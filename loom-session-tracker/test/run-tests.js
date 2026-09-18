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

// ── TI-002 · THE BUILD THE TESTS ACTUALLY LOAD ──────────────────────────────────────
// `test/harness.js` load() requires from out/, and NOTHING on this path has ever run tsc — the only
// tsc is the `compile` npm script, which ./test.sh does not call. So editing src/ and running the
// targeted tests graded the PREVIOUS build, and playbook §23 made that targeted run a worker's ONLY
// verification before it answers. TI-001 closed the "no tests ran" door; this is the same lie
// through the next one — a green run that never saw the change.
//
// It REFUSES rather than compiles. `tsc -p ./` here is a 2.2s FULL build (no `incremental`), and
// mutation.py already compiles each mutant copy itself, so compiling on every run would pay that
// twice per mutant. Stat-ing 74 files costs 0.34ms, measured, against a 2.2s compile.
//
// MTIME IS THE WHOLE OF THE EVIDENCE, and the honest statement of that is two-sided. A NEWER mtime
// is what protects you; an OLDER one defeats you just as completely, and not only via a deliberate
// `touch` — `cp -p`, `rsync -a`, `tar -x` and any editor that restores from a backup all write new
// CONTENT under an old timestamp, and this check will pass them. Only a content hash would close
// that, and that is not what this is. Equally, it refuses on timestamps alone: a `git checkout` or
// merge that rewrites tsconfig.json or a source with identical content costs a 2.2s rebuild. That
// direction is the safe one, so it is deliberate — but it is a false refusal and it is named here
// rather than discovered.
const SRC_DIR = path.join(__dirname, "..", "src");
const OUT_DIR = path.join(__dirname, "..", "out");
const TSCONFIG = path.join(__dirname, "..", "tsconfig.json");
const COMPILE_HINT = "  ELECTRON_RUN_AS_NODE=1 ${CODIUM:-/usr/share/codium/codium} node_modules/typescript/bin/tsc -p ./";

function mtime(p) { try { return fs.statSync(p).mtimeMs; } catch { return null; } }

// ── TI-002 · A WRITE THAT ACTUALLY LANDS ────────────────────────────────────────────
// The child's fd 1 is a NON-BLOCKING pipe. `console.log` queues in libuv and `process.exit` drops
// whatever has not drained; a single `fs.writeSync` throws EAGAIN the moment the 64KB pipe is full,
// which it is whenever the parent is stalled — and the parent stalls synchronously, per child,
// inside reclaim()'s recursive rmSync. Both routes lose output, and the one that matters is the
// ##RESULT trailer, whose absence the parent reads as a dead file.
//
// So: retry on EAGAIN, and handle a PARTIAL write, because writeSync returns a byte count and is
// under no obligation to take the whole buffer. Atomics.wait is the only synchronous sleep here —
// a busy spin would keep this process on the CPU that the parent needs in order to drain us.
// BOUNDED: if the parent is never going to read again, a test runner must not hang for ever.
const WRITE_DEADLINE_MS = 30000;
function writeAllSync(fd, text) {
  const buf = Buffer.from(text, "utf8");
  const pause = new Int32Array(new SharedArrayBuffer(4));
  let off = 0;
  const until = Date.now() + WRITE_DEADLINE_MS;
  while (off < buf.length) {
    try {
      off += fs.writeSync(fd, buf, off, buf.length - off);
    } catch (e) {
      if (e.code !== "EAGAIN") return false;          // EPIPE and friends: the reader is gone
      if (Date.now() > until) return false;
      try { Atomics.wait(pause, 0, 0, 5); } catch { /* not every build allows it; the retry still spins */ }
    }
  }
  return true;
}

/** Files under `dir` matching `re`, RECURSIVELY, as paths relative to `dir`.
 *  R1 · IT WALKS. A flat readdir skipped any subdirectory entirely, so the first person to add
 *  `src/foo/bar.ts` would have lost this guarantee for it silently and with no warning anywhere —
 *  which is a defeat of the guard that needs no `touch` at all. src/ is flat today; this is for
 *  the day it is not. Found by the adversarial pass, driven, not argued. */
function filesUnder(dir, re, base = dir) {
  let found = [];
  let ents;
  try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch { return found; }
  for (const e of ents) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) found = found.concat(filesUnder(full, re, base));
    // `.d.ts` is EXCLUDED: tsc emits no .js for a declaration file, so counting one as a source
    // would refuse every run over a file that is not missing.
    else if (re.test(e.name) && !e.name.endsWith(".d.ts")) found.push(path.relative(base, full));
  }
  return found;
}

/** Every reason out/ is not a faithful build of src/. Empty means the tests will load what the
 *  worker just wrote. Pure, so a test can drive it against a fixture tree. */
