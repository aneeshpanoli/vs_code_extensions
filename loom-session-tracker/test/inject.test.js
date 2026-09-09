// inject.test.js — the delivery layer. It shells out to loom_cdp.py, so the tests stub that file with
// a python script that reports back what it was asked to do.
const { suite, ok, eq, match, load, readJson, LOOM } = require("./harness");
const fs = require("fs");
const path = require("path");
const { injectTo } = load("inject.js");

const CDP = path.join(LOOM, "loom_cdp.py");
/** Stub loom_cdp.py: echo the argv, plus whatever result dict the test wants it to report. */
function stub(report = "{'ok': True}") {
  fs.mkdirSync(LOOM, { recursive: true });
  fs.writeFileSync(CDP, `import sys\nprint(' '.join(sys.argv[1:]))\nprint("${report}")\n`);
}
const run = (target, msg, name) => new Promise((resolve) => {
  injectTo(target, msg, name, (ok, note) => resolve({ ok, note }));
});

suite("inject: the orchestrator is addressed by its FRAME, not by its role", () => {
  // `--role product-owner` can never land: loom_cdp.py's find_role drops owner-detected frames (the
  // self-woke guard). The webviewId is the only way in, so it must be on the command line.
  stub();
  return run({ role: "product-owner", webviewId: "wid-po" }, "hello", "t-inject.json").then((r) => {
    ok(r.ok, "reported ok");
    const dbg = readJson(path.join(LOOM, "t-inject.json"));
    match(dbg.out, /--webview-id wid-po/, "the exact frame is passed through");
    match(dbg.out, /--submit/, "and it is submitted");
    eq(dbg.target.webviewId, "wid-po", "logged for diagnosis");
  });
});

suite("inject: a worker with no known frame is still addressed by role", () => {
  stub();
  return run({ role: "alpha" }, "/model claude-opus-5", "t-inject2.json").then(() => {
    const dbg = readJson(path.join(LOOM, "t-inject2.json"));
    match(dbg.out, /--role alpha/, "role targeting kept");
    ok(!/--webview-id/.test(dbg.out), "no frame flag when there is no frame");
  });
});

suite("inject: a report of ok=False is a FAILURE, not a success", () => {
  // loom_cdp.py exits 0 even when it found nothing; trusting the exit code would call that delivered.
  stub("{'ok': False, 'note': 'webviewId abc is not an attached frame'}");
  return run({ role: "po", webviewId: "abc" }, "hi", "t-inject3.json").then((r) => {
    eq(r.ok, false, "not ok");
    match(r.note, /not an attached frame/, "carries the injector's own explanation");
  });
});

suite("inject: a crashing injector is reported, never thrown", () => {
  fs.writeFileSync(CDP, "import sys\nsys.exit(3)\n");
  return run({ role: "po", webviewId: "wid" }, "hi", "t-inject4.json").then((r) => {
    eq(r.ok, false, "failure surfaced");
    ok(readJson(path.join(LOOM, "t-inject4.json")), "and written to the debug file");
  });
});

suite("inject: the message is logged truncated, so a debug file stays readable", () => {
  stub();
  return run({ role: "po", webviewId: "w" }, "x".repeat(1000), "t-inject5.json").then(() => {
    const dbg = readJson(path.join(LOOM, "t-inject5.json"));
    eq(dbg.message.length, 300, "truncated");
  });
});
