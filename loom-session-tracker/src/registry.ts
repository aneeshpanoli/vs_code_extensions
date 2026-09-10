// registry.ts — ONE JOB: the persistence + project-partition layer. Reads each repo's role roster
// (board.json) to know which project a role belongs to, and writes each project's targetmap.json.
// FAIL-PROOF: atomic writes (temp+rename), never overwrite a good map with an empty/worse one, and
// only rewrite when the content actually changed (no churn). All I/O is try/caught.

import * as fs from "fs";
import * as os from "os";
import * as path from "path";

import { isOwnerRole } from "./naming";

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

// A DENYLIST of metadata key names is not enough, and the cost of it being wrong is not cosmetic.
// Measured across every live board 2026-09-08: funisland's flat board carries `_comment`, `updated`,
// `standing_order`, `priority_rule`, `lanes`, `standing_laws_for_every_item` and `free_now` — none of
// them on the denylist — so its roster came out as 7 phantom roles plus 3 real ones, and DROPPED the 8
// real roles that own a mailbox on the bus (art, character, metagame, playtest, scriptwriter,
// simulation, testgamification, content). Everything keyed off the roster was wrong for them:
//   * the classifier's validRoles excluded them, so those sessions could not be detected at all;
//   * checkHealth() never looked at them — funisland/simulation had been "working" with no status
//     update since 2026-08-21 (18 days) and no watchdog could ever have seen it;
//   * scanWorktrees() marks `orphaned = !roster.has(role)`, so 7 of their worktrees read as orphaned,
//     and 6 of those passed EVERY safeguard in removeWorktree (clean, on a branch, nothing risky) —
//     the cleanup report was offering to remove the working directories of live roles.
// So roles are now derived STRUCTURALLY, from two independent sources, and unioned:
//   A) the board — every key of a nested `roles` wrapper, or, on a flat board, every object-valued key
//      that is shaped like a role entry (measured: session_id/branch/status/bound_at/worktree/... ) or
//      is a bare `{}` stub. funisland's `lanes` is an object too, but its keys are lane names, not role
//      fields, so it is excluded on shape rather than by name.
//   B) the bus — any subdirectory holding a mailbox (status.json / inbox.md / outbox.md). A role with a
//      mailbox EXISTS whether or not the board remembered to list it; measured, this is what recovers
//      funisland's 8, gaming/gameplay and livegita/developer.
// The two failure directions are not symmetric: a phantom role costs nothing (its status/mailbox reads
// simply fail and it is skipped), while a dropped role makes a real session invisible and its worktree
// look like garbage. The union errs in the harmless direction on purpose.

/** Fields a role entry carries on a flat board, measured across every live board 2026-09-08. */
const ROLE_FIELDS = new Set([
  "session_id", "sessionId", "session", "branch", "status", "bound_at", "boundAt",
  "worktree", "webviewId", "role", "current", "last_handled", "updated_at", "model",
]);

/** Files that mean "this directory is a role's mailbox on the bus". */
const MAILBOX_FILES = ["status.json", "inbox.md", "outbox.md"];

function isRoleEntry(v: any): boolean {
  if (!v || typeof v !== "object" || Array.isArray(v)) return false;
  const keys = Object.keys(v);
  if (keys.length === 0) return true;                       // a bare `{}` stub is a declared role
  return keys.some((k) => ROLE_FIELDS.has(k));
}

/** Roles that own a mailbox directory on this bus, whatever the board says about them. */
function mailboxRoles(repo: string): string[] {
  const dir = path.join(LOOM_ROOT, repo);
  let names: string[] = [];
  try { names = fs.readdirSync(dir); } catch { return []; }
  return names.filter((n) => !n.startsWith(".") &&
    MAILBOX_FILES.some((f) => { try { return fs.statSync(path.join(dir, n, f)).isFile(); } catch { return false; } }));
}

/** The role names of ONE project: its board roster UNION the roles that own a mailbox on its bus. */
export function boardRoles(repo: string): string[] {
  const out = new Set<string>(mailboxRoles(repo));
  let data: any;
  try { data = JSON.parse(fs.readFileSync(path.join(LOOM_ROOT, repo, "board.json"), "utf8")); }
  catch { return Array.from(out).sort(); }
  const nested = data && data.roles && typeof data.roles === "object" && !Array.isArray(data.roles)
    ? data.roles : null;
  if (nested) {
    // Inside a `roles` wrapper every key is a role by construction — no shape test, no filtering.
    for (const k of Object.keys(nested)) if (k) out.add(k);
  } else if (data && typeof data === "object" && !Array.isArray(data)) {
    for (const [k, v] of Object.entries(data)) if (k && !NON_ROLE_KEYS.has(k) && isRoleEntry(v)) out.add(k);
  }
  return Array.from(out).sort();
}

/**
 * The webviewIds this project's board declares to be its ORCHESTRATOR's, from every board entry whose
 * key is an owner name (any spelling — see naming.ts).
 *
 * WHY THIS IS NEEDED, measured live 2026-09-09. Content detection CANNOT identify livegita's PO. The
 * orchestrator quotes its workers' `LOOMROLE=` sign-offs, and `detectOwner()` only calls that a
 * self-tell at THREE distinct roles — but livegita runs ONE worker, so its PO can never quote three.
 * With a single quoted `LOOMROLE=gitadeveloper`, `classify()` read the PO's own tab as a clean
 * single-marker sign-off and returned it as the DEVELOPER. Worse, it then beat the real developer's
 * frame for that role on text length (159 KB vs 57 KB), so the tracker showed the orchestrator's tab
 * as the developer — which is how a hand-tag came to write `{"role":"gitadeveloper"}` at 17:36.
 * The ≥3 heuristic is sound for a big team and useless for a small one; the board is not a heuristic.
 */
export function boardOwnerFrames(repo: string): Set<string> {
  const out = new Set<string>();
  let data: any;
  try { data = JSON.parse(fs.readFileSync(path.join(LOOM_ROOT, repo, "board.json"), "utf8")); }
  catch { return out; }
  const src = (data && data.roles && typeof data.roles === "object" && !Array.isArray(data.roles))
    ? data.roles : data;
  if (!src || typeof src !== "object") return out;
  for (const [k, v] of Object.entries<any>(src)) {
    if (!isOwnerRole(k)) continue;
    const w = v && typeof v === "object" ? v.webviewId : null;
    if (typeof w === "string" && w) out.add(w);
  }
  return out;
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
