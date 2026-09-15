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

// ── WL-006 · a declared background gate is evidence, not silence ──────────────────────────────
//
// THE HOLE THIS CLOSES, measured three times (WL-002, WL-004+FX-002, WL-005). A worker launches a
// mutation gate in the background, its turn ends, and the gate finishes ~18 minutes later with
// nothing to wake it. Its `outbox.md` line 1 still names the PREVIOUS handoff and `status.json`
// still says the previous `current`, which to anything reading the bus is indistinguishable from a
// worker that has done nothing — the same shape as a stall. The orchestrator then either waits on a
// worker that will never speak, or rings a worker that IS busy and burns the context doing the work.
//
// WHY THIS LIVES IN health.ts and not beside the ledger tick: the stall alarm and the gate wake are
// THE SAME MEASUREMENT of the same field. The stall clock asks "how long since status.json was
// written", which cannot tell stuck from busy — it fired at 0.8h during FX-002 with ten files
// edited. A live gate is positive evidence of work on exactly that question. Splitting the two
// across files is how one state ends up rendered as another.
//
// THREE STATES, NEVER COLLAPSED (the `unmeasured`-as-zero mistake, sixth sighting):
//   · "running" — a declared gate positively identified as alive. NOT a stall; suppresses the alarm.
//   · "exited"  — declared, and not identified alive. Wake the role, once.
//   · "none"    — nothing declared. The only one of the three that may look like idle.

export type GateState = "running" | "exited" | "none";

export interface GateDeclaration {
  pid: number;
  log: string;
  launchedAt: string;
  mutants: number | null;
  /** WHICH BLOCK THE GATE BELONGS TO, so a finished block's leftover declaration does not wake
   *  anyone. Found live in developer1's own status.json 2026-09-15: WL-005's declaration — pid dead,
   *  block merged 90 minutes earlier — was still sitting there, and under
   *  "unidentified -> exited -> wake" it was a wake for a block that was over. The `log@launchedAt`
   *  key bounds that to ONE spurious wake rather than one per tick, which is the important half, but
   *  one wake still costs a role a whole turn of the context this block exists to protect. Optional:
   *  a declaration without it still behaves as before, bounded by the key. */
  handoff: string | null;
}

/** `status.json.gate`, as the worker writes it. Absent or malformed reads as no declaration — a
 *  half-written gate block must never be read as a live gate. */
export function readGate(obj: any): GateDeclaration | null {
  const g = obj && obj.gate;
  if (!g || typeof g !== "object") return null;
  const pid = Number(g.pid);
  const log = typeof g.log === "string" ? g.log : "";
  const launchedAt = typeof g.launched_at === "string" ? g.launched_at
                   : typeof g.launchedAt === "string" ? g.launchedAt : "";
  if (!Number.isInteger(pid) || pid <= 0 || !log || !Number.isFinite(Date.parse(launchedAt))) return null;
  const m = Number(g.mutants);
  const h = typeof g.handoff === "string" && g.handoff ? g.handoff : null;
  return { pid, log, launchedAt, mutants: Number.isFinite(m) ? m : null, handoff: h };
}

/** Seconds since boot, from /proc/stat's `btime`. */
function bootTimeMs(): number | null {
  try {
    const m = /^btime (\d+)$/m.exec(fs.readFileSync("/proc/stat", "utf8"));
    return m ? Number(m[1]) * 1000 : null;
  } catch { return null; }
}

/** When the process at `pid` actually started, from /proc/<pid>/stat field 22 (USER_HZ ticks since
 *  boot). Null when it cannot be read — which is not "it started long ago", it is "unknown". */
function processStartMs(pid: number): number | null {
  const boot = bootTimeMs();
  if (boot === null) return null;
  let stat: string;
  try { stat = fs.readFileSync(`/proc/${pid}/stat`, "utf8"); } catch { return null; }
  // The comm field can contain spaces and parentheses, so fields are counted AFTER the last ')'.
  const tail = stat.slice(stat.lastIndexOf(")") + 2).split(/\s+/);
  const ticks = Number(tail[19]);                          // field 22 overall = index 19 after comm
  if (!Number.isFinite(ticks)) return null;
  return boot + (ticks / 100) * 1000;                      // USER_HZ is 100 on Linux
}

/** The declared pid's own command line, or null. READ OF ONE KNOWN PID, never a pattern search:
 *  a search whose pattern names its target matches the searcher's own argv, which has caught three
 *  things on this bus in one day — and the bracket form protects the pattern, not the rest of argv. */
function cmdlineOf(pid: number): string | null {
  try { return fs.readFileSync(`/proc/${pid}/cmdline`, "utf8").replace(/\0/g, " ").trim(); }
  catch { return null; }
}

