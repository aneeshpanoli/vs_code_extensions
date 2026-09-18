// notifier-wiring.test.js — NF-001: "a finish is announced exactly once" is a property of the BUS
// AND THE COMPOSER, not of `Notifier.scan()`.
//
// WHY THIS FILE EXISTS SEPARATELY FROM notifier.test.js. Every claim in that file is about `scan()`,
// and all of them were green while the product had this defect: `scan()` marked a finish announced
// at DETECTION and persisted it BEFORE any injection was attempted, and the failure callback in
// extension.ts showed a VS Code warning toast — a popup for a human looking at the editor, which an
// orchestrator is not and cannot read. So a worker finishing while the orchestrator was mid-turn was
// refused by the busy-composer guard and NEVER RAISED AGAIN. Measured on another bus, 2026-09-17: a
// finished job sat unread in an outbox for three hours. Nothing in notifier.test.js could have said
// so, because nothing anywhere called `runNotifier`.
//
// The orchestrator is mid-turn precisely when it is working, so the message most worth delivering is
// the one most likely to be refused. That is why the assertion here is about a SEQUENCE of ticks
// against a REFUSING injector, and why a fake that always accepts would prove nothing.

const { suite, ok, eq, match, load, vscode, busPath, writeJson, readJson, setStatus, settle, LOOM,
        fixtureDir } = require("./harness");
const fs = require("fs");
const path = require("path");

const ext = load("extension.js");
const cdp = load("cdp.js");
const { setOrchestrator } = load("orchestrator.js");

const marker = (r) => "\nLOOMROLE=" + r + "\n";
const IDLE = "\nRemote Control\nOpus 5\nMedium\nBypass permissions\n";
const frame = (webviewId, text) => ({ webviewId, text, type: "iframe", targetUrl: "vscode-webview://x" });

/** The injector, as delegation-wiring.test.js drives it: exit 0 and say the outcome in the printed
 *  dict, because `injectVerdict` reads the dict and not the exit code. The two fast `ok: False`
 *  cases are deliberately separate — one typed nothing, the other typed the whole message and
 *  verified it is sitting in the composer, and retrying THAT appends a duplicate. */
const LOGGING_CDP =
  "import sys, os, time\n" +
  "time.sleep(float(os.environ.get('LOOM_FAKE_INJECT_SLEEP', '0')))\n" +
  "p = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'inject-log.txt')\n" +
  "open(p, 'a').write(' '.join(sys.argv[1:]).replace('\\n', ' ') + '\\n')\n" +
  "print(' '.join(sys.argv[1:]))\n" +
  "if os.environ.get('LOOM_FAKE_INJECT_FAIL'):\n" +
  "    print(\"{'ok': False, 'note': 'composer busy or frame not found'}\")\n" +
  "if os.environ.get('LOOM_FAKE_INJECT_TYPED_UNSENT'):\n" +
  "    print(\"{'ok': False, 'note': 'typed but NOT submitted: send click -> None; " +
  "text still in composer (verified)'}\")\n";

const injectLog = () => {
  try { return fs.readFileSync(path.join(LOOM, "inject-log.txt"), "utf8").split("\n").filter(Boolean); }
  catch { return []; }
};
const clearInjectLog = () => { try { fs.unlinkSync(path.join(LOOM, "inject-log.txt")); } catch {} };
/** The FINISH NOTIFICATIONS sent to THIS bus. `inject-log.txt` is one file for the whole sandbox and
 *  several detectors ride the same tick and the same injector, so the count is scoped by `--repo`,
 *  which is on every injection's argv — not by the message alone. */
const notices = (repo) =>
  injectLog().filter((l) => /loom-notify/.test(l) && new RegExp("--repo " + repo + "(\\s|$)").test(l));

const stateFile = (repo) => busPath(repo, "notify-state.json");
const pending = (repo) => (readJson(stateFile(repo)) || {}).pending || [];
const delivered = (repo) => (readJson(stateFile(repo)) || {}).announced || [];

/** A DISTINCT repo id per suite, and it is load-bearing: the queue is per repo and lives on disk,
 *  so two suites sharing an id would have one settle the other's event. */
