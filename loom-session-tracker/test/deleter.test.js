// deleter.test.js — the most destructive path in the extension. Everything here exists to prove
// the "recoverable by design" contract: refuse if the work isn't banked, keep the branch, move the
// transcript rather than delete it.
const { suite, ok, eq, match, load, makeRepo, busPath, writeJson, readJson, home } = require("./harness");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { execFileSync } = require("child_process");
const { deleteSession } = load("deleter.js");

const git = (cwd, ...args) => execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8", timeout: 15000 });
function haveGit() { try { execFileSync("git", ["--version"], { timeout: 5000 }); return true; } catch { return false; } }

/** A repo laid out like a real Loom project, optionally with a worktree for `role`. */
function fixture(role, { withWorktree = true, commitInWorktree = false } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "loom-del-"));
  const repoRoot = path.join(root, "proj");
  fs.mkdirSync(repoRoot);
  git(repoRoot, "init", "-q", "-b", "main");
  git(repoRoot, "config", "user.email", "t@example.com");
  git(repoRoot, "config", "user.name", "T");
  fs.writeFileSync(path.join(repoRoot, "f.txt"), "hello");
  git(repoRoot, "add", "-A");
  git(repoRoot, "commit", "-qm", "init");
  const wt = path.join(repoRoot, ".claude", "worktrees", role);
  if (withWorktree) {
    fs.mkdirSync(path.dirname(wt), { recursive: true });
    git(repoRoot, "worktree", "add", "-q", "-b", `worktree-${role}`, wt);
    if (commitInWorktree) {
      fs.writeFileSync(path.join(wt, "work.txt"), "banked work");
      git(wt, "add", "-A");
      git(wt, "commit", "-qm", "the role's banked work");
    }
  }
  return { repoRoot, wt };
}

/** A bus + a transcript on disk for that role's session. */
function busWithTranscript(role, sid) {
  const repo = makeRepo({ roles: { [role]: { session_id: sid }, other: { session_id: "keep-me" } } });
  const projDir = path.join(home, ".claude", "projects", "-some-project");
  fs.mkdirSync(projDir, { recursive: true });
  const transcript = path.join(projDir, sid + ".jsonl");
  fs.writeFileSync(transcript, '{"type":"user"}\n');
  return { repo, transcript };
}

suite("deleter: REFUSES when the worktree has uncommitted work, and deletes nothing", () => {
  if (!haveGit()) return;
  const role = "dirtyrole";
  const { repoRoot, wt } = fixture(role);
  const { repo, transcript } = busWithTranscript(role, "sid-dirty");
  fs.writeFileSync(path.join(wt, "unbanked.txt"), "work in progress");   // uncommitted

  const r = deleteSession(repo, role, repoRoot, "stamp");
  eq(r.ok, false, "refused");
  match(r.error, /uncommitted work/i, "explains why: " + r.error);
  match(r.error, /bank it first/i, "tells the user what to do");
  eq(r.steps, [], "no steps taken");
  // nothing destroyed
  ok(fs.existsSync(wt), "worktree still present");
  ok(fs.existsSync(path.join(wt, "unbanked.txt")), "the unbanked work is untouched");
  ok(fs.existsSync(transcript), "transcript untouched");
  ok(readJson(busPath(repo, "board.json")).roles[role], "board entry untouched");
});

suite("deleter: REFUSES when git status cannot be read (never guesses it is clean)", () => {
  if (!haveGit()) return;
  const role = "unreadable";
  // A worktree path that is not a git worktree, under a non-git root -> status fails.
  const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), "loom-nogit-"));
  const wt = path.join(repoRoot, ".claude", "worktrees", role);
  fs.mkdirSync(wt, { recursive: true });
  const { repo } = busWithTranscript(role, "sid-unreadable");

  const r = deleteSession(repo, role, repoRoot, "stamp");
  eq(r.ok, false, "refused");
  match(r.error, /status unreadable/i, "says the status could not be read: " + r.error);
  ok(fs.existsSync(wt), "nothing removed");
});

