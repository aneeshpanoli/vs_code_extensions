// health.ts — ONE JOB: notice the failure modes the finish-notifier structurally cannot see.
//
// The notifier fires on `working -> idle/blocked`. So a role that goes `working` and never comes
// back is invisible forever: a stall is indistinguishable from a busy session. Measured on the real
// buses 2026-09-08, four roles claimed to be working with stale status files — one of them
// (gaming/leveldesign) for 1681 hours. Nothing would ever have told you.
//
// Two related blind spots, also measured:
//   * Non-conforming statuses. The protocol is idle | working | blocked, but `shwab_docker/trader`
//     sat in "active" and `livegita/po` in "orchestrating". The notifier only reacts when the
//     PREVIOUS status was "working", so a role in "active" can never announce a finish at all.
//   * `updated_at` drift: trader's timestamp was 1205h stale while its file had been touched 4.9h
//     ago, i.e. something rewrites the file without maintaining the field the panel displays.
//
// Everything here is read-only analysis; the one destructive helper (removeWorktree) refuses dirty
// work exactly like deleter.ts, and never uses --force.

import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { execFile, execFileSync } from "child_process";
import { boardRoles, busRepos } from "./registry";

const LOOM_ROOT = path.join(os.homedir(), ".claude", "loom");
const LOOM_CDP = path.join(LOOM_ROOT, "loom_cdp.py");
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
export interface WorktreeFinding { role: string; path: string; orphaned: boolean; dirty: boolean; }

/** Every worktree under <repoRoot>/.claude/worktrees, tagged orphaned (no board role) and dirty. */
export function scanWorktrees(repo: string | null, repoRoot: string | null): WorktreeFinding[] {
  if (!repo || !repoRoot) return [];
  const dir = path.join(repoRoot, ".claude", "worktrees");
  let names: string[] = [];
  try { names = fs.readdirSync(dir).filter((n) => { try { return fs.statSync(path.join(dir, n)).isDirectory(); } catch { return false; } }); }
  catch { return []; }
  const roster = new Set(boardRoles(repo));
  return names.map((role) => {
    const p = path.join(dir, role);
    let dirty = true;                       // unreadable counts as dirty: never remove what we cannot verify
    try {
      dirty = execFileSync("git", ["-C", p, "status", "--porcelain"],
        { encoding: "utf8", timeout: 5000, stdio: ["ignore", "pipe", "pipe"] }).trim().length > 0;
    } catch { /* keep dirty = true */ }
    return { role, path: p, orphaned: !roster.has(role), dirty };
  }).sort((a, b) => a.role.localeCompare(b.role));
}

/** Remove one worktree. Refuses anything dirty or still on the roster; the branch is retained. */
export function removeWorktree(repoRoot: string, f: WorktreeFinding): { ok: boolean; note: string } {
  if (f.dirty) return { ok: false, note: `${f.role}: uncommitted work — refused` };
  if (!f.orphaned) return { ok: false, note: `${f.role}: still on the board — refused` };
  try {
    execFileSync("git", ["-C", repoRoot, "worktree", "remove", f.path],
      { encoding: "utf8", timeout: 15000, stdio: ["ignore", "pipe", "pipe"] });
    return { ok: true, note: `${f.role}: removed (branch worktree-${f.role} retained)` };
  } catch (e: any) { return { ok: false, note: `${f.role}: ${String(e.message || e).slice(0, 80)}` }; }
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

  /** Tell the orchestrator a worker appears stuck. Fire-and-forget, like the other injectors. */
  alert(ev: StallEvent, orchestratorRole: string, done?: (ok: boolean, note: string) => void): void {
    const msg = `[loom-stall] ${ev.role} has been "${ev.status}" with no status update for ` +
      `${ev.staleHours.toFixed(1)}h. Check whether it is stuck, blocked, or finished without saying so.`;
    execFile("python3", [LOOM_CDP, "inject", "--role", orchestratorRole, "--message", msg, "--submit"],
      { timeout: 60_000 },
      (err, stdout, stderr) => {
        const ok = !err;
        try {
          fs.writeFileSync(path.join(LOOM_ROOT, "stall-debug.json"), JSON.stringify({
            at: new Date().toISOString(), event: ev, orchestrator: orchestratorRole, ok,
            out: String(stdout || "").slice(-400),
            err: String((err && err.message) || stderr || "").slice(-400),
          }, null, 2));
        } catch { /* ignore */ }
        done?.(ok, ok ? "alerted" : String((err && err.message) || "inject failed"));
      });
  }
}
