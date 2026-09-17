// quiet.test.js — NT-001: tell him when a project goes quiet.
//
// The detector is pure, so every claim quiet.ts makes is pinned here without a frame, a container or
// a clock. THE TWO THINGS THAT DECIDE WHETHER HE BELIEVES THE NOTIFICATION are asserted hardest:
//
//   1. `stoppedAt` is the moment activity ENDED, not the moment we noticed — he asked for the former
//      and the two differ by up to N.
//   2. ONE notification per stop, and the latch survives the exact flicker that made the stall alarm
//      fire four times in one day at the orchestrator. That case is asserted directly below, against
//      the condition-keyed shape it replaces.
//
// NOTHING HERE TOUCHES DOCKER OR A PHONE. Every push test drives an injected runner; the real one is
// never constructed. The handoff's line is "Send NOTHING to his phone from a test" and the way that
// is guaranteed is structural, not careful.

const { suite, ok, eq, load } = require("./harness");
const { quietTick, activityAt, markNotified, quietMessage, stoppedClock,
      DEFAULT_QUIET_MINUTES } = load("quiet.js");
const { sendPush, preflight, pushKey } = load("push.js");

const MIN = 60_000;
const NOW = Date.parse("2026-09-17T12:00:00.000Z");

/** A project observed doing nothing: a window is open, but no frame is mid-turn and no gate is live. */
function silent(over = {}) {
return { repo: "r", busyFrames: 0, framesSeen: 2, gateRunning: false,
         newestStatusAt: null, newestTranscriptAt: null, lastWhat: "dev1 · NT-001 · shipped", ...over };
}
/** A project observed WORKING right now. */
const busy = (over = {}) => silent({ busyFrames: 1, ...over });

const fresh = () => ({ lastActivityAt: 0, lastWhat: "", notifiedFor: null, seenActive: false });


// ── the unit is the project, and unknown is not idle ────────────────────────────────────────
suite("quiet: a project with no frames and no status files is UNKNOWN, not stopped", () => {
  const r = quietTick(silent({ framesSeen: 0 }), fresh(), NOW);
  eq(activityAt(silent({ framesSeen: 0 }), NOW), null);
  eq(r.finding, null);
  eq(r.skip, "project not observed this tick");
});

suite("quiet: a project never observed active is never reported — the 61 dormant repos", () => {
  // 71 transcript dirs exist on this machine; 10 did anything in 36h. A quiet project we have no
  // history for must produce nothing, however long it has been quiet.
  const st = { ...fresh(), lastActivityAt: NOW - 600 * MIN, seenActive: false };
  const r = quietTick(silent({ newestStatusAt: NOW - 600 * MIN }), st, NOW);
  eq(r.finding, null);
  eq(r.skip, "never observed active — no stop to report");
});

// ── a mid-turn frame and a live gate are both WORK ──────────────────────────────────────────
suite("quiet: a mid-turn frame is activity at NOW", () => { eq(activityAt(busy(), NOW), NOW); });

suite("quiet: a LIVE GATE is activity even with no frame mid-turn", () => {
  // An 18-minute mutation gate produces no frames and no writes. Without this it reads as a stop —
  // the exact false positive health.ts already paid for once (WL-006).
  eq(activityAt(silent({ gateRunning: true }), NOW), NOW);
  const st = { ...fresh(), lastActivityAt: NOW - 40 * MIN, seenActive: true };
  const r = quietTick(silent({ gateRunning: true }), st, NOW);
  eq(r.finding, null);
  eq(r.skip, "active");
});

suite("quiet: an OLD status write is a watermark, not liveness", () => {
  // The bug caught in review: if an old stamp were treated as "active", a project whose status.json
  // was last written hours ago would read as working for ever and never fire.
  const stamp = NOW - 30 * MIN;
  eq(activityAt(silent({ newestStatusAt: stamp }), NOW), stamp);
  const r = quietTick(silent({ newestStatusAt: stamp }), { ...fresh(), seenActive: true }, NOW);
  ok(r.finding, "an old watermark must still be able to go quiet");
  eq(r.finding.stoppedAt, stamp);
});

// ── 2 · WHEN IT STOPPED IS WHEN IT ENDED ────────────────────────────────────────────────────
suite("quiet: stoppedAt is when activity ENDED, not when we noticed", () => {
  const ended = NOW - 22 * MIN;
  const st = { lastActivityAt: ended, lastWhat: "dev1 · NT-001", notifiedFor: null, seenActive: true };
  const r = quietTick(silent(), st, NOW);
  ok(r.finding, "22 minutes quiet at N=15 must fire");
  eq(r.finding.stoppedAt, ended);
  ok(r.finding.stoppedAt !== NOW, "must not report the moment of noticing");
  ok(r.finding.stoppedAt !== NOW - DEFAULT_QUIET_MINUTES * MIN, "must not report now-N either");
  eq(r.finding.quietMinutes, 22);
});

suite("quiet: the clock runs from the watermark, so an already-old watermark fires sooner", () => {
  // A project whose last write was 9 minutes before it fell silent reaches N nine minutes sooner.
  const st = { ...fresh(), lastActivityAt: NOW - 16 * MIN, seenActive: true };
  ok(quietTick(silent(), st, NOW).finding, "16 min old watermark fires at N=15");
  const young = { ...fresh(), lastActivityAt: NOW - 14 * MIN, seenActive: true };
  eq(quietTick(silent(), young, NOW).finding, null);
  eq(quietTick(silent(), young, NOW).skip, "active");
});