suite("deleter: a clean worktree is removed but its BRANCH and commits are retained", () => {
  if (!haveGit()) return;
  const role = "cleanrole";
  const { repoRoot, wt } = fixture(role, { commitInWorktree: true });
  const { repo } = busWithTranscript(role, "sid-clean");

  const r = deleteSession(repo, role, repoRoot, "stamp");
  ok(r.ok, "succeeded: " + (r.error || ""));
  eq(fs.existsSync(wt), false, "worktree directory removed");
  match(r.steps.join(" | "), /worktree removed/, "reports the removal");
  match(r.steps.join(" | "), /retained/, "and says it is recoverable");
  // the recovery path must still exist
  match(git(repoRoot, "branch", "--list", `worktree-${role}`), new RegExp(`worktree-${role}`),
    "branch retained -> the work is re-addable");
  match(git(repoRoot, "log", "--oneline", `worktree-${role}`), /banked work/, "its commits are retained");
});

suite("deleter: the transcript is ARCHIVED, not destroyed", () => {
  if (!haveGit()) return;
  const role = "archiverole";
  const { repoRoot } = fixture(role);
  const sid = "sid-archive";
  const { repo, transcript } = busWithTranscript(role, sid);

  const r = deleteSession(repo, role, repoRoot, "2026-09-08T00-00-00");
  ok(r.ok, "succeeded");
  eq(fs.existsSync(transcript), false, "moved out of the projects dir");
  const archived = path.join(busPath(repo, "deleted-sessions"), `${role}-${sid}-2026-09-08T00-00-00.jsonl`);
  ok(fs.existsSync(archived), "archived under deleted-sessions/ with role, session id and stamp");
  eq(fs.readFileSync(archived, "utf8"), '{"type":"user"}\n', "content preserved byte-for-byte");
  match(r.steps.join(" | "), /transcript archived/, "reports it");
});

suite("deleter: the board entry is removed and other roles are left alone", () => {
  if (!haveGit()) return;
  const role = "boardrole";
  const { repoRoot } = fixture(role);
  const { repo } = busWithTranscript(role, "sid-board");

  const r = deleteSession(repo, role, repoRoot, "stamp");
  ok(r.ok, "succeeded");
  const board = readJson(busPath(repo, "board.json"));
  eq(board.roles[role], undefined, "the deleted role is gone from the roster");
  ok(board.roles.other, "the other role is untouched");
  match(r.steps.join(" | "), /board.json entry removed/, "reports it");
});

suite("deleter: works when the role has no worktree at all", () => {
  const role = "noworktree";
  const { repo, transcript } = busWithTranscript(role, "sid-nowt");
  const r = deleteSession(repo, role, null, "stamp");     // repoRoot null -> worktree step skipped
  ok(r.ok, "succeeded");
  eq(fs.existsSync(transcript), false, "transcript still archived");
  eq(readJson(busPath(repo, "board.json")).roles[role], undefined, "board still cleaned");
  eq(r.steps.some((s) => /worktree/.test(s)), false, "no worktree step claimed");
});

suite("deleter: a role with no transcript on disk still cleans up", () => {
  const role = "notranscript";
  const repo = makeRepo({ roles: { [role]: { session_id: "sid-missing" } } });
  const r = deleteSession(repo, role, null, "stamp");
  ok(r.ok, "succeeded");
  eq(r.steps.some((s) => /transcript/.test(s)), false, "no archive step claimed");
  eq(readJson(busPath(repo, "board.json")).roles[role], undefined, "board cleaned");
});

suite("deleter: a FLAT board is left alone (entries live under roles{})", () => {
  // Documents the actual contract: only a nested roster is edited.
  const role = "flatrole";
  const repo = makeRepo({ [role]: { session_id: "sid-flat" } });     // flat board, no roles{}
  const r = deleteSession(repo, role, null, "stamp");
  ok(r.ok, "still succeeds");
  ok(readJson(busPath(repo, "board.json"))[role], "flat entry is not removed");
  eq(r.steps.some((s) => /board.json/.test(s)), false, "and it does not claim to have removed one");
});

suite("deleter: never throws on missing or corrupt inputs", () => {
  const r1 = deleteSession("no-such-repo", "ghost", null, "stamp");
  ok(r1.ok, "missing bus is not fatal");
  const repo = makeRepo(null);
  fs.writeFileSync(busPath(repo, "board.json"), "}{ corrupt");
  const r2 = deleteSession(repo, "ghost", null, "stamp");
  ok(r2.ok, "corrupt board is not fatal");
  const r3 = deleteSession(repo, "ghost", "/nonexistent/path/xyz", "stamp");
  ok(typeof r3.ok === "boolean", "a bad repoRoot returns a result rather than throwing");
});
