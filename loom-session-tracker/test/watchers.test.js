// watchers.test.js — WC-001 §17: the orchestrator that armed a watcher.
//
// The detector's whole value is that it does NOT fire on the seven things it could easily fire on,
// so each exclusion is asserted in BOTH directions: the exclusion holds, AND the otherwise-identical
// record does produce a finding. Delete any guard in watchers.ts and one of these goes red.
//
// The classifier is pure over one JSONL record, so the false positives measured on real transcripts
// are pinned here as literal records rather than described in a comment.

const { suite, ok, eq, load, makeRepo, busPath, fixtureDir } = require("./harness");
const fs = require("fs");
const path = require("path");
const { classifyCall, scanAppended, watcherTick, watcherReminder, markWatcherReminded,
        loadWatchers, saveWatchers, WATCHER_TOOLS } = load("watchers.js");

/** An assistant record carrying one tool_use block. */
function rec(name, input = {}, over = {}) {
  return {
    type: "assistant", timestamp: "2026-09-17T12:00:00.000Z",
    message: { content: [{ type: "tool_use", name, input }] },
    ...over,
  };
}

const EMPTY = { sessionId: null, offset: 0, reminded: false, remindedSession: null,
                remindedDispatch: null, deliveredAt: null };

/** A bus where the orchestrator's identity records agree and a transcript exists. */
function input(over = {}) {
  return { repo: "r", orchestrator: "po", sessionId: "sid-1", transcript: "/t.jsonl",
           lastDispatch: "2026-09-17T10:00:00.000Z", ...over };
}

/** A scan stub — `watcherTick` takes the scanner so no transcript is needed on disk. */
const scanner = (armings, offset = 100) => () => ({ armings, offset });

const ONE = [{ kind: "Monitor", at: "2026-09-17T12:00:00.000Z" }];

// ── the classifier: what IS a watcher ───────────────────────────────────────────────────────────

suite("watchers: the three watcher tools are recognised by name", () => {
  for (const t of ["Monitor", "ScheduleWakeup", "CronCreate"]) {
    ok(WATCHER_TOOLS.has(t), `${t} is a watcher tool`);
    const hit = classifyCall(rec(t));
    ok(hit && hit.kind === t, `${t} classifies as an arming`);
  }
});

suite("watchers: a background shell loop OVER THE BUS is an arming", () => {
  const cmd = "until grep -q idle ~/.claude/loom/r/dev1/status.json; do sleep 5; done";
  const hit = classifyCall(rec("Bash", { command: cmd, run_in_background: true }));
  ok(hit && hit.kind === "loom-poll", "a bus poll is caught");
});

// ── (1) TEXT. The probe that answered §1 matched its own grep command. ──────────────────────────

suite("watchers: A RECORD THAT MERELY MENTIONS A WATCHER IS NOT ONE", () => {
  // Measured 2026-09-17: grepping every transcript for `<command-name>/loop</command-name>` returned
  // exactly one hit — the probe's own grep, echoed into its own transcript. This is that record.
  const selfProbe = rec("Bash", {
    command: "grep -rl '<command-name>/loop</command-name>' ~/.claude/projects --include='*.jsonl'",
  });
  eq(classifyCall(selfProbe), null, "a grep FOR watchers is not a watcher");
  const talking = { type: "assistant", timestamp: "t",
                    message: { content: [{ type: "text", text: "I will arm a Monitor and a /loop" }] } };
  eq(classifyCall(talking), null, "prose naming Monitor and /loop is not a tool call");
});

// ── (2) SUBAGENTS. §4 asks every role to fan out; a sidechain's watcher is its own business. ─────

suite("watchers: A SUBAGENT'S WATCHER IS NEVER THE ORCHESTRATOR'S", () => {
  eq(classifyCall(rec("Monitor", {}, { isSidechain: true })), null, "sidechain Monitor excluded");
  ok(classifyCall(rec("Monitor")), "the identical record in the main session IS caught");
});

// ── (3) ONE-SHOT BACKGROUND WORK — 1,873 of them in orchestrator dirs. ──────────────────────────

