const { suite, ok, eq, match, load, makeRepo, busPath, writeJson, readJson, settle, vscode, LOOM, fixtureDir} = require("./harness");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { execFileSync } = require("child_process");
const { checkHealth, handoffIds, boardSessionId, isWorkingLike, countWorking, publishWorking, readWorking,
        scanWorktrees, removeWorktree, readRemovalLog, HealthWatcher, KNOWN_STATUSES, DRIFT_HOURS } = load("health.js");

const HOUR = 3_600_000;
/** Write a status.json with a controlled file mtime. */
function status(repo, role, obj, ageHours = 0) {
  const f = busPath(repo, role, "status.json");
  writeJson(f, obj);
  const t = (Date.now() - ageHours * HOUR) / 1000;
  fs.utimesSync(f, t, t);
  return f;
}

suite("health: a role working with no status update is stalled", () => {
  // The case the finish notifier structurally cannot see: it only fires on working -> done.
  const repo = makeRepo({ roles: { busy: {}, stuck: {} } });
  status(repo, "busy", { status: "working", current: "H-1" }, 0.1);
  status(repo, "stuck", { status: "working", current: "H-2" }, 3);
  const h = checkHealth(repo, { stallMinutes: 45 });
  eq(h.stalled.map((s) => s.role), ["stuck"], "only the silent one");
  ok(h.stalled[0].staleHours > 2.9, "reports how long it has been quiet");
  eq(h.stalled[0].status, "working", "and what it claims to be doing");
});

suite("health: idle and blocked roles are never 'stalled'", () => {
  const repo = makeRepo({ roles: { a: {}, b: {} } });
  status(repo, "a", { status: "idle" }, 500);
  status(repo, "b", { status: "blocked", current: "H-9" }, 500);
  eq(checkHealth(repo, { stallMinutes: 45 }).stalled, [], "a quiet idle role is just idle");
});

suite("health: the stall threshold is configurable", () => {
  const repo = makeRepo({ roles: { w: {} } });
  status(repo, "w", { status: "working" }, 2);
  eq(checkHealth(repo, { stallMinutes: 180 }).stalled, [], "under the threshold");
  eq(checkHealth(repo, { stallMinutes: 60 }).stalled.length, 1, "over it");
});

suite("health: a status outside the protocol is flagged, and why it matters", () => {
  // Measured live: shwab_docker/trader sat in "active", which the notifier never reacts to.
  const repo = makeRepo({ roles: { trader: {}, po: {} } });
  status(repo, "trader", { status: "active" });
  status(repo, "po", { status: "orchestrating" });
  const h = checkHealth(repo, {});
  eq(h.nonConforming.map((c) => c.role).sort(), ["po", "trader"], "both flagged");
  const t = h.nonConforming.find((c) => c.role === "trader");
  match(t.issue, /never notifies/, "explains the consequence for a working-like status");
  eq(KNOWN_STATUSES.sort(), ["blocked", "idle", "working"], "the protocol set");
});

suite("health: an unmaintained updated_at is flagged", () => {
  // Measured live: trader's file was touched 4.9h ago but its updated_at was 1205h stale.
  const repo = makeRepo({ roles: { w: {} } });
  status(repo, "w", { status: "working", updated_at: new Date(Date.now() - 100 * HOUR).toISOString() }, 0);
  const h = checkHealth(repo, {});
  const drift = h.nonConforming.find((c) => /updated_at/.test(c.issue));
  ok(drift, "drift detected");
  match(drift.issue, /behind the file/, "explains it: " + drift.issue);
  // a well-maintained one is silent
  const repo2 = makeRepo({ roles: { w: {} } });
  status(repo2, "w", { status: "working", updated_at: new Date().toISOString() }, 0);
  eq(checkHealth(repo2, {}).nonConforming.filter((c) => /updated_at/.test(c.issue)), [], "fresh timestamp is fine");
  ok(DRIFT_HOURS > 0, "the tolerance is a named constant");
});

suite("health: working-like statuses are recognised beyond the protocol word", () => {
  for (const s of ["working", "active", "Running", "busy"]) ok(isWorkingLike(s), s + " counts as working");
  for (const s of ["idle", "blocked", "", null, undefined, 42]) eq(isWorkingLike(s), false, JSON.stringify(s) + " does not");
});

suite("health: an unfiltered window reports nothing", () => {
  eq(checkHealth(null, {}), null, "no repo -> no report");
});

// ── global concurrency ──────────────────────────────────────────────────────
suite("concurrency: counts roles working across EVERY project", () => {
  const a = makeRepo({ roles: { w1: {}, w2: {} } }, "concA");
  const b = makeRepo({ roles: { w3: {} } }, "concB");
  status(a, "w1", { status: "working" });
  status(a, "w2", { status: "idle" });
  status(b, "w3", { status: "active" });          // working-like, different project
  const c = countWorking();
  ok(c.total >= 2, "counted across buses: " + JSON.stringify(c.roles));
  ok(c.roles.includes("concA/w1") && c.roles.includes("concB/w3"), "naming both");
  ok(!c.roles.includes("concA/w2"), "the idle one is not counted");
});

suite("concurrency: the count is published for every window to share", () => {
  const c = countWorking();
  publishWorking(c);
  const back = readWorking();
  eq(back.total, c.total, "round-trips");
  ok(Array.isArray(back.roles), "with the roles listed");
  // change-only: publishing the same set again must not rewrite
  const before = readWorking().at;
  publishWorking(countWorking());
  eq(readWorking().at, before, "unchanged count does not churn the file");
});

// ── worktree hygiene ────────────────────────────────────────────────────────
function gitRepo() {
  const root = fixtureDir("loom-wt-");
  const repoRoot = path.join(root, "proj");
  fs.mkdirSync(repoRoot);
  const git = (cwd, ...a) => execFileSync("git", ["-C", cwd, ...a], { encoding: "utf8", timeout: 15000 });
  git(repoRoot, "init", "-q", "-b", "main");
  git(repoRoot, "config", "user.email", "t@e.com"); git(repoRoot, "config", "user.name", "T");
  fs.writeFileSync(path.join(repoRoot, "f.txt"), "x"); git(repoRoot, "add", "-A"); git(repoRoot, "commit", "-qm", "i");
  return { repoRoot, git };
}
function addWorktree(git, repoRoot, role) {
  const wt = path.join(repoRoot, ".claude", "worktrees", role);
  fs.mkdirSync(path.dirname(wt), { recursive: true });
  git(repoRoot, "worktree", "add", "-q", "-b", "worktree-" + role, wt);
  return wt;
}
const haveGit = () => { try { execFileSync("git", ["--version"], { timeout: 5000 }); return true; } catch { return false; } };