suite("quiet: N is configurable and is the threshold that decides", () => {
  const st = { ...fresh(), lastActivityAt: NOW - 20 * MIN, seenActive: true };
  ok(quietTick(silent(), st, NOW, 15).finding, "quiet 20 min, N=15 -> fires");
  eq(quietTick(silent(), st, NOW, 30).finding, null, "quiet 20 min, N=30 -> silent");
});

// ── 3 · THE LATCH · one notification per stop ───────────────────────────────────────────────
suite("quiet: fires ONCE, then stays silent however long the project stays quiet", () => {
  const ended = NOW - 20 * MIN;
  let st = { ...fresh(), lastActivityAt: ended, seenActive: true, lastWhat: "x" };
  const first = quietTick(silent(), st, NOW);
  ok(first.finding, "first stop fires");
  st = markNotified(first.state);
  for (const later of [NOW + 5 * MIN, NOW + 60 * MIN, NOW + 600 * MIN]) {
    const r = quietTick(silent(), st, later);
    eq(r.finding, null);
    eq(r.skip, "already notified for this stop");
    st = r.state;
  }
});

suite("quiet: THE STALL-ALARM FLICKER: quietness coming and going does NOT re-arm the latch", () => {
  // health.ts:676 deletes a role's latch the moment it is not reported stalled on a tick, so any
  // flicker re-arms it — four fires in one day at the orchestrator. Here the latch is keyed on the
  // ACTIVITY WATERMARK, an event, so the same flicker cannot clear it. Re-key it to the quiet
  // condition and this test goes red.
  const ended = NOW - 20 * MIN;
  let st = markNotified(quietTick(silent(), { ...fresh(), lastActivityAt: ended, seenActive: true }, NOW).state);
  // The project is seen at the SAME watermark again and again — a status file rewritten with no new
  // mtime, a tick landing on the boundary. None of it is new activity.
  for (let i = 0; i < 5; i++) {
    const r = quietTick(silent({ newestStatusAt: ended }), st, NOW + i * MIN);
    eq(r.finding, null, "an unchanged watermark must never re-fire");
    st = r.state;
  }
  eq(st.notifiedFor, ended);
});

suite("quiet: REAL new activity re-arms, and the next stop fires with the NEW time", () => {
  const ended = NOW - 20 * MIN;
  let st = markNotified(quietTick(silent(), { ...fresh(), lastActivityAt: ended, seenActive: true }, NOW).state);
  // It starts working again.
  const back = NOW + MIN;
  st = quietTick(busy(), st, back).state;
  eq(st.notifiedFor, null, "genuine new activity must re-arm the latch");
  eq(st.lastActivityAt, back);
  // ...and stops again.
  const r = quietTick(silent(), st, back + 16 * MIN);
  ok(r.finding, "a second, genuine stop must fire");
  eq(r.finding.stoppedAt, back, "and must report the SECOND stop's time, not the first");
});

// ── the message ─────────────────────────────────────────────────────────────────────────────
suite("quiet: the message names the project, the time, and what was last done", () => {
  const m = quietMessage({ repo: "vs_code_extensions", stoppedAt: NOW, quietMinutes: 17,
                           lastWhat: "developer1 · NT-001 · shipped" });
  ok(m.title.includes("vs_code_extensions"), "title names the project");
  ok(m.title.includes("stopped"), "title says what happened");
  ok(m.body.includes(stoppedClock(NOW)), "body carries the clock time it stopped");
  ok(m.body.includes("NT-001"), "body carries what was last done");
  ok(m.title.length <= 200, "title fits Notification.title varchar(200)");
});

suite("quiet: a project with no recorded block still gets an honest body", () => {
  const st = { ...fresh(), lastActivityAt: NOW - 20 * MIN, seenActive: true, lastWhat: "" };
  const r = quietTick(silent({ lastWhat: null }), st, NOW);
  eq(r.finding.lastWhat, "no completed block recorded");
});

// ── the transport · NOTHING REACHES DOCKER OR A PHONE ───────────────────────────────────────
/** Records what would have been run and replies with a script. */
function fakeRunner(reply) {
  const calls = [];
  const run = async (file, args, env, timeoutMs) => {
    calls.push({ file, args, env, timeoutMs });
    return reply(args);
  };
  return { run, calls };
}
const okSend = () => ({ code: 0, stdout: "LOOMPUSH:SENT\n", stderr: "" });

suite("quiet: the payload rides in argv, never interpolated into the python", async () => {
  // A project name and another role's last_line reach a Python interpreter. If they were pasted
  // into the code, this string would end the statement. It must appear as a VALUE and the code must
  // be byte-identical to the no-quote case.
  const nasty = `'); import os; os.system('touch /tmp/pwned`;
  const f = fakeRunner(okSend);
  await sendPush({ container: "c", timeoutSec: 5 }, nasty, "body", "k", f.run);
  const { args } = f.calls[0];
  const py = args[args.length - 1];
  ok(!py.includes(nasty), "the payload must NOT appear in the python source");
  ok(py.includes("os.environ['LOOM_TITLE']"), "the python reads its values from the environment");
  ok(args.includes(`LOOM_TITLE=${nasty}`), "the payload rides as a docker -e argv entry");
  ok(args[0] === "exec" && args.includes("c"), "it is a docker exec at the configured container");
});

