// run-tests.js — discovers test/*.test.js, runs them, prints a report.
//
// PARALLEL BY FILE. One process per test file, each with its OWN throwaway HOME (so no test can touch
// the real ~/.claude/loom bus, and no file can leak a stub into another — a leaked closeWebview stub
// once made a test in a later file read ok:true). Up to LOOM_TEST_JOBS at once (default: every
// core). A filter (file or name), or LOOM_TEST_JOBS=1, runs the old single-process path; mutation.py sets
// LOOM_TEST_JOBS=1 inside each mutant copy so 33 mutants do not each fork 34 children.
//
// TI-001 · TWO RULES THIS RUNNER NOW ENFORCES ABOUT ITSELF.
//   1. ZERO TESTS EXECUTED IS NEVER A PASS. A filter that matched nothing used to print
//      `0/0 passed` and exit 0. Playbook §23 makes a targeted run a worker's ONLY verification
//      before it answers, so a vacuously green filter lets a worker report "tests green" having
//      run no test at all. Every exit path below asserts a non-zero count.
//   2. AN INTERRUPTED RUN CLEANS UP AFTER ITSELF. Sandboxes were removed in each child's `close`
//      handler only, so a parent that died — Ctrl-C, an outer `timeout`, a reap — left every
//      sandbox in flight behind. Measured: 42 orphaned trees holding 79,741 inodes from two
//      killed gates; 896,188 directories and 12.2M inodes in the September incident.
const fs = require("fs");
const os = require("os");
const path = require("path");

const FILES = fs.readdirSync(__dirname).filter((f) => f.endsWith(".test.js")).sort();

// ── TI-001 · what a filter MEANS ────────────────────────────────────────────────────
// It used to mean "suite names containing <arg>", and nothing else. So the obvious spelling — the
// FILE name, which is exactly what §23 tells a worker to run for what it changed — matched no
// suite and ran nothing.
//
// R1 · A FILE SELECTOR MUST LOOK LIKE A FILE, and the reason is a defect the first version had.
// Trying the file name FIRST for any argument silently NARROWED every documented name filter that
// happens to be a substring of a filename: `./test.sh notifier` (README.md:1001) ran only
// notifier.test.js and quietly dropped the two "notifier" suites in extension.test.js, exiting 0
// with a non-zero count — invisible to the guard below, because something did run. That is the
// same lie in a new place: a worker asks for the tests of a thing and is told green by a subset.
// So the two spellings are now DISJOINT and decided by the argument's own shape: an argument
// ending in `.js` selects FILES and must match one, anything else is the suite-name filter
// EXACTLY as before. Neither may report success having executed nothing: see refuseEmptyRun().
function looksLikeFile(arg) { return /\.js$/i.test(path.basename(String(arg))); }

function resolveFilter(arg) {
  if (!arg) return { files: FILES, only: null, how: "the whole suite" };
  const raw = String(arg);
  if (looksLikeFile(raw)) {
    const base = path.basename(raw).toLowerCase();
    const byFile = FILES.filter((f) => f.toLowerCase() === base || f.toLowerCase().includes(base));
    return { files: byFile, only: null, how: `test file "${raw}"` };   // empty -> refused, not ignored
  }
  return { files: FILES, only: raw, how: `suite names containing "${raw}"` };
}

/** THE GUARD. Nothing executed is a failure, wherever the run ended up, and it says what it
 *  looked for — a silent 0 is the eighth costume of the vacuous baseline in this repo. */
function refuseEmptyRun(how, hint) {
  console.log(`\n\x1b[31m0 tests executed — nothing matched ${how}\x1b[0m`);
  if (hint) console.log(hint);
  console.log(`A run that executes no test is NOT a pass. Exiting 3.`);
  process.exit(3);
}

// ── TI-001 · sandboxes an interrupted run still owns ────────────────────────────────
// Every sandbox this process has made and not yet reclaimed. A `close` handler cannot run for a
// child whose PARENT is being killed, so the set is also drained from the signal and exit paths.
const LIVE_SANDBOXES = new Set();
const LIVE_CHILDREN = new Set();