suite("worktrees: orphans (no role on the board) are identified, dirty ones marked", () => {
  if (!haveGit()) return;
  const { repoRoot, git } = gitRepo();
  const repo = makeRepo({ roles: { onboard: {} } });
  addWorktree(git, repoRoot, "onboard");
  addWorktree(git, repoRoot, "leftover");
  const dirtyWt = addWorktree(git, repoRoot, "dirtyleftover");
  fs.writeFileSync(path.join(dirtyWt, "wip.txt"), "unbanked");
  const found = scanWorktrees(repo, repoRoot);
  eq(found.map((w) => w.role), ["dirtyleftover", "leftover", "onboard"], "all three found, sorted");
  eq(found.find((w) => w.role === "onboard").orphaned, false, "a role still on the board is not an orphan");
  eq(found.find((w) => w.role === "leftover").orphaned, true, "one with no board role is");
  eq(found.find((w) => w.role === "leftover").dirty, false, "and it is clean");
  eq(found.find((w) => w.role === "dirtyleftover").dirty, true, "uncommitted work marks it dirty");
});

suite("worktrees: removal refuses dirty and on-board ones, keeps the branch", () => {
  if (!haveGit()) return;
  const { repoRoot, git } = gitRepo();
  const repo = makeRepo({ roles: { keep: {} } });
  addWorktree(git, repoRoot, "keep");
  addWorktree(git, repoRoot, "gone");
  const dirtyWt = addWorktree(git, repoRoot, "messy");
  fs.writeFileSync(path.join(dirtyWt, "wip.txt"), "unbanked");
  const found = scanWorktrees(repo, repoRoot);
  const by = (r) => found.find((w) => w.role === r);

  eq(removeWorktree(repoRoot, by("keep")).ok, false, "on-board worktree refused");
  match(removeWorktree(repoRoot, by("keep")).note, /still on the board/, "saying why");
  eq(removeWorktree(repoRoot, by("messy")).ok, false, "dirty orphan refused");
  match(removeWorktree(repoRoot, by("messy")).note, /uncommitted/, "saying why");

  const r = removeWorktree(repoRoot, by("gone"));
  ok(r.ok, "clean orphan removed: " + r.note);
  eq(fs.existsSync(by("gone").path), false, "directory gone");
  match(git(repoRoot, "branch", "--list", "worktree-gone"), /worktree-gone/, "branch retained — recoverable");
  ok(fs.existsSync(by("keep").path) && fs.existsSync(by("messy").path), "the refused ones are untouched");
});

suite("worktrees: an unreadable worktree is treated as dirty, never removed", () => {
  const repo = makeRepo({ roles: {} });
  const root = fixtureDir("loom-nogit-");
  fs.mkdirSync(path.join(root, ".claude", "worktrees", "bogus"), { recursive: true });
  const found = scanWorktrees(repo, root);
  eq(found.length, 1, "found it");
  eq(found[0].dirty, true, "unverifiable counts as dirty");
  eq(removeWorktree(root, found[0]).ok, false, "so removal refuses");
});

suite("worktrees: no repo root means nothing to scan", () => {
  eq(scanWorktrees("anything", null), [], "null root");
  eq(scanWorktrees(null, "/tmp"), [], "null repo");
});

// ── stall alerting ──────────────────────────────────────────────────────────
suite("watchdog: a stall is announced once, and again only after it moves", () => {
  const repo = makeRepo({ roles: { w: {} } });
  const w = new HealthWatcher(repo);
  status(repo, "w", { status: "working" }, 5);
  const first = w.scan(checkHealth(repo, { stallMinutes: 45 }));
  eq(first.length, 1, "announced once");
  eq(first[0].role, "w", "naming the role");
  eq(w.scan(checkHealth(repo, { stallMinutes: 45 })).length, 0, "not repeated while still stuck");
  ok(readJson(busPath(repo, "stall-state.json")).alerted.w, "remembered on the bus");
  // it starts moving again, then stalls again -> a new alert
  status(repo, "w", { status: "working" }, 0);
  eq(w.scan(checkHealth(repo, { stallMinutes: 45 })).length, 0, "moving again clears it");
  status(repo, "w", { status: "working" }, 5);
  eq(w.scan(checkHealth(repo, { stallMinutes: 45 })).length, 1, "a fresh stall alerts again");
});

suite("watchdog: an unfiltered window alerts on nothing", () => {
  eq(new HealthWatcher(null).scan(null), [], "no repo, no report -> nothing");
});

suite("watchdog: the alert reaches the orchestrator via loom_cdp", () => {
  const repo = makeRepo({ roles: { w: {} } });
  fs.writeFileSync(path.join(LOOM, "loom_cdp.py"), "import sys\nprint(' '.join(sys.argv[1:]))\n");
  return new Promise((resolve, reject) => {
    new HealthWatcher(repo).alert({ repo, role: "w", status: "working", staleHours: 7.5 }, "po", (okFlag) => {
      try {
        ok(okFlag, "inject reported ok");
        const dbg = readJson(path.join(LOOM, "stall-debug.json"));
        match(dbg.out, /--role po/, "sent to the orchestrator");
        match(dbg.out, /loom-stall/, "as a stall alert");
        match(dbg.out, /7\.5h/, "naming how long it has been silent");
        resolve();
      } catch (e) { reject(e); }
    });
  });
});

// ── safeguards against mangling the git tree ────────────────────────────────
suite("worktrees: the ACTUAL branch is reported, not an assumed worktree-<role>", () => {
  if (!haveGit()) return;
  const { repoRoot, git } = gitRepo();
  const repo = makeRepo({ roles: {} });
  const wt = path.join(repoRoot, ".claude", "worktrees", "act");
  fs.mkdirSync(path.dirname(wt), { recursive: true });
  git(repoRoot, "worktree", "add", "-q", "-b", "act-module", wt);   // NOT worktree-act
  const f = scanWorktrees(repo, repoRoot)[0];
  eq(f.branch, "act-module", "reports the real branch name");
  const r = removeWorktree(repoRoot, f);
  ok(r.ok, "removed");
  match(r.note, /branch act-module kept/, "and names the real branch: " + r.note);
  match(r.note, /worktree add/, "with the restore command");
});

suite("worktrees: a DETACHED HEAD worktree is refused — its commits are on no branch", () => {
  if (!haveGit()) return;
  const { repoRoot, git } = gitRepo();
  const repo = makeRepo({ roles: {} });
  const wt = addWorktree(git, repoRoot, "loose");
  git(wt, "checkout", "--detach", "-q");
  const f = scanWorktrees(repo, repoRoot)[0];
  eq(f.branch, null, "detached -> no branch");
  const r = removeWorktree(repoRoot, f);
  eq(r.ok, false, "refused");
  match(r.note, /DETACHED/, "saying why");
  match(r.note, /switch -c/, "and how to make it safe");
  ok(fs.existsSync(wt), "nothing removed");
});

suite("worktrees: gitignored files git cannot restore block removal", () => {
  if (!haveGit()) return;
  // The trap: `git status --porcelain` does NOT list ignored files, so a worktree holding a .env
  // reads as perfectly clean. Measured live: 7 funisland worktrees hold learning.sqlite.
  const { repoRoot, git } = gitRepo();
  fs.writeFileSync(path.join(repoRoot, ".gitignore"), ".env\n*.sqlite\n");
  git(repoRoot, "add", "-A"); git(repoRoot, "commit", "-qm", "ignore");
  const repo = makeRepo({ roles: {} });
  const wt = addWorktree(git, repoRoot, "hassecrets");
  fs.writeFileSync(path.join(wt, ".env"), "API_KEY=hunter2");
  const f = scanWorktrees(repo, repoRoot)[0];
  eq(f.dirty, false, "porcelain says clean — this is exactly the trap");
  ok(f.risky.includes(".env"), "but the precious ignored file is seen: " + JSON.stringify(f.risky));
  const r = removeWorktree(repoRoot, f);
  eq(r.ok, false, "refused");
  match(r.note, /cannot restore/, "saying why: " + r.note);
  ok(fs.existsSync(path.join(wt, ".env")), "the .env is still there");
});