suite("watchers: BACKGROUND IS NOT A WATCHER — ONLY A LOOP IS", () => {
  const build = rec("Bash", { command: "npm run build > /tmp/build.log", run_in_background: true });
  eq(classifyCall(build), null, "a one-shot background build is not a watcher");
  // A SURVIVING MUTANT WROTE THIS LINE. Every "not a watcher" case above also lacked a bus path, so
  // dropping the loop requirement entirely still passed: reading the bus ONCE is not polling it, and
  // nothing asserted that until a mutant that kept only the bus-path test survived.
  const once = rec("Bash", { command: "cat ~/.claude/loom/r/dev1/status.json > /tmp/snap.json",
                             run_in_background: true });
  eq(classifyCall(once), null, "reading a status.json ONCE in the background is not polling it");
  const fg = rec("Bash", { command: "until grep -q x ~/.claude/loom/r/dev1/status.json; do sleep 5; done" });
  eq(classifyCall(fg), null, "without run_in_background it is not the §17 shape either");
});

// ── (4) THE ONE THAT WOULD HAVE SUNK IT — 787 bounded waits on build logs. ──────────────────────

suite("watchers: A BOUNDED WAIT ON A BUILD LOG IS NOT A BUS POLL", () => {
  // Measured verbatim shape from livegita's transcripts: a gate wait, not §17's subject.
  const gate = rec("Bash", {
    command: "until grep -qE '[0-9]+ passed|[0-9]+ failed' /tmp/claude-1000/lane.log; do sleep 3; done",
    run_in_background: true,
  });
  eq(classifyCall(gate), null, "waiting on a test log is not polling the bus");
  const bus = rec("Bash", {
    command: "until grep -qE 'idle' /home/x/.claude/loom/r/dev1/status.json; do sleep 3; done",
    run_in_background: true,
  });
  ok(classifyCall(bus), "the identical loop over a status.json IS caught");
});

// ── (6) A HUMAN TYPING INTO AN ORCHESTRATOR TAB. ────────────────────────────────────────────────

suite("watchers: A WATCHER THE HUMAN TYPED IS NOT REPORTED TO THE SESSION", () => {
  const typed = { type: "user", timestamp: "t",
                  message: { content: "<command-name>/loop</command-name>" } };
  eq(classifyCall(typed), null, "a user record is never an arming");
  // The structural half, and it is the one a mutant can reach: only the SESSION's own acts count, so
  // a non-assistant record is refused on its TYPE and not merely because its content is a string.
  const notOurs = { type: "user", timestamp: "t",
                    message: { content: [{ type: "tool_use", name: "Monitor", input: {} }] } };
  eq(classifyCall(notOurs), null, "a tool_use block on a non-assistant record is still not ours");
  const junk = [null, {}, { type: "assistant" }, { type: "assistant", message: { content: "s" } }];
  for (const j of junk) eq(classifyCall(j), null, "malformed records classify as nothing");
});

// ── (5) HISTORY — the first sight of a session baselines and counts nothing. ─────────────────────

suite("watchers: THE FIRST SIGHT OF A SESSION COUNTS NOTHING, however much history it holds", () => {
  const dir = fixtureDir("loom-wc-");
  const f = path.join(dir, "t.jsonl");
  // A transcript full of armings, all of them from before this detector ever ran.
  fs.writeFileSync(f, Array(5).fill(JSON.stringify(rec("Monitor"))).join("\n") + "\n");
  const r = watcherTick(input({ transcript: f }), { ...EMPTY });
  eq(r.finding, null, "no finding from history");
  ok(/first sight/.test(r.skip), "it says so rather than going silent");
  eq(r.state.offset, fs.statSync(f).size, "the whole existing file is baselined away");
  eq(r.state.sessionId, "sid-1", "and the session is remembered");

  // Now a NEW arming is appended — that one does count.
  fs.appendFileSync(f, JSON.stringify(rec("CronCreate")) + "\n");
  const r2 = watcherTick(input({ transcript: f }), r.state);
  ok(r2.finding, "an arming appended AFTER the baseline fires");
  eq(r2.finding.kinds.join(), "CronCreate", "and only the new one is reported");
});

