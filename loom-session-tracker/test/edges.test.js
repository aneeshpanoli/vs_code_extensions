// edges.test.js — the boundaries and the malformed inputs.
//
// Written after the lesson of 2026-09-09: a suite built from the same assumptions as the code cannot
// falsify them. These are deliberately hostile — off-by-one on every threshold, values that are
// legal-but-surprising (0%, 100%), shapes the real world can produce (a board that is an array, a
// half-written transcript line, a repo name containing regex metacharacters), and the two names on
// this machine that differ only by case (`gaming` and `Gaming`) or by suffix (`funisland` and
// `funisland-teachladder`). Anything asserted here was RUN, not reasoned about.
const { suite, ok, eq, match, load, makeRepo, busPath, writeJson, readJson, home, LOOM } =
  require("./harness");
const fs = require("fs");
const path = require("path");

const { attributeRepo } = load("roles.js");
const { parseRead } = load("cdp.js");
const { boardRoles } = load("registry.js");
const { readTranscriptContext, usageTokens, DEFAULT_WINDOW_TOKENS } = load("context.js");
const { isBusy, BUSY_TAIL_CHARS } = load("sessions.js");
const { decide, DEFAULT_CONFIG, MIN_MEMORY_BYTES, CLEARED_PANEL_CHARS, loadState } = load("memory.js");
const { injectTo } = load("inject.js");

// ── the context percentage: 0 is a number, not "missing" ───────────────────
suite("edge: 0% context is a reading, not an absence", () => {
  // `?? null` and `|| null` differ here, and the difference is whether an idle session reads as
  // "unknown" (hold) or "0%" (fine). The panel can legitimately report 0 after a clear.
  eq(parseRead('{"t":"hi","c":0}').contextPct, 0, "zero survives the envelope");
  const s = decide(input({ panelPct: 0, reading: reading(900_000) }));
  eq(s.kind, "none", "0% from the panel outranks a 90% transcript estimate");
  match(s.note, /context 0%/, "and is reported as 0, not as unknown");
});

suite("edge: 100% context still triggers exactly once", () => {
  const s = decide(input({ panelPct: 100 }));
  eq(s.kind, "save", "fires");
  eq(s.next.triggerPct, 100, "at the cap the app itself clamps to");
});

suite("edge: a percentage that is not a number is not a percentage", () => {
  eq(parseRead('{"t":"hi","c":"73"}').contextPct, null, "a numeric string is refused");
  eq(parseRead('{"t":"hi","c":null}').contextPct, null, "null");
  eq(parseRead('{"c":73}').contextPct, null, "an envelope with no text is not our envelope");
  eq(parseRead("[1,2,3]"), { text: "[1,2,3]", contextPct: null }, "a JSON array is just text");
  eq(parseRead(""), { text: "", contextPct: null }, "empty string");
});

// ── project attribution: the names on this machine are adversarial ─────────
const REPOS = ["gaming", "Gaming", "funisland", "funisland-teachladder", "c++lib"];

suite("edge: attribution is case-sensitive, because `gaming` and `Gaming` are both real buses", () => {
  eq(attributeRepo("loom/gaming/x loom/gaming/y", REPOS).repo, "gaming", "lowercase bus");
  eq(attributeRepo("loom/Gaming/x", REPOS).repo, "Gaming", "and the capitalised one is a different project");
});

suite("edge: one project name is not a prefix of another's", () => {
  // ~/Containers holds funisland AND funisland-teachladder.
  eq(attributeRepo("Containers/funisland-teachladder/src", REPOS).repo, "funisland-teachladder",
    "the longer name is not stolen by the shorter");
  eq(attributeRepo("Containers/funisland/src", REPOS).repo, "funisland", "and vice versa");
});

suite("edge: a repo name with regex metacharacters is matched literally", () => {
  eq(attributeRepo("loom/c++lib/a loom/c++lib/b", REPOS).repo, "c++lib", "escaped, not compiled");
  eq(attributeRepo("loom/cXXlib/a", REPOS).repo, null, "and it really is literal");
});

