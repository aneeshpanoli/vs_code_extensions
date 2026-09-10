// health.ts — ONE JOB: notice the failure modes the finish-notifier structurally cannot see.
//
// The notifier fires on `working -> idle/blocked`. So a role that goes `working` and never comes
// back is invisible forever: a stall is indistinguishable from a busy session. Measured on the real
// buses 2026-09-08, four roles claimed to be working with stale status files — one of them
// (gaming/leveldesign) for 1681 hours. Nothing would ever have told you.
//
// Two related blind spots, also measured:
//   * Non-conforming statuses. The protocol is idle | working | blocked, but `shwab_docker/trader`
//     sat in "active" and `livegita/po` in "orchestrating". The notifier now baselines on any
//     WORKING_LIKE status so those finishes still announce, but the roles are still reported: a
//     status nothing else recognises is a protocol break worth fixing at the source.
//   * `updated_at` drift: trader's timestamp was 1205h stale while its file had been touched 4.9h
//     ago, i.e. something rewrites the file without maintaining the field the panel displays.
//
// Everything here is read-only analysis; the one destructive helper (removeWorktree) refuses dirty
// work exactly like deleter.ts, and never uses --force.

import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { execFileSync } from "child_process";
import { boardRoles, busRepos } from "./registry";
import { injectTo } from "./inject";
import { getOrchestrator } from "./orchestrator";

const LOOM_ROOT = path.join(os.homedir(), ".claude", "loom");
const WORKING_FILE = path.join(LOOM_ROOT, "working-sessions.json");
const HOUR_MS = 3_600_000;

/** The statuses the loom protocol defines. Anything else silently bypasses the notifier. */
export const KNOWN_STATUSES = ["idle", "working", "blocked"];
/** Statuses that mean the role is consuming the shared usage pool right now. */
export const WORKING_LIKE = ["working", "active", "running", "busy"];
/** updated_at allowed to lag the file this long before we call it unmaintained. */
export const DRIFT_HOURS = 6;

export interface StallFinding { role: string; status: string; staleHours: number; }
export interface ConformFinding { role: string; status: string; issue: string; }
export interface HealthReport { repo: string; stalled: StallFinding[]; nonConforming: ConformFinding[]; }

function readStatus(repo: string, role: string): { obj: any; mtimeMs: number } | null {
  const f = path.join(LOOM_ROOT, repo, role, "status.json");
  try {
    const st = fs.statSync(f);
    return { obj: JSON.parse(fs.readFileSync(f, "utf8")), mtimeMs: st.mtimeMs };
  } catch { return null; }
}

function parseIso(v: any): number | null {
  if (typeof v !== "string" || !v) return null;
  const t = Date.parse(v);
  return Number.isFinite(t) ? t : null;
}

export function isWorkingLike(status: any): boolean {
  return typeof status === "string" && WORKING_LIKE.includes(status.toLowerCase());
}

/**
 * Stalled roles (working-like but not writing status any more) and protocol violations.
 * `stallMinutes` is how long a working role may go quiet before we call it stuck.
 */
export function checkHealth(repo: string | null,
                            opts: { now?: number; stallMinutes?: number } = {}): HealthReport | null {
  if (!repo) return null;
  const now = opts.now ?? Date.now();
  const stallMs = (opts.stallMinutes ?? 45) * 60_000;
  const out: HealthReport = { repo, stalled: [], nonConforming: [] };
  for (const role of boardRoles(repo)) {
    const s = readStatus(repo, role);
    if (!s) continue;
    const status = String(s.obj.status ?? "");
    if (status && !KNOWN_STATUSES.includes(status.toLowerCase())) {
      out.nonConforming.push({
        role, status,
        issue: isWorkingLike(status)
          ? `not a protocol status — a finish from "${status}" never notifies`
          : "not a protocol status",
      });
    }
    const ua = parseIso(s.obj.updated_at);
    if (ua !== null && s.mtimeMs - ua > DRIFT_HOURS * HOUR_MS) {
      out.nonConforming.push({
        role, status,
        issue: `updated_at is ${((s.mtimeMs - ua) / HOUR_MS).toFixed(0)}h behind the file — not being maintained`,
      });
    }
    if (isWorkingLike(status) && now - s.mtimeMs > stallMs) {
      out.stalled.push({ role, status, staleHours: (now - s.mtimeMs) / HOUR_MS });
    }
  }
  return out;
}

// ── global concurrency ──────────────────────────────────────────────────────────────────────
export interface WorkingCount { at: string; total: number; roles: string[]; }

/** Roles working RIGHT NOW across every project — the number that actually burns the shared pool. */
export function countWorking(now = Date.now()): WorkingCount {
  const roles: string[] = [];
  for (const repo of busRepos()) {
    for (const role of boardRoles(repo)) {
      const s = readStatus(repo, role);
      if (s && isWorkingLike(s.obj.status)) roles.push(`${repo}/${role}`);
    }
  }
  roles.sort();
  return { at: new Date(now).toISOString(), total: roles.length, roles };
}

