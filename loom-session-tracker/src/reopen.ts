// reopen.ts — ONE JOB: after a window reload, know which role sessions came back EMPTY and which
// transcript each should be reopened from. fs-only, no vscode.
//
// WHY. Claude Code's restore path discards the session id (deserializeWebviewPanel reads only
// isFullEditor), so every restored Claude tab is a blank conversation. Measured 2026-09-09 22:40
// after a restart: 12 of 25 Claude frames in the editor were empty shells (94–541 chars). The
// extension already had a reopen path, offered ONCE as a dismissable toast right after the first
// tick at activation — before restored tabs had rendered — and never again. It also reopened the
// board's session_id, which is not always the newest transcript for the role: livegita's
// `developer` sid (70b561b4) was older than its worktree's latest, while funisland's
// learningactivity/curriculum sids were the freshest. So: recompute every tick, keep offering until
// nothing is missing, and reopen the FRESHEST transcript. Opening stays an explicit click — the
// 2026-07-12 rule that Claude tabs are never opened or closed automatically still holds.

import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { boardRoles } from "./registry";
import { transcriptFor } from "./context";
import { canonicalRole } from "./naming";

const LOOM_ROOT = path.join(os.homedir(), ".claude", "loom");
const PROJECTS_ROOT = path.join(os.homedir(), ".claude", "projects");

export interface ReopenCandidate {
  role: string;
  sessionId: string;
  file: string;
  /** Where the id came from: the board entry, or the newest transcript in the role's worktree. */
  source: "board" | "worktree";
  mtime: number;
}

/** Claude Code's transcript directory for a cwd: every "/" and "." becomes "-". Measured:
 *  /home/aneesh/Containers/funisland/.claude/worktrees/curriculum
 *  -> ~/.claude/projects/-home-aneesh-Containers-funisland--claude-worktrees-curriculum */
export function projectDirFor(cwd: string): string {
  return path.join(PROJECTS_ROOT, cwd.replace(/[\/.]/g, "-"));
}

function boardEntry(repo: string, role: string): any {
  try {
    const d = JSON.parse(fs.readFileSync(path.join(LOOM_ROOT, repo, "board.json"), "utf8"));
    return (d.roles || d)[role] || null;
  } catch { return null; }
}

function mtimeOf(f: string): number { try { return fs.statSync(f).mtimeMs; } catch { return 0; } }

/** The newest transcript this role could be reopened from, or null when it has none anywhere. */
export function freshestSession(repo: string, role: string): ReopenCandidate | null {
  const e = boardEntry(repo, role);
  const out: ReopenCandidate[] = [];
  const sid = e && (e.session_id || e.sessionId);
  if (typeof sid === "string" && sid) {
    const f = transcriptFor(sid);
    if (f) out.push({ role, sessionId: sid, file: f, source: "board", mtime: mtimeOf(f) });
  }
  const wt = e && typeof e.worktree === "string" ? e.worktree : null;
  if (wt) {
    const dir = projectDirFor(wt);
    let names: string[] = [];
    try { names = fs.readdirSync(dir).filter((n) => n.endsWith(".jsonl")); } catch { /* none */ }
    for (const n of names) {
      const f = path.join(dir, n);
      out.push({ role, sessionId: n.slice(0, -6), file: f, source: "worktree", mtime: mtimeOf(f) });
    }
  }
  if (!out.length) return null;
  out.sort((a, b) => b.mtime - a.mtime);
  return out[0];
}

/**
 * Roles of this project that are NOT live right now and have a transcript to come back from.
 * `liveNames` = roles the tracker sees signed/bound/pathed this tick, plus the owner names when an
 * orchestrator frame is present — an owner with no frame is as missing as any worker.
 */
export function missingRoles(repo: string, liveNames: Set<string>): ReopenCandidate[] {
  const out: ReopenCandidate[] = [];
  for (const role of boardRoles(repo)) {
    // an aliased name is live when its surviving name is (livegita: gitadeveloper -> developer)
    if (liveNames.has(role) || liveNames.has(canonicalRole(repo, role))) continue;
    const c = freshestSession(repo, role);
    if (c) out.push(c);
  }
  return out;
}

/**
 * The roles that were LIVE in this project before the window reloaded — read from the bus BEFORE
 * the first tick rewrites it. targetmap.json is the tracker's own last detection ({webviewId: role});
 * bindings.json holds /loom-time bindings. Both survive the reload while the frame ids in them do
 * not, which is precisely what makes them a record of "who was open" rather than "who is open".
 * This is the set the restart path is allowed to reopen automatically: a role absent from it was
 * closed on purpose at some earlier time and stays closed (measured: shwab_docker's board lists six
 * roles whose sessions were retired hours before the restart).
 */
export function previouslyLive(repo: string): Set<string> {
  const out = new Set<string>();
  for (const f of ["targetmap.json", "bindings.json"]) {
    try {
      const m = JSON.parse(fs.readFileSync(path.join(LOOM_ROOT, repo, f), "utf8"));
      if (m && typeof m === "object") for (const r of Object.values(m)) if (typeof r === "string" && r) out.add(r);
    } catch { /* none */ }
  }
  return out;
}
