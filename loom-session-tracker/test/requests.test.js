// requests.test.js — an orchestrator opening its own role sessions.
// Written from the 2026-09-12 request, verbatim: "Reopen the three role sessions from the LOOM
// SESSIONS panel… Once they exist I will find each by its block id and worktree path, rewrite its id
// file, ring it to continue where it stood, and confirm pickup." Every step there is the
// orchestrator's own work except the one it cannot perform.
const { suite, ok, eq, load, makeRepo, busPath, writeJson } = require("./harness");
const { planOpen, readRequest, writeResult, REQUEST_TTL_MS } = load("requests.js");
const fs = require("fs"), path = require("path");
const HOME = process.env.HOME;

const tx = (dir, sid) => {
  fs.mkdirSync(dir, { recursive: true });
  const f = path.join(dir, sid + ".jsonl"); fs.writeFileSync(f, "{}\n"); return f;
};
/** a role the bus can actually reopen: board entry + a transcript */
const reopenable = (repo, role, sid) => {
  tx(path.join(HOME, ".claude", "projects", "-p-" + repo), sid);
};
const request = (repo, roles, at) =>
  writeJson(busPath(repo, "open-requests.json"), { roles, requestedAt: at ?? new Date().toISOString() });

function bus(roles) {
  const board = {};
  for (const [r, sid] of Object.entries(roles)) board[r] = { session_id: sid };
  return board;
}

suite("requests: the roles asked for are opened from their freshest transcript", () => {
  const repo = makeRepo(bus({ developer1: "s-d1", socialworker1: "s-sw1", productowner: "s-po" }), "req-open");
  reopenable(repo, "developer1", "s-d1"); reopenable(repo, "socialworker1", "s-sw1");
  request(repo, ["developer1", "socialworker1"]);
  const p = planOpen(repo, new Set(), 5);
  eq(p.open.map((c) => c.role).sort(), ["developer1", "socialworker1"]);
  eq(p.refused, []);
  ok(p.consumed, "the request file is consumed so it cannot loop");
});

suite("requests: the boundaries, each refused with a reason", () => {
  const repo = makeRepo(bus({ developer1: "s-d1", productowner: "s-po" }), "req-bounds");
  reopenable(repo, "developer1", "s-d1"); reopenable(repo, "productowner", "s-po");
  request(repo, ["productowner", "developer1", "notarole"]);
  const p = planOpen(repo, new Set(["developer1"]), 5);     // developer1 is already live
  eq(p.open, [], "nothing opened");
  const why = Object.fromEntries(p.refused.map((r) => [r.role, r.reason]));
  ok(/orchestrator/.test(why.productowner), `an orchestrator is never opened this way: ${why.productowner}`);
  ok(/already live/.test(why.developer1), `a live role is not reopened: ${why.developer1}`);
  ok(/not a role of/.test(why.notarole), `a request cannot invent a role: ${why.notarole}`);
});

suite("requests: a request cannot exceed the active-session cap", () => {
  const repo = makeRepo(bus({ developer1: "s1", developer2: "s2", developer3: "s3" }), "req-cap");
  for (const [r, s] of [["developer1", "s1"], ["developer2", "s2"], ["developer3", "s3"]]) reopenable(repo, r, s);
  request(repo, ["developer1", "developer2", "developer3"]);
  const p = planOpen(repo, new Set(), 2);                    // only two slots left
  eq(p.open.length, 2, "opens what fits");
  eq(p.refused.map((r) => r.reason), ["active-session cap reached"], "and says why the rest did not");
});

suite("requests: a stale file cannot open tabs later", () => {
  const repo = makeRepo(bus({ developer1: "s-d1" }), "req-stale");
  reopenable(repo, "developer1", "s-d1");
  request(repo, ["developer1"], new Date(Date.now() - REQUEST_TTL_MS - 60_000).toISOString());
  const p = planOpen(repo, new Set(), 5);
  eq(p.open, [], "a request from a session that has since died opens nothing");
  ok(/stale/.test(p.refused[0].reason), p.refused[0].reason);
  ok(p.consumed, "and it is consumed, so it cannot sit there firing forever");
});