/** Publish it so every window (and any script) sees the same global number. Never throws. */
export function publishWorking(c: WorkingCount): void {
  try {
    try {
      const cur = JSON.parse(fs.readFileSync(WORKING_FILE, "utf8"));
      if (JSON.stringify(cur.roles) === JSON.stringify(c.roles)) return;   // change-only
    } catch { /* write it */ }
    fs.mkdirSync(LOOM_ROOT, { recursive: true });
    const tmp = WORKING_FILE + ".tmp." + process.pid;
    fs.writeFileSync(tmp, JSON.stringify(c, null, 2));
    fs.renameSync(tmp, WORKING_FILE);
  } catch { /* a monitor must never break a tick */ }
}

export function readWorking(): WorkingCount | null {
  try { return JSON.parse(fs.readFileSync(WORKING_FILE, "utf8")); } catch { return null; }
}

// ── worktree hygiene ────────────────────────────────────────────────────────────────────────
/** Gitignored names that are NOT rebuildable — losing them is real damage, not a rebuild. */
export const RISKY_IGNORED = /(^|\/)\.env|\.key$|\.pem$|secrets?|\.sqlite3?$|\.db$|credentials/i;

export interface WorktreeFinding {
  role: string; path: string; orphaned: boolean; dirty: boolean;
  /** Gitignored-but-precious files living here. `git status --porcelain` does NOT list ignored
   *  files, so without this a worktree holding a .env reads as perfectly clean. Measured live:
   *  funisland/adapt-health-fixes is porcelain-clean and holds one. */
  risky: string[];
  /** Commits on this branch not reachable from the repo's default branch, or null if unknown. */
  ahead: number | null;
  /** The role still has a live session — removing the directory out from under it would break it. */
  live: boolean;
  /** The branch it is checked out on, or null when HEAD is DETACHED. Not always `worktree-<role>`:
   *  measured live, funisland/act sits on `act-module`. Null is the dangerous case — removing a
   *  detached worktree leaves its commits unreferenced (reflog only, until gc), so it is refused. */
  branch: string | null;
}

function git(cwd: string, args: string[], timeout = 5000): string | null {
  try {
    return execFileSync("git", ["-C", cwd, ...args],
      { encoding: "utf8", timeout, stdio: ["ignore", "pipe", "pipe"] }).trim();
  } catch { return null; }
}