suite("quiet: a delivered send is reported delivered; a dedupe is NOT", () => {
  // emit_system_alert returns None when a row with that dedup_key is already standing and sends
  // nothing, with exit code 0 either way. Treating that as delivered would latch a stop that never
  // reached him.
  return (async () => {
    const sent = fakeRunner(okSend);
    eq((await sendPush({ container: "c", timeoutSec: 5 }, "t", "b", "k", sent.run)).delivered, true);
    const dup = fakeRunner(() => ({ code: 0, stdout: "LOOMPUSH:DEDUPED\n", stderr: "" }));
    const r = await sendPush({ container: "c", timeoutSec: 5 }, "t", "b", "k", dup.run);
    eq(r.delivered, false, "a dedupe is not a delivery");
    ok(/dedup/i.test(r.note), "and it says so");
  })();
});

suite("quiet: a dead container is off and says so — it never invents a transport", async () => {
  const dead = fakeRunner(() => ({ code: 1, stdout: "", stderr: "Error: Container xyz is not running" }));
  const r = await preflight({ container: "c", timeoutSec: 5 }, dead.run);
  eq(r.delivered, false);
  ok(/not running/.test(r.note), "the panel is told which door failed");
  ok(r.note.startsWith("off —"), "the feature reports itself OFF");
});

suite("quiet: preflight refuses when the backend has no service account — the SILENT failure", async () => {
  // firebase_push returns without sending when the service account is absent, but the row is still
  // created and emit_system_alert still returns a Notification — so a send alone reports success
  // while the phone stays dark. This is the check that catches it.
  const noCreds = fakeRunner(() => ({ code: 0, stdout: "LOOMPUSH:READY:True:False\n", stderr: "" }));
  const r = await preflight({ container: "c", timeoutSec: 5 }, noCreds.run);
  eq(r.delivered, false);
  ok(/service account/.test(r.note));
  const off = fakeRunner(() => ({ code: 0, stdout: "LOOMPUSH:READY:False:True\n", stderr: "" }));
  ok(/FCM_ENABLED/.test((await preflight({ container: "c", timeoutSec: 5 }, off.run)).note));
  const ready = fakeRunner(() => ({ code: 0, stdout: "LOOMPUSH:READY:True:True\n", stderr: "" }));
  eq((await preflight({ container: "c", timeoutSec: 5 }, ready.run)).delivered, true);
});

suite("quiet: no credential is ever read, named or logged by the extension", async () => {
  const f = fakeRunner(okSend);
  await preflight({ container: "c", timeoutSec: 5 }, f.run);
  await sendPush({ container: "c", timeoutSec: 5 }, "t", "b", "k", f.run);
  const all = JSON.stringify(f.calls);
  ok(!/firebase-service-account|private_key|FCMDevice|BEGIN PRIVATE/.test(all),
     "no credential path, token table or key material may appear in anything we run");
  // The preflight asks only whether the file EXISTS.
  ok(/os\.path\.exists/.test(f.calls[0].args[f.calls[0].args.length - 1]),
     "readiness is an existence check, never a read");
});

suite("quiet: as_of_date is never sent — it would dismiss his other alerts", async () => {
  const f = fakeRunner(okSend);
  await sendPush({ container: "c", timeoutSec: 5 }, "t", "b", "k", f.run);
  const all = JSON.stringify(f.calls);
  ok(!/as_of_date/.test(all),
     "TradingFCMService dismisses the on-device batch whenever as_of_date is present");
});

suite("quiet: the push key is unique per stop, so two windows racing dedupe instead of buzzing twice", () => {
  const a = pushKey("repo", 1000), b = pushKey("repo", 2000);
  ok(a !== b, "a different stop is a different key");
  eq(pushKey("repo", 1000), a, "the SAME stop is the same key — the cross-window backstop");
  ok(a.length <= 200, "dedup_key is varchar(200)");
});



// ── NT-001-R1 · ONLY A PROJECT WHOSE WINDOW IS OPEN ────────────────────────────────────────────
//
// His convention, verbatim: "The notification should only be sent about project windows that are
// open. So if I walk away from something, I will close it." So a closed window is an EXPLICIT
// request for silence, and these tests pin the three things that can go wrong with honouring it:
//
//   1. THE REQUIREMENT EXISTS AT ALL. Without a test that an open window is REQUIRED, "we only
//      notify about open windows" is an unfalsifiable claim — the mutant that deletes the check
//      must fail something.
//   2. DOUBT IS NOT CLOSURE. An unreadable window list must withhold, never drop. This is the
//      direction of failure that produces no complaint: a notification that never arrives, about a
//      stop you were not sure of, is indistinguishable from a quiet night.
//   3. A DROP DOES NOT COME BACK. Reopening a window is not a request for the stop that happened
//      while it was shut.
const { windowOpenness, gateByOpenWindow, markDropped } = load("quiet.js");

