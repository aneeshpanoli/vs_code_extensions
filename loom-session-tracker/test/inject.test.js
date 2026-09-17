// inject.test.js — the delivery layer. It shells out to loom_cdp.py, so the tests stub that file with
// a python script that reports back what it was asked to do.
const { suite, ok, eq, match, load, readJson, LOOM, makeRepo } = require("./harness");
const fs = require("fs");
const path = require("path");
const { injectTo, REPLY_FOR, REPORTING_CONTRACT, ORCHESTRATOR_KINDS, WORKER_KINDS,
        withContract, buildStamp, isClearCommand, isOrchestratorTarget, clearRefusal } = load("inject.js");
const { setOrchestrator } = load("orchestrator.js");

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
    // MOD-001 §5 · this asserted `eq(typed, body)` — "delivered exactly as written" — while the
    // contract was the only thing that could ever be appended, so exact equality and "no contract"
    // were the same claim. They are not any more: every non-command message now carries a build
    // stamp. The claim PD-001 owns is the CONTRACT's absence, asserted above; what equality was
    // also protecting is that the worker's own figures reach it unaltered, asserted here.
    ok(typed.startsWith(body), `${kind} keeps the worker's figures first and unaltered`);
    eq(typed, `${body}\n\n${buildStamp()}`, `${kind} carries the build stamp and nothing else`);
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


// ── CX-001 · THE CHOKEPOINT REFUSES A CLEAR AIMED AT AN ORCHESTRATOR ──────────────────────────
//
// Owner, 2026-09-16: "Do not ever clear the orchestrator's context."
//
// memory.ts no longer produces a clear step, and that is the removal. This is the GUARANTEE — the
// part that survives a caller written next month by someone who never read memory.ts. Every test
// below is in BOTH directions on purpose: the refusal is worthless if it also stops a WORKER being
// cleared, because clearing workers between handoffs is playbook §12 and a standing owner directive.

suite("CX-001: what counts as a clear COMMAND, and what is merely prose about clearing", () => {
  // The distinction the whole guard rests on. A composer executes a line as a command only when it
  // STARTS with the slash, so anything else — however much it talks about clearing — is a message.
  ok(isClearCommand("/clear"), "the bare command");
  ok(isClearCommand("  /clear  "), "leading whitespace is still a command to the composer");
  ok(isClearCommand("/CLEAR"), "case does not change what the composer does with it");
  ok(isClearCommand("/clear now"), "with an argument");
  ok(!isClearCommand("/clearcache"), "a different command that merely starts the same way");
  ok(!isClearCommand(""), "nothing is not a command");
  ok(!isClearCommand("please /clear the worker"), "a slash mid-sentence is typed, not executed");
  // THE ONE THAT WOULD HAVE UNDONE PLAYBOOK §12. health.ts's clearReminder is orchestrator-addressed
  // prose telling the orchestrator to clear its WORKERS, and its debug file is named clear-debug.json.
  // A guard keyed on the word "clear", or on the debug name, would have silently killed it.
  const { HealthWatcher } = load("health.js");
  const reminder = new HealthWatcher(null).clearReminder(
    { repo: "demo", role: "developer1", blocks: 3, ids: ["A-1", "A-2", "A-3"], since: "yesterday" });
  match(reminder, /clear developer1 and re-bind it/, "the reminder does say the word, in prose");
  ok(!isClearCommand(reminder), "and it is NOT a command — the §12 reminder still goes out");
});

suite("CX-001: who counts as an orchestrator — by owner NAME and by the project's TAG", () => {
  ok(isOrchestratorTarget("product-owner", null), "an owner-named role, with no tag on the bus at all");
  ok(isOrchestratorTarget("productowner", null), "whatever spelling the project uses");
  ok(isOrchestratorTarget("po", null), "livegita's spelling too");
  // the case NAMES cannot catch: a project whose orchestrator is called something unremarkable
  ok(isOrchestratorTarget("gitadeveloper", "gitadeveloper"), "the tagged role, whatever it is called");
  ok(!isOrchestratorTarget("developer1", "gitadeveloper"), "a worker is not the tagged role");
  ok(!isOrchestratorTarget("developer1", null), "and a worker on an untagged bus is still a worker");
  ok(!isOrchestratorTarget("", "developer1"), "an empty role names nobody");
});

