// rebind.ts — ONE JOB: the session id is the ADDRESS; the webviewId is a CACHE this module refreshes.
//
// WHY THIS EXISTS, measured 2026-09-13 after an IDE restart at ~20:30Z. The webviewId is the `?id=`
// UUID VSCodium mints per webview INSTANCE. Nobody persists it, and nothing can: on restart Claude
// Code's deserializer drops the session, every Claude tab returns as a blank shell with a NEW id,
// and the extension's restart path reopens each previously-live role in yet another new tab without
// ever learning which frame that is. So `bindings.json`, `board.json`'s `webview_id`, `<role>.id`
// and `orchestrator.json` all keep DEAD ids until a worker re-runs `/loom <role>` by hand and the
// orchestrator does a nonce ring. That morning `productowner.id` said 1db463ac while the session was
// actually in 1e41adbf, and both developer tabs of the vs_code_extensions bus were stranded.
//
// The Claude session id is STABLE across restarts, and `cdp.ts` can now read it off every panel. So
// the id files stop being the address and become a cache — and this module is the ONLY writer that
// refreshes them, from a session-id match and from nothing else.
//
// THE NARROW LICENCE. tracker.ts's rule was "the tracker NEVER writes bindings.json", and that rule
// is what makes a `/loom` self-binding durable. It is narrowed here by exactly one clause: a binding
// DERIVED FROM A SESSION-ID MATCH may be written. Never from content, never from a guess, never from
// a fingerprint. A tracker that cannot read the session id changes nothing on the bus.

import * as fs from "fs";
import * as os from "os";
import * as path from "path";

import { boardRoles, loadBindings } from "./registry";
import { projectDirFor } from "./reopen";
import { isOwnerRole } from "./naming";
import { setOrchestratorFrame } from "./orchestrator";

const LOOM_ROOT = path.join(os.homedir(), ".claude", "loom");

/** Where a session id claiming a role came from. `board` is the role's recorded `session_id`;
 *  `transcript` is a `.jsonl` sitting in that role's OWN worktree project directory. */
export type SessionSource = "board" | "transcript";

export interface SessionOwner { role: string; source: SessionSource; }

function readJson(f: string): any {
  try { return JSON.parse(fs.readFileSync(f, "utf8")); } catch { return null; }
}

function boardOf(repo: string): { data: any; roles: any } | null {
  const data = readJson(path.join(LOOM_ROOT, repo, "board.json"));
  if (!data || typeof data !== "object") return null;
  const roles = data.roles && typeof data.roles === "object" && !Array.isArray(data.roles) ? data.roles : data;
  if (!roles || typeof roles !== "object") return null;
  return { data, roles };
}

/**
 * The worktree directory of a role, as the bus records it or as the convention names it.
 *
 * The board entry's `worktree` field is authoritative when present — but measured across the live
 * buses it very often is NOT (vs_code_extensions' own `developer1` entry carries session_id, branch,
 * status, bound_at and updated_at, and no worktree at all). The Loom's own convention, the one
 * `/loom <role>` follows, is `<repo root>/.claude/worktrees/<role>`, so that is the fallback.
 *
 * It is deliberately ROLE-SCOPED in both forms, and the window's own cwd is never used as a
 * directory of its own: one role lives per worktree, so a transcript there belongs to that role and
 * to nobody else — whereas `windowCwd` itself holds the transcripts of every ad-hoc session anyone
 * ever ran in that folder. See `sessionOwners` for why that distinction is load-bearing.
 */
export function roleWorktree(repo: string, role: string, windowCwd: string | null): string | null {
  const b = boardOf(repo);
  const e = b && b.roles[role];
  if (e && typeof e === "object" && typeof e.worktree === "string" && e.worktree) return e.worktree;
  if (!windowCwd) return null;
  // A window that IS a worktree ( .../.claude/worktrees/<something> ) sits one repo root up.
  const m = /^(.*)\/\.claude\/worktrees\/[^/]+$/.exec(windowCwd.replace(/\/+$/, ""));
  const root = m ? m[1] : windowCwd.replace(/\/+$/, "");
  return path.join(root, ".claude", "worktrees", role);
}

