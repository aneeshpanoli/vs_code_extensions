// duties.test.js — DU-001 §19: two live blocks on one file.
//
// Every exclusion is asserted in BOTH directions. That is not padding: this detector's whole risk is
// that an exclusion added to stop a false positive also swallows the true positive it was supposed
// to leave alone. Four reminders exist on this bus and one of them was wrong four times in two days;
// a fifth that misfires costs more than it saves.

const { suite, eq, ok, match, load, fixtureDir } = require("./harness");

const {
  isCollidable,
  SERIALISED_BY_PROCESS,
  NOT_SOURCE,
  collisions,
  parsePorcelain,
  gatherWork,
  overlapFinding,
  markOverlapReminded,
  overlapReminder,
  emptyOverlapState,
  pairKey,
  loadOverlapState,
  saveOverlapState,
} = load("duties.js");

const work = (role, handoff, files) => ({ role, handoff, files });

// ── THE CONDITION ITSELF ───────────────────────────────────────────────────────────────────────

suite("DU-001 §19: two live roles on one file is the finding", () => {
  const found = collisions([
    work("developer1", "OV-001", ["src/models.ts", "src/overlap.ts"]),
    work("developer2", "DU-001", ["src/duties.ts", "src/overlap.ts"]),
  ]);
  eq(found.length, 1, "one pair, one finding");
  eq(found[0].files, ["src/overlap.ts"], "and it names the file they actually share");
  eq(found[0].roles, ["developer1", "developer2"], "roles sorted, so the pair has one identity");
  eq(found[0].handoffs, ["OV-001", "DU-001"], "handoffs travel in the same order as the roles");
});

suite("DU-001 §19: two live roles on DIFFERENT files is not a finding", () => {
  // The other direction of the test above. §19 is not "two workers are live" — parallel work on
  // disjoint files is the thing the Loom exists to make possible.
  const found = collisions([
    work("developer1", "OV-001", ["src/models.ts", "src/overlap.ts"]),
    work("developer2", "DU-001", ["src/duties.ts", "src/inject.ts"]),
  ]);
  eq(found.length, 0, "no shared file, nothing to say");
});

suite("DU-001 §19: the pair identity does not depend on the order the roles arrived in", () => {
  const a = collisions([
    work("developer2", "DU-001", ["src/x.ts"]),
    work("developer1", "OV-001", ["src/x.ts"]),
  ]);
  const b = collisions([
    work("developer1", "OV-001", ["src/x.ts"]),
    work("developer2", "DU-001", ["src/x.ts"]),
  ]);
  eq(pairKey(a[0]), pairKey(b[0]), "same pair, same latch key, whichever role the board listed first");
  eq(a[0].handoffs, b[0].handoffs, "and the handoffs stay attached to the right roles");
});

// ── FALSE POSITIVE 1 · FILES THE BUS SERIALISES ON PURPOSE ─────────────────────────────────────

suite("DU-001: package.json does NOT fire — the bus already serialises the version bump", () => {
  // Every block bumps the manifest, so without this the detector fires on every pair of live blocks
  // forever. It is a true collision that the orchestrator has already solved by assigning each block
  // its own version, so a reminder adds nothing and costs believability.
  const found = collisions([
    work("developer1", "OV-001", ["loom-session-tracker/package.json"]),
    work("developer2", "DU-001", ["loom-session-tracker/package.json"]),
  ]);
  eq(found.length, 0, "the one collision the process has already solved stays silent");
  ok(!isCollidable("loom-session-tracker/package.json"), "and the path itself is excluded");
  ok(!isCollidable("package.json"), "at the repo root too");
  ok(!isCollidable("package-lock.json"), "and the lockfile that moves with it");
});