suite("worktrees: rebuildable ignored files do NOT block removal", () => {
  if (!haveGit()) return;
  const { repoRoot, git } = gitRepo();
  fs.writeFileSync(path.join(repoRoot, ".gitignore"), "__pycache__/\nnode_modules/\n");
  git(repoRoot, "add", "-A"); git(repoRoot, "commit", "-qm", "ignore");
  const repo = makeRepo({ roles: {} });
  const wt = addWorktree(git, repoRoot, "buildjunk");
  fs.mkdirSync(path.join(wt, "__pycache__"), { recursive: true });
  fs.writeFileSync(path.join(wt, "__pycache__", "x.pyc"), "junk");
  const f = scanWorktrees(repo, repoRoot)[0];
  eq(f.risky, [], "caches are not precious");
  ok(removeWorktree(repoRoot, f).ok, "so removal proceeds");
});

suite("worktrees: a worktree backing a LIVE session is refused", () => {
  if (!haveGit()) return;
  const { repoRoot, git } = gitRepo();
  const repo = makeRepo({ roles: {} });          // off the board, so otherwise removable
  addWorktree(git, repoRoot, "busyrole");
  const f = scanWorktrees(repo, repoRoot, new Set(["busyrole"]))[0];
  eq(f.live, true, "the tracker says a session is live here");
  const r = removeWorktree(repoRoot, f);
  eq(r.ok, false, "refused — it would pull the directory out from under a running session");
  match(r.note, /LIVE session/, "saying why");
});

suite("worktrees: unmerged commits are counted so you see what the branch holds", () => {
  if (!haveGit()) return;
  const { repoRoot, git } = gitRepo();
  const repo = makeRepo({ roles: {} });
  const wt = addWorktree(git, repoRoot, "hascommits");
  fs.writeFileSync(path.join(wt, "work.txt"), "banked");
  git(wt, "add", "-A"); git(wt, "commit", "-qm", "role work");
  const f = scanWorktrees(repo, repoRoot)[0];
  eq(f.ahead, 1, "one commit not on the default branch");
  match(removeWorktree(repoRoot, f).note, /1 commit\(s\) ahead/, "and the removal note says so");
});

suite("worktrees: every removal is logged with a way back", () => {
  if (!haveGit()) return;
  const { repoRoot, git } = gitRepo();
  const repo = makeRepo({ roles: {} });
  addWorktree(git, repoRoot, "logged");
  const f = scanWorktrees(repo, repoRoot)[0];
  const before = readRemovalLog().length;
  ok(removeWorktree(repoRoot, f).ok, "removed");
  const log = readRemovalLog();
  eq(log.length, before + 1, "one entry appended");
  const e = log[log.length - 1];
  eq(e.role, "logged", "role recorded");
  eq(e.branch, "worktree-logged", "branch recorded");
  ok(e.head && e.head.length >= 7, "and the exact commit it was on: " + e.head);
  ok(e.path && e.at, "with its path and timestamp");
});

// ── CL-001 · a block dispatched into a session that was never cleared ─────────────────────────
//
// Playbook §12 has required a clear-and-re-bind between every handoff since 2026-09-08. Measured
// across every bus on 2026-09-16: 18 of the 24 roles whose transcript could be read were carrying
// MORE than one block in one session (shwab_docker/trader: 22 blocks, 64.3 MB). The rule was prose,
// so nothing enforced it and nothing noticed. These tests are about the noticing.
//
// THE NAMES BELOW STATE EXACTLY WHAT THE BODY DRIVES — MP-002's finding and this block's stated
// trap: a test whose name claims a general property while its body drives one narrow helper is worse
// than no test, because the name stops you asking. Every suite here is named for the FUNCTION it
// drives. The one suite entitled to speak for the FIELD behaviour is the last one in this file: it
// boots the extension and goes through the `refresh` command — the same `runTick()` the 15s timer
// calls — because WL-008 shipped 188/188 green on a mechanism that could never fire, for exactly the
// want of that. It is a test file reaching for extension.js on purpose.

/** Set both halves of the observation: the board's session id, and the role's status file. */
function clearBus(name, role, sessionId, statusObj) {
  const repo = makeRepo({ roles: { [role]: { session_id: sessionId, branch: "b" } } }, name);
  writeJson(busPath(repo, role, "status.json"), statusObj);
  return repo;
}
function reSession(repo, role, sessionId) {
  const f = busPath(repo, "board.json");
  const b = readJson(f);
  b.roles[role].session_id = sessionId;
  writeJson(f, b);
}

suite("CL-001 scanClears: a NEW handoff id under an UNCHANGED session id raises one event", () => {
  const repo = clearBus("cl-new", "dev", "S-1", { status: "working", current: "B-1" });
  const w = new HealthWatcher(repo);
  eq(w.scanClears(checkHealth(repo, {})), [], "the first sighting is the BASELINE, not evidence");

  // The dispatch that skipped the clear: a new block, same session.
  writeJson(busPath(repo, "dev", "status.json"), { status: "working", current: "B-2", last_handled: "B-1" });
  const evs = w.scanClears(checkHealth(repo, {}));
  eq(evs.length, 1, "exactly one event for the one block that arrived");
  eq(evs[0].role, "dev");
  eq(evs[0].newId, "B-2", "the block that arrived");
  eq(evs[0].blocks, 2, "and how many this session is now known to have carried");
  eq(evs[0].ids, ["B-1", "B-2"], "named, so the orchestrator can check them itself");
});

suite("CL-001 scanClears: a CHANGED session id is a /clear and raises NOTHING", () => {
  // The negative half, and it is the same code path with one field different — which is what makes
  // the guard observable rather than argued.
  const repo = clearBus("cl-cleared", "dev", "S-1", { status: "working", current: "B-1" });
  const w = new HealthWatcher(repo);
  w.scanClears(checkHealth(repo, {}));                       // baseline on S-1

  // Cleared and re-bound, then given the next block. `last_handled` still names the OLD block —
  // exactly the shape that would otherwise report a violation against the dispatch that did it right.
  reSession(repo, "dev", "S-2");
  writeJson(busPath(repo, "dev", "status.json"), { status: "working", current: "B-2", last_handled: "B-1" });
  eq(w.scanClears(checkHealth(repo, {})), [], "a clear resets everything, including last_handled");

  // …and the new session is watched from there: a third block without a clear IS reported.
  writeJson(busPath(repo, "dev", "status.json"), { status: "working", current: "B-3", last_handled: "B-2" });
  const evs = w.scanClears(checkHealth(repo, {}));
  eq(evs.map((e) => e.newId), ["B-3"], "the fresh session is held to the same rule");
  eq(evs[0].blocks, 2, "B-2 was the baseline of the NEW session and B-3 arrived on top of it");
  eq(evs[0].ids, ["B-2", "B-3"], "and B-1 is gone with the session it belonged to");
  ok(!evs[0].ids.includes("B-1"),
     "`last_handled` survives a clear, so seeding the new session with it would carry a finished " +
     "block across the boundary and name it in a later reminder — measured, not reasoned");
});