/** A window list as cdp.openWindowRoots yields one. */
const seen = (...roots) => ({ pages: roots.length, roots });
const noRoles = () => [];

suite("quiet R1: a window whose folder IS the repo means OPEN", () => {
  eq(windowOpenness(seen("vs_code_extensions"), "vs_code_extensions", []), "open");
  eq(windowOpenness(seen("other", "vs_code_extensions"), "vs_code_extensions", []),
     "open", "one matching window among several is enough — he has many windows");
});

suite("quiet R1: a WORKTREE window counts as the project's window", () => {
  // `.claude/worktrees/developer1` presents itself by its own basename, so the roster is the map.
  eq(windowOpenness(seen("developer1"), "vs_code_extensions", ["productowner", "developer1"]),
     "open", "a worker's worktree window is that project's window");
  eq(windowOpenness(seen("developer1"), "vs_code_extensions", []),
     "closed", "and a role this project does not have is not its window");
});

suite("quiet R1: windows are seen, none of them this project's -> CLOSED", () => {
  eq(windowOpenness(seen("ReciEats", "Lumen"), "vs_code_extensions", ["developer1"]), "closed");
});

suite("quiet R1: a window with NO FOLDER open is a real window and nobody's project", () => {
  // It raises `pages` and contributes no name: it cannot make a project open, and its presence
  // means the read DID work, so the verdict is a genuine `closed` rather than doubt.
  eq(windowOpenness({ pages: 2, roots: [] }, "vs_code_extensions", []), "closed");
});

suite("quiet R1: AN UNREADABLE WINDOW LIST IS UNKNOWN, NEVER CLOSED", () => {
  eq(windowOpenness(null, "r", []), "unknown", "the read failed — that is not a closed window");
  eq(windowOpenness({ pages: 0, roots: [] }, "r", []), "unknown",
     "a read that lists NO window at all contradicts running inside one — doubt, not closure");
  eq(windowOpenness({ pages: 3, roots: null }, "r", []), "unknown", "a malformed shape is doubt too");
  eq(windowOpenness(undefined, "r", []), "unknown");
});

suite("quiet R1: THE GATE — an open window sends, a closed one drops, doubt withholds", () => {
  const f = [{ repo: "vs_code_extensions" }];
  const g1 = gateByOpenWindow(f, seen("vs_code_extensions"), noRoles);
  eq(g1.send.length, 1, "open -> sent"); eq(g1.dropped.length, 0); eq(g1.withheld.length, 0);

  const g2 = gateByOpenWindow(f, seen("somethingelse"), noRoles);
  eq(g2.send.length, 0, "closed -> NOT sent"); eq(g2.dropped.length, 1, "and dropped, not withheld");

  const g3 = gateByOpenWindow(f, null, noRoles);
  eq(g3.send.length, 0, "unknown -> NOT sent");
  eq(g3.dropped.length, 0, "and NOT dropped — a dropped stop is gone for good");
  eq(g3.withheld.length, 1, "withheld, so the next readable tick still reports it");
});

suite("quiet R1: the gate decides PER PROJECT — one closed window never silences another", () => {
  const g = gateByOpenWindow([{ repo: "alpha" }, { repo: "beta" }], seen("beta"), noRoles);
  eq(g.send.map((f) => f.repo), ["beta"]);
  eq(g.dropped.map((f) => f.repo), ["alpha"]);
});

suite("quiet R1: a roster lookup that throws is contained, and sends nothing", () => {
  const g = gateByOpenWindow([{ repo: "r" }], seen("r2"), () => { throw new Error("no board"); });
  // The roles are unknown, so a name-only verdict stands: `r2` is not `r`, hence closed. What must
  // NOT happen is an exception escaping into a tick.
  eq(g.send.length, 0, "nothing is sent on a broken roster");
  eq(g.dropped.length + g.withheld.length, 1, "and the finding is accounted for rather than lost");
});

suite("quiet R1: A CLOSED WINDOW DROPS THE STOP — and a REOPENED window never backfills it", () => {
  // He walked away at 12:00, the threshold elapsed at 12:15 with the window shut, and he reopens it
  // at 14:00. The stop must never arrive — it is two hours stale and he asked not to hear it.
  const stopped = NOW - 20 * MIN;
  let st = { lastActivityAt: stopped, lastWhat: "dev1 · NT-001 · shipped", notifiedFor: null, seenActive: true };
  const r = quietTick(silent(), st, NOW);
  ok(r.finding, "the stop IS detected — openness gates the SEND, not the detection");
  eq(r.finding.stoppedAt, stopped, "and stoppedAt is still the moment activity ENDED");

  st = markDropped(r.state);                       // window was closed at send time
  const later = quietTick(silent(), st, NOW + 120 * MIN);   // window reopened, still nothing running
  eq(later.finding, null, "the reopened window does not deliver the old stop");
  eq(later.skip, "already notified for this stop", "the latch holds it, by the same mechanism");
});

