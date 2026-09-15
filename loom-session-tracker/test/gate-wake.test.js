// gate-wake.test.js — WL-006. A worker's background gate finishes after the worker's turn has ended,
// and nothing wakes it.
//
// MEASURED THREE TIMES (WL-002, WL-004+FX-002, WL-005). On WL-005 the 180-mutant gate ran for ~18
// minutes after the turn ended; throughout, `outbox.md` line 1 still read `# RESPONSE WL-004-R6` and
// `status.json.current` still read `WL-004-R6`. To anything reading the bus that is indistinguishable
// from a worker that has done nothing — the same shape as a stall. The orchestrator's workaround was
// to read the gate log through /proc/<pid>/fd/1, which is a person-shaped fix for a machine-shaped
// hole.
//
// THREE STATES, NEVER COLLAPSED: running / exited-and-unanswered / none. Only the third may look idle.
const { suite, ok, eq, load, makeRepo, busPath, writeJson, readJson } = require("./harness");
const fs = require("fs");
const path = require("path");
const { spawn } = require("child_process");

const { readGate, gateStateOf, gateKey, checkHealth, HealthWatcher } = load("health.js");

const decl = (pid, log, launchedAt, mutants = 180) =>
  ({ pid, log, launched_at: launchedAt, mutants });

suite("WL-006: a declaration is read, and a malformed one is NOT a live gate", () => {
  const good = readGate({ gate: decl(123, "/tmp/g.log", "2026-09-15T21:00:00Z") });
  eq(good.pid, 123); eq(good.log, "/tmp/g.log"); eq(good.mutants, 180);
  eq(readGate({}), null, "no declaration");
  eq(readGate({ gate: {} }), null, "empty declaration");
  eq(readGate({ gate: decl(0, "/tmp/g.log", "2026-09-15T21:00:00Z") }), null, "pid 0 is not a pid");
  eq(readGate({ gate: decl(123, "", "2026-09-15T21:00:00Z") }), null, "no log path");
  eq(readGate({ gate: decl(123, "/tmp/g.log", "nonsense") }), null, "unparseable launch time");
  // A half-written gate block must read as NO declaration, never as a live gate: a false "running"
  // suppresses the stall alarm for ever and withholds the wake.
  eq(gateStateOf(readGate({ gate: { pid: 123 } })), "none", "an incomplete block is `none`");
});

suite("WL-006: identification needs all three facts — alive, right KIND, and THIS launch", () => {
  // The positive case: a live process whose command line names mutation.py, declared at its real
  // start time. This suite used to assert only the refusal, which meant nothing here proved that a
  // running gate is ever recognised at all — a test that names a behaviour must exercise it.
  const real = spawn("python3", ["-c", "import time; time.sleep(60)  # test/mutation.py"], { stdio: "ignore" });
  // The wrong KIND: alive, but not a gate.
  const other = spawn(process.execPath, ["-e", "setTimeout(()=>{},60000)"], { stdio: "ignore" });
  try {
    const now = new Date().toISOString();
    eq(gateStateOf(readGate({ gate: decl(real.pid, "/tmp/g.log", now) })), "running",
       "alive + right kind + started when we said => running");
    eq(gateStateOf(readGate({ gate: decl(other.pid, "/tmp/g.log", now) })), "exited",
       "a live process of the WRONG KIND is not this gate");
    // THE PID-REUSE CASE, which is the whole reason a pid is not proof: the right kind, alive, but
    // its start time does not match the declaration, so the pid has been recycled since.
    eq(gateStateOf(readGate({ gate: decl(real.pid, "/tmp/g.log", "2026-01-01T00:00:00Z") })), "exited",
       "right kind and alive, but NOT this launch — a recycled pid must not read as running");
  } finally { real.kill(); other.kill(); }
});

suite("WL-006: a PID is not proof — a recycled pid is not the declared gate", () => {
  // PID 1 is alive on any Linux host and is certainly not a mutation gate started seconds ago.
  const g = readGate({ gate: decl(1, "/tmp/g.log", new Date().toISOString()) });
  eq(gateStateOf(g), "exited",
     "pid 1 is alive but is neither the right kind nor started when we said — not `running`");
  // A pid that does not exist at all.
  const dead = readGate({ gate: decl(999999, "/tmp/g.log", new Date().toISOString()) });
  eq(gateStateOf(dead), "exited", "no /proc entry => exited");
});