suite("CL-001 checkHealth: a role it cannot judge is never counted as clean", () => {
  // WL-002's rule, and the third time this product has been bitten by it: "I cannot tell" is its own
  // state. A role with no session_id on the board is not a role with zero blocks.
  const repo = makeRepo({ roles: { nosid: { branch: "b" }, nostatus: { session_id: "S-9" } } }, "cl-unknown");
  writeJson(busPath(repo, "nosid", "status.json"), { status: "working", current: "B-1" });
  fs.mkdirSync(busPath(repo, "nostatus"), { recursive: true });
  fs.writeFileSync(busPath(repo, "nostatus", "outbox.md"), "");   // on the bus, but no status file
  const h = checkHealth(repo, {});
  const byRole = Object.fromEntries(h.clears.map((c) => [c.role, c]));
  eq(boardSessionId(repo, "nosid"), null, "a board entry with no session_id reads as null, not as a session");
  eq(boardSessionId(repo, "nostatus"), "S-9", "and the id is read out of the nested `roles` board shape");
  eq(boardSessionId(repo, "neverheardof"), null, "a role that is not on the board at all");
  match(byRole.nosid.unknown, /no session_id/, "no board session id: a clear is undetectable, and it says so");
  match(byRole.nostatus.unknown, /no readable status\.json/, "an unreadable status file is reported, not skipped");
  eq(byRole.nostatus.ids, [], "with nothing invented to fill it");

  const w = new HealthWatcher(repo);
  writeJson(busPath(repo, "nosid", "status.json"), { status: "working", current: "B-2", last_handled: "B-1" });
  eq(w.scanClears(h), [], "and an unjudgeable role never produces an event either way");
});

suite("CL-001 scanClears: an unreadable tick does not erase the baseline", () => {
  // If forgetting an unreadable role re-baselined it, deleting a status file would launder the
  // evidence — and a worker mid-write is exactly when the file is briefly unreadable.
  const repo = clearBus("cl-blip", "dev", "S-1", { status: "working", current: "B-1" });
  const w = new HealthWatcher(repo);
  w.scanClears(checkHealth(repo, {}));
  fs.writeFileSync(busPath(repo, "dev", "status.json"), "{ not json");
  eq(w.scanClears(checkHealth(repo, {})), [], "the blip itself says nothing");
  writeJson(busPath(repo, "dev", "status.json"), { status: "working", current: "B-2", last_handled: "B-1" });
  eq(w.scanClears(checkHealth(repo, {})).map((e) => e.newId), ["B-2"], "and B-1 is still the baseline");
});

suite("CL-001 handoffIds: only an id-shaped `current` can produce an arrival", () => {
  // `current` is free text in practice — half the live buses put a sentence in it. A loose reader
  // would manufacture a fresh "block" out of every re-worded status line, and the reminder would
  // become noise within a day.
  eq(handoffIds({ current: "CL-001", last_handled: "WL-010" }), ["CL-001", "WL-010"], "both fields read");
  eq(handoffIds({ current: "CL-001", last_handled: "CL-001" }), ["CL-001"], "and de-duplicated");
  eq(handoffIds({ current: "finishing up the review", last_handled: null }), [], "a sentence is not an id");
  eq(handoffIds({ current: 42 }), [], "nor is a number, an object, or a missing field");
  eq(handoffIds({}), []);

  const repo = clearBus("cl-shape", "dev", "S-1", { status: "working", current: "B-1" });
  const w = new HealthWatcher(repo);
  w.scanClears(checkHealth(repo, {}));
  writeJson(busPath(repo, "dev", "status.json"), { status: "working", current: "still on B-1, gate running" });
  eq(w.scanClears(checkHealth(repo, {})), [], "a re-worded status invents no arrival on the tick either");
  writeJson(busPath(repo, "dev", "status.json"), { status: "working", current: "DEV-217", last_handled: "B-1" });
  eq(w.scanClears(checkHealth(repo, {})).map((e) => e.newId), ["DEV-217"], "and a real id still lands");
});

suite("CL-001 markClearReported: an event repeats until it is DELIVERED, then stops", () => {
  // Delivery-only marking, for the reason WL-006/WL-008 paid for twice: marking on ATTEMPT records
  // "the orchestrator was told" for a message nobody received.
  const repo = clearBus("cl-deliver", "dev", "S-1", { status: "working", current: "B-1" });
  const w = new HealthWatcher(repo);
  w.scanClears(checkHealth(repo, {}));
  writeJson(busPath(repo, "dev", "status.json"), { status: "working", current: "B-2", last_handled: "B-1" });
  eq(w.scanClears(checkHealth(repo, {})).length, 1, "raised");
  eq(w.scanClears(checkHealth(repo, {})).length, 1, "and raised AGAIN — nothing was delivered");
  w.markClearReported("dev", "B-2");
  eq(w.scanClears(checkHealth(repo, {})), [], "delivered: it is retired");
  writeJson(busPath(repo, "dev", "status.json"), { status: "working", current: "B-3", last_handled: "B-2" });
  const evs = w.scanClears(checkHealth(repo, {}));
  eq(evs.map((e) => e.newId), ["B-3"], "and the NEXT block is still reported");
  eq(evs[0].blocks, 3, "with the already-delivered block still counted in the total");
});

suite("CL-001 scanClears: an UNDELIVERED arrival does not cross a /clear boundary", () => {
  // FOUND IN THE FIELD, NOT HERE. Every unit test above delivered the arrivals it raised, so all of
  // them passed while this was broken: an arrival raised on a tick where the composer was busy sits
  // in neither the baseline nor `reported`, and a /clear arriving before it was ever delivered
  // seeded the NEW session's baseline with it. The next reminder then named a block belonging to the
  // session that had just been cleared — the exact defect the seeding rule exists to prevent, alive
  // one branch over. Running the compiled code against a copy of the live bus is what showed it.
  const repo = clearBus("cl-undelivered", "dev", "S-1", { status: "working", current: "B-1" });
  const w = new HealthWatcher(repo);
  w.scanClears(checkHealth(repo, {}));
  writeJson(busPath(repo, "dev", "status.json"), { status: "working", current: "B-2", last_handled: "B-1" });
  eq(w.scanClears(checkHealth(repo, {})).length, 1, "B-2 arrives and is raised");
  // …and is NEVER delivered — no markClearReported. Then the role is cleared and given B-3.
  reSession(repo, "dev", "S-2");
  writeJson(busPath(repo, "dev", "status.json"), { status: "working", current: "B-3", last_handled: "B-2" });
  eq(w.scanClears(checkHealth(repo, {})), [], "the clear is still not a violation");
  writeJson(busPath(repo, "dev", "status.json"), { status: "working", current: "B-4", last_handled: "B-3" });
  const evs = w.scanClears(checkHealth(repo, {}));
  eq(evs.map((e) => e.newId), ["B-4"]);
  eq(evs[0].ids, ["B-3", "B-4"], "and the undelivered B-2 did not follow the role into its new session");
  eq(evs[0].blocks, 2, "so the count is the new session's, not a running total across the clear");
});