function reclaim(sandbox) {
  LIVE_SANDBOXES.delete(sandbox);
  try { fs.rmSync(sandbox, { recursive: true, force: true }); } catch { /* best effort */ }
}

function reclaimAll() {
  for (const child of LIVE_CHILDREN) { try { child.kill("SIGKILL"); } catch { /* already gone */ } }
  LIVE_CHILDREN.clear();
  for (const sandbox of [...LIVE_SANDBOXES]) reclaim(sandbox);
}

/** The stamp: WHO IS INSIDE THIS SANDBOX. Written by the occupant itself (see the child branch
 *  below), because the occupant is the process whose death makes the directory collectable.
 *  ATOMIC — rename, not a truncating rewrite — so a concurrent reaper can never read half a pid
 *  and take it for a dead one. */
function stampOwner(sandbox, pid) {
  if (!sandbox) return;
  try {
    const f = path.join(sandbox, ".runner-pid");
    fs.writeFileSync(`${f}.tmp`, String(pid));
    fs.renameSync(`${f}.tmp`, f);
  } catch { /* best effort */ }
}

/** WHAT THE HANDLERS CANNOT COVER: SIGKILL, and a power cut. Neither can be caught by anything, so
 *  the second line of defence is here — a sandbox stamped with the pid that lives in it, reaped by
 *  the NEXT run once that pid is gone. The failure direction is deliberately "leave it": a pid that
 *  is alive (or that we may not signal) keeps its directory, so a concurrent run is never touched.
 *
 *  R1 · AN UNSTAMPED DIRECTORY IS NOT SIMPLY IGNORED ANY MORE. It can be a sandbox SIGKILLed in the
 *  microseconds between mkdtemp and the stamp, or one from a runner older than this file — and
 *  "ignore it" makes that a PERMANENT leak, which is the defect this block exists to end. It is
 *  reaped only once it is older than any run can possibly be: every suite here is bounded in
 *  minutes, so a day is far outside the range where a live run could be mistaken for a corpse. */
const UNSTAMPED_GRACE_MS = 24 * 60 * 60 * 1000;

function reapAbandonedSandboxes() {
  let names;
  try { names = fs.readdirSync(os.tmpdir()); } catch { return 0; }
  let reaped = 0;
  for (const name of names) {
    if (!name.startsWith("loom-test-home-")) continue;
    const dir = path.join(os.tmpdir(), name);
    let pid = null;
    try { pid = Number(fs.readFileSync(path.join(dir, ".runner-pid"), "utf8").trim()); } catch { pid = null; }
    if (pid === null || !Number.isInteger(pid) || pid <= 0) {
      let age = 0;
      try { age = Date.now() - fs.statSync(dir).mtimeMs; } catch { continue; }
      if (age < UNSTAMPED_GRACE_MS) continue;                 // could still be in use — leave it
    } else {
      try { process.kill(pid, 0); continue; } catch (e) { if (e.code !== "ESRCH") continue; }
    }
    try { fs.rmSync(dir, { recursive: true, force: true }); reaped++; } catch { /* best effort */ }
  }
  return reaped;
}

function sandboxEnv() {
  const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), "loom-test-home-"));
  // FX-002 · TMPDIR INSIDE THE SANDBOX. Each child's `os.tmpdir()` now resolves here, so every
  // fixture — including any site added after this handoff, which cannot be made to register itself —
  // lands inside the directory the runner already removes below. VERIFIED on this box that both
  // `node` and `codium --ELECTRON_RUN_AS_NODE` honour TMPDIR in `os.tmpdir()`; it was not assumed.
  const tmp = path.join(sandbox, "tmp");
  fs.mkdirSync(tmp, { recursive: true });
  // TI-001 · registered before it is used, so that BOTH recovery paths — this process's signal
  // handlers, and the next run's reaper after a SIGKILL — can find it. The stamp written here is
  // provisional: it names THIS process, which is the only one alive until the child boots and
  // stamps itself. Without a provisional stamp the directory is unstamped for that window.
  LIVE_SANDBOXES.add(sandbox);
  stampOwner(sandbox, process.pid);
  return { sandbox, env: { ...process.env, HOME: sandbox, LOOM_TEST_SANDBOX: sandbox,
                           TMPDIR: tmp, ELECTRON_RUN_AS_NODE: "1" } };
}