suite("requests: a role with no transcript is spawned fresh, never reopened from a guess", () => {
  const repo = makeRepo(bus({ designer: "s-none" }), "req-notx");
  request(repo, ["designer"]);
  const p = planOpen(repo, new Set(), 5);
  eq(p.open, [], "nothing to reopen — there is no transcript, and it does not invent one");
  eq(p.spawn, ["designer"], "so it is spawned as a new conversation and bound");
  eq(p.refused, []);
});

suite("requests: no file means no work, and the result is readable afterwards", () => {
  const repo = makeRepo(bus({ developer1: "s-d1" }), "req-none");
  eq(readRequest(repo), null, "absent file");
  eq(planOpen(repo, new Set(), 5).consumed, false, "nothing to consume");
  writeResult(repo, [{ role: "developer1", sessionId: "s-d1", source: "board", file: "/x", mtime: 1 }],
              [{ role: "designer", reason: "no transcript to reopen it from" }]);
  const back = JSON.parse(fs.readFileSync(busPath(repo, "open-requests.json"), "utf8"));
  eq(back.opened[0].role, "developer1", "the orchestrator can read back what happened");
  eq(back.refused[0].role, "designer");
  ok(back.servedAt, "and when");
  eq(readRequest(repo), null, "a result is not itself a request");
});

suite("requests: a role that has NEVER had a session is spawned and bound, not refused", () => {
  // "Spin up the roles they need" — a brand-new role has no transcript to reopen. The channel now
  // opens a fresh conversation for it and binds it with /loom <role>, instead of refusing.
  const repo = makeRepo(bus({ developer1: "s-d1", socialworker1: "s-new" }), "req-spawn");
  reopenable(repo, "developer1", "s-d1");                   // developer1 can be REOPENED
  request(repo, ["developer1", "socialworker1"]);          // socialworker1 has no transcript anywhere
  const p = planOpen(repo, new Set(), 5);
  eq(p.open.map((c) => c.role), ["developer1"], "reopened from its transcript");
  eq(p.spawn, ["socialworker1"], "spawned fresh");
  eq(p.refused, [], "nothing refused");
});

suite("requests: spawns count against the cap too", () => {
  const repo = makeRepo(bus({ a1: "x", b1: "y", c1: "z" }), "req-spawn-cap");
  request(repo, ["a1", "b1", "c1"]);                        // none has a transcript
  const p = planOpen(repo, new Set(), 2);
  eq(p.spawn.length, 2); eq(p.refused.map((r) => r.reason), ["active-session cap reached"]);
});

suite("requests: the result names the frame each tab came up in", () => {
  const repo = makeRepo(bus({ developer1: "s-d1" }), "req-result-frame");
  writeResult(repo, [{ role: "developer1", sessionId: "s-d1", from: "board", webviewId: "wid-new-1" },
                     { role: "socialworker1", sessionId: null, from: "spawned", webviewId: "wid-new-2", bound: true }], []);
  const back = JSON.parse(fs.readFileSync(busPath(repo, "open-requests.json"), "utf8"));
  eq(back.opened[0].webviewId, "wid-new-1", "the orchestrator can ring it directly");
  eq(back.opened[1].from, "spawned"); eq(back.opened[1].bound, true, "and knows the bind landed");
});

suite("requests: every message the extension sends an orchestrator tells it how to open its own roles", () => {
  // 2026-09-12: ReciEats' PO wrote "Lane A's tab did not come back. That costs nothing: A is held with
  // no block in flight" — and held it. The channel existed; nothing had ever told the PO. A capability
  // an orchestrator is never told about does not exist for it.
  const { restoreMessage } = load("memory.js");
  const restore = restoreMessage("/x/memory.md", "ReciEats", "productowner");
  ok(/open-requests\.json/.test(restore), "the post-/clear restore names the channel");
  ok(/§15/.test(restore), "and points at the playbook section");
  ok(/do not ask a person/.test(restore), "and says not to wait for a human");
  const fs = require("fs"), path = require("path");
  const ext = fs.readFileSync(path.join(__dirname, "..", "out", "extension.js"), "utf8");
  const wake = ext.slice(ext.indexOf("[loom-restart]"), ext.indexOf("[loom-restart]") + 900);
  ok(/open-requests\.json/.test(wake), "the restart wake names the channel too");
  ok(/do not wait for a person/.test(wake), "and says not to wait");
});

