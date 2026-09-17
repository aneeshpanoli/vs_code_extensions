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
const { suite, ok, eq, match, fixtureDir, sweepFixtures, tmpFixtureCount } = require("./harness");
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

suite("FX-002: THE RUNNER sweeps after a suite that FAILED — exercised through the real runner", () => {
  // A SURVIVING MUTANT WROTE THIS TEST. `if (!fail) H.sweepFixtures()` passed the whole suite,
  // because the "a fixture whose test THREW" test above calls sweepFixtures() itself — it proves the
  // helper works and says nothing about whether the runner calls it on the failing path. Asserted is
  // not reached, for the fifth time in this project. So this spawns the actual runner on a suite that
  // actually throws, with TMPDIR pointed somewhere we can count, and asserts the directory is empty.
  const { execFileSync } = require("child_process");
  const sandbox = fixtureDir("loom-fxrun-");
  const tmp = path.join(sandbox, "tmp");
  fs.mkdirSync(tmp, { recursive: true });
  let failed = false;
  try {
    execFileSync(process.execPath, [path.join(__dirname, "run-tests.js"), "--file", "_leak-fixture.js"],
      { env: { ...process.env, ELECTRON_RUN_AS_NODE: "1", HOME: sandbox,
               LOOM_TEST_SANDBOX: sandbox, TMPDIR: tmp },
        encoding: "utf8", timeout: 120000, stdio: ["ignore", "pipe", "pipe"] });
  } catch { failed = true; }                          // the fixture suite throws on purpose
  ok(failed, "the spawned suite really did fail — otherwise this proves nothing about the failing path");
  const left = fs.readdirSync(tmp).filter((n) => n.startsWith("loom-"));
  eq(left, [], "and the runner still reclaimed its fixture: " + left.join(", "));
});

suite("FX-002: the temp root is redirectable, which is what contains the mutation gate", () => {
  // The gate points TMPDIR inside its throwaway tree so the suite's fixtures land where its own
  // rmtree already reaches. That only works if os.tmpdir() honours TMPDIR — asserted, not assumed.
  // NOT `eq(os.tmpdir(), process.env.TMPDIR || os.tmpdir())` — that compares a value with itself and
  // passes vacuously whenever TMPDIR is unset. Assert it only when it is set.
  if (process.env.TMPDIR) {
    eq(os.tmpdir(), process.env.TMPDIR, "os.tmpdir() follows TMPDIR when TMPDIR is set");
  }
  if (process.env.LOOM_TEST_SANDBOX) {
    ok(os.tmpdir().startsWith(process.env.LOOM_TEST_SANDBOX),
       `the runner already redirects it into the per-file sandbox (${os.tmpdir()})`);
  }
});

// ── TI-001 · the runner must not lie about running, and must not litter when it dies ──
//
// These live here because this is the file that already owns "what the suite leaves on the host",
// and because both defects are the same shape as FX-002's: THE ASSERTION IS ON THE FILESYSTEM AND
// ON AN OBSERVED EXIT CODE, never on a call being made. A test that greps run-tests.js for a signal
// handler passes against a handler that never fires.
//
// EVERY suite below spawns the real runner, so each sets LOOM_TEST_NO_SPAWN in the child's
// environment and every one of them returns early when it is set. Without that a full-suite run
// executes this file, which spawns a full-suite run, which executes this file.
const { spawn, spawnSync } = require("child_process");
const RUNNER = path.join(__dirname, "run-tests.js");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const NESTED = Boolean(process.env.LOOM_TEST_NO_SPAWN);

/** A temp root we own and can count, and the environment a REAL parent run needs: no
 *  LOOM_TEST_SANDBOX (or the runner skips the parent branch that does all of this). */
function runnerEnv(tmp) {
  const env = { ...process.env, ELECTRON_RUN_AS_NODE: "1", TMPDIR: tmp, LOOM_TEST_NO_SPAWN: "1" };
  delete env.LOOM_TEST_SANDBOX;
  return env;
}
const sandboxesIn = (dir) => fs.readdirSync(dir).filter((n) => n.startsWith("loom-test-home-"));
const ownTmp = () => { const t = path.join(fixtureDir("loom-ti001-"), "tmp"); fs.mkdirSync(t, { recursive: true }); return t; };

/** R1 · NESTED OUTPUT IS DEFANGED BEFORE IT IS QUOTED. A failure message is printed by the runner
 *  indented, and mutation.py parses `✓`/`✗` lines out of the run's stdout to decide which tests
 *  passed. Quoting a nested runner's output verbatim would inject suite results that never ran at
 *  this level into the gate's evidence — the exit-code-as-evidence defect through a new door. */
const quiet = (out) => String(out || "").replace(/[✓✗]/g, "·");

/** The pid a sandbox says is living in it, or null. */
const stampOf = (dir) => {
  try { return Number(fs.readFileSync(path.join(dir, ".runner-pid"), "utf8").trim()) || null; }
  catch { return null; }
};
const alive = (pid) => { try { process.kill(pid, 0); return true; } catch (e) { return e.code === "EPERM"; } };

