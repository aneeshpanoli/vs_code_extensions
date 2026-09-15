// workledger.test.js — WL-001. The arithmetic of "what did the agents actually produce", against a
// FIXTURE GIT REPO built here with known commits, so every figure has an answer computed by hand.
//
// Why a real repo rather than a stubbed `git`: the thing most likely to break this module is git's
// output format (rename spellings, binary `-\t-`, an empty tree, a repo with no tag), and a stub
// proves only that the parser agrees with the stub. The fixture costs ~1s and tests the real path.
const { suite, ok, eq, match, load, makeRepo, busPath, writeJson, LOOM } = require("./harness");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { execFileSync } = require("child_process");

const wl = load("workledger.js");

// ── fixture helpers ───────────────────────────────────────────────────────────────────────────

const GIT_ID = ["-c", "user.email=t@t", "-c", "user.name=t", "-c", "commit.gpgsign=false"];
function git(dir, args) {
  return execFileSync("git", ["-C", dir, ...GIT_ID, ...args], { encoding: "utf8" });
}

/** A repo named `name` with `commits`: [{msg, files: {path: contents}, deletes: [], daysAgo}]. */
function makeGitRepo(name, commits) {
  const dir = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "loom-wl-")), name);
  fs.mkdirSync(dir, { recursive: true });
  git(dir, ["init", "-q", "-b", "main"]);
  for (const c of commits) {
    for (const [f, body] of Object.entries(c.files || {})) {
      fs.mkdirSync(path.dirname(path.join(dir, f)), { recursive: true });
      fs.writeFileSync(path.join(dir, f), body);
    }
    for (const f of c.deletes || []) fs.rmSync(path.join(dir, f), { force: true });
    git(dir, ["add", "-A"]);
    const when = new Date(Date.now() - (c.daysAgo || 0) * 86400000).toISOString();
    execFileSync("git", ["-C", dir, ...GIT_ID, "commit", "-q", "-m", c.msg], {
      env: { ...process.env, GIT_AUTHOR_DATE: when, GIT_COMMITTER_DATE: when },
    });
  }
  return dir;
}

const lines = (n, prefix = "line") =>
  Array.from({ length: n }, (_, i) => `${prefix} ${i}`).join("\n") + "\n";

/** A transcript tree under a fake ~/.claude/projects, so token scans need no real sessions. */
function makeTranscripts(repo, perModel, { suffix = "", old = false } = {}) {
  const root = path.join(LOOM, "..", "projects-" + Math.random().toString(36).slice(2));
  const dir = path.join(root, `-home-user-Containers-${repo}${suffix}`);
  fs.mkdirSync(dir, { recursive: true });
  const out = [];
  for (const [model, u] of Object.entries(perModel)) {
    out.push(JSON.stringify({ type: "assistant", message: { model, usage: u } }));
  }
  // Lines that must NOT be counted: a user turn, and a replay of the same usage on a non-assistant
  // line. Counting either would double every figure in the panel.
  out.push(JSON.stringify({ type: "user", message: { role: "user", content: "hi" } }));
  out.push(JSON.stringify({ type: "summary", message: { usage: { output_tokens: 999999999 } } }));
  out.push("");                                     // a torn trailing line is normal
  const f = path.join(dir, "session.jsonl");
  fs.writeFileSync(f, out.join("\n"));
  if (old) {
    const t = (Date.now() - 30 * 86400000) / 1000;
    fs.utimesSync(f, t, t);
  }
  return root;
}

const usage = (i, o, cr, cc) => ({
  input_tokens: i, output_tokens: o, cache_read_input_tokens: cr, cache_creation_input_tokens: cc,
});

// ── R1 · arithmetic ───────────────────────────────────────────────────────────────────────────

suite("WL-001 R1: shipsToUser is the share of CHANGED LINES landing in configured product paths", () => {
  // 100 product lines added, 40 rig lines added => 100/140 = 71.4%.
  const dir = makeGitRepo("fixt1", [
    { msg: "seed", files: { "README.md": "x\n" } },
    { msg: "work", files: { "src/app/page.tsx": lines(100), "test/page.test.ts": lines(40) } },
  ]);
  const w = wl.computeWorkLedger(dir, { productPaths: { fixt1: ["src/app/**"] } });
  eq(w.productLines, 100, "product lines counted");
  eq(w.totalLines, 141, "every changed line counted (README seed included)");
  eq(w.shipsToUser, 70.9, "share, to one decimal");
  eq(w.heuristic, false, "configured, not guessed");
});

suite("WL-001 R7a: a test file under a product glob is NOT product — the defect this panel exists to refute", () => {
  // MEASURED, not hypothetical. ReciEats' productPaths are `src/app/**` + `src/lib/**`, and 39,150
  // of the 63,225 lines those globs matched over the audited week were TEST files living under
  // `src/` — `src/app/page.test.tsx` alone was +10,782, the single largest file in the product
  // figure. A ledger that counts page.test.tsx as product reports the number it exists to refute.
  const dir = makeGitRepo("fixt2", [
    { msg: "seed", files: { "README.md": "x\n" } },
    { msg: "work", files: { "src/app/a.tsx": lines(20), "src/app/a.test.tsx": lines(80) } },
  ]);
  const w = wl.computeWorkLedger(dir, { productPaths: { fixt2: ["src/app/**"] } });
  eq(w.productLines, 20, "the glob matches the test file; the exclusion subtracts it anyway");
  ok(w.shipsToUser < 25, `and the shipping share tells the truth (${w.shipsToUser}%)`);
  // Turning the exclusions off reproduces the defect exactly — so the fix is the exclusions, and
  // this test would still catch a regression that quietly emptied the list.
  const broken = wl.computeWorkLedger(dir, { productPaths: { fixt2: ["src/app/**"] }, excludePaths: [] });
  eq(broken.productLines, 100, "without exclusions the test file is counted as product again");
  ok(broken.shipsToUser > 90, `which is how a week like the audited one reads GREEN (${broken.shipsToUser}%)`);
  const heur = wl.computeWorkLedger(dir, { productPaths: {} });
  eq(heur.heuristic, true, "unconfigured repo falls back and SAYS SO");
  eq(heur.productLines, 20, "and the heuristic reaches the same answer by its own route");
});