if (!process.env.LOOM_TEST_SANDBOX) {
  const { spawn } = require("child_process");
  const filter = process.argv[2];
  const jobs = Math.max(1, Number(process.env.LOOM_TEST_JOBS) || os.cpus().length);

  // TI-001 · a run that is interrupted gives its sandboxes back. `exit` covers the ordinary and the
  // throwing paths; the three catchable signals cover Ctrl-C, an outer `timeout`, and a reap. Each
  // re-raises after cleaning, so the exit status still says how the run died.
  process.on("exit", reclaimAll);
  for (const sig of ["SIGINT", "SIGTERM", "SIGHUP"]) {
    process.on(sig, () => { reclaimAll(); process.exit(sig === "SIGINT" ? 130 : sig === "SIGTERM" ? 143 : 129); });
  }
  const reaped = reapAbandonedSandboxes();
  if (reaped) console.log(`reaped ${reaped} sandbox(es) abandoned by a run that could not clean up (SIGKILL or worse)`);

  if (!FILES.length) refuseEmptyRun(`any *.test.js in ${__dirname}`, "  the test directory is empty");

  if (filter || jobs === 1) {
    // Single process — but SPAWNED, NOT spawnSync'd. R1: spawnSync blocks the event loop, so with
    // the handlers above installed a SIGTERM could not be delivered until the run finished — the
    // handlers SWALLOWED the signal, and an outer `timeout` or a reap no longer stopped the run at
    // all. Measured: a SIGTERMed run was still going 13s later, where before it died at once. This
    // keeps the loop free, and registers the child so an interrupted run kills it rather than
    // pulling the directory out from under it.
    const { sandbox, env } = sandboxEnv();
    const child = spawn(process.execPath, [__filename, ...process.argv.slice(2)], { stdio: "inherit", env });
    LIVE_CHILDREN.add(child);
    child.on("close", (code, signal) => {
      LIVE_CHILDREN.delete(child);
      reclaim(sandbox);
      process.exit(signal ? 1 : code === null ? 1 : code);
    });
    return;
  }
  // one child per file, `jobs` at a time; each child prints its own lines and a trailer we parse
  const queue = FILES.slice();
  let running = 0, pass = 0, fail = 0, filesDone = 0;
  const failures = [];
  const t0 = Date.now();
  const next = () => {
    while (running < jobs && queue.length) {
      const file = queue.shift();
      const { sandbox, env } = sandboxEnv();
      running++;
      let out = "";
      const child = spawn(process.execPath, [__filename, "--file", file], { env, stdio: ["ignore", "pipe", "pipe"] });
      LIVE_CHILDREN.add(child);
      child.stdout.on("data", (d) => (out += d));
      child.stderr.on("data", (d) => (out += d));
      child.on("close", (code) => {
        running--; filesDone++;
        LIVE_CHILDREN.delete(child);
        reclaim(sandbox);
        const m = /##RESULT (\d+) (\d+)\n?$/.exec(out);
        const body = out.replace(/##RESULT \d+ \d+\n?$/, "");
        process.stdout.write(body);
        if (m) { pass += Number(m[1]); fail += Number(m[2]); }
        else { fail++; failures.push(`${file}: crashed (exit ${code})`); }
        for (const line of body.split("\n")) if (/\u2717/.test(line)) failures.push(line.replace(/^\s*\x1b\[31m\u2717\x1b\[0m /, ""));
        if (queue.length) next();
        else if (running === 0) done();
      });
    }
  };
  const done = () => {
    const total = pass + fail;
    // TI-001 · the guard on the parallel path too. 51 files that between them ran nothing is a
    // broken runner, not a green run.
    if (total === 0) refuseEmptyRun(`the whole suite (${FILES.length} test files)`, "  no test file reported a result");
    console.log(`\n${fail ? "\x1b[31m" : "\x1b[32m"}${pass}/${total} passed\x1b[0m  — ${FILES.length} test files, ` +
      `${jobs} in parallel, ${((Date.now() - t0) / 1000).toFixed(1)}s`);
    if (failures.length) { console.log("\nfailed:"); for (const f of failures) console.log(`  - ${f}`); }
    process.exit(fail ? 1 : 0);
  };
  next();
  return;
}

// R1 · THE OCCUPANT STAMPS ITSELF, on both paths, before it does anything else. The parent's
// provisional stamp names the PARENT; if the parent is SIGKILLed this child is orphaned and keeps
// running, and a reaper going by that dead pid would delete a live process's HOME. Reproduced
// exactly that way on this host before this line existed.
stampOwner(process.env.LOOM_TEST_SANDBOX, process.pid);

const H = require("./harness");
const fileArg = process.argv[2] === "--file" ? process.argv[3] : null;
// TI-001 · a file name resolves to FILES, a suite substring to `only`, and a targeted run now
// REQUIRES ONLY THE FILES IT NAMED — previously a filter loaded all 51 and skipped at execution.
const chosen = fileArg ? { files: [fileArg], only: null, how: `--file ${fileArg}` }
                       : resolveFilter(process.argv[2]);
const { only, how } = chosen;
const files = chosen.files;
// Refused BEFORE loading anything: a file selector that names nothing is a typo, and saying so in
// milliseconds is better than saying so after requiring 51 files.
if (!files.length) refuseEmptyRun(how, `  no test file matches it — try one of ${FILES.length}, e.g. ./test.sh ${FILES[0]}`);
for (const f of files) require(path.join(__dirname, f));

(async () => {
  let pass = 0, fail = 0, skipped = 0;
  const failures = [];
  for (const s of H.suites) {
    if (only && !s.name.toLowerCase().includes(only.toLowerCase())) { skipped++; continue; }
    H.vscode._reset();
    try {
      await s.fn();
      pass++;
      console.log(`  \x1b[32m✓\x1b[0m ${s.name}`);
    } catch (e) {
      fail++;
      failures.push({ name: s.name, err: e });
      console.log(`  \x1b[31m✗\x1b[0m ${s.name}`);
      console.log(`      ${String(e.message || e).split("\n").join("\n      ")}`);
      if (!(e instanceof H.AssertionError) && e.stack) {
        console.log(`      ${e.stack.split("\n").slice(1, 3).join("\n      ")}`);
      }
    } finally {
      // FX-002 · the owner. A suite that THREW still gives its fixture directories back; that is the
      // whole reason this lives here rather than at the end of each suite body.
      H.sweepFixtures();
    }
  }
  // TI-001 · BEFORE the trailer, so a child that ran nothing prints no ##RESULT and the parent
  // reads it as a crash rather than as zero passes it can quietly add to the total.
  if (pass + fail === 0) {
    refuseEmptyRun(how, only
      ? `  ${skipped} suite(s) exist and none matched. Try a FILE name — e.g. ./test.sh ${FILES[0]}`
      : `  ${files.length} file(s) matched but declared no suite`);
  }
  if (fileArg) { console.log(`##RESULT ${pass} ${fail}`); process.exit(fail ? 1 : 0); }
  const total = pass + fail;
  console.log(`\n${fail ? "\x1b[31m" : "\x1b[32m"}${pass}/${total} passed\x1b[0m` +
    (skipped ? `  (${skipped} filtered out)` : "") + `  — ${files.length} test files`);
  if (fail) { console.log("\nfailed:"); for (const f of failures) console.log(`  - ${f.name}`); }
  process.exit(fail ? 1 : 0);
})();
