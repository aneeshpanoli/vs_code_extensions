// delegation.test.js — PB-001 §2: the orchestrator that is doing the work itself.
//
// The detector is pure, so every claim its comments make is pinned here without a composer, a board
// or a clock. The two FALSE-POSITIVE cases (no workers bound; every worker busy) are the ones that
// decide whether anyone believes the reminder, so they are asserted in both directions: the
// exclusion holds, AND the identical bus with one worker idle does fire. Delete either exclusion in
// delegation.ts and one of these goes red.

const { suite, ok, eq, load, makeRepo, busPath, readJson } = require("./harness");
const fs = require("fs");
const { delegationTick, delegationReminder, markReminded, loadDelegation, saveDelegation,
        DEFAULT_WORK_MINUTES, TICK_MS } = load("delegation.js");

const TICK = 15_000;
/** Ticks needed to reach `mins` minutes of observed mid-turn time. */
const ticksFor = (mins) => Math.ceil((mins * 60_000) / TICK);

/** A bus where the orchestrator is mid-turn and one worker sits idle — the firing case. */
function working(over = {}) {
  return {
    repo: "r", orchestrator: "po", busy: true,
    workers: [{ role: "dev1", working: false }],
    lastDispatch: "2026-09-17T10:00:00.000Z",
    ...over,
  };
}

/** Run n ticks of the same observation and return the final result. */
function run(input, n, prev = { busyTicks: 0, since: null, reminded: false }, mins = DEFAULT_WORK_MINUTES) {
  let r = { state: prev, finding: null, skip: null };
  for (let i = 0; i < n; i++) r = delegationTick(input, r.state, mins, TICK);
  return r;
}

suite("delegation: the tick cadence and default threshold agree with the shipped constants", () => {
  eq(TICK_MS, 15_000, "one tick is 15s, as extension.ts schedules");
  eq(DEFAULT_WORK_MINUTES, 30, "30 minutes of observed turns");
});

suite("delegation: it fires after the threshold of OBSERVED mid-turn time, not before", () => {
  const need = ticksFor(DEFAULT_WORK_MINUTES);
  const short = run(working(), need - 1);
  eq(short.finding, null, "one tick short of the threshold says nothing");
  eq(short.skip, "not yet worked long enough", "and says why");

  const due = run(working(), need);
  ok(due.finding, "fires on the tick that reaches the threshold");
  eq(due.finding.orchestrator, "po", "names the orchestrator");
  eq(due.finding.idle.join(","), "dev1", "names the idle role it could hand work to");
  ok(due.finding.workedMinutes >= DEFAULT_WORK_MINUTES, "reports the observed minutes");
});

suite("delegation: IDLE TICKS ARE NOT WORK — a quiet orchestrator never accumulates", () => {
  // The rule is about an orchestrator WORKING while its agents sit idle. A session that is simply
  // open and doing nothing is not that, and wall-clock (the rejected signal) could not tell them
  // apart. Thousands of idle ticks must still produce nothing.
  const quiet = run(working({ busy: false }), ticksFor(DEFAULT_WORK_MINUTES) * 3);
  eq(quiet.finding, null, "an idle orchestrator is never reminded");
  eq(quiet.state.busyTicks, 0, "and nothing accumulated");
});

suite("delegation: a frame not seen this tick is UNKNOWN — it neither counts nor resets", () => {
  // Unknown is its own state (WL-002's rule). Counting it would credit work to a session that may
  // have been closed; forgetting it would make an unreadable frame a way to erase the evidence.
  const half = run(working(), 10);
  eq(half.state.busyTicks, 10, "ten busy ticks banked");
  const unseen = delegationTick(working({ busy: null }), half.state, DEFAULT_WORK_MINUTES, TICK);
  eq(unseen.skip, "orchestrator frame not seen this tick", "reported as unknown");
  eq(unseen.state.busyTicks, 10, "the stretch is neither advanced nor lost");
});

