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
//
// A TRANSCRIPT CAN ONLY BE RESUMED FROM THE WINDOW IT WAS WRITTEN UNDER. Claude Code looks a session
// id up in the project directory of the window's cwd (`~/.claude/projects/<cwd with / and . as ->`);
// an id it cannot find there opens a NEW, blank "Untitled" conversation instead — on the pinned
// default model, with no memory. Measured 2026-09-13 05:50: four roles (Lumen/developer1,
// ReciEats/developer1 and designer, livegita/developer1) were reopened from their FRESHEST transcript,
// every one of which lived under `…--claude-worktrees-<role>` because the role had moved into its
// worktree; all four tabs came up as 400-character blank shells, the bus got `webviewId: null`
// back, and the orchestrators asked again. A role whose only transcripts live under another cwd is
// STRANDED from this window: it is not offered for reopening, the restart path skips it, and an
// open-request for it is served by spawning a fresh bound tab (which is what a blank tab would have
// been anyway, minus the binding).

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

/** Can `claude-vscode.editor.open(sessionId)` resume this transcript from a window whose folder is
 *  `windowCwd`? Only when the file sits in that cwd's own project directory. An unknown cwd (a
 *  windowless run, or a test) is permissive — the guard exists to stop known-wrong opens. */
export function resumableFrom(file: string, windowCwd: string | null | undefined): boolean {
  if (!windowCwd) return true;
  return path.dirname(path.resolve(file)) === projectDirFor(path.resolve(windowCwd));
}

/** Every transcript a role could come back from, freshest first. */
function allSessions(repo: string, role: string): ReopenCandidate[] {
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
  out.sort((a, b) => b.mtime - a.mtime);
  return out;
}

/** The newest transcript this role could be reopened from IN THIS WINDOW, or null when it has none.
 *  With `windowCwd`, transcripts written under another cwd are skipped — a fresher one there does
 *  not make this window's resumable one wrong, it makes the role stranded (see `strandedRoles`). */
export function freshestSession(repo: string, role: string, windowCwd: string | null = null): ReopenCandidate | null {
  const out = allSessions(repo, role).filter((c) => resumableFrom(c.file, windowCwd));
  return out.length ? out[0] : null;
}

/** A role with transcripts, none of which this window can resume. `cwd` is where its freshest one
 *  would resume from — the folder a person would have to open to bring it back with its memory. */
export interface Stranded { role: string; sessionId: string; file: string; cwd: string | null }

/** Roles of this project that are NOT live, HAVE a transcript, and can be resumed from NOWHERE in
 *  this window. Reopening these here yields a blank tab; only spawning (a fresh bound tab) or a
 *  window on their own cwd can bring them back. */
export function strandedRoles(repo: string, liveNames: Set<string>, windowCwd: string | null): Stranded[] {
  const out: Stranded[] = [];
  if (!windowCwd) return out;
  for (const role of boardRoles(repo)) {
    if (liveNames.has(role) || liveNames.has(canonicalRole(repo, role))) continue;
    const all = allSessions(repo, role);
    if (!all.length || all.some((c) => resumableFrom(c.file, windowCwd))) continue;
    // The cwd it would resume from: the board's worktree when the file sits in that worktree's own
    // project dir (the board sid itself often does — the role moved there and kept writing).
    const e = boardEntry(repo, role);
    const wt = e && typeof e.worktree === "string" ? e.worktree : null;
    const cwd = wt && path.dirname(path.resolve(all[0].file)) === projectDirFor(path.resolve(wt)) ? wt : null;
    out.push({ role, sessionId: all[0].sessionId, file: all[0].file, cwd });
  }
  return out;
}

/**
 * Roles of this project that are NOT live right now and have a transcript to come back from.
 * `liveNames` = roles the tracker sees signed/bound/pathed this tick, plus the owner names when an
 * orchestrator frame is present — an owner with no frame is as missing as any worker.
 */
export function missingRoles(repo: string, liveNames: Set<string>, windowCwd: string | null = null): ReopenCandidate[] {
  const out: ReopenCandidate[] = [];
  for (const role of boardRoles(repo)) {
    // an aliased name is live when its surviving name is (livegita: gitadeveloper -> developer)
    if (liveNames.has(role) || liveNames.has(canonicalRole(repo, role))) continue;
    const c = freshestSession(repo, role, windowCwd);
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
