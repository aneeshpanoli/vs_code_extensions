// run-tests.js — discovers test/*.test.js, runs them, prints a report.
// Re-execs itself with HOME pointed at a throwaway directory so no test can
// ever touch the real ~/.claude/loom bus.
const fs = require("fs");
const os = require("os");
const path = require("path");

if (!process.env.LOOM_TEST_SANDBOX) {
  const { spawnSync } = require("child_process");
  const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), "loom-test-home-"));
  const r = spawnSync(process.execPath, [__filename, ...process.argv.slice(2)], {
    stdio: "inherit",
    env: { ...process.env, HOME: sandbox, LOOM_TEST_SANDBOX: sandbox, ELECTRON_RUN_AS_NODE: "1" },
  });
  try { fs.rmSync(sandbox, { recursive: true, force: true }); } catch { /* best effort */ }
  process.exit(r.status === null ? 1 : r.status);
}

const H = require("./harness");
const only = process.argv[2];                       // optional substring filter
const files = fs.readdirSync(__dirname).filter((f) => f.endsWith(".test.js")).sort();
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
    }
  }
  const total = pass + fail;
  console.log(`\n${fail ? "\x1b[31m" : "\x1b[32m"}${pass}/${total} passed\x1b[0m` +
    (skipped ? `  (${skipped} filtered out)` : "") + `  — ${files.length} test files`);
  if (fail) { console.log("\nfailed:"); for (const f of failures) console.log(`  - ${f.name}`); }
  process.exit(fail ? 1 : 0);
})();