// ── FALSE POSITIVE (a) ────────────────────────────────────────────────────────────────────────
suite("delegation: A BUS WITH NO WORKERS BOUND NEVER FIRES, however long the orchestrator works", () => {
  const solo = run(working({ workers: [] }), ticksFor(DEFAULT_WORK_MINUTES) * 4);
  eq(solo.finding, null, "a solo orchestrator has nobody to delegate to");
  eq(solo.skip, "no workers bound — nobody to delegate to", "and the reason is named, not silent");

  // THE OTHER DIRECTION, which is what makes the assertion above mean something: the identical bus
  // with one idle worker on it DOES fire. Without this, deleting the exclusion would keep the test
  // green for the wrong reason.
  const peer = run(working(), ticksFor(DEFAULT_WORK_MINUTES) * 4);
  ok(peer.finding, "the same bus WITH an idle worker fires");
});

// ── FALSE POSITIVE (b) ────────────────────────────────────────────────────────────────────────
suite("delegation: AN ORCHESTRATOR WAITING ON BUSY WORKERS IS NEVER NUDGED", () => {
  const allBusy = working({ workers: [{ role: "dev1", working: true },
                                      { role: "dev2", working: true },
                                      { role: "dev3", working: true }] });
  const r = run(allBusy, ticksFor(DEFAULT_WORK_MINUTES) * 4);
  eq(r.finding, null, "three running workers is §8's concurrency cap being obeyed");
  eq(r.skip, "every bound worker is busy — waiting is correct", "and it says so");

  // One of the three finishes. NOW there is a lane to fill, and only now.
  const oneFree = working({ workers: [{ role: "dev1", working: true },
                                      { role: "dev2", working: true },
                                      { role: "dev3", working: false }] });
  const after = run(oneFree, ticksFor(DEFAULT_WORK_MINUTES) * 4);
  ok(after.finding, "fires once a lane actually opens");
  eq(after.finding.idle.join(","), "dev3", "names only the free one");
  eq(after.finding.busyWorkers.join(","), "dev1,dev2", "and keeps the busy ones apart from it");
});

// ── SUPPRESSION ───────────────────────────────────────────────────────────────────────────────
suite("delegation: reminded ONCE per undelegated stretch, however long it runs", () => {
  const need = ticksFor(DEFAULT_WORK_MINUTES);
  const first = run(working(), need);
  ok(first.finding, "fires the first time");

  // Delivery is what latches — see markReminded.
  const latched = markReminded(first.state);
  const again = run(working(), need * 3, latched);
  eq(again.finding, null, "never fires twice for the same stretch");
  eq(again.skip, "already reminded for this stretch", "and says which latch held");
});

suite("delegation: WORKERS FLICKERING BUSY AND IDLE DOES NOT RE-ARM IT", () => {
  // This is the stall alarm's exact defect, and the reason this latch is keyed on the dispatch
  // watermark rather than on the condition: `alerted` is emptied whenever a role stops being
  // reported stalled, so a role that oscillates is re-alerted every time. Measured on this bus:
  // four alerts at the orchestrator in one day.
  const need = ticksFor(DEFAULT_WORK_MINUTES);
  let st = markReminded(run(working(), need).state);
  for (let i = 0; i < 6; i++) {
    // everyone busy (excluded), then idle again (the condition returns) — six times over
    st = run(working({ workers: [{ role: "dev1", working: true }] }), need, st).state;
    const back = run(working(), need, st);
    eq(back.finding, null, `oscillation ${i + 1} does not re-arm the reminder`);
    st = back.state;
  }
});

suite("delegation: ONLY A NEW DISPATCH RE-ARMS IT — and it resets the stretch too", () => {
  const need = ticksFor(DEFAULT_WORK_MINUTES);
  const latched = markReminded(run(working(), need).state);
  eq(run(working(), need, latched).finding, null, "still latched");

  // The orchestrator delegates. THAT is the re-arm, and it is the only one.
  const afterDispatch = delegationTick(
    working({ lastDispatch: "2026-09-17T12:00:00.000Z" }), latched, DEFAULT_WORK_MINUTES, TICK);
  eq(afterDispatch.state.reminded, false, "the latch is released by the dispatch");
  eq(afterDispatch.state.busyTicks, 1, "and the new stretch counts from the dispatch, not the reminder");
  eq(afterDispatch.finding, null, "so nothing fires immediately after delegating");

  const later = run(working({ lastDispatch: "2026-09-17T12:00:00.000Z" }), need, afterDispatch.state);
  ok(later.finding, "and a NEW undelegated stretch can be reported on its own merits");
});

