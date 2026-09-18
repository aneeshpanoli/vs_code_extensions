// delegation-wiring.test.js — DG-001-R1: "once per undelegated stretch" is a property of the BUS,
// not of `delegationTick`.
//
// WHY THIS FILE EXISTS SEPARATELY FROM delegation.test.js. Every claim in delegation.test.js is
// about a pure function, and all 22 of them were green while the product delivered one due reminder
// up to four times per window, times the number of windows open on the project. They could not have
// been otherwise: nothing in that file — nothing anywhere — ever called `runDelegation`. This repo
// has now shipped that shape three times (MOD-001's mutant that compiled and survived until a test
// drove the real `activate()`; AN-001's 188 green tests on a mechanism that could never fire), and
// the rule it keeps teaching is the one in the handoff: if a mutant can only be killed by a pure-
// function test, the pure-function test is not testing the product.
//
// So every suite here drives the real `activate()` tick path — the real `runDelegation`, the real
// `injectTo`, the real state file on the real bus — against a fake `loom_cdp.py` that logs the argv
// of every injection, and asserts on WHAT REACHED THE INJECTOR. The fake can be made SLOW, which is
// the whole point: the repeat being closed lives in the window between "this tick decided to remind"
// and "the injector came back", and a fast fake closes that window by accident and proves nothing.
//
// TWO WINDOWS ARE TWO `activate()` CALLS. `currentRepo()` resolves through the shared repository
// directory, so every worktree window of one project reads and writes ONE `delegation-state.json` —
// which is exactly what the second `activate()` reproduces here, because the thing under test is the
// files they share, not the processes they are not.

const { suite, ok, eq, match, load, vscode, busPath, writeJson, readJson, setStatus, settle, LOOM,
        fixtureDir } = require("./harness");
const fs = require("fs");
const path = require("path");

const ext = load("extension.js");
const cdp = load("cdp.js");
const { setOrchestrator } = load("orchestrator.js");

const marker = (r) => "\nLOOMROLE=" + r + "\n";
/** An idle footer and a mid-turn one. `isBusy` reads only the last 400 chars, and only these lines. */
const IDLE = "\nRemote Control\nOpus 5\nMedium\nBypass permissions\n";
const WORKING = "\nShimmying...\nClaude is working\nOpus 5\nMedium\nBypass permissions\n";
const frame = (webviewId, text) => ({ webviewId, text, type: "iframe", targetUrl: "vscode-webview://x" });

/** The injector, replaced by a script that records every call and can be made to take its time.
 *  `LOOM_FAKE_INJECT_SLEEP` is read at RUN time, so one activation can serve a slow injection and a
 *  fast one. */
const LOGGING_CDP =
  "import sys, os, time\n" +
  "time.sleep(float(os.environ.get('LOOM_FAKE_INJECT_SLEEP', '0')))\n" +
  "p = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'inject-log.txt')\n" +
  // ONE LINE PER INJECTION, newlines squashed. The message carries the reporting contract, which is
  // multi-line, so the raw argv spans several lines — and a log that is counted by line then counts
  // one injection several times, or loses the `--repo` the count is scoped by onto a later line.
  "open(p, 'a').write(' '.join(sys.argv[1:]).replace('\\n', ' ') + '\\n')\n" +
  "print(' '.join(sys.argv[1:]))\n" +
  // A REFUSAL, in loom_cdp.py's own shape: exit 0, and say so in the printed dict. `injectVerdict`
  // reads the dict and not the exit code, which is MS-001's finding; a fake that exits non-zero
  // would be testing a failure mode the real injector does not have.
  "if os.environ.get('LOOM_FAKE_INJECT_FAIL'):\n" +
  "    print(\"{'ok': False, 'note': 'composer busy or frame not found'}\")\n" +
  // THE OTHER FAST `ok: False`, and the one that is not a refusal at all: loom_cdp.py typed the
  // whole message, read the composer back and CONFIRMED the text is sitting in it, and only the
  // send button failed. Same boolean, same few milliseconds, opposite meaning.
  "if os.environ.get('LOOM_FAKE_INJECT_TYPED_UNSENT'):\n" +
  "    print(\"{'ok': False, 'note': 'typed but NOT submitted: send click -> None; " +
  "text still in composer (verified)'}\")\n";

