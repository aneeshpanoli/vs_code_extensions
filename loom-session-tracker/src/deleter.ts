// deleter.ts — ONE JOB: safely REMOVE a finished role session's on-disk artifacts. RECOVERABLE BY DESIGN
// (the Arya lesson: never hard-destroy). It:
//   1) REFUSES if the role's worktree has uncommitted changes (job isn't banked) — no --force, ever.
//   2) `git worktree remove` — the branch `worktree-<role>` and all its commits are RETAINED (re-addable).
//   3) ARCHIVES the transcript to <repo>/deleted-sessions/ (moved, not rm'd).
//   4) removes the board.json entry + any lock.
// The CALLER (coordinator) enforces the self/lock/agent boundaries BEFORE this ever runs.

import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { execFileSync } from "child_process";

const HOME = os.homedir();
const LOOM_ROOT = path.join(HOME, ".claude", "loom");
const PROJECTS = path.join(HOME, ".claude", "projects");

export interface DeleteResult { ok: boolean; steps: string[]; error?: string }

function boardPath(repo: string) { return path.join(LOOM_ROOT, repo, "board.json"); }

function sessionIdOf(repo: string, role: string): string | null {
  try {
    const d = JSON.parse(fs.readFileSync(boardPath(repo), "utf8"));
    const r = (d.roles || {})[role];
    return (r && r.session_id) || null;
  } catch { return null; }
}

function findTranscript(sid: string): string | null {
  try {
    for (const dir of fs.readdirSync(PROJECTS)) {
      const p = path.join(PROJECTS, dir, sid + ".jsonl");
      if (fs.existsSync(p)) return p;
    }
  } catch { /* ignore */ }
  return null;
}

/** repoRoot = the MAIN repo path (for `git worktree`). Recoverable, refuse-if-dirty. Never throws. */
export function deleteSession(repo: string, role: string, repoRoot: string | null, stamp: string): DeleteResult {
  const steps: string[] = [];
  try {
    const trash = path.join(LOOM_ROOT, repo, "deleted-sessions");
    try { fs.mkdirSync(trash, { recursive: true }); } catch { /* ignore */ }

    // 1 + 2) worktree: refuse if dirty, else remove (branch retained)
    if (repoRoot) {
      const wt = path.join(repoRoot, ".claude", "worktrees", role);
      if (fs.existsSync(wt)) {
        let dirty = "";
        try { dirty = execFileSync("git", ["-C", wt, "status", "--porcelain"], { encoding: "utf8", timeout: 5000 }).trim(); }
        catch { /* if we can't check, treat as unknown -> refuse below */ dirty = "UNKNOWN"; }
        if (dirty) return { ok: false, steps, error: `REFUSED: worktree '${role}' has uncommitted work (${dirty === "UNKNOWN" ? "status unreadable" : "bank it first"}). Nothing deleted.` };
        try {
          execFileSync("git", ["-C", repoRoot, "worktree", "remove", wt], { encoding: "utf8", timeout: 10000 });
          steps.push(`worktree removed (branch worktree-${role} + commits retained — re-add to recover)`);
        } catch (e: any) { return { ok: false, steps, error: `git worktree remove failed: ${String(e.message || e).slice(0, 90)}` }; }
      }
    }

    // 3) transcript -> archived (moved, recoverable)
    const sid = sessionIdOf(repo, role);
    if (sid) {
      const tr = findTranscript(sid);
      if (tr) {
        try { fs.renameSync(tr, path.join(trash, `${role}-${sid}-${stamp}.jsonl`)); steps.push("transcript archived to deleted-sessions/"); }
        catch { /* leave it; not fatal */ }
      }
    }

    // 4) board.json entry + lock cleanup
    try {
      const d = JSON.parse(fs.readFileSync(boardPath(repo), "utf8"));
      if (d.roles && d.roles[role]) { delete d.roles[role]; fs.writeFileSync(boardPath(repo), JSON.stringify(d, null, 2)); steps.push("board.json entry removed"); }
    } catch { /* ignore */ }

    return { ok: true, steps };
  } catch (e: any) {
    return { ok: false, steps, error: String(e && e.message || e).slice(0, 120) };
  }
}