function bus(name) {
  const root = path.join(fixtureDir("loom-nf-"), name);
  fs.mkdirSync(root, { recursive: true });
  vscode.workspace.workspaceFolders = [{ uri: { fsPath: root } }];
  const repo = path.basename(root);
  writeJson(busPath(repo, "board.json"), {
    productowner: { branch: "main" },
    developer1: { branch: "worktree-developer1" },
  });
  setStatus(repo, "developer1", { role: "developer1", status: "working", current: "NF-7" });
  setOrchestrator(repo, "productowner", "wid-po");
  return repo;
}

const finish = (repo, role = "developer1", over = {}) =>
  setStatus(repo, role, { role, status: "idle", current: "NF-7", last_line: "done, 9 tests", ...over });

/** Bring a window up and hand back the `runTick` the interval calls. ACTIVATION ITSELF TICKS, so
 *  every suite brings the window up while the worker is still WORKING — a window that activates
 *  onto an already-finished worker queues the event on the activation tick, and the ticks the suite
 *  then drives would be asserting about a delivery it never watched happen. */
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
  vscode._config["loomSessionTracker.showStartupDigest"] = false;
  // The delegation reminder rides the same tick and the same bus-wide inject claim. Left at its
  // default half hour it is never due inside a suite, so the counts below are about the notifier.
  delete vscode._config["loomSessionTracker.delegationMinutes"];
  Object.assign(vscode._config, over || {});
}

// ─────────────────────────────────────────────────────────────────────────────────────────────────

suite("NF-001 wiring: a finish reaches the composer, and is owed until it lands", async () => {
  // The baseline claim, and the one nothing asserted before this file: the tick calls `runNotifier`
  // and something is typed. Every suite below is a statement about HOW MANY, which is vacuous if
  // the answer to "any?" is no.
  //
  // THE MID-FLIGHT ASSERTION IS THE LOAD-BEARING ONE, and it was added after a CONTROL: run against
  // HEAD's detect-and-forget code, the end-state assertions here passed unchanged (the old build
  // wrote the key into `announced` at detection, and its state file has no `pending` at all, which
  // reads as an empty queue). A suite that passes on the code it was written to condemn asserts
  // nothing. A SLOW injector opens the only window where the two builds differ: the message is on
  // its way and NOT yet delivered.
  config();
  const repo = bus("nf-reaches");
  const w = await window_([frame("wid-po", "po" + marker("productowner") + IDLE)]);
  clearInjectLog();
  process.env.LOOM_FAKE_INJECT_SLEEP = "0.6";
  try {
    finish(repo);
    const ticked = w.tick();
    await settle(250);                                  // the injector is still typing
    eq(pending(repo).length, 1, "IN FLIGHT: the finish is still owed — nothing is retired yet");
    eq(delivered(repo).length, 0, "and nothing is announced on the strength of having noticed it");
    await ticked;
    await settle(800);
    eq(notices(repo).length, 1, "one notification was typed into the composer — runNotifier is wired");
    match(notices(repo)[0], /developer1 finished on NF-7/, "it names the worker and the handoff");
    match(notices(repo)[0], /outbox\.md/, "and tells the orchestrator where to read");
    eq(pending(repo).length, 0, "delivered, so nothing is still owed");
    eq(delivered(repo), ["developer1|NF-7|idle"], "and THAT — the delivery — is what retires it");
  } finally { delete process.env.LOOM_FAKE_INJECT_SLEEP; w.off(); }
});

