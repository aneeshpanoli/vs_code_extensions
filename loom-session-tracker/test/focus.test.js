// focus.test.js — clicking a role in the sidebar brings its tab forward, and NEVER opens a duplicate.
//
// The primitive is Claude's own `claude-vscode.editor.open(sessionId)`: for a session that is already
// open it calls reveal() and returns; for one that is not, it opens the transcript in a NEW tab. So the
// only question that matters is "is this session open right now?", and text cannot answer it —
// measured 2026-09-12, one live panel quoted eleven other sessions' ids. The board entry a role writes
// for itself, plus a transcript that is being written this quarter-hour, can.
const { suite, ok, eq, match, load, makeRepo, busPath, writeJson } = require("./harness");
const { planFocus, FRESH_MS } = load("focus.js");
const fs = require("fs"), path = require("path");
const HOME = process.env.HOME;
const tx = (sid, ageMs) => {
  const dir = path.join(HOME, ".claude", "projects", "-focus-" + sid); fs.mkdirSync(dir, { recursive: true });
  const f = path.join(dir, sid + ".jsonl"); fs.writeFileSync(f, "{}\n");
  const t = (Date.now() - ageMs) / 1000; fs.utimesSync(f, t, t); return f;
};

suite("focus: a role whose transcript is being written right now is revealed", () => {
  const repo = makeRepo({ developer1: { session_id: "sid-live-1" } }, "focus-live");
  tx("sid-live-1", 30_000);
  const p = planFocus(repo, "developer1");
  eq(p.kind, "reveal", JSON.stringify(p));
  eq(p.sessionId, "sid-live-1", "the board's own session id");
});

suite("focus: a stale transcript is refused — opening it would be a duplicate tab", () => {
  const repo = makeRepo({ developer1: { session_id: "sid-old-1" } }, "focus-stale");
  tx("sid-old-1", FRESH_MS + 60_000);
  const p = planFocus(repo, "developer1");
  eq(p.kind, "refuse");
  match(p.reason, /duplicate/, "and the reason says why: " + p.reason);
  match(p.reason, /\/loom developer1/, "and how to fix it");
});

suite("focus: no board session, no transcript, no project — each refused with its own reason", () => {
  const repo = makeRepo({ developer1: {}, designer: { session_id: "sid-ghost" } }, "focus-none");
  match(planFocus(repo, "developer1").reason, /has not bound itself/, "no session_id on the board");
  match(planFocus(repo, "designer").reason, /no transcript on disk/, "a session id nothing was written for");
  match(planFocus(null, "developer1").reason, /not scoped to a project/, "no window project");
});
