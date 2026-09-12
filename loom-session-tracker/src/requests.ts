// requests.ts — ONE JOB: let an ORCHESTRATOR open the role sessions it needs, without asking a human
// to click anything.
//
// WHY. An orchestrator can write files and ring sessions, but it cannot open an editor tab — only the
// extension can call `claude-vscode.editor.open`. So a PO that needs a worker back has no move except
// to ask the user, and on 2026-09-12 one did exactly that: "Reopen the three role sessions from the
// LOOM SESSIONS panel, which still says reopen 3. Once they exist I will find each by its block id
// and worktree path, rewrite its id file, ring it, and confirm pickup." Everything in that sentence
// is the orchestrator's own work except the one step it cannot perform.
//
// THE CHANNEL. The orchestrator writes `~/.claude/loom/<repo>/open-requests.json`:
//
//     { "roles": ["developer1", "socialworker1"], "requestedAt": "<iso>", "note": "why" }
//
// The extension picks it up on its next tick, opens each role's freshest transcript, and REPLACES the
// file with the outcome, so the orchestrator can read back what happened:
//
//     { "servedAt": "<iso>", "opened": [...], "refused": [{"role":..., "reason":...}] }
//
// BOUNDARIES, because this hands a session the power to open tabs:
//  - only roles on THIS project's roster (a request cannot reach another project);
//  - never an orchestrator role — the PO does not reopen itself, and that is also the role whose
//    duplicate would be most confusing;
//  - never a role that is already live — this is "open what is missing", not "open another one";
//  - never more than the active-session cap allows, counted the same way `spawn()` counts it;
//  - a request older than REQUEST_TTL_MS is ignored, so a file left behind by a dead session cannot
//    open tabs days later;
//  - the file is consumed (rewritten as a result) whether or not anything was opened, so a bad
//    request cannot loop.

import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { boardRoles } from "./registry";
import { isOwnerRole, canonicalRole } from "./naming";
import { freshestSession, ReopenCandidate } from "./reopen";

const LOOM_ROOT = path.join(os.homedir(), ".claude", "loom");

/** A request this old is stale — a session that died mid-thread must not open tabs tomorrow. */
export const REQUEST_TTL_MS = 30 * 60_000;

export interface OpenRequest { roles: string[]; requestedAt?: string; note?: string }
export interface Refusal { role: string; reason: string }
export interface Plan {
  open: ReopenCandidate[];
  refused: Refusal[];
  /** True when a file was present and should now be replaced with the result. */
  consumed: boolean;
}

function file(repo: string): string { return path.join(LOOM_ROOT, repo, "open-requests.json"); }

export function readRequest(repo: string): OpenRequest | null {
  try {
    const d = JSON.parse(fs.readFileSync(file(repo), "utf8"));
    if (!d || !Array.isArray(d.roles)) return null;
    const roles = d.roles.filter((r: any) => typeof r === "string" && r.trim()).map((r: string) => r.trim().toLowerCase());
    if (!roles.length) return null;
    return { roles, requestedAt: d.requestedAt, note: d.note };
  } catch { return null; }
}

/**
 * What to open for `repo`, given who is already live and how much room the cap leaves.
 * Pure: it reads the bus but changes nothing, so the decision can be asserted directly.
 */
export function planOpen(repo: string, liveRoles: Set<string>, slots: number, now = Date.now()): Plan {
  const req = readRequest(repo);
  if (!req) return { open: [], refused: [], consumed: false };
  const age = req.requestedAt ? now - Date.parse(req.requestedAt) : 0;
  if (req.requestedAt && (!Number.isFinite(age) || age > REQUEST_TTL_MS)) {
    return { open: [], refused: req.roles.map((role) => ({ role, reason: `request is stale (older than ${REQUEST_TTL_MS / 60000}m)` })), consumed: true };
  }
  const roster = new Set(boardRoles(repo));
  const open: ReopenCandidate[] = [];
  const refused: Refusal[] = [];
  for (const raw of req.roles) {
    const role = canonicalRole(repo, raw);
    if (isOwnerRole(role)) { refused.push({ role: raw, reason: "an orchestrator is never opened this way" }); continue; }
    if (!roster.has(role)) { refused.push({ role: raw, reason: `not a role of ${repo}` }); continue; }
    if (liveRoles.has(role)) { refused.push({ role: raw, reason: "already live" }); continue; }
    if (open.some((c) => c.role === role)) continue;                   // duplicate in one request
    const c = freshestSession(repo, role);
    if (!c) { refused.push({ role: raw, reason: "no transcript to reopen it from" }); continue; }
    if (open.length >= slots) { refused.push({ role: raw, reason: "active-session cap reached" }); continue; }
    open.push(c);
  }
  return { open, refused, consumed: true };
}

/** Replace the request with its outcome, so the orchestrator can read back what happened. */
export function writeResult(repo: string, opened: ReopenCandidate[], refused: Refusal[]): void {
  try {
    fs.writeFileSync(file(repo), JSON.stringify({
      servedAt: new Date().toISOString(),
      opened: opened.map((c) => ({ role: c.role, sessionId: c.sessionId, from: c.source })),
      refused,
    }, null, 2));
  } catch { /* a result write must never break a tick */ }
}
