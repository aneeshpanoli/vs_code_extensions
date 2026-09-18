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

suite("notifier: working -> idle is QUEUED once (detection, not delivery)", () => {
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
  eq(restart(repo).scan().length, 0, "not queued again on the next tick");
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

suite("notifier: two windows on one repo cannot both queue the same finish", () => {
  const repo = bus();
  setStatus(repo, "w1", { status: "working", current: "H-7" });
  restart(repo).scan();
  setStatus(repo, "w1", { status: "idle", current: "H-7" });
  const a = new Notifier(repo), b = new Notifier(repo);
  eq(a.scan().length, 1, "first window queues it");
  eq(b.scan().length, 0, "second window sees it already owed");
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

// ── NF-001 · a finish is retired when it is DELIVERED, never when it is detected ────────────────

suite("notifier: a detected finish is OWED until it is delivered", () => {
  const repo = bus();
  setStatus(repo, "w1", { status: "working", current: "H-7" });
  restart(repo).scan();
  setStatus(repo, "w1", { status: "idle", current: "H-7", last_line: "done" });
  eq(restart(repo).scan().length, 1, "detected");
  const due = restart(repo).duePending();
  ok(due, "and it is owed to the orchestrator");
  eq(due.role, "w1", "the role");
  eq(due.key, "w1|H-7|idle", "keyed by role, task and post-work status");
  eq(readJson(busPath(repo, "notify-state.json")).announced.length, 0,
     "DETECTION RETIRES NOTHING — this is the whole block");
});

suite("notifier: a REFUSED delivery is still owed on the next tick", () => {
  const repo = bus();
  setStatus(repo, "w1", { status: "working", current: "H-7" });
  restart(repo).scan();
  setStatus(repo, "w1", { status: "idle", current: "H-7" });
  restart(repo).scan();
  const ev = restart(repo).duePending();
  restart(repo).settle(ev, "retry", "composer busy or frame not found");
  const again = restart(repo).duePending();
  ok(again, "a composer that refused is not an orchestrator that heard");
  eq(again.key, ev.key, "the same event");
  eq(again.attempts, 1, "and the attempt is counted where a reader of the bus can see it");
  match(again.lastNote, /composer busy/, "with the injector's own words");
});

suite("notifier: a DELIVERED finish is retired and never repeats", () => {
  const repo = bus();
  setStatus(repo, "w1", { status: "working", current: "H-7" });
  restart(repo).scan();
  setStatus(repo, "w1", { status: "idle", current: "H-7" });
  restart(repo).scan();
  const ev = restart(repo).duePending();
  restart(repo).settle(ev, "latch", "injected");
  eq(restart(repo).duePending(), null, "nothing owed");
  eq(restart(repo).scan().length, 0, "and re-scanning the same idle state re-queues nothing");
  eq(restart(repo).duePending(), null, "still nothing owed after another tick");
});

suite("notifier: a role back at WORK supersedes what it was owed", () => {
  // Superseded, in one word: a role only goes back to working because it was given a handoff, and
  // handoffs come from the orchestrator — so a role at work is proof the finish was noticed.
  const repo = bus();
  setStatus(repo, "w1", { status: "working", current: "H-7" });
  restart(repo).scan();
  setStatus(repo, "w1", { status: "idle", current: "H-7" });
  eq(restart(repo).scan().length, 1, "owed");
  setStatus(repo, "w1", { status: "working", current: "H-8" });
  restart(repo).scan();
  eq(restart(repo).duePending(), null, "a stale finish is dropped, not delivered late");
  setStatus(repo, "w1", { status: "idle", current: "H-8" });
  restart(repo).scan();
  eq(restart(repo).duePending().task, "H-8", "and the NEW finish is owed on its own");
});

suite("notifier: settling an event the bus has dropped re-queues nothing", () => {
  const repo = bus();
  setStatus(repo, "w1", { status: "working", current: "H-7" });
  restart(repo).scan();
  setStatus(repo, "w1", { status: "idle", current: "H-7" });
  restart(repo).scan();
  const ev = restart(repo).duePending();
  setStatus(repo, "w1", { status: "working", current: "H-8" });   // superseded mid-injection
  restart(repo).scan();
  restart(repo).settle(ev, "retry", "composer busy");
  eq(restart(repo).duePending(), null, "a retry cannot resurrect what going back to work dropped");
});

suite("notifier: five finishes queue oldest-first, one delivery at a time", () => {
  const repo = makeRepo({ po: {}, a: {}, b: {}, c: {}, d: {}, e: {} });
  setOrchestrator(repo, "po");
  for (const r of ["a", "b", "c", "d", "e"]) setStatus(repo, r, { status: "working", current: "H" });
  restart(repo).scan();
  // finished in this order, each at a distinct instant so the queue order is the FINISH order
  let t = Date.parse("2026-09-18T10:00:00Z");
  for (const r of ["c", "a", "e", "b", "d"]) {
    setStatus(repo, r, { status: "idle", current: "H" });
    restart(repo).scan(t += 60_000);
  }
  eq(restart(repo).backlog().count, 5, "all five are owed — none was lost to a busy composer");
  const order = [];
  for (let i = 0; i < 5; i++) {
    const ev = restart(repo).duePending();
    order.push(ev.role);
    restart(repo).settle(ev, "latch", "injected");
  }
  eq(order, ["c", "a", "e", "b", "d"], "delivered one per tick in the order they FINISHED");
  eq(restart(repo).duePending(), null, "and the queue is empty, each delivered exactly once");
});

suite("notifier: the backlog says how long the orchestrator has not been reached", () => {
  const repo = bus();
  setStatus(repo, "w1", { status: "working", current: "H-7" });
  restart(repo).scan();
  setStatus(repo, "w1", { status: "idle", current: "H-7" });
  const at = Date.parse("2026-09-18T10:00:00Z");
  restart(repo).scan(at);
  const b = restart(repo).backlog(at + 90 * 60_000);
  eq(b.count, 1, "one owed");
  eq(b.oldestAgeMs, 90 * 60_000, "for ninety minutes — the three-hour outbox, made visible");
  eq(b.oldest.role, "w1", "and it names who is waiting");
});

suite("notifier: a 0.62.0 state file (no pending) is read, not discarded", () => {
  // Its `announced` meant DETECTED. Carried over as-is: clearing it would re-announce every finish
  // already acted on, on every bus, at upgrade.
  const repo = bus();
  setStatus(repo, "w1", { status: "working", current: "H-7" });
  restart(repo).scan();
  const f = busPath(repo, "notify-state.json");
  const old = readJson(f);
  delete old.pending;
  old.announced = ["w1|H-7|idle"];
  fs.writeFileSync(f, JSON.stringify(old));
  setStatus(repo, "w1", { status: "idle", current: "H-7" });
  eq(restart(repo).scan().length, 0, "what the old build recorded still suppresses");
  eq(restart(repo).duePending(), null, "and nothing is owed twice by the upgrade");
});

suite("notifier: retirement is matched on the queued INSTANCE, not on the key", () => {
  // `key` is role|task|status and rerunning a handoff produces it twice (see the suite above). An
  // injection can still be in flight when the second finish is queued, and settling by key would
  // retire an event the injector never carried — this block's own defect, at the retirement end.
  const repo = bus();
  setStatus(repo, "w1", { status: "working", current: "H-7" });
  restart(repo).scan();
  setStatus(repo, "w1", { status: "idle", current: "H-7" });
  restart(repo).scan();
  const first = restart(repo).duePending();          // handed to a slow injector
  setStatus(repo, "w1", { status: "working", current: "H-7" });
  restart(repo).scan();                              // re-dispatched: first is dropped
  setStatus(repo, "w1", { status: "idle", current: "H-7" });
  restart(repo).scan();                              // …and finishes the SAME handoff again
  const second = restart(repo).duePending();
  eq(second.key, first.key, "the same key");
  ok(second.id !== first.id, "and a different instance");
  restart(repo).settle(first, "latch", "injected");  // the old injection lands
  const still = restart(repo).duePending();
  ok(still, "the second finish is STILL OWED — it was never delivered");
  eq(still.id, second.id, "the very instance that was queued");
});

suite("notifier: a scan cannot roll back a delivery that landed while it was reading", () => {
  // `scan` is a read-modify-write: it loads state, then reads board.json and one status.json per
  // role, then saves. A `settle` from another window (or this window's own injection callback) fits
  // inside that gap, and writing the snapshot back would resurrect the delivered event AND erase
  // the record of it — a second copy typed into the composer. The save is a merge for that reason.
  const repo = bus();
  setStatus(repo, "w1", { status: "working", current: "H-7" });
  restart(repo).scan();
  setStatus(repo, "w1", { status: "idle", current: "H-7" });
  restart(repo).scan();
  const ev = restart(repo).duePending();
  // window B is mid-scan holding the pre-delivery snapshot; window A settles; B then saves.
  const windowB = restart(repo);
  const realRead = fs.readFileSync;
  let settled = false;
  fs.readFileSync = function (f, ...rest) {
    if (!settled && String(f).endsWith("status.json")) {
      settled = true;
      restart(repo).settle(ev, "latch", "injected");       // …window A delivers, right here
    }
    return realRead.call(this, f, ...rest);
  };
  try { windowB.scan(); } finally { fs.readFileSync = realRead; }
  ok(settled, "the delivery landed inside window B's scan");
  eq(restart(repo).duePending(), null, "and B's save did not resurrect it");
  eq(readJson(busPath(repo, "notify-state.json")).announced, ["w1|H-7|idle"],
     "nor erase the record that it was delivered");
});

suite("notifier: a refused event backs off instead of spawning an injector every tick", () => {
  const repo = bus();
  setStatus(repo, "w1", { status: "working", current: "H-7" });
  restart(repo).scan();
  setStatus(repo, "w1", { status: "idle", current: "H-7" });
  const t0 = Date.parse("2026-09-18T10:00:00Z");
  restart(repo).scan(t0);
  let ev = restart(repo).duePending(t0);
  for (let i = 0; i < 5; i++) {
    ok(ev, `attempt ${i + 1} is due immediately — the first minute of ticks retries flat out`);
    restart(repo).settle(ev, "retry", "composer busy", t0);
    ev = restart(repo).duePending(t0);
  }
  eq(ev, null, "after five refusals it is not retried on the very next tick");
  ok(restart(repo).duePending(t0 + 61_000), "but it IS retried a minute later — deferred, not dropped");
});

suite("notifier: an event owed for a day is dropped, and the drop is recorded", () => {
  const repo = bus();
  setStatus(repo, "w1", { status: "working", current: "H-7" });
  restart(repo).scan();
  setStatus(repo, "w1", { status: "idle", current: "H-7" });
  const t0 = Date.parse("2026-09-18T10:00:00Z");
  restart(repo).scan(t0);
  const later = restart(repo);
  later.scan(t0 + 25 * 60 * 60 * 1000);
  eq(later.duePending(), null, "expired");
  const st = readJson(busPath(repo, "notify-state.json"));
  eq(st.dropped.length, 1, "AND SAID SO — the queue emptying is not the same as anyone being told");
  eq(st.dropped[0].key, "w1|H-7|idle", "which finish");
  match(st.dropped[0].why, /expired/, "and why");
  eq(st.announced.length, 0, "an expiry is not a delivery");
});