suite("CL-001 saveStall: the clear baseline survives on disk, across a new watcher", () => {
  // The saveStall early-return compares state field by field; a tick that changed ONLY `clears`
  // would have been dropped, and every arrival would then be rediscovered and re-sent every 15s.
  const repo = clearBus("cl-persist", "dev", "S-1", { status: "working", current: "B-1" });
  new HealthWatcher(repo).scanClears(checkHealth(repo, {}));
  const st = readJson(busPath(repo, "stall-state.json"));
  ok(st && st.clears && st.clears.dev, "the baseline reached stall-state.json — the existing precedent file");
  eq(st.clears.dev.session, "S-1", "keyed to the session it was observed under");
  writeJson(busPath(repo, "dev", "status.json"), { status: "working", current: "B-2", last_handled: "B-1" });
  // A FRESH watcher: an extension reload must not re-baseline and forget the violation.
  eq(new HealthWatcher(repo).scanClears(checkHealth(repo, {})).map((e) => e.newId), ["B-2"],
     "a reloaded extension still sees the arrival");
});

suite("CL-001 clearReminder: a reminder naming the next action, never a gate", () => {
  const repo = clearBus("cl-msg", "developer1", "S-1", { status: "working", current: "B-1" });
  const w = new HealthWatcher(repo);
  w.scanClears(checkHealth(repo, {}));
  writeJson(busPath(repo, "developer1", "status.json"), { status: "working", current: "B-2", last_handled: "B-1" });
  const msg = w.clearReminder(w.scanClears(checkHealth(repo, {}))[0]);
  match(msg, /developer1/, "names the role");
  match(msg, /at least 2 handoff ids in ONE session/, "the count, stated as the FLOOR it is");
  match(msg, /B-1, B-2/, "and the blocks, so it can be checked rather than believed");
  match(msg, /§12/, "cites the law it is reminding of");
  match(msg, /Nothing is blocked and nothing needs undoing/,
        "says outright that no work is stopped — an orchestrator reading this as a fault re-does finished work");
  match(msg, /NEXT dispatch/, "and gives the ONE action, at the point it is actually doable");
  ok(!/%/.test(msg), "no percentage: this is not a score of anyone's conduct");
  ok(!/\b(halt|refused|blocked until|do not proceed|stop work)\b/i.test(msg),
     "and nothing that reads as permission to stop working");
});

// ── CL-002 · A FIRST HANDOFF IS NOT A §12 VIOLATION ──────────────────────────────────────────
//
// §12 is violated by a SECOND block in one session. "At least 1" is not a violation of anything —
// it is a worker doing exactly what it should. The detector fired on it anyway, and it fired at the
// dispatch that had just cleared and re-bound the role seconds earlier: the reminder arriving at the
// orchestrator for having got it RIGHT. Fourth false alarm from this one detector in two days.
//
// WHERE IT CAME FROM, AND IT IS THE PREVIOUS FIX'S OWN SHADOW: the baseline of a new session drops
// every id that belonged to the OLD session (the "at least 3 for a session that carried two" fix
// above). On the §12 dispatch the status file names only the block just finished, so every id is
// dropped and the baseline is EMPTY BY CONSTRUCTION. The first id to arrive then reads
// `known.length === 0`, `arrived.length === 1`, and pushes an event with `blocks: 1`.

suite("CL-002 scanClears: a session's FIRST block raises nothing — one id is not a second one", () => {
  // The empty baseline, built the way the field builds it: the new session is first sighted naming
  // only the block the OLD session finished, so the carried-drop leaves it with nothing.
  const repo = clearBus("cl2-first", "dev", "S-1", { status: "working", current: "B-1" });
  const w = new HealthWatcher(repo);
  w.scanClears(checkHealth(repo, {}));                        // baseline on S-1: B-1

  reSession(repo, "dev", "S-2");
  writeJson(busPath(repo, "dev", "status.json"), { status: "idle", last_handled: "B-1" });
  eq(w.scanClears(checkHealth(repo, {})), [], "the re-bind itself is not evidence");
  eq(readJson(busPath(repo, "stall-state.json")).clears.dev.ids, [],
     "and the new session's baseline is EMPTY — B-1 went with the session it belonged to");

  // THE FIRST BLOCK OF THE NEW SESSION. Exactly one id, in a session that has carried nothing else.
  writeJson(busPath(repo, "dev", "status.json"), { status: "working", current: "B-2", last_handled: "B-1" });
  eq(w.scanClears(checkHealth(repo, {})), [],
     "one block in one session is §12 being FOLLOWED — reporting it reminds the orchestrator for " +
     "having cleared correctly, which is the opposite of what this detector is for");
});

suite("CL-002 scanClears: the full §12 sequence — clear, reset, bind, first block — is silent", () => {
  // The realistic shape, driven end to end rather than asserted about: the orchestrator resets the
  // role's status.json IN THE SAME BREATH as the `/clear`, which is what empties the baseline.
  const repo = clearBus("cl2-seq", "developer1", "S-1", { status: "working", current: "NT-000" });
  const w = new HealthWatcher(repo);
  w.scanClears(checkHealth(repo, {}));

  // /clear + reset, together. Nothing but the finished block is named.
  reSession(repo, "developer1", "S-2");
  writeJson(busPath(repo, "developer1", "status.json"),
            { status: "dispatched", last_handled: "NT-000", last_line: "Reset by productowner at the /clear." });
  eq(w.scanClears(checkHealth(repo, {})), [], "the reset tick");
  // bind: the worker rewrites its own status file with the block it was given.
  writeJson(busPath(repo, "developer1", "status.json"),
            { status: "working", current: "NT-001", last_handled: "NT-000" });
  eq(w.scanClears(checkHealth(repo, {})), [],
     "NT-001 is developer1's FIRST block in this session — the live false alarm, driven");
});

suite("CL-002 scanClears: a SECOND block still fires, floor 2, naming both", () => {
  // The property the guard must not cost. A suppressed first arrival is still REMEMBERED, so when
  // the second one lands the count is 2 and the first is named with it.
  const repo = clearBus("cl2-second", "dev", "S-1", { status: "working", current: "B-1" });
  const w = new HealthWatcher(repo);
  w.scanClears(checkHealth(repo, {}));
  reSession(repo, "dev", "S-2");
  writeJson(busPath(repo, "dev", "status.json"), { status: "idle", last_handled: "B-1" });
  w.scanClears(checkHealth(repo, {}));                        // empty baseline on S-2

  writeJson(busPath(repo, "dev", "status.json"), { status: "working", current: "B-2", last_handled: "B-1" });
  eq(w.scanClears(checkHealth(repo, {})), [], "first block: silent");
  writeJson(busPath(repo, "dev", "status.json"), { status: "working", current: "B-3", last_handled: "B-2" });
  const evs = w.scanClears(checkHealth(repo, {}));
  eq(evs.map((e) => e.newId).sort(), ["B-2", "B-3"], "the second block fires, and so does the one it makes a violation");
  ok(evs.every((e) => e.blocks === 2), "floor 2 — the session is now known to have carried two");
  // Named, not ordered: `ids` follows the status file (`current`, then `last_handled`), which is not
  // arrival order and has never claimed to be. The assertion is about WHICH blocks, not their order.
  eq([...evs[0].ids].sort(), ["B-2", "B-3"], "both named, so the orchestrator can check them rather than believe them");
  ok(!evs[0].ids.includes("B-1"), "and still nothing from the session that was cleared");
});

