// gc.test.js — the cross-project garbage collector: every tier boundary, and the promise that
// nothing is ever deleted.
//
// The planner is a pure function of a world on disk, so the world is built here: a fake
// `~/.vscode-oss/extensions` tree, a fake `~/.claude/projects` tree with controlled mtimes, buses
// under the sandbox `~/.claude/loom`, and REAL temporary git repos with real worktrees (a merged
// branch and an unmerged one behave differently, and only git can tell you which is which).
//
// Every suite in this file shares one sandbox HOME, so the world ACCUMULATES across suites. Nothing
// below asserts a global total; every assertion filters the plan down to the fixture it made. That
// is also the honest shape of the thing being tested — planGc always looks at the whole machine.
const { suite, ok, eq, match, load, makeRepo, busPath, writeJson, readJson, LOOM, home } =
  require("./harness");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { execFileSync } = require("child_process");

const gc = load("gc.js");

const DAY = 86400000;
const NOW = Date.parse("2026-09-13T12:00:00Z");
// 0.33.0 ships `enabled: false` (a person runs the first pass by hand); every suite below is
// about what collection DOES, so they opt in. `gc: the shipped default is OFF` guards the default.
const CFG = { ...gc.DEFAULT_GC_CONFIG, enabled: true };

const EXT_ROOT = path.join(home, ".vscode-oss", "extensions");
const PROJECTS = path.join(home, ".claude", "projects");

function input(over = {}) {
  return { now: NOW, cfg: CFG, currentVersion: "0.33.0", liveRoles: new Set(), repoRoots: {}, ...over };
}
/** Everything the plan holds for one tier, matched by a substring of the label. */
const pick = (plan, tier, needle) => plan[`tier${tier}`].filter((i) => i.label.includes(needle));
const labels = (items) => items.map((i) => i.label).sort();

function writeAged(file, content, ageDays) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
  const t = (NOW - ageDays * DAY) / 1000;
  fs.utimesSync(file, t, t);
  return file;
}

// ── a real git repo, because "merged" is a question only git answers ────────────────────────
let gitSeq = 0;
function git(cwd, ...args) {
  return execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}
/** A repo on `main` with one commit. Returns its root. */
function makeGitRepo(name) {
  const root = path.join(home, "gitrepos", `${name}-${++gitSeq}`);
  fs.mkdirSync(root, { recursive: true });
  git(root, "init", "-q", "-b", "main");
  git(root, "config", "user.email", "t@example.com");
  git(root, "config", "user.name", "t");
  fs.writeFileSync(path.join(root, "README"), "base\n");
  git(root, "add", "-A");
  git(root, "commit", "-qm", "base");
  return root;
}
/** Add `.claude/worktrees/<role>` on its own branch. `commit` puts a commit on it (unmerged);
 *  `merge` then merges that branch back into main (so the branch becomes an ancestor). */
function addWorktree(root, role, { commit = false, merge = false, dirty = false } = {}) {
  const p = path.join(root, ".claude", "worktrees", role);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  git(root, "worktree", "add", "-q", "-b", `worktree-${role}`, p, "main");
  if (commit) {
    fs.writeFileSync(path.join(p, role + ".txt"), "work\n");
    git(p, "add", "-A");
    git(p, "commit", "-qm", `work by ${role}`);
    if (merge) git(root, "merge", "-q", "--no-ff", "-m", `merge ${role}`, `worktree-${role}`);
  }
  if (dirty) fs.writeFileSync(path.join(p, "scratch.txt"), "uncommitted\n");
  return p;
}

// ════════════════════════════════════════════════════════════════════════════════════════════
// TIER 1 — deployed extension builds
// ════════════════════════════════════════════════════════════════════════════════════════════

function deployExt(version, registeredVersion) {
  const dir = path.join(EXT_ROOT, `local.loom-session-tracker-${version}`);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "package.json"), JSON.stringify({ version }));
  if (registeredVersion !== undefined) {
    const loc = path.join(EXT_ROOT, `local.loom-session-tracker-${registeredVersion}`);
    fs.writeFileSync(path.join(EXT_ROOT, "extensions.json"), JSON.stringify([
      { identifier: { id: "other.thing" }, version: "1.0.0" },
      { identifier: { id: "local.loom-session-tracker" }, version: registeredVersion,
        location: { fsPath: loc, path: loc } },
    ]));
  }
  return dir;
}

/** Extension labels this suite planted, ignoring any another test file left in a shared HOME.
 *  `LOOM_TEST_JOBS=1` — which is what test/mutation.py uses inside every mutant — runs every file in
 *  ONE sandbox, so an assertion on the whole extensions directory is an assertion about other files. */
const mine = (plan, prefix) =>
  plan.tier1.filter((i) => i.kind === "extension" && i.label.startsWith(prefix)).map((i) => i.label).sort();

suite("gc tier 1: every deployed build except the running one and the registered one", () => {
  runningVersionsFile({});          // R1: with no stamp file at all, the whole tier is refused
  deployExt("9.30.0");
  deployExt("9.31.0");
  deployExt("9.32.0");
  deployExt("9.33.0", "9.32.0");            // running 9.33.0, editor still has 9.32.0 registered
  const plan = gc.planGc(input({ currentVersion: "9.33.0" }));
  eq(mine(plan, "9.3"), ["9.30.0", "9.31.0"],
     "the running build and the registered build are both kept; the rest are collectable");
  const one = plan.tier1.find((i) => i.kind === "extension" && i.label === "9.30.0");
  match(one.dest, /_archive\/2026-09-13\/extensions\/local\.loom-session-tracker-9\.30\.0$/,
        "archived under the dated archive, never deleted");
});

suite("gc tier 1: an unreadable extensions.json collects NO build", () => {
  deployExt("9.40.0");
  fs.writeFileSync(path.join(EXT_ROOT, "extensions.json"), "{ not json");
  try {
    const plan = gc.planGc(input({ currentVersion: "9.33.0" }));
    eq(plan.tier1.filter((i) => i.kind === "extension").length, 0,
       "without knowing which build the editor loads, uninstalling one out from under it is the risk");
    ok(plan.notes.some((n) => /extensions\.json unreadable/.test(n)), "and it says why");
  } finally { deployExt("9.33.0", "9.33.0"); }     // restore a readable registration for later suites
});

// ════════════════════════════════════════════════════════════════════════════════════════════
// TIER 1 — transcripts
// ════════════════════════════════════════════════════════════════════════════════════════════

suite("gc tier 1: an old transcript no bus references is collectable", () => {
  const dir = "-home-t-projA";
  writeAged(path.join(PROJECTS, dir, "aaaaaaaa-old.jsonl"), "{}\n", 40);
  writeAged(path.join(PROJECTS, dir, "newest00-new.jsonl"), "{}\n", 1);
  const plan = gc.planGc(input());
  eq(labels(pick(plan, 1, "aaaaaaaa")), [`${dir}/aaaaaaaa`], "old and unreferenced -> tier 1");
  eq(pick(plan, 1, "newest00").length, 0, "and the young one is not touched");
});

suite("gc tier 1: the NEWEST transcript in a project dir is never collected, however old", () => {
  const dir = "-home-t-projStale";
  writeAged(path.join(PROJECTS, dir, "older000-x.jsonl"), "{}\n", 90);
  writeAged(path.join(PROJECTS, dir, "newest11-x.jsonl"), "{}\n", 60);
  const plan = gc.planGc(input());
  eq(labels(pick(plan, 1, dir)), [`${dir}/older000`],
     "the freshest file in a directory IS that project's session — archiving it loses the /clear trail");
});

suite("gc tier 1: a transcript a board still names is kept whatever its age", () => {
  const repo = makeRepo({ roles: { dev: { session_id: "boardref-1111" } } }, "gcRefBoard");
  const dir = "-home-t-projRef";
  writeAged(path.join(PROJECTS, dir, "boardref-1111.jsonl"), "{}\n", 90);
  writeAged(path.join(PROJECTS, dir, "zzzzzzzz-new.jsonl"), "{}\n", 0);
  const plan = gc.planGc(input());
  eq(pick(plan, 1, "boardref").length, 0, `${repo}'s board still points at it`);
});

suite("gc tier 1: a transcript a context-state names is kept whatever its age", () => {
  const repo = makeRepo({ roles: {} }, "gcRefCtx");
  writeJson(busPath(repo, "context-state.json"), { phase: "watch", sessionId: "ctxref-2222" });
  const dir = "-home-t-projCtx";
  writeAged(path.join(PROJECTS, dir, "ctxref-2222.jsonl"), "{}\n", 90);
  writeAged(path.join(PROJECTS, dir, "zzzzzzzz-new.jsonl"), "{}\n", 0);
  const plan = gc.planGc(input());
  eq(pick(plan, 1, "ctxref").length, 0, "the context cycle's own record of the session counts as a reference");
});