const injectLog = () => {
  try { return fs.readFileSync(path.join(LOOM, "inject-log.txt"), "utf8").split("\n").filter(Boolean); }
  catch { return []; }
};
const clearInjectLog = () => { try { fs.unlinkSync(path.join(LOOM, "inject-log.txt")); } catch {} };
/**
 * The delegate reminders SENT TO THIS BUS. Other detectors ride the same tick and the same injector,
 * and `inject-log.txt` is one file for the whole sandbox — so filtering on the message alone counts
 * any still-live activation from an earlier suite as well. Those are latched and quiet today, which
 * means the counts below would hold BY LUCK; `--repo` is on every injection's argv, so scoping to it
 * makes them hold by construction.
 */
const reminders = (repo) =>
  injectLog().filter((l) => /loom-delegate/.test(l) && new RegExp("--repo " + repo + "(\\s|$)").test(l));

const stateFile = (repo) => busPath(repo, "delegation-state.json");
const claimFile = (repo) => busPath(repo, "delegation-inflight.lock");

/**
 * A bus with a tagged orchestrator and two workers, one of them free. A DISTINCT repo id per suite,
 * and it is load-bearing: the LATCH is per repo and lives on disk, so two suites sharing an id would
 * have the first one silence the second, which is how a wiring suite passes for the wrong reason.
 */
function bus(name, { idleWorker = true } = {}) {
  const root = path.join(fixtureDir("loom-dg-"), name);
  fs.mkdirSync(root, { recursive: true });
  vscode.workspace.workspaceFolders = [{ uri: { fsPath: root } }];
  const repo = path.basename(root);
  writeJson(busPath(repo, "board.json"), {
    productowner: { branch: "main" },
    developer1: { branch: "worktree-developer1" },
    developer2: { branch: "worktree-developer2" },
  });
  setStatus(repo, "developer1", { role: "developer1", status: "working" });
  setStatus(repo, "developer2", { role: "developer2", status: idleWorker ? "idle" : "working" });
  setOrchestrator(repo, "productowner", "wid-po");
  return repo;
}

/** The dispatch watermark, as `lastDispatchAt` actually reads it: the model ledger's `openedAt`. */
function dispatchAt(repo, iso) {
  writeJson(busPath(repo, "model-policy.json"),
            { pending: {}, escalations: {}, defaulted: [],
              ledger: { "developer1:DG-001": { openedAt: iso } } });
}

/** A stretch already past the threshold, so a suite about DELIVERY does not have to spend 30
 *  minutes of wall clock getting there. `lastTickAt` is left old so the cadence gate is open. */
function seedStretch(repo, over = {}) {
  writeJson(stateFile(repo), {
    busyTicks: 500, since: null, reminded: false, deliveredAt: null,
    lastTickAt: new Date(Date.now() - 600_000).toISOString(), ...over,
  });
}

/**
 * Bring a window up and hand back its own `runTick`, which is what the interval calls. Driving the
 * command rather than waiting on the 15-second timer is what makes a tick SEQUENCE testable.
 *
 * ACTIVATION ITSELF TICKS, so every suite below brings its windows up BEFORE it seeds the stretch.
 * Seeding first was measured to pass for the wrong reason: the activation tick delivered the
 * reminder and the ticks the suite actually drove were suppressed by the latch it had already set,
 * so the counts came out right while asserting nothing about the driven sequence. A window that
 * comes up to an empty state file has a `busyTicks` of 0 and nothing is due, which is the quiet
 * starting line these suites need.
 */