suite("DU-001: the manifest exclusion does NOT swallow a real collision alongside it", () => {
  // THE OTHER DIRECTION, and the one that matters. Two roles sharing package.json AND a source file
  // must still report the source file — an exclusion that suppressed the whole pair because one of
  // its files was a manifest would hide exactly what this detector exists to find.
  const found = collisions([
    work("developer1", "OV-001", ["loom-session-tracker/package.json", "src/extension.ts"]),
    work("developer2", "DU-001", ["loom-session-tracker/package.json", "src/extension.ts"]),
  ]);
  eq(found.length, 1, "the pair still reports");
  eq(found[0].files, ["src/extension.ts"], "naming the real collision, and not the manifest");
});

suite("DU-001: the exclusion is keyed on the FILE, not on a substring of it", () => {
  // `package.json` must not exclude a source file that merely contains the word.
  ok(isCollidable("src/package.json.ts"), "a source file named after the manifest still collides");
  ok(isCollidable("src/packagejson.ts"), "nor does a near-miss match");
  ok(isCollidable("test/fixtures/package.json.fixture"), "a fixture is not the manifest");
});

// ── FALSE POSITIVE 2 · BUILD OUTPUT ────────────────────────────────────────────────────────────

suite("DU-001: two workers both compiling is not a §19 finding", () => {
  const found = collisions([
    work("developer1", "OV-001", ["out/extension.js", "out/models.js"]),
    work("developer2", "DU-001", ["out/extension.js", "out/duties.js"]),
  ]);
  eq(found.length, 0, "build output collides constantly and means nothing");
  ok(!isCollidable("out/extension.js"), "out/");
  ok(!isCollidable("node_modules/x/index.js"), "dependencies");
  ok(!isCollidable("dist/bundle.js"), "dist/");
});

suite("DU-001: the build exclusion does NOT swallow the SOURCE of the same name", () => {
  // The direction that would quietly break the detector: excluding `out/extension.js` must never
  // exclude `src/extension.ts`, which is the single most collided source file on this repo.
  ok(isCollidable("src/extension.ts"), "the source still collides");
  ok(isCollidable("loom-session-tracker/src/extension.ts"), "including under a subdirectory");
  const found = collisions([
    work("developer1", "OV-001", ["out/extension.js", "src/extension.ts"]),
    work("developer2", "DU-001", ["out/extension.js", "src/extension.ts"]),
  ]);
  eq(found.length, 1, "the pair reports");
  eq(found[0].files, ["src/extension.ts"], "on the source, not the artefact");
});

// ── FALSE POSITIVE 3 · A BUS WITH ONE LIVE WORKER ──────────────────────────────────────────────

suite("DU-001: one live role can never collide — most buses are in this state", () => {
  eq(collisions([work("developer1", "OV-001", ["src/a.ts"])]).length, 0, "a single role");
  eq(collisions([]).length, 0, "no roles at all");
  eq(collisions([work("developer1", "OV-001", [])]).length, 0, "a role that has touched nothing");
  // A role with no files is not live work: it must not pair with one that has.
  eq(collisions([
    work("developer1", "OV-001", []),
    work("developer2", "DU-001", ["src/a.ts"]),
  ]).length, 0, "one role idle, nothing to sequence");
});

// ── FALSE POSITIVE 4 · A ROLE NEVER COLLIDES WITH ITSELF ───────────────────────────────────────

suite("DU-001: a role listed twice does not report itself", () => {
  // A stale board entry beside a live one would otherwise be a permanent self-collision.
  const found = collisions([
    work("developer1", "OV-001", ["src/a.ts"]),
    work("developer1", "OV-001", ["src/a.ts"]),
  ]);
  eq(found.length, 0, "the same role on both sides is not a pair");
});

suite("DU-001: three live roles report every colliding pair, not just the first", () => {
  const found = collisions([
    work("developer1", "A-001", ["src/a.ts"]),
    work("developer2", "B-001", ["src/a.ts"]),
    work("developer3", "C-001", ["src/a.ts"]),
  ]);
  eq(found.length, 3, "three roles on one file is three pairs");
});

// ── THE LATCH ──────────────────────────────────────────────────────────────────────────────────