suite("gc tier 1: a session's subagents move WITH it, and a live session's are never touched", () => {
  const dir = "-home-t-projSub";
  writeAged(path.join(PROJECTS, dir, "deadses1-x.jsonl"), "{}\n", 40);
  writeAged(path.join(PROJECTS, dir, "deadses1-x", "subagents", "s1.jsonl"), "{}\n", 40);
  // a LIVE session in the same dir: referenced by a board, and the newest file there
  const repo = makeRepo({ roles: { dev: { session_id: "livesess-9" } } }, "gcSub");
  writeAged(path.join(PROJECTS, dir, "livesess-9.jsonl"), "{}\n", 0);
  writeAged(path.join(PROJECTS, dir, "livesess-9", "subagents", "s2.jsonl"), "{}\n", 0);
  const plan = gc.planGc(input());
  eq(labels(pick(plan, 1, dir)), [`${dir}/deadses1`, `${dir}/deadses1/subagents`],
     "the dead session and its subagent tree; nothing of the live one");
  ok(!plan.tier1.some((i) => String(i.src).includes("livesess-9")),
     `${repo}'s live session keeps its subagents`);
});

// ════════════════════════════════════════════════════════════════════════════════════════════
// TIER 1 — backup files
// ════════════════════════════════════════════════════════════════════════════════════════════

suite("gc tier 1: old .bak-<epoch> files are archived and fresh ones are left", () => {
  const oldEpoch = Math.floor((NOW - 30 * DAY) / 1000);
  const newEpoch = Math.floor((NOW - 1 * DAY) / 1000);
  writeAged(path.join(LOOM, `ring.py.bak-${oldEpoch}`), "old\n", 30);
  writeAged(path.join(LOOM, `ring.py.bak-${newEpoch}`), "new\n", 1);
  const plan = gc.planGc(input());
  eq(labels(pick(plan, 1, "ring.py.bak")), [`ring.py.bak-${oldEpoch}`], "only the one past gcBackupDays");
});

suite("gc tier 1: the epoch in a backup's NAME outranks a refreshed mtime", () => {
  const oldEpoch = Math.floor((NOW - 30 * DAY) / 1000);
  // copied yesterday, so its mtime is young — but it is still a 30-day-old backup
  writeAged(path.join(LOOM, `copied.py.bak-${oldEpoch}`), "x\n", 1);
  const plan = gc.planGc(input());
  eq(labels(pick(plan, 1, "copied.py.bak")), [`copied.py.bak-${oldEpoch}`],
     "a re-copied backup is judged by when it was taken, not when it was copied");
});

// ════════════════════════════════════════════════════════════════════════════════════════════
// TIER 2 / TIER 3 — worktrees
// ════════════════════════════════════════════════════════════════════════════════════════════

suite("gc tier 2: an orphaned, clean, MERGED worktree is collectable", () => {
  const repo = makeRepo({ roles: { onboard: {} } }, "gcWtA");
  const root = makeGitRepo("wtA");
  addWorktree(root, "gone", { commit: true, merge: true });
  const plan = gc.planGc(input({ repoRoots: { [repo]: root } }));
  eq(labels(pick(plan, 2, `${repo}/gone`)), [`${repo}/gone`], "no board role, clean, fully merged");
  eq(pick(plan, 3, `${repo}/gone`).length, 0, "so it is not a question for a person");
});

suite("gc tier 2: a worktree whose role IS on the board is never planned at all", () => {
  const repo = makeRepo({ roles: { onboard: {} } }, "gcWtB");
  const root = makeGitRepo("wtB");
  addWorktree(root, "onboard", { commit: true, merge: true });
  const plan = gc.planGc(input({ repoRoots: { [repo]: root } }));
  eq(pick(plan, 2, `${repo}/onboard`).length, 0, "a rostered role's worktree is its working directory");
  eq(pick(plan, 3, `${repo}/onboard`).length, 0, "and it is not even a question");
});

suite("gc tier 3: an UNMERGED orphan worktree is a question, never an action", () => {
  const repo = makeRepo({ roles: {} }, "gcWtC");
  const root = makeGitRepo("wtC");
  addWorktree(root, "ahead", { commit: true });        // committed, never merged
  const plan = gc.planGc(input({ repoRoots: { [repo]: root } }));
  eq(pick(plan, 2, `${repo}/ahead`).length, 0, "removing it would strand a commit");
  match(pick(plan, 3, `${repo}/ahead`)[0].detail, /unmerged/, "and the reason is named");
});

suite("gc tier 3: a DIRTY orphan worktree is a question, never an action", () => {
  const repo = makeRepo({ roles: {} }, "gcWtD");
  const root = makeGitRepo("wtD");
  addWorktree(root, "messy", { commit: true, merge: true, dirty: true });
  const plan = gc.planGc(input({ repoRoots: { [repo]: root } }));
  eq(pick(plan, 2, `${repo}/messy`).length, 0, "uncommitted work is not garbage");
  match(pick(plan, 3, `${repo}/messy`)[0].detail, /uncommitted work/, "and the reason is named");
});

suite("gc tier 3: an orphan worktree backing a LIVE session is a question, never an action", () => {
  const repo = makeRepo({ roles: {} }, "gcWtE");
  const root = makeGitRepo("wtE");
  addWorktree(root, "busy", { commit: true, merge: true });
  const plan = gc.planGc(input({ repoRoots: { [repo]: root }, liveRoles: new Set([`${repo}/busy`]) }));
  eq(pick(plan, 2, `${repo}/busy`).length, 0, "removing it would pull the floor out from under a running session");
  match(pick(plan, 3, `${repo}/busy`)[0].detail, /LIVE session/, "and the reason is named");
});

suite("gc: a project with no checkout in this window has no worktrees considered", () => {
  const repo = makeRepo({ roles: {} }, "gcWtF");
  const root = makeGitRepo("wtF");
  addWorktree(root, "elsewhere", { commit: true, merge: true });
  const plan = gc.planGc(input({ repoRoots: {} }));
  eq(pick(plan, 2, `${repo}/elsewhere`).length + pick(plan, 3, `${repo}/elsewhere`).length, 0,
     "no root, no opinion — the safe direction");
});

// ════════════════════════════════════════════════════════════════════════════════════════════
// TIER 2 — board entries naming a session that exists nowhere
// ════════════════════════════════════════════════════════════════════════════════════════════

suite("gc tier 2: a board entry whose session has no transcript is marked, not removed", () => {
  const repo = makeRepo({ roles: { ghost: { session_id: "nowhere-1234", status: "idle" } } }, "gcBoardA");
  const plan = gc.planGc(input());
  const item = pick(plan, 2, `${repo}/ghost`)[0];
  ok(item, "planned");
  match(item.detail, /no transcript anywhere — mark "dead"/, "the entry stays; only its status changes");
});

suite("gc tier 2: an OWNER role's board entry is never marked dead", () => {
  const repo = makeRepo({ roles: { productowner: { session_id: "nowhere-5678" } } }, "gcBoardB");
  const plan = gc.planGc(input());
  eq(pick(plan, 2, `${repo}/productowner`).length, 0,
     "the owner entry is what re-finds the orchestrator after a /clear — a person repairs that one");
});

suite("gc tier 2: a LIVE role's board entry is never marked dead", () => {
  const repo = makeRepo({ roles: { fresh: { session_id: "nowhere-9999" } } }, "gcBoardC");
  const plan = gc.planGc(input({ liveRoles: new Set([`${repo}/fresh`]) }));
  eq(pick(plan, 2, `${repo}/fresh`).length, 0,
     "a fresh session's board id lags its transcript by seconds; live is never dead");
});

suite("gc tier 2: an entry whose transcript exists is left alone", () => {
  const repo = makeRepo({ roles: { real: { session_id: "hastrans-4444" } } }, "gcBoardD");
  writeAged(path.join(PROJECTS, "-home-t-projHas", "hastrans-4444.jsonl"), "{}\n", 0);
  const plan = gc.planGc(input());
  eq(pick(plan, 2, `${repo}/real`).length, 0, "nothing to say about it");
});

suite("gc tier 2: an entry already marked dead is not re-planned", () => {
  const repo = makeRepo({ roles: { ghost: { session_id: "nowhere-0001", status: "dead" } } }, "gcBoardE");
  const plan = gc.planGc(input());
  eq(pick(plan, 2, `${repo}/ghost`).length, 0, "idempotent — a second pass finds nothing to do");
});

// ════════════════════════════════════════════════════════════════════════════════════════════
// TIER 3 — buses
// ════════════════════════════════════════════════════════════════════════════════════════════

suite("gc tier 3: a bus nobody has touched for staleBusDays is a question", () => {
  const repo = makeRepo({ roles: {} }, "gcStaleBus");
  const t = (NOW - 200 * DAY) / 1000;
  fs.utimesSync(busPath(repo, "board.json"), t, t);
  const plan = gc.planGc(input());
  const item = pick(plan, 3, repo).find((i) => i.kind === "staleBus");
  ok(item, "listed");
  match(item.detail, /untouched for 200d/, "with its age");
  eq(plan.tier1.filter((i) => i.repo === repo).length + plan.tier2.filter((i) => i.repo === repo).length, 0,
     "and nothing acts on a whole bus automatically");
});

// ════════════════════════════════════════════════════════════════════════════════════════════
// THE EMPTY PLAN
// ════════════════════════════════════════════════════════════════════════════════════════════

