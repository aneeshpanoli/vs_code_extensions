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