/** How far a process's measured start may sit from the declared `launched_at` and still be the same
 *  launch. The declaration is written in the same turn as the spawn, so seconds; a minute is slack. */
const GATE_START_TOLERANCE_MS = 120_000;

/**
 * Is the declared gate actually running?
 *
 * A PID IS NOT PROOF — pids are reused, and a wake fired at a recycled pid is worse than no wake.
 * Three facts must agree, and each covers a different way the pid alone lies:
 *   1. /proc/<pid> exists                  — something is alive there.
 *   2. its command line names `mutation.py` — it is the KIND of process that was declared; a pid
 *                                            recycled by an editor or a shell fails here.
 *   3. its start time is within tolerance of `launched_at` — it is THIS launch. A second gate that
 *                                            happened to inherit the pid, or a long-lived process
 *                                            that had it all along, fails here.
 *
 * Any of them unreadable means NOT identified, and therefore "exited". That direction is deliberate:
 * a missed suppression costs one spurious stall warning, while a false "running" suppresses the
 * alarm for ever and withholds the wake this block exists to deliver.
 */
export function gateStateOf(decl: GateDeclaration | null, now = Date.now()): GateState {
  if (!decl) return "none";
  const cmd = cmdlineOf(decl.pid);
  if (cmd === null) return "exited";                       // no /proc entry at all
  if (!/mutation\.py/.test(cmd)) return "exited";          // pid reused by something else
  const started = processStartMs(decl.pid);
  if (started === null) return "exited";                   // cannot identify => do not claim running
  const declared = Date.parse(decl.launchedAt);
  if (Math.abs(started - declared) > GATE_START_TOLERANCE_MS) return "exited";
  return started <= now + GATE_START_TOLERANCE_MS ? "running" : "exited";
}


/** The statuses the loom protocol defines. Anything else silently bypasses the notifier. */
export const KNOWN_STATUSES = ["idle", "working", "blocked"];
/** Statuses that mean the role is consuming the shared usage pool right now. */
export const WORKING_LIKE = ["working", "active", "running", "busy"];
/** updated_at allowed to lag the file this long before we call it unmaintained. */
export const DRIFT_HOURS = 6;

export interface StallFinding { role: string; status: string; staleHours: number; }
export interface ConformFinding { role: string; status: string; issue: string; }
/** WL-006: a role whose declared gate is alive (`gated`) or has finished (`gateExited`). Separate
 *  arrays, not a flag on `stalled`, because neither is a stall and both are positive evidence. */
export interface GateFinding {
  role: string; status: string; pid: number; log: string; launchedAt: string;
  mutants: number | null; staleHours: number;
}