suite("gc: an empty world produces an empty plan", () => {
  // Several modules resolve LOOM_ROOT from os.homedir() at LOAD time, so a pristine world means a
  // pristine process. This is what the runner itself does for every test file (run-tests.js).
  const empty = fs.mkdtempSync(path.join(os.tmpdir(), "loom-gc-empty-"));
  const script = path.join(empty, "probe.js");
  fs.writeFileSync(script, `
    const gc = require(${JSON.stringify(path.join(__dirname, "..", "out", "gc.js"))});
    const plan = gc.planGc({ now: ${NOW}, cfg: gc.DEFAULT_GC_CONFIG, currentVersion: "0.33.0",
                             liveRoles: new Set(), repoRoots: {} });
    console.log(JSON.stringify({ n: [plan.tier1.length, plan.tier2.length, plan.tier3.length],
                                 render: gc.renderGc(plan), summary: gc.gcSummary(plan) }));
  `);
  const r = execFileSync(process.execPath, [script],
    { encoding: "utf8", env: { ...process.env, HOME: empty, ELECTRON_RUN_AS_NODE: "1" } });
  const out = JSON.parse(r.trim().split("\n").pop());
  eq(out.n, [0, 0, 0], "nothing anywhere");
  eq(out.render, "", "and the digest shows no gc section at all");
  match(out.summary, /tier1 0 .* tier2 0 .* tier3 0/, "the one-liner still reports honestly");
});

suite("gc: applying an empty plan does nothing and says nothing", () => {
  const r = gc.applyGc({ date: "2026-09-13", tier1: [], tier2: [], tier3: [], notes: [] }, [1, 2]);
  eq([r.done.length, r.skipped.length, r.bytesFreed], [0, 0, 0], "a no-op is a clean no-op");
});

// ════════════════════════════════════════════════════════════════════════════════════════════
// THE APPLIER
// ════════════════════════════════════════════════════════════════════════════════════════════

suite("gc apply: a collected file is MOVED — archive holds it, the original is gone, bytes identical", () => {
  const dir = "-home-t-applyMove";
  const src = writeAged(path.join(PROJECTS, dir, "movedses-1.jsonl"), "the contents\n", 40);
  writeAged(path.join(PROJECTS, dir, "keepnew0-1.jsonl"), "{}\n", 0);
  const plan = gc.planGc(input());
  const item = pick(plan, 1, "movedses")[0];
  ok(item, "planned");
  const only = { ...plan, tier1: [item], tier2: [], tier3: [] };
  const r = gc.applyGc(only, [1]);
  eq(r.skipped.length, 0, "nothing refused");
  eq(r.done.length, 1, "one item collected");
  ok(!fs.existsSync(src), "the original is gone from the projects dir");
  ok(fs.existsSync(item.dest), "and it is in the archive");
  eq(fs.readFileSync(item.dest, "utf8"), "the contents\n", "byte-for-byte, so it can be moved back");
});

suite("gc apply: an unwritable archive SKIPS the item and reports it — never throws, never deletes", () => {
  const dir = "-home-t-applyRO";
  const src = writeAged(path.join(PROJECTS, dir, "rofile00-1.jsonl"), "precious\n", 40);
  writeAged(path.join(PROJECTS, dir, "keepnew0-2.jsonl"), "{}\n", 0);
  const plan = gc.planGc(input());
  const item = pick(plan, 1, "rofile00")[0];
  const only = { ...plan, tier1: [item], tier2: [], tier3: [] };
  // The exact destination directory exists but cannot be written into.
  const destDir = path.dirname(item.dest);
  fs.mkdirSync(destDir, { recursive: true });
  fs.chmodSync(destDir, 0o500);
  let r;
  try { r = gc.applyGc(only, [1]); } finally { fs.chmodSync(destDir, 0o700); }
  eq(r.done.length, 0, "nothing was collected");
  eq(r.skipped.length, 1, "and the item is reported, not swallowed");
  match(r.skipped[0].note, /archive dir not/, "with the reason");
  eq(fs.readFileSync(src, "utf8"), "precious\n", "the original is untouched — a failed move never deletes");
});

suite("gc apply: tier 3 is never acted on, even when it is asked for", () => {
  const repo = makeRepo({ roles: {} }, "gcApplyT3");
  const root = makeGitRepo("applyT3");
  const wt = addWorktree(root, "ahead", { commit: true });
  const plan = gc.planGc(input({ repoRoots: { [repo]: root } }));
  ok(pick(plan, 3, `${repo}/ahead`).length, "it is in tier 3");
  const r = gc.applyGc(plan, [1, 2, 3], { repoRoots: { [repo]: root } });
  eq(r.tiers, [1, 2], "tier 3 is filtered out of the request itself");
  ok(fs.existsSync(wt), "the unmerged worktree is still there");
});

suite("gc apply: a dead board entry is MARKED, and the entry itself survives", () => {
  const repo = makeRepo({ roles: { ghost: { session_id: "nowhere-2222", branch: "worktree-ghost" } } }, "gcApplyBoard");
  const plan = gc.planGc(input());
  const item = pick(plan, 2, `${repo}/ghost`)[0];
  ok(item, "planned");
  const r = gc.applyGc({ ...plan, tier1: [], tier2: [item], tier3: [] }, [2]);
  eq(r.skipped.length, 0, "applied");
  const board = readJson(busPath(repo, "board.json"));
  eq(board.roles.ghost.status, "dead", "marked");
  eq(board.roles.ghost.gc_note, "2026-09-13: session_id has no transcript", "with a dated note saying why");
  eq(board.roles.ghost.session_id, "nowhere-2222", "the id is KEPT — this is a label, not a deletion");
  eq(board.roles.ghost.branch, "worktree-ghost", "and so is everything else on the entry");
});

suite("gc apply: a merged orphan worktree is removed and its BRANCH is kept", () => {
  const repo = makeRepo({ roles: {} }, "gcApplyWt");
  const root = makeGitRepo("applyWt");
  const wt = addWorktree(root, "done", { commit: true, merge: true });
  const plan = gc.planGc(input({ repoRoots: { [repo]: root } }));
  const item = pick(plan, 2, `${repo}/done`)[0];
  ok(item, "planned");
  const r = gc.applyGc({ ...plan, tier1: [], tier2: [item], tier3: [] }, [2], { repoRoots: { [repo]: root } });
  eq(r.skipped.length, 0, r.skipped.map((s) => s.note).join("; "));
  ok(!fs.existsSync(wt), "the directory is gone");
  ok(git(root, "rev-parse", "--verify", "worktree-done"), "the branch and its commits are still there");
});

suite("gc apply: a worktree that went dirty since the plan was made is refused", () => {
  const repo = makeRepo({ roles: {} }, "gcApplyRace");
  const root = makeGitRepo("applyRace");
  const wt = addWorktree(root, "raced", { commit: true, merge: true });
  const plan = gc.planGc(input({ repoRoots: { [repo]: root } }));
  const item = pick(plan, 2, `${repo}/raced`)[0];
  ok(item, "planned while clean");
  fs.writeFileSync(path.join(wt, "late.txt"), "started working again\n");   // the session came back
  const r = gc.applyGc({ ...plan, tier1: [], tier2: [item], tier3: [] }, [2], { repoRoots: { [repo]: root } });
  eq(r.done.length, 0, "nothing removed");
  match(r.skipped[0].note, /uncommitted work/, "the applier re-checks rather than trusting a minutes-old plan");
  ok(fs.existsSync(wt), "and the directory is still there");
});

suite("gc apply: every action is written to gc-debug.json with its way back", () => {
  const dir = "-home-t-applyLog";
  writeAged(path.join(PROJECTS, dir, "loggedse-1.jsonl"), "x\n", 40);
  writeAged(path.join(PROJECTS, dir, "keepnew0-3.jsonl"), "{}\n", 0);
  const plan = gc.planGc(input());
  const item = pick(plan, 1, "loggedse")[0];
  gc.applyGc({ ...plan, tier1: [item], tier2: [], tier3: [] }, [1]);
  const log = readJson(path.join(LOOM, "gc-debug.json"));
  ok(Array.isArray(log) && log.length, "the log exists");
  const last = log[log.length - 1];
  ok(last.done.some((d) => d.src === item.src && d.dest === item.dest),
     "and it records exactly where the thing went");
});

// ════════════════════════════════════════════════════════════════════════════════════════════
// THE CROSS-WINDOW LEASE
// ════════════════════════════════════════════════════════════════════════════════════════════

suite("gc lease: the first pass on a machine runs", () => {
  const d = gc.dueForAuto({}, "winA", NOW, CFG);
  ok(d.run, "nothing has ever run");
  eq(d.next.owner, "winA", "and this window claims it before doing any work");
  eq(d.next.ownerAt, NOW, "with a timestamp the lease is judged by");
});

suite("gc lease: a second window does NOT run while the first holds the lease", () => {
  const held = { owner: "winA", ownerAt: NOW - 60_000 };
  const d = gc.dueForAuto(held, "winB", NOW, CFG);
  ok(!d.run, "one collector per machine — seven windows must not race over the same files");
  match(d.note, /another window is running this pass/, "and it says so");
  eq(d.next, held, "the other window's claim is left exactly as it was");
});