function staleReasons(srcDir, outDir, tsconfig) {
  const srcs = filesUnder(srcDir, /\.(ts|tsx|mts|cts)$/i).sort();
  if (!srcs.length) return [];
  const reasons = [];
  const outTimes = [];
  const expected = new Set();
  for (const rel of srcs) {
    const js = rel.replace(/\.(ts|tsx|mts|cts)$/i, ".js");
    expected.add(js);
    const tm = mtime(path.join(srcDir, rel)), om = mtime(path.join(outDir, js));
    if (om === null) { reasons.push(`src/${rel} has never been compiled — out/${js} does not exist`); continue; }
    outTimes.push(om);
    if (tm !== null && tm > om) reasons.push(`src/${rel} is newer than out/${js} by ${((tm - om) / 1000).toFixed(1)}s`);
  }
  // A source that was DELETED leaves its build output behind — tsc never removes it — and the tests
  // can still load() it. That is green against code that no longer exists.
  for (const js of filesUnder(outDir, /\.(js|cjs|mjs)$/i).sort()) {
    if (!expected.has(js)) reasons.push(`out/${js} has no src/ — a deleted source the tests can still load`);
  }
  const cm = mtime(tsconfig);
  if (cm !== null && outTimes.length && cm > Math.min(...outTimes)) reasons.push(`tsconfig.json changed after the build`);
  return reasons;
}

/** Exit 4 — its own code, so "your build is stale" can never be read as a test failure (1), an
 *  empty run (3) or a missing codium (2). */