suite("WL-001 R7c: product and rig PARTITION the week's lines — they must not overlap", () => {
  // Before R7a the same `src/app/page.test.tsx` was counted as product AND as rig, so the ratio
  // understated the rig by construction while the shipping share overstated the product.
  const dir = makeGitRepo("fixt15", [
    { msg: "seed", files: { "README.md": "x\n" } },
    { msg: "work", files: { "src/app/a.tsx": lines(10), "src/app/a.test.tsx": lines(30),
                            "scripts/verify.py": lines(10) } },
  ]);
  const w = wl.computeWorkLedger(dir, { productPaths: { fixt15: ["src/app/**"] } });
  eq(w.productLines, 10, "only the real product line count");
  eq(w.rigLines, 40, "what was SUBTRACTED from product lands in rig, beside scripts/");
  eq(w.rigRatio, 4, "and the ratio is rig over product, sharing nothing");
  ok(w.productLines + w.rigLines <= w.totalLines, "the two sets never double-count a line");
});

suite("WL-001 R7a: the default exclusions match at any depth, not just the repo root", () => {
  // A root-anchored `__tests__` pattern would miss `src/__tests__/`, which is where they live.
  const c = wl.classifierFor("r", { r: ["src/**"] });
  for (const f of ["src/app/page.test.tsx", "src/a.spec.ts", "src/__tests__/a.ts",
                   "src/deep/__mocks__/fs.ts"]) {
    eq(c.isProduct(f), false, `${f} is not product`);
    eq(c.isExcluded(f), true, `${f} is visibly excluded, not silently absent`);
  }
  eq(c.isProduct("src/app/page.tsx"), true, "and ordinary product is untouched");
});

suite("WL-001 R7a: excludePaths is settings-overridable, like everything else", () => {
  const c = wl.classifierFor("r", { r: ["src/**"] }, ["**/*.stories.*"]);
  eq(c.isProduct("src/a.stories.tsx"), false, "a project's own convention can be excluded");
  eq(c.isProduct("src/a.test.tsx"), true, "and replacing the list really replaces it");
  const d = wl.classifierFor("r", { r: ["src/**"] }, []);
  eq(d.isProduct("src/a.test.tsx"), true, "an EMPTY list excludes nothing — a person's choice stands");
});

suite("WL-001 R1: narrationShare counts commits whose ENTIRE file set is documentation", () => {
  const dir = makeGitRepo("fixt3", [
    { msg: "seed", files: { "src/app/a.ts": lines(5) } },
    { msg: "update the guide", files: { "guide/GUIDE.txt": lines(10) } },
    { msg: "docs only", files: { "docs/PLAN.md": lines(3) } },
    { msg: "mixed", files: { "README.md": lines(2), "src/app/b.ts": lines(2) } },
  ]);
  const w = wl.computeWorkLedger(dir, { productPaths: { fixt3: ["src/app/**"] } });
  eq(w.commits, 4, "four commits in the window");
  eq(w.narrationCommits, 2, "the guide commit and the docs commit; the MIXED one is not narration");
  eq(w.narrationShare, 50, "share of commits");
});

suite("WL-001 R1: topChurn ranks by touches, and its order is stable", () => {
  const dir = makeGitRepo("fixt4", [
    { msg: "c1", files: { "guide/GUIDE.txt": lines(1), "src/app/a.ts": lines(1) } },
    { msg: "c2", files: { "guide/GUIDE.txt": lines(2) } },
    { msg: "c3", files: { "guide/GUIDE.txt": lines(3) } },
  ]);
  const w = wl.computeWorkLedger(dir, { productPaths: { fixt4: ["src/app/**"] } });
  eq(w.topChurn[0].file, "guide/GUIDE.txt", "the most-touched file leads");
  eq(w.topChurn[0].touches, 3, "touch count");
  ok(w.topChurn.length <= 5, "five at most");
  const again = wl.computeWorkLedger(dir, { productPaths: { fixt4: ["src/app/**"] } });
  eq(again.topChurn.map((c) => c.file), w.topChurn.map((c) => c.file), "stable across runs");
});

suite("WL-001 R1: a commit OUTSIDE the window is not measured", () => {
  const dir = makeGitRepo("fixt5", [
    { msg: "ancient", files: { "src/app/old.ts": lines(500) }, daysAgo: 30 },
    { msg: "recent", files: { "src/app/new.ts": lines(10) }, daysAgo: 1 },
  ]);
  const w = wl.computeWorkLedger(dir, { productPaths: { fixt5: ["src/app/**"] }, windowDays: 7 });
  eq(w.commits, 1, "only the in-window commit");
  eq(w.productLines, 10, "the 500-line ancient commit is not this week's work");
});

suite("WL-001 R1: a repo with NO TAG reports never-released — a warning, not a blank", () => {
  const dir = makeGitRepo("fixt6", [{ msg: "c1", files: { "src/app/a.ts": lines(3) } }]);
  const w = wl.computeWorkLedger(dir, { productPaths: { fixt6: ["src/app/**"] } });
  eq(w.tag, null, "no tag");
  eq(w.blocksSinceRelease, null, "and therefore no count since one");
  const rel = wl.figuresFor(w).find((f) => f.key === "release");
  eq(rel.band, "bad", "rendered RED — this is ReciEats' answer and it must not be a blank cell");
  match(rel.value, /never released/, "and it states what it means");
});