suite("gc lease: a STALE lease is taken over — a closed window must not block collection forever", () => {
  const abandoned = { owner: "winA", ownerAt: NOW - (gc.LEASE_MS + 1000) };
  const d = gc.dueForAuto(abandoned, "winB", NOW, CFG);
  ok(d.run, "the holder is gone");
  eq(d.next.owner, "winB", "and the new window takes the claim");
});

suite("gc lease: the same window does not re-run inside the interval", () => {
  const d = gc.dueForAuto({ lastRunAt: NOW - 3 * 3_600_000 }, "winA", NOW, { ...CFG, intervalHours: 24 });
  ok(!d.run, "3h into a 24h interval");
  match(d.note, /last run 3\.0h ago; every 24h/, "and it says how long is left to wait");
});

suite("gc lease: the interval expiring makes it due again", () => {
  const d = gc.dueForAuto({ lastRunAt: NOW - 25 * 3_600_000 }, "winA", NOW, { ...CFG, intervalHours: 24 });
  ok(d.run, "25h into a 24h interval");
});

suite("gc lease: disabled means never, whatever the state says", () => {
  const d = gc.dueForAuto({}, "winA", NOW, { ...CFG, enabled: false });
  ok(!d.run, "gcEnabled=false is absolute");
  eq(d.next.owner, undefined, "and no claim is taken");
});

suite("gc lease: finishing releases the claim and records the outcome", () => {
  const claimed = { owner: "winA", ownerAt: NOW };
  const next = gc.finishAuto(claimed, NOW + 5000,
    { date: "2026-09-13", done: [1, 2], skipped: [], bytesFreed: 1234 }, "tier 1: 2 collected");
  eq(next.owner, undefined, "released, so a crashed follow-up cannot deadlock the next pass");
  eq(next.lastRunAt, NOW + 5000, "and the interval starts from now");
  eq(next.lastResult, { date: "2026-09-13", done: 2, skipped: 0, bytesFreed: 1234 }, "with what it did");
});

suite("gc lease: state survives a round trip through the bus", () => {
  ok(gc.saveGcState({ lastRunAt: NOW, lastNote: "tier 1: 3 collected" }), "written");
  const back = gc.loadGcState();
  eq(back.lastRunAt, NOW, "and read back");
  eq(back.lastNote, "tier 1: 3 collected", "with its note");
});

// ════════════════════════════════════════════════════════════════════════════════════════════
// GC-002 HARDENING — each of these is a way the first version could have destroyed something
// ════════════════════════════════════════════════════════════════════════════════════════════

suite("gc: the shipped default is OFF", () => {
  eq(gc.DEFAULT_GC_CONFIG.enabled, false,
     "0.33.0 ships off on purpose — the first pass on this machine moves ~700 MB unattended");
});

// ── S1 · a build a window is still RUNNING is never archived ────────────────────────────────

function runningVersionsFile(map) {
  writeJson(path.join(LOOM, "running-versions.json"), map);
}

suite("gc S1: a build nine windows are still RUNNING is never archived", () => {
  deployExt("8.10.0");
  deployExt("8.29.0");
  deployExt("8.32.0", "8.32.0");
  // exactly the measured state: the registry says 8.32.0, the windows are on 8.29.0
  runningVersionsFile({
    AgAI: { version: "8.29.0", at: new Date(NOW - 3600000).toISOString() },
    funisland: { version: "8.29.0", at: new Date(NOW - 1800000).toISOString() },
  });
  const plan = gc.planGc(input({ currentVersion: "8.32.0" }));
  eq(mine(plan, "8."), ["8.10.0"],
     "8.29.0 is kept — an editor keeps the code it loaded until it is reloaded");
});

suite("gc S1: a running-versions stamp older than the interval no longer protects a build", () => {
  deployExt("8.40.0");
  deployExt("8.41.0", "8.41.0");
  runningVersionsFile({ ghost: { version: "8.40.0", at: new Date(NOW - 40 * 3600000).toISOString() } });
  const plan = gc.planGc(input({ currentVersion: "8.41.0", cfg: { ...CFG, intervalHours: 24 } }));
  ok(mine(plan, "8.40").length, "a stamp 40h old in a 24h interval is a window that is gone");
});

// This suite used to assert the opposite — "an unparseable date is not evidence that the window is
// gone", so the entry was kept. True, and it has no end to it: nothing ever ages such an entry out,
// so one damaged entry pinned its version in the keep-set for the life of the file and that build
// became permanently uncollectable. GC-006 R3 bounds it in the one direction that is bounded.
suite("gc R3: a stamp entry with an unreadable timestamp does not protect its build for ever", () => {
  deployExt("8.50.0");
  deployExt("8.51.0", "8.51.0");
  runningVersionsFile({ odd: { version: "8.50.0", at: "not a date" } });
  const plan = gc.planGc(input({ currentVersion: "8.51.0" }));
  eq(mine(plan, "8.50"), ["8.50.0"],
     "an entry that cannot say WHEN it was written can never age out, and a keep-set entry with no " +
     "expiry is permanent — any window actually on that build re-stamps within 15 seconds");
});

suite("gc R3: dropping one undated entry does not touch the dated ones beside it", () => {
  deployExt("8.52.0");
  deployExt("8.53.0");
  deployExt("8.54.0", "8.54.0");
  runningVersionsFile({
    broken: { version: "8.52.0", at: "not a date" },
    real: { version: "8.53.0", at: new Date(NOW - 60000).toISOString() },
  });
  const plan = gc.planGc(input({ currentVersion: "8.54.0" }));
  eq(mine(plan, "8.53"), [], "the window that said when it stamped is still protected");
  eq(mine(plan, "8.52"), ["8.52.0"], "and only the undated one is offered");
  eq(gc.runningVersions(NOW, 86400000).readable, true,
     "a parseable FILE stays readable — this is not the torn-file refusal, which needs the whole tier");
});

suite("gc S1: a non-semver current version refuses the whole extension tier", () => {
  deployExt("8.60.0");
  deployExt("8.61.0", "8.61.0");
  runningVersionsFile({});
  const plan = gc.planGc(input({ currentVersion: "unknown" }));
  eq(plan.tier1.filter((i) => i.kind === "extension").length, 0,
     'VERSION is "unknown" whenever package.json could not be read — that must not mean "keep nothing"');
  ok(plan.notes.some((n) => /not a semver/.test(n)), "and it says why");
});

// ── S5 · every registered entry is kept, not the last ───────────────────────────────────────

suite("gc S5: extensions.json registering the same id twice keeps BOTH builds", () => {
  deployExt("8.70.0");
  deployExt("8.71.0");
  deployExt("8.72.0");
  const loc = (v) => path.join(EXT_ROOT, `local.loom-session-tracker-${v}`);
  fs.writeFileSync(path.join(EXT_ROOT, "extensions.json"), JSON.stringify([
    { identifier: { id: "local.loom-session-tracker" }, version: "8.70.0",
      location: { fsPath: loc("8.70.0"), path: loc("8.70.0") } },
    { identifier: { id: "local.loom-session-tracker" }, version: "8.71.0",
      location: { fsPath: loc("8.71.0"), path: loc("8.71.0") } },
  ]));
  runningVersionsFile({});
  const plan = gc.planGc(input({ currentVersion: "8.72.0" }));
  eq(mine(plan, "8.7"), [], "both registrations are honoured; only the current build is left over");
});

// ── S3 · a LIVE role's transcript is never archived ─────────────────────────────────────────

suite("gc S3: a LIVE role's transcript is never archived, however old", () => {
  const repo = makeRepo({ roles: { dev: { session_id: "livetran-0001" } } }, "gcLiveTran");
  const dir = "-home-t-projLive";
  writeAged(path.join(PROJECTS, dir, "livetran-0001.jsonl"), "{}\\n", 200);
  writeAged(path.join(PROJECTS, dir, "zzzzzzzz-lv.jsonl"), "{}\\n", 0);
  const plan = gc.planGc(input({ liveRoles: new Set([`${repo}/dev`]) }));
  eq(pick(plan, 1, "livetran").length, 0,
     "an orchestrator idle for weeks still has its tab open; its transcript is the only thing reopen can use");
});

suite("gc S3: a LIVE role's transcript is kept even when its id is only in status.json", () => {
  const repo = makeRepo({ roles: { dev: {} } }, "gcLiveStatus");
  writeJson(busPath(repo, "dev", "status.json"), { status: "working", session_id: "statonly-0002" });
  const dir = "-home-t-projLiveS";
  writeAged(path.join(PROJECTS, dir, "statonly-0002.jsonl"), "{}\\n", 200);
  writeAged(path.join(PROJECTS, dir, "zzzzzzzz-ls.jsonl"), "{}\\n", 0);
  const plan = gc.planGc(input({ liveRoles: new Set([`${repo}/dev`]) }));
  eq(pick(plan, 1, "statonly").length, 0, "the board never learned the id; the role's own status did");
});