suite("delegation: an untagged bus is never judged", () => {
  const r = run(working({ orchestrator: null }), ticksFor(DEFAULT_WORK_MINUTES) * 2);
  eq(r.finding, null, "no tag, no finding");
  eq(r.skip, "no tagged orchestrator", "named");
});

suite("delegation: a bus that has never dispatched is still measurable", () => {
  // `lastDispatch: null` is "no handoff has ever been seen here", not "long ago". It must not be
  // mistaken for a dispatch, and it must not suppress the finding either.
  const r = run(working({ lastDispatch: null }), ticksFor(DEFAULT_WORK_MINUTES));
  ok(r.finding, "fires");
  eq(r.finding.lastDispatch, null, "and carries the absence honestly");
  ok(/No handoff to any role has been seen/.test(delegationReminder(r.finding)),
     "which the message renders as an absence, never as a stale timestamp");
});

// ── THE MESSAGE ───────────────────────────────────────────────────────────────────────────────
suite("delegation: the reminder names the action and the role, not a score", () => {
  const f = run(working(), ticksFor(DEFAULT_WORK_MINUTES)).finding;
  const msg = delegationReminder(f);
  ok(/dev1/.test(msg), "names the idle role");
  ok(/inbox\.md/.test(msg), "names the concrete next action — write a handoff");
  ok(/§8/.test(msg) && /§19/.test(msg), "cites the rules that apply at this moment");
  ok(/nothing is blocked and nothing needs undoing/.test(msg),
     "says nothing needs undoing, so it cannot be read as a fault to go back and fix");
  ok(/carry on/.test(msg), "and leaves the judgement with the orchestrator");
});

suite("delegation: THE MESSAGE CARRIES NO THRESHOLD, QUOTA OR BAR TO CLEAR", () => {
  // A line an orchestrator can satisfy by STOPPING WORK is the WL-001 defect aimed at the one reader
  // who can act — and here it would be an own-goal, since the remedy for "you are working alone"
  // must never read as "work less". The observation may be stated; a target may not.
  const msg = delegationReminder(run(working(), ticksFor(DEFAULT_WORK_MINUTES)).finding);
  for (const word of ["score", "grade", "rating", "quota", "threshold", "target", "limit",
                      "should not", "too much", "at least", "%"]) {
    ok(!new RegExp(word, "i").test(msg), `no "${word}" in the reminder`);
  }
});

suite("delegation: it does not imply the busy roles are available", () => {
  const f = run(working({ workers: [{ role: "dev1", working: false },
                                    { role: "dev2", working: true }] }),
                ticksFor(DEFAULT_WORK_MINUTES)).finding;
  const msg = delegationReminder(f);
  ok(/dev2 is working/.test(msg), "says the busy lane is accounted for");
  ok(/loom\/r\/dev1\/inbox\.md/.test(msg), "and points the dispatch at the idle one");
});

// ── THE LATCH ON DISK ─────────────────────────────────────────────────────────────────────────
suite("delegation: the latch survives an extension reload", () => {
  // A latch held in memory fires again on every window reload — the reason gatesWoken went to disk.
  const repo = makeRepo({ po: {}, dev1: {} });
  const st = markReminded({ busyTicks: 400, since: "2026-09-17T10:00:00.000Z", reminded: false });
  saveDelegation(repo, st);
  const back = loadDelegation(repo);
  eq(back.reminded, true, "the DELIVERED flag, read back");
  eq(back.since, "2026-09-17T10:00:00.000Z", "alongside the watermark it is measured from");
  ok(typeof back.deliveredAt === "string", "and when the delivery happened, for a human reading it");
  eq(back.busyTicks, 400, "and the stretch");
  ok(readJson(busPath(repo, "delegation-state.json")).updatedAt, "stamped");
});