suite("quiet R1: a drop latches the WATERMARK, so a NEW stop after it still reports", () => {
  // Dropping must silence ONE stop, not the project. If he closes a window, reopens it, works, and
  // walks away again, that second stop is a new event and he wants it.
  const st = markDropped({ lastActivityAt: NOW - 20 * MIN, lastWhat: "x", notifiedFor: null, seenActive: true });
  const worked = quietTick(busy(), st, NOW);                       // new activity re-arms
  eq(worked.state.notifiedFor, null, "new activity cleared the drop latch");
  const again = quietTick(silent(), worked.state, NOW + 20 * MIN);
  ok(again.finding, "the NEXT stop is reported normally");
  eq(again.finding.stoppedAt, NOW, "and it is the new stop, not the dropped one");
});

suite("quiet R1: withholding latches NOTHING — an unreadable tick loses no notification", () => {
  const st = { lastActivityAt: NOW - 20 * MIN, lastWhat: "x", notifiedFor: null, seenActive: true };
  const r = quietTick(silent(), st, NOW);
  ok(r.finding, "the stop is found");
  const held = gateByOpenWindow([{ repo: "r" }], null, noRoles);
  eq(held.withheld.length, 1);
  // The state is untouched by withholding — there is no markWithheld, deliberately.
  const next = quietTick(silent(), r.state, NOW + MIN);
  ok(next.finding, "so the very next tick finds the same stop again and can report it");
  eq(next.finding.stoppedAt, r.finding.stoppedAt, "as the SAME stop, with the same instant");
});


// ══ NT-001-R2 · THE ORCHESTRATOR'S CLOSING SUMMARY RIDES ALONG ═══════════════════════════════════
//
// His words: "when a project is truly done it usually ends with a summary from the orchestrator, and
// I want that summary to come along with the notification." He is away from his desk, so what the
// phone says is all he gets.
//
// THE THREE CLAIMS ASSERTED HARDEST, because they are the three that decide whether he can trust it:
//   1. WHICH message — the orchestrator's last spoken TEXT, never a tool call, a tool result, a
//      thinking block, a subagent, or a line this extension typed into it.
//   2. A CUT IS NEVER SILENT — a summary that stops dead mid-sentence reads as a crashed agent, so
//      every truncation carries a marker saying so, and the marker is inside the byte budget.
//   3. IT MAY ADD, AND MAY NEVER SUBTRACT — every failure path falls back to the EXACT body NT-001
//      sends today, and nothing here can throw into a tick.
const { assistantText, lastAssistantText, SUMMARY_TAIL_BYTES } = load("watchers.js");
const { truncateHonestly, SUMMARY_BUDGET_BYTES, FCM_PAYLOAD_BYTES } = load("push.js");
const { orchestratorSaid } = load("quiet.js");

const fs2 = require("fs");
const os2 = require("os");
const path2 = require("path");

/** A transcript record, in the shape the CLI actually writes. */
const rec = (type, content, over = {}) => ({
  type, isSidechain: false, timestamp: "2026-09-17T12:00:00.000Z",
  message: { content }, ...over,
});
const textBlock = (t) => ({ type: "text", text: t });


// ── 1 · WHICH MESSAGE ───────────────────────────────────────────────────────────────────────────

suite("R2: the orchestrator's own spoken text is what is read", () => {
  const r = assistantText(rec("assistant", [textBlock("All three lanes are green. 981/981.")]));
  ok(r, "an assistant text record qualifies");
  eq(r.text, "All three lanes are green. 981/981.");
  eq(r.at, "2026-09-17T12:00:00.000Z", "and it carries the record's own instant");
});

suite("R2: a TOOL CALL is not something it said", () => {
  // He asked what the orchestrator TOLD him. A tool_use block is not speech, and it is the most
  // common trailing block there is — a run that ends on a Bash call would otherwise report the call.
  eq(assistantText(rec("assistant", [{ type: "tool_use", name: "Bash", input: { command: "ls" } }])), null);
});

suite("R2: a TOOL RESULT is not something it said", () => {
  eq(assistantText(rec("assistant", [{ type: "tool_result", content: "981 passed" }])), null);
});

suite("R2: THINKING is not something it said", () => {
  // The part it deliberately did not tell him. Sending it would put private reasoning on his phone.
  eq(assistantText(rec("assistant", [{ type: "thinking", thinking: "maybe the latch is wrong" }])), null);
});

suite("R2: from a mixed turn, ONLY the spoken text is taken", () => {
  const r = assistantText(rec("assistant", [
    { type: "thinking", thinking: "private" },
    { type: "tool_use", name: "Bash", input: { command: "./test.sh" } },
    textBlock("Committed as 46ef86b."),
  ]));
  eq(r.text, "Committed as 46ef86b.", "the thinking and the tool call are both absent");
});

suite("R2: a SUBAGENT's message is not the orchestrator speaking", () => {
  // §4 tells every role to fan out. A subagent reporting to its parent is not the orchestrator
  // reporting to him, and it is the LAST thing in the file whenever a turn ends on a fan-out.
  eq(assistantText(rec("assistant", [textBlock("subagent done")], { isSidechain: true })), null);
});

suite("R2: a USER record is never read as the orchestrator speaking", () => {
  eq(assistantText(rec("user", [textBlock("check your inbox")])), null);
});


// ── the injected-message rule, which is the one he would notice ─────────────────────────────────

