// reopen.test.js — which sessions came back empty, and which transcript brings each back.
const { suite, ok, eq, load, makeRepo, busPath, writeJson } = require("./harness");
const { freshestSession, missingRoles, projectDirFor, previouslyLive } = load("reopen.js");
const fs = require("fs"), path = require("path");
const HOME = process.env.HOME;
const tx = (dir, sid, ageMs) => {
  fs.mkdirSync(dir, { recursive: true }); const f = path.join(dir, sid + ".jsonl");
  fs.writeFileSync(f, "{}\n"); const t = (Date.now() - ageMs) / 1000; fs.utimesSync(f, t, t); return f;
};

suite("reopen: the project dir is the cwd with / and . turned into -", () => {
  eq(projectDirFor("/home/aneesh/Containers/funisland/.claude/worktrees/curriculum"),
     path.join(HOME, ".claude", "projects", "-home-aneesh-Containers-funisland--claude-worktrees-curriculum"));
});

suite("reopen: the freshest transcript wins, whether it is the board's or the worktree's", () => {
  // Measured 2026-09-09: livegita's board sid for `developer` was OLDER than the worktree's newest.
  const wt = "/tmp/wt/developer";
  const repo = makeRepo({ developer: { session_id: "boardsid0", worktree: wt } }, "reopen-fresh");
  tx(path.join(HOME, ".claude", "projects", "-x"), "boardsid0", 3 * 3600_000);          // 3h old
  const newer = tx(projectDirFor(wt), "wtsid0000", 10 * 60_000);                          // 10 min old
  const c = freshestSession(repo, "developer");
  eq(c.sessionId, "wtsid0000", "worktree transcript is newer"); eq(c.source, "worktree"); eq(c.file, newer);
  // and the other way round
  const repo2 = makeRepo({ curriculum: { session_id: "boardsid1", worktree: "/tmp/wt/curriculum" } }, "reopen-fresh2");
  tx(path.join(HOME, ".claude", "projects", "-y"), "boardsid1", 60_000);
  tx(projectDirFor("/tmp/wt/curriculum"), "wtsid1111", 3600_000);
  eq(freshestSession(repo2, "curriculum").source, "board", "board sid is newest here");
});

suite("reopen: only roles that are NOT live and HAVE a transcript are offered", () => {
  const repo = makeRepo({
    developer: { session_id: "s-dev", worktree: "/tmp/wt/d2" },
    designer:  { session_id: "s-des" },                 // no transcript anywhere
    po:        { session_id: "s-po" },
  }, "reopen-missing");
  tx(path.join(HOME, ".claude", "projects", "-z"), "s-dev", 1000);
  tx(path.join(HOME, ".claude", "projects", "-z"), "s-po", 1000);
  const m = missingRoles(repo, new Set(["po"]));                // the PO is live
  eq(m.map((c) => c.role), ["developer"], "developer missing; designer has nothing to reopen; po is live");
  eq(freshestSession(repo, "designer"), null, "no transcript -> null, never a guess");
});

suite("reopen: previouslyLive is the pre-restart targetmap + bindings, and aliases count as live", () => {
  const repo = makeRepo({ developer: { session_id: "s1", worktree: "/tmp/wt/pl" }, gitadeveloper: { session_id: "s2" },
                          trader: { session_id: "s3" } }, "reopen-prev");
  writeJson(busPath(repo, "targetmap.json"), { "old-wid-1": "developer" });
  writeJson(busPath(repo, "bindings.json"), { "old-wid-2": "gitadeveloper" });
  eq([...previouslyLive(repo)].sort(), ["developer", "gitadeveloper"], "trader was not open before the restart");
  writeJson(busPath(repo, "naming.json"), { aliases: { gitadeveloper: "developer" } });
  tx(path.join(HOME, ".claude", "projects", "-p"), "s2", 1000);
  eq(missingRoles(repo, new Set(["developer"])).length, 0, "gitadeveloper is live through its alias");
});
