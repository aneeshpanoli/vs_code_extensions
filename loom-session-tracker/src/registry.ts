// registry.ts — ONE JOB: the persistence + project-partition layer. Reads each repo's role roster
// (board.json) to know which project a role belongs to, and writes each project's targetmap.json.
// FAIL-PROOF: atomic writes (temp+rename), never overwrite a good map with an empty/worse one, and
// only rewrite when the content actually changed (no churn). All I/O is try/caught.

import * as fs from "fs";
import * as os from "os";
import * as path from "path";

const LOOM_ROOT = path.join(os.homedir(), ".claude", "loom");

export interface Agent {
  role: string;
  repo: string;
  webviewId: string;
  lastSeen: number;   // epoch ms this agent was last confidently detected
}

function loadWidMap(repo: string, file: string): Map<string, string> {
  const out = new Map<string, string>();
  try {
    const m = JSON.parse(fs.readFileSync(path.join(LOOM_ROOT, repo, file), "utf8"));
    if (m && typeof m === "object") for (const [w, r] of Object.entries(m)) if (typeof r === "string") out.set(w, r);
  } catch { /* none yet */ }
  return out;
}

/** {webviewId: role} AUTHORITATIVE bindings recorded at `/loom`-injection time (bindings.json). The
 *  extension NEVER writes this file — so a `/loom` self-binding survives ticks where the role emits no
 *  detectable signal (marker scrolled out, working outside a worktree). This is the durable gap-filler. */
export function loadBindings(repo: string): Map<string, string> {
  return loadWidMap(repo, "bindings.json");
}

/** {webviewId: role} from the tracker's own detection cache (targetmap.json). */
export function loadTargetmap(repo: string): Map<string, string> {
  return loadWidMap(repo, "targetmap.json");
}

// board.json top-level keys that are metadata, not roles (only matter for FLAT boards with no `roles` wrapper).
const NON_ROLE_KEYS = new Set([
  "repo", "bus", "note", "orchestrator", "roles", "concurrency", "decisions",
  "playtests", "milestones", "bugs", "process_fixes", "qa_log",
]);

/** The role names registered in ONE project's board.json (its authoritative roster). */
export function boardRoles(repo: string): string[] {
  let data: any;
  try { data = JSON.parse(fs.readFileSync(path.join(LOOM_ROOT, repo, "board.json"), "utf8")); }
  catch { return []; }
  const roles = (data && data.roles) || data;   // nested {roles:{...}} or a flat {role:{...}} board
  if (!roles || typeof roles !== "object") return [];
  // Only apply the metadata filter to a FLAT board; a nested `roles` dict is all-roles by construction.
  const flat = !(data && data.roles);
  return Object.keys(roles).filter((k) => k && (!flat || !NON_ROLE_KEYS.has(k)));
}

/** {role: repo} from every repo bus's board.json — the authoritative per-project roster. */
export function roleToRepo(): Map<string, string> {
  const out = new Map<string, string>();
  let repos: string[] = [];
  try { repos = fs.readdirSync(LOOM_ROOT); } catch { return out; }
  for (const repo of repos) {
    for (const role of boardRoles(repo)) out.set(role, repo);
  }
  return out;
}

/** Atomic, no-throw write. Returns true if the file was (re)written, false if unchanged/failed. */
function writeAtomic(file: string, contentObj: any): boolean {
  let next: string;
  try { next = JSON.stringify(contentObj, null, 2); } catch { return false; }
  try {
    const cur = fs.readFileSync(file, "utf8");
    if (cur.trim() === next.trim()) return false;   // change-only: no churn
  } catch { /* missing -> write it */ }
  try {
    const tmp = file + ".tmp." + process.pid;
    fs.writeFileSync(tmp, next);
    fs.renameSync(tmp, file);                        // atomic swap
    return true;
  } catch { return false; }
}

/**
 * Persist the per-project targetmaps from the current set of confidently-detected agents.
 * FAIL-PROOF RULES:
 *  - Only touch a repo we actually saw ≥1 agent for THIS pass (never clobber a good map with empty
 *    because a transient CDP read returned nothing).
 *  - Atomic + change-only writes.
 * Returns the list of repos whose map changed.
 */
export function writeTargetmaps(agents: Agent[]): string[] {
  const perRepo = new Map<string, Record<string, string>>();
  for (const a of agents) {
    if (!perRepo.has(a.repo)) perRepo.set(a.repo, {});
    perRepo.get(a.repo)![a.webviewId] = a.role;
  }
  const changed: string[] = [];
  for (const [repo, tmap] of perRepo) {
    if (Object.keys(tmap).length === 0) continue;   // never write an empty map
    const file = path.join(LOOM_ROOT, repo, "targetmap.json");
    if (writeAtomic(file, tmap)) changed.push(repo);
  }
  return changed;
}

/** Every project bus that has a board.json (used when a window has no folder open, so the user can
 *  still choose which project they're tagging an orchestrator for). */
export function busRepos(): string[] {
  try {
    return fs.readdirSync(LOOM_ROOT)
      .filter((r) => { try { return fs.statSync(path.join(LOOM_ROOT, r, "board.json")).isFile(); } catch { return false; } })
      .sort();
  } catch { return []; }
}