async function window_(frames) {
  cdp.readFrames = async () => frames;
  fs.writeFileSync(path.join(LOOM, "loom_cdp.py"), LOGGING_CDP);
  const context = { subscriptions: [] };
  ext.activate(context);
  const tick = vscode._commands["loomSessionTracker.refresh"];
  await settle();
  return {
    tick,
    off() {
      ext.deactivate();
      for (const d of context.subscriptions) { try { d.dispose && d.dispose(); } catch {} }
    },
  };
}

function config(over) {
  // A quarter of a minute is one tick, so a seeded stretch is over the bar; the reminder itself is
  // what these suites are about, not the counting.
  vscode._config["loomSessionTracker.delegationMinutes"] = 0.25;
  vscode._config["loomSessionTracker.showStartupDigest"] = false;
  Object.assign(vscode._config, over || {});
}

// ─────────────────────────────────────────────────────────────────────────────────────────────────

suite("DG-001-R1 wiring: the reminder actually reaches the orchestrator's composer", async () => {
  // The baseline claim, and the one nothing asserted before this file: `runDelegation` is called by
  // the tick at all. Every suite below is a statement about HOW MANY, which is vacuous if the answer
  // to "any?" is no.
  config();
  const repo = bus("dg-reaches");
  const w = await window_([frame("wid-po", "po" + marker("productowner") + IDLE)]);
  seedStretch(repo);
  clearInjectLog();
  try {
    await w.tick();
    await settle(200);
    eq(reminders(repo).length, 1, "one reminder was typed into the composer — runDelegation is wired");
    const sent = reminders(repo)[0];
    match(sent, /developer2 has been idle/, "it names the worker that is actually free");
    // NOT "developer1 is absent": the message names the busy roles too, on purpose, so that a
    // §8 concurrency cap being FOLLOWED does not read as work nobody is doing. What must be true is
    // that the two are on the right sides of the sentence.
    match(sent, /developer1 is working, so that lane is accounted for/,
          "and says of the one that is busy that its lane is accounted for, not that it is idle");
    match(sent, /inbox\.md/, "and answers 'to whom' with a path, which is the point of the line");
    eq(readJson(stateFile(repo)).reminded, true, "and the stretch is latched, on the bus, not in memory");
  } finally { w.off(); }
});

suite("DG-001-R1 wiring: a reminder IN FLIGHT is delivered once, not once per tick", async () => {
  // THE FIRST LIVE REPEAT. `loom_cdp.py` runs for up to INJECT_TIMEOUT_MS — four ticks at the
  // default interval — and until it returns, nothing had been latched, so every one of those ticks
  // re-read an unlatched file, found the same due stretch and injected again. Measured as up to four
  // deliveries of one reminder.
  //
  // The fake injector is made to take 400ms and four ticks are driven inside that window. A build
  // without the claim types four times here; the pure suite cannot see the difference, because the
  // pure function is given the same unlatched state each time and is RIGHT to return a finding.
  config();
  const repo = bus("dg-inflight");
  const w = await window_([frame("wid-po", "po" + marker("productowner") + IDLE)]);
  seedStretch(repo);
  clearInjectLog();
  process.env.LOOM_FAKE_INJECT_SLEEP = "0.4";
  try {
    await w.tick();
    await w.tick();
    await w.tick();
    await w.tick();
    eq(reminders(repo).length, 0, "nothing has landed yet — the injector is still typing");
    ok(fs.existsSync(claimFile(repo)), "and the claim is held for exactly that window");
    await settle(900);
    eq(reminders(repo).length, 1,
       "ONE reminder for four ticks spent inside one injection — the claim is taken BEFORE the " +
       "injector is spawned, which is the trade the wake path deliberately does not make");
    ok(!fs.existsSync(claimFile(repo)), "and the claim is given back when the injection returns");
    eq(readJson(stateFile(repo)).reminded, true, "the latch now carries it");
  } finally { process.env.LOOM_FAKE_INJECT_SLEEP = "0"; w.off(); }
});

