// fixtures.test.js — FX-002. The suite must not leave its fixtures on the host.
//
// MEASURED 2026-09-15: 15 helpers called `fs.mkdtempSync(os.tmpdir(), "loom-…")` and nothing removed
// the result. Six days of runs left 892,449 directories in /tmp holding 12,201,926 inodes — 97.6% of
// the filesystem — and the host reached 100% of its inode table with 74 GB of disk FREE, so no
// space check on this box could see it. It killed a mutation gate mid-run, and a 168-mutant gate is
// 168 suite runs, which made the gate the amplifier.
//
// THESE TESTS ASSERT THE ABSENCE OF LEAKED DIRECTORIES, never the presence of an `rmSync` call. A
// test that greps the source for a teardown passes against a teardown that never runs — the same
// asserted-is-not-reached failure this project has now hit four times.
const { suite, ok, eq, fixtureDir, sweepFixtures, tmpFixtureCount } = require("./harness");
const fs = require("fs");
const os = require("os");
const path = require("path");

suite("FX-002: a fixture directory is gone after the sweep — the count returns to where it started", () => {
  const before = tmpFixtureCount();
  const a = fixtureDir("loom-fxtest-");
  const b = fixtureDir("loom-fxtest-");
  ok(fs.existsSync(a) && fs.existsSync(b), "both fixtures exist while the suite is using them");
  eq(tmpFixtureCount(), before + 2, "and they are visible in the temp root");
  sweepFixtures();
  ok(!fs.existsSync(a), "the first is gone");
  ok(!fs.existsSync(b), "the second is gone");
  eq(tmpFixtureCount(), before, "the count is back where it started — nothing left on the host");
});

suite("FX-002: a fixture with CONTENT is removed, not just an empty directory", () => {
  const before = tmpFixtureCount();
  const dir = fixtureDir("loom-fxtest-");
  fs.mkdirSync(path.join(dir, "nested", "deeper"), { recursive: true });
  fs.writeFileSync(path.join(dir, "nested", "deeper", "f.txt"), "x");
  sweepFixtures();
  ok(!fs.existsSync(dir), "a populated tree is removed recursively");
  eq(tmpFixtureCount(), before, "and leaves nothing behind");
});

suite("FX-002: a fixture whose test THREW is still swept — the owner is the runner, not the test", () => {
  // The whole reason the sweep lives in run-tests.js's `finally` rather than at the end of each
  // suite body: the leak that mattered was the one on the failing path.
  const before = tmpFixtureCount();
  let dir = null;
  try {
    dir = fixtureDir("loom-fxtest-");
    throw new Error("a test failing mid-suite");
  } catch { /* exactly what the runner catches */ }
  ok(fs.existsSync(dir), "the fixture outlived the throw, as it must to be usable");
  sweepFixtures();                                   // what the runner's `finally` does
  ok(!fs.existsSync(dir), "and the runner still reclaimed it");
  eq(tmpFixtureCount(), before, "a red suite leaks nothing either");
});

suite("FX-002: a removal that FAILS does not turn a green suite red", () => {
  const dir = fixtureDir("loom-fxtest-");
  fs.rmSync(dir, { recursive: true, force: true });   // gone from under the sweep
  sweepFixtures();                                    // must not throw
  ok(true, "best-effort by design: hygiene must never fail a correctness run");
});

suite("FX-002: the sweep is exhaustive — nothing is left registered afterwards", () => {
  const before = tmpFixtureCount();
  for (let i = 0; i < 5; i++) fixtureDir("loom-fxtest-");
  eq(tmpFixtureCount(), before + 5, "five registered");
  sweepFixtures();
  eq(tmpFixtureCount(), before, "five reclaimed");
  sweepFixtures();
  eq(tmpFixtureCount(), before, "and a second sweep is a no-op, not a double-free");
});

suite("FX-002: NO test file creates a temp dir outside the registry", () => {
  // The structural half. Any new `fs.mkdtempSync(os.tmpdir(), …)` in a test file escapes both the
  // per-suite sweep and the gate's TMPDIR containment, so it is refused here by construction.
  const dir = __dirname;
  const self = path.basename(__filename);
  const offenders = [];
  // THE SCAN MUST SKIP ITSELF. This file names the banned call in its own regex and comments, so a
  // scan that includes it reports itself as the offender — which is exactly what it did on the first
  // run. Same shape as a mutation find-string that matches its own definition: a check whose subject
  // includes the checker is measuring the wrong thing.
  for (const f of fs.readdirSync(dir).filter((n) => n.endsWith(".test.js") && n !== self)) {
    const src = fs.readFileSync(path.join(dir, f), "utf8");
    // The CALL, not the word: `fs.mkdtempSync(` followed anywhere by the process-wide temp root.
    if (/mkdtempSync\s*\(\s*path\.join\s*\(\s*os\.tmpdir\s*\(/.test(src)) offenders.push(f);
  }
  eq(offenders, [], "every fixture goes through fixtureDir() — these do not: " + offenders.join(", "));
});

suite("FX-002: the temp root is redirectable, which is what contains the mutation gate", () => {
  // The gate points TMPDIR inside its throwaway tree so the suite's fixtures land where its own
  // rmtree already reaches. That only works if os.tmpdir() honours TMPDIR — asserted, not assumed.
  eq(os.tmpdir(), process.env.TMPDIR || os.tmpdir(), "os.tmpdir() follows TMPDIR when it is set");
  if (process.env.LOOM_TEST_SANDBOX) {
    ok(os.tmpdir().startsWith(process.env.LOOM_TEST_SANDBOX),
       `the runner already redirects it into the per-file sandbox (${os.tmpdir()})`);
  }
});
