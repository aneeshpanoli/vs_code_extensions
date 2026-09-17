// corpus.test.js — AN-001. A stale mutation anchor must break the SUITE, not wait for a gate.
//
// MEASURED AT c1f94bb: seven of the 350 anchors in test/mutation.py did not match their file
// uniquely — four matched nothing, three had come to match TWICE because the code grew a second
// identical site. An anchor that matches nothing means the mutant is never applied, so it grades
// nothing, AND THE RUN REPORTS A CLEAN CORPUS. Three of the seven were rotted by this project's own
// commits weeks earlier and nobody saw it, because the only thing that checked anchors was the
// pre-flight of a full 350-mutant gate — an hours-long run nobody does while building.
//
// So the check lives here too, where it costs a fraction of a second and runs on `./test.sh` like
// everything else. It calls mutation.py's OWN `anchor_scan`, never a reimplementation of the
// counting: a second copy of the rule is a second thing to rot.
//
// WHAT IT DOES NOT COVER, said here because the first draft of this comment overstated it: a
// FILTERED run (`./test.sh overlap.test.js`) does not load this file, by TI-001's rule that a
// targeted run requires only the files it named. The whole suite carries it; a targeted run does not.
const { suite, ok, eq, match, fixtureDir } = require("./harness");
const { spawnSync } = require("child_process");
const path = require("path");
const fs = require("fs");

const ROOT = path.resolve(__dirname, "..");

// Written by mutation.py's `make_tree` into every throwaway copy it makes. NOTHING in this file is
// asserted inside one, and the reason is not tidiness: inside a mutant copy exactly one anchor is
// bent ON PURPOSE, so the corpus assertion is false there BY CONSTRUCTION. Left ungated it would
// fail in all 349 mutant trees and mark every mutant "caught" for a reason that is not the defect —
// an unreadable scoreboard, which is the 2026-09-13 failure in a new costume.
//
// IT IS A FILE AND NOT AN ENVIRONMENT VARIABLE because the first version was `LOOM_MUTANT_TREE=1`,
// and one `export` in a shell then deleted this whole file's coverage while still printing a pass.
// A marker that switches a check off has to be harder to set than the check is to run, and the
// branch it selects asserts its own premise below rather than asserting nothing.
const IN_MUTANT_TREE = fs.existsSync(path.join(ROOT, ".mutant-tree"));

const PY = `
import importlib.util, pathlib, json, sys
root = pathlib.Path(sys.argv[1])
spec = importlib.util.spec_from_file_location("mutation", root / "test/mutation.py")
m = importlib.util.module_from_spec(spec); spec.loader.exec_module(m)
rows = [(i, t) for i, t in enumerate(m.MUTATIONS)] + [("noop", tuple(m.NOOP_SELFCHECK))]
bad = m.anchor_scan(rows)
print(json.dumps({"total": len(rows), "bad": [[str(b[0]), b[1], b[3]] for b in bad],
                  "files": sorted({r[1][1] for r in rows})}))
`;

/** {total, bad, files} — from mutation.py itself, run against `root`. */
function scanIn(root) {
  const r = spawnSync("python3", ["-c", PY, root], { encoding: "utf8", timeout: 60000 });
  // A MISSING python3 IS A FAILURE, NOT A SKIP. The first version returned early and every suite
  // below then asserted `ok(true)`: on a box without python3 the report was BYTE-IDENTICAL to a
  // clean corpus — `7/7 passed`, exit 0, including the suite named "the check can go red". That is
  // this block's own defect (the evidence of a hole looking exactly like success) reproduced inside
  // the fix for it. The corpus is a python table and the gate is a python script, so a host that
  // cannot run python3 cannot make this claim and must not print a pass.
  ok(!(r.error && r.error.code === "ENOENT"),
     "python3 must be on this host — the mutation corpus is a python table, and without it the " +
     "anchor check cannot be made at all. A check that cannot be made is red, never green.");
  ok(r.status === 0, `python3 could not read the corpus: ${(r.stderr || "").slice(-400)}`);
  return JSON.parse(r.stdout.trim().split("\n").pop());
}

