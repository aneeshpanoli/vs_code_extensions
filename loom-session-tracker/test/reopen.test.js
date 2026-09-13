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

// ── a transcript resumes only from the window it was written under ──────────────────────────────
// Measured 2026-09-13 05:50: four roles reopened from their freshest transcripts, all under
// `…--claude-worktrees-<role>`; every tab came up as a blank "Untitled" shell on the pinned model.
const { resumableFrom, strandedRoles } = load("reopen.js");

suite("reopen: a transcript is resumable only from the cwd whose project dir holds it", () => {
  const win = "/home/x/Containers/Lumen";
  const here = tx(projectDirFor(win), "sid-here", 1000);
  const wt = tx(projectDirFor(win + "/.claude/worktrees/developer1"), "sid-wt", 1000);
  ok(resumableFrom(here, win), "the window's own project dir");
  ok(!resumableFrom(wt, win), "a worktree's project dir is another cwd — opens blank here");
  ok(resumableFrom(wt, win + "/.claude/worktrees/developer1"), "…and is resumable from a window ON that worktree");
  ok(resumableFrom(wt, null), "an unknown window is permissive (standalone run)");
});

suite("reopen: with a window cwd, the freshest RESUMABLE transcript wins — a fresher stranded one does not", () => {
  const win = "/home/x/Containers/R1";
  const wtc = "/home/x/Containers/R1/.claude/worktrees/developer1";
  const repo = makeRepo({ developer1: { session_id: "sid-board", worktree: wtc } }, "reopen-cwd");
  tx(projectDirFor(win), "sid-board", 3 * 3600_000);          // 3h old, resumable here
  tx(projectDirFor(wtc), "sid-wt-new", 60_000);              // 1 min old, NOT resumable here
  eq(freshestSession(repo, "developer1").sessionId, "sid-wt-new", "no cwd: freshest overall (old behaviour)");
  eq(freshestSession(repo, "developer1", win).sessionId, "sid-board", "this window: the one it can resume");
  eq(freshestSession(repo, "developer1", wtc).sessionId, "sid-wt-new", "the worktree window: its own");
  eq(missingRoles(repo, new Set(), win).map((m) => m.sessionId), ["sid-board"], "missingRoles is scoped the same way");
  eq(strandedRoles(repo, new Set(), win), [], "a role with a resumable transcript is not stranded");
});

suite("reopen: a role whose ONLY transcripts live under another cwd is stranded, not offered", () => {
  const win = "/home/x/Containers/R2";
  const wtc = "/home/x/Containers/R2/.claude/worktrees/designer";
  const repo = makeRepo({ designer: { session_id: "sid-des", worktree: wtc }, productowner: { session_id: "sid-po" } }, "reopen-stranded");
  tx(projectDirFor(wtc), "sid-des", 1000);                   // the board sid itself lives in the worktree dir
  tx(projectDirFor(win), "sid-po", 1000);
  eq(missingRoles(repo, new Set(), win).map((m) => m.role), ["productowner"], "designer is not offered here");
  const st = strandedRoles(repo, new Set(), win);
  eq(st.map((s) => s.role), ["designer"]);
  eq(st[0].sessionId, "sid-des"); eq(st[0].cwd, wtc, "names the cwd it would resume from");
  eq(strandedRoles(repo, new Set(["designer"]), win), [], "a live role is not stranded");
  eq(strandedRoles(repo, new Set(), null), [], "no window cwd: nothing can be called stranded");
  eq(freshestSession(repo, "designer", win), null, "and nothing is reopened from a guess");
});
