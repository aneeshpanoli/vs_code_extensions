// digest.ts — ONE JOB: at startup (and on demand), answer "what needs me?" for this project.
//
// WHY: the bus accumulates work that nobody is watching. Measured on the real buses 2026-09-08:
// 11 roles had an outbox newer than their inbox (a worker answered and nobody picked it up), 4 sat
// in `blocked` awaiting a decision, and NO project had an orchestrator tagged — so every
// notification path in this extension was dormant. None of that is visible anywhere until you go
// looking, which is exactly what a startup summary is for.
//
// Everything here is READ-ONLY and computed from the bus plus what the tracker already knows. The
// actions it suggests (tag an orchestrator, reopen a session) are always the user's click, never
// automatic — a session is never opened or closed on our own initiative.

import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { execFileSync } from "child_process";
import { boardRoles, busRepos } from "./registry";
import { getOrchestrator } from "./orchestrator";

const LOOM_ROOT = path.join(os.homedir(), ".claude", "loom");
const HOUR_MS = 3_600_000;

export interface RoleNote { role: string; detail: string; hoursAgo?: number; }
export interface Digest {
  repo: string;
  /** Worker answered after the last handoff — a response nobody has picked up. */
  awaitingPickup: RoleNote[];
  /** status.json says `blocked` — a loop-back waiting on a decision. */
  blocked: RoleNote[];
  /** Blocked by a usage limit (from the limit watcher's state). */
  limited: RoleNote[];
  /** Workers still on the orchestrator-only model tier. */
  premium: RoleNote[];
  /** Uncommitted work sitting in a role's worktree. */
  unbanked: RoleNote[];
  /** Roles the board knows, with a session id, that have no live tab right now. */
  missingSessions: { role: string; sessionId: string }[];
  orchestratorTagged: boolean;
  /** Hygiene, across every bus: long-dead buses and role names claimed by more than one. */
  staleBuses: { repo: string; days: number }[];
  duplicateRoles: { role: string; repos: string[] }[];
  /** How many items actually want the user's attention (hygiene excluded). */
  actionable: number;
}

function mtime(p: string): number | null {
  try { return fs.statSync(p).mtimeMs; } catch { return null; }
}
function nonEmpty(p: string): boolean {
  try { return fs.statSync(p).size > 0; } catch { return false; }
}
function readStatus(repo: string, role: string): any {
  try { return JSON.parse(fs.readFileSync(path.join(LOOM_ROOT, repo, role, "status.json"), "utf8")); }
  catch { return null; }
}
function boardEntry(repo: string, role: string): any {
  try {
    const d = JSON.parse(fs.readFileSync(path.join(LOOM_ROOT, repo, "board.json"), "utf8"));
    return (d.roles || d)[role] || null;
  } catch { return null; }
}
/** Newest mtime anywhere directly under a bus — how recently that project was touched. */
function busTouched(repo: string): number | null {
  let newest: number | null = null;
  const walk = (dir: string, depth: number) => {
    let entries: string[] = [];
    try { entries = fs.readdirSync(dir); } catch { return; }
    for (const e of entries) {
      const p = path.join(dir, e);
      let st;
      try { st = fs.statSync(p); } catch { continue; }
      if (st.isDirectory()) { if (depth > 0) walk(p, depth - 1); }
      else if (newest === null || st.mtimeMs > newest) newest = st.mtimeMs;
    }
  };
  walk(path.join(LOOM_ROOT, repo), 1);
  return newest;
}

/** Uncommitted changes in a role's worktree, or null when there is no worktree / no answer. */
export function unbankedIn(repoRoot: string | null, role: string): string | null {
  if (!repoRoot) return null;
  const wt = path.join(repoRoot, ".claude", "worktrees", role);
  if (!fs.existsSync(wt)) return null;
  try {
    const out = execFileSync("git", ["-C", wt, "status", "--porcelain"],
      { encoding: "utf8", timeout: 5000, stdio: ["ignore", "pipe", "pipe"] }).trim();
    return out || null;
  } catch { return null; }   // unreadable is not "unbanked"; the deleter is the one that must refuse
}

export interface DigestInput {
  liveRoles: Set<string>;
  limited: Record<string, { kind: string; etaText?: string | null }>;
  premiumPending: Record<string, { model: string; attempts: number }>;
  repoRoot: string | null;
  now?: number;
  staleDays?: number;
  checkUnbanked?: boolean;
}