suite("NF-001 wiring: a REFUSED notification is raised again on a later tick", async () => {
  // THE BLOCK. A busy composer refuses; the old build had already written the key as announced
  // before the injector was even spawned, so this second tick sent nothing and the finish was lost
  // for good. A mutant that moves the retirement back to detection dies HERE.
  config();
  const repo = bus("nf-refused");
  const w = await window_([frame("wid-po", "po" + marker("productowner") + IDLE)]);
  clearInjectLog();
  process.env.LOOM_FAKE_INJECT_FAIL = "1";
  try {
    finish(repo);
    await w.tick();
    await settle(300);
    eq(notices(repo).length, 1, "one attempt was made");
    eq(delivered(repo).length, 0, "and it was REFUSED, so nothing is retired");
    eq(pending(repo).length, 1, "the finish is still owed");
    eq(pending(repo)[0].attempts, 1, "with the attempt counted on the bus, where an agent can read it");
    match(pending(repo)[0].lastNote, /composer busy/, "in the injector's own words — not in a toast");

    await w.tick();
    await settle(300);
    eq(notices(repo).length, 2, "the next tick tries AGAIN — a refused notification is not a delivered one");

    delete process.env.LOOM_FAKE_INJECT_FAIL;
    await w.tick();
    await settle(300);
    eq(notices(repo).length, 3, "and when the orchestrator is free it finally lands…");
    eq(delivered(repo), ["developer1|NF-7|idle"], "…which is the only thing that retires it");
    eq(pending(repo).length, 0, "nothing owed");

    await w.tick();
    await settle(300);
    eq(notices(repo).length, 3, "DELIVERED EXACTLY ONCE — no repeat once it landed");
  } finally { delete process.env.LOOM_FAKE_INJECT_FAIL; w.off(); }
});

suite("NF-001 wiring: 'typed but NOT submitted' is NOT retried", async () => {
  // loom_cdp.py's fast `ok: False` is two failures wearing one boolean, and this one means the whole
  // message is already sitting in the orchestrator's composer, verified. Retrying it appends a
  // second copy — the livegita repeat, arriving by a route the boolean cannot see. Same call the
  // reminder makes (`settleInjection`), not a second copy of the rule.
  config();
  const repo = bus("nf-typed-unsent");
  const w = await window_([frame("wid-po", "po" + marker("productowner") + IDLE)]);
  clearInjectLog();
  // THE FIRST PHASE IS A PLAIN REFUSAL, and it is here because of a control: with only the second
  // phase, HEAD's detect-and-forget build passed this suite verbatim — it also typed once and never
  // again, for the opposite reason. The two `ok: False` cases must be shown to be treated
  // DIFFERENTLY, which takes both of them in one run.
  try {
    finish(repo);
    process.env.LOOM_FAKE_INJECT_FAIL = "1";
    await w.tick();
    await settle(300);
    eq(notices(repo).length, 1, "refused: nothing was typed…");
    eq(pending(repo).length, 1, "…so it is still owed");
    delete process.env.LOOM_FAKE_INJECT_FAIL;

    process.env.LOOM_FAKE_INJECT_TYPED_UNSENT = "1";
    await w.tick();
    await settle(300);
    eq(notices(repo).length, 2, "the retry types it");
    eq(pending(repo).length, 0, "and THIS ok:False means the text IS in the composer — retired…");
    eq(delivered(repo), ["developer1|NF-7|idle"], "…recorded as delivered, same boolean, opposite meaning");
    await w.tick();
    await settle(300);
    eq(notices(repo).length, 2, "…so no second copy is typed on top of the first");
  } finally {
    delete process.env.LOOM_FAKE_INJECT_FAIL;
    delete process.env.LOOM_FAKE_INJECT_TYPED_UNSENT; w.off();
  }
});

suite("NF-001 wiring: a worker back at WORK is not announced late", async () => {
  // SUPERSEDED. A role only goes back to working because it was handed a block, and on this bus
  // blocks come from the orchestrator — so a role at work is proof the finish was noticed by the
  // only party the message was for. Sending it now would point at an outbox already answered.
  config();
  const repo = bus("nf-superseded");
  const w = await window_([frame("wid-po", "po" + marker("productowner") + IDLE)]);
  clearInjectLog();
  process.env.LOOM_FAKE_INJECT_FAIL = "1";
  try {
    finish(repo);
    await w.tick();
    await settle(300);
    eq(notices(repo).length, 1, "refused, and still owed");
    eq(pending(repo).length, 1, "owed");
    setStatus(repo, "developer1", { role: "developer1", status: "working", current: "NF-8" });
    delete process.env.LOOM_FAKE_INJECT_FAIL;
    await w.tick();
    await settle(300);
    eq(pending(repo).length, 0, "the stale finish is DROPPED, not delivered late");
    eq(notices(repo).length, 1, "so the free composer is not told about work that has moved on");
  } finally { delete process.env.LOOM_FAKE_INJECT_FAIL; w.off(); }
});