suite("R2: A LINE THIS EXTENSION TYPED IN IS NEVER QUOTED BACK AT HIM", () => {
  // "A stop summary that quotes our own [loom-ledger] line back at him would be absurd." The FIRST
  // defence is structural — injectTo types into a COMPOSER, so an injected message is a `user`
  // record and the rule above already excludes it. This covers the case structure cannot: the
  // session repeating our line as its own words, which an orchestrator that was just sent one may
  // well do.
  eq(assistantText(rec("assistant", [textBlock("[loom-ledger] Only 10% of agent output ships.")])), null);
  eq(assistantText(rec("assistant", [textBlock("[loom-watch] This session armed a Monitor.")])), null);
});

suite("R2: the injected-line rule is keyed on the SHAPE, not on the nine markers that exist today", () => {
  // A tenth marker added next month must be covered without anyone remembering to come back here.
  eq(assistantText(rec("assistant", [textBlock("[loom-somethingnew] a marker invented later")])), null);
});

suite("R2: a summary that MENTIONS a reminder in passing is still his summary", () => {
  // The rule must not be a substring search. Only a LEADING marker is ours; an orchestrator writing
  // about the reminder it received is speaking, and he asked to hear it.
  const r = assistantText(rec("assistant",
    [textBlock("I stopped the Monitor after the [loom-watch] reminder, and banked at 30%.")]));
  ok(r, "not rejected");
  ok(/banked at 30%/.test(r.text), "and it arrives whole");
});

suite("R2: empty, blank and shapeless records are nothing to say", () => {
  eq(assistantText(rec("assistant", [textBlock("   ")])), null, "whitespace is not a summary");
  eq(assistantText(rec("assistant", [])), null);
  eq(assistantText(rec("assistant", null)), null);
  eq(assistantText(null), null);
  eq(assistantText({ type: "assistant" }), null);
});

suite("R2: the legacy plain-string content shape is read too", () => {
  const r = assistantText(rec("assistant", "an older record's content"));
  ok(r, "not dropped as unreadable");
  eq(r.text, "an older record's content");
});


// ── 2 · READING IT OFF DISK, FROM THE TAIL ──────────────────────────────────────────────────────

const TXDIR = path2.join(os2.homedir(), ".claude", "r2-transcripts");
function transcript(name, lines) {
  fs2.mkdirSync(TXDIR, { recursive: true });
  const f = path2.join(TXDIR, name);
  fs2.writeFileSync(f, lines.map((l) => (typeof l === "string" ? l : JSON.stringify(l))).join("\n") + "\n");
  return f;
}

suite("R2: the LAST thing it said is what is read, not the first", () => {
  const f = transcript("order.jsonl", [
    rec("assistant", [textBlock("starting the block")]),
    rec("assistant", [textBlock("halfway through")]),
    rec("assistant", [textBlock("DONE - 981/981, committed as 46ef86b.")]),
  ]);
  eq(lastAssistantText(f).text, "DONE - 981/981, committed as 46ef86b.");
});

suite("R2: trailing TOOL CALLS after the last message do not hide it", () => {
  // The common real shape: the orchestrator speaks, then runs a few more tools. Measured, the last
  // assistant text sits a median of 3.9 KB back from EOF for exactly this reason.
  const f = transcript("trailing.jsonl", [
    rec("assistant", [textBlock("All green - banking now.")]),
    rec("assistant", [{ type: "tool_use", name: "Bash", input: { command: "git commit" } }]),
    rec("user", [{ type: "tool_result", content: "[main 46ef86b]" }]),
    rec("assistant", [{ type: "tool_use", name: "Bash", input: { command: "git push" } }]),
  ]);
  eq(lastAssistantText(f).text, "All green - banking now.");
});

suite("R2: reading is BOUNDED - the tail is what is read, not the file", () => {
  // The cost claim. A message older than the tail is not found, and that is the designed outcome:
  // the notification falls back rather than the read growing without limit on a 171 MB transcript.
  const filler = JSON.stringify(rec("user", [{ type: "tool_result", content: "x".repeat(4000) }]));
  const f = transcript("big.jsonl", [
    rec("assistant", [textBlock("said long ago, beyond the tail")]),
    ...Array.from({ length: 12 }, () => filler),
  ]);
  eq(lastAssistantText(f, 2048), null, "a 2 KB tail cannot reach it - and says so with null");
  ok(lastAssistantText(f, 1 << 20), "a tail that reaches it finds it");
  eq(SUMMARY_TAIL_BYTES, 256 * 1024, "the shipped tail is 256 KB - ~14x the measured 17.6 KB worst case");
});

suite("R2: a record split by the tail boundary is dropped, never half-parsed", () => {
  const f = transcript("split.jsonl", [
    rec("assistant", [textBlock("earlier")]),
    rec("assistant", [textBlock("the real last word")]),
  ]);
  const size = fs2.statSync(f).size;
  // A tail that lands in the middle of the FIRST record: the fragment is not JSON, and must not
  // throw or be guessed at.
  const r = lastAssistantText(f, size - 20);
  eq(r.text, "the real last word", "the intact record is still read");
});

suite("R2: an unreadable transcript is a null, never an exception", () => {
  eq(lastAssistantText(path2.join(TXDIR, "does-not-exist.jsonl")), null);
  eq(lastAssistantText(transcript("empty.jsonl", [])), null, "an empty file has nothing to say");
  eq(lastAssistantText(transcript("junk.jsonl", ["{not json", "also not json"])), null);
});