suite("gc S3: a bus with NO board.json still protects the session it names", () => {
  // AgAI, Personality, growth-chamber and aneeshpanoli.com are exactly this shape.
  const repo = "gcNoBoard";
  writeJson(path.join(LOOM, repo, "context-state.json"), { phase: "watch", sessionId: "noboard1-0003" });
  ok(!fs.existsSync(path.join(LOOM, repo, "board.json")), "the fixture really has no board");
  const dir = "-home-t-projNoBoard";
  writeAged(path.join(PROJECTS, dir, "noboard1-0003.jsonl"), "{}\\n", 200);
  writeAged(path.join(PROJECTS, dir, "zzzzzzzz-nb.jsonl"), "{}\\n", 0);
  const plan = gc.planGc(input());
  eq(pick(plan, 1, "noboard1").length, 0,
     "busRepos() requires a board.json; garbage collection must not — loomDirs() sees this one");
});

// ── S4 · referencedSessionIds is complete ───────────────────────────────────────────────────

suite("gc S4: a session named only in a role's status.json is referenced", () => {
  const repo = makeRepo({ roles: { worker: {} } }, "gcRefStatus");
  writeJson(busPath(repo, "worker", "status.json"), { status: "idle", session_id: "refstatu-0004" });
  const dir = "-home-t-projRefS";
  writeAged(path.join(PROJECTS, dir, "refstatu-0004.jsonl"), "{}\\n", 90);
  writeAged(path.join(PROJECTS, dir, "zzzzzzzz-rs.jsonl"), "{}\\n", 0);
  ok(gc.referencedSessions().ids.has("refstatu-0004"), "counted as a reference");
  eq(pick(gc.planGc(input()), 1, "refstatu").length, 0, "so it is not collectable");
});

suite("gc S4: a session named only in an open-requests result is referenced", () => {
  const repo = makeRepo({ roles: {} }, "gcRefOpen");
  writeJson(busPath(repo, "open-requests.json"), {
    servedAt: "2026-09-13T10:00:00Z",
    opened: [{ role: "alpha", sessionId: "refopen1-0005", from: "board" }], refused: [],
  });
  const dir = "-home-t-projRefO";
  writeAged(path.join(PROJECTS, dir, "refopen1-0005.jsonl"), "{}\\n", 90);
  writeAged(path.join(PROJECTS, dir, "zzzzzzzz-ro.jsonl"), "{}\\n", 0);
  ok(gc.referencedSessions().ids.has("refopen1-0005"), "counted as a reference");
  eq(pick(gc.planGc(input()), 1, "refopen1").length, 0, "so it is not collectable");
});

suite("gc S4: the universal sweep finds a session id mentioned in any bus .md or .json", () => {
  const repo = makeRepo({ roles: {} }, "gcRefSweep");
  const sid = "7f3a91c2-4b6d-4e8f-9a1b-2c3d4e5f6a7b";        // 36 chars, as Claude Code writes them
  fs.writeFileSync(busPath(repo, "notes.md"),
    `The developer's session is ${sid} — do not lose it.\\n`);
  const dir = "-home-t-projSweep";
  writeAged(path.join(PROJECTS, dir, sid + ".jsonl"), "{}\\n", 200);
  writeAged(path.join(PROJECTS, dir, "zzzzzzzz-sw.jsonl"), "{}\\n", 0);
  ok(gc.referencedSessions().ids.has(sid), "a prose mention in a notes file still counts");
  eq(pick(gc.planGc(input()), 1, sid.slice(0, 8)).length, 0, "so the transcript stays");
});

suite("gc S4: the collector's own log does not count as a reference", () => {
  const sid = "1a2b3c4d-5e6f-4a7b-8c9d-0e1f2a3b4c5d";
  writeJson(path.join(LOOM, "gc-debug.json"),
            [{ at: "2026-09-01T00:00:00Z", done: [{ kind: "transcript", src: `/x/${sid}.jsonl` }] }]);
  ok(!gc.referencedSessions().ids.has(sid),
     "letting our own leavings count would make the collector protect them forever");
});

// ── S2 / S6 · the applier re-checks against the world as it is NOW ───────────────────────────

suite("gc S2: a worktree that went LIVE since the plan was made is refused", () => {
  const repo = makeRepo({ roles: {} }, "gcApplyLive");
  const root = makeGitRepo("applyLive");
  const wt = addWorktree(root, "woken", { commit: true, merge: true });
  const plan = gc.planGc(input({ repoRoots: { [repo]: root } }));
  const item = pick(plan, 2, `${repo}/woken`)[0];
  ok(item, "planned while nothing was live");
  // the session came back between the plan and the click
  const r = gc.applyGc({ ...plan, tier1: [], tier2: [item], tier3: [] }, [2],
    { repoRoots: { [repo]: root }, liveRoles: new Set([`${repo}/woken`]) });
  eq(r.done.length, 0, "nothing removed");
  match(r.skipped[0].note, /LIVE session/,
        "removeWorktree's live refusal can only fire if the applier passes it the live roster");
  ok(fs.existsSync(wt), "and the working directory is still there");
});

suite("gc S2: a transcript whose session went LIVE since the plan was made is refused", () => {
  const dir = "-home-t-applyLiveTran";
  const src = writeAged(path.join(PROJECTS, dir, "wokenses-0006.jsonl"), "precious\\n", 40);
  writeAged(path.join(PROJECTS, dir, "zzzzzzzz-wt.jsonl"), "{}\\n", 0);
  const plan = gc.planGc(input());
  const item = pick(plan, 1, "wokenses")[0];
  ok(item, "planned");
  const r = gc.applyGc({ ...plan, tier1: [item], tier2: [], tier3: [] }, [1],
    { liveSessionIds: new Set(["wokenses-0006"]) });
  eq(r.done.length, 0, "nothing moved");
  match(r.skipped[0].note, /its session is LIVE now/, "and it says why");
  eq(fs.readFileSync(src, "utf8"), "precious\\n", "the transcript is untouched");
});

suite("gc S6: a board entry rebound since the plan was made is not marked dead", () => {
  const repo = makeRepo({ roles: { ghost: { session_id: "oldid000-0007" } } }, "gcApplyRebound");
  const plan = gc.planGc(input());
  const item = pick(plan, 2, `${repo}/ghost`)[0];
  ok(item, "planned against oldid000-0007");
  // a /clear happened and the extension rebound the entry (0.31.0) between plan and click
  writeJson(busPath(repo, "board.json"), { roles: { ghost: { session_id: "freshid0-0008" } } });
  const r = gc.applyGc({ ...plan, tier1: [], tier2: [item], tier3: [] }, [2]);
  eq(r.done.length, 0, "nothing marked");
  match(r.skipped[0].note, /rebound since the plan/, "and it says why");
  eq(readJson(busPath(repo, "board.json")).roles.ghost.status, undefined, "the fresh entry is untouched");
});

suite("gc S6: a board entry whose role went LIVE since the plan was made is not marked dead", () => {
  const repo = makeRepo({ roles: { ghost: { session_id: "wokeboar-0009" } } }, "gcApplyLiveBoard");
  const plan = gc.planGc(input());
  const item = pick(plan, 2, `${repo}/ghost`)[0];
  ok(item, "planned");
  const r = gc.applyGc({ ...plan, tier1: [], tier2: [item], tier3: [] }, [2],
    { liveRoles: new Set([`${repo}/ghost`]) });
  eq(r.done.length, 0, "nothing marked");
  match(r.skipped[0].note, /no longer dead/, "the live check is asked again at apply time");
});

suite("gc S6: a board entry whose transcript reappeared is not marked dead", () => {
  const repo = makeRepo({ roles: { ghost: { session_id: "camebac0-0010" } } }, "gcApplyBack");
  const plan = gc.planGc(input());
  const item = pick(plan, 2, `${repo}/ghost`)[0];
  ok(item, "planned while there was no transcript");
  writeAged(path.join(PROJECTS, "-home-t-projBack", "camebac0-0010.jsonl"), "{}\\n", 0);
  const r = gc.applyGc({ ...plan, tier1: [], tier2: [item], tier3: [] }, [2]);
  eq(r.done.length, 0, "nothing marked");
  match(r.skipped[0].note, /no longer dead/, "the transcript check is asked again too");
});

// ── S8 · a move that cannot be verified leaves nothing behind that looks good ─────────────────

suite("gc S8: a dangling symlink at the destination is a refusal, not an overwrite", () => {
  const dir = "-home-t-applySymlink";
  const src = writeAged(path.join(PROJECTS, dir, "symdest0-0011.jsonl"), "real\\n", 40);
  writeAged(path.join(PROJECTS, dir, "zzzzzzzz-sy.jsonl"), "{}\\n", 0);
  const plan = gc.planGc(input());
  const item = pick(plan, 1, "symdest0")[0];
  fs.mkdirSync(path.dirname(item.dest), { recursive: true });
  fs.symlinkSync("/nowhere/at/all", item.dest);              // statSync says "absent"; lstat does not
  const r = gc.applyGc({ ...plan, tier1: [item], tier2: [], tier3: [] }, [1]);
  eq(r.done.length, 0, "nothing moved");
  match(r.skipped[0].note, /already exists/, "somebody pointed that path somewhere on purpose");
  eq(fs.readFileSync(src, "utf8"), "real\\n", "and the original is untouched");
});

