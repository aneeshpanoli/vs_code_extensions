// run-tests.js — discovers test/*.test.js, runs them, prints a report.
//
// PARALLEL BY FILE. One process per test file, each with its OWN throwaway HOME (so no test can touch
// the real ~/.claude/loom bus, and no file can leak a stub into another — a leaked closeWebview stub
// once made a test in a later file read ok:true). Up to LOOM_TEST_JOBS at once (default: every
// core). A name filter, or LOOM_TEST_JOBS=1, runs the old single-process path; test/mutation.py sets
// LOOM_TEST_JOBS=1 inside each mutant copy so 33 mutants do not each fork 34 children.
const fs = require("fs");
const os = require("os");
const path = require("path");

const FILES = fs.readdirSync(__dirname).filter((f) => f.endsWith(".test.js")).sort();

function sandboxEnv() {
  const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), "loom-test-home-"));
  // FX-002 · TMPDIR INSIDE THE SANDBOX. Each child's `os.tmpdir()` now resolves here, so every
  // fixture — including any site added after this handoff, which cannot be made to register itself —
  // lands inside the directory the runner already removes below. VERIFIED on this box that both
  // `node` and `codium --ELECTRON_RUN_AS_NODE` honour TMPDIR in `os.tmpdir()`; it was not assumed.
  const tmp = path.join(sandbox, "tmp");
  fs.mkdirSync(tmp, { recursive: true });
  return { sandbox, env: { ...process.env, HOME: sandbox, LOOM_TEST_SANDBOX: sandbox,
                           TMPDIR: tmp, ELECTRON_RUN_AS_NODE: "1" } };
}

if (!process.env.LOOM_TEST_SANDBOX) {
  const { spawnSync, spawn } = require("child_process");
  const filter = process.argv[2];
  const jobs = Math.max(1, Number(process.env.LOOM_TEST_JOBS) || os.cpus().length);
  if (filter || jobs === 1) {
    // single process, as before
    const { sandbox, env } = sandboxEnv();
    const r = spawnSync(process.execPath, [__filename, ...process.argv.slice(2)], { stdio: "inherit", env });
    try { fs.rmSync(sandbox, { recursive: true, force: true }); } catch { /* best effort */ }
    process.exit(r.status === null ? 1 : r.status);
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
      child.stdout.on("data", (d) => (out += d));
      child.stderr.on("data", (d) => (out += d));
      child.on("close", (code) => {
        running--; filesDone++;
        try { fs.rmSync(sandbox, { recursive: true, force: true }); } catch { /* best effort */ }
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
    console.log(`\n${fail ? "\x1b[31m" : "\x1b[32m"}${pass}/${total} passed\x1b[0m  — ${FILES.length} test files, ` +
      `${jobs} in parallel, ${((Date.now() - t0) / 1000).toFixed(1)}s`);
    if (failures.length) { console.log("\nfailed:"); for (const f of failures) console.log(`  - ${f}`); }
    process.exit(fail ? 1 : 0);
  };
  next();
  return;
}

const H = require("./harness");
const fileArg = process.argv[2] === "--file" ? process.argv[3] : null;
const only = fileArg ? null : process.argv[2];      // optional substring filter (single-process mode)
const files = fileArg ? [fileArg] : FILES;
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
  if (fileArg) { console.log(`##RESULT ${pass} ${fail}`); process.exit(fail ? 1 : 0); }
  const total = pass + fail;
  console.log(`\n${fail ? "\x1b[31m" : "\x1b[32m"}${pass}/${total} passed\x1b[0m` +
    (skipped ? `  (${skipped} filtered out)` : "") + `  — ${files.length} test files`);
  if (fail) { console.log("\nfailed:"); for (const f of failures) console.log(`  - ${f.name}`); }
  process.exit(fail ? 1 : 0);
})();