suite("watchers: A CLEAR RE-BASELINES — a new session never inherits the old one's offset", () => {
  const dir = fixtureDir("loom-wc-");
  const f = path.join(dir, "t2.jsonl");
  fs.writeFileSync(f, JSON.stringify(rec("Monitor")) + "\n");
  const prev = { sessionId: "sid-OLD", offset: 999999, reminded: true, remindedSession: "sid-OLD",
                 remindedDispatch: "2026-09-17T10:00:00.000Z" };
  const r = watcherTick(input({ transcript: f }), prev);
  eq(r.finding, null, "the first tick of the new session counts nothing");
  eq(r.state.sessionId, "sid-1", "the new session is adopted");
  eq(r.state.offset, fs.statSync(f).size, "and its offset is the file, not the stale 999999");
  eq(r.state.reminded, false, "a new session is a new stretch — the latch re-arms");
  eq(r.state.remindedDispatch, null, "and the watermark it was delivered against goes with it");
});

// ── (7) PB-001's IDENTITY RULE — the defect this detector refuses to inherit. ────────────────────

suite("watchers: IDENTITY RECORDS THAT DISAGREE COUNT NOTHING AND RE-BASELINE NOTHING", () => {
  const prev = { ...EMPTY, sessionId: "sid-1", offset: 42 };
  let scanned = false;
  const r = watcherTick(input({ sessionId: null }), prev, () => { scanned = true; return { armings: ONE, offset: 9 }; });
  eq(r.finding, null, "a transition in flight produces no finding");
  ok(/transition is in flight/.test(r.skip), "and says why");
  ok(!scanned, "the transcript is not even read");
  eq(r.state.offset, 42, "THE OFFSET IS UNTOUCHED — re-baselining here would swallow real records");
  eq(r.state.sessionId, "sid-1", "and the remembered session is untouched too");
});

suite("watchers: an untagged bus and an unresolvable transcript are never judged", () => {
  eq(watcherTick(input({ orchestrator: null }), { ...EMPTY }).skip, "no tagged orchestrator");
  eq(watcherTick(input({ transcript: null }), { ...EMPTY }).skip, "no transcript for this session");
});

// ── the latch ───────────────────────────────────────────────────────────────────────────────────

suite("watchers: reminded ONCE per stretch, however many watchers are armed after it", () => {
  const seen = { ...EMPTY, sessionId: "sid-1" };
  const r1 = watcherTick(input(), seen, scanner(ONE));
  ok(r1.finding, "the first arming fires");
  const latched = markWatcherReminded(r1.state, "sid-1", "2026-09-17T10:00:00.000Z");
  const r2 = watcherTick(input(), latched, scanner(ONE));
  eq(r2.finding, null, "a second arming in the same stretch is not reported again");
  eq(r2.skip, "already reminded for this stretch");
});

suite("watchers: ONLY A CHANGED DISPATCH OR A NEW SESSION RE-ARMS IT", () => {
  const base = { ...EMPTY, sessionId: "sid-1" };
  const latched = markWatcherReminded(watcherTick(input(), base, scanner(ONE)).state,
                                      "sid-1", "2026-09-17T10:00:00.000Z");
  eq(latched.remindedDispatch, "2026-09-17T10:00:00.000Z",
     "delivery records the watermark it saw, not the moment it happened");
  // The SAME watermark stays latched: the world has reported nothing new.
  eq(watcherTick(input(), latched, scanner(ONE)).finding, null, "same watermark stays latched");
  // A newer dispatch re-arms — the orchestrator handed work over.
  ok(watcherTick(input({ lastDispatch: "2026-09-17T11:00:00.000Z" }), latched, scanner(ONE)).finding,
     "a newer dispatch re-arms the reminder");
  // And so does an EARLIER one — not a hypothetical: `lastDispatchAt` is a max over OPEN ledger
  // records, so a record CLOSING lowers the watermark. This is the accepted cost of the change,
  // one extra reminder per decrease, against a re-arm that could be lost.
  ok(watcherTick(input({ lastDispatch: "2026-09-17T09:00:00.000Z" }), latched, scanner(ONE)).finding,
     "an EARLIER watermark re-arms too — a changed watermark is a changed watermark");
  // A watermark that DISAPPEARS is not a dispatch, and must not re-arm.
  eq(watcherTick(input({ lastDispatch: null }), latched, scanner(ONE)).finding, null,
     "the watermark going away is not a new dispatch");
});