suite("NF-001 wiring: two workers that finished while it was busy arrive one per tick", async () => {
  // NO FLOOD AND NO COALESCING. Each event names a different outbox; one message per delivery is
  // what lets any single one of them be retired without a claim about the others.
  config();
  const repo = bus("nf-queue");
  writeJson(busPath(repo, "board.json"), {
    productowner: { branch: "main" },
    developer1: { branch: "worktree-developer1" },
    developer2: { branch: "worktree-developer2" },
  });
  setStatus(repo, "developer1", { role: "developer1", status: "working", current: "NF-7" });
  setStatus(repo, "developer2", { role: "developer2", status: "working", current: "NF-9" });
  const w = await window_([frame("wid-po", "po" + marker("productowner") + IDLE)]);
  clearInjectLog();
  process.env.LOOM_FAKE_INJECT_FAIL = "1";
  try {
    finish(repo, "developer1");
    await w.tick();
    await settle(300);
    finish(repo, "developer2", { current: "NF-9" });
    await w.tick();
    await settle(300);
    eq(pending(repo).length, 2, "both are owed — a busy composer lost neither");
    eq(pending(repo).map((p) => p.role), ["developer1", "developer2"], "oldest finish first");
    delete process.env.LOOM_FAKE_INJECT_FAIL;
    const before = notices(repo).length;
    await w.tick();
    await settle(300);
    eq(notices(repo).length, before + 1, "ONE delivery per tick, not a burst");
    eq(pending(repo).map((p) => p.role), ["developer2"], "and the older one is the one that went");
    await w.tick();
    await settle(300);
    eq(notices(repo).length, before + 2, "the next tick carries the next one");
    eq(pending(repo).length, 0, "each delivered exactly once");
  } finally { delete process.env.LOOM_FAKE_INJECT_FAIL; w.off(); }
});

suite("NF-001 wiring: a finish nobody can be told about is written where an agent reads", async () => {
  // POINT 5 OF THE HANDOFF. The toast is for a human looking at the editor; the party that has to
  // act on a stuck notification is an agent, so the fact lives in files: the queue with its attempts
  // in notify-state.json, and the summary in tracker-debug.json beside every other subsystem's.
  config();
  const repo = bus("nf-visible");
  const w = await window_([frame("wid-po", "po" + marker("productowner") + IDLE)]);
  clearInjectLog();
  // BOTH OF THESE FILES ARE MACHINE-GLOBAL, and every suite in this file uses the role name
  // `developer1`: left in place, the previous suite's `finishBacklog {owed: 1, role: "developer1"}`
  // satisfies every assertion below even if this suite's own tick wrote nothing. Removed first, and
  // the repo checked — DG-001-R2's finding was a digest reading a machine-global file and no test
  // failing over it.
  try { fs.unlinkSync(path.join(LOOM, "tracker-debug.json")); } catch {}
  try { fs.unlinkSync(path.join(LOOM, "notify-debug.json")); } catch {}
  process.env.LOOM_FAKE_INJECT_FAIL = "1";
  try {
    finish(repo);
    await w.tick();
    await settle(300);
    const dbg = readJson(path.join(LOOM, "tracker-debug.json"));
    eq(dbg.repo, repo, "written by THIS bus's tick, not left by the last suite");
    ok(dbg.finishBacklog, "the backlog is on the panel's own file");
    eq(dbg.finishBacklog.owed, 1, "one finish the orchestrator has not been told about");
    eq(dbg.finishBacklog.role, "developer1", "named");
    const dbg2 = readJson(path.join(LOOM, "notify-debug.json"));
    eq(dbg2.ok, false, "and the refusal itself is on record");
    eq(dbg2.target.repo, repo, "for this bus");

    // THE SUMMARY LAGS ONE TICK, and it is asserted here rather than hidden: the note is composed
    // from the queue at the START of a tick, while the refusal it reports arrives in the injector's
    // async callback near the END of one. `notify-debug.json` above carries the refusal immediately;
    // the panel line carries it from the next tick.
    await w.tick();
    await settle(300);
    match(readJson(path.join(LOOM, "tracker-debug.json")).finishBacklog.lastNote, /composer busy/,
          "the next tick's summary carries the injector's own words");

    // AND IT GOES AWAY WHEN IT IS NO LONGER TRUE. The note is only ever assigned under a condition,
    // so without a per-tick reset the panel would keep telling an agent to act on a delivered
    // notification for the life of the window.
    delete process.env.LOOM_FAKE_INJECT_FAIL;
    await w.tick();                       // delivers, at the end of the tick
    await settle(300);
    await w.tick();                       // …and THIS tick composes the note from an empty queue
    await settle(300);
    const after = readJson(path.join(LOOM, "tracker-debug.json"));
    eq(after.finishBacklog, undefined, "delivered, so the panel stops claiming a backlog");
  } finally { delete process.env.LOOM_FAKE_INJECT_FAIL; w.off(); }
});