suite("CX-001: the refusal fires on BOTH halves together, never on one alone", () => {
  // Both, or nothing. Either half on its own would be wrong in a way that breaks something real.
  ok(clearRefusal("product-owner", "/clear", null), "clear + orchestrator -> refused");
  ok(!clearRefusal("developer1", "/clear", null), "clear + WORKER -> allowed (playbook §12)");
  ok(!clearRefusal("product-owner", "[loom-clears] clear developer1 and re-bind it", null),
     "prose + orchestrator -> allowed, or the §12 reminder itself would be blocked");
  ok(!clearRefusal("developer1", "hello", null), "neither -> allowed");
  match(String(clearRefusal("product-owner", "/clear", null)), /never clears an orchestrator/,
     "and the refusal says why, so it is not read as a broken injector");
  match(String(clearRefusal("gitadeveloper", "/clear", "gitadeveloper")), /tagged orchestrator/,
     "naming which of the two tests caught it");
});

suite("CX-001: injectTo REFUSES a /clear at the orchestrator — nothing is spawned, and it says so", () => {
  stub();
  const repo = makeRepo({ po: {} });
  setOrchestrator(repo, "po", "wid-po");
  fs.rmSync(path.join(LOOM, "t-clear-refused.json"), { force: true });
  return run({ role: "po", webviewId: "wid-po", repo }, "/clear", "t-clear-refused.json").then((r) => {
    eq(r.ok, false, "the caller is told it did not happen");
    match(r.note, /never clears an orchestrator/, "with the reason");
    const dbg = readJson(path.join(LOOM, "t-clear-refused.json"));
    eq(dbg.refused, true, "the refusal is on the record, not a silent no-op");
    eq(dbg.ok, false);
    // THE ASSERTION THAT MATTERS: the injector was never even invoked. The stub echoes its argv into
    // `out`, so an empty `out` is proof no python ran and nothing was typed anywhere.
    eq(dbg.out, "", "loom_cdp.py was never spawned — no text reached any composer");
  });
});

suite("CX-001: a WORKER's /clear still goes through, BYTE-IDENTICAL to before the guard", () => {
  // THE LOAD-BEARING HALF. Playbook §12 clears a worker between every handoff; a guard that also
  // stopped that would silently undo a standing owner directive from 2026-09-08.
  stub();
  const repo = makeRepo({ developer1: {} });
  setOrchestrator(repo, "po", "wid-po");          // there IS an orchestrator; it is just not the target
  return run({ role: "developer1", webviewId: "wid-d1", repo }, "/clear", "t-clear-worker.json").then((r) => {
    ok(r.ok, "delivered");
    const dbg = readJson(path.join(LOOM, "t-clear-worker.json"));
    eq(dbg.message, "/clear", "the message is unchanged — no contract, no header, no rewriting");
    eq(dbg.contract, false, "a command never carries the reporting contract");
    match(dbg.out, /--role developer1/, "addressed to the worker");
    match(dbg.out, /--webview-id wid-d1/, "at its own frame");
    match(dbg.out, /--submit/, "and actually submitted");
  });
});

suite("CX-001: the refusal is by ROLE, so it holds for a tagged orchestrator with a worker-ish name", () => {
  // livegita's orchestrator is named `po`; another project's could be named anything. The NAME test
  // cannot catch that one — only the tag can, and the tag is re-read on every injection because it
  // can be moved between ticks.
  stub();
  const repo = makeRepo({ gitadeveloper: {} });
  setOrchestrator(repo, "gitadeveloper", "wid-x");
  return run({ role: "gitadeveloper", webviewId: "wid-x", repo }, "/clear", "t-clear-tagged.json").then((r) => {
    eq(r.ok, false, "refused on the tag alone");
    match(r.note, /tagged orchestrator/, "and says which test caught it");
    eq(readJson(path.join(LOOM, "t-clear-tagged.json")).out, "", "nothing was spawned");
  });
});