export interface HealthReport {
  repo: string; stalled: StallFinding[]; nonConforming: ConformFinding[];
  gated: GateFinding[]; gateExited: GateFinding[];
}

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
  const out: HealthReport = { repo, stalled: [], nonConforming: [], gated: [], gateExited: [] };
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
    // WL-006 · A LIVE GATE IS NOT A STALL, and the suppression is RECORDED rather than silent: the
    // role moves to `gated`, so the report says "this one is working and here is the evidence"
    // instead of simply omitting it. Omitting would render `running` as `none`.
    const decl = readGate(s.obj);
    // A declaration whose block is ALREADY ANSWERED is spent, not a wake. `last_handled` is the
    // worker's own statement that it finished that block — so the leftover names a block that is
    // over, and reading it as "gate exited, response not yet written" is one state rendered as
    // another, the mistake this whole sequence keeps catching. A worker SHOULD also clear its `gate`
    // when it writes its response; this makes the tracker correct whether or not it does.
    const answered = !!(decl && decl.handoff && decl.handoff === String(s.obj.last_handled || ""));
    const gate = answered ? "none" : gateStateOf(decl, now);
    if (gate === "running" && decl) {
      out.gated.push({ role, status, pid: decl.pid, log: decl.log, launchedAt: decl.launchedAt,
                       mutants: decl.mutants, staleHours: (now - s.mtimeMs) / HOUR_MS });
    } else if (gate === "exited" && decl) {
      // Declared and finished, and the role has not spoken since. This is the wake, and it is NOT a
      // stall either — the worker is not stuck, it is asleep with an answer waiting.
      out.gateExited.push({ role, status, pid: decl.pid, log: decl.log, launchedAt: decl.launchedAt,
                            mutants: decl.mutants, staleHours: (now - s.mtimeMs) / HOUR_MS });
    } else if (isWorkingLike(status) && now - s.mtimeMs > stallMs) {
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
interface StallState {
  alerted: Record<string, { status: string; at: string }>;
  /** WL-006 · which GATE each role has already been woken for, keyed by the gate's own identity
   *  (`log@launched_at`) rather than by the role. On disk, so it survives a reload of the extension —
   *  a wake record kept in memory would fire again on every window restart. A NEW declaration is a
   *  new key, so the next gate wakes normally instead of being suppressed for ever by the last one. */
  gatesWoken?: Record<string, string>;
  updatedAt?: string;
}
function stallFile(repo: string): string { return path.join(LOOM_ROOT, repo, "stall-state.json"); }

function loadStall(repo: string): StallState {
  try {
    const st = JSON.parse(fs.readFileSync(stallFile(repo), "utf8"));
    if (st && st.alerted && typeof st.alerted === "object") {
      return { alerted: st.alerted,
               gatesWoken: st.gatesWoken && typeof st.gatesWoken === "object" ? st.gatesWoken : {} };
    }
  } catch { /* none yet */ }
  return { alerted: {}, gatesWoken: {} };
}
function saveStall(repo: string, st: StallState): void {
  try {
    const f = stallFile(repo);
    try {
      const cur = JSON.parse(fs.readFileSync(f, "utf8"));
      if (JSON.stringify(cur.alerted) === JSON.stringify(st.alerted)
          && JSON.stringify(cur.gatesWoken || {}) === JSON.stringify(st.gatesWoken || {})) return;
    } catch { /* write */ }
    fs.mkdirSync(path.dirname(f), { recursive: true });
    const tmp = f + ".tmp." + process.pid;
    fs.writeFileSync(tmp, JSON.stringify({ ...st, updatedAt: new Date().toISOString() }, null, 2));
    fs.renameSync(tmp, f);
  } catch { /* ignore */ }
}

export interface StallEvent { repo: string; role: string; status: string; staleHours: number; }

/** WL-006: a role whose declared gate has exited and which has not yet been woken for THAT gate. */
export interface GateEvent {
  repo: string; role: string; pid: number; log: string; mutants: number | null; key: string;
}

/** A gate's identity. The log path alone is not enough — a role reusing one path across runs would
 *  be woken only for the first — so the launch instant is part of it. */
export function gateKey(log: string, launchedAt: string): string {
  return `${log}@${launchedAt}`;
}

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

  /**
   * WL-006 · Roles whose declared gate has EXITED and which have not been woken for that gate.
   *
   * Returns the candidates; it does NOT record them as woken. `markWoken` is called by the caller
   * only once a wake was actually DELIVERED, because a worker mid-turn cannot be typed into and
   * marking it here would mean "woken" for a role that was never told — the same
   * asserted-is-not-reached shape that has cost this project five findings.
   */
  scanGates(report: HealthReport | null): GateEvent[] {
    if (!this.repo || !report) return [];
    const st = loadStall(this.repo);
    const woken = st.gatesWoken || {};
    const out: GateEvent[] = [];
    for (const g of report.gateExited) {
      const key = gateKey(g.log, g.launchedAt);
      if (woken[g.role] === key) continue;                  // already told this role about THIS gate
      out.push({ repo: this.repo, role: g.role, pid: g.pid, log: g.log, mutants: g.mutants, key });
    }
    return out;
  }

  /** Record a DELIVERED wake, so it is not repeated every tick. Persisted, so a reload does not
   *  re-wake every role whose gate finished before the window came back. */
  markWoken(role: string, key: string): void {
    if (!this.repo) return;
    const st = loadStall(this.repo);
    st.gatesWoken = { ...(st.gatesWoken || {}), [role]: key };
    saveStall(this.repo, st);
  }

  /** Wake the ROLE ITSELF — it is the session that can read the log and write the response. The
   *  orchestrator is not told: it did not launch the gate, and ringing it would make a person the
   *  transport again, which is the workaround this replaces. Not typed into a busy composer. */
  wake(ev: GateEvent, frame: { webviewId: string; busy: boolean } | null,
       done?: (ok: boolean, note: string) => void): void {
    if (!frame || frame.busy) { if (done) done(false, "composer busy or frame not found"); return; }
    const n = ev.mutants === null ? "" : ` (${ev.mutants} mutants)`;
    injectTo({ role: ev.role, webviewId: frame.webviewId, repo: ev.repo },
      `[loom-gate] Your background gate${n} has EXITED (pid ${ev.pid}). Read its log yourself — ` +
      `${ev.log} — and then finish the handoff: write your RESPONSE to outbox.md and set ` +
      `status.json (status, current, last_handled, the grade counts). Nothing else has read it, and ` +
      `until you do, your outbox still names the previous handoff.`,
      "gate-debug.json", done);
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