// ── WT-001: THE SWALLOW. ────────────────────────────────────────────────────────────────────────
// `remindedAt` held a dispatch watermark when one had been reported and the DELIVERY INSTANT when
// one had not (`lastDispatch ?? new Date()`), and the re-arm then asked `lastDispatch > remindedAt`
// — an ordering comparison between two different kinds of fact. `lastDispatchAt` returns null on an
// empty or unreadable ledger, so the second branch is reachable; and every `openedAt` that already
// exists is by construction earlier than a wall clock read now. So the first real dispatch the
// world reports after such a delivery CANNOT exceed the stamp, the re-arm is swallowed, and the
// watcher reminder never speaks again for that session.

suite("watchers: A REMINDER DELIVERED WITH NO WATERMARK STILL RE-ARMS ON THE NEXT DISPATCH", () => {
  const base = { ...EMPTY, sessionId: "sid-1" };
  // The tick that delivers sees no dispatch at all — an empty ledger, or one that did not read.
  const r1 = watcherTick(input({ lastDispatch: null }), base, scanner(ONE));
  ok(r1.finding, "it fires");
  const latched = markWatcherReminded(r1.state, "sid-1", null);
  eq(latched.remindedDispatch, null,
     "NULL IS A REAL OBSERVATION — the world had reported no dispatch, and that is not a latch key");
  eq(latched.reminded, true, "what WE did is what latches");
  ok(typeof latched.deliveredAt === "string",
     "the delivery instant is still recorded — it is just no longer comparable to a watermark");
  ok(latched.deliveredAt > "2026-09-17T10:00:00.000Z",
     "and it is a wall clock read, later than any openedAt already in the ledger");
  // It holds while nothing is reported.
  eq(watcherTick(input({ lastDispatch: null }), latched, scanner(ONE)).finding, null,
     "still nothing reported, still latched");
  // Now the ledger reports a real dispatch — one that HAPPENED BEFORE we delivered, which is every
  // dispatch already in it. Under the ordering comparison this is silence for the rest of the
  // session; under the identity comparison it is a re-arm.
  const after = watcherTick(input({ lastDispatch: "2026-09-17T10:00:00.000Z" }), latched, scanner(ONE));
  ok(after.finding, "THE RE-ARM IS NOT SWALLOWED");
  // Not once, and not by luck: the same state re-armed is then latched again by its own delivery.
  const relatched = markWatcherReminded(after.state, "sid-1", "2026-09-17T10:00:00.000Z");
  eq(relatched.remindedDispatch, "2026-09-17T10:00:00.000Z",
     "and the field now holds the watermark it has ACTUALLY seen, not the moment it spoke");
  eq(watcherTick(input({ lastDispatch: "2026-09-17T10:00:00.000Z" }), relatched, scanner(ONE)).finding,
     null, "so it latches again");
});

suite("watchers: A RE-ARM THE ORDERING COMPARISON WOULD SWALLOW FIRES ONCE, NOT EVERY TICK", () => {
  // Twenty ticks against a watermark that is EARLIER than the delivery instant — the shape `>`
  // answers "no" to. The ordering direction itself is graded by the mutant, not by this body.
  let st = markWatcherReminded({ ...EMPTY, sessionId: "sid-1" }, "sid-1", null);
  let fired = 0;
  for (let i = 0; i < 20; i++) {
    const r = watcherTick(input({ lastDispatch: "2026-09-17T10:00:00.000Z" }), st, scanner(ONE));
    if (r.finding) { fired++; st = markWatcherReminded(r.state, "sid-1", "2026-09-17T10:00:00.000Z"); }
    else st = r.state;
  }
  eq(fired, 1, "the swallowed re-arm is delivered exactly once, then latches honestly");
});