suite("DG-001-R1 wiring: a second window ticking the same bus adds no second reminder", async () => {
  // THE SECOND LIVE REPEAT, and the one that made livegita look like a flood: every worktree window
  // of a project resolves to the same repo id and ticks the same state file, so N windows delivered
  // N reminders. The claim is a file on the bus, so it is shared by exactly the windows that share
  // the state — which is why this is closed by the same one mechanism and not a second one.
  //
  // WHAT THIS SUITE DOES *NOT* PROVE, and why it is no longer named as though it did: two
  // `activate()` calls are two closures in ONE process, and `runDelegation` is synchronous from the
  // state read to the spawn, so the event loop serialises them however the claim is implemented. A
  // check-then-write, or an in-memory boolean, passes this suite. What it pins is that the
  // suppression is carried by a file on the BUS rather than by anything inside a window — the
  // ATOMICITY of taking that file is pinned where it can actually be lost, by the eight-process race
  // in delegation.test.js.
  config();
  const repo = bus("dg-two-windows");
  const a = await window_([frame("wid-po", "po" + marker("productowner") + IDLE)]);
  const b = await window_([frame("wid-po", "po" + marker("productowner") + IDLE)]);
  seedStretch(repo);
  clearInjectLog();
  process.env.LOOM_FAKE_INJECT_SLEEP = "0.4";
  try {
    await Promise.all([a.tick(), b.tick()]);
    await settle(900);
    eq(reminders(repo).length, 1, "two windows, one orchestrator, one reminder");
    await a.tick();
    await b.tick();
    await settle(200);
    eq(reminders(repo).length, 1, "and the latch they share holds for both of them afterwards");
  } finally { process.env.LOOM_FAKE_INJECT_SLEEP = "0"; b.off(); a.off(); }
});

suite("DG-001-R1 wiring: two windows observing one orchestrator bank ONE busy tick, not two", async () => {
  // The counter had the same multiplier as the delivery, and it is the quieter half: N windows made
  // `busyTicks` advance N times a tick, so a threshold that says 30 minutes arrived in 30/N. The
  // orchestrator is ONE session; a second window's look at the same minute is the same minute.
  //
  // No sleeping: the two ticks land milliseconds apart, which is precisely the case the gate exists
  // for, and the seeded `lastTickAt` is old enough that the FIRST of them is counted.
  config();
  const repo = bus("dg-counter");
  const a = await window_([frame("wid-po", "po" + marker("productowner") + WORKING)]);
  const b = await window_([frame("wid-po", "po" + marker("productowner") + WORKING)]);
  writeJson(stateFile(repo), { busyTicks: 0, since: null, reminded: false, deliveredAt: null,
                               lastTickAt: new Date(Date.now() - 600_000).toISOString() });
  clearInjectLog();
  try {
    await a.tick();
    eq(readJson(stateFile(repo)).busyTicks, 1, "the first window banks the tick");
    await b.tick();
    eq(readJson(stateFile(repo)).busyTicks, 1,
       "the second window, same instant, same orchestrator, banks nothing — 30 minutes means 30 " +
       "minutes however many windows are open");
    await a.tick();
    eq(readJson(stateFile(repo)).busyTicks, 1, "and neither does the first one ticking again early");
  } finally { b.off(); a.off(); }
});

