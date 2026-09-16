// busy-latch.test.js — WL-008. The tracker's `busyRoles` must describe THIS tick, not every tick
// that has ever happened.
//
// MEASURED IN THE FIELD 2026-09-16, not derived from the code. The WL-006 gate wake shipped in
// 0.38.3 behind a 188/188 mutation gate and never fired once, across two real gates. The scheduler
// ran (runHealth() is called from runTick every 15s), checkHealth+scanGates produced the event —
// verified by running the deployed code against the live bus — and the live extension was captured
// writing `gateWake {ok: false, note: "composer busy or frame not found"}` on every tick for
// 36 minutes while the target role sat IDLE with a perfectly matching declaration.
//
// The cause: `busyRoles` was a Set that was only ever ADDED to. `limits` and `models` are rebuilt
// fresh each tick; this was not, and its only clear() sits in setFilter(), behind a human switching
// the project filter. So the first tick that saw a role mid-turn latched it busy FOR EVER.
//
// IT COULD NEVER HAVE FIRED. To launch a gate a worker must be mid-turn, so it is ALWAYS observed
// busy before its gate can possibly exit. That is why a green suite meant nothing here: every test
// of busy-ness drove the pure isBusy() helper, which was correct the whole time. Nothing drove the
// STATE BUILT FROM IT across two ticks. This file does that, and only that.

const { suite, ok, eq, load, makeRepo } = require("./harness");
const { Tracker } = load("tracker.js");
const { isBusy } = load("sessions.js");

const WORKING = "\nShimmying...\nClaude is working\nOpus 5\nBypass permissions";
const IDLE = "\nRemote Control\nOpus 5\nMedium\nBypass permissions";

/** A frame as cdp.readFrames yields one, carrying a role marker and a footer. */
const frame = (webviewId, role, footer) =>
  ({ webviewId, text: `some conversation\nLOOMROLE=${role}\n${footer}`, claudeSessionId: null,
     contextPct: null, // window unknown: attribution comes from the roster + the marker, not the window title
     windowRoot: null, windowKnown: false,
     url: `vscode-webview://host/index.html?id=${webviewId}` });

/** A filtered tracker takes its roster from the project's own board.json, so the bus must exist
 *  before a marker can be attributed to a role. */
function busFor(name) { return makeRepo({ developer1: {}, developer2: {}, productowner: {} }, name); }

async function tickWith(t, frames) {
  t.setFrameSource(async () => frames);
  return t.tick();
}

suite("WL-008: a role that STOPS being busy stops being in busyRoles", async () => {
  // The helper was never the problem, and the test that only drives it passes either way.
  ok(isBusy(WORKING), "the detector reads a mid-turn footer as busy");
  ok(!isBusy(IDLE), "and an idle footer as not busy — this much was always true");

  const repo = busFor("wl008-a");
  const t = new Tracker(repo);
  await tickWith(t, [frame("w1", "developer1", WORKING)]);
  ok(t.busyRoles.has("developer1"), "tick 1: mid-turn, so busy");

  // The role finishes its turn. THE WHOLE DEFECT IS THIS ONE ASSERTION.
  await tickWith(t, [frame("w1", "developer1", IDLE)]);
  ok(!t.busyRoles.has("developer1"),
     "tick 2: the turn ended, so the role is NOT busy — a Set only ever added to said otherwise " +
     "for ever, and that silently disabled the gate wake in production for two releases");

  // And back again: the state tracks the frame in both directions, not just downward.
  await tickWith(t, [frame("w1", "developer1", WORKING)]);
  ok(t.busyRoles.has("developer1"), "tick 3: busy again — it follows the frame, it does not ratchet");
});

suite("WL-008: a role that leaves the read entirely is not left behind as busy", async () => {
  const repo = busFor("wl008-b");
  const t = new Tracker(repo);
  await tickWith(t, [frame("w1", "developer1", WORKING), frame("w2", "developer2", WORKING)]);
  eq([...t.busyRoles].sort().join(","), "developer1,developer2", "both mid-turn");
  // developer2's tab is closed. A stale `busy` for a role that is not even present is the same
  // defect wearing a different hat: it would refuse a wake for a role that later comes back idle.
  await tickWith(t, [frame("w1", "developer1", IDLE)]);
  eq([...t.busyRoles].join(","), "", "neither is busy: one went idle, the other is simply gone");
});

suite("WL-008: THE FIELD CASE, end to end — launch a gate mid-turn, then go idle", async () => {
  // The exact sequence that produced `gatesWoken: {}` twice. A worker is mid-turn (it has to be, to
  // launch anything), then its turn ends and the gate is still running, then the gate exits and the
  // wake is attempted. The wake's guard reads busyRoles; before this fix it read `true` at every
  // step after the first, so the role was never typed into and never marked woken.
  const repo = busFor("wl008-c");
  const t = new Tracker(repo);
  await tickWith(t, [frame("w1", "developer1", WORKING)]);      // launches its gate, mid-turn
  ok(t.busyRoles.has("developer1"), "mid-turn while launching");
  await tickWith(t, [frame("w1", "developer1", IDLE)]);         // turn ends, gate still running
  await tickWith(t, [frame("w1", "developer1", IDLE)]);         // gate exits; the wake fires here
  const a = t.view().find((v) => v.role === "developer1" && v.repo === repo && v.liveness === "live");
  ok(a, "the frame is found — this half was never broken, and blaming it cost a diagnosis");
  ok(!t.busyRoles.has(a.role),
     "and the composer is NOT busy, so wake() proceeds to injectTo instead of returning at its guard");
});