suite("gc S8: measure() reports when it ran out of budget, so a verify cannot pass on a guess", () => {
  const dir = path.join(home, "measureme");
  fs.mkdirSync(dir, { recursive: true });
  for (let i = 0; i < 12; i++) fs.writeFileSync(path.join(dir, `f${i}.txt`), "x".repeat(10));
  const full = gc.measure(dir);
  eq([full.bytes, full.truncated], [120, false], "a complete walk is complete");
  const short = gc.measure(dir, 5);
  ok(short.truncated, "and a budgeted one says its number is a lower bound");
  ok(short.bytes < full.bytes, "which it is");
});

// ── S9 · a worktree name is matched through the bus's aliases, and typos are a question ──────

suite("gc S9: a worktree named by a bus ALIAS of a real role is not garbage", () => {
  // livegita's shape: the board says `gitadeveloper`, the worktree is `developer`.
  const repo = makeRepo({ roles: { gitadeveloper: {} } }, "gcAlias");
  writeJson(busPath(repo, "naming.json"), { aliases: { developer: "gitadeveloper" } });
  const root = makeGitRepo("alias");
  addWorktree(root, "developer", { commit: true, merge: true });
  const plan = gc.planGc(input({ repoRoots: { [repo]: root } }));
  eq(pick(plan, 2, `${repo}/developer`).length, 0, "it is that role's working directory");
  eq(pick(plan, 3, `${repo}/developer`).length, 0, "and not even a question");
});

suite("gc S9: a worktree one typo away from a real role drops to tier 3, never tier 2", () => {
  // the measured case: Gaming/protyping, one letter off `prototyping`, was offered for removal.
  const repo = makeRepo({ roles: { prototyping: {} } }, "gcTypo");
  const root = makeGitRepo("typo");
  addWorktree(root, "protyping", { commit: true, merge: true });
  const plan = gc.planGc(input({ repoRoots: { [repo]: root } }));
  eq(pick(plan, 2, `${repo}/protyping`).length, 0, "a typo is not a dead worktree");
  match(pick(plan, 3, `${repo}/protyping`)[0].detail, /one typo away from the role "prototyping"/,
        "and the report names the role it looks like");
});

suite("gc S9: a genuinely unrelated orphan is still collectable", () => {
  const repo = makeRepo({ roles: { prototyping: {} } }, "gcNotTypo");
  const root = makeGitRepo("nottypo");
  addWorktree(root, "scratchpad", { commit: true, merge: true });
  const plan = gc.planGc(input({ repoRoots: { [repo]: root } }));
  eq(labels(pick(plan, 2, `${repo}/scratchpad`)), [`${repo}/scratchpad`],
     "the typo guard must not swallow real garbage");
});

// ── S7 · the lease survives a long pass and a moved clock ────────────────────────────────────

suite("gc S7 lease: a claim in the FUTURE is treated as expired, not as fresh", () => {
  const skewed = { owner: "winA", ownerAt: NOW + 60 * 60000 };
  const d = gc.dueForAuto(skewed, "winB", NOW, CFG);
  ok(d.run, "a clock step must not create a lease nothing can ever break");
  eq(d.next.owner, "winB", "and the new window takes it");
});

suite("gc S7 lease: a lastRunAt in the FUTURE is treated as due, not as never", () => {
  const skewed = { lastRunAt: NOW + 100 * 3600000 };
  const d = gc.dueForAuto(skewed, "winA", NOW, CFG);
  ok(d.run, "an interval that can never elapse fails closed and silently");
  match(d.note, /clock skew/, "and it says what it thinks happened");
});

suite("gc S7 lease: a long pass refreshes its own claim at half-life", () => {
  const fresh = { owner: "winA", ownerAt: NOW };
  eq(gc.refreshLease(fresh, "winA", NOW + 1000), null, "nothing to do so early");
  const aging = gc.refreshLease(fresh, "winA", NOW + gc.LEASE_MS / 2 + 1000);
  ok(aging, "past half-life it is rewritten");
  eq(aging.ownerAt, NOW + gc.LEASE_MS / 2 + 1000, "with the current time");
  eq(gc.refreshLease({ owner: "winB", ownerAt: NOW }, "winA", NOW + gc.LEASE_MS), null,
     "and a window never refreshes a claim that is not its own");
});

suite("gc S8: a copy is only trusted when BOTH measurements are complete and equal", () => {
  const c = (bytes) => ({ bytes, truncated: false });
  const t = (bytes) => ({ bytes, truncated: true });
  eq(gc.verifyCopy(c(100), c(100)), null, "same size, both walks complete — trusted");
  match(gc.verifyCopy(c(100), c(90)), /verify mismatch/, "a short copy is caught");
  match(gc.verifyCopy(t(100), c(100)), /too large to verify/,
        "two lower bounds that happen to match is agreement about nothing");
  match(gc.verifyCopy(c(100), t(100)), /too large to verify/, "either side is enough to refuse");
});

suite("gc S3: a LIVE role's transcript survives even when its bus is not one loomDirs() scans", () => {
  // WHY THIS SHAPE. The planner's live-session check sits behind the reference sweep, and the sweep
  // already reads the same board.json and status.json that the live ids come from — so for an
  // ordinary bus the check is belt-and-braces and a mutation of it survives. It is load-bearing in
  // exactly one place: a directory under the loom root that `loomDirs()` refuses to treat as a bus
  // (`_archive`, `node_modules`, `tools`, `__pycache__` — and `~/.claude/loom/tools/` really exists).
  // Nothing there is swept, so the live roster is the only thing standing between a running session
  // and having its transcript archived. This test pins that, and keeps the guard falsifiable.
  const repo = "tools";
  writeJson(path.join(LOOM, repo, "board.json"), { roles: { dev: { session_id: "toolsdev-0012" } } });
  ok(!gc.loomDirs().includes(repo), "the fixture bus really is one loomDirs() skips");
  ok(!gc.referencedSessions().ids.has("toolsdev-0012"), "so nothing there counts as a reference");
  const dir = "-home-t-projTools";
  writeAged(path.join(PROJECTS, dir, "toolsdev-0012.jsonl"), "{}\n", 200);
  writeAged(path.join(PROJECTS, dir, "zzzzzzzz-tl.jsonl"), "{}\n", 0);

  eq(pick(gc.planGc(input()), 1, "toolsdev").length, 1,
     "with no live role it IS collectable — which is what makes the next assertion mean something");
  eq(pick(gc.planGc(input({ liveRoles: new Set([`${repo}/dev`]) })), 1, "toolsdev").length, 0,
     "and the live roster alone keeps it");
});

// ════════════════════════════════════════════════════════════════════════════════════════════
// GC-004 — the second review: the DATA the collector is fed defeated its safeguards
// ════════════════════════════════════════════════════════════════════════════════════════════
// Every hole below is the same shape: a read that could not answer returned "nothing" instead of
// "I do not know", and every guard downstream reads "nothing" as permission.

// ── R1 · an unreadable running-versions.json refuses the whole extension tier ────────────────

suite("gc R1: a TORN running-versions.json collects no build at all", () => {
  deployExt("7.10.0");
  deployExt("7.11.0", "7.11.0");
  fs.writeFileSync(path.join(LOOM, "running-versions.json"), '{"win-1": {"vers');   // interrupted write
  const plan = gc.planGc(input({ currentVersion: "7.11.0" }));
  eq(plan.tier1.filter((i) => i.kind === "extension").length, 0,
     "an empty keep-set is indistinguishable from 'nothing is running' — and ten windows rewrite " +
     "this file every 15 seconds, so a torn read is ordinary");
  ok(plan.notes.some((n) => /running-versions\.json is missing or unreadable/.test(n)), "and it says why");
});

suite("gc R1: an ABSENT running-versions.json collects no build either", () => {
  deployExt("7.20.0");
  deployExt("7.21.0", "7.21.0");
  try { fs.rmSync(path.join(LOOM, "running-versions.json")); } catch { /* already gone */ }
  const plan = gc.planGc(input({ currentVersion: "7.21.0" }));
  eq(plan.tier1.filter((i) => i.kind === "extension").length, 0, "no stamp, no opinion");
  eq(gc.runningVersions(NOW, 86400000).readable, false, "and the reader says so rather than returning empty");
});

// ── R2 · the stamp is keyed by window, and both shapes are read ──────────────────────────────

suite("gc R2: two windows of ONE project on different builds both protect their build", () => {
  deployExt("7.30.0");
  deployExt("7.31.0");
  deployExt("7.32.0", "7.32.0");
  // the whole point: both entries are the same project, and a repo-keyed file could hold only one
  runningVersionsFile({
    "1234:abc": { version: "7.30.0", at: new Date(NOW - 60000).toISOString(), repo: "Gaming" },
    "5678:def": { version: "7.31.0", at: new Date(NOW - 60000).toISOString(), repo: "Gaming" },
  });
  const plan = gc.planGc(input({ currentVersion: "7.32.0" }));
  eq(mine(plan, "7.3"), [], "neither window has the floor pulled out from under it");
});