suite("CL-002 scanClears: a session first sighted HOLDING one block still fires on the next", () => {
  // The floor's whole reason for existing, and the case the guard must not swallow: a first sighting
  // cannot know what the session carried before it, so an id already present is one KNOWN block —
  // not zero. The next arrival is therefore a second block and reports as "at least 2".
  const repo = clearBus("cl2-holding", "dev", "S-1", { status: "working", current: "B-1" });
  const w = new HealthWatcher(repo);
  eq(w.scanClears(checkHealth(repo, {})), [], "the first sighting is the baseline");
  writeJson(busPath(repo, "dev", "status.json"), { status: "working", current: "B-2", last_handled: "B-1" });
  const evs = w.scanClears(checkHealth(repo, {}));
  eq(evs.map((e) => e.newId), ["B-2"], "and the block that arrives on top of it IS a violation");
  eq(evs[0].blocks, 2, "at least 2 — the extension reloading mid-block must not make this 1 and vanish");
  eq(evs[0].ids, ["B-1", "B-2"]);
});

suite("CL-002 scanClears: the suppressed first block is REMEMBERED across a later /clear", () => {
  // The guard goes at the EVENT PUSH, not in what counts as an arrival, and this is the difference.
  // `seen` is what stops an undelivered arrival following a role into its next session (the
  // undelivered-arrival fix above). Suppressing the arrival EARLIER — dropping it from `arrived` —
  // would leave it unrecorded, and it would then be seeded into the NEXT session's baseline and
  // named in a later reminder: the exact defect that fix exists to prevent, re-introduced by this one.
  const repo = clearBus("cl2-seen", "dev", "S-1", { status: "working", current: "B-1" });
  const w = new HealthWatcher(repo);
  w.scanClears(checkHealth(repo, {}));
  reSession(repo, "dev", "S-2");
  writeJson(busPath(repo, "dev", "status.json"), { status: "idle", last_handled: "B-1" });
  w.scanClears(checkHealth(repo, {}));                        // empty baseline
  writeJson(busPath(repo, "dev", "status.json"), { status: "working", current: "B-2", last_handled: "B-1" });
  eq(w.scanClears(checkHealth(repo, {})), [], "B-2 is suppressed, never delivered, never reported");
  eq(readJson(busPath(repo, "stall-state.json")).clears.dev.seen, ["B-2"],
     "but it is SEEN — the suppression is silence, not amnesia");

  reSession(repo, "dev", "S-3");
  writeJson(busPath(repo, "dev", "status.json"), { status: "working", current: "B-3", last_handled: "B-2" });
  eq(w.scanClears(checkHealth(repo, {})), [], "the next clear starts over");
  const st = readJson(busPath(repo, "stall-state.json")).clears.dev;
  ok(!st.ids.includes("B-2"), "and the suppressed B-2 did NOT follow the role into its new session");
});

suite("CL-002 scanClears: `unknown` and a missing session id still never count and never reset", () => {
  // Load-bearing, and stated here because the guard is a new `continue` in the same loop: a role that
  // cannot be read keeps its baseline, or deleting a status file would launder the evidence.
  const repo = clearBus("cl2-unknown", "dev", "S-1", { status: "working", current: "B-1" });
  const w = new HealthWatcher(repo);
  w.scanClears(checkHealth(repo, {}));
  writeJson(busPath(repo, "dev", "status.json"), { status: "working", current: "B-2", last_handled: "B-1" });
  fs.writeFileSync(busPath(repo, "dev", "status.json"), "{ not json");
  eq(w.scanClears(checkHealth(repo, {})), [], "an unreadable tick says nothing");
  eq(readJson(busPath(repo, "stall-state.json")).clears.dev.ids, ["B-1"], "and erases nothing");
  writeJson(busPath(repo, "dev", "status.json"), { status: "working", current: "B-2", last_handled: "B-1" });
  eq(w.scanClears(checkHealth(repo, {})).map((e) => e.newId), ["B-2"], "the baseline survived the blip intact");
});

suite("CL-002 scanClears: the WC-001 alarm the owner's window rendered is a STALE-BUILD artifact", () => {
  // THE 'WHICH BUILD RENDERED THIS FIGURE' RULE, APPLIED TO A DETECTOR. A second alarm fired live
  // saying developer2 carried CL-002 and WC-001 in one session. WC-001 belonged to the PREVIOUS
  // session and `last_handled` still named it because the reset happens in the same breath as the
  // clear. The owner's window is running 0.44.0 — so that alarm is what 0.44.0 does, and says
  // NOTHING about current source. Current source already has the baseline-drops-the-old-session's-ids
  // rule. Driven here rather than argued: this suite is the evidence that no patch is owed for it.
  const repo = clearBus("cl2-stale", "developer2", "S-1", { status: "working", current: "WC-001" });
  const w = new HealthWatcher(repo);
  w.scanClears(checkHealth(repo, {}));                        // the tracker saw the OLD session
  reSession(repo, "developer2", "S-2");
  writeJson(busPath(repo, "developer2", "status.json"),
            { status: "dispatched", current: "CL-002", last_handled: "WC-001" });
  eq(w.scanClears(checkHealth(repo, {})), [],
     "no event: the carried-drop already removes WC-001, and CL-002 is a first block besides");

  // …and the same reset seen by a tracker that never watched the old session (an extension reload):
  // a first sighting is the baseline whatever it names, so it is silent for a different reason.
  const fresh = clearBus("cl2-stale-reload", "developer2", "S-2",
                         { status: "dispatched", current: "CL-002", last_handled: "WC-001" });
  eq(new HealthWatcher(fresh).scanClears(checkHealth(fresh, {})), [],
     "a first sighting names its baseline and reports nothing, however many ids are in it");
});

// ── CL-001 · THE FIELD OBSERVATION ───────────────────────────────────────────────────────────
//
// Everything above drives functions. This drives the TICK: activate() the extension, then invoke
// `loomSessionTracker.refresh`, which is `runTick()` — the same function the 15s timer calls, which
// calls runHealth(), which is the only place scanClears() is wired. WL-008 is the reason this suite
// exists in this shape: 188 green tests on a mechanism that could never fire in the field, because
// they drove scanGates directly and nothing drove the thing that CALLS it.
//
// BOTH HALVES IN ONE RUN: the reminder appearing when a block arrives under an unchanged session id,
// and NOT appearing when the session id changes with it.
const cext = load("extension.js");
const ccdp = load("cdp.js");
const { setOrchestrator } = load("orchestrator.js");