suite("requests: a role stranded in another cwd is SPAWNED and bound, never reopened blank", () => {
  // Measured 2026-09-13 05:50 (ReciEats/designer): editor.open on a worktree transcript from the main
  // window produced a 410-character "Untitled" shell, and the orchestrator got webviewId back for a
  // tab with no memory and no binding.
  const { projectDirFor } = load("reopen.js");
  const { strandedNote } = load("requests.js");
  const win = "/home/x/Containers/RE";
  const wtc = win + "/.claude/worktrees/designer";
  const repo = makeRepo({ designer: { session_id: "s-des", worktree: wtc }, developer2: { session_id: "s-d2" } }, "req-stranded");
  tx(projectDirFor(wtc), "s-des");                            // only in the worktree's dir
  tx(projectDirFor(win), "s-d2");                             // resumable here
  request(repo, ["designer", "developer2"]);
  const p = planOpen(repo, new Set(), 5, Date.now(), win);
  eq(p.open.map((c) => c.role), ["developer2"], "the resumable one is reopened");
  eq(p.spawn, ["designer"], "the stranded one is spawned fresh");
  eq(p.stranded.map((s) => [s.role, s.sessionId, s.cwd]), [["designer", "s-des", wtc]], "and reported as stranded");
  ok(/s-des.*cannot be resumed from this window/.test(strandedNote(p.stranded[0])), "the note tells the orchestrator why");
  eq(p.refused, []);
  // Without a window cwd the old behaviour holds: the transcript is opened.
  request(repo, ["designer"]);
  eq(planOpen(repo, new Set(), 5).open.map((c) => c.role), ["designer"]);
});

// ── the guard's two answers, at the spawn path (OV-001-R1 §1(3)) ────────────────────────────────