if (IN_MUTANT_TREE) {
  suite("AN-001: the marker that skips the corpus check must itself be in a real mutant copy", () => {
    // The branch asserts its own premise instead of asserting nothing. A `.mutant-tree` sitting in
    // the actual checkout would silently disable every suite below, so the one thing worth checking
    // here is that this tree is NOT the checkout: mutation.py's copies live under TMPDIR and are
    // not inside any work tree.
    const r = spawnSync("git", ["rev-parse", "--is-inside-work-tree"], { cwd: ROOT, encoding: "utf8" });
    const inWorkTree = r.status === 0 && r.stdout.trim() === "true";
    ok(!inWorkTree,
       `.mutant-tree marks ${ROOT} as one of mutation.py's throwaway copies, but it is inside a git ` +
       `work tree — so either the marker leaked into the checkout and the corpus check is silently ` +
       `off, or a copy was made somewhere it should not be. Delete ${path.join(ROOT, ".mutant-tree")}.`);
  });
} else {

suite("AN-001: the mutation corpus is importable DATA, and reading it runs no gate", () => {
  // WC-001's guard, asserted from the outside: `import mutation` must not copy a tree, compile
  // anything or run a suite. If that ever regresses, this check becomes the expensive thing it
  // exists not to be — and the 60s timeout in `scanIn` is what would catch it.
  const s = scanIn(ROOT);
  ok(s.total > 300, `the corpus has ${s.total} anchors — the table plus the no-op self-check`);
});

suite("AN-001: EVERY anchor in the corpus occurs exactly ONCE in the file it names", () => {
  const s = scanIn(ROOT);
  const detail = s.bad.map(([i, nm, why]) => `\n    [${i}] ${why}\n         ${nm}`).join("");
  eq(s.bad.length, 0,
     `${s.bad.length} of ${s.total} anchors grade NOTHING while a gate would report a clean corpus:${detail}`);
});

suite("AN-001: every file the corpus names still exists — a mutant on deleted code grades nothing", () => {
  // The other half of staleness, and the one with no repair: if the file is gone the mutant must be
  // RETIRED, not re-anchored. Counted separately so the failure names the right fix.
  //
  // The paths come from the TABLE, not from a regex over mutation.py's text. The first version of
  // this suite matched `"src/*.ts",` lines and so checked 29 of the 32 files the corpus names — two
  // under test/ and live-check.js at the root were invisible to a suite whose name said "every".
  const s = scanIn(ROOT);
  ok(s.files.length > 25, `the corpus names ${s.files.length} distinct files`);
  const missing = s.files.filter((f) => !fs.existsSync(path.join(ROOT, f)));
  eq(missing.length, 0, `the corpus names files that no longer exist: ${missing.join(", ")}`);
});

// ── THE OTHER DIRECTION · the check must go RED ──────────────────────────────────────────────────
// Every suite above asserts a CLEAN corpus, and a guard that has only ever agreed with the world is
// indistinguishable from one that cannot disagree. This project shipped an overlap guard that had
// never refused anything (OV-001) and a comment counter-rule that was simply broken (CM-001), both
// green the whole time. So the rot is staged in a COPY of the tree and the real `anchor_scan` is run
// against it — it reads the tree its own mutation.py sits in, so a fixture tree is the only way to
// ask it about a corpus that is stale. Never the live source.
//
// The staged entry is SYNTHETIC. The first version bent a live anchor by its literal text — the
// extension.ts import line, one of the seven that had just rotted — so the guard against anchor rot
// was itself anchored on rot-prone text. This appends an entry that exists only inside the fixture,
// so nothing here can decay with the corpus.
const PROBE = "AN-001 fixture probe — exists only inside this fixture";
function rotted(find) {
  const dir = fixtureDir("loom-corpus-");
  // The same item list as mutation.py's own `make_tree`, and a list rather than just `src` for the
  // same reason: the corpus anchors into test/run-tests.js, test/harness.js and live-check.js too,
  // so a fixture holding only src/ reports 18 stale anchors that are an artefact of the fixture.
  for (const item of ["src", "test", "package.json", "tsconfig.json", "test.sh", "live-check.js"]) {
    fs.cpSync(path.join(ROOT, item), path.join(dir, item), { recursive: true });
  }
  // Appended at the END, so the entry is there when the table is IMPORTED and absent when
  // mutation.py runs as a script (the gate exits inside `__main__`, above this line).
  fs.appendFileSync(path.join(dir, "test", "mutation.py"),
                    `\nMUTATIONS.append((${JSON.stringify(PROBE)}, "src/extension.ts", ` +
                    `${JSON.stringify(find)}, ${JSON.stringify(find)}))\n`);
  return dir;
}

suite("AN-001: an anchor that matches NOTHING is named by the scan — the check can go red", () => {
  const s = scanIn(rotted('import { NOTHING_LIKE_THIS_EXISTS } from "./cdp";'));
  eq(s.bad.length, 1, "exactly the staged anchor is reported, and nothing else drifts with it");
  eq(s.bad[0][1], PROBE, "and it is the staged one, not a live entry");
  match(s.bad[0][2], /src\/extension\.ts: pattern occurs 0 time\(s\), expected 1/,
        "naming the file and how many times it matched");
});

suite("AN-001: an anchor that matches TWICE is named too — a duplicate mutates two sites at once", () => {
  // The direction developer1 did not meet and this block did: three of the seven stale anchors at
  // HEAD matched twice, because the code grew a second identical site. Python's `str.replace`
  // replaces EVERY occurrence, so a duplicated anchor restores two defects at once and a catch
  // cannot say which of them it caught.
  const s = scanIn(rotted("import "));
  eq(s.bad.length, 1, "the duplicated anchor is the one reported");
  eq(s.bad[0][1], PROBE, "and it is the staged one");
  match(s.bad[0][2], /occurs ([2-9]|\d\d+) time\(s\), expected 1/, "with a count above one, not zero");
});

suite("AN-001: stale INSIDE the run refuses; stale ELSEWHERE reports; strict escalates", () => {
  // `anchor_verdict` is the branch the whole shape turns on, so it is asserted directly rather than
  // through a gate run: grading 349 mutants to test an if-statement is how a branch stays untested.
  const r = spawnSync("python3", ["-c", `
import importlib.util, pathlib, json, sys
spec = importlib.util.spec_from_file_location("mutation", pathlib.Path(sys.argv[1]) / "test/mutation.py")
m = importlib.util.module_from_spec(spec); spec.loader.exec_module(m)
S = [(7, "n7", "src/a.ts", "why7"), (9, "n9", "src/b.ts", "why9")]
out = {
  "inside":  m.anchor_verdict(S, {7}, False)[0],
  "outside": m.anchor_verdict(S, {1}, False)[0],
  "strict":  m.anchor_verdict(S, {1}, True)[0],
  "clean":   m.anchor_verdict([], {1}, True)[0],
  "counts":  [len(m.anchor_verdict(S, {7}, False)[1]), len(m.anchor_verdict(S, {7}, False)[2])],
  "selects": [len(m.select([])), len(m.select(["src/overlap.ts"])), len(m.select(["no-such-mutant"]))],
}
print(json.dumps(out))
`, ROOT], { encoding: "utf8", timeout: 60000 });
  ok(!(r.error && r.error.code === "ENOENT"), "python3 must be on this host — see scanIn");
  ok(r.status === 0, `python3 failed: ${(r.stderr || "").slice(-400)}`);
  const v = JSON.parse(r.stdout.trim().split("\n").pop());
  eq(v.inside, "refuse", "a hole where the run is looking stops the run");
  eq(v.outside, "report", "an anchor somebody else rotted does NOT block work on this defect");
  eq(v.strict, "refuse", "MUTATION_STRICT_ANCHORS=1 makes the whole corpus a gate");
  eq(v.clean, "clean", "and a clean corpus is clean under strict too");
  eq(v.counts[0], 1, "the graded-stale list carries the one inside the selection");
  eq(v.counts[1], 1, "and the other is reported as elsewhere, not lost");
  ok(v.selects[0] > v.selects[1] && v.selects[1] > 0, "a file selects some of the corpus, not all and not none");
  eq(v.selects[2], 0, "and a selector matching nothing selects nothing — the gate refuses on that");
});

suite("AN-001: a selector that matches no mutant REFUSES — an empty run is not a green one", () => {
  // TI-001's rule, met again one file over: the gate must not print a clean sheet for a run that
  // graded zero mutants. Exercised in a FIXTURE tree, and it exits before any tree copy, compile or
  // suite run — this test never starts a gate.
  const dir = rotted('import { readFrames, openWindowRoots } from "./cdp";');
  const r = spawnSync("python3", [path.join(dir, "test", "mutation.py"), "no-such-mutant-anywhere"],
                      { encoding: "utf8", timeout: 60000 });
  ok(!(r.error && r.error.code === "ENOENT"), "python3 must be on this host — see scanIn");
  eq(r.status, 3,
     `exit 3, the code ./test.sh uses for an empty run — got ${r.status}: ${(r.stdout || "").slice(0, 300)}`);
  match(r.stdout, /selects 0 of the \d+ mutants/, "and it says so rather than reporting a clean corpus");
  // The corpus-wide line comes FIRST, so even the run that grades nothing reports the corpus.
  match(r.stdout, /anchor check \(WHOLE corpus, \d+ anchors\)/, "having already reported the corpus");
});

}   // end: not inside a mutant copy