suite("watchers: A WATCHER ARMED AND NOTHING ELSE CHANGING DOES NOT OSCILLATE", () => {
  // The stall alarm's defect: a latch keyed on the CONDITION re-fires every time it flickers.
  let st = { ...EMPTY, sessionId: "sid-1" };
  let fired = 0;
  for (let i = 0; i < 20; i++) {
    const r = watcherTick(input(), st, scanner(i % 2 ? ONE : []));
    if (r.finding) { fired++; st = markWatcherReminded(r.state, "sid-1", "2026-09-17T10:00:00.000Z"); }
    else st = r.state;
  }
  eq(fired, 1, "ten armings across twenty ticks produce exactly one reminder");
});

// ── the message ─────────────────────────────────────────────────────────────────────────────────

suite("watchers: THE MESSAGE NEVER CLAIMS THE WATCHER IS RUNNING", () => {
  const m = watcherReminder({ repo: "r", orchestrator: "po", armings: ONE, kinds: ["Monitor"],
                              lastDispatch: null });
  ok(/armed/.test(m), "it speaks of the arming, which is a fact");
  ok(/may already\s+have been stopped/.test(m.replace(/\s+/g, " ")),
     "and says outright that it may already be stopped");
  ok(!/is running|currently running|still running/.test(m), "it never asserts a live watcher");
});

suite("watchers: the message names what to do instead, and carries no threshold or score", () => {
  const m = watcherReminder({ repo: "r", orchestrator: "po", armings: ONE, kinds: ["loom-poll"],
                              lastDispatch: null });
  ok(/status\.json goes working/.test(m), "it names the wake-ups that replace the watcher");
  ok(/15 seconds|one tick/.test(m), "and states the latency being traded");
  for (const w of ["threshold", "quota", "score", "limit of", "budget"]) {
    ok(!new RegExp(w, "i").test(m), `the message carries no ${w}`);
  }
  eq((m.match(/§/g) || []).length, 1, "the playbook is cited exactly once");
});

// ── the reader: appended-only, partial-line safe ─────────────────────────────────────────────────

suite("watchers: only APPENDED bytes are read, and a half-written record is not consumed", () => {
  const dir = fixtureDir("loom-wc-");
  const f = path.join(dir, "t3.jsonl");
  const line = JSON.stringify(rec("Monitor")) + "\n";
  fs.writeFileSync(f, line);
  const a = scanAppended(f, 0);
  eq(a.armings.length, 1, "the complete record is read");
  eq(a.offset, Buffer.byteLength(line), "and consumed");
  eq(scanAppended(f, a.offset).armings.length, 0, "a second scan re-reads nothing");

  // A record still being written: it must not be parsed, and its bytes must not be consumed.
  const half = JSON.stringify(rec("CronCreate")).slice(0, 40);
  fs.appendFileSync(f, half);
  const b = scanAppended(f, a.offset);
  eq(b.armings.length, 0, "a half-written record yields nothing");
  eq(b.offset, a.offset, "and is left unconsumed for the next tick");
  // Completed, it is read exactly once.
  fs.writeFileSync(f, line + JSON.stringify(rec("CronCreate")) + "\n");
  eq(scanAppended(f, a.offset).armings.length, 1, "once complete it is read");
});

suite("watchers: a truncated or replaced transcript is re-read from the start, not from a stale offset", () => {
  const dir = fixtureDir("loom-wc-");
  const f = path.join(dir, "t4.jsonl");
  fs.writeFileSync(f, JSON.stringify(rec("Monitor")) + "\n");
  eq(scanAppended(f, 10_000_000).armings.length, 1, "an offset past EOF restarts at 0");
  eq(scanAppended("/does/not/exist.jsonl", 5).offset, 5, "a missing file never throws and keeps its offset");
});

// ── the latch on disk ───────────────────────────────────────────────────────────────────────────