const CLEAR_DEBUG = path.join(LOOM, "clear-debug.json");

suite("CL-001 on the real tick: the reminder is delivered by runTick, and a /clear silences it", async () => {
  const repo = makeRepo({ roles: { developer1: { session_id: "S-1", branch: "b" } } }, "cl-tick");
  writeJson(busPath(repo, "developer1", "status.json"),
            { status: "working", current: "WL-010", updated_at: new Date().toISOString() });
  // One project per window, exactly as the extension is deployed.
  const dir = path.join(fixtureDir("loom-clear-"), repo);
  fs.mkdirSync(dir);
  vscode.workspace.workspaceFolders = [{ uri: { fsPath: dir } }];
  setOrchestrator(repo, "product-owner", "wid-po");
  // The injector stub stands in for loom_cdp.py: it exits 0, so the inject is a real DELIVERY.
  fs.writeFileSync(path.join(LOOM, "loom_cdp.py"), "import sys\nprint(' '.join(sys.argv[1:]))\n");
  ccdp.readFrames = async () => [{ webviewId: "wid-po", contextPct: null, type: "iframe", targetUrl: "x",
    text: `orchestrating ~/.claude/loom/${repo}/board.json\nLOOMROLE=product-owner\nRemote Control\nOpus 5\nMedium\nBypass permissions\n` }];
  ccdp.closeWebview = async () => ({ ok: true, note: "closed" });
  try { fs.unlinkSync(CLEAR_DEBUG); } catch { /* none yet */ }

  const context = { subscriptions: [] };
  cext.activate(context);
  await settle(80);                                   // tick 1: baselines WL-010 under S-1
  try {
    eq(readJson(CLEAR_DEBUG), null, "nothing is said about a session on its first block");

    // THE DEFECT, on the bus: a second handoff written into a session nobody cleared.
    writeJson(busPath(repo, "developer1", "status.json"),
              { status: "working", current: "CL-001", last_handled: "WL-010",
                updated_at: new Date().toISOString() });
    await vscode.commands.executeCommand("loomSessionTracker.refresh");
    await settle(120);
    const sent = readJson(CLEAR_DEBUG);
    ok(sent, "the tick itself delivered a reminder — not a helper, the tick");
    ok(sent.ok, "and the injector took it: " + (sent && sent.note));
    eq(sent.target.role, "product-owner", "addressed to the ORCHESTRATOR, the one that dispatches");
    eq(sent.target.webviewId, "wid-po", "through the tagged frame, like every other orchestrator message");
    match(sent.message, /developer1 has now carried at least 2 handoff ids in ONE session/, "and it says what it saw");
    match(sent.message, /WL-010, CL-001/, "naming both blocks");

    // AND THE NEGATIVE HALF. The role is cleared (a new session id) and given the next block.
    fs.unlinkSync(CLEAR_DEBUG);
    const b = readJson(busPath(repo, "board.json"));
    b.roles.developer1.session_id = "S-2";
    writeJson(busPath(repo, "board.json"), b);
    writeJson(busPath(repo, "developer1", "status.json"),
              { status: "working", current: "CL-002", last_handled: "CL-001",
                updated_at: new Date().toISOString() });
    await vscode.commands.executeCommand("loomSessionTracker.refresh");
    await settle(120);
    eq(readJson(CLEAR_DEBUG), null,
       "a dispatch that DID clear and re-bind is told nothing — on the same tick path, one field different");

    // And it has not simply gone deaf: a third block on the NEW session is reported again.
    writeJson(busPath(repo, "developer1", "status.json"),
              { status: "working", current: "CL-003", last_handled: "CL-002",
                updated_at: new Date().toISOString() });
    await vscode.commands.executeCommand("loomSessionTracker.refresh");
    await settle(120);
    match((readJson(CLEAR_DEBUG) || {}).message || "", /CL-002, CL-003/,
          "the watch continues on the new session, counting from the clear");
  } finally {
    cext.deactivate();
    for (const d of context.subscriptions) { try { d.dispose && d.dispose(); } catch {} }
  }
});

suite("CL-001 on the real tick: clearReminders=false silences it entirely", async () => {
  const repo = makeRepo({ roles: { developer1: { session_id: "S-1", branch: "b" } } }, "cl-tick-off");
  writeJson(busPath(repo, "developer1", "status.json"), { status: "working", current: "WL-010" });
  const dir = path.join(fixtureDir("loom-clear-off-"), repo);
  fs.mkdirSync(dir);
  vscode.workspace.workspaceFolders = [{ uri: { fsPath: dir } }];
  vscode._config["loomSessionTracker.clearReminders"] = false;
  setOrchestrator(repo, "product-owner", "wid-po");
  ccdp.readFrames = async () => [];
  try { fs.unlinkSync(CLEAR_DEBUG); } catch { /* none yet */ }
  const context = { subscriptions: [] };
  cext.activate(context);
  await settle(80);
  try {
    writeJson(busPath(repo, "developer1", "status.json"),
              { status: "working", current: "CL-001", last_handled: "WL-010" });
    await vscode.commands.executeCommand("loomSessionTracker.refresh");
    await settle(120);
    eq(readJson(CLEAR_DEBUG), null, "a project that has switched it off is never typed into");
  } finally {
    cext.deactivate();
    for (const d of context.subscriptions) { try { d.dispose && d.dispose(); } catch {} }
    delete vscode._config["loomSessionTracker.clearReminders"];
  }
});

// ── PB-001 · TWO DETECTORS THAT CRIED WOLF, BOTH MEASURED ON THE LIVE BUS 2026-09-17 ───────────

suite("health: a respawned worker is NOT reported as an unclear session (PB-001)", () => {
  // MEASURED: the clear-detector told the orchestrator "developer2 has now carried at least 2
  // handoff ids in ONE session (PB-001, PD-001)" when that tab had DIED and been respawned as a
  // brand-new session minutes earlier. A respawn is the strongest clear there is — the transcript is
  // gone, not merely reset — so the reminder was not slightly wrong, it was inverted.
  //
  // THE RACE: the board is written by two parties (the role on bind, the tracker on rebind) and §12
  // requires the inbox be rewritten BEFORE the new tab exists. So there is a window where the NEW
  // handoff id is visible while the board still names the DEAD session. The trigger is met on every
  // correct respawn by construction.
  const { sessionAgreement } = load("health.js");
  const repo = makeRepo({ po: { session_id: "po-1" },
                          dev1: { session_id: "OLD-session", branch: "worktree-dev1" } });
  status(repo, "dev1", { status: "working", current: "PB-001", last_handled: "PD-001",
                         session_id: "NEW-session", updated_at: new Date().toISOString() });
  const snap = checkHealth(repo).clears.find((c) => c.role === "dev1");
  ok(snap.unknown, "the role is UNKNOWN this tick, not clean and not in violation");
  ok(/transition is in flight/.test(snap.unknown), `and says why: ${snap.unknown}`);

  // Unknown is never counted — so no event, and therefore no message.
  const w = new HealthWatcher(repo);
  eq(w.scanClears(checkHealth(repo)).length, 0, "no clear reminder is raised during the transition");
});

