// inject.test.js — the delivery layer. It shells out to loom_cdp.py, so the tests stub that file with
// a python script that reports back what it was asked to do.
const { suite, ok, eq, match, load, readJson, LOOM } = require("./harness");
const fs = require("fs");
const path = require("path");
const { injectTo, REPLY_FOR, REPORTING_CONTRACT, ORCHESTRATOR_KINDS, WORKER_KINDS,
        withContract } = load("inject.js");

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

// ── PD-001 · the REPORTING CONTRACT, asserted BY MESSAGE KIND ──────────────────────────────────
//
// The claim under test is not "this string appears somewhere". It is a statement about a BOUNDARY:
// a message that reaches an ORCHESTRATOR — the session that reports upward to the human — carries
// the contract, and a message that reaches a WORKER does not, because a worker's report to its
// orchestrator is the counts-and-measurements evidence a block is banked on. So each kind is
// asserted on its own, both ways, rather than by one grep over a blob of concatenated text.

suite("PD-001: every ORCHESTRATOR-facing kind carries the reporting contract", () => {
  for (const kind of ORCHESTRATOR_KINDS) {
    const typed = withContract(kind, "the message body");
    ok(typed.includes(REPORTING_CONTRACT), `${kind} carries the contract`);
    ok(typed.startsWith("the message body"),
       `${kind} keeps its own body first — the contract is appended, never a replacement`);
  }
});

suite("PD-001: no WORKER-facing kind carries it — the evidence a block is banked on is not suppressed", () => {
  for (const kind of WORKER_KINDS) {
    const body = "225/225 caught, 0 survived, 830/830 green";
    const typed = withContract(kind, body);
    ok(!typed.includes(REPORTING_CONTRACT), `${kind} does NOT carry the contract`);
    eq(typed, body, `${kind} is delivered exactly as written`);
  }
});

// The gate wake is the one that matters most: it is the message that asks a worker to write its
// grade counts. Telling THAT session to report "product, not figures" would suppress the very
// figures the orchestrator banks the block on. Named on its own so the exclusion cannot be
// deleted later as incidental.
suite("PD-001: the gate wake — which asks a worker for its grade counts — is never given the contract", () => {
  ok(WORKER_KINDS.has("gate-debug.json"), "classified as worker-facing");
  ok(!ORCHESTRATOR_KINDS.has("gate-debug.json"), "and not as orchestrator-facing");
  ok(!withContract("gate-debug.json", "your gate exited; write the grade counts").includes("[contract]"),
     "so the worker is still asked for counts, with nothing telling it to drop them");
});

suite("PD-001: the two tables are disjoint, and an unknown kind defaults to NO contract", () => {
  for (const k of ORCHESTRATOR_KINDS)
    ok(!WORKER_KINDS.has(k), `${k} is on exactly one side of the boundary`);
  ok(!withContract("some-new-debug.json", "body").includes("[contract]"),
     "a kind nobody classified stays silent — a new message must be a DECISION, not a default");
});

// DRIFT GUARD. REPLY_FOR is the table of every message kind this extension names. A kind that gets
// a reply hint but no side of the boundary is a message nobody decided about — and the decision is
// the feature. "context-clear" is the one deliberate absence: its body is the literal "/clear", a
// command, which can carry neither a header nor a contract.
suite("PD-001: every named message kind has been assigned a side (or is a command)", () => {
  const COMMAND_ONLY = new Set(["context-clear"]);
  for (const kind of Object.keys(REPLY_FOR)) {
    if (COMMAND_ONLY.has(kind)) continue;
    ok(ORCHESTRATOR_KINDS.has(kind) || WORKER_KINDS.has(kind),
       `${kind} is classified as orchestrator- or worker-facing`);
  }
  eq(withContract("context-clear", "/clear"), "/clear",
     "and the command-only kind stays a bare command");
});

// A command is typed and EXECUTED. loom_cdp.py's compose_outgoing() returns anything starting with
// "/" untouched for exactly this reason; appending here would corrupt the command rather than
// instruct anybody. "/clear" is the live case — the context-memory clear step.
suite("PD-001: a command never carries the contract, whoever it is addressed to", () => {
  eq(withContract("context-restore", "/clear"), "/clear", "the bare clear is delivered verbatim");
  eq(withContract("context-save", "/model claude-opus-5"), "/model claude-opus-5",
     "and so is a tier switch");
  eq(withContract("brief-debug.json", "   "), "   ",
     "an empty body is left alone rather than becoming a contract with no message");
});

// Drives the REAL injection path, not just the pure function: what loom_cdp.py is handed, and what
// the debug log records, must both be the text that was actually typed.
suite("PD-001: the contract reaches the composer, and the debug log records what was really typed", () => {
  stub();
  return run({ role: "po", webviewId: "w" }, "a worker finished", "notify-debug.json").then(() => {
    const dbg = readJson(path.join(LOOM, "notify-debug.json"));
    match(dbg.out, /\[contract\] To the owner/, "the contract was passed to the injector");
    match(dbg.message, /\[contract\] To the owner/,
      "and the log shows the contract, not the pre-contract body");
    eq(dbg.contract, true, "the log states outright that a contract was attached");
  });
});

// The briefing is 500+ chars, so the logged `message` is truncated well before the contract that
// sits at its end. Without the flag the debug file would read as though nothing was attached — a
// record that quietly contradicts what was typed is worse than no record.
suite("PD-001: a body longer than the log's truncation still records that the contract went", () => {
  stub();
  return run({ role: "po", webviewId: "w" }, "x".repeat(600), "brief-debug.json").then(() => {
    const dbg = readJson(path.join(LOOM, "brief-debug.json"));
    eq(dbg.message.length, 300, "still truncated, so the file stays readable");
    ok(!/\[contract\]/.test(dbg.message), "and the contract really is past the cut");
    eq(dbg.contract, true, "but the flag says it was attached");
    match(dbg.out, /\[contract\] To the owner/, "and it really was typed");
  });
});

suite("PD-001: the flag is false when nothing was attached", () => {
  stub();
  return run({ role: "dev2" }, "your gate exited", "gate-debug.json").then(() => {
    eq(readJson(path.join(LOOM, "gate-debug.json")).contract, false,
       "a worker message is logged as carrying none");
  });
});

suite("PD-001: a worker injection reaches the composer with the body and nothing appended", () => {
  stub();
  return run({ role: "dev2" }, "your gate exited (pid 1)", "gate-debug.json").then(() => {
    const dbg = readJson(path.join(LOOM, "gate-debug.json"));
    ok(!/\[contract\]/.test(dbg.out), "nothing was appended on the way to the worker's composer");
    match(dbg.message, /your gate exited \(pid 1\)/, "the body is intact");
  });
});

// §4 · the fix must not BE the defect. The complaint is volume standing in for a decision, so the
// thing appended to every orchestrator message is held to one line, and it is held to naming the
// four things a product report has to answer.
suite("PD-001: the contract is ONE line and names the four things a report must carry", () => {
  eq(REPORTING_CONTRACT.split("\n").length, 1,
     "one line — a paragraph appended to every message would be the defect, shipped");
  match(REPORTING_CONTRACT, /bullets/, "how to say it");
  match(REPORTING_CONTRACT, /what works/, "what the product does now");
  match(REPORTING_CONTRACT, /broken for a user/, "what is broken, in a user's terms");
  match(REPORTING_CONTRACT, /next block changes for a user/, "what the next block buys a user");
  match(REPORTING_CONTRACT, /decision the owner must make/, "and the decision being asked for");
});