function refuseStaleBuild(reasons) {
  console.log(`\n\x1b[31mout/ is not a build of src/ — REFUSING to run\x1b[0m`);
  for (const r of reasons.slice(0, 8)) console.log(`  - ${r}`);
  if (reasons.length > 8) console.log(`  ... and ${reasons.length - 8} more`);
  console.log(`\nThe tests load out/, not src/. Running now would grade the PREVIOUS build and could`);
  console.log(`report green for a change it never saw. Compile first:\n${COMPILE_HINT}`);
  process.exit(4);
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
  // TI-002 · before a single child is spawned, and before the sandbox machinery costs anything.
  // There is deliberately NO env override: an escape hatch in a guard against a false green is a
  // hole in it, and out/ is untracked here, so nothing but an actual edit moves these mtimes.
  const stale = staleReasons(SRC_DIR, OUT_DIR, TSCONFIG);
  if (stale.length) refuseStaleBuild(stale);

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
      // TI-002 · THE TWO STREAMS ARE KEPT APART. They used to be appended to ONE string and the
      // trailer matched with `$` — but stderr is a second pipe, delivered on its own schedule, and
      // for a file that shells out (project.test.js runs git through execFileSync, whose stderr is
      // ours by default) the writer is a DIFFERENT PROCESS. So a PASSING file whose last word came
      // from stderr parsed as no-trailer and was reported `crashed (exit 0)` — the string measured
      // on main. Driven standalone before this change: 38/40 and 34/40 mislabelled.
      let sout = "", serr = "", settled = false;
      const child = spawn(process.execPath, [__filename, "--file", file], { env, stdio: ["ignore", "pipe", "pipe"] });
      LIVE_CHILDREN.add(child);
      child.stdout.on("data", (d) => (sout += d));
      child.stderr.on("data", (d) => (serr += d));
      // A child that could not be spawned at all emits `error`. MEASURED: `close` fires anyway
      // (ENOENT gives code -2), so the accounting never depended on this — it adds the reason to
      // the output, nothing more, and an earlier comment here overstated it.
      child.on("error", (e) => { serr += `\n  spawn failed: ${e.message}\n`; });
      child.on("close", (code, signal) => {
        if (settled) return;
        settled = true;
        running--; filesDone++;
        LIVE_CHILDREN.delete(child);
        reclaim(sandbox);
        // TI-002 · THE TRAILER IS THE WHOLE OF THE LAST LINE, not a match anywhere near the end.
        // A substring match lets QUOTED output impersonate it: fixtures.test.js prints nested
        // runner output inside its own failure messages, `##RESULT` and all. Anchoring to the last
        // line removes that class rather than arguing it cannot happen today.
        const trimmed = sout.replace(/\s+$/, "");
        const cut = trimmed.lastIndexOf("\n");
        const m = /^##RESULT (\d+) (\d+)$/.exec(trimmed.slice(cut + 1));
        const body = (m ? trimmed.slice(0, cut + 1) : sout) + serr;
        process.stdout.write(body);
        // TI-002 · THE TRAILER IS NOT BELIEVED ON ITS OWN — it is cross-checked against how the
        // process actually ended, because the two can disagree and the old code only ever read the
        // trailer. Where they disagree the runner cannot tell which is true, so it REFUSES: every
        // branch here adds to `fail`, and none of them can end a run green.
        const expected = m ? (Number(m[2]) ? 1 : 0) : null;
        if (signal) {
          // THE FALSE GREEN. A child SIGKILLed after printing a clean trailer used to be counted as
          // its full passes with no failure — driven: `7/7 passed, exit 0` over a corpse. The OOM
          // killer reaches these children first, and they run 25-at-a-time.
          fail++;
          failures.push(`${file}: killed by ${signal}${m ? ` AFTER reporting ${m[1]}/${Number(m[1]) + Number(m[2])} — that report is not trusted` : ""}`);
        } else if (!m) {
          fail++;
          failures.push(/##RESULT/.test(sout)
            ? `${file}: its ##RESULT was not the last thing it printed (exit ${code}) — output after it means the file did not finish cleanly`
            : `${file}: no ##RESULT trailer (exit ${code}) — the file never reported a result`);
        } else if (Number(m[1]) + Number(m[2]) === 0) {
          // TI-001's rule — ZERO EXECUTED IS NEVER A PASS — was enforced only INSIDE the child, and
          // the parent is the thing that prints the green. So a file reporting `##RESULT 0 0`
          // contributed nothing, satisfied every guard (filesDone is complete, the run's total is
          // non-zero because OTHER files ran) and the run exited 0. Driven by the adversarial pass.
          fail++;
          failures.push(`${file}: reported 0 tests — a file that executed nothing is not a pass`);
        } else if (code !== expected) {
          fail++;
          failures.push(`${file}: ##RESULT says ${m[1]} passed / ${m[2]} failed but the process exited ${code} (expected ${expected}) — the runner cannot tell which is true`);
        } else {
          pass += Number(m[1]); fail += Number(m[2]);
        }
        for (const line of body.split("\n")) if (/✗/.test(line)) failures.push(line.replace(/^\s*\x1b\[31m✗\x1b\[0m /, ""));
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
    // TI-002 · a cheap structural backstop, and DELIBERATELY NOT the thing that stops a file
    // vanishing. `done()` has one call site, inside the close handler that increments filesDone,
    // and running only reaches 0 once every spawned child has closed — so this cannot fire today,
    // and an earlier comment here claimed more for it than that. What actually stops a file
    // vanishing is the per-child grading above: a signal, a missing trailer, a trailer that
    // disagrees with the exit code, and a file reporting zero tests are each a failure. This stands
    // for the day the loop above grows a path that forgets a file.
    if (filesDone !== FILES.length) {
      console.log(`\n\x1b[31m${filesDone} of ${FILES.length} test files reported — REFUSING to grade this run\x1b[0m`);
      console.log(`A file that vanishes from a run without the run noticing is the defect this guard exists for. Exiting 3.`);
      process.exit(3);
    }
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

// TI-002 · THE RUNNER'S OWN VERDICT LINES GO OUT BLOCKING, for the same reason as the trailer.
// Measured: a child producing 20,000 console.log lines delivered 4,345 of them — `process.exit`
// drops whatever libuv has not drained. These are the ✓/✗ lines the parent scrapes for failure
// names at :361 and that mutation.py parses to decide which tests passed (PASS_RE/FAIL_RE), so
// losing them turns a red file into a half-reported one. A test's OWN console.log is still
// droppable — that is pre-existing and not something this runner can reach.
const say = (line) => { writeAllSync(1, line + "\n"); };

(async () => {
  let pass = 0, fail = 0, skipped = 0;
  const failures = [];
  for (const s of H.suites) {
    if (only && !s.name.toLowerCase().includes(only.toLowerCase())) { skipped++; continue; }
    H.vscode._reset();
    try {
      await s.fn();
      pass++;
      say(`  \x1b[32m✓\x1b[0m ${s.name}`);
    } catch (e) {
      fail++;
      failures.push({ name: s.name, err: e });
      say(`  \x1b[31m✗\x1b[0m ${s.name}`);
      say(`      ${String(e.message || e).split("\n").join("\n      ")}`);
      if (!(e instanceof H.AssertionError) && e.stack) {
        say(`      ${e.stack.split("\n").slice(1, 3).join("\n      ")}`);
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
  // TI-002 · the trailer goes out through writeAllSync, which RETRIES. The first version of this
  // called fs.writeSync once and claimed in a comment that "writeSync cannot be dropped" — that was
  // wrong, and an adversarial pass drove it: fd 1 is a NON-BLOCKING pipe, the parent stalls
  // synchronously between children (inside reclaim()'s recursive rmSync and sandboxEnv()'s mkdtemp),
  // the 64KB pipe fills, and writeSync throws EAGAIN. Re-measured independently: the trailer was
  // lost outright and the file was reported `crashed (exit 0)` — the very symptom this was meant to
  // end. The fallback was worse than useless: console.log followed by process.exit is exactly the
  // asynchronous drop the comment claimed to be avoiding.
  if (fileArg) { writeAllSync(1, `##RESULT ${pass} ${fail}\n`); process.exit(fail ? 1 : 0); }
  const total = pass + fail;
  console.log(`\n${fail ? "\x1b[31m" : "\x1b[32m"}${pass}/${total} passed\x1b[0m` +
    (skipped ? `  (${skipped} filtered out)` : "") + `  — ${files.length} test files`);
  if (fail) { console.log("\nfailed:"); for (const f of failures) console.log(`  - ${f.name}`); }
  process.exit(fail ? 1 : 0);
})();