suite("edge: both path separators count", () => {
  eq(attributeRepo("loom\\Gaming\\x", REPOS).repo, "Gaming", "backslash");
  eq(attributeRepo("loom/Gaming\\x", REPOS).repo, "Gaming", "mixed");
});

suite("edge: attribution needs a clear majority, and says so at the boundary", () => {
  const many = (repo, n) => Array(n).fill(`loom/${repo}/x`).join(" ");
  eq(attributeRepo(many("Gaming", 4) + " " + many("gaming", 1), REPOS).repo, "Gaming", "4/5 = 0.8 is enough");
  eq(attributeRepo(many("Gaming", 3) + " " + many("gaming", 1), REPOS).repo, null, "3/4 = 0.75 is not");
});

suite("edge: attribution never throws on nothing", () => {
  eq(attributeRepo("", REPOS).repo, null, "empty text");
  eq(attributeRepo("loom/Gaming/x", []).repo, null, "empty repo list");
  eq(attributeRepo(null, REPOS).repo, null, "null text");
  eq(attributeRepo("loom//x", ["", "Gaming"]).repo, null, "an empty repo name is skipped");
});

// ── decide(): every threshold, from both sides ─────────────────────────────
const reading = (tokens, sessionId = "s-old", file = "/tmp/x/s-old.jsonl") =>
  ({ tokens, fraction: tokens / 1_000_000, model: "m", at: null, sessionId, file });
function input(over = {}) {
  return {
    repo: "demo", role: "po", webviewId: "wid", reading: reading(600_000), busy: false,
    frameSeen: true, panelPct: null, panelChars: 150000, memoryFile: "/m/memory.md",
    memoryMtime: null, memorySize: 0, now: 1_800_000_000_000,
    cfg: { ...DEFAULT_CONFIG }, state: { phase: "watch" }, ...over,
  };
}
const NOW = 1_800_000_000_000, MIN = 60_000;

suite("edge: the threshold is inclusive", () => {
  eq(decide(input({ panelPct: 50 })).kind, "save", "exactly at 50% fires");
  eq(decide(input({ panelPct: 49 })).kind, "none", "one below does not");
});

suite("edge: a memory file exactly at the minimum size counts as banked", () => {
  const saving = (size) => decide(input({
    state: { phase: "saving", idleTicks: 9, phaseAt: NOW - MIN, memoryBaseline: 1000 },
    memoryMtime: 2000, memorySize: size,
  }));
  eq(saving(MIN_MEMORY_BYTES).kind, "clear", "exactly the minimum is a handoff");
  eq(saving(MIN_MEMORY_BYTES - 1).kind, "none", "one byte less is not");
});

suite("edge: the memory file must be strictly newer than the request", () => {
  const at = (mtime) => decide(input({
    state: { phase: "saving", idleTicks: 9, phaseAt: NOW - MIN, memoryBaseline: 1000 },
    memoryMtime: mtime, memorySize: 4096,
  }));
  eq(at(1000).kind, "none", "the same mtime is the OLD file, not a save");
  eq(at(1001).kind, "clear", "a millisecond newer is a save");
});

suite("edge: the cleared-panel threshold is exclusive", () => {
  const chars = (n) => decide(input({
    state: { phase: "clearing", phaseAt: NOW - MIN }, reading: null, panelPct: null, panelChars: n,
  }));
  eq(chars(CLEARED_PANEL_CHARS - 1).kind, "restore", "below the line is cleared");
  eq(chars(CLEARED_PANEL_CHARS).kind, "none", "exactly at it is not");
  eq(chars(0).kind, "restore", "an empty panel is cleared, and 0 is not mistaken for unknown");
});

suite("edge: timeouts fire strictly after the window, not at it", () => {
  const at = (age) => decide(input({ state: { phase: "saving", idleTicks: 9, phaseAt: NOW - age, memoryBaseline: 0 } }));
  eq(at(10 * MIN).kind, "none", "exactly at the 10m timeout it is still waiting");
  eq(at(10 * MIN + 1).kind, "abort", "a millisecond later it gives up");
});