suite("health: once the records AGREE, the clear detector works exactly as before (PB-001)", () => {
  // The other direction, which is what stops the fix above from being a blanket suppression: the
  // identical bus with one field changed still reports a genuine §12 violation.
  const repo = makeRepo({ po: { session_id: "po-1" },
                          dev1: { session_id: "S1", branch: "worktree-dev1" } });
  status(repo, "dev1", { status: "working", current: "AA-001", session_id: "S1",
                         updated_at: new Date().toISOString() });
  const w = new HealthWatcher(repo);
  w.scanClears(checkHealth(repo));                       // baseline this session
  status(repo, "dev1", { status: "working", current: "AA-002", last_handled: "AA-001",
                         session_id: "S1", updated_at: new Date().toISOString() });
  const evs = w.scanClears(checkHealth(repo));
  eq(evs.length, 1, "a second block in the SAME session is still reported");
  eq(evs[0].newId, "AA-002", "naming the block that arrived");
});

suite("health: a status.json with no session_id leaves the board unchallenged (PB-001)", () => {
  // playbook §2's status schema does not require the field, so its absence must change nothing.
  const { sessionAgreement } = load("health.js");
  eq(sessionAgreement("S1", null).agree, true, "absent is not disagreement");
  eq(sessionAgreement(null, "S2").agree, true, "nor is an absent board id");
  eq(sessionAgreement("S1", "S1").agree, true, "agreement agrees");
  eq(sessionAgreement("S1", "S2").agree, false, "and a real disagreement is caught");
});

suite("health: THE ORCHESTRATOR IS NEVER STALL-ALERTED ABOUT ITSELF (PB-001)", () => {
  // MEASURED: the stall alarm fired at the orchestrator four times in one day. Its diagnosis was
  // meaningless — the stall clock is the mtime of status.json, which is a WORKER's heartbeat and
  // which an orchestrator is not required to maintain — and its prescription ("ring the role named
  // here") named the orchestrator itself, which is the one action that cannot help.
  const { setOrchestrator } = load("orchestrator.js");
  const old = new Date(Date.now() - 6 * 3600_000).toISOString();
  const repo = makeRepo({ po: { session_id: "po-1" }, dev1: { session_id: "d1" } });
  setOrchestrator(repo, "po", "frame-1");
  // Both files identical and equally stale, so the ONLY difference is which role is tagged.
  const stale = { status: "working", current: "AA-001", session_id: "x", updated_at: old };
  status(repo, "po", stale, 6);
  status(repo, "dev1", stale, 6);
  const stalled = checkHealth(repo).stalled.map((s) => s.role);
  ok(!stalled.includes("po"), "the orchestrator is not reported stalled on its own file's age");
  ok(stalled.includes("dev1"), "while a WORKER with the identical file still is");
});

suite("CL-002 on the real tick: the §12 dispatch is silent, and the block AFTER it is not", async () => {
  // THE LIVE FALSE ALARM, DRIVEN THROUGH `runTick()` RATHER THAN ASSERTED ABOUT. The suites above
  // drive scanClears; this drives the thing that CALLS it, because WL-008 shipped 188 green tests on
  // a mechanism that could never fire in the field. The guard is silence, and silence is exactly the
  // property a function-level test can hold while the wiring reports anyway.
  //
  // The sequence is the orchestrator's real one: clear, reset the status file in the same breath,
  // bind, then the first block. That is what empties the baseline, and the empty baseline is what
  // made the detector fire at the dispatch that had just done it right.
  const repo = makeRepo({ roles: { developer1: { session_id: "S-1", branch: "b" } } }, "cl2-tick");
  writeJson(busPath(repo, "developer1", "status.json"),
            { status: "working", current: "NT-000", updated_at: new Date().toISOString() });
  const dir = path.join(fixtureDir("loom-clear2-"), repo);
  fs.mkdirSync(dir);
  vscode.workspace.workspaceFolders = [{ uri: { fsPath: dir } }];
  setOrchestrator(repo, "product-owner", "wid-po");
  fs.writeFileSync(path.join(LOOM, "loom_cdp.py"), "import sys\nprint(' '.join(sys.argv[1:]))\n");
  ccdp.readFrames = async () => [{ webviewId: "wid-po", contextPct: null, type: "iframe", targetUrl: "x",
    text: `orchestrating ~/.claude/loom/${repo}/board.json\nLOOMROLE=product-owner\nRemote Control\nOpus 5\nMedium\nBypass permissions\n` }];
  ccdp.closeWebview = async () => ({ ok: true, note: "closed" });
  try { fs.unlinkSync(CLEAR_DEBUG); } catch { /* none yet */ }

  const context = { subscriptions: [] };
  cext.activate(context);
  await settle(80);                                   // tick 1: baselines NT-000 under S-1
  try {
    const tick = async () => {
      await vscode.commands.executeCommand("loomSessionTracker.refresh");
      await settle(120);
    };
    // /clear + reset, together, naming only the block just finished.
    const b = readJson(busPath(repo, "board.json"));
    b.roles.developer1.session_id = "S-2";
    writeJson(busPath(repo, "board.json"), b);
    writeJson(busPath(repo, "developer1", "status.json"),
              { status: "dispatched", last_handled: "NT-000",
                last_line: "Reset by productowner at the /clear.", updated_at: new Date().toISOString() });
    await tick();
    eq(readJson(CLEAR_DEBUG), null, "the reset tick says nothing");

    // THE FIRST BLOCK OF THE FRESH SESSION — the alarm that fired in the field, at the dispatch
    // that had cleared and re-bound the role seconds earlier.
    writeJson(busPath(repo, "developer1", "status.json"),
              { status: "working", current: "NT-001", last_handled: "NT-000",
                updated_at: new Date().toISOString() });
    await tick();
    eq(readJson(CLEAR_DEBUG), null,
       "ONE block in one session is §12 being followed — the tick delivers nothing, and this is the " +
       "assertion the live false alarm would have failed");

    // AND IT HAS NOT GONE DEAF. The second block into that same session is the violation, and it
    // still arrives — with the floor, both blocks named, and nothing from the cleared session.
    writeJson(busPath(repo, "developer1", "status.json"),
              { status: "working", current: "NT-002", last_handled: "NT-001",
                updated_at: new Date().toISOString() });
    await tick();
    const sent = readJson(CLEAR_DEBUG);
    ok(sent && sent.ok, "the second block is delivered by the tick: " + (sent && sent.note));
    match(sent.message, /at least 2 handoff ids in ONE session/, "the floor, worded as a floor");
    match(sent.message, /NT-001/, "the first block, which the second one made a violation");
    match(sent.message, /NT-002/, "and the block that arrived");
    ok(!/NT-000/.test(sent.message),
       "and NOTHING from the session that was cleared — the dropped id must not return as an arrival");
  } finally {
    cext.deactivate();
    for (const d of context.subscriptions) { try { d.dispose && d.dispose(); } catch {} }
  }
});
