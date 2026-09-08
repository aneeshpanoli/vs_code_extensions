const { suite, ok, eq, match, load, makeRepo, busPath, writeJson, readJson, LOOM } = require("./harness");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { execFileSync } = require("child_process");
const { checkHealth, isWorkingLike, countWorking, publishWorking, readWorking,
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
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "loom-wt-"));
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
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "loom-nogit-"));
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