suite("DG-001-R1 wiring: an injection REFUSED fast is not latched, and the next tick tries again", async () => {
  // THE WAKE RULE, KEPT WHERE IT IS CHEAP. A reminder the injector says it did not deliver has not
  // been delivered, and latching it would be the swallow. The claim is about repeats, not about
  // pretending an attempt succeeded — so a fast refusal releases the claim and changes nothing.
  //
  // This is also the suite that stops the fix over-correcting into "latch on anything that comes
  // back", which would silence a bus whose composer happened to be busy at the one moment it looked.
  config();
  const repo = bus("dg-refused");
  const w = await window_([frame("wid-po", "po" + marker("productowner") + IDLE)]);
  seedStretch(repo);
  clearInjectLog();
  process.env.LOOM_FAKE_INJECT_FAIL = "1";
  try {
    await w.tick();
    await settle(300);
    eq(reminders(repo).length, 1, "one attempt was made");
    eq(readJson(stateFile(repo)).reminded, false, "and refused, so NOTHING is latched");
    ok(!fs.existsSync(claimFile(repo)), "and the claim is given back, not left holding the bus quiet");
    await w.tick();
    await settle(300);
    eq(reminders(repo).length, 2, "so the next tick tries again — a refused reminder is not a delivered one");
    delete process.env.LOOM_FAKE_INJECT_FAIL;
    await w.tick();
    await settle(300);
    eq(reminders(repo).length, 3, "and when it finally lands…");
    eq(readJson(stateFile(repo)).reminded, true, "…THAT is what latches the stretch");
    await w.tick();
    await settle(300);
    eq(reminders(repo).length, 3, "and it is quiet from then on");
  } finally { delete process.env.LOOM_FAKE_INJECT_FAIL; w.off(); }
});

suite("DG-001-R1 wiring: text already sitting in the composer is never typed a second time", async () => {
  // THE REPEAT THAT SURVIVED THE FIRST VERSION OF THIS BLOCK, found by the refutation pass and
  // reproduced here. `injectTo` reports ONE boolean, and `loom_cdp.py`'s fast `ok: False` is not one
  // failure but several: "composer not found" typed nothing, while "typed but NOT submitted … text
  // still in composer (verified)" means the entire reminder is ALREADY IN the orchestrator's
  // composer and only the send button failed.
  //
  // Treating that as "not delivered" and retrying it appends another copy every fifteen seconds —
  // the livegita symptom precisely, arriving by a route no stopwatch and no boolean can see, and
  // one this block had blessed as correct until the note was read instead of guessed at.
  config();
  const repo = bus("dg-typed-unsent");
  const w = await window_([frame("wid-po", "po" + marker("productowner") + IDLE)]);
  seedStretch(repo);
  clearInjectLog();
  process.env.LOOM_FAKE_INJECT_TYPED_UNSENT = "1";
  try {
    await w.tick();
    await settle(300);
    eq(reminders(repo).length, 1, "one attempt, and the text is in the composer");
    eq(readJson(stateFile(repo)).reminded, true,
       "so the stretch IS latched — the owner has the message, unsent or not");
    await w.tick();
    await w.tick();
    await settle(300);
    eq(reminders(repo).length, 1,
       "and it is NEVER typed again: a second copy under the first is the repeat, not a recovery");
  } finally { delete process.env.LOOM_FAKE_INJECT_TYPED_UNSENT; w.off(); }
});

suite("DG-001-R1 wiring: the threshold is measured in the interval the window ACTUALLY ticks at", async () => {
  // `delegationTick` counts TICKS and the message speaks in MINUTES, so the conversion needs the real
  // interval. `schedule()` reads it from settings and clamps it at a 5-second floor; delegation.ts's
  // own default is 15 seconds. A window at the floor therefore banks three ticks per 15 seconds and
  // would be told it had been working for half an hour after ten minutes — and the sentence, which
  // states the minutes as an observation, would say so in the owner's composer.
  config({ "loomSessionTracker.intervalMs": 5000 });
  const repo = bus("dg-interval");
  // 0.25 minutes at a 5-second tick is THREE ticks, and at the 15-second default it is one. Two
  // banked ticks is therefore under the bar for a window that ticks at 5s, and over it for a build
  // that has forgotten which interval it runs at.
  const w = await window_([frame("wid-po", "po" + marker("productowner") + IDLE)]);
  seedStretch(repo, { busyTicks: 2 });
  clearInjectLog();
  try {
    await w.tick();
    await settle(300);
    eq(reminders(repo).length, 0, "two ticks of a five-second interval is ten seconds, not half an hour");
    seedStretch(repo, { busyTicks: 3 });
    await w.tick();
    await settle(300);
    eq(reminders(repo).length, 1, "and the third one is the threshold, measured in this window's own ticks");
  } finally { w.off(); delete vscode._config["loomSessionTracker.intervalMs"]; }
});