suite("delegation: a bus with no latch file reads as a fresh start, never as reminded", () => {
  const repo = makeRepo({ po: {}, dev1: {} });
  const st = loadDelegation(repo);
  eq(st.reminded, false, "not latched");
  eq(st.busyTicks, 0, "nothing accumulated");
  eq(st.since, null, "no watermark");
});

suite("delegation: a corrupt latch file reads as a fresh start rather than throwing", () => {
  const repo = makeRepo({ po: {}, dev1: {} });
  fs.writeFileSync(busPath(repo, "delegation-state.json"), "{not json");
  const st = loadDelegation(repo);
  eq(st.reminded, false, "degrades to unlatched");
  eq(st.busyTicks, 0, "and to an empty stretch");
});

suite("delegation: saving is change-only, so a quiet tick never churns the file", () => {
  const repo = makeRepo({ po: {}, dev1: {} });
  const st = { busyTicks: 3, since: null, reminded: false };
  saveDelegation(repo, st);
  const first = fs.statSync(busPath(repo, "delegation-state.json")).mtimeMs;
  const stamp = readJson(busPath(repo, "delegation-state.json")).updatedAt;
  saveDelegation(repo, { ...st });
  eq(readJson(busPath(repo, "delegation-state.json")).updatedAt, stamp,
     "an unchanged state is not rewritten");
  ok(fs.statSync(busPath(repo, "delegation-state.json")).mtimeMs === first, "file untouched");
});

// ── DG-001 · THE LATCH ON A BUS THAT HAS NEVER DISPATCHED ─────────────────────────────────────
// Live defect, measured at livegita's orchestrator: busyTicks 133, since null, remindedAt null, and
// a reminder on every qualifying tick for 33 minutes until the feature was switched off for every
// bus. The old latch stored the watermark, so on a bus that had never dispatched it stored `null` —
// the same `null` that means "nothing delivered" — and `remindedAt !== null` was false for ever.
// These four suites are the properties; the tests above cover the watermark case unchanged.
suite("delegation: A BUS THAT HAS NEVER DISPATCHED IS REMINDED AT MOST ONCE — the DG-001 spam", () => {
  const need = ticksFor(DEFAULT_WORK_MINUTES);
  const never = working({ lastDispatch: null });
  const first = run(never, need);
  ok(first.finding, "the first reminder is due — a never-dispatched bus is still measurable");
  eq(first.state.since, null, "and it has no watermark to key a latch on");

  const latched = markReminded(first.state);
  eq(latched.reminded, true, "delivery is recorded as a fact about US, not about the watermark");
  const after = run(never, need * 10, latched);
  eq(after.finding, null, "and ten further stretches of ticks say nothing at all");
  eq(after.skip, "already reminded for this stretch", "the latch is what held");
});

suite("delegation: THE FIRST EVER DISPATCH STILL RE-ARMS IT — the spam is not fixed by silence", () => {
  // The wrong fix for the suite above is to make a null watermark permanently unremindable. A bus
  // that is reminded, then delegates for the FIRST TIME, then goes undelegated again, has earned a
  // second reminder exactly as a bus with a history would.
  const need = ticksFor(DEFAULT_WORK_MINUTES);
  const latched = markReminded(run(working({ lastDispatch: null }), need).state);

  const dispatched = delegationTick(working({ lastDispatch: "2026-09-17T13:00:00.000Z" }),
                                    latched, DEFAULT_WORK_MINUTES, TICK);
  eq(dispatched.state.reminded, false, "the first ever dispatch releases the latch");
  eq(dispatched.state.since, "2026-09-17T13:00:00.000Z", "and becomes the watermark it had lacked");
  eq(dispatched.state.busyTicks, 1, "the stretch restarts at the dispatch");
  ok(typeof latched.deliveredAt === "string" && dispatched.state.deliveredAt === latched.deliveredAt,
     "and the delivery RECORD survives the re-arm — it answers a question `reminded` cannot");
  eq(dispatched.finding, null, "nothing fires at the moment of delegating");

  const later = run(working({ lastDispatch: "2026-09-17T13:00:00.000Z" }), need, dispatched.state);
  ok(later.finding, "and the NEW undelegated stretch is reported on its own merits");
});

