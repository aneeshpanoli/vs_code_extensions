// context.test.js — reading a session's context occupancy out of its own transcript.
// The fixtures are real transcript lines, reduced: the shapes here are what
// ~/.claude/projects/<slug>/<sessionId>.jsonl actually contains (measured 2026-09-08).
const { suite, ok, eq, load, home } = require("./harness");
const fs = require("fs");
const path = require("path");
const {
  readTranscriptContext, usageTokens, transcriptFor, newestTranscriptIn, boardSessionId, pct,
  DEFAULT_WINDOW_TOKENS,
} = load("context.js");

const PROJECTS = path.join(home, ".claude", "projects");
let n = 0;
function projectDir(name) {
  const dir = path.join(PROJECTS, name || `-proj-${++n}`);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}
function assistant(usage, extra = {}) {
  return JSON.stringify({
    type: "assistant", sessionId: extra.sessionId || "s-1", timestamp: extra.timestamp || "2026-09-08T04:41:13.084Z",
    isSidechain: extra.isSidechain,
    message: { model: extra.model || "claude-opus-5", usage },
  });
}
function transcript(dir, sessionId, lines) {
  const f = path.join(dir, `${sessionId}.jsonl`);
  fs.writeFileSync(f, lines.join("\n") + "\n");
  return f;
}

suite("context: occupancy is input + cache_read + cache_creation of the last turn", () => {
  // The real numbers off Gaming/developer: 2 + 115,282 + 885 = 116,169.
  const dir = projectDir();
  const f = transcript(dir, "s-1", [
    assistant({ input_tokens: 4, cache_read_input_tokens: 10, cache_creation_input_tokens: 1 }),
    assistant({ input_tokens: 2, cache_read_input_tokens: 115282, cache_creation_input_tokens: 885 }),
  ]);
  const r = readTranscriptContext(f, 1000000);
  eq(r.tokens, 116169, "the LAST turn's tokens, summed");
  eq(pct(r.fraction), 12, "as a percent of the window");
  eq(r.model, "claude-opus-5", "model carried through");
  eq(r.sessionId, "s-1", "session id carried through");
});

suite("context: a subagent's turn is not this session's context", () => {
  // isSidechain lines are a subagent's own thread — counting them would read a big subagent
  // job as the orchestrator filling up.
  const dir = projectDir();
  const f = transcript(dir, "s-2", [
    assistant({ input_tokens: 1, cache_read_input_tokens: 100000 }, { sessionId: "s-2" }),
    assistant({ input_tokens: 1, cache_read_input_tokens: 900000 }, { sessionId: "s-2", isSidechain: true }),
  ]);
  eq(readTranscriptContext(f, 1000000).tokens, 100001, "the sidechain turn is skipped");
});

suite("context: only the TAIL of a huge transcript is read", () => {
  // One live transcript is 63 MB; reading it whole every tick is not an option.
  const dir = projectDir();
  const filler = JSON.stringify({ type: "user", message: { content: "x".repeat(4000) } });
  const lines = [];
  for (let i = 0; i < 400; i++) lines.push(filler);           // ~1.6 MB of noise
  lines.push(assistant({ input_tokens: 3, cache_read_input_tokens: 500000 }, { sessionId: "s-3" }));
  const f = transcript(dir, "s-3", lines);
  ok(fs.statSync(f).size > 1000000, "fixture really is large");
  eq(readTranscriptContext(f, 1000000).tokens, 500003, "found in the tail");
});

suite("context: an unreadable or usage-free transcript reads as unknown, never throws", () => {
  const dir = projectDir();
  eq(readTranscriptContext(path.join(dir, "missing.jsonl")), null, "missing file");
  const f = transcript(dir, "s-4", ['{"type":"user","message":{}}', "not json at all"]);
  eq(readTranscriptContext(f), null, "no assistant usage -> null");
});

suite("context: a truncated first line in the tail is dropped, not guessed at", () => {
  const dir = projectDir();
  const f = path.join(dir, "s-5.jsonl");
  fs.writeFileSync(f, "{broken-half-line\n" + assistant({ input_tokens: 7 }, { sessionId: "s-5" }) + "\n");
  eq(readTranscriptContext(f).tokens, 7, "parses what is whole");
});

suite("context: a transcript is found by session id wherever its project dir is", () => {
  const dir = projectDir("-home-aneesh-Containers-somewhere");
  transcript(dir, "find-me", [assistant({ input_tokens: 5 })]);
  ok(String(transcriptFor("find-me")).endsWith("find-me.jsonl"), "located");
  eq(transcriptFor("nope"), null, "unknown session id");
  eq(transcriptFor(""), null, "empty id");
});

suite("context: the post-clear session is the newest file in the same directory", () => {
  // /clear starts a NEW session id: the old file stops growing and a new one appears alongside it.
  const dir = projectDir();
  const old = transcript(dir, "before", [assistant({ input_tokens: 1 })]);
  fs.utimesSync(old, new Date(1000), new Date(1000));
  const fresh = transcript(dir, "after", [assistant({ input_tokens: 2 })]);
  eq(newestTranscriptIn(dir), fresh, "newest wins");
  eq(newestTranscriptIn(dir, { exclude: "after" }), old, "excluding the new one falls back");
  eq(newestTranscriptIn(dir, { sinceMs: Date.now() + 60000 }), null, "nothing newer than the cutoff");
  eq(newestTranscriptIn(path.join(dir, "nope")), null, "missing dir -> null, no throw");
});

suite("context: the board's session_id is what points at the orchestrator's transcript", () => {
  const { makeRepo } = require("./harness");
  const repo = makeRepo({ po: { session_id: "sid-po" }, w1: {} });
  eq(boardSessionId(repo, "po"), "sid-po", "flat board entry");
  eq(boardSessionId(repo, "w1"), null, "role without one");
  eq(boardSessionId("missing", "po"), null, "missing board -> null");
});

suite("context: the default window is the measured auto-compaction ceiling", () => {
  // Measured on this machine: compaction at 999,703 / 999,195 / 999,343 tokens.
  eq(DEFAULT_WINDOW_TOKENS, 1000000, "1M, not the 200k the bare model id implies");
  eq(usageTokens(null), 0, "no usage block -> 0");
  eq(usageTokens({ input_tokens: "x", cache_read_input_tokens: 5 }), 5, "non-numeric fields ignored");
});

suite("context: an empty transcript is empty, not an error", () => {
  const dir = projectDir();
  const f = path.join(dir, "s-empty.jsonl");
  fs.writeFileSync(f, "");
  eq(readTranscriptContext(f), null, "no turns -> unknown");
});

suite("context: a turn with usage but no tokens is skipped, not read as zero", () => {
  // A zero would be a claim about the context; the reader keeps looking instead.
  const dir = projectDir();
  const f = transcript(dir, "s-zero", [
    assistant({ input_tokens: 42 }, { sessionId: "s-zero" }),
    assistant({ input_tokens: 0, cache_read_input_tokens: 0 }, { sessionId: "s-zero" }),
  ]);
  eq(readTranscriptContext(f).tokens, 42, "falls back to the last real turn");
});

suite("context: an unreadable projects root never throws", () => {
  // transcriptFor and newestTranscriptIn both walk the filesystem; both must degrade quietly.
  eq(newestTranscriptIn(path.join(PROJECTS, "no-such-dir")), null, "missing directory");
  const dir = projectDir();
  fs.writeFileSync(path.join(dir, "notes.txt"), "not a transcript");
  eq(newestTranscriptIn(dir), null, "non-jsonl files are ignored");
});