suite("requests: an overlapping role is REFUSED, and one waved through by the exemption is REPORTED", () => {
  // The defect this closes: a refusal came back in `refused` with a reason, while a non-refusal the
  // exemption caused came back as an ordinary open — indistinguishable from two genuinely disjoint
  // briefs. The orchestrator could not tell that a judgement had been made for it.
  const list = (id, files) => `---\nid: ${id}\nfiles:\n${files.map((f) => `  - ${f}\n`).join("")}---\n# ${id}\n`;
  const inbox = (repo, role, text) => {
    const f = busPath(repo, role, "inbox.md");
    fs.mkdirSync(path.dirname(f), { recursive: true });
    fs.writeFileSync(f, text);
  };

  const repo = makeRepo(bus({ developer1: "s-d1", developer2: "s-d2", productowner: "s-po" }), "req-exempt");
  reopenable(repo, "developer2", "s-d2");
  inbox(repo, "developer1", list("X-1", ["src/delegation.ts", "package.json", "HANDOVER.md"]));
  inbox(repo, "developer2", list("X-2", ["src/overlap.ts", "package.json", "HANDOVER.md"]));
  writeJson(busPath(repo, "developer1", "status.json"), { status: "working", current: "X-1" });
  request(repo, ["developer2"]);
  const p = planOpen(repo, new Set(["developer1"]), 5);
  eq(p.open.map((c) => c.role), ["developer2"], "the dispatch happens — that is what the exemption is for");
  eq(p.refused, [], "nothing is refused");
  eq(p.exempted, [{ role: "developer2", reason: "shares package.json with developer1, allowed as a mechanical merge" }],
     "and the file the guard let through is named, in the result the orchestrator reads back");

  // A REAL shared file still refuses, and then there is no exemption line: one answer per pair.
  const repo2 = makeRepo(bus({ developer1: "s-d1", developer2: "s-d2", productowner: "s-po" }), "req-exempt2");
  reopenable(repo2, "developer2", "s-d2");
  inbox(repo2, "developer1", list("X-3", ["src/overlap.ts", "package.json"]));
  inbox(repo2, "developer2", list("X-4", ["src/overlap.ts", "package.json"]));
  writeJson(busPath(repo2, "developer1", "status.json"), { status: "working", current: "X-3" });
  request(repo2, ["developer2"]);
  const p2 = planOpen(repo2, new Set(["developer1"]), 5);
  eq(p2.open, [], "no tab is opened");
  eq(p2.refused.map((r) => r.reason), ["overlaps developer1 on src/overlap.ts"], "the refusal names the real file");
  eq(p2.exempted, [], "and says nothing about the manifest it also shared — the refusal is the report");

  // Two disjoint briefs are silent, as they always were: the note exists to mark a JUDGEMENT, not a
  // dispatch, and a line on every open would be noise nobody reads.
  const repo3 = makeRepo(bus({ developer1: "s-d1", developer2: "s-d2", productowner: "s-po" }), "req-exempt3");
  reopenable(repo3, "developer2", "s-d2");
  inbox(repo3, "developer1", list("X-5", ["src/a.ts"]));
  inbox(repo3, "developer2", list("X-6", ["src/b.ts"]));
  writeJson(busPath(repo3, "developer1", "status.json"), { status: "working", current: "X-5" });
  request(repo3, ["developer2"]);
  const p3 = planOpen(repo3, new Set(["developer1"]), 5);
  eq(p3.open.map((c) => c.role), ["developer2"]); eq(p3.exempted, [], "nothing was waived, so nothing is said");

  // AND A ROLE IS NEVER IN BOTH LISTS. The first draft noted the exemption BEFORE the cap check, so a
  // role held back for a slot came back refused AND waived in one result — the note claiming a file
  // two roles were about to edit unguarded when nothing had been dispatched at all. Found by the
  // refutation pass; this is the assertion that keeps it fixed.
  const repo4 = makeRepo(bus({ developer1: "s-d1", developer2: "s-d2", productowner: "s-po" }), "req-exempt4");
  reopenable(repo4, "developer2", "s-d2");
  inbox(repo4, "developer1", list("X-7", ["src/a.ts", "package.json"]));
  inbox(repo4, "developer2", list("X-8", ["src/b.ts", "package.json"]));
  writeJson(busPath(repo4, "developer1", "status.json"), { status: "working", current: "X-7" });
  request(repo4, ["developer2"]);
  const p4 = planOpen(repo4, new Set(["developer1"]), 0);           // no slots left
  eq(p4.refused.map((r) => r.reason), ["active-session cap reached"], "the cap refuses it");
  eq(p4.exempted, [], "and nothing was waived, because nothing was dispatched");
});

suite("requests: writeResult carries `exempted` only when there is something to say", () => {
  // Narrowly named on purpose: this one drives writeResult DIRECTLY and proves only the file shape.
  // The suite above is the one that proves planOpen fills the list.
  const repo = makeRepo(bus({ designer: "s-x" }), "req-exempt-write");
  writeResult(repo, [], [], [{ role: "developer2", reason: "shares package.json with developer1, allowed as a mechanical merge" }]);
  const back = JSON.parse(fs.readFileSync(busPath(repo, "open-requests.json"), "utf8"));
  eq(back.exempted[0].role, "developer2", "the waived judgement is readable back by the orchestrator");
  writeResult(repo, [], []);
  const plain = JSON.parse(fs.readFileSync(busPath(repo, "open-requests.json"), "utf8"));
  eq("exempted" in plain, false, "and an ordinary dispatch grows no empty key");
  eq(plain.refused, [], "the keys that were always there are unchanged");
});