suite("WL-001 R1: a tagged repo counts the blocks since the tag", () => {
  const dir = makeGitRepo("fixt7", [
    { msg: "c1", files: { "src/app/a.ts": lines(3) } },
    { msg: "c2", files: { "src/app/b.ts": lines(3) } },
  ]);
  git(dir, ["tag", "v1.0.0", "HEAD~1"]);
  const w = wl.computeWorkLedger(dir, { productPaths: { fixt7: ["src/app/**"] } });
  eq(w.tag, "v1.0.0", "newest tag found");
  eq(w.blocksSinceRelease, 1, "one commit since it");
  eq(wl.figuresFor(w).find((f) => f.key === "release").band, "unknown", "a released repo is not red");
});

suite("WL-001 R1: a path that is not a git repo, or absent, returns a WELL-FORMED empty result", () => {
  for (const p of [null, "/nonexistent/nowhere", os.tmpdir()]) {
    const w = wl.computeWorkLedger(p, {});
    eq(w.empty, true, `empty for ${p}`);
    ok(typeof w.emptyReason === "string" && w.emptyReason.length, "and says WHY");
    eq(w.commits, 0, "no commits");
    eq(w.shipsToUser, null, "figure is NULL, never 0 — unreadable and measured-zero are opposites");
    eq(Array.isArray(w.topChurn), true, "still well-formed");
  }
});

suite("WL-001 R1: a repo with no commits IN THE WINDOW still reports its ledger half", () => {
  const dir = makeGitRepo("fixt8", [{ msg: "ancient", files: { "a.ts": lines(3) }, daysAgo: 60 }]);
  const repo = "fixt8";
  fs.mkdirSync(busPath(repo), { recursive: true });
  fs.writeFileSync(busPath(repo, "model-ledger.jsonl"),
    JSON.stringify({ id: "A-1", role: "dev", model: "claude-opus-5", loopBacks: 2, wallMinutes: 30,
                     finished: new Date().toISOString() }) + "\n");
  const w = wl.computeWorkLedger(dir, { windowDays: 7 });
  eq(w.empty, true, "git has nothing to say");
  eq(w.handoffs, 1, "but a week of handoffs that produced no commit is exactly the finding");
  eq(w.loopBackRate, 100, "and its loop-back rate is still reported");
});

// ── R1 · the ledger half ──────────────────────────────────────────────────────────────────────

suite("WL-001 R1: loopBackRate skips ack lines and self-shifts, which are not handoffs", () => {
  const repo = makeRepo({ dev: {} });
  const now = new Date().toISOString();
  fs.writeFileSync(busPath(repo, "model-ledger.jsonl"), [
    JSON.stringify({ id: "A-1", role: "dev", loopBacks: 0, wallMinutes: 10, finished: now }),
    JSON.stringify({ id: "A-1-ack", role: "dev", loopBacks: 0, wallMinutes: 0, finished: now }),
    JSON.stringify({ role: "po", self: true, from: "x", to: "y", finished: now }),
    JSON.stringify({ id: "A-2", role: "dev", loopBacks: 1, wallMinutes: 50, finished: now }),
    "{ not json",
  ].join("\n"));
  const led = wl.readLedger(repo, Date.now() - 7 * 86400000);
  eq(led.map((l) => l.id), ["A-1", "A-2"], "acks, self-shifts and garbage all dropped");
});

suite("WL-001 R1: a NEGATIVE or zero wall time is DROPPED, never shown as 0", () => {
  // The `started` bug is real and known. A 0 in this column reads as "that handoff took no time",
  // which is precisely the self-flattering number this module refuses to print.
  eq(wl.medianPositive([30, 0, -5, 50]), 40, "median over the positives only");
  eq(wl.medianPositive([0, -1]), null, "nothing positive => null, not 0");
  eq(wl.medianPositive([]), null, "empty => null");
  eq(wl.medianPositive([7]), 7, "single value");
});

// ── R6 · tokens, cost, and the denominator ────────────────────────────────────────────────────

suite("WL-001 R6: CACHE READS ARE COUNTED — omitting them understates a week by ~100x", () => {
  const root = makeTranscripts("tok1", { "claude-opus-5": usage(100, 200, 1_000_000, 5_000) });
  const scan = wl.scanTranscripts("tok1", 0, root);
  eq(scan.total, 1_005_300, "all four classes summed");
  eq(scan.byModel["claude-opus-5"].cacheRead, 1_000_000, "and the cache read is the bulk of it");
  ok(scan.total > 100 * (100 + 200 + 5000),
     "a total without cache reads would be two orders of magnitude smaller");
});

suite("WL-001 R6: usage is read from ASSISTANT lines only — no double counting", () => {
  const root = makeTranscripts("tok2", { "claude-opus-5": usage(1, 2, 3, 4) });
  const scan = wl.scanTranscripts("tok2", 0, root);
  eq(scan.total, 10, "the user and summary lines contribute nothing");
  eq(scan.files, 1, "one transcript file read");
});

suite("WL-001 R6: tokens are split BY MODEL, and a worktree session belongs to its repo", () => {
  const root = makeTranscripts("tok3", { "claude-opus-5": usage(0, 0, 100, 0) });
  // The worktree sessions are the bulk of the spend; dropping them undercounts by most of itself.
  makeTranscripts("tok3", { "claude-fable-5-1": usage(0, 0, 50, 0) },
                  { suffix: "--claude-worktrees-developer1" });
  const dirs = wl.transcriptDirsFor("tok3", root);
  eq(dirs.length, 1, "each scan root holds its own dir in this fixture");
  const scan = wl.scanTranscripts("tok3", 0, root);
  eq(Object.keys(scan.byModel), ["claude-opus-5"], "split by model id");
});

