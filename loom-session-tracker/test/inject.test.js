// inject.test.js — the delivery layer. It shells out to loom_cdp.py, so the tests stub that file with
// a python script that reports back what it was asked to do.
const { suite, ok, eq, match, load, readJson, LOOM } = require("./harness");
const fs = require("fs");
const path = require("path");
const { injectTo, REPLY_FOR } = load("inject.js");

const CDP = path.join(LOOM, "loom_cdp.py");
/** Stub loom_cdp.py: echo the argv, plus whatever result dict the test wants it to report. */
function stub(report = "{'ok': True}") {
  fs.mkdirSync(LOOM, { recursive: true });
  fs.writeFileSync(CDP, `import sys\nprint(' '.join(sys.argv[1:]))\nprint("${report}")\n`);
}
const run = (target, msg, name, replyKind) => new Promise((resolve) => {
  injectTo(target, msg, name, (ok, note) => resolve({ ok, note }), replyKind);
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

// MC-001 · replyKind is a SEPARATE argument from the debug log file name — a caller that sends more
// than one KIND of message down one debug file (context-memory: save/clear/restore, all logged to
// "context-debug.json") must be able to say which reply hint applies without renaming its log.
suite("inject: replyKind picks the --reply text independently of the debug log file name", () => {
  stub();
  return run({ role: "po", webviewId: "w" }, "hi", "t-inject6.json", "context-restore").then(() => {
    const dbg = readJson(path.join(LOOM, "t-inject6.json"));
    match(dbg.out, new RegExp(REPLY_FOR["context-restore"].replace(/[.*+?^${}()|[\]\\]/g, "\\$&")),
      "the restore reply line was sent");
    ok(!new RegExp(REPLY_FOR["context-save"].replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).test(dbg.out),
      "not the save reply line, even though both share the SAME debug file name");
  });
});

suite("inject: omitting replyKind falls back to the debug log file name (every other call site)", () => {
  stub();
  return run({ role: "po", webviewId: "w" }, "hi", "notify-debug.json").then(() => {
    const dbg = readJson(path.join(LOOM, "notify-debug.json"));
    match(dbg.out, new RegExp(REPLY_FOR["notify-debug.json"].replace(/[.*+?^${}()|[\]\\]/g, "\\$&")),
      "unchanged behaviour for the single-message call sites");
  });
});

// MC-001 acceptance: each context-memory step's reply hint, asserted BY STEP — including the exact
// defect (the save hint reappearing on the restore) so it can never return silently.
suite("inject: REPLY_FOR keys the context-memory subsystem by StepKind, one line per message it sends", () => {
  ok(REPLY_FOR["context-save"], "save has its own line");
  ok(REPLY_FOR["context-clear"], "clear has its own line");
  ok(REPLY_FOR["context-restore"], "restore has its own line");
  ok(!REPLY_FOR["context-debug.json"], "the old subsystem-wide key is gone — nothing looks it up any more");
  match(REPLY_FOR["context-save"], /write the memory file/, "save: the job is to WRITE it");
  ok(!/write the memory file/.test(REPLY_FOR["context-restore"]), "restore: NOT told to write — a fresh session has nothing to bank");
  match(REPLY_FOR["context-restore"], /read the memory file|nothing to bank/, "restore: told to READ it and get on with the work");
});