suite("CX-001: everything that is NOT a clear reaches the orchestrator exactly as before", () => {
  // The guard must be invisible to the nine other messages this extension sends upward. A refusal
  // that also swallowed the stall alert or the finish notice would be a far larger outage than the
  // behaviour it removed.
  stub();
  const repo = makeRepo({ po: {} });
  setOrchestrator(repo, "po", "wid-po");
  return run({ role: "po", webviewId: "wid-po", repo },
             "[loom-stall] developer1 has been \"working\" with no status update for 3.0h.",
             "stall-debug.json").then((r) => {
    ok(r.ok, "delivered");
    const dbg = readJson(path.join(LOOM, "stall-debug.json"));
    ok(!dbg.refused, "not refused");
    match(dbg.out, /--webview-id wid-po/, "and it went to the orchestrator's frame");
    eq(dbg.contract, true, "still carrying the reporting contract it is supposed to carry");
  });
});

// ── PB-001 · THE NEW MESSAGE SITS ON THE ORCHESTRATOR SIDE, AND THE BOUNDARY IS ASSERTED BOTH WAYS ──

suite("inject: the delegation reminder is an ORCHESTRATOR message and carries the contract", () => {
  const { ORCHESTRATOR_KINDS, WORKER_KINDS, withContract, REPORTING_CONTRACT, REPLY_FOR } =
    load("inject.js");
  ok(ORCHESTRATOR_KINDS.has("delegate-debug.json"), "classified upward");
  ok(!WORKER_KINDS.has("delegate-debug.json"), "and not as a worker message");
  ok(withContract("delegate-debug.json", "you are working alone").includes(REPORTING_CONTRACT),
     "so it carries the §21 reporting contract like every other orchestrator message");
  ok(REPLY_FOR["delegate-debug.json"], "and it has a reply hint");
  ok(!/ring the role/i.test(REPLY_FOR["delegate-debug.json"]),
     "which is NOT 'ring the role named here' — the action is a dispatch, not an answer");
});

suite("inject: NO WORKER MESSAGE PICKS UP ANY OF PB-001 (both directions)", () => {
  // Same boundary PD-001 established. A worker owes its orchestrator counts and measurements; the
  // contract would suppress exactly the evidence this bus banks a block on.
  const { WORKER_KINDS, withContract, REPORTING_CONTRACT, buildStamp } = load("inject.js");
  for (const kind of WORKER_KINDS) {
    // MOD-001 §5 · "untouched" was exact equality, which now also forbids the build stamp. The
    // boundary this suite owns is PB-001's reminder text, so it is asserted directly: the stamp
    // names a build, the contract instructs the reader, and only the second is a worker's business.
    ok(withContract(kind, "a worker message").startsWith("a worker message"), `${kind} body intact`);
    eq(withContract(kind, "a worker message"), `a worker message\n\n${buildStamp()}`,
       `${kind} picks up the build stamp and nothing more`);
    ok(!withContract(kind, "a worker message").includes(REPORTING_CONTRACT),
       `${kind} carries no contract`);
  }
  // The gate wake is the load-bearing one: it is the message that ASKS a worker for its counts.
  ok(WORKER_KINDS.has("gate-debug.json"), "the gate wake is still named as a worker kind");
});

suite("inject: the delegation reminder is never appended to a command", () => {
  const { withContract, REPORTING_CONTRACT } = load("inject.js");
  for (const cmd of ["/clear", "/loom developer1", "/model claude-opus-5"]) {
    eq(withContract("delegate-debug.json", cmd), cmd, `${cmd} is returned verbatim`);
    ok(!withContract("delegate-debug.json", cmd).includes(REPORTING_CONTRACT), "no contract on it");
  }
});