suite("WL-001 R6: a transcript older than the window is not counted", () => {
  const root = makeTranscripts("tok4", { "claude-opus-5": usage(0, 0, 999, 0) }, { old: true });
  eq(wl.scanTranscripts("tok4", Date.now() - 7 * 86400000, root).total, 0, "out of window");
  eq(wl.scanTranscripts("tok4", 0, root).total, 999, "in an unbounded window it is counted");
});

suite("WL-001 R6: costEquivalent is list price per class, and reproduces the audited figures", () => {
  // The PO's own table, and the answer it must give for ReciEats. This pins the ARITHMETIC: given
  // these prices and these tokens, $8,945 is the only right answer.
  const poPrices = {
    "claude-opus-5": [5, 25, 0.5, 10], "claude-fable-5-1": [10, 50, 1, 20],
    "claude-sonnet-5": [2, 10, 0.2, 4], "claude-haiku-4-5": [1, 5, 0.1, 2],
  };
  const reciEats = {
    "claude-opus-5": { input: 83350, output: 30553632, cacheRead: 6999949740, cacheCreate: 66880570 },
    "claude-fable-5-1": { input: 256296, output: 17327250, cacheRead: 2176590677, cacheCreate: 48326820 },
  };
  eq(wl.costEquivalent(reciEats, poPrices).dollars, 8945.09, "ReciEats, measured 2026-09-15");
  const pleodo = {
    "claude-opus-5": { input: 49632, output: 20348509, cacheRead: 5591283533, cacheCreate: 40072671 },
    "claude-fable-5-1": { input: 55836, output: 3658484, cacheRead: 356064901, cacheCreate: 7559696 },
  };
  eq(wl.costEquivalent(pleodo, poPrices).dollars, 4396.07, "pleodo, measured the same day");
});

suite("WL-001 R6: an UNPRICED model contributes tokens but NOT dollars, and is named", () => {
  const c = wl.costEquivalent({ "some-new-model": { input: 0, output: 0, cacheRead: 2_000_000, cacheCreate: 0 } },
                              { "claude-opus-5": [5, 25, 0.5, 10] });
  eq(c.dollars, 0, "no price row, no dollars — never a silent guess at one");
  eq(c.unpricedTokens, 2_000_000, "the tokens are still counted");
  eq(c.unpricedModels, ["some-new-model"], "and the model is named so the undercount is visible");
});

suite("WL-001 R6: a model that spent NOTHING is not an undercount", () => {
  // `<synthetic>` appears on every bus with an all-zero usage object. Listing it as unpriced would
  // put a permanent warning on a figure that is exactly right.
  const c = wl.costEquivalent({ "<synthetic>": { input: 0, output: 0, cacheRead: 0, cacheCreate: 0 } }, {});
  eq(c.unpricedModels, [], "zero-token models are not reported as unpriced");
  eq(c.unpricedTokens, 0, "and add nothing to the undercount");
});

suite("WL-001 R6: a [1m] suffix and a dated snapshot price as their family", () => {
  const p = { "claude-opus-5": [5, 25, 0.5, 10], "claude-haiku-4-5": [1, 5, 0.1, 2] };
  eq(wl.priceFor("claude-opus-5[1m]", p), p["claude-opus-5"], "the window suffix is not a SKU");
  eq(wl.priceFor("claude-haiku-4-5-20251001", p), p["claude-haiku-4-5"], "a dated snapshot inherits");
  eq(wl.priceFor("gpt-fictional", p), null, "an unknown id stays unpriced rather than being folded in");
});

suite("WL-001 R6: netProductLines is a TWO-POINT DIFF — churn is not production", () => {
  // The same file rewritten three times, ending 10 lines long. Per-commit numstat would report ~60
  // lines of "production"; the two-point diff reports the 10 that exist.
  const dir = makeGitRepo("fixt9", [
    { msg: "base", files: { "README.md": "x\n" }, daysAgo: 30 },
    { msg: "v1", files: { "src/app/a.ts": lines(20) }, daysAgo: 3 },
    { msg: "v2", files: { "src/app/a.ts": lines(15, "other") }, daysAgo: 2 },
    { msg: "v3", files: { "src/app/a.ts": lines(10, "final") }, daysAgo: 1 },
  ]);
  const w = wl.computeWorkLedger(dir, { productPaths: { fixt9: ["src/app/**"] }, windowDays: 7 });
  eq(w.netProductLines, 10, "ten lines exist now that did not before — not the churn total");
  ok(w.totalLines > 10, `churn is much larger (${w.totalLines} changed lines) — that is the point`);
  eq(w.newUserFacingFiles, 1, "one new user-facing file, which is what separates building from revising");
});

suite("WL-001 R6: a repo whose WHOLE history is inside the window diffs from the empty tree", () => {
  // Measured 2026-09-15: pleodo has no commit older than 7 days. Without the empty-tree base the
  // denominator comes out 0 and every cost-per-line reads as "no product at all".
  const dir = makeGitRepo("fixt10", [{ msg: "c1", files: { "src/app/a.ts": lines(12) }, daysAgo: 1 }]);
  const w = wl.computeWorkLedger(dir, { productPaths: { fixt10: ["src/app/**"] }, windowDays: 7 });
  eq(w.netProductLines, 12, "everything here is new in this window");
  eq(w.newUserFacingFiles, 1, "and the file is new");
});