export function buildDigest(repo: string | null, input: DigestInput): Digest | null {
  if (!repo) return null;
  const now = input.now ?? Date.now();
  const staleDays = input.staleDays ?? 30;
  const d: Digest = {
    repo, awaitingPickup: [], blocked: [], limited: [], premium: [], unbanked: [],
    missingSessions: [], orchestratorTagged: !!getOrchestrator(repo),
    staleBuses: [], duplicateRoles: [], actionable: 0,
  };

  for (const role of boardRoles(repo)) {
    const dir = path.join(LOOM_ROOT, repo, role);
    const ob = mtime(path.join(dir, "outbox.md"));
    const ib = mtime(path.join(dir, "inbox.md"));
    // A response written after the last handoff, still sitting there.
    if (ob !== null && ib !== null && ob > ib && nonEmpty(path.join(dir, "outbox.md"))) {
      d.awaitingPickup.push({ role, detail: "response not picked up", hoursAgo: (now - ob) / HOUR_MS });
    }
    const st = readStatus(repo, role);
    if (st && st.status === "blocked") {
      d.blocked.push({ role, detail: String(st.current || st.last_line || "loop-back raised").slice(0, 80) });
    }
    const lim = input.limited[role];
    if (lim) d.limited.push({ role, detail: lim.kind + (lim.etaText ? ` · resets ${lim.etaText}` : "") });
    const prem = input.premiumPending[role];
    if (prem) d.premium.push({ role, detail: `on ${prem.model} (attempt ${prem.attempts})` });
    if (input.checkUnbanked !== false) {
      const dirty = unbankedIn(input.repoRoot, role);
      if (dirty) d.unbanked.push({ role, detail: `${dirty.split("\n").length} uncommitted change(s)` });
    }
    // A role the board still claims, whose tab is not live — the "evaporated session" case.
    if (!input.liveRoles.has(role)) {
      const entry = boardEntry(repo, role);
      if (entry && entry.session_id) d.missingSessions.push({ role, sessionId: String(entry.session_id) });
    }
  }

  // Hygiene across every bus (not counted as actionable).
  const seen = new Map<string, string[]>();
  for (const r of busRepos()) {
    const touched = busTouched(r);
    if (touched !== null) {
      const days = (now - touched) / (24 * HOUR_MS);
      if (days >= staleDays) d.staleBuses.push({ repo: r, days: Math.round(days) });
    }
    for (const role of boardRoles(r)) {
      if (!seen.has(role)) seen.set(role, []);
      seen.get(role)!.push(r);
    }
  }
  for (const [role, repos] of seen) if (repos.length > 1) d.duplicateRoles.push({ role, repos: repos.sort() });

  d.actionable = d.awaitingPickup.length + d.blocked.length + d.limited.length +
    d.premium.length + d.unbanked.length + d.missingSessions.length + (d.orchestratorTagged ? 0 : 1);
  return d;
}

/** Human-readable digest, for the modal and the log. */
export function renderDigest(d: Digest): string {
  const L: string[] = [];
  const list = (title: string, items: RoleNote[]) => {
    if (!items.length) return;
    L.push(`${title} (${items.length}):`);
    for (const i of items) {
      L.push(`   • ${i.role} — ${i.detail}` + (i.hoursAgo !== undefined ? ` (${i.hoursAgo.toFixed(1)}h ago)` : ""));
    }
  };
  if (!d.orchestratorTagged) {
    L.push("⚠ No orchestrator tagged — finish notifications, auto-resume and the model exemption are all inactive.");
  }
  list("Responses waiting to be picked up", d.awaitingPickup);
  list("Blocked on a decision", d.blocked);
  list("Blocked by a usage limit", d.limited);
  list("Workers on the orchestrator-only model", d.premium);
  list("Unbanked work in a worktree", d.unbanked);
  if (d.missingSessions.length) {
    L.push(`Roles with no live session (${d.missingSessions.length}):`);
    for (const m of d.missingSessions) L.push(`   • ${m.role} — ${m.sessionId.slice(0, 8)}`);
  }
  if (d.staleBuses.length) {
    L.push(`Stale buses (${d.staleBuses.length}): ` + d.staleBuses.map((s) => `${s.repo} (${s.days}d)`).join(", "));
  }
  if (d.duplicateRoles.length) {
    L.push(`Role names claimed by more than one bus (${d.duplicateRoles.length}): ` +
      d.duplicateRoles.map((x) => `${x.role} [${x.repos.join(", ")}]`).join("; "));
  }
  return L.length ? L.join("\n") : "Nothing needs your attention.";
}
