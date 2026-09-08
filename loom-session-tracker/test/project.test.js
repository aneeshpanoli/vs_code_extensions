const { suite, ok, eq, load, vscode, home } = require("./harness");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { execFileSync } = require("child_process");
const { currentRepo, repoRoot } = load("project.js");

const git = (cwd, ...args) => execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8", timeout: 10000 });
function haveGit() { try { execFileSync("git", ["--version"], { timeout: 5000 }); return true; } catch { return false; } }
const openFolder = (p) => { vscode.workspace.workspaceFolders = [{ uri: { fsPath: p } }]; };

/** A repo named like a Loom project, with one worktree, mirroring the real layout. */
function fixtureRepo(name) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "loom-git-"));
  const repo = path.join(root, name);
  fs.mkdirSync(repo);
  git(repo, "init", "-q", "-b", "main");
  git(repo, "config", "user.email", "t@example.com");
  git(repo, "config", "user.name", "T");
  fs.writeFileSync(path.join(repo, "f.txt"), "hello");
  git(repo, "add", "-A");
  git(repo, "commit", "-qm", "init");
  return repo;
}

suite("project: an unopened window has no repo (the tracker then runs unfiltered)", () => {
  vscode.workspace.workspaceFolders = undefined;
  eq(currentRepo(), null, "no folder -> null");
  eq(repoRoot(), null, "and no root");
});

suite("project: the repo id is the project directory name", () => {
  if (!haveGit()) return;                       // git is required for this fixture
  const repo = fixtureRepo("funisland");
  openFolder(repo);
  eq(currentRepo(), "funisland", "matches the board.json bus name");
  eq(repoRoot(), repo, "root is the checkout itself");
});

suite("project: a WORKTREE window resolves to the parent project, not the worktree", () => {
  if (!haveGit()) return;
  // This is what makes a role session (on .claude/worktrees/<role>) share the parent's bus.
  const repo = fixtureRepo("Gaming");
  const wt = path.join(repo, ".claude", "worktrees", "developer");
  fs.mkdirSync(path.dirname(wt), { recursive: true });
  git(repo, "worktree", "add", "-q", "-b", "worktree-developer", wt);
  openFolder(wt);
  eq(currentRepo(), "Gaming", "worktree maps back to the parent repo id");
  eq(repoRoot(), repo, "and git operations target the main checkout");
});

suite("project: a non-git folder falls back to its own name", () => {
  const plain = fs.mkdtempSync(path.join(os.tmpdir(), "loom-plain-"));
  openFolder(plain);
  eq(currentRepo(), path.basename(plain), "uses the folder name");
  eq(repoRoot(), null, "no git root to operate in");
});