suite("WL-001 R6: a window that produced NO net product line is RED, not 'unknown'", () => {
  const dir = makeGitRepo("fixt11", [
    { msg: "base", files: { "src/app/a.ts": lines(20) }, daysAgo: 30 },
    { msg: "delete it all", deletes: ["src/app/a.ts"], files: { "docs/why.md": lines(3) }, daysAgo: 1 },
  ]);
  const root = makeTranscripts("fixt11", { "claude-opus-5": usage(0, 0, 500_000_000, 0) });
  const w = wl.computeWorkLedger(dir, {
    productPaths: { fixt11: ["src/app/**"] }, windowDays: 7, projectsRoot: root });
  ok(w.netProductLines <= 0, `net is not positive (${w.netProductLines})`);
  eq(w.costPerProductLine, null, "no ratio exists — dividing would print Infinity or a negative");
  const f = wl.figuresFor(w).find((k) => k.key === "costPerProductLine");
  eq(f.band, "bad", "spending tokens and producing nothing is the WORST reading, not the quietest");
  match(f.value, /no net product lines/i, "and the row states it");
});

suite("WL-001 R6: costPerProductLine reddens above the threshold and the row states the number", () => {
  const w = { ...wl.computeWorkLedger(null, {}), tokensSpent: 10, netProductLines: 100,
              costEquivalent: 50, costPerProductLine: 0.5 };
  const hot = wl.figuresFor(w, { ...wl.DEFAULT_THRESHOLDS, costPerLine: 0.25 });
  const row = hot.find((f) => f.key === "costPerProductLine");
  eq(row.band, "bad", "above the threshold");
  match(row.value, /0\.50/, "and STATES the number — a bare warning icon is what this replaces");
  eq(wl.figuresFor({ ...w, costPerProductLine: 0.25 },
       { ...wl.DEFAULT_THRESHOLDS, costPerLine: 0.25 })
     .find((f) => f.key === "costPerProductLine").band, "good", "at the boundary it is not red");
});

suite("WL-001 R6: the collapsed row carries tokens, $equiv and $/line — that line IS the audit", () => {
  const w = { ...wl.computeWorkLedger(null, {}), tokensSpent: 9_339_968_335, costEquivalent: 8945.09,
              costPerProductLine: 0.37, shipsToUser: 10.7, loopBackRate: 30, narrationShare: 28,
              commits: 221, tag: null };
  const s = wl.summaryLine(w);
  match(s, /9\.3B/, "tokens, humanised");
  match(s, /\$8,945/, "list-price equivalent");
  match(s, /\$0\.37\/line/, "and the ratio the owner actually asked for");
  match(s, /ships 10\.7%/, "beside the shipping share");
  match(s, /no release in 221 blocks/, "and the release state");
});

// ── R2 · bands ────────────────────────────────────────────────────────────────────────────────

suite("WL-001 R2: band boundaries are inclusive on the good side, both directions", () => {
  const t = wl.DEFAULT_THRESHOLDS;
  eq(wl.band(40, t.shipsGood, t.shipsBad, true), "good", "40% shipping is green (>=40)");
  eq(wl.band(39.9, t.shipsGood, t.shipsBad, true), "warn", "just under is amber");
  eq(wl.band(20, t.shipsGood, t.shipsBad, true), "warn", "20 is the amber floor");
  eq(wl.band(19.9, t.shipsGood, t.shipsBad, true), "bad", "under 20 is red");
  eq(wl.band(20, t.loopBackGood, t.loopBackBad, false), "good", "20% loop-backs is green (<=20)");
  eq(wl.band(20.1, t.loopBackGood, t.loopBackBad, false), "warn", "just over is amber");
  eq(wl.band(50, t.loopBackGood, t.loopBackBad, false), "warn", "50 is still amber");
  eq(wl.band(50.1, t.loopBackGood, t.loopBackBad, false), "bad", "over 50 is red");
  eq(wl.band(10, t.narrationGood, t.narrationBad, false), "good", "10% narration is green");
  eq(wl.band(25.1, t.narrationGood, t.narrationBad, false), "bad", "over 25 is red");
  eq(wl.band(null, 1, 2, true), "unknown", "a null figure is UNKNOWN, never green");
  eq(wl.band(NaN, 1, 2, true), "unknown", "and so is a NaN");
});

suite("WL-001 R2: every figure names its numerator, denominator, window and computedAt", () => {
  const dir = makeGitRepo("fixt12", [{ msg: "c", files: { "src/app/a.ts": lines(4) } }]);
  const w = wl.computeWorkLedger(dir, { productPaths: { fixt12: ["src/app/**"] } });
  for (const f of wl.figuresFor(w)) {
    match(f.detail, /window \d+d/, `${f.key} states its window`);
    match(f.detail, /computed \d{4}-/, `${f.key} states computedAt, so a stale cache is obvious`);
  }
  const ships = wl.figuresFor(w).find((f) => f.key === "shipsToUser");
  match(ships.detail, /\d+ of \d+ changed lines/, "shipsToUser states numerator and denominator");
});

suite("WL-001 R2: a HEURISTIC figure says so, everywhere it is shown", () => {
  const dir = makeGitRepo("unlisted_repo", [{ msg: "c", files: { "src/a.ts": lines(4) } }]);
  const w = wl.computeWorkLedger(dir, { productPaths: {} });
  eq(w.heuristic, true, "not configured");
  match(wl.figuresFor(w).find((f) => f.key === "shipsToUser").detail, /HEURISTIC/,
        "an unconfigured guess presented as a measurement is the same lie in a new place");
  match(wl.summaryLine(w), /\(est\)/, "and the collapsed row marks it too");
});

suite("WL-001 R4: an EMPTY product list is configuration, not absence", () => {
  const c = wl.classifierFor("r", { r: [] });
  eq(c.heuristic, false, "a person wrote []; falling through to the heuristic would overrule them");
  eq(c.isProduct("src/app/a.ts"), false, "and it means nothing here ships");
});