suite("DU-001: the latch is on the PAIR OF BLOCKS, so one collision is one message", () => {
  const found = collisions([
    work("developer1", "OV-001", ["src/x.ts"]),
    work("developer2", "DU-001", ["src/x.ts"]),
  ]);
  const first = overlapFinding(emptyOverlapState(), found);
  ok(first.finding, "the first sight of this pair reports");
  const after = markOverlapReminded(first.state, first.finding);
  const second = overlapFinding(after, found);
  eq(second.finding, null, "and the second tick does not");
  match(second.skip, /already reminded/, "and says why");
});

suite("DU-001: the latch re-arms on a NEW BLOCK, not on the condition clearing", () => {
  // THE ANTI-PRECEDENT, named in the source: the stall alarm re-armed whenever its condition
  // cleared, so a flickering worker produced four wrong alarms in two days. Here the condition
  // going away and coming back must NOT re-arm — only a genuinely new pair of blocks does.
  const before = collisions([
    work("developer1", "OV-001", ["src/x.ts"]),
    work("developer2", "DU-001", ["src/x.ts"]),
  ]);
  let st = markOverlapReminded(emptyOverlapState(), before[0]);

  // the condition clears (one role stops touching the file) and then returns, same blocks
  eq(overlapFinding(st, []).finding, null, "nothing to report while it is clear");
  eq(overlapFinding(st, before).finding, null, "and its RETURN does not re-arm — same two blocks");

  // one role moves to a new block: a genuinely new collision
  const after = collisions([
    work("developer1", "OV-002", ["src/x.ts"]),
    work("developer2", "DU-001", ["src/x.ts"]),
  ]);
  ok(overlapFinding(st, after).finding, "a new block on either side is a new finding");
});

suite("DU-001: a second, different pair still reports while the first is latched", () => {
  const st = markOverlapReminded(
    emptyOverlapState(),
    collisions([work("developer1", "A-001", ["src/x.ts"]), work("developer2", "B-001", ["src/x.ts"])])[0],
  );
  const other = collisions([
    work("developer1", "A-001", ["src/y.ts"]),
    work("developer3", "C-001", ["src/y.ts"]),
  ]);
  ok(overlapFinding(st, other).finding, "latching one pair must not silence another");
});

// ── READING THE WORKTREES ──────────────────────────────────────────────────────────────────────

suite("DU-001: porcelain parsing covers the states a worker's tree is actually in", () => {
  const files = parsePorcelain(
    " M src/inject.ts\n?? src/duties.ts\nA  test/duties.test.js\n D src/gone.ts\n",
  );
  ok(files.includes("src/inject.ts"), "modified");
  ok(files.includes("src/duties.ts"), "untracked — a brand-new file is the commonest collision");
  ok(files.includes("test/duties.test.js"), "added");
  ok(files.includes("src/gone.ts"), "deleted — one role deleting what another edits IS a collision");
  eq(parsePorcelain(null), [], "and an unreadable tree yields nothing rather than throwing");
  eq(parsePorcelain(""), [], "as does an empty one");
});

suite("DU-001: a rename reports the NEW path, which is the one that will conflict", () => {
  eq(parsePorcelain("R  src/old.ts -> src/new.ts\n"), ["src/new.ts"]);
});

suite("DU-001: BOTH halves of a role's work are gathered — committed and not", () => {
  // Each half alone is a defect. Measured on this bus 2026-09-17: the role working OV-001 had ZERO
  // committed files and its entire block lived in uncommitted state, so a branch-diff-only detector
  // would have been blind to it; and a worker that has committed but not merged is invisible to
  // `status --porcelain`.
  const calls = [];
  const fakeGit = (cwd, args) => {
    calls.push(args.join(" "));
    if (args[0] === "diff") return "src/committed.ts\n";
    if (args[0] === "status") return " M src/uncommitted.ts\n";
    return null;
  };
  const w = gatherWork("/wt/developer1", "main", "OV-001", "developer1", fakeGit);
  eq(w.files, ["src/committed.ts", "src/uncommitted.ts"], "both halves, sorted");
  eq(w.role, "developer1");
  eq(w.handoff, "OV-001");
  ok(calls.some((c) => /main\.\.\.HEAD/.test(c)),
     "the THREE-dot form: what this branch changed, not what landed on main meanwhile");
});

