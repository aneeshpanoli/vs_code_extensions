const { suite, ok, eq, match, load, makeRepo, busPath, setStatus, readJson, LOOM } = require("./harness");
const fs = require("fs");
const path = require("path");
const { Notifier } = load("notifier.js");
const { setOrchestrator } = load("orchestrator.js");

// A bus with an orchestrator tagged and one worker.
function bus() {
  const repo = makeRepo({ po: {}, w1: {} });
  setOrchestrator(repo, "po");
  return repo;
}
// Each Notifier instance is a fresh "IDE run" — state must come from the bus.
const restart = (repo) => new Notifier(repo);

suite("notifier: a never-scanned bus baselines silently", () => {
  const repo = bus();
  setStatus(repo, "w1", { status: "working", current: "H-7" });
  eq(restart(repo).scan().length, 0, "first ever scan announces nothing");
  ok(fs.existsSync(busPath(repo, "notify-state.json")), "but records the baseline on the bus");
});

suite("notifier: working -> idle is announced once", () => {
  const repo = bus();
  setStatus(repo, "w1", { status: "working", current: "H-7" });
  restart(repo).scan();
  setStatus(repo, "w1", { status: "idle", current: "H-7", last_line: "done, 12 tests pass" });
  const ev = restart(repo).scan();
  eq(ev.length, 1, "one event");
  eq(ev[0].role, "w1", "role");
  eq(ev[0].task, "H-7", "task id");
  eq(ev[0].status, "idle", "post-work status");
  match(ev[0].lastLine, /12 tests pass/, "carries last_line");
  eq(restart(repo).scan().length, 0, "not announced again on the next tick");
});

suite("notifier: a finish DURING an IDE restart is still announced", () => {
  // The whole point of persisting state: the editor is closed while the worker finishes.
  const repo = bus();
  setStatus(repo, "w1", { status: "working", current: "H-7" });
  restart(repo).scan();                       // IDE run #1 records "working"
  setStatus(repo, "w1", { status: "idle", current: "H-7", last_line: "finished offline" });
  const ev = restart(repo).scan();            // IDE run #2, zero in-memory history
  eq(ev.length, 1, "downtime completion announced after restart");
  match(ev[0].lastLine, /finished offline/, "with its last line");
});

suite("notifier: two windows on one repo cannot both announce", () => {
  const repo = bus();
  setStatus(repo, "w1", { status: "working", current: "H-7" });
  restart(repo).scan();
  setStatus(repo, "w1", { status: "idle", current: "H-7" });
  const a = new Notifier(repo), b = new Notifier(repo);
  eq(a.scan().length, 1, "first window announces");
  eq(b.scan().length, 0, "second window sees it already announced");
});

suite("notifier: blocked (loop-back) is announced like a finish", () => {
  const repo = bus();
  setStatus(repo, "w1", { status: "working", current: "H-8" });
  restart(repo).scan();
  setStatus(repo, "w1", { status: "blocked", current: "H-8", last_line: "need a PO decision" });
  const ev = restart(repo).scan();
  eq(ev.length, 1, "blocked fires");
  eq(ev[0].status, "blocked", "status carried through");
});

suite("notifier: re-running the SAME task announces again", () => {
  const repo = bus();
  setStatus(repo, "w1", { status: "working", current: "H-7" });
  restart(repo).scan();
  setStatus(repo, "w1", { status: "idle", current: "H-7" });
  eq(restart(repo).scan().length, 1, "first finish");
  setStatus(repo, "w1", { status: "working", current: "H-7" });    // back to work, same id
  restart(repo).scan();
  setStatus(repo, "w1", { status: "idle", current: "H-7" });
  eq(restart(repo).scan().length, 1, "second finish of the same id announces too");
});

suite("notifier: staying idle never fires", () => {
  const repo = bus();
  setStatus(repo, "w1", { status: "idle", current: "H-1" });
  restart(repo).scan();
  setStatus(repo, "w1", { status: "idle", current: "H-1" });
  eq(restart(repo).scan().length, 0, "idle -> idle is not a finish");
});