suite("DG-001-R1 wiring: a DISPATCH re-arms it, and the next stretch is reminded once", async () => {
  // The bound on the bound: a claim that was never released, or a latch that never re-armed, would
  // pass every suite above by silencing the bus for ever. That is the swallow — the quiet cousin of
  // the spam, and the wrong fix for it. This is the suite that fails if the fix over-corrects.
  config();
  const repo = bus("dg-rearm");
  const w = await window_([frame("wid-po", "po" + marker("productowner") + IDLE)]);
  seedStretch(repo, { since: "2026-09-17T10:00:00.000Z" });
  dispatchAt(repo, "2026-09-17T10:00:00.000Z");
  clearInjectLog();
  try {
    await w.tick();
    await settle(200);
    eq(reminders(repo).length, 1, "the first stretch is reminded");
    await w.tick();
    await settle(200);
    eq(reminders(repo).length, 1, "and stays reminded");
    dispatchAt(repo, "2026-09-17T12:00:00.000Z");
    // The new stretch starts at zero, so it has to earn the threshold again before anything is due.
    await w.tick();
    await settle(200);
    eq(reminders(repo).length, 1, "a dispatch re-arms the latch but does NOT make a reminder due");
    const st = readJson(stateFile(repo));
    eq(st.reminded, false, "the latch is re-armed");
    eq(st.since, "2026-09-17T12:00:00.000Z", "against the new watermark");
    seedStretch(repo, { since: "2026-09-17T12:00:00.000Z" });
    await w.tick();
    await settle(200);
    eq(reminders(repo).length, 2, "and once the new stretch is long enough, it is reminded — once");
  } finally { w.off(); }
});

suite("DG-001-R1 wiring: a dispatch DURING the injection does not latch the new stretch", async () => {
  // THE HALF THAT NOTHING ASSERTED, and it is a swallow. The reminder that is mid-flight is about
  // the stretch that was running when the tick decided to send it. If the orchestrator dispatches
  // while `loom_cdp.py` is typing — which is exactly what the reminder is asking it to do, so this
  // is the SUCCESS path, not an edge case — then by the time the callback runs, that stretch is
  // over and a new one has started at zero. Recording the delivery against the new stretch would
  // latch a stretch nobody has been reminded about, and it would stay latched until the dispatch
  // after that.
  //
  // Drop the `cur.since === r.state.since` conjunct in extension.ts and every other suite in this
  // file stays green.
  config();
  const repo = bus("dg-dispatch-midflight");
  const w = await window_([frame("wid-po", "po" + marker("productowner") + IDLE)]);
  seedStretch(repo, { since: "2026-09-17T10:00:00.000Z" });
  dispatchAt(repo, "2026-09-17T10:00:00.000Z");
  clearInjectLog();
  process.env.LOOM_FAKE_INJECT_SLEEP = "0.5";
  try {
    const t = w.tick();
    await settle(120);
    // The orchestrator does what the reminder asks, while the reminder is still being typed.
    dispatchAt(repo, "2026-09-17T14:00:00.000Z");
    // …and the interval keeps ticking through the injection — an injection may run for four of them.
    // It is that tick which records the new stretch, so this is how the turnover actually reaches
    // the state file, not a contrivance to make the assertion reachable.
    await w.tick();
    eq(readJson(stateFile(repo)).since, "2026-09-17T14:00:00.000Z",
       "a tick inside the injection has moved the bus on to the new stretch");
    await t;
    await settle(900);
    eq(reminders(repo).length, 1, "the reminder for the old stretch was delivered");
    const st = readJson(stateFile(repo));
    eq(st.reminded, false,
       "but it is NOT recorded against the new stretch — that stretch has had no reminder, and " +
       "latching it here would swallow the one it is owed");
    ok(!fs.existsSync(claimFile(repo)), "and the claim is still given back");
  } finally { process.env.LOOM_FAKE_INJECT_SLEEP = "0"; w.off(); }
});