suite("TI-001: a filter that matches NOTHING exits non-zero — a zero-test run is never a pass", () => {
  if (NESTED) return;
  // The defect this replaces: `./test.sh <file>` filtered by suite NAME, so a file name matched no
  // suite, executed nothing, printed `0/0 passed` and EXITED 0. Playbook §23 makes a targeted run a
  // worker's only verification before it answers, so that is a worker reporting green having run
  // nothing. THE EXIT CODE IS THE ASSERTION — it is what a caller, a script and a gate all read.
  // Both spellings are checked, because both can select nothing.
  for (const arg of ["zzz-no-such-file.test.js", "zzz-no-such-suite"]) {
    const r = spawnSync(process.execPath, [RUNNER, arg],
      { env: runnerEnv(ownTmp()), encoding: "utf8", timeout: 600000 });
    ok(r.status !== 0, `"${arg}" executed nothing and must FAIL, got exit ${r.status}`);
    ok(!/\d+\/0 passed/.test(r.stdout || ""), "and must not word it as a pass: " + quiet(r.stdout).trim());
    match(r.stdout || "", /0 tests executed/, `"${arg}": it says what happened`);
    match(r.stdout || "", new RegExp(arg.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")), "and names what it looked for");
  }
});

suite("TI-001: a TEST FILE name runs that file's suites — the spelling §23 tells workers to use", () => {
  if (NESTED) return;
  // The other half of the same defect: it is not enough to fail loudly on nonsense, the obvious
  // spelling has to WORK. A non-zero count is the assertion, because zero is the failure mode.
  const r = spawnSync(process.execPath, [RUNNER, "naming.test.js"],
    { env: runnerEnv(ownTmp()), encoding: "utf8", timeout: 600000 });
  eq(r.status, 0, "a real file's suites pass: " + quiet(r.stdout).slice(-400));
  const m = /(\d+)\/(\d+) passed/.exec(r.stdout || "");
  ok(m, "it reported a count at all");
  ok(Number(m[2]) > 0, `and the count is NOT zero — got ${m && m[0]}`);
  eq(m[1], m[2], "all of them passed");
  match(r.stdout || "", /— 1 test files/, "and it loaded only the file it was asked for");
});

suite("TI-001: a suite-NAME filter is NOT narrowed to a file of the same name", () => {
  if (NESTED) return;
  // R1 · A DEFECT THE FIRST VERSION OF THIS CHANGE INTRODUCED, found by an adversarial pass. Trying
  // the file name first for ANY argument meant `./test.sh notifier` — documented at README.md:1001
  // — quietly stopped running the "notifier" suites that live in extension.test.js and ran only
  // notifier.test.js. Non-zero count, exit 0, so the guard above could not see it: a worker asks
  // for the tests of a thing and is told green by a subset of them.
  // THE ASSERTION IS THAT THE NAME FILTER IS A STRICT SUPERSET, which is exactly what was lost.
  const byName = spawnSync(process.execPath, [RUNNER, "notifier"],
    { env: runnerEnv(ownTmp()), encoding: "utf8", timeout: 600000 });
  const byFile = spawnSync(process.execPath, [RUNNER, "notifier.test.js"],
    { env: runnerEnv(ownTmp()), encoding: "utf8", timeout: 600000 });
  eq(byName.status, 0, "the name filter runs: " + quiet(byName.stdout).slice(-300));
  eq(byFile.status, 0, "the file filter runs: " + quiet(byFile.stdout).slice(-300));
  const count = (out) => Number((/(\d+)\/(\d+) passed/.exec(out || "") || [0, 0, 0])[2]);
  ok(count(byName.stdout) > 0 && count(byFile.stdout) > 0, "both executed something");
  ok(count(byName.stdout) > count(byFile.stdout),
     `the NAME filter must reach suites outside notifier.test.js — name ran ${count(byName.stdout)}, ` +
     `file ran ${count(byFile.stdout)}; equal means the file spelling swallowed the name spelling`);
});

suite("TI-001: an INTERRUPTED run leaves NO sandbox behind — counted on the temp root", async () => {
  if (NESTED) return;
  // MEASURED 2026-09-17 before the fix: killing a 6-second parallel run left 3 sandboxes holding
  // 337 inodes. developer1 reaped 42 trees holding 79,741 inodes from two killed gates the same
  // day; September's incident was 896,188 directories and 12.2M inodes at the same fault.
  // THE COUNT IS THE ASSERTION, taken from the directory, before and after.
  const tmp = ownTmp();
  eq(sandboxesIn(tmp).length, 0, "we start from an empty temp root we own");
  const child = spawn(process.execPath, [RUNNER],
    { env: { ...runnerEnv(tmp), LOOM_TEST_JOBS: "2" }, stdio: ["ignore", "pipe", "pipe"] });
  child.stdout.on("data", () => {}); child.stderr.on("data", () => {});
  let peak = 0;
  for (let i = 0; i < 300 && peak < 2; i++) { await sleep(100); peak = Math.max(peak, sandboxesIn(tmp).length); }
  ok(peak > 0, "the run really was mid-flight with sandboxes open — otherwise this proves nothing");
  child.kill("SIGTERM");
  await new Promise((r) => child.on("close", r));
  for (let i = 0; i < 100 && sandboxesIn(tmp).length; i++) await sleep(100);
  eq(sandboxesIn(tmp), [], `the killed run gave every sandbox back (peak was ${peak})`);
});

suite("TI-001: the SINGLE-PROCESS path is interruptible, and its sandbox names the process inside it", async () => {
  if (NESTED) return;
  // R1 · TWO DEFECTS THE ADVERSARIAL PASS REPRODUCED ON THIS HOST, both in the path the mutation
  // gate and every filtered run actually take:
  //   · the signal handlers SWALLOWED the signal — spawnSync blocks the event loop, so a SIGTERMed
  //     run was still going 13s later where the default disposition had killed it at once. An
  //     outer `timeout` or a reap stopped stopping the run.
  //   · the sandbox was stamped with the PARENT's pid, so a SIGKILLed parent left a live orphan
  //     whose HOME the next run's reaper deleted out from under it.
  // Both are asserted here against the real process and the real directory.
  const tmp = ownTmp();
  const child = spawn(process.execPath, [RUNNER],
    { env: { ...runnerEnv(tmp), LOOM_TEST_JOBS: "1" }, stdio: ["ignore", "pipe", "pipe"] });
  child.stdout.on("data", () => {}); child.stderr.on("data", () => {});
  // The parent stamps PROVISIONALLY with its own pid at mkdtemp — it is the only process alive at
  // that instant — and the occupant replaces it as its first act. So the assertion is that the
  // handover HAPPENS, promptly: poll until the stamp stops naming the parent. (This test caught
  // that race on itself first: it read the provisional stamp and reported the parent's pid.)
  let dir = null, stamp = null, provisional = null;
  for (let i = 0; i < 300 && stamp === null; i++) {
    await sleep(50);
    const found = sandboxesIn(tmp);
    if (!found.length) continue;
    dir = path.join(tmp, found[0]);
    const st = stampOf(dir);
    if (st === null) continue;
    if (st === child.pid) { provisional = st; continue; }
    stamp = st;
  }
  ok(dir, "the single-process run opened a sandbox");
  ok(stamp, `the process INSIDE took ownership of the stamp (it still read ${provisional}, the parent)`);
  ok(alive(stamp), "and whoever the stamp names is alive while the sandbox is in use — a reaper must never take it");
  const t0 = Date.now();
  child.kill("SIGTERM");
  await new Promise((r) => child.on("close", r));
  const took = Date.now() - t0;
  ok(took < 20000, `SIGTERM stopped it promptly (${took}ms) — the handlers must not swallow the signal`);
  for (let i = 0; i < 100 && sandboxesIn(tmp).length; i++) await sleep(100);
  eq(sandboxesIn(tmp), [], "and it gave its sandbox back");
});

suite("TI-001: the next run reaps what a SIGKILL abandoned — and never a sandbox still in use", () => {
  if (NESTED) return;
  // WHAT THE HANDLERS CANNOT COVER. SIGKILL is uncatchable, so the recovery is the next run's
  // reaper, and the only thing that makes it safe is that it goes by the pid stamped inside: a
  // LIVE owner keeps its directory. Both directions are asserted, because a reaper that removes
  // a running job's HOME would be a worse bug than the leak it fixes. The unstamped case is its
  // own third direction: recent means "possibly in use", old means "nobody is coming back".
  const tmp = ownTmp();
  let deadPid = 4194300;                                  // find one that is genuinely gone
  while (deadPid > 2 && alive(deadPid)) deadPid--;
  const stamp = (name, pid, ageMs) => {
    const dir = path.join(tmp, name);
    fs.mkdirSync(dir, { recursive: true });
    if (pid !== null) fs.writeFileSync(path.join(dir, ".runner-pid"), String(pid));
    if (ageMs) { const t = (Date.now() - ageMs) / 1000; fs.utimesSync(dir, t, t); }
    return dir;
  };
  const abandoned = stamp("loom-test-home-abandoned", deadPid);
  const inUse = stamp("loom-test-home-inuse", process.pid);
  const freshUnstamped = stamp("loom-test-home-fresh", null);
  const oldUnstamped = stamp("loom-test-home-old", null, 48 * 60 * 60 * 1000);
  const r = spawnSync(process.execPath, [RUNNER, "--file", "naming.test.js"],
    { env: runnerEnv(tmp), encoding: "utf8", timeout: 600000 });
  eq(r.status, 0, "the run itself passed: " + quiet(r.stdout).slice(-300));
  ok(!fs.existsSync(abandoned), "the sandbox whose owner is dead was reaped");
  ok(fs.existsSync(inUse), "the sandbox whose owner is ALIVE was left alone — never reap a live run");
  ok(fs.existsSync(freshUnstamped), "a RECENT unstamped directory could still be in use — left alone");
  ok(!fs.existsSync(oldUnstamped), "an OLD unstamped one outlived every possible run — reaped, not leaked for ever");
});