/**
 * {claude session id -> role} for ONE project: every role's recorded `session_id`, plus every
 * transcript sitting in that role's own worktree project directory.
 *
 * WHY THE TRANSCRIPT HALF. A board `session_id` goes stale the moment a role is `/clear`ed or
 * resumed into a new session, and that is precisely the state this whole mechanism is meant to heal.
 * The role's worktree holds the transcripts it actually ran, so a frame carrying one of those is
 * that role even when the board has not caught up.
 *
 * AMBIGUITY REFUSES (principle 16). A session id claimed by TWO roles is dropped entirely rather
 * than resolved by some tiebreak — a wrong role here rewrites the bus and misroutes injections. The
 * board half wins over the transcript half for the same id, because the board is a statement and a
 * directory listing is an inference.
 *
 * A NARROWING, STATED PLAINLY. RB-001 asked for transcripts whose cwd is "this window's cwd or the
 * role's worktree". Only the role's worktree is used. `windowCwd` on its own cannot be attributed:
 * the owner role typically has no worktree, so every transcript ever written in the window's folder
 * — including the ad-hoc Claude tabs a person opens by hand — would map to the orchestrator, be
 * adopted at binding authority, and become injectable as it. The worktree form is role-scoped by
 * construction and carries no such hazard. Cross-project transcripts are excluded by construction:
 * only these role directories are ever read.
 */
export function sessionOwners(repo: string, windowCwd: string | null = null): Map<string, SessionOwner> {
  const out = new Map<string, SessionOwner>();
  const dropped = new Set<string>();
  const claim = (sid: string, role: string, source: SessionSource) => {
    const id = String(sid || "").toLowerCase();
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(id)) return;
    if (dropped.has(id)) return;
    const prev = out.get(id);
    if (!prev) { out.set(id, { role, source }); return; }
    if (prev.role === role) { if (prev.source === "transcript" && source === "board") out.set(id, { role, source }); return; }
    // Two different roles, one id. Whatever the sources, we cannot tell — so nobody gets it.
    if (prev.source === "board" && source === "transcript") return;   // a statement beats a listing
    if (prev.source === "transcript" && source === "board") { out.set(id, { role, source }); return; }
    out.delete(id); dropped.add(id);
  };

  const b = boardOf(repo);
  const roles = boardRoles(repo);
  for (const role of roles) {
    const e = b && b.roles[role];
    const sid = e && typeof e === "object" ? (e.session_id || e.sessionId) : null;
    if (typeof sid === "string" && sid) claim(sid, role, "board");
  }
  for (const role of roles) {
    const wt = roleWorktree(repo, role, windowCwd);
    if (!wt) continue;
    let names: string[] = [];
    try { names = fs.readdirSync(projectDirFor(wt)); } catch { continue; }   // no transcripts there
    for (const n of names) if (n.endsWith(".jsonl")) claim(n.slice(0, -6), role, "transcript");
  }
  return out;
}

/** What the bus currently believes this role's frame is, from each of the three places it is recorded. */
export function busWebviewFor(repo: string, role: string): { bindings: string | null; board: string | null; idfile: string | null } {
  let bindings: string | null = null;
  for (const [w, r] of loadBindings(repo)) if (r === role) { bindings = w; break; }
  const b = boardOf(repo);
  const e = b && b.roles[role];
  // BOTH SPELLINGS. The extension reads `webviewId` (registry.busDeclaredFrames), but the boards the
  // Loom skill actually writes use `webview_id` — vs_code_extensions' own `productowner` entry
  // carries `webview_id` and no `webviewId` at all (checked 2026-09-13). Reading only one of them
  // reports "the bus said nothing" about an entry that plainly said something.
  const board = e && typeof e === "object"
    ? (typeof e.webviewId === "string" && e.webviewId ? e.webviewId
       : typeof e.webview_id === "string" && e.webview_id ? e.webview_id : null)
    : null;
  let idfile: string | null = null;
  try {
    const l = fs.readFileSync(path.join(LOOM_ROOT, repo, `${role}.id`), "utf8").split(/\r?\n/);
    const w = (l[0] || "").trim();
    if (/^[0-9a-f-]{8,}$/i.test(w)) idfile = w;
  } catch { /* none */ }
  return { bindings, board, idfile };
}

function writeAtomic(file: string, next: string): boolean {
  try { if (fs.readFileSync(file, "utf8") === next) return false; } catch { /* missing -> write */ }
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = `${file}.tmp.${process.pid}`;
    fs.writeFileSync(tmp, next);
    fs.renameSync(tmp, file);
    return true;
  } catch { return false; }
}

/** One rewrite, as it is logged: which files moved, and from what to what. */
export interface RebindLog {
  role: string;
  to: string;
  from: { bindings: string | null; board: string | null; idfile: string | null };
  files: string[];
  notes: string[];
}