suite("gc R2: the OLD repo-keyed shape is still honoured alongside the new one", () => {
  deployExt("7.40.0");
  deployExt("7.41.0");
  deployExt("7.42.0", "7.42.0");
  runningVersionsFile({
    Gaming: { version: "7.40.0", at: new Date(NOW - 60000).toISOString() },          // pre-0.33.0
    "999:zzz": { version: "7.41.0", at: new Date(NOW - 60000).toISOString(), repo: "Lumen" },
  });
  const plan = gc.planGc(input({ currentVersion: "7.42.0" }));
  eq(mine(plan, "7.4"), [],
     "mixed builds write both shapes for a while; the keep-set is the union of every entry");
});

// ── R3 · a truncated reference sweep is not an answer ────────────────────────────────────────

suite("gc R3: a sweep that ran out of budget collects NO transcript", () => {
  // more .json files under the loom root than the sweep agrees to open
  const noisy = path.join(LOOM, "gcR3noise");
  fs.mkdirSync(noisy, { recursive: true });
  for (let i = 0; i < 4200; i++) fs.writeFileSync(path.join(noisy, `n${i}.json`), "{}");
  const dir = "-home-t-projR3";
  const src = writeAged(path.join(PROJECTS, dir, "beyondbu-0100.jsonl"), "{}\n", 90);
  writeAged(path.join(PROJECTS, dir, "zzzzzzzz-r3.jsonl"), "{}\n", 0);
  try {
    ok(gc.referencedSessions().truncated, "the sweep admits it gave up");
    const plan = gc.planGc(input());
    eq(pick(plan, 1, "beyondbu").length, 0,
       "an id the sweep never reached is indistinguishable from one nothing references");
    ok(plan.notes.some((n) => /reference sweep .* gave up early/.test(n)), "and it says why");
    ok(fs.existsSync(src), "the transcript is still there");
  } finally { fs.rmSync(noisy, { recursive: true, force: true }); }
});

suite("gc R3: a file over the size bound truncates the sweep rather than being skipped quietly", () => {
  const big = busPath(makeRepo({ roles: {} }, "gcR3big"), "huge.json");
  fs.writeFileSync(big, '{"pad":"' + "x".repeat(9_000_000) + '"}');
  try {
    ok(gc.referencedSessions().truncated, "skipping a file silently is how a live id went missing");
  } finally { fs.rmSync(big, { force: true }); }
});

suite("gc R3: a 3 MB file is read, not skipped — a banked handover is routinely over 2 MB", () => {
  const repo = makeRepo({ roles: {} }, "gcR3mid");
  const sid = "3c4d5e6f-7a8b-4c9d-8e1f-2a3b4c5d6e7f";
  fs.writeFileSync(busPath(repo, "handover.md"), "x".repeat(3_000_000) + `\nsession ${sid}\n`);
  const sweep = gc.referencedSessions();
  ok(!sweep.truncated, "3 MB is inside the 8 MB bound");
  ok(sweep.ids.has(sid), "and the id in it counts");
});

// ── R4 · the live roster the collector uses is machine-wide ──────────────────────────────────

suite("gc R4: a role is live to the collector when the BUS says so, whatever this window tracks", () => {
  const repo = makeRepo({ roles: { faraway: {} } }, "gcR4bus");
  writeJson(busPath(repo, "faraway", "status.json"), { status: "working", session_id: "farawayy-0200" });
  const live = gc.busLiveRoles(Date.now());
  ok(live.roles.has(`${repo}/faraway`), "a status.json written just now is a session that is running");
  ok(live.sessionIds.has("farawayy-0200"), "and its session id is live too");
});

suite("gc R4: a role whose status.json has not been written for hours is not live", () => {
  const repo = makeRepo({ roles: { sleepy: {} } }, "gcR4old");
  const f = busPath(repo, "sleepy", "status.json");
  writeJson(f, { status: "working", session_id: "sleepyyy-0201" });
  const t = (Date.now() - 5 * 3600000) / 1000;
  fs.utimesSync(f, t, t);
  const live = gc.busLiveRoles(Date.now());
  ok(!live.roles.has(`${repo}/sleepy`), "the file's mtime is the honest clock, not its updated_at");
  ok(!live.sessionIds.has("sleepyyy-0201"), "so its id is not protected as live");
});

// ── R5 · the claim survives the move loop; finishing never clobbers a takeover ────────────────

suite("gc R5: the default throttle is half the lease, not every item", () => {
  const dir = "-home-t-applyThrottle";
  for (let i = 0; i < 3; i++) writeAged(path.join(PROJECTS, dir, `thrott${i}-050${i}.jsonl`), "{}\n", 40);
  writeAged(path.join(PROJECTS, dir, "zzzzzzzz-tt.jsonl"), "{}\n", 0);
  const plan = gc.planGc(input());
  const items = plan.tier1.filter((i) => i.label.includes("thrott"));
  let refreshes = 0;
  gc.applyGc({ ...plan, tier1: items, tier2: [], tier3: [] }, [1], { refresh: () => { refreshes++; } });
  eq(refreshes, 0, "three small files take a millisecond; rewriting the lease file each time is waste");
});

suite("gc R5: a long pass refreshes its claim BEFORE and AFTER every item", () => {
  const dir = "-home-t-applyRefresh";
  for (let i = 0; i < 3; i++) {
    writeAged(path.join(PROJECTS, dir, `refresh${i}-030${i}.jsonl`), "{}\n", 40);
  }
  writeAged(path.join(PROJECTS, dir, "zzzzzzzz-rf.jsonl"), "{}\n", 0);
  const plan = gc.planGc(input());
  const items = plan.tier1.filter((i) => i.label.includes("refresh"));
  ok(items.length >= 3, "three items to move");
  let refreshes = 0;
  // `refreshEveryMs: 0` removes the throttle, so the callback is observable. The first version of
  // the applier moved up to 700 MB without ever touching its claim, and the lease is five minutes.
  const r = gc.applyGc({ ...plan, tier1: items, tier2: [], tier3: [] }, [1],
    { refresh: () => { refreshes++; }, refreshEveryMs: 0 });
  eq(r.done.length, items.length, "everything moved");
  // TWICE per item, not once. Refreshing only at the top of the loop renews the claim just BEFORE a
  // long cross-device copy and then not again until the item AFTER it has also finished — and the
  // last item in a pass is never followed by a refresh at all.
  eq(refreshes, 2 * items.length, "the claim was refreshed on both sides of every one of them");
});

suite("gc R5: a refresh that throws never fails the pass", () => {
  const dir = "-home-t-applyThrow";
  writeAged(path.join(PROJECTS, dir, "throwref-0400.jsonl"), "{}\n", 40);
  writeAged(path.join(PROJECTS, dir, "zzzzzzzz-th.jsonl"), "{}\n", 0);
  const plan = gc.planGc(input());
  const item = pick(plan, 1, "throwref")[0];
  const r = gc.applyGc({ ...plan, tier1: [item], tier2: [], tier3: [] }, [1],
    { refresh: () => { throw new Error("bus went away"); }, refreshEveryMs: 0 });
  eq(r.skipped.length, 0, "keeping a lease alive is best-effort, not a precondition");
  eq(r.done.length, 1, "the move still happened");
});

suite("gc R5: finishing does NOT release a claim another window has taken over", () => {
  const takenOver = { owner: "winB", ownerAt: NOW };
  const next = gc.finishAuto(takenOver, NOW + 1000, null, "our pass ended", "winA");
  eq(next.owner, "winB", "winA's lease went stale and winB started; clearing it would hand winB's " +
     "in-flight pass to a third window");
  eq(next.ownerAt, NOW, "untouched");
  eq(next.lastRunAt, NOW + 1000, "but what we did is still recorded");
});

suite("gc R5: finishing releases our OWN claim as before", () => {
  const ours = { owner: "winA", ownerAt: NOW };
  const next = gc.finishAuto(ours, NOW + 1000, null, "done", "winA");
  eq(next.owner, undefined, "released");
  eq(next.ownerAt, undefined, "cleanly");
});

// ── R6 · the small corrections ───────────────────────────────────────────────────────────────

suite("gc R6: a registration whose location and version disagree keeps BOTH builds", () => {
  deployExt("7.50.0");
  deployExt("7.51.0");
  deployExt("7.52.0");
  const loc = path.join(EXT_ROOT, "local.loom-session-tracker-7.50.0");
  fs.writeFileSync(path.join(EXT_ROOT, "extensions.json"), JSON.stringify([
    { identifier: { id: "local.loom-session-tracker" }, version: "7.51.0",
      location: { fsPath: loc, path: loc } },        // a registry caught mid-rewrite
  ]));
  runningVersionsFile({ w: { version: "7.52.0", at: new Date(NOW).toISOString() } });
  const plan = gc.planGc(input({ currentVersion: "7.52.0" }));
  eq(mine(plan, "7.5"), [], "whichever field is the stale one, the build the editor loads survives");
});