suite("delegation: ONLY DELIVERY LATCHES — a reminder refused by a busy composer is not one", () => {
  // extension.ts returns without calling markReminded when the orchestrator is mid-turn, and injectTo
  // latches only on ok. Asserted here as a property of the state rather than of the caller: a tick
  // that PRODUCED a finding must leave the latch open, so that only markReminded can close it. That
  // asserted-is-not-reached shape has cost this project six findings.
  const need = ticksFor(DEFAULT_WORK_MINUTES);
  for (const bus of [working(), working({ lastDispatch: null })]) {
    const due = run(bus, need);
    ok(due.finding, "a finding was produced");
    eq(due.state.reminded, false, "but producing one latches nothing");
    const refusedAgain = run(bus, 1, due.state);
    ok(refusedAgain.finding, "so the next tick offers it again until someone receives it");
  }
});

suite("delegation: AN OLD STATE FILE MIGRATES WITHOUT A BURST AND WITHOUT A CRASH", () => {
  // Every `delegation-state.json` on disk was written by 0.60.0 and has no `reminded`. The flag is
  // derived by replaying the OLD suppression condition, so each bus keeps the suppression it
  // actually had.
  const latchedRepo = makeRepo({ po: {}, dev1: {} });
  fs.writeFileSync(busPath(latchedRepo, "delegation-state.json"), JSON.stringify(
    { busyTicks: 200, since: "2026-09-17T10:00:00.000Z", remindedAt: "2026-09-17T10:00:00.000Z" }));
  const kept = loadDelegation(latchedRepo);
  eq(kept.reminded, true, "a bus that WAS latched under the old shape stays silent");
  eq(kept.busyTicks, 200, "and keeps its stretch");

  // The affected shape. It was never latched — that is the defect — so the truth is `false`, and it
  // is due ONE reminder, after which the boolean holds. One is not a burst.
  const spammingRepo = makeRepo({ po: {}, dev1: {} });
  fs.writeFileSync(busPath(spammingRepo, "delegation-state.json"), JSON.stringify(
    { busyTicks: 133, since: null, remindedAt: null }));
  const live = loadDelegation(spammingRepo);
  eq(live.reminded, false, "livegita's file loads unlatched, which is what it truly was");

  // THE THIRD SHAPE, and the half of the replay that the two above cannot see: a watermark that
  // MOVED after the reminder was delivered. The old condition required equality, so that file was
  // NOT suppressed and its new stretch was owed a reminder. Derive the flag from "remindedAt is a
  // string" alone and the equality half stops being load-bearing — the bus migrates as latched and
  // a legitimately due reminder is swallowed for ever, silently, with the suite still green.
  const movedRepo = makeRepo({ po: {}, dev1: {} });
  fs.writeFileSync(busPath(movedRepo, "delegation-state.json"), JSON.stringify(
    { busyTicks: 200, since: "2026-09-17T12:00:00.000Z", remindedAt: "2026-09-17T09:00:00.000Z" }));
  const moved = loadDelegation(movedRepo);
  eq(moved.reminded, false, "a watermark that moved since the reminder migrates UNLATCHED");
  eq(moved.since, "2026-09-17T12:00:00.000Z", "keeping the newer watermark it is measured from");
  const r = delegationTick(working({ repo: spammingRepo, lastDispatch: null }), live,
                           DEFAULT_WORK_MINUTES, TICK);
  ok(r.finding, "so one reminder is due");
  const after = run(working({ repo: spammingRepo, lastDispatch: null }),
                    ticksFor(DEFAULT_WORK_MINUTES) * 4, markReminded(r.state));
  eq(after.finding, null, "and that is the last one this stretch — 133 becomes 1");
});