/**
 * Point every place the bus records this role's frame at `webviewId`. Change-only (an unchanged file
 * is not rewritten, so a 15-second tick never churns), atomic (tmp+rename) and total: a DEAD id is
 * REPLACED, not merely ignored, because `reach_po.py @<repo>/<role>.id` has to work within one tick
 * of a restart with nobody typing anything.
 *
 * `frameText`/`busy` are only used to decide the fate of an id file's line-2 guard string, with the
 * same rule `registry.declarationHolds` uses: a guard that is absent from an IDLE tab is wrong and is
 * dropped, while on a BUSY tab its absence is inconclusive (the transcript is virtualized and the
 * sign-off has scrolled out of the DOM) and it is kept.
 *
 * `frameText === null` means the frame's text was NOT READ — the restart path knows which frame it
 * just opened without having read a word of it. That is inconclusive in the same way a busy tab is,
 * so the guard is KEPT. Not reading a frame is not evidence against what the guard says.
 *
 * Returns null when nothing needed changing. Never throws.
 */
export function rebindFrame(repo: string, role: string, webviewId: string,
                            frameText: string | null, busy: boolean): RebindLog | null {
  if (!repo || !role || !webviewId) return null;
  const from = busWebviewFor(repo, role);
  const files: string[] = [];
  const notes: string[] = [];

  // 1) bindings.json — {webviewId: role}. The new id is added and any OTHER id claiming this role is
  //    removed, or the stale one would keep answering as a second frame for the same worker.
  try {
    const f = path.join(LOOM_ROOT, repo, "bindings.json");
    const cur = readJson(f);
    const map: Record<string, string> = (cur && typeof cur === "object" && !Array.isArray(cur)) ? { ...cur } : {};
    let changed = map[webviewId] !== role;
    map[webviewId] = role;
    for (const k of Object.keys(map)) if (k !== webviewId && map[k] === role) { delete map[k]; changed = true; }
    if (changed && writeAtomic(f, JSON.stringify(map, null, 2))) files.push("bindings.json");
  } catch { notes.push("bindings.json unwritable"); }

  // 2) board.json — only the role's OWN entry, only `webviewId`. A board with no entry for this role
  //    is left alone: inventing a roster row is not this function's job (same judgement as
  //    orchestrator.rebindSession).
  try {
    const f = path.join(LOOM_ROOT, repo, "board.json");
    const b = boardOf(repo);
    if (b && b.roles[role] && typeof b.roles[role] === "object") {
      const cur = b.roles[role];
      // Write `webviewId` (what the extension reads) and ALSO refresh `webview_id` when the entry
      // already carries that spelling — otherwise the heal leaves a correct new field beside a stale
      // old one, and every reader that prefers the old spelling keeps following the dead id.
      const hasSnake = typeof cur.webview_id === "string";
      if (cur.webviewId !== webviewId || (hasSnake && cur.webview_id !== webviewId)) {
        b.roles[role] = { ...cur, webviewId, ...(hasSnake ? { webview_id: webviewId } : {}),
                          rebound_by: "loom-session-tracker by session id" };
        if (writeAtomic(f, JSON.stringify(b.data, null, 2))) files.push("board.json");
      }
    } else if (b) { notes.push(`board.json has no ${role} entry — left alone`); }
  } catch { notes.push("board.json unwritable"); }

  // 3) <role>.id — line 1 the webviewId, line 2 an optional guard string (README-ids.md).
  try {
    const f = path.join(LOOM_ROOT, repo, `${role}.id`);
    let guard: string | null = null;
    try { guard = (fs.readFileSync(f, "utf8").split(/\r?\n/)[1] || "").trim() || null; } catch { /* new file */ }
    if (guard && frameText !== null && !frameText.includes(guard) && !busy) {
      notes.push(`dropped ${role}.id guard (absent from an idle frame)`);
      guard = null;
    }
    const next = guard ? `${webviewId}\n${guard}\n` : `${webviewId}\n`;
    if (writeAtomic(f, next)) files.push(`${role}.id`);
  } catch { notes.push(`${role}.id unwritable`); }

  // 4) orchestrator.json — the owner's frame is addressed from there too.
  if (isOwnerRole(role)) {
    try {
      const before = readJson(path.join(LOOM_ROOT, repo, "orchestrator.json"));
      setOrchestratorFrame(repo, webviewId);
      const after = readJson(path.join(LOOM_ROOT, repo, "orchestrator.json"));
      if (JSON.stringify(before) !== JSON.stringify(after)) files.push("orchestrator.json");
    } catch { notes.push("orchestrator.json unwritable"); }
  }

  if (!files.length) return null;
  return { role, to: webviewId, from, files, notes };
}