suite("R2: a corrupt line next to a good one does not lose the good one", () => {
  const f = transcript("mixed.jsonl", [
    rec("assistant", [textBlock("the summary")]),
    "{ truncated assistant garbage",
  ]);
  eq(lastAssistantText(f).text, "the summary");
});


// ── 3 · THE SIZE BUDGET, AND HONEST TRUNCATION ──────────────────────────────────────────────────

suite("R2: a summary inside the budget is untouched", () => {
  const s = "Everything is green. 981/981 both modes, committed as 46ef86b.";
  eq(truncateHonestly(s), s, "no marker, no cut, nothing added");
});

suite("R2: A CUT IS NEVER SILENT - this is the claim, and it is the whole requirement", () => {
  // "A summary silently ending mid-sentence reads as a crashed agent." He is away from his desk and
  // cannot check; a message that stops dead is indistinguishable from an orchestrator that died.
  const long = "The migration is complete. ".repeat(400);          // ~10.8 KB
  const out = truncateHonestly(long);
  ok(out.length < long.length, "it was cut");
  ok(/\[cut - \d+ of \d+ characters\]$/.test(out), "and the body SAYS it was cut, with real numbers");
});

suite("R2: the cut marker is INSIDE the budget, not added to it", () => {
  // Otherwise the function that exists to enforce the bound is the thing that breaks it.
  const long = "x".repeat(9000);
  eq(Buffer.byteLength(truncateHonestly(long), "utf8") <= SUMMARY_BUDGET_BYTES, true);
  const tight = truncateHonestly(long, 300);
  eq(Buffer.byteLength(tight, "utf8") <= 300, true, "at any budget, including a small one");
  ok(/\[cut - /.test(tight), "and it is still honest at a small budget");
});

suite("R2: the budget is measured in BYTES, so a multi-byte summary cannot overrun", () => {
  // A real summary quotes paths, box-drawing comment rules and the occasional emoji. `slice` cuts by
  // UTF-16 code unit, so a character count would let a 3-byte-per-char message overrun by 3x.
  const wide = "\u2192 ".repeat(3000);
  const out = truncateHonestly(wide);
  eq(Buffer.byteLength(out, "utf8") <= SUMMARY_BUDGET_BYTES, true,
     "bytes, not characters: " + Buffer.byteLength(out, "utf8"));
});

suite("R2: the whole payload stays well inside the FCM bound", () => {
  // The arithmetic in push.ts, asserted rather than trusted: title + key + body-prefix + summary +
  // an envelope this module cannot see must leave real headroom, because overrunning is a REJECTED
  // send - a notification he never learns was missed.
  const worst = SUMMARY_BUDGET_BYTES + 200 /* title */ + 200 /* dedup_key */ + 250 /* body prefix */;
  eq(worst < FCM_PAYLOAD_BYTES, true, "worst case " + worst + " is inside " + FCM_PAYLOAD_BYTES);
  ok(FCM_PAYLOAD_BYTES - worst > 1000, "with >1 KB spare for the envelope estimate to be wrong about");
});


// ── 4 · THE MESSAGE HE READS ────────────────────────────────────────────────────────────────────

const r2finding = { repo: "vs_code_extensions", stoppedAt: NOW, quietMinutes: 22.4,
                    lastWhat: "developer1 - NT-001-R2 - shipped" };

suite("R2: WITH NO SUMMARY, the body is EXACTLY what NT-001 sends today", () => {
  // The fallback, asserted literally. "The notification's existing job does not depend on this
  // feature working" - so this is pinned character for character, not merely checked for a substring.
  const before = "Quiet since " + stoppedClock(NOW) + " (22.4 min). Last: developer1 - NT-001-R2 - shipped";
  eq(quietMessage(r2finding).body, before, "no summary");
  eq(quietMessage(r2finding, null).body, before, "an explicit null");
  eq(quietMessage(r2finding, { role: "product-owner", text: "" }).body, before, "an empty summary");
});

suite("R2: with a summary, his words arrive AND are attributed to the role that said them", () => {
  const m = quietMessage(r2finding, { role: "product-owner", text: "Both lanes green. 981/981." });
  ok(/Quiet since \d\d:\d\d/.test(m.body), "the existing message is still there, first");
  ok(/Both lanes green\. 981\/981\./.test(m.body), "and his summary came along");
  ok(/product-owner/.test(m.body), "attributed to the role, so he knows whose account this is");
});

suite("R2: the message does not claim the summary is a VERDICT, or that it is a closing one", () => {
  // Limit #4 carried forward: this is the orchestrator's own account of itself, exactly as
  // `lastWhat` is. And measured - over 155 transcripts there is NO structural marker separating a
  // "done" closer from a mid-work message - so calling it a closing summary would overclaim twice.
  const m = quietMessage(r2finding, { role: "product-owner", text: "all green" });
  ok(/last said/.test(m.body), "it says what it is: the last thing that role said");
  eq(/closing summary|verified|confirmed|proof/i.test(m.body), false,
     "and never dresses a self-report as an independent check");
});

suite("R2: a long summary is cut inside the MESSAGE, not only inside the helper", () => {
  const m = quietMessage(r2finding, { role: "po", text: "The migration is complete. ".repeat(400) });
  ok(/\[cut - \d+ of \d+ characters\]/.test(m.body), "the body itself carries the honest marker");
  ok(Buffer.byteLength(m.body, "utf8") < FCM_PAYLOAD_BYTES, "and the body fits the transport");
});

suite("R2: the title is untouched by the summary", () => {
  eq(quietMessage(r2finding, { role: "po", text: "x".repeat(5000) }).title, "vs_code_extensions stopped");
});


// ── 5 · FINDING IT: EVERY FAILURE IS A FALLBACK, NEVER A THROW ──────────────────────────────────

const r2deps = (over = {}) => ({
  orchestratorOf: () => ({ role: "product-owner" }),
  sessionOf: () => "sid-1",
  transcriptOf: () => "/tmp/t.jsonl",
  readLast: () => ({ text: "Both lanes green." }),
  ...over,
});

suite("R2: the happy path returns the orchestrator's words and its role", () => {
  const w = orchestratorSaid("r", r2deps());
  eq(w.role, "product-owner");
  eq(w.text, "Both lanes green.");
});

suite("R2: a SOLO PROJECT with no tagged orchestrator falls back silently", () => {
  eq(orchestratorSaid("r", r2deps({ orchestratorOf: () => null })), null);
});

suite("R2: IDENTITY IN TRANSITION sends no summary - a stale id would quote a DEAD session", () => {
  // PB-001's rule, and this reader is unsafe without it. A transcript is addressed BY SESSION ID, so
  // a stale id reads a session that ended hours ago and presents its last words as the thing that
  // just finished. That is worse than sending no summary, which is why disagreement lands here.
  eq(orchestratorSaid("r", r2deps({ sessionOf: () => null })), null);
});

suite("R2: no transcript, or nothing readable in it, falls back", () => {
  eq(orchestratorSaid("r", r2deps({ transcriptOf: () => null })), null);
  eq(orchestratorSaid("r", r2deps({ readLast: () => null })), null);
  eq(orchestratorSaid("r", r2deps({ readLast: () => ({ text: "   " }) })), null, "blank is nothing to say");
});

suite("R2: A THROWING READER CANNOT BREAK A TICK", () => {
  // A notifier must never break a tick - the rule saveQuiet and runQuiet already keep. This feature
  // reads a board, a status file and a transcript, each of which can vanish mid-read.
  const boom = () => { throw new Error("gone"); };
  eq(orchestratorSaid("r", r2deps({ orchestratorOf: boom })), null);
  eq(orchestratorSaid("r", r2deps({ sessionOf: boom })), null);
  eq(orchestratorSaid("r", r2deps({ transcriptOf: boom })), null);
  eq(orchestratorSaid("r", r2deps({ readLast: boom })), null);
});


// ── two tests added because their mutants SURVIVED the first grading ────────────────────────────
//
// Both guards below were already correct; what was missing was a test that made them LOAD-BEARING.
// Each original test passed for an incidental reason rather than the stated one, which is the exact
// shape of a green test that stops you asking the question.

suite("R2: a block is excluded for WHAT IT IS, not for happening to lack a `text` field", () => {
  // WHY THIS EXISTS: the mutant "thinking and tool calls leak into the notification" SURVIVED. The
  // thinking-block test above passed not because of the `b.type !== "text"` check but because a
  // thinking block carries `thinking` and no `text`, so the later `typeof b.text === "string"` guard
  // caught it anyway. The type check was doing nothing that was tested, and a block shape that
  // carried BOTH would have walked straight through. Keyed on the fact, not on an incidental
  // property — private reasoning reaching his phone is not a defect to discover in production.
  const r = assistantText(rec("assistant", [
    { type: "thinking", thinking: "private", text: "private reasoning that must not reach his phone" },
    { type: "tool_use", name: "Bash", text: "git push --force", input: {} },
    textBlock("Both lanes green."),
  ]));
  eq(r.text, "Both lanes green.", "only the spoken block survives: " + JSON.stringify(r.text));
});

suite("R2: a summary UNDER the budget in CHARACTERS but OVER it in BYTES is still cut", () => {
  // WHY THIS EXISTS: the mutant "the budget counts CHARACTERS, not bytes" SURVIVED. The multi-byte
  // test above used 6000 characters, which is over the budget counted either way — so it never
  // separated the two, and the early-return guard was untested. THIS is the case that separates
  // them, and it is the one that would actually ship: a 1500-character summary is unremarkable, and
  // at three bytes a character it is 4500 bytes and overruns a payload that is REJECTED rather than
  // truncated.
  const s = "→".repeat(1500);
  eq(s.length < SUMMARY_BUDGET_BYTES, true, "a character count would wave this through untouched");
  eq(Buffer.byteLength(s, "utf8") > SUMMARY_BUDGET_BYTES, true, "but it is " +
     Buffer.byteLength(s, "utf8") + " bytes");
  const out = truncateHonestly(s);
  eq(Buffer.byteLength(out, "utf8") <= SUMMARY_BUDGET_BYTES, true,
     "cut to " + Buffer.byteLength(out, "utf8") + " bytes");
  ok(/\[cut - \d+ of \d+ characters\]$/.test(out), "and the cut is marked");
});