suite("gc R6: a SHORT role name uses a tighter typo radius", () => {
  // At distance 2 every two-letter role is a typo of every other: `po` would shield `qa`.
  const repo = makeRepo({ roles: { po: {}, qa: {} } }, "gcR6short");
  const root = makeGitRepo("r6short");
  addWorktree(root, "qb", { commit: true, merge: true });     // one edit from `qa` — a real near-miss
  addWorktree(root, "zz", { commit: true, merge: true });     // two edits from `qa` — not a typo
  const plan = gc.planGc(input({ repoRoots: { [repo]: root } }));
  match(pick(plan, 3, `${repo}/qb`)[0].detail, /one typo away from the role "qa"/,
        "one edit on a short name is still a near-miss");
  eq(labels(pick(plan, 2, `${repo}/zz`)), [`${repo}/zz`],
     "but two edits on a two-letter name is a different word, and real garbage must stay collectable");
});

suite("gc R6: an UPPERCASE session id in a board still protects its transcript", () => {
  const sid = "9F8E7D6C-5B4A-4938-8271-60514F3E2D1C";
  const repo = makeRepo({ roles: { dev: { session_id: sid } } }, "gcR6upper");
  const dir = "-home-t-projUpper";
  writeAged(path.join(PROJECTS, dir, sid.toLowerCase() + ".jsonl"), "{}\n", 90);
  writeAged(path.join(PROJECTS, dir, "zzzzzzzz-up.jsonl"), "{}\n", 0);
  ok(gc.referencedSessions().ids.has(sid.toLowerCase()), `${repo}'s board reference is folded to lower case`);
  eq(pick(gc.planGc(input()), 1, sid.slice(0, 8).toLowerCase()).length, 0, "so the transcript stays");
});

suite("gc R6: an UPPERCASE transcript FILENAME is matched against a lower-case reference", () => {
  // The other direction, and the one that makes the comparison itself load-bearing: the reference
  // readers fold to lower case, so a file named in upper case is only protected if the candidate is
  // folded too. Both halves of a case-insensitive compare have to be tested or one of them is free
  // to rot.
  const sid = "AB12CD34-5E6F-4708-9A1B-2C3D4E5F6071";
  const repo = makeRepo({ roles: { dev: { session_id: sid.toLowerCase() } } }, "gcR6upperFile");
  const dir = "-home-t-projUpperFile";
  writeAged(path.join(PROJECTS, dir, sid + ".jsonl"), "{}\n", 90);
  writeAged(path.join(PROJECTS, dir, "zzzzzzzz-uf.jsonl"), "{}\n", 0);
  ok(gc.referencedSessions().ids.has(sid.toLowerCase()), `${repo}'s board names it in lower case`);
  eq(pick(gc.planGc(input()), 1, sid.slice(0, 8)).length, 0,
     "and the upper-case file on disk is recognised as the same session");
});

// ════════════════════════════════════════════════════════════════════════════════════════════
// GC-006 — the writer side of "a read that cannot answer is a refusal", and the one tier that
// deletes rather than moves.
// ════════════════════════════════════════════════════════════════════════════════════════════

// ── R2 · what actually stands between an orphaned worktree and `git worktree remove` ─────────

suite("gc R2: a role with only a MAILBOX and no board entry still owns its worktree", () => {
  // THE GUARD THAT ACTUALLY DECIDES, and until now nothing tested it through this tier. A GC-006
  // review read `input.liveRoles` (a 30-minute mtime window that returns two roles machine-wide) as
  // the thing standing between an orphaned worktree and `git worktree remove`, and proposed widening
  // it. It never gets a say: `scanWorktrees` calls a worktree orphaned only when its name is absent
  // from `boardRoles(repo)`, which is the board UNION every role owning a mailbox on the bus, at ANY
  // age. Six hours stale here, and with no board entry at all.
  const repo = makeRepo({ roles: {} }, "gcR2mailbox");
  const f = busPath(repo, "napping", "status.json");
  writeJson(f, { status: "idle", session_id: "nappingg-0601" });
  const t = (Date.now() - 6 * 3600000) / 1000;
  fs.utimesSync(f, t, t);
  const root = makeGitRepo("r2mailbox");
  addWorktree(root, "napping", { commit: true, merge: true });   // clean, merged: otherwise collectable
  const plan = gc.planGc(input({ repoRoots: { [repo]: root } }));   // liveRoles deliberately EMPTY
  eq(pick(plan, 2, `${repo}/napping`).length, 0,
     "clean, merged, no board entry, not live by any window — and still never offered for removal");
  eq(pick(plan, 3, `${repo}/napping`).length, 0, "not even as a tier-3 decision: it is not orphaned");
});

suite("gc R2: a worktree with NO mailbox and no board entry IS collectable", () => {
  // The other half of the same guard: over-keeping everything would be a different bug. funisland
  // had 72 of these, 4.7 GB, measured 2026-09-13.
  const repo = makeRepo({ roles: {} }, "gcR2nomailbox");
  const root = makeGitRepo("r2nomailbox");
  addWorktree(root, "nobody", { commit: true, merge: true });
  const plan = gc.planGc(input({ repoRoots: { [repo]: root } }));
  eq(labels(pick(plan, 2, `${repo}/nobody`)), [`${repo}/nobody`],
     "no board entry, no status.json, no inbox, no outbox — nothing on this machine claims it");
});

suite("gc R2: the APPLIER re-checks the roster, not just the plan", () => {
  // A plan is a guess about a moment that has passed, and this is the tier where acting on a stale
  // guess deletes a working directory. The role appears on the bus AFTER the plan was made.
  const repo = makeRepo({ roles: {} }, "gcR2apply");
  const root = makeGitRepo("r2apply");
  const wt = addWorktree(root, "later", { commit: true, merge: true });
  const plan = gc.planGc(input({ repoRoots: { [repo]: root } }));
  const mineOnly = pick(plan, 2, `${repo}/later`);
  eq(labels(mineOnly), [`${repo}/later`], "the plan offers it");
  writeJson(busPath(repo, "later", "status.json"), { status: "idle" });   // ...and only now, a mailbox
  // Only this fixture's item: every suite here shares one world, and applying a whole accumulated
  // plan would act on other suites' worktrees.
  const r = gc.applyGc({ ...plan, tier1: [], tier2: mineOnly, tier3: [] }, [2],
                       { repoRoots: { [repo]: root } });
  eq(r.done.length, 0, "the applier refuses it");
  match(r.skipped[0].note, /still on the board/, "naming the safeguard that fired");
  ok(fs.existsSync(wt), "and the working directory is still there — this path cannot be undone");
});

// ── R4 · the claim is refreshed around each item, and a decline is not a refresh ─────────────

suite("gc R4: a refresh that DECLINED to write does not reset the throttle", () => {
  // The clock is injected because this defect is invisible without owning it: declining and
  // refreshing look identical from outside except in WHEN the next attempt happens. `refreshLease`
  // declines whenever the claim is younger than half the lease, so on a long pass the old code
  // measured its next attempt from a moment at which nothing had been written, and the claim could
  // drift a full lease between writes — expiring under its own holder mid-pass.
  const dir = "-home-t-applyDecline";
  for (let i = 0; i < 3; i++) writeAged(path.join(PROJECTS, dir, `declin${i}-070${i}.jsonl`), "{}\n", 40);
  writeAged(path.join(PROJECTS, dir, "zzzzzzzz-dc.jsonl"), "{}\n", 0);
  const plan = gc.planGc(input());
  const items = plan.tier1.filter((i) => i.label.includes("declin"));
  eq(items.length, 3, "three items to move");
  // Every observation of the clock costs 60 ms, so time advances with the pass and with nothing else.
  let clock = 0;
  const nowMs = () => (clock += 60);
  let calls = 0;
  const r = gc.applyGc({ ...plan, tier1: items, tier2: [], tier3: [] }, [1],
    { refresh: () => { calls++; return false; }, refreshEveryMs: 100, nowMs });
  eq(r.done.length, 3, "everything moved");
  eq(calls, 2 * items.length - 1,
     "once a refresh declines, every later attempt point tries again: the throttle measures from " +
     "the last WRITE, not the last attempt");
});

suite("gc R4: a refresh that DID write resets the throttle", () => {
  const dir = "-home-t-applyWrote";
  for (let i = 0; i < 3; i++) writeAged(path.join(PROJECTS, dir, `wrotee${i}-080${i}.jsonl`), "{}\n", 40);
  writeAged(path.join(PROJECTS, dir, "zzzzzzzz-wr.jsonl"), "{}\n", 0);
  const plan = gc.planGc(input());
  const items = plan.tier1.filter((i) => i.label.includes("wrotee"));
  let clock = 0;
  const nowMs = () => (clock += 60);
  let calls = 0;
  const r = gc.applyGc({ ...plan, tier1: items, tier2: [], tier3: [] }, [1],
    { refresh: () => { calls++; return true; }, refreshEveryMs: 100, nowMs });
  eq(r.done.length, 3, "everything moved");
  ok(calls > 0 && calls < 2 * items.length - 1,
     `a claim that was actually written is not rewritten at the next opportunity (${calls} calls)`);
});