suite("edge: a clock that moves backwards does not fire a timeout", () => {
  // now < phaseAt happens on an NTP correction or a suspended laptop.
  const s = decide(input({ state: { phase: "saving", idleTicks: 9, phaseAt: NOW + 3600_000, memoryBaseline: 0 } }));
  eq(s.kind, "none", "negative elapsed time is not a timeout");
});

suite("edge: a zero cooldown means no cooldown", () => {
  const s = decide(input({
    cfg: { ...DEFAULT_CONFIG, cooldownMinutes: 0 }, state: { phase: "watch", lastCycleAt: NOW },
  }));
  eq(s.kind, "save", "back-to-back cycles are allowed when asked for");
});

suite("edge: a state from another version does not crash the machine", () => {
  // 0.11.0 wrote phases watch|saving|clearing; a future one may write something else.
  const s = decide(input({ state: { phase: "restoring", phaseAt: NOW, futureField: 1 } }));
  eq(s.kind, "save", "an unknown phase is treated as watching");
  eq(s.next.futureField, 1, "and fields it does not understand are preserved");
});

suite("edge: a corrupt state file reads as a fresh watch", () => {
  const repo = makeRepo({ po: {} });
  fs.writeFileSync(busPath(repo, "context-state.json"), '{"phase":');
  eq(loadState(repo).phase, "watch", "truncated JSON");
  fs.writeFileSync(busPath(repo, "context-state.json"), '{"phase":42}');
  eq(loadState(repo).phase, "watch", "a phase that is not a string");
});

// ── boards the real world can produce ──────────────────────────────────────
suite("edge: a board that is not an object yields no roles", () => {
  for (const junk of [[], ["alpha"], "alpha", 42, null, true]) {
    const repo = makeRepo(null);
    fs.writeFileSync(busPath(repo, "board.json"), JSON.stringify(junk));
    eq(boardRoles(repo), [], `board.json = ${JSON.stringify(junk)}`);
  }
});

suite("edge: a `roles` key that is an array is not a roster", () => {
  const repo = makeRepo({ roles: ["alpha", "beta"] });
  eq(boardRoles(repo), [], "an array has no role names to take");
});

suite("edge: empty and dotted names are never roles", () => {
  const repo = makeRepo({ "": { session_id: "x" }, ".hidden": { session_id: "y" }, real: { session_id: "z" } });
  const roles = boardRoles(repo);
  ok(!roles.includes(""), "empty key dropped");
  ok(roles.includes("real"), "the real one kept");
  // A dotted bus DIRECTORY is skipped (.pytest_cache); a dotted BOARD key is the board's business.
  fs.mkdirSync(busPath(repo, ".pytest_cache"), { recursive: true });
  fs.writeFileSync(busPath(repo, ".pytest_cache", "status.json"), "{}");
  ok(!boardRoles(repo).includes(".pytest_cache"), "dotted directories are not roles");
});

suite("edge: a mailbox path that is a file, not a directory, is not a role", () => {
  const repo = makeRepo({ real: { session_id: "z" } });
  fs.writeFileSync(busPath(repo, "notes"), "just a file on the bus");
  ok(!boardRoles(repo).includes("notes"), "readdir on a file fails, and that is not a role");
});

// ── transcripts as they are actually written ───────────────────────────────
function transcript(name, lines) {
  const dir = path.join(home, ".claude", "projects", "-edge-" + name);
  fs.mkdirSync(dir, { recursive: true });
  const f = path.join(dir, name + ".jsonl");
  fs.writeFileSync(f, lines.join("\n"));
  return f;
}
const turn = (usage, extra = {}) => JSON.stringify({
  type: "assistant", sessionId: extra.sessionId, message: { model: "m", usage },
});

suite("edge: a half-written last line falls back to the last complete turn", () => {
  // The file is appended to live; a read can land mid-write.
  const f = transcript("partial", [turn({ input_tokens: 500 }), '{"type":"assistant","mess']);
  eq(readTranscriptContext(f).tokens, 500, "the complete turn is used");
});