suite("watchers: the latch survives an extension reload, and a corrupt one reads as a fresh start", () => {
  const repo = makeRepo({}, "wc-latch");
  eq(loadWatchers(repo).sessionId, null, "no file reads as a fresh start, never as reminded");
  const st = { sessionId: "s", offset: 12, reminded: true, remindedSession: "s",
               remindedDispatch: "2026-09-17T10:00:00.000Z" };
  saveWatchers(repo, st);
  eq(loadWatchers(repo).offset, 12, "it round-trips");
  eq(loadWatchers(repo).remindedSession, "s", "including the latch");
  eq(loadWatchers(repo).reminded, true, "and the flag that IS the latch");
  eq(loadWatchers(repo).remindedDispatch, "2026-09-17T10:00:00.000Z", "and the watermark beside it");
  fs.writeFileSync(busPath(repo, "watcher-state.json"), "{not json");
  eq(loadWatchers(repo).reminded, false, "a corrupt latch reads as fresh rather than throwing");
});

// WT-001: the files already on disk when this ships. Nothing on disk says which kind of fact an old
// `remindedAt` holds — that ambiguity IS the defect — so it seeds the latch and NOT the watermark.
suite("watchers: A PRE-SPLIT STATE FILE LOADS, COSTS AT MOST ONE REMINDER, AND NEVER BURSTS", () => {
  const repo = makeRepo({}, "wc-migrate");
  fs.mkdirSync(path.dirname(busPath(repo, "watcher-state.json")), { recursive: true });
  fs.writeFileSync(busPath(repo, "watcher-state.json"), JSON.stringify(
    { sessionId: "sid-1", offset: 400, remindedAt: "2026-09-17T10:00:00.000Z",
      remindedSession: "sid-1", updatedAt: "2026-09-17T10:00:00.000Z" }));
  const st = loadWatchers(repo);
  eq(st.offset, 400, "it loads");
  eq(st.reminded, true, "an old stamp of either kind means a reminder WAS delivered — suppression kept");
  eq(st.remindedDispatch, null,
     "but it is not read as a watermark, because nothing on disk says it is one");
  // MEASURED, not assumed: a null watermark differs from any reported dispatch, so a bus whose
  // ledger has one re-arms on the FIRST tick after the upgrade. The upgrade is therefore not
  // silent — it costs ONE reminder, which is the price of refusing to guess which kind of fact
  // the old stamp held, and it is paid in the direction this bus prefers.
  const r = watcherTick(input(), st, scanner(ONE));
  ok(r.finding, "the upgrade costs one reminder on a bus that has dispatched");
  const again = markWatcherReminded(r.state, "sid-1", "2026-09-17T10:00:00.000Z");
  eq(watcherTick(input(), again, scanner(ONE)).finding, null, "ONE, not a burst");
  // A bus that has NOT dispatched keeps its suppression exactly, because null equals null.
  eq(watcherTick(input({ lastDispatch: null }), st, scanner(ONE)).finding, null,
     "and a bus with nothing to report stays silent through the upgrade");
});

// The file this bus actually has on disk today: `remindedAt` null, which is the unlatched shape.
suite("watchers: a pre-split file that never delivered reads as never delivered", () => {
  const repo = makeRepo({}, "wc-migrate-null");
  fs.mkdirSync(path.dirname(busPath(repo, "watcher-state.json")), { recursive: true });
  fs.writeFileSync(busPath(repo, "watcher-state.json"), JSON.stringify(
    { sessionId: "sid-1", offset: 5073596, remindedAt: null, remindedSession: null }));
  eq(loadWatchers(repo).reminded, false, "no stamp is no delivery, so nothing is suppressed");
});

suite("watchers: saving is change-only, so a quiet tick never churns the file", () => {
  const repo = makeRepo({}, "wc-churn");
  const st = { sessionId: "s", offset: 1, reminded: false, remindedSession: null,
               remindedDispatch: null };
  saveWatchers(repo, st);
  const before = fs.statSync(busPath(repo, "watcher-state.json")).mtimeMs;
  saveWatchers(repo, { ...st });
  eq(fs.statSync(busPath(repo, "watcher-state.json")).mtimeMs, before, "an unchanged save is a no-op");
});
