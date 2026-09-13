// orchestrator.ts — ONE JOB: persist which role is THE orchestrator for a repo bus.
// Stored on the bus itself (~/.claude/loom/<repo>/orchestrator.json) so the tag survives
// window reloads and is visible to any tooling, not just this extension. fs-only, no vscode.

import * as fs from "fs";
import * as os from "os";
import * as path from "path";

import { OWNER_ALIASES, isOwnerRole } from "./naming";

const LOOM_ROOT = path.join(os.homedir(), ".claude", "loom");

// The orchestrator/PO session is NOT a worker role — it never appears in a board.json roster and the
// tracker excludes it from tracked agents. These names must therefore always be offered as tag
// candidates independently, and loom_cdp.py's detect_role recognizes them for injection.
// Sourced from naming.ts so `po` (livegita) is offered too — it was missing from the hardcoded pair.
export const ORCHESTRATOR_CANDIDATES: readonly string[] = OWNER_ALIASES;

export interface OrchestratorTag {
  role: string;
  taggedAt: string;   // ISO
  /** The exact frame the orchestrator is running in. Injection into the orchestrator MUST address this
   *  id: loom_cdp.py's find_role() drops any frame that content-detects as product-owner (the self-woke
   *  guard), so `--role product-owner` can never land. Refreshed each tick while it is detectable, and
   *  left alone when it is not — a stale id is better than none, and the injector reports a miss. */
  webviewId?: string | null;
}

function file(repo: string): string {
  return path.join(LOOM_ROOT, repo, "orchestrator.json");
}

export function getOrchestrator(repo: string | null): OrchestratorTag | null {
  if (!repo) return null;
  try {
    const t = JSON.parse(fs.readFileSync(file(repo), "utf8"));
    if (t && typeof t.role === "string" && t.role) return t;
  } catch { /* untagged */ }
  return null;
}

export function setOrchestrator(repo: string, role: string | null, webviewId?: string | null): void {
  const f = file(repo);
  if (role === null) {
    try { fs.unlinkSync(f); } catch { /* already gone */ }
    return;
  }
  fs.mkdirSync(path.dirname(f), { recursive: true });
  const tmp = f + ".tmp." + process.pid;
  fs.writeFileSync(tmp, JSON.stringify(
    { role, taggedAt: new Date().toISOString(), webviewId: webviewId ?? null }, null, 2));
  fs.renameSync(tmp, f);
}

/** Record the frame the orchestrator is in, keeping the tag otherwise intact. No-op when untagged or
 *  when nothing changed, so a tick never churns the file. */
export function setOrchestratorFrame(repo: string, webviewId: string | null): void {
  const cur = getOrchestrator(repo);
  if (!cur || !webviewId || cur.webviewId === webviewId) return;
  const f = file(repo);
  try {
    const tmp = f + ".tmp." + process.pid;
    fs.writeFileSync(tmp, JSON.stringify({ ...cur, webviewId }, null, 2));
    fs.renameSync(tmp, f);
  } catch { /* a frame refresh must never throw from a tick */ }
}

/**
 * After a `/clear`, the orchestrator is a NEW session id and the board still records the old one —
 * which is how Lumen's cycle read a dead transcript as 57% fourteen times (2026-09-13). The
 * extension is the one party that has SEEN the fresh transcript appear (memory.ts confirms the clear
 * by it), so it records that id on the board itself rather than hoping the restore prompt is
 * followed. Only the owner role's entry, only `session_id` and `bound_at`; everything else is kept.
 * Nested (`roles{}`) and flat boards both supported. Never throws.
 */
export function rebindSession(repo: string, role: string, sessionId: string): boolean {
  if (!repo || !role || !sessionId) return false;
  const f = path.join(LOOM_ROOT, repo, "board.json");
  try {
    const d = JSON.parse(fs.readFileSync(f, "utf8"));
    const roles = d && d.roles && typeof d.roles === "object" ? d.roles : d;
    if (!roles || typeof roles !== "object") return false;
    // THE BOARD'S OWN SPELLING. The tag says `product-owner` where Gaming's board says
    // `productowner` (audit 2026-09-13); writing the tag's spelling would add a second owner row and
    // leave the stale one in place. So the existing owner-named entry is the one corrected — the exact
    // name first, else any owner alias — and a board with NO owner entry (funisland) is left alone:
    // the cycle's own state carries the id, and inventing a roster row is not this function's job.
    const key = Object.keys(roles).find((k) => k === role && roles[k] && typeof roles[k] === "object")
      ?? Object.keys(roles).find((k) => isOwnerRole(k) && roles[k] && typeof roles[k] === "object");
    if (!key) return false;
    const entry = roles[key];
    if (entry.session_id === sessionId) return false;
    roles[key] = { ...entry, session_id: sessionId, bound_at: new Date().toISOString(),
                   rebound_by: "loom-session-tracker after /clear" };
    const tmp = f + ".tmp." + process.pid;
    fs.writeFileSync(tmp, JSON.stringify(d, null, 2));
    fs.renameSync(tmp, f);
    return true;
  } catch { return false; }
}