suite("WL-001 R4: the glob matcher handles ** across separators and * within one", () => {
  ok(wl.matchesAny("src/app/deep/a.tsx", ["src/app/**"]), "** crosses separators");
  ok(wl.matchesAny("src/app/a.tsx", ["src/app/**"]), "** may match nothing at all");
  ok(!wl.matchesAny("src/other/a.tsx", ["src/app/**"]), "and does not match a sibling");
  ok(wl.matchesAny("src/a.ts", ["src/*.ts"]), "* stays within one segment");
  ok(!wl.matchesAny("src/deep/a.ts", ["src/*.ts"]), "and does not cross one");
});

// ── the cache ─────────────────────────────────────────────────────────────────────────────────

suite("WL-001 R1: the cache is honoured until the interval elapses", () => {
  const repo = makeRepo({ dev: {} });
  const now = Date.now();
  writeJson(busPath(repo, "work-ledger.json"),
    { ledger: { ...wl.computeWorkLedger(null, {}), repo, computedAt: new Date(now).toISOString() } });
  eq(wl.dueForCompute(wl.readCache(repo), 10, now + 60_000), false, "a minute later: not due");
  eq(wl.dueForCompute(wl.readCache(repo), 10, now + 11 * 60_000), true, "eleven minutes later: due");
  eq(wl.dueForCompute(null, 10, now), true, "no cache at all: due");
});

suite("WL-001 R1: an UNREADABLE computedAt is due, not rested on", () => {
  eq(wl.dueForCompute({ ledger: { computedAt: "not a date" } }, 10, Date.now()), true,
     "a value we cannot read is not a measurement we can rest on");
});

suite("WL-001 R5: notifiedOn survives a recompute — the day belongs to the project", () => {
  const repo = makeRepo({ dev: {} });
  writeJson(busPath(repo, "work-ledger.json"),
    { ledger: { ...wl.computeWorkLedger(null, {}), repo, computedAt: "2020-01-01T00:00:00Z" },
      notifiedOn: "2026-09-15" });
  const next = wl.refreshWorkLedger(repo, null, { intervalMin: 10 });
  eq(next.notifiedOn, "2026-09-15", "a recompute must not re-arm today's announcement");
  ok(next.ledger.computedAt > "2026", "and it really did recompute");
});

// ── R5 · the decision ─────────────────────────────────────────────────────────────────────────