suite("NF-001 wiring: a SECOND finish under the same key is not retired by the first injection", async () => {
  // THE REFUTATION PASS'S FINDING, and the sharpest one: `key` is `role|task|status`, and rerunning
  // a handoff produces that same key twice (notifier.test.js has a suite for it). An injection may
  // run 60 s against a 15 s tick, so a worker can finish, be re-dispatched, and finish AGAIN while
  // the first injector is still typing. Retiring by key would then mark the second finish delivered
  // on the strength of a message that carried the first — NF-001's own defect, wearing the
  // retirement key. Retirement is matched on the queued INSTANCE, so this cannot happen.
  config();
  const repo = bus("nf-same-key");
  const w = await window_([frame("wid-po", "po" + marker("productowner") + IDLE)]);
  clearInjectLog();
  process.env.LOOM_FAKE_INJECT_SLEEP = "1.2";
  try {
    finish(repo);
    const slow = w.tick();                                   // injector starts typing, and stays in
    await settle(250);
    eq(pending(repo).length, 1, "the first finish is in flight");
    setStatus(repo, "developer1", { role: "developer1", status: "working", current: "NF-7" });
    await w.tick();                                          // re-dispatched: the first is dropped
    await settle(50);
    finish(repo);                                            // …and finishes the SAME handoff again
    await w.tick();
    await settle(50);
    eq(pending(repo).length, 1, "the SECOND finish is owed");
    eq(pending(repo)[0].attempts, 0, "and has never been attempted");
    await slow;
    await settle(1500);                                      // the FIRST injection now comes back ok
    eq(pending(repo).length, 1, "it retires the instance IT carried, and nothing else");
    eq(delivered(repo).length, 0, "the second finish is not announced on the first one's delivery");
    eq(pending(repo)[0].key, "developer1|NF-7|idle", "it is still owed under the same key");
  } finally { delete process.env.LOOM_FAKE_INJECT_SLEEP; w.off(); }
});

suite("NF-001 wiring: a finish that reached NOBODY is recorded as dropped", async () => {
  // The supersede rule rests on "a role goes back to work because the orchestrator handed it a
  // block". health.ts's gate wake falsifies that — it puts a worker back to `working` and
  // deliberately does not tell the orchestrator — so the drop is recorded rather than trusted.
  config();
  const repo = bus("nf-dropped");
  const w = await window_([frame("wid-po", "po" + marker("productowner") + IDLE)]);
  clearInjectLog();
  try { fs.unlinkSync(path.join(LOOM, "tracker-debug.json")); } catch {}
  process.env.LOOM_FAKE_INJECT_FAIL = "1";
  try {
    finish(repo);
    await w.tick();
    await settle(300);
    eq(pending(repo).length, 1, "owed, and refused");
    setStatus(repo, "developer1", { role: "developer1", status: "working", current: "NF-8" });
    delete process.env.LOOM_FAKE_INJECT_FAIL;
    await w.tick();
    await settle(300);
    const st = readJson(stateFile(repo));
    eq(st.pending.length, 0, "dropped");
    eq(st.dropped.length, 1, "AND SAID SO — a drop nobody can see is the same defect wearing a hat");
    eq(st.dropped[0].key, "developer1|NF-7|idle", "which finish");
    match(st.dropped[0].why, /superseded/, "and why");
    const dbg = readJson(path.join(LOOM, "tracker-debug.json"));
    eq(dbg.repo, repo, "this bus");
    eq(dbg.finishBacklog.droppedUndelivered.length, 1, "carried to the panel even with an empty queue");
  } finally { delete process.env.LOOM_FAKE_INJECT_FAIL; w.off(); }
});