suite("WL-006: a live gate SUPPRESSES the stall alarm and is reported as evidence, not omitted", () => {
  const repo = makeRepo({ dev: {} }, "wl006-suppress");
  const child = spawn("python3", ["-c", "import time; time.sleep(60)  # test/mutation.py"], { stdio: "ignore" });
  try {
    const launched = new Date().toISOString();
    // status.json is deliberately OLD — 3 hours stale, which is well past any stall threshold.
    writeJson(busPath(repo, "dev", "status.json"),
      { status: "working", current: "WL-9", updated_at: "2026-01-01T00:00:00Z",
        gate: decl(child.pid, "/tmp/g.log", launched, 180) });
    const f = busPath(repo, "dev", "status.json");
    const old = Date.now() - 3 * 3600_000;
    fs.utimesSync(f, old / 1000, old / 1000);
    const r = checkHealth(repo, { stallMinutes: 45 });
    eq(r.stalled.length, 0, "a role with a LIVE gate is not stalled, however old its status file is");
    eq(r.gated.length, 1, "and it is REPORTED as gated — omitting it would render `running` as `none`");
    eq(r.gated[0].role, "dev");
    eq(r.gated[0].pid, child.pid, "with the evidence that justified the suppression");
    eq(r.gated[0].mutants, 180);
    eq(r.gateExited.length, 0, "it has not exited");
  } finally { child.kill(); }
});

suite("WL-006: an EXITED gate is neither stalled nor gated — it is a wake, once", () => {
  const repo = makeRepo({ dev: {} }, "wl006-exit");
  writeJson(busPath(repo, "dev", "status.json"),
    { status: "working", current: "WL-9", updated_at: "2026-01-01T00:00:00Z",
      gate: decl(999999, "/tmp/wl006.log", new Date().toISOString(), 180) });
  const r = checkHealth(repo, { stallMinutes: 45 });
  eq(r.stalled.length, 0, "a finished gate is not a stall — the worker is asleep with an answer, not stuck");
  eq(r.gated.length, 0, "and not running either");
  eq(r.gateExited.length, 1, "it is the third state, on its own");

  const w = new HealthWatcher(repo);
  const first = w.scanGates(r);
  eq(first.length, 1, "one wake candidate");
  eq(first[0].role, "dev");
  eq(first[0].log, "/tmp/wl006.log", "and it carries the log the worker must read itself");

  // NOT marked by scanning — only by delivery.
  eq(w.scanGates(r).length, 1, "scanning twice does not consume the event: delivery does");
  w.markWoken("dev", first[0].key);
  eq(w.scanGates(r).length, 0, "once delivered, never again for THIS gate");
});

suite("WL-006: the once-only record survives a reload, and a NEW gate wakes again", () => {
  const repo = makeRepo({ dev: {} }, "wl006-once");
  const g1 = decl(999999, "/tmp/wl006-a.log", "2026-09-15T21:00:00Z", 180);
  writeJson(busPath(repo, "dev", "status.json"),
    { status: "working", current: "WL-9", updated_at: "2026-01-01T00:00:00Z", gate: g1 });
  const w = new HealthWatcher(repo);
  const ev = w.scanGates(checkHealth(repo, {}))[0];
  w.markWoken("dev", ev.key);

  // A FRESH watcher is what a reloaded extension has. In-memory dedupe would re-wake here.
  const reloaded = new HealthWatcher(repo);
  eq(reloaded.scanGates(checkHealth(repo, {})).length, 0, "the record is on disk, so a reload is quiet");
  ok(readJson(busPath(repo, "stall-state.json")).gatesWoken.dev.includes("/tmp/wl006-a.log"),
     "and it is keyed by the gate, visibly");

  // The NEXT gate is a different gate and must wake.
  writeJson(busPath(repo, "dev", "status.json"),
    { status: "working", current: "WL-10", updated_at: "2026-01-01T00:00:00Z",
      gate: decl(999999, "/tmp/wl006-b.log", "2026-09-15T22:00:00Z", 12) });
  eq(new HealthWatcher(repo).scanGates(checkHealth(repo, {})).length, 1,
     "a new declaration is a new key — the last gate must not suppress the next one for ever");

  // Same log path, RE-LAUNCHED: the launch instant is part of the identity, so it wakes again.
  writeJson(busPath(repo, "dev", "status.json"),
    { status: "working", current: "WL-9", updated_at: "2026-01-01T00:00:00Z",
      gate: decl(999999, "/tmp/wl006-a.log", "2026-09-15T23:30:00Z", 180) });
  eq(new HealthWatcher(repo).scanGates(checkHealth(repo, {})).length, 1,
     "a re-run writing the SAME log path still wakes — the key is log@launchedAt, not log");
});