suite("DG-001-R1 wiring: an EXPIRED claim is taken over, so a crash mid-injection is not silence", async () => {
  // The claim bounds the repeat; this is what bounds the claim. A window killed between taking it
  // and releasing it would otherwise hold it for ever and no window could ever remind this bus
  // again — the permanent swallow. A claim older than the injector's own timeout cannot belong to a
  // live injector, and the next tick takes it over.
  config();
  const repo = bus("dg-expired");
  const w = await window_([frame("wid-po", "po" + marker("productowner") + IDLE)]);
  seedStretch(repo);
  // Older than INJECT_TIMEOUT_MS *and* the grace band that keeps a claim alive a little longer than
  // the injector it covers.
  fs.writeFileSync(claimFile(repo), JSON.stringify({ at: Date.now() - 300_000, pid: 999999 }));
  clearInjectLog();
  try {
    await w.tick();
    await settle(300);
    eq(reminders(repo).length, 1, "a claim older than INJECT_TIMEOUT_MS is dead and is taken over");
  } finally { w.off(); }
});

suite("DG-001-R1 wiring: a LIVE claim from another window suppresses, and loses nothing", async () => {
  // The other half of the same rule, and the reason losing the claim is not losing the reminder:
  // the state is untouched, so the stretch is still due and the next free tick delivers it.
  config();
  const repo = bus("dg-held");
  const w = await window_([frame("wid-po", "po" + marker("productowner") + IDLE)]);
  seedStretch(repo);
  fs.writeFileSync(claimFile(repo), JSON.stringify({ at: Date.now(), pid: 999999 }));
  clearInjectLog();
  try {
    await w.tick();
    await settle(300);
    eq(reminders(repo).length, 0, "someone else is mid-injection, so this window stays quiet");
    eq(readJson(stateFile(repo)).reminded, false, "and nothing is latched — the reminder is not lost");
    fs.unlinkSync(claimFile(repo));
    await w.tick();
    await settle(300);
    eq(reminders(repo).length, 1, "the very next tick delivers it");
  } finally { w.off(); }
});

suite("DG-001-R1 wiring: a mid-turn orchestrator is not interrupted, and keeps its stretch", async () => {
  // Pre-existing behaviour, asserted here for the first time AT THE WIRING, because the claim now
  // sits next to it: a refusal to inject into a busy composer must not take a claim, must not latch,
  // and must not lose the stretch it was about.
  config();
  const repo = bus("dg-midturn");
  const w = await window_([frame("wid-po", "po" + marker("productowner") + WORKING)]);
  seedStretch(repo);
  clearInjectLog();
  try {
    await w.tick();
    await settle(300);
    eq(reminders(repo).length, 0, "nothing is typed into a composer that is mid-turn");
    ok(!fs.existsSync(claimFile(repo)), "and no claim is taken for an injection that never happened");
    eq(readJson(stateFile(repo)).reminded, false, "the stretch is still due");
  } finally { w.off(); }
});

suite("DG-001-R1 wiring: the reminder is OFF when the setting says so", async () => {
  // The stopgap that is currently holding every bus quiet. It is the one thing standing between a
  // regression here and the owner's composer, so it is asserted at the wiring rather than trusted.
  config({ "loomSessionTracker.delegationReminders": false });
  const repo = bus("dg-off");
  const w = await window_([frame("wid-po", "po" + marker("productowner") + IDLE)]);
  seedStretch(repo);
  clearInjectLog();
  try {
    await w.tick();
    await settle(300);
    eq(reminders(repo).length, 0, "the setting is read by the wiring, not only documented");
  } finally { w.off(); delete vscode._config["loomSessionTracker.delegationReminders"]; }
});