suite("DU-001: a worktree git cannot break the tick", () => {
  const w = gatherWork("/nope", "main", "X-001", "developer1", () => null);
  eq(w.files, [], "an unreadable worktree contributes nothing and throws nothing");
  eq(collisions([w, work("developer2", "Y-001", ["src/a.ts"])]).length, 0);
});

// ── THE MESSAGE ────────────────────────────────────────────────────────────────────────────────

suite("DU-001: the reminder names the file and both blocks, and does not say 'refactor'", () => {
  const c = collisions([
    work("developer1", "OV-001", ["src/extension.ts", "src/models.ts"]),
    work("developer2", "DU-001", ["src/extension.ts", "src/models.ts"]),
  ])[0];
  const msg = overlapReminder(c);
  match(msg, /\[loom-overlap\]/, "tagged like every other reminder");
  match(msg, /developer1/, "names the first role");
  match(msg, /developer2/, "and the second");
  match(msg, /OV-001/, "names the first block");
  match(msg, /DU-001/, "and the second");
  match(msg, /src\/extension\.ts/, "and the file");
  match(msg, /\+1 more/, "counting the rest rather than listing them");
  match(msg, /§19/, "and cites the clause it is enforcing");
  // The measurement supports "these two are on it now". It does NOT support a claim about how the
  // file should be shaped — the history metric that would have claimed that was refuted and removed.
  ok(!/refactor|split/i.test(msg), "it does not tell anyone to refactor: that is not what was measured");
  eq(msg.split("\n").length, 2, "two lines — a duty list appended to a message is the banned shape");
});

suite("DU-001: with one shared file the message does not claim there are more", () => {
  const c = collisions([
    work("developer1", "OV-001", ["src/x.ts"]),
    work("developer2", "DU-001", ["src/x.ts"]),
  ])[0];
  ok(!/more/.test(overlapReminder(c)), "no '+0 more'");
});

// ── STATE FILE ─────────────────────────────────────────────────────────────────────────────────

suite("DU-001: the latch survives a restart, and a quiet tick does not rewrite the file", () => {
  const fs = require("fs");
  // FX-002: through the registry, never `mkdtempSync(os.tmpdir(), …)` — the runner owns the
  // removal, so a suite that throws still gives its fixture back, and the gate's TMPDIR contains it.
  const root = fixtureDir("loom-du-state-");
  const st = markOverlapReminded(
    emptyOverlapState(),
    collisions([work("developer1", "A-001", ["src/x.ts"]), work("developer2", "B-001", ["src/x.ts"])])[0],
  );
  ok(saveOverlapState("repo", st, root), "written");
  eq(loadOverlapState("repo", root).reported, st.reported, "and read back identically");
  eq(saveOverlapState("repo", st, root), false, "an unchanged state is not rewritten");
  eq(loadOverlapState("repo", root).reported, st.reported, "and is still intact after the no-op");
  fs.rmSync(root, { recursive: true, force: true });
});

suite("DU-001: a missing or corrupt state file is a fresh latch, never a crash", () => {
  const fs = require("fs"), path = require("path");
  const root = fixtureDir("loom-du-state-");            // FX-002 · registered, swept by the runner
  eq(loadOverlapState("absent", root).reported, {}, "absent");
  fs.mkdirSync(path.join(root, "bad"), { recursive: true });
  fs.writeFileSync(path.join(root, "bad", "duties-state.json"), "{not json");
  eq(loadOverlapState("bad", root).reported, {}, "corrupt");
  fs.rmSync(root, { recursive: true, force: true });
});