suite("WL-001 R5: the alert fires on a RED ships figure, once per day", () => {
  const w = { ...wl.computeWorkLedger(null, {}), repo: "R", shipsToUser: 10.7, narrationShare: 28,
              commits: 221, tag: null, tokensSpent: 9e9, costEquivalent: 8945, netProductLines: 24075,
              costPerProductLine: 0.37, newUserFacingFiles: 2 };
  const now = Date.parse("2026-09-15T10:00:00Z");
  const msg = wl.ledgerAlert(w, null, wl.DEFAULT_THRESHOLDS, now);
  ok(msg, "a red project raises a line");
  match(msg, /^\[loom-ledger\] R:/, "addressed and tagged");
  match(msg, /10\.7% of this week's changed lines reach a user/, "states the shipping figure");
  match(msg, /28% of commits only update the guide/, "and the narration figure");
  match(msg, /no release in 221 blocks/, "and the release state");
  match(msg, /list-price equivalent, not a bill/, "and is explicit that the dollars are not a bill");
  match(msg, /2 new user-facing file\(s\)/, "and what was actually built");
  match(msg, /Consider whether the next block ships something\./, "and asks for the decision");
  eq(wl.ledgerAlert(w, "2026-09-15", wl.DEFAULT_THRESHOLDS, now), null, "already said today: silent");
  ok(wl.ledgerAlert(w, "2026-09-14", wl.DEFAULT_THRESHOLDS, now), "yesterday does not silence today");
});

suite("WL-001 R5: a green project is never nudged", () => {
  const w = { ...wl.computeWorkLedger(null, {}), repo: "R", shipsToUser: 80, narrationShare: 2,
              commits: 10, tag: "v1", blocksSinceRelease: 1, tokensSpent: 100,
              costEquivalent: 1, netProductLines: 500, costPerProductLine: 0.002 };
  eq(wl.ledgerAlert(w, null, wl.DEFAULT_THRESHOLDS, Date.now()), null, "nothing to say");
});

suite("WL-001 R5: COST alone raises it, even when the shipping share looks fine", () => {
  // The two are not the same alarm. A week can be green on shares and still cost a fortune per line.
  const w = { ...wl.computeWorkLedger(null, {}), repo: "R", shipsToUser: 80, narrationShare: 2,
              commits: 10, tag: "v1", blocksSinceRelease: 1, tokensSpent: 9e9,
              costEquivalent: 9000, netProductLines: 100, costPerProductLine: 90 };
  const msg = wl.ledgerAlert(w, null, wl.DEFAULT_THRESHOLDS, Date.now());
  ok(msg, "a ruinous cost per line raises it on its own");
  match(msg, /\$90\.00\/line/, "and names the ratio");
});

suite("WL-001 R5: a week that produced NO net product line raises it too", () => {
  const w = { ...wl.computeWorkLedger(null, {}), repo: "R", shipsToUser: 90, narrationShare: 1,
              commits: 50, tag: "v1", blocksSinceRelease: 2, tokensSpent: 5e9,
              costEquivalent: 4000, netProductLines: 0, costPerProductLine: null };
  const msg = wl.ledgerAlert(w, null, wl.DEFAULT_THRESHOLDS, Date.now());
  ok(msg, "spending five billion tokens for no net product line is always worth one line");
  match(msg, /NO net product lines/, "and it says exactly that");
});

suite("WL-001 R5: a project with nothing measured at all is silent", () => {
  eq(wl.ledgerAlert(wl.computeWorkLedger(null, {}), null, wl.DEFAULT_THRESHOLDS, Date.now()), null,
     "no commits, no tokens: nothing to announce");
});

// ── R3 · the report ───────────────────────────────────────────────────────────────────────────

suite("WL-001 R3: the report states its provenance and refuses to imply a bill", () => {
  const dir = makeGitRepo("fixt13", [{ msg: "c", files: { "src/app/a.ts": lines(4) } }]);
  const root = makeTranscripts("fixt13", { "claude-opus-5": usage(10, 20, 30_000, 40) });
  const w = wl.computeWorkLedger(dir, { productPaths: { fixt13: ["src/app/**"] }, projectsRoot: root });
  const md = wl.renderReport([{ w, rows: [] }]);
  match(md, /computed from \*\*git\*\*/, "says where the figures come from");
  match(md, /Nothing here comes from what an agent wrote about itself/, "and where they do NOT");
  match(md, /list-price equivalent.+not a bill/is, "and that the dollars are not an invoice");
  match(md, /Cache reads are included/i, "and that cache reads are in the total");
  match(md, /NET, not churn/, "and what the denominator means");
  match(md, /No handoffs recorded/, "an empty handoff table says so rather than being blank");
});

suite("WL-001 R3: a handoff no commit names shows an em dash, not 0", () => {
  const dir = makeGitRepo("fixt14", [
    { msg: "WL-9 does the thing", files: { "src/app/a.ts": lines(6) } },
  ]);
  const repo = "fixt14";
  fs.mkdirSync(busPath(repo), { recursive: true });
  const now = new Date().toISOString();
  fs.writeFileSync(busPath(repo, "model-ledger.jsonl"), [
    JSON.stringify({ id: "WL-9", role: "dev", model: "claude-opus-5", loopBacks: 0, wallMinutes: 12, finished: now }),
    JSON.stringify({ id: "WL-8", role: "dev", model: "claude-opus-5", loopBacks: 1, wallMinutes: -3, finished: now }),
  ].join("\n"));
  const rows = wl.handoffRows(dir, repo, Date.now() - 7 * 86400000, { fixt14: ["src/app/**"] });
  const named = rows.find((r) => r.id === "WL-9");
  const unnamed = rows.find((r) => r.id === "WL-8");
  eq(named.linesShipped, 6, "the commit naming WL-9 attributes its product lines to it");
  eq(unnamed.linesShipped, null, "no commit names WL-8 — null, because that is not a measured 0");
  const md = wl.renderReport([{ w: wl.computeWorkLedger(dir, {}), rows }]);
  match(md, /— \(no commit names it\)/, "and the report renders it as such");
  match(md, /\| WL-8 \| dev \| claude-opus-5 \| 1 \| — \|/, "a negative wall time renders as a dash");
});

suite("WL-001 R3: the report survives a project with no git data at all", () => {
  const w = wl.computeWorkLedger(null, {});
  const md = wl.renderReport([{ w, rows: [] }]);
  match(md, /No git data/, "says so rather than throwing");
  ok(wl.renderReport([]).length > 0, "and an empty report is still a document");
});

// ── R3 / R5 · through the REAL extension: the registered command and the tick's nudge ─────────
// These run activate() so the command is exercised exactly as VS Code invokes it, and so R5's
// decision is made by the tick rather than by a unit call. Kept in THIS file rather than
// commands.test.js so WL-001 stays inside the files its handoff declared (§19).
const ext = load("extension.js");
const cdp = load("cdp.js");
const { setOrchestrator } = load("orchestrator.js");
const { vscode, readJson, settle } = require("./harness");

const marker = (r) => "\nLOOMROLE=" + r + "\n";
const footer = (m = "Opus 5") => `\nRemote Control\n${m}\nMedium\nBypass permissions\n`;
const frame = (webviewId, text) => ({ webviewId, text, contextPct: null, type: "iframe", targetUrl: "x" });
const run = (id, ...a) => vscode.commands.executeCommand("loomSessionTracker." + id, ...a);

/** A real git repo AT the window's project folder, so the tick measures something real. */
function gitProject(repo, files) {
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), "loom-wlcmd-"));
  const dir = path.join(parent, repo);
  fs.mkdirSync(dir, { recursive: true });
  vscode.workspace.workspaceFolders = [{ uri: { fsPath: dir } }];
  git(dir, ["init", "-q", "-b", "main"]);
  for (const [f, body] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(dir, f)), { recursive: true });
    fs.writeFileSync(path.join(dir, f), body);
  }
  git(dir, ["add", "-A"]);
  git(dir, ["commit", "-q", "-m", "seed"]);
  return dir;
}

/** Boot the extension with a scripted frame read and a harmless injector stub. */
async function activate(frames = []) {
  cdp.readFrames = async () => frames;
  cdp.closeWebview = async () => ({ ok: true, note: "closed" });
  fs.writeFileSync(path.join(LOOM, "loom_cdp.py"), "import sys\nprint(' '.join(sys.argv[1:]))\n");
  const context = { subscriptions: [], extensionPath: path.join(__dirname, "..") };
  ext.activate(context);
  await settle(120);
  return () => {
    ext.deactivate();
    for (const d of context.subscriptions) { try { d.dispose && d.dispose(); } catch { /* ignore */ } }
  };
}