suite("inject: the playbook pointer exists EXACTLY ONCE across every message the tool sends", () => {
  // PB-001 §4: "the playbook pointer exists exactly once, at the start of an orchestrator's life."
  // A version of this feature that attaches the playbook to every message is the "500 lines of
  // garbage" complaint shipped under a new name, so this counts the actual sources.
  const fs2 = require("fs");
  const path2 = require("path");
  const srcDir = path2.join(__dirname, "..", "src");
  let hits = [];
  for (const f of fs2.readdirSync(srcDir).filter((n) => n.endsWith(".ts"))) {
    const text = fs2.readFileSync(path2.join(srcDir, f), "utf8");
    // Only STRING LITERALS count — a comment naming the file is documentation, not bytes typed.
    for (const line of text.split("\n")) {
      if (/^\s*\/\//.test(line) || /^\s*\*/.test(line)) continue;
      if (line.includes("ORCHESTRATION-PLAYBOOK.md")) hits.push(`${f}: ${line.trim()}`);
    }
  }
  eq(hits.length, 1, `exactly one message names the playbook file (found: ${hits.join(" | ")})`);
  ok(/extension\.ts/.test(hits[0]), "and it is the restart wake, the one moment an orchestrator begins");
});

// ── MOD-001 §5 · WHICH BUILD SAID THIS ─────────────────────────────────────────────────────────
//
// An alarm that cannot name its build is unfalsifiable: a live `[loom-clears]` was read as a claim
// about main, and proving it had come from 0.44.0 cost a block's attention. These assert the stamp
// at the ONE point every injection passes, which is why no message builder needed editing — and
// which is also why `watchers.ts`, owned by another live handoff, is covered without being touched.
suite("MOD-001: every non-command injection names the build that sent it", () => {
  const { withContract, setBuildVersion, buildStamp, ORCHESTRATOR_KINDS, WORKER_KINDS } = load("inject.js");
  setBuildVersion("0.52.0");
  eq(buildStamp(), "[loom-session-tracker 0.52.0]", "the stamp is the version, not a guess");
  for (const kind of [...ORCHESTRATOR_KINDS, ...WORKER_KINDS, "some-future-debug.json"]) {
    ok(withContract(kind, "a reminder").includes("[loom-session-tracker 0.52.0]"),
       `${kind} names its build — a kind added later inherits this without knowing the rule exists`);
  }
});

suite("MOD-001: a COMMAND is still returned verbatim — a stamp would be typed as part of it", () => {
  const { withContract, setBuildVersion } = load("inject.js");
  setBuildVersion("0.52.0");
  for (const cmd of ["/clear", "/loom developer2", "/model claude-opus-5"]) {
    eq(withContract("spawn-debug.json", cmd), cmd, `${cmd} carries no stamp`);
    eq(withContract("clear-debug.json", cmd), cmd, `${cmd} carries no stamp, orchestrator-bound either`);
  }
  eq(withContract("notify-debug.json", ""), "", "and an empty message stays empty");
});

suite("MOD-001: an unset or blank version says 'unknown' rather than inventing a number", () => {
  const { setBuildVersion, buildStamp } = load("inject.js");
  for (const bad of [null, "", "   ", undefined]) {
    setBuildVersion(bad);
    eq(buildStamp(), "[loom-session-tracker unknown]",
       `${JSON.stringify(bad)} is reported as unknown — a wrong number is worse than no number`);
  }
  setBuildVersion("0.52.0");
});

suite("MOD-001: the debug log's `contract` flag tracks the CONTRACT, not 'something was appended'", () => {
  const { setBuildVersion } = load("inject.js");
  setBuildVersion("0.52.0");
  stub();
  // gate-debug.json is worker-facing: stamped, but carrying no contract. Before the stamp existed
  // the flag was `outgoing !== message`, which would now report this as contract: true.
  return run({ role: "dev2" }, "your gate exited", "gate-debug.json").then(() => {
    const dbg = readJson(path.join(LOOM, "gate-debug.json"));
    eq(dbg.contract, false, "a stamped worker message is still logged as carrying NO contract");
    eq(dbg.build, "0.52.0", "and the log names the build, where a disputed reminder is read");
    match(dbg.message, /\[loom-session-tracker 0\.52\.0\]/, "the stamp is in the logged text too");
  });
});
