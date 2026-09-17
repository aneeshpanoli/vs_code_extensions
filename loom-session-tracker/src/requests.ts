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
//    request cannot loop;
//  - never a role whose handoff declares `files:` that a currently WORKING role's handoff also
//    declares — playbook §19's disjointness rule (CH-001). Both sides must declare; an absent
//    `files:` line refuses nothing, ever. See overlap.ts. A role opened DESPITE a shared file, because
//    the only files it shares are mechanically mergeable, is reported in `exempted` — the guard never
//    makes that judgement silently (OV-001-R1).
//  - a role whose transcripts all live under ANOTHER cwd (it moved into its worktree) is not
//    reopened here — that opens a blank tab (reopen.ts) — it is SPAWNED and bound, and the result
//    says so, with the cwd its memory would resume from.

import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { boardRoles } from "./registry";
import { isOwnerRole, canonicalRole } from "./naming";
import { freshestSession, strandedRoles, ReopenCandidate, Stranded } from "./reopen";
import { overlapFor, overlapReason, exemptionFor, exemptionReason } from "./overlap";

const LOOM_ROOT = path.join(os.homedir(), ".claude", "loom");

/** A request this old is stale — a session that died mid-thread must not open tabs tomorrow. */
export const REQUEST_TTL_MS = 30 * 60_000;

export interface OpenRequest { roles: string[]; requestedAt?: string; note?: string }
export interface Refusal { role: string; reason: string }
export interface Plan {
  open: ReopenCandidate[];
  /** Roles with no transcript anywhere: opened as a NEW conversation and bound with `/loom <role>`.
   *  "Spin up the roles they need" includes roles that have never had a session. */
  spawn: string[];
  /** Roles in `spawn` that DO have a transcript, just none this window can resume. Reported back so
   *  the orchestrator knows the fresh tab carries no memory and where the old one would resume. */
  stranded: Stranded[];
  refused: Refusal[];
  /** Roles OPENED (or spawned) despite a shared file, because every file they share is a mechanical
   *  merge
   *  (OV-001-R1 §1(3)). Not refusals — the opposite — but the same shape, because they are read the
   *  same way: the orchestrator asked for a dispatch and is being told what the guard waved through.
   *  A judgement made on its behalf that appeared nowhere was the defect this closes. */
  exempted: Refusal[];
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
export function planOpen(repo: string, liveRoles: Set<string>, slots: number, now = Date.now(),
                         windowCwd: string | null = null): Plan {
  const req = readRequest(repo);
  if (!req) return { open: [], spawn: [], stranded: [], refused: [], exempted: [], consumed: false };
  const age = req.requestedAt ? now - Date.parse(req.requestedAt) : 0;
  if (req.requestedAt && (!Number.isFinite(age) || age > REQUEST_TTL_MS)) {
    return { open: [], spawn: [], stranded: [], exempted: [],
             refused: req.roles.map((role) => ({ role, reason: `request is stale (older than ${REQUEST_TTL_MS / 60000}m)` })), consumed: true };
  }
  const roster = new Set(boardRoles(repo));
  const strandedHere = strandedRoles(repo, liveRoles, windowCwd);
  const open: ReopenCandidate[] = [];
  const spawn: string[] = [];
  const stranded: Stranded[] = [];
  const refused: Refusal[] = [];
  const exempted: Refusal[] = [];
  for (const raw of req.roles) {
    const role = canonicalRole(repo, raw);
    if (isOwnerRole(role)) { refused.push({ role: raw, reason: "an orchestrator is never opened this way" }); continue; }
    if (!roster.has(role)) { refused.push({ role: raw, reason: `not a role of ${repo}` }); continue; }
    if (liveRoles.has(role)) { refused.push({ role: raw, reason: "already live" }); continue; }
    if (open.some((c) => c.role === role) || spawn.includes(role)) continue;   // duplicate in one request
    // §19's disjointness rule, enforced rather than trusted (CH-001): a handoff that declares files
    // another WORKING role's handoff also declares is a merge conflict already written down, and the
    // cheapest moment to refuse it is before the tab exists. Roles accepted EARLIER IN THIS PLAN
    // count too — one request naming two colliding briefs is the case the rule is most about.
    // Absence of a `files:` line on either side is never an overlap; see overlap.ts.
    const alsoLive = [...open.map((c) => c.role), ...spawn];
    const ov = overlapFor(repo, role, alsoLive);
    if (ov) { refused.push({ role: raw, reason: overlapReason(ov) }); continue; }
    if (open.length + spawn.length >= slots) { refused.push({ role: raw, reason: "active-session cap reached" }); continue; }
    // ...and when it does NOT refuse because of the exemption, say which file it let through. AFTER
    // the cap check, and that order was wrong in the first draft: noted before it, a role held back
    // for a slot appeared in `refused` AND in `exempted` in one result, and the note claimed a file
    // two roles were about to edit unguarded when nobody had been dispatched at all. A judgement is
    // only worth reporting once the dispatch it permitted actually happens.
    const ex = exemptionFor(repo, role, alsoLive);
    if (ex) exempted.push({ role: raw, reason: exemptionReason(ex) });
    const c = freshestSession(repo, role, windowCwd);
    if (c) { open.push(c); continue; }
    spawn.push(role);
    const st = strandedHere.find((x) => x.role === role);
    if (st) stranded.push(st);
  }
  return { open, spawn, stranded, refused, exempted, consumed: true };
}

/** Replace the request with its outcome, so the orchestrator can read back what happened. */
export interface Opened { role: string; sessionId: string | null; from: "board" | "worktree" | "spawned";
  /** The frame the tab came up in, when it could be told apart from what was already open. This is
   *  what the orchestrator rings — it no longer has to hunt for the tab by nonce. */
  webviewId: string | null; bound?: boolean;
  /** Why a role with a transcript was spawned fresh instead: its transcript cannot be resumed from
   *  this window. Names the session and the cwd it would resume from. */
  note?: string; }

/** The line an orchestrator reads to understand a stranded spawn. */
export function strandedNote(s: Stranded): string {
  return `spawned fresh: ${s.role}'s transcript ${s.sessionId.slice(0, 8)} lives under ` +
    `${s.cwd || "another cwd"} and cannot be resumed from this window (it would open blank); ` +
    `hand it its memory by hand`;
}

/** `exempted` is written only when it has entries: an orchestrator reading this file back should see
 *  a new key the day the guard waved something through, not an empty one on every dispatch. */
export function writeResult(repo: string, opened: Opened[], refused: Refusal[], exempted: Refusal[] = []): void {
  try {
    fs.writeFileSync(file(repo), JSON.stringify({
      servedAt: new Date().toISOString(),
      opened,
      refused,
      ...(exempted.length ? { exempted } : {}),
    }, null, 2));
  } catch { /* a result write must never break a tick */ }
}