suite("WL-001 R3: the command is registered and opens a MARKDOWN report", async () => {
  const repo = makeRepo({ roles: { alpha: {} } }, "wlcmdA");
  gitProject(repo, { "src/app/a.ts": "a\nb\nc\n", "guide/GUIDE.txt": "g\n" });
  const off = await activate([]);
  try {
    ok(vscode._commands["loomSessionTracker.workLedgerReport"], "registered by activate()");
    await run("workLedgerReport");
    await settle(250);
    const doc = vscode._shownDocs[vscode._shownDocs.length - 1];
    ok(doc, "a document was opened and shown");
    eq(doc.languageId, "markdown",
       "markdown, not a webview — a report exists to be pasted into a handoff");
    match(doc.content, /# Loom work ledger/, "titled");
    match(doc.content, new RegExp(`## ${repo}`), "names this project");
    match(doc.content, /Nothing here comes from what an agent wrote about itself/,
          "and carries the provenance rule on the page itself");
  } finally { off(); }
});

suite("WL-001 R5: a RED project's orchestrator is told ONCE, on an IDLE composer", async () => {
  const repo = makeRepo({ roles: { alpha: {} } }, "wlcmdB");
  // A week of pure narration: docs only, so shipsToUser is 0% — red.
  gitProject(repo, { "guide/GUIDE.txt": "g\n".repeat(50), "docs/PLAN.md": "p\n".repeat(20) });
  setOrchestrator(repo, "product-owner", "wid-po");
  vscode._config["loomSessionTracker.productPaths"] = { [repo]: ["src/app/**"] };
  const off = await activate([frame("wid-po",
    `working on ~/.claude/loom/${repo}/ ` + marker("product-owner") + footer("Fable 5.1"))]);
  try {
    await settle(400);
    const dbg = readJson(path.join(LOOM, "ledger-debug.json"));
    ok(dbg, "the orchestrator was told");
    match(String(dbg.message || ""), /\[loom-ledger\]/, "with the ledger line");
    match(String(dbg.message || ""), /reach a user/, "naming the shipping figure");
    const cache = readJson(busPath(repo, "work-ledger.json"));
    eq(cache.notifiedOn, new Date().toISOString().slice(0, 10),
       "and the day is stamped ON THE BUS, so a reload cannot re-announce it");
    fs.rmSync(path.join(LOOM, "ledger-debug.json"), { force: true });
    await run("refresh");
    await settle(250);
    eq(readJson(path.join(LOOM, "ledger-debug.json")), null, "once per project per calendar day");
  } finally { delete vscode._config["loomSessionTracker.productPaths"]; off(); }
});

suite("WL-001 R5: a BUSY orchestrator composer is never typed into, and the day is not spent", async () => {
  const repo = makeRepo({ roles: { alpha: {} } }, "wlcmdC");
  gitProject(repo, { "guide/GUIDE.txt": "g\n".repeat(50) });
  setOrchestrator(repo, "product-owner", "wid-po");
  vscode._config["loomSessionTracker.productPaths"] = { [repo]: ["src/app/**"] };
  // "esc to interrupt" is what marks a frame mid-turn. A line typed over a running turn is the
  // noise that gets a feature switched off in a week — the same discipline /model is held to.
  const off = await activate([frame("wid-po",
    `working on ~/.claude/loom/${repo}/ esc to interrupt` + marker("product-owner") + footer("Fable 5.1"))]);
  try {
    await settle(400);
    eq(readJson(path.join(LOOM, "ledger-debug.json")), null, "nothing typed into a running turn");
    const cache = readJson(busPath(repo, "work-ledger.json"));
    ok(cache && !cache.notifiedOn, "and today is still OWED — a later idle tick may still say it");
  } finally { delete vscode._config["loomSessionTracker.productPaths"]; off(); }
});

suite("WL-001 R5: with no orchestrator tagged, nobody is nudged — never a worker", async () => {
  const repo = makeRepo({ roles: { alpha: {} } }, "wlcmdD");
  gitProject(repo, { "guide/GUIDE.txt": "g\n".repeat(50) });
  vscode._config["loomSessionTracker.productPaths"] = { [repo]: ["src/app/**"] };
  const off = await activate([frame("wid-alpha", "working" + marker("alpha") + footer())]);
  try {
    await settle(400);
    eq(readJson(path.join(LOOM, "ledger-debug.json")), null,
       "a worker cannot choose what the next block builds, so a worker is never told");
  } finally { delete vscode._config["loomSessionTracker.productPaths"]; off(); }
});

suite("WL-001 R1: the tick writes the cache the panel reads, and honours the interval", async () => {
  const repo = makeRepo({ roles: { alpha: {} } }, "wlcmdE");
  gitProject(repo, { "src/app/a.ts": "a\n".repeat(30) });
  vscode._config["loomSessionTracker.productPaths"] = { [repo]: ["src/app/**"] };
  const off = await activate([]);
  try {
    await settle(400);
    const first = readJson(busPath(repo, "work-ledger.json"));
    ok(first && first.ledger, "the tick wrote a cache");
    eq(first.ledger.heuristic, false, "measured against the CONFIGURED product paths");
    eq(first.ledger.shipsToUser, 100, "all thirty changed lines are product");
    await run("refresh");
    await settle(250);
    eq(readJson(busPath(repo, "work-ledger.json")).ledger.computedAt, first.ledger.computedAt,
       "a second tick inside the interval reads the cache instead of re-running git");
  } finally { delete vscode._config["loomSessionTracker.productPaths"]; off(); }
});

suite("WL-001 R4: workLedgerEnabled=false measures nothing and writes nothing", async () => {
  const repo = makeRepo({ roles: { alpha: {} } }, "wlcmdF");
  gitProject(repo, { "guide/GUIDE.txt": "g\n".repeat(50) });
  setOrchestrator(repo, "product-owner", "wid-po");
  vscode._config["loomSessionTracker.workLedgerEnabled"] = false;
  const off = await activate([frame("wid-po",
    `~/.claude/loom/${repo}/` + marker("product-owner") + footer("Fable 5.1"))]);
  try {
    await settle(400);
    eq(readJson(busPath(repo, "work-ledger.json")), null, "no cache written");
    eq(readJson(path.join(LOOM, "ledger-debug.json")), null, "and nobody nudged");
  } finally { delete vscode._config["loomSessionTracker.workLedgerEnabled"]; off(); }
});