suite("WL-006: NO declaration leaves the stall alarm exactly as it was", () => {
  const repo = makeRepo({ dev: {} }, "wl006-none");
  const f = busPath(repo, "dev", "status.json");
  writeJson(f, { status: "working", current: "WL-9", updated_at: "2026-01-01T00:00:00Z" });
  const old = Date.now() - 3 * 3600_000;
  fs.utimesSync(f, old / 1000, old / 1000);
  const r = checkHealth(repo, { stallMinutes: 45 });
  eq(r.stalled.length, 1, "no gate declared => the stall alarm behaves as before");
  eq(r.gated.length, 0);
  eq(r.gateExited.length, 0);
  eq(new HealthWatcher(repo).scanGates(r).length, 0, "and there is nothing to wake");
});

suite("WL-006: a BUSY composer is not typed into, and the wake is NOT marked", () => {
  const repo = makeRepo({ dev: {} }, "wl006-busy");
  writeJson(busPath(repo, "dev", "status.json"),
    { status: "working", current: "WL-9", updated_at: "2026-01-01T00:00:00Z",
      gate: decl(999999, "/tmp/wl006.log", new Date().toISOString(), 180) });
  const w = new HealthWatcher(repo);
  const ev = w.scanGates(checkHealth(repo, {}))[0];
  let called = null;
  w.wake(ev, { webviewId: "wv1", busy: true }, (ok, note) => { called = { ok, note }; });
  eq(called.ok, false, "a mid-turn composer is never typed into");
  eq(w.scanGates(checkHealth(repo, {})).length, 1,
     "and the event stays pending — marking on ATTEMPT would mean 'woken' for a role never told");
  w.wake(ev, null, (ok) => { called = { ok }; });
  eq(called.ok, false, "no frame is the same refusal");
  eq(w.scanGates(checkHealth(repo, {})).length, 1, "still pending");
});

suite("WL-006: a declaration whose block is ALREADY ANSWERED is spent, not a wake", () => {
  // FOUND LIVE, not hypothesised: developer1's own status.json carried WL-005's declaration — pid
  // dead, block merged 90 minutes earlier — while it sat idle on last_handled: WL-005. Under
  // "unidentified -> exited -> wake the role" that leftover was a wake for a block that was over.
  const repo = makeRepo({ dev: {} }, "wl006-spent");
  writeJson(busPath(repo, "dev", "status.json"),
    { status: "idle", current: null, last_handled: "WL-5",
      updated_at: "2026-01-01T00:00:00Z",
      gate: { ...decl(999999, "/tmp/wl005.log", "2026-09-15T21:19:57Z", 180), handoff: "WL-5" } });
  const r = checkHealth(repo, { stallMinutes: 45 });
  eq(r.gateExited.length, 0, "the block is answered — its leftover declaration is not a wake");
  eq(r.gated.length, 0, "and not running");
  eq(new HealthWatcher(repo).scanGates(r).length, 0, "so nobody is woken for a finished block");
});

suite("WL-006: a declaration for the block still IN FLIGHT does wake, even beside a last_handled", () => {
  // The distinction that matters: a role that finished WL-5 and is now gating WL-6 has BOTH a
  // last_handled and a live-block declaration. Only the stale one is spent.
  const repo = makeRepo({ dev: {} }, "wl006-inflight");
  writeJson(busPath(repo, "dev", "status.json"),
    { status: "working", current: "WL-6", last_handled: "WL-5",
      updated_at: "2026-01-01T00:00:00Z",
      gate: { ...decl(999999, "/tmp/wl006.log", "2026-09-15T22:00:00Z", 12), handoff: "WL-6" } });
  const r = checkHealth(repo, { stallMinutes: 45 });
  eq(r.gateExited.length, 1, "this gate belongs to the block that is NOT yet answered");
  eq(new HealthWatcher(repo).scanGates(r).length, 1, "so it is a wake");
});

suite("WL-006: a declaration with NO handoff still behaves as before, bounded by the key", () => {
  const repo = makeRepo({ dev: {} }, "wl006-nohandoff");
  writeJson(busPath(repo, "dev", "status.json"),
    { status: "idle", last_handled: "WL-5", updated_at: "2026-01-01T00:00:00Z",
      gate: decl(999999, "/tmp/old.log", "2026-09-15T21:19:57Z", 180) });
  const r = checkHealth(repo, { stallMinutes: 45 });
  eq(r.gateExited.length, 1, "without a handoff it cannot be tied to a block, so it is still a wake");
  const w = new HealthWatcher(repo);
  const ev = w.scanGates(r);
  eq(ev.length, 1, "once");
  w.markWoken("dev", ev[0].key);
  eq(new HealthWatcher(repo).scanGates(checkHealth(repo, {})).length, 0, "and only once — the key bounds it");
});
