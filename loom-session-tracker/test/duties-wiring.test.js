// duties-wiring.test.js — DU-001: the §19 detector is actually CALLED, and its message actually
// reaches the orchestrator's composer.
//
// WHY THIS FILE EXISTS SEPARATELY FROM duties.test.js. Every claim in duties.test.js is about a pure
// function, and all of them stay green if `runDuties()` is never wired into the tick. A detector
// nothing calls is decoration with a full test suite, and this repo has shipped that defect before:
// MOD-001 added a mutant that COMPILED AND SURVIVED until a test drove the real `activate()`.
//
// So this drives the real path end to end — activate() -> tick -> injectTo -> a fake loom_cdp.py
// that appends every injection's argv to a log — against REAL git worktrees, because `gatherWork`
// shells out to git and a fake cannot be injected through `activate()`.

const { suite, ok, eq, match, load, vscode, makeRepo, busPath, writeJson, setStatus, settle, LOOM,
        fixtureDir } = require("./harness");
const fs = require("fs");
const path = require("path");
const { execFileSync } = require("child_process");

const ext = load("extension.js");
const cdp = load("cdp.js");
const { setOrchestrator } = load("orchestrator.js");

const marker = (r) => "\nLOOMROLE=" + r + "\n";
const footer = (m = "Opus 5") => `\nRemote Control\n${m}\nMedium\nBypass permissions\n`;
const frame = (webviewId, text) => ({ webviewId, text, type: "iframe", targetUrl: "vscode-webview://x" });

const LOGGING_CDP =
  "import sys, os\n" +
  "p = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'inject-log.txt')\n" +
  "open(p, 'a').write(' '.join(sys.argv[1:]) + '\\n')\n" +
  "print(' '.join(sys.argv[1:]))\n";

const injectLog = () => {
  try { return fs.readFileSync(path.join(LOOM, "inject-log.txt"), "utf8").split("\n").filter(Boolean); }
  catch { return []; }
};
const clearInjectLog = () => { try { fs.unlinkSync(path.join(LOOM, "inject-log.txt")); } catch {} };

const git = (cwd, args) =>
  execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });

/**
 * A real repo on `main` with a worktree per role, each holding an UNCOMMITTED edit to whatever files
 * that role is given. Uncommitted on purpose: measured on this bus 2026-09-17, the other live role
 * had zero committed files and its whole block sat uncommitted, so this is the state the detector
 * must actually work in.
 */
function makeWorktrees(roles, project) {
  // A DISTINCT repo id per suite, and it is load-bearing. Every suite previously landed in a
  // directory called "proj", so all three shared one bus id — and the LATCH written by the first
  // suite silenced the two that follow. Both negative suites passed for the wrong reason: verified
  // 2026-09-17 by deleting the `isWorkingLike` filter, which left all three green. A negative test
  // that a mutant cannot turn red is not a test.
  const root = path.join(fixtureDir("loom-du-"), project);
  fs.mkdirSync(root, { recursive: true });
  git(root, ["init", "-q", "-b", "main"]);
  git(root, ["config", "user.email", "t@t"]);
  git(root, ["config", "user.name", "t"]);
  fs.mkdirSync(path.join(root, "src"), { recursive: true });
  for (const f of ["src/shared.ts", "src/only-a.ts", "src/only-b.ts", "package.json"]) {
    fs.writeFileSync(path.join(root, f), f === "package.json" ? "{}\n" : "// base\n");
  }
  git(root, ["add", "-A"]);
  git(root, ["commit", "-qm", "base"]);
  for (const [role, files] of Object.entries(roles)) {
    const wt = path.join(root, ".claude", "worktrees", role);
    git(root, ["worktree", "add", "-q", "-b", `worktree-${role}`, wt, "main"]);
    for (const f of files) fs.writeFileSync(path.join(wt, f), `// ${role} was here\n`);
  }
  return root;
}

/** Point the window at the repo root so `currentRepo()`/`repoRoot()` resolve to it. */
function openAt(root) {
  vscode.workspace.workspaceFolders = [{ uri: { fsPath: root } }];
  return path.basename(root);
}