/** The repo's default branch, for the ahead-count. */
function defaultBranch(repoRoot: string): string | null {
  const head = git(repoRoot, ["symbolic-ref", "--short", "refs/remotes/origin/HEAD"]);
  if (head) return head.replace(/^origin\//, "");
  for (const b of ["main", "master"]) if (git(repoRoot, ["rev-parse", "--verify", "--quiet", b])) return b;
  return null;
}

/** Every worktree under <repoRoot>/.claude/worktrees, with everything needed to refuse safely. */
export function scanWorktrees(repo: string | null, repoRoot: string | null,
                              liveRoles: Set<string> = new Set()): WorktreeFinding[] {
  if (!repo || !repoRoot) return [];
  const dir = path.join(repoRoot, ".claude", "worktrees");
  let names: string[] = [];
  try { names = fs.readdirSync(dir).filter((n) => { try { return fs.statSync(path.join(dir, n)).isDirectory(); } catch { return false; } }); }
  catch { return []; }
  const roster = new Set(boardRoles(repo));
  const base = defaultBranch(repoRoot);
  return names.map((role) => {
    const p = path.join(dir, role);
    const porcelain = git(p, ["status", "--porcelain"]);
    const dirty = porcelain === null ? true : porcelain.length > 0;   // unverifiable counts as dirty
    const branch = git(p, ["symbolic-ref", "--short", "HEAD"]) || null;
    const ignored = (git(p, ["status", "--porcelain", "--ignored"]) || "")
      .split("\n").filter((l) => l.startsWith("!!")).map((l) => l.slice(3).trim());
    const risky = ignored.filter((f) => RISKY_IGNORED.test(f));
    let ahead: number | null = null;
    if (branch && base) {
      const n = git(repoRoot, ["rev-list", "--count", `${base}..${branch}`], 10000);
      ahead = n === null ? null : parseInt(n, 10);
    }
    return { role, path: p, orphaned: !roster.has(role), dirty, risky, ahead, live: liveRoles.has(role), branch };
  }).sort((a, b) => a.role.localeCompare(b.role));
}

/**
 * Remove one worktree. The directory goes; the BRANCH and its commits stay, so it is re-addable
 * with `git worktree add <path> <branch>`. Refuses anything dirty, still rostered, or DETACHED —
 * a detached worktree's commits are on no branch, so removing it would strand them.
 */
export function removeWorktree(repoRoot: string, f: WorktreeFinding): { ok: boolean; note: string } {
  // Every refusal below is a way this could destroy something git cannot give back.
  if (f.dirty) return { ok: false, note: `${f.role}: uncommitted work — refused` };
  if (!f.orphaned) return { ok: false, note: `${f.role}: still on the board — refused` };
  if (f.live) return { ok: false, note: `${f.role}: has a LIVE session — refused (it would lose its working dir)` };
  if (!f.branch) {
    return { ok: false, note: `${f.role}: DETACHED HEAD — its commits are on no branch; ` +
      `removing would strand them. Give it a branch first (git -C <path> switch -c keep-${f.role}).` };
  }
  if (f.risky.length) {
    return { ok: false, note: `${f.role}: holds gitignored files git cannot restore ` +
      `(${f.risky.slice(0, 3).join(", ")}) — refused` };
  }
  const head = git(f.path, ["rev-parse", "HEAD"]);
  const out = git(repoRoot, ["worktree", "remove", f.path], 15000);
  if (out === null) return { ok: false, note: `${f.role}: git refused to remove it (locked, or in use)` };
  logRemoval({ at: new Date().toISOString(), repoRoot, role: f.role, path: f.path,
               branch: f.branch, head, ahead: f.ahead });
  return { ok: true, note: `${f.role}: removed — branch ${f.branch} kept` +
    (f.ahead ? ` (${f.ahead} commit(s) ahead)` : "") +
    `; restore with: git -C ${repoRoot} worktree add ${f.path} ${f.branch}` };
}

/** Append-only record of what was removed, so every removal has a written way back. */
function logRemoval(entry: any): void {
  try {
    const f = path.join(LOOM_ROOT, "worktree-removals.json");
    let log: any[] = [];
    try { const j = JSON.parse(fs.readFileSync(f, "utf8")); if (Array.isArray(j)) log = j; } catch { /* new */ }
    log.push(entry);
    fs.mkdirSync(LOOM_ROOT, { recursive: true });
    const tmp = f + ".tmp." + process.pid;
    fs.writeFileSync(tmp, JSON.stringify(log.slice(-200), null, 2));
    fs.renameSync(tmp, f);
  } catch { /* the removal already happened; a failed log must not throw */ }
}

export function readRemovalLog(): any[] {
  try { const j = JSON.parse(fs.readFileSync(path.join(LOOM_ROOT, "worktree-removals.json"), "utf8"));
        return Array.isArray(j) ? j : []; } catch { return []; }
}

// ── stall alerting (deduped on the bus, like the finish notifier) ────────────────────────────
interface StallState { alerted: Record<string, { status: string; at: string }>; updatedAt?: string; }
function stallFile(repo: string): string { return path.join(LOOM_ROOT, repo, "stall-state.json"); }

function loadStall(repo: string): StallState {
  try {
    const st = JSON.parse(fs.readFileSync(stallFile(repo), "utf8"));
    if (st && st.alerted && typeof st.alerted === "object") return { alerted: st.alerted };
  } catch { /* none yet */ }
  return { alerted: {} };
}
function saveStall(repo: string, st: StallState): void {
  try {
    const f = stallFile(repo);
    try {
      const cur = JSON.parse(fs.readFileSync(f, "utf8"));
      if (JSON.stringify(cur.alerted) === JSON.stringify(st.alerted)) return;
    } catch { /* write */ }
    fs.mkdirSync(path.dirname(f), { recursive: true });
    const tmp = f + ".tmp." + process.pid;
    fs.writeFileSync(tmp, JSON.stringify({ ...st, updatedAt: new Date().toISOString() }, null, 2));
    fs.renameSync(tmp, f);
  } catch { /* ignore */ }
}

export interface StallEvent { repo: string; role: string; status: string; staleHours: number; }

export class HealthWatcher {
  constructor(private repo: string | null) {}

  /** New stalls since the last pass. A role is re-alerted only after it starts moving again. */
  scan(report: HealthReport | null): StallEvent[] {
    if (!this.repo || !report) return [];
    const st = loadStall(this.repo);
    const stalledNow = new Set(report.stalled.map((s) => s.role));
    for (const role of Object.keys(st.alerted)) if (!stalledNow.has(role)) delete st.alerted[role];
    const events: StallEvent[] = [];
    for (const s of report.stalled) {
      if (st.alerted[s.role]) continue;                       // already told them about this stall
      st.alerted[s.role] = { status: s.status, at: new Date().toISOString() };
      events.push({ repo: this.repo, role: s.role, status: s.status, staleHours: s.staleHours });
    }
    saveStall(this.repo, st);
    return events;
  }

  /** Tell the orchestrator a worker appears stuck. Fire-and-forget, like the other injectors, and
   *  addressed by the tag's frame id for the same reason (see inject.ts). */
  alert(ev: StallEvent, orchestratorRole: string, done?: (ok: boolean, note: string) => void): void {
    const msg = `[loom-stall] ${ev.role} has been "${ev.status}" with no status update for ` +
      `${ev.staleHours.toFixed(1)}h. Check whether it is stuck, blocked, or finished without saying so.`;
    const tag = getOrchestrator(ev.repo);
    injectTo({ role: orchestratorRole, webviewId: tag ? tag.webviewId : null, repo: ev.repo },
             msg, "stall-debug.json", done);
  }
}