suite("edge: CRLF line endings parse", () => {
  const dir = path.join(home, ".claude", "projects", "-edge-crlf");
  fs.mkdirSync(dir, { recursive: true });
  const f = path.join(dir, "crlf.jsonl");
  fs.writeFileSync(f, turn({ input_tokens: 700 }) + "\r\n");
  eq(readTranscriptContext(f).tokens, 700, "the \\r does not break JSON.parse");
});

suite("edge: a transcript with no sessionId field falls back to its filename", () => {
  const f = transcript("named-by-file", [turn({ input_tokens: 5 })]);
  eq(readTranscriptContext(f).sessionId, "named-by-file", "identity comes from somewhere");
});

suite("edge: a nonsense window size falls back to the measured default", () => {
  const f = transcript("window", [turn({ input_tokens: 500_000 })]);
  eq(readTranscriptContext(f, 0).fraction, 0.5, "0 is not a divisor");
  eq(readTranscriptContext(f, -1).fraction, 0.5, "nor is a negative one");
  eq(readTranscriptContext(f, DEFAULT_WINDOW_TOKENS).fraction, 0.5, "matching the default");
});

suite("edge: usage fields that are not numbers contribute nothing", () => {
  eq(usageTokens({ input_tokens: null, cache_read_input_tokens: undefined }), 0, "nulls");
  eq(usageTokens({ input_tokens: Infinity, cache_read_input_tokens: 5 }), 5, "infinity is not a count");
  eq(usageTokens({ input_tokens: NaN, cache_read_input_tokens: 5 }), 5, "NaN is not a count");
  eq(usageTokens("nope"), 0, "not an object");
});

// ── the busy marker, at the edge of the window it looks in ─────────────────
suite("edge: the busy marker is only believed near the composer", () => {
  const marker = "Claude is working";
  eq(isBusy("x".repeat(100) + marker + "y".repeat(BUSY_TAIL_CHARS - marker.length - 1)), true,
    "just inside the tail");
  eq(isBusy(marker + "y".repeat(BUSY_TAIL_CHARS)), false,
    "pushed out of the tail by later text — a conversation that merely quotes it does not count");
  eq(isBusy(""), false, "empty");
  eq(isBusy(null), false, "null");
});

// ── injection carries text verbatim ────────────────────────────────────────
suite("edge: a prompt with newlines, quotes and shell metacharacters arrives intact", () => {
  // execFile takes an argv array — no shell — so none of this can be interpreted. Worth proving:
  // the save prompt is multi-line and contains bullets, and a role name could contain anything.
  const argvFile = path.join(LOOM, "edge-argv.json");
  fs.mkdirSync(LOOM, { recursive: true });
  fs.writeFileSync(path.join(LOOM, "loom_cdp.py"),
    `import sys, json\njson.dump(sys.argv[1:], open(${JSON.stringify(argvFile)}, "w"))\nprint("{'ok': True}")\n`);
  const nasty = "line one\nline two \"quoted\" 'single' $(rm -rf /) `whoami` ; echo pwned\n  • bullet — em";
  return new Promise((resolve, reject) => {
    injectTo({ role: "po", webviewId: "wid-1" }, nasty, "edge-debug.json", (okFlag) => {
      try {
        ok(okFlag, "reported ok");
        const argv = readJson(argvFile);
        eq(argv[argv.indexOf("--message") + 1], nasty, "the message arrived byte for byte");
        eq(argv[argv.indexOf("--webview-id") + 1], "wid-1", "and so did the frame id");
        resolve();
      } catch (e) { reject(e); }
    });
  });
});

suite("edge: an empty message is still delivered as an argument", () => {
  fs.writeFileSync(path.join(LOOM, "loom_cdp.py"), "import sys\nprint(' '.join(sys.argv[1:]))\n");
  return new Promise((resolve, reject) => {
    injectTo({ role: "po" }, "", "edge-debug2.json", (okFlag) => {
      try { ok(okFlag, "no crash on an empty prompt"); resolve(); } catch (e) { reject(e); }
    });
  });
});
