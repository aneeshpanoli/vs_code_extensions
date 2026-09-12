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