async function activate(frames) {
  cdp.readFrames = async () => frames;
  fs.writeFileSync(path.join(LOOM, "loom_cdp.py"), LOGGING_CDP);
  const context = { subscriptions: [] };
  ext.activate(context);
  await settle();
  return () => {
    ext.deactivate();
    for (const d of context.subscriptions) { try { d.dispose && d.dispose(); } catch {} }
  };
}

/** Board + status + orchestrator tag for a two-worker bus, both WORKING. */
function bus(repo, roles, statuses) {
  writeJson(busPath(repo, "board.json"), roles);
  for (const [role, st] of Object.entries(statuses)) {
    setStatus(repo, role, { role, status: st, current: `${role.toUpperCase()}-001` });
    fs.writeFileSync(busPath(repo, role, "inbox.md"), `---\nid: ${role.toUpperCase()}-001\n---\n\nwork\n`);
  }
  fs.writeFileSync(busPath(repo, "outbox.md"), "");
}

suite("DU-001 wiring: two WORKING roles on one file reach the orchestrator's composer", async () => {
  const root = makeWorktrees({ developer1: ["src/shared.ts", "src/only-a.ts"],
                               developer2: ["src/shared.ts", "src/only-b.ts"] }, "du-both-working");
  const repo = openAt(root);
  bus(repo,
      { productowner: { branch: "main" }, developer1: { branch: "worktree-developer1" },
        developer2: { branch: "worktree-developer2" } },
      { developer1: "working", developer2: "working" });
  setOrchestrator(repo, "productowner", "wid-po");
  clearInjectLog();
  const off = await activate([frame("wid-po", "po" + marker("productowner") + footer())]);
  try {
    await settle();
    const sent = injectLog().join("\n");
    match(sent, /loom-overlap/, "the §19 reminder was actually typed — runDuties is wired into the tick");
    match(sent, /shared\.ts/, "and it names the file the two live roles share");
    ok(!/only-a\.ts/.test(sent), "not the file only one of them touched");
    ok(!/package\.json/.test(sent), "and not the manifest the bus serialises by design");
  } finally { off(); }
});

suite("DU-001 wiring: a role that is NOT working is not half of a collision", async () => {
  // A finished worker's worktree still holds its whole block until the orchestrator merges it, so
  // counting idle roles would report every pair of BANKED blocks as a live collision. This is the
  // loudest false positive available and it is excluded at the wiring, not in the pure core.
  const root = makeWorktrees({ developer1: ["src/shared.ts"], developer2: ["src/shared.ts"] },
                             "du-one-idle");
  const repo = openAt(root);
  bus(repo,
      { productowner: { branch: "main" }, developer1: { branch: "worktree-developer1" },
        developer2: { branch: "worktree-developer2" } },
      { developer1: "working", developer2: "idle" });
  setOrchestrator(repo, "productowner", "wid-po");
  clearInjectLog();
  const off = await activate([frame("wid-po", "po" + marker("productowner") + footer())]);
  try {
    await settle();
    ok(!/loom-overlap/.test(injectLog().join("\n")),
       "one working role and one idle one is not two live blocks");
  } finally { off(); }
});

suite("DU-001 wiring: two working roles on DIFFERENT files say nothing", async () => {
  const root = makeWorktrees({ developer1: ["src/only-a.ts"], developer2: ["src/only-b.ts"] },
                             "du-disjoint");
  const repo = openAt(root);
  bus(repo,
      { productowner: { branch: "main" }, developer1: { branch: "worktree-developer1" },
        developer2: { branch: "worktree-developer2" } },
      { developer1: "working", developer2: "working" });
  setOrchestrator(repo, "productowner", "wid-po");
  clearInjectLog();
  const off = await activate([frame("wid-po", "po" + marker("productowner") + footer())]);
  try {
    await settle();
    ok(!/loom-overlap/.test(injectLog().join("\n")),
       "parallel work on disjoint files is what the Loom is FOR — it must be silent");
  } finally { off(); }
});