suite("notifier: the orchestrator's own transitions never fire", () => {
  const repo = bus();
  setStatus(repo, "po", { status: "working", current: "orchestrating" });
  restart(repo).scan();
  setStatus(repo, "po", { status: "idle", current: "orchestrating" });
  eq(restart(repo).scan().length, 0, "PO is watched by nobody");
});

suite("notifier: a role the board forgot, but the bus knows, IS watched", () => {
  // Boards go stale; a mailbox does not. Measured 2026-09-08, gaming/gameplay and livegita/developer
  // each had a full mailbox and no board entry, and their finishes could never have been announced.
  const repo = bus();
  setStatus(repo, "stranger", { status: "working", current: "X" });
  restart(repo).scan();
  setStatus(repo, "stranger", { status: "idle", current: "X" });
  eq(restart(repo).scan().length, 1, "a mailbox-owning role is on the roster");
});

suite("notifier: a finish from an OFF-PROTOCOL working status is still announced", () => {
  // The protocol is idle | working | blocked, but sessions write other things: measured 2026-09-08,
  // shwab_docker/trader sat in "active". Baselining only on the literal "working" made every such
  // role's finish invisible forever.
  const repo = bus();
  setStatus(repo, "w1", { status: "active", current: "H-9" });
  restart(repo).scan();
  setStatus(repo, "w1", { status: "idle", current: "H-9", last_line: "shipped" });
  const ev = restart(repo).scan();
  eq(ev.length, 1, "active -> idle announced");
  eq(ev[0].task, "H-9", "with its handoff id");
});

suite("notifier: an off-protocol working status does not itself announce", () => {
  const repo = bus();
  setStatus(repo, "w1", { status: "working", current: "H-9" });
  restart(repo).scan();
  setStatus(repo, "w1", { status: "busy", current: "H-9" });
  eq(restart(repo).scan().length, 0, "working -> busy is still working, not a finish");
});

suite("notifier: an unfiltered window (no repo) does nothing", () => {
  eq(new Notifier(null).scan(), [], "null repo -> no scan, no state written");
});

suite("notifier: corrupt state file degrades to a fresh baseline", () => {
  const repo = bus();
  setStatus(repo, "w1", { status: "working", current: "H-7" });
  restart(repo).scan();
  fs.writeFileSync(busPath(repo, "notify-state.json"), "not json");
  setStatus(repo, "w1", { status: "idle", current: "H-7" });
  eq(restart(repo).scan().length, 0, "unreadable state -> baseline, not a crash");
  ok(readJson(busPath(repo, "notify-state.json")), "and the file is rewritten valid");
});

suite("notifier: notifyOrchestrator refuses when nothing is tagged", (done) => {
  const repo = makeRepo({ w1: {} });          // no orchestrator.json
  return new Promise((resolve, reject) => {
    new Notifier(repo).notifyOrchestrator(
      { repo, role: "w1", status: "idle", task: "H-1", lastLine: "" },
      (okFlag, note) => {
        try { eq(okFlag, false, "not ok"); match(note, /no orchestrator tagged/, "explains why"); resolve(); }
        catch (e) { reject(e); }
      });
  });
});

suite("notifier: notifyOrchestrator shells out to loom_cdp inject", () => {
  const repo = bus();
  // Stub loom_cdp.py so nothing real is driven; it just echoes its args.
  fs.writeFileSync(path.join(LOOM, "loom_cdp.py"), "import sys\nprint(' '.join(sys.argv[1:]))\n");
  return new Promise((resolve, reject) => {
    new Notifier(repo).notifyOrchestrator(
      { repo, role: "w1", status: "idle", task: "H-7", lastLine: "all green" },
      (okFlag) => {
        try {
          ok(okFlag, "inject reported ok");
          const dbg = readJson(path.join(LOOM, "notify-debug.json"));
          eq(dbg.target.role, "po", "targeted the tagged orchestrator");
          match(dbg.out, /inject/, "ran the inject subcommand");
          match(dbg.out, /--submit/, "submitted the prompt");
          match(dbg.out, /w1 finished on H-7/, "message names the worker and task");
          match(dbg.out, /outbox\.md/, "tells the PO where to read");
          resolve();
        } catch (e) { reject(e); }
      });
  });
});
