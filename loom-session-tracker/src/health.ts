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
import { isOwnerRole } from "./naming";

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
export interface GateProbe {
  cmdline(pid: number): string | null;
  startedAt(pid: number): number | null;
}

/** The real /proc readers. Injectable ONLY so the unreadable-start case can be asserted: there is no
 *  way to make /proc/<pid>/stat unreadable while /proc/<pid>/cmdline is readable from a test, and a
 *  branch no test can reach is exactly where a wrong default hides — a mutant flipping that `exited`
 *  to `running` survived the whole suite, which suppresses the alarm for ever. The seam exists to
 *  make the default testable, not to vary it in production. */
export const REAL_GATE_PROBE: GateProbe = { cmdline: cmdlineOf, startedAt: processStartMs };

export function gateStateOf(decl: GateDeclaration | null, now = Date.now(),
                            probe: GateProbe = REAL_GATE_PROBE): GateState {
  if (!decl) return "none";
  const cmd = probe.cmdline(decl.pid);
  if (cmd === null) return "exited";                       // no /proc entry at all
  if (!/mutation\.py/.test(cmd)) return "exited";          // pid reused by something else
  const started = probe.startedAt(decl.pid);
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

/** WL-008 · a stall now SAYS WHICH KIND IT IS. `none`: the role never declared a gate — it simply
 *  stopped. `spent`: it declared one for a block it has since answered, so the declaration is over
 *  and the silence since is its own. These are different situations for whoever reads the alarm,
 *  and rendering both as the bare word "stalled" is one reading standing in for two. */
export interface StallFinding { role: string; status: string; staleHours: number;
                                gate?: "none" | "spent"; }
export interface ConformFinding { role: string; status: string; issue: string; }
/** WL-006: a role whose declared gate is alive (`gated`) or has finished (`gateExited`). Separate
 *  arrays, not a flag on `stalled`, because neither is a stall and both are positive evidence. */
export interface GateFinding {
  role: string; status: string; pid: number; log: string; launchedAt: string;
  mutants: number | null; staleHours: number;
}

// ── CL-001 · a worker session that was never cleared ─────────────────────────────────────────
//
// Playbook §12: a worker is cleared and re-bound between EVERY handoff, so each block starts from an
// empty transcript and the handoff file is the whole brief. Measured across every bus 2026-09-16:
// 18 of the 24 roles whose transcript could be read were carrying more than one block in one
// session — shwab_docker/trader held 22 blocks in 64.3 MB. It is not one orchestrator's habit, it
// is universal, and it is INVISIBLE: a worker holding twelve blocks answers exactly like a fresh one
// right up until it answers from a block it was never given. There is no symptom to notice. What
// there IS, on the bus the tracker already reads, is a pair of facts that cannot both be innocent:
//
//   A NEW HANDOFF ID APPEARING IN status.json WHILE board.json's session_id IS UNCHANGED
//   means that block was dispatched into a session that was never cleared.
//
// THE COUNT IS A FLOOR, NEVER A TOTAL. We can only count blocks that ARRIVE while we are watching.
// Whatever the status file already names when a session is first seen is the BASELINE — a bind, or
// the extension reloading mid-block, must not be read as evidence of anything. So the finding says
// "at least N, since <when>", and `since` is in the message.
//
// AND "I CANNOT TELL" IS ITS OWN STATE (WL-002's rule, third time it has bitten this product): a
// role with no status.json, or no session_id on the board, is NOT a role with zero blocks. It goes
// in `clearsUnknown` with the reason, and it is never counted, never scored, and never silently
// dropped into the clean pile.
export interface ClearSnapshot {
  role: string;
  /** From board.json. null when the board does not say — which is unknown, not "no session". */
  sessionId: string | null;
  /** Handoff ids this role's status.json names right now (`current`, then `last_handled`). */
  ids: string[];
  /** Why this role cannot be judged this tick, or null when it can. */
  unknown: string | null;
}

export interface HealthReport {
  repo: string; stalled: StallFinding[]; nonConforming: ConformFinding[];
  gated: GateFinding[]; gateExited: GateFinding[];
  /** CL-001 · one entry per role on the board, judgeable or not. */
  clears: ClearSnapshot[];
}

/** Handoff ids look like `WL-010` / `CL-001` / `DEV-217`. Anything else in `current` (a free-text
 *  note, a null, a leftover object) is not an id and is not counted — guessing would manufacture
 *  arrivals out of prose. */
const HANDOFF_ID = /^[A-Za-z][A-Za-z0-9]{0,7}-\d{1,4}$/;

export function handoffIds(obj: any): string[] {
  const out: string[] = [];
  for (const v of [obj && obj.current, obj && obj.last_handled]) {
    if (typeof v !== "string") continue;
    const id = v.trim();
    if (HANDOFF_ID.test(id) && !out.includes(id)) out.push(id);
  }
  return out;
}

/** The session id the board declares for a role — the thing a `/clear` changes. Both board shapes
 *  (flat, and wrapped in `roles`) are read, because both exist on the live buses. */
/**
 * PB-001 · The session id a role's OWN status.json claims, if it claims one.
 *
 * It exists to be compared with the board's, and the comparison is the fix for a detector that cried
 * wolf twice in one day. See `sessionAgreement` below.
 */
export function statusSessionId(obj: any): string | null {
  const sid = obj && typeof obj === "object" ? (obj.session_id || obj.sessionId) : null;
  return typeof sid === "string" && sid.trim() ? sid.trim() : null;
}

/**
 * PB-001 · DO THE IDENTITY RECORDS AGREE ABOUT WHICH SESSION THIS ROLE IS?
 *
 * MEASURED, twice on 2026-09-17, both false: the clear-detector told the orchestrator that
 * `developer2` "has now carried at least 2 handoff ids in ONE session (PB-001, PD-001) — nothing has
 * cleared it since 15:50:12Z", when that tab had DIED and been respawned as a brand-new session
 * minutes earlier. It did the same to `developer1` at 06:53Z.
 *
 * THE MECHANISM, and it is a race rather than a missing rule. A clear is detected by comparing the
 * board's `session_id` against the one remembered from last tick, and `scanClears` already
 * re-baselines correctly when that changes. But the board is written by TWO parties — the role
 * itself when it binds, and the tracker when it rebinds by session id — and playbook §12 requires
 * the inbox be rewritten BEFORE the new tab exists. So there is a window in which the NEW handoff id
 * is already visible while the board still names the DEAD session, and in that window the arrival is
 * judged against the wrong session and reads as a §12 violation. The trigger is met on every correct
 * respawn by construction, which is the worst possible property for a rule-enforcement message.
 *
 * THE FIX: session identity is the AND of the records that name it, not the board's alone. When the
 * role's own status.json names a session and it differs from the board's, a transition is in flight
 * — and a transition is precisely the clear this detector must not report against. That is not a
 * clean bill of health and it is not a violation either: it is UNKNOWN, which this module already
 * has a state for, and unknown is never counted and never re-baselined.
 *
 * A respawn is the strongest clear there is — the transcript is gone, not merely reset — so a
 * detector that reports one as a violation is not slightly wrong, it is inverted. And a reminder
 * that fires on correct behaviour trains its reader to ignore every reminder from the same tool,
 * which in a product whose whole job is keeping directives from falling through the cracks is not a
 * cosmetic defect but the defect itself.
 *
 * Absent is not disagreement: a status.json with no `session_id` (the protocol in playbook §2 does
 * not require one) leaves the board unchallenged and behaviour exactly as before.
 */
export function sessionAgreement(boardSid: string | null, statusSid: string | null):
    { agree: boolean; note: string | null } {
  if (!boardSid || !statusSid) return { agree: true, note: null };
  if (boardSid === statusSid) return { agree: true, note: null };
  return { agree: false,
           note: `identity records disagree (board ${boardSid.slice(0, 8)}…, status ` +
                 `${statusSid.slice(0, 8)}…) — a session transition is in flight` };
}

export function boardSessionId(repo: string, role: string): string | null {
  try {
    const data = JSON.parse(fs.readFileSync(path.join(LOOM_ROOT, repo, "board.json"), "utf8"));
    const roles = data && data.roles && typeof data.roles === "object" && !Array.isArray(data.roles)
      ? data.roles : data;
    const ent = roles && roles[role];
    const sid = ent && typeof ent === "object" ? ent.session_id : null;
    return typeof sid === "string" && sid.trim() ? sid.trim() : null;
  } catch { return null; }
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
/**
 * PB-001 · Is this role the bus's tagged orchestrator?
 *
 * WHY THE STALL CHECK SKIPS IT, and this is a correction rather than an exemption. The stall clock
 * is the mtime of a role's `status.json`, and that file is a WORKER's heartbeat: a worker is bound,
 * works a block, and keeps the file current because the orchestrator reads it to know where the
 * block stands. An orchestrator's entry is written when it binds and then largely left alone — its
 * `status` sits at "working" for days, which is true — so the stall clock on it measures nothing but
 * how long ago somebody last touched a file nobody is required to touch.
 *
 * MEASURED on this bus: the alarm fired at the orchestrator four times in one day, and its
 * instruction ("check whether it is stuck, blocked, or finished without saying so" — with the reply
 * hint "ring the role named here") named the orchestrator itself. Ringing yourself is the one action
 * that cannot help, so this was a diagnosis that was wrong and a prescription that was empty.
 *
 * Nothing is lost by the skip: an orchestrator's liveness is observed DIRECTLY from its frame every
 * tick (`OwnerView.busy`, `liveness`), which is a live signal rather than a file's age, and PB-001's
 * delegation detector is built on exactly that. An untagged bus has no orchestrator to skip and
 * every role is checked as before.
 */
export function isTaggedOrchestrator(repo: string, role: string): boolean {
  const tag = getOrchestrator(repo);
  return !!(tag && tag.role && tag.role === role) || isOwnerRole(role);
}

export function checkHealth(repo: string | null,
                            opts: { now?: number; stallMinutes?: number } = {}): HealthReport | null {
  if (!repo) return null;
  const now = opts.now ?? Date.now();
  const stallMs = (opts.stallMinutes ?? 45) * 60_000;
  const out: HealthReport = { repo, stalled: [], nonConforming: [], gated: [], gateExited: [],
                              clears: [] };
  for (const role of boardRoles(repo)) {
    const s = readStatus(repo, role);
    // CL-001 · THE SNAPSHOT IS TAKEN BEFORE THE `continue`. A role whose status.json is missing or
    // unparseable is exactly the role most likely to be mid-something, and dropping it here is how
    // it would have silently joined the roles with nothing to report.
    const sessionId = boardSessionId(repo, role);
    if (!s) {
      out.clears.push({ role, sessionId, ids: [],
                        unknown: "no readable status.json — cannot tell which block it is on" });
    } else {
      const ids = handoffIds(s.obj);
      // PB-001 · the board's word is checked against the role's own before anything is judged.
      const agree = sessionAgreement(sessionId, statusSessionId(s.obj));
      out.clears.push({
        role, sessionId, ids,
        unknown: !sessionId ? "board.json declares no session_id for this role — a clear is undetectable"
               : !agree.agree ? agree.note
               : ids.length === 0 ? "status.json names no handoff id (no `current`, no `last_handled`)"
               : null,
      });
    }
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
    } else if (isWorkingLike(status) && now - s.mtimeMs > stallMs && !isTaggedOrchestrator(repo, role)) {
      // THE THIRD STATE, named rather than folded in. WL-006's wake fires on a gate that EXITED;
      // a role that never launched one is a different thing and was previously indistinguishable.
      // It is NOT auto-woken, and that is a decision, not an omission: a finished gate is PROOF
      // that an answer is waiting, which is what justifies typing into a worker unasked. A silent
      // role with no gate carries no such proof — it may be waiting on a human, blocked, or simply
      // done badly — so nudging it would be a guess dressed as a measurement, which is the one
      // move this whole sequence exists to refuse. It is reported, with which kind it is.
      out.stalled.push({ role, status, staleHours: (now - s.mtimeMs) / HOUR_MS,
                         gate: answered && decl ? "spent" : "none" });
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
  /** WL-008 · A WAKE THAT WAS ATTEMPTED AND REFUSED, per role, with the gate it was for.
   *
   *  `gatesWoken` records only DELIVERY, which is right — marking on attempt would mean "woken" for
   *  a role never told. But delivery-only plus a guard that could never pass meant the wake was
   *  retried every 15 seconds for 36 minutes and NOTHING ever said so: the state file looked
   *  untouched, which reads identically to "no gate ever finished". The refusals were real events
   *  and they were the only evidence, so they are now kept. */
  gatesPending?: Record<string, { key: string; since: string; attempts: number; note: string }>;
  /** CL-001 · what each role's CURRENT session has been seen to carry.
   *
   *  `session` is the id from board.json at the moment we started watching this session; a different
   *  one means a `/clear` happened and everything starts over — which is the whole point, and is
   *  what makes the guard's negative case observable rather than argued.
   *
   *  `ids` is the BASELINE (what the status file already named when the session was first seen) and
   *  `reported` is what has since ARRIVED and been delivered. They are kept apart on purpose: only
   *  arrivals are evidence, and only delivery may retire an arrival — an arrival marked here on
   *  ATTEMPT would read as "the orchestrator was told" for a message nobody ever received, which is
   *  the asserted-is-not-reached shape that has cost this project six findings. */
  /**  `seen` is every arrival OBSERVED under this session, delivered or not. It exists because
   *  `reported` alone could not carry the boundary: an arrival raised on a tick where the composer
   *  was busy is in neither list, so a `/clear` arriving before it was ever delivered seeded the new
   *  session's baseline with it — and the next reminder named a block from the session that had just
   *  been cleared. Found by running the compiled code against a copy of the live bus, NOT by the
   *  unit tests, which had delivered every arrival they raised. */
  clears?: Record<string, { session: string; ids: string[]; since: string; reported: string[];
                            seen?: string[]; dropped?: string[] }>;
  updatedAt?: string;
}
function stallFile(repo: string): string { return path.join(LOOM_ROOT, repo, "stall-state.json"); }

function loadStall(repo: string): StallState {
  try {
    const st = JSON.parse(fs.readFileSync(stallFile(repo), "utf8"));
    if (st && st.alerted && typeof st.alerted === "object") {
      return { alerted: st.alerted,
               gatesWoken: st.gatesWoken && typeof st.gatesWoken === "object" ? st.gatesWoken : {},
               gatesPending: st.gatesPending && typeof st.gatesPending === "object" ? st.gatesPending : {},
               clears: st.clears && typeof st.clears === "object" ? st.clears : {} };
    }
  } catch { /* none yet */ }
  return { alerted: {}, gatesWoken: {}, gatesPending: {}, clears: {} };
}
function saveStall(repo: string, st: StallState): void {
  try {
    const f = stallFile(repo);
    try {
      const cur = JSON.parse(fs.readFileSync(f, "utf8"));
      if (JSON.stringify(cur.alerted) === JSON.stringify(st.alerted)
          && JSON.stringify(cur.gatesWoken || {}) === JSON.stringify(st.gatesWoken || {})
          && JSON.stringify(cur.gatesPending || {}) === JSON.stringify(st.gatesPending || {})
          // CL-001 · the clear baseline MUST be part of the change test. Left out, a tick that
          // changed only `clears` would take this early return, nothing would reach disk, and every
          // arrival would be rediscovered and re-sent on the next tick for ever — the same message
          // every 15 seconds, which is how a reminder becomes a thing people turn off.
          && JSON.stringify(cur.clears || {}) === JSON.stringify(st.clears || {})) return;
    } catch { /* write */ }
    fs.mkdirSync(path.dirname(f), { recursive: true });
    const tmp = f + ".tmp." + process.pid;
    fs.writeFileSync(tmp, JSON.stringify({ ...st, updatedAt: new Date().toISOString() }, null, 2));
    fs.renameSync(tmp, f);
  } catch { /* ignore */ }
}

export interface StallEvent { repo: string; role: string; status: string; staleHours: number;
                              gate?: "none" | "spent"; }

/** WL-006: a role whose declared gate has exited and which has not yet been woken for THAT gate. */
/** WL-008 · a wake that keeps being refused. Reported, because silence looked like success. */
export interface WakePending {
  role: string; key: string; since: string; attempts: number; note: string; pendingMinutes: number;
}

export interface GateEvent {
  repo: string; role: string; pid: number; log: string; mutants: number | null; key: string;
}

/** CL-001 · one block dispatched into a session that was never cleared. `blocks` and `ids` are a
 *  FLOOR measured since `since` — never a total, because nothing can see what a session carried
 *  before the tracker started watching it. */
export interface ClearEvent {
  repo: string; role: string; sessionId: string; newId: string;
  blocks: number; ids: string[]; since: string;
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
      events.push({ repo: this.repo, role: s.role, status: s.status, staleHours: s.staleHours,
                    gate: s.gate });
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
    const pend = { ...(st.gatesPending || {}) };
    delete pend[role];                      // delivered: it is no longer waiting on anything
    st.gatesPending = pend;
    saveStall(this.repo, st);
  }

  /**
   * WL-008 · Record a wake that was ATTEMPTED and REFUSED, with the reason.
   *
   * NOT a retry ceiling, and the field evidence argues against one. A ceiling would have stopped
   * trying after N attempts and said nothing — the role would still be asleep and the failure would
   * now also be invisible, which is strictly worse than the loop that at least kept a live attempt
   * going. What was actually missing was not restraint, it was NOTICING: the wake was refused ~140
   * times in 36 minutes and no file, message or figure changed. So retrying stays, and the refusal
   * becomes a fact on disk with a first-attempt instant, so "pending too long" can be SEEN.
   */
  recordWakeRefused(role: string, key: string, note: string, now = Date.now()): void {
    if (!this.repo) return;
    const st = loadStall(this.repo);
    const pend = { ...(st.gatesPending || {}) };
    const prev = pend[role];
    // A NEW gate restarts the clock: the age that matters is how long THIS wake has been pending.
    pend[role] = prev && prev.key === key
      ? { ...prev, attempts: prev.attempts + 1, note }
      : { key, since: new Date(now).toISOString(), attempts: 1, note };
    st.gatesPending = pend;
    saveStall(this.repo, st);
  }

  /** Wakes that have been refused continuously for longer than `ms` — a mechanism failing silently
   *  is the one thing this whole sequence exists to make impossible. */
  pendingBeyond(ms: number, now = Date.now()): WakePending[] {
    if (!this.repo) return [];
    const st = loadStall(this.repo);
    const out: WakePending[] = [];
    for (const [role, p] of Object.entries(st.gatesPending || {})) {
      const since = Date.parse(p.since);
      if (!Number.isFinite(since) || now - since < ms) continue;
      out.push({ role, key: p.key, since: p.since, attempts: p.attempts, note: p.note,
                 pendingMinutes: (now - since) / 60_000 });
    }
    return out;
  }

  /** Wake the ROLE ITSELF — it is the session that can read the log and write the response. The
   *  orchestrator is not told: it did not launch the gate, and ringing it would make a person the
   *  transport again, which is the workaround this replaces. Not typed into a busy composer. */
  wake(ev: GateEvent, frame: { webviewId: string; busy: boolean } | null,
       done?: (ok: boolean, note: string) => void): void {
    // WL-008 · TWO STATES, TWO SENTENCES. These wore one note — "composer busy or frame not found" —
    // and that is the reading-rendered-as-another-reading defect this sequence keeps finding, sitting
    // in the diagnostic itself. They are not the same event and they do not have the same fix: a busy
    // composer is TRANSIENT and the next tick retries; no live frame means the role's tab is gone or
    // unattributed, and retrying will not help until that changes. When the wake was silently failing
    // in the field, this single note is what made it impossible to tell which was happening.
    if (!frame) { if (done) done(false, "no live frame for this role — its tab is gone or unattributed"); return; }
    if (frame.busy) { if (done) done(false, "composer busy (mid-turn) — not typed into; retrying next tick"); return; }
    const n = ev.mutants === null ? "" : ` (${ev.mutants} mutants)`;
    injectTo({ role: ev.role, webviewId: frame.webviewId, repo: ev.repo },
      `[loom-gate] Your background gate${n} has EXITED (pid ${ev.pid}). Read its log yourself — ` +
      `${ev.log} — and then finish the handoff: write your RESPONSE to outbox.md and set ` +
      `status.json (status, current, last_handled, the grade counts). Nothing else has read it, and ` +
      `until you do, your outbox still names the previous handoff.`,
      "gate-debug.json", done);
  }

  /**
   * CL-001 · Blocks that arrived in a session that was never cleared.
   *
   * The rule, and it is the whole mechanism: a handoff id that appears in a role's status.json while
   * its board session_id is UNCHANGED was dispatched without a `/clear`. A changed session id is a
   * clear, and resets everything — so the guard's negative case is not an argument, it is the same
   * code path with one field different, which is what makes it observable in the field.
   *
   * This does NOT record the arrival as reported; `markClearReported` does, and only on delivery.
   * An unreported arrival is therefore raised again every tick until it is actually delivered, which
   * is deliberate: the orchestrator's composer is busy for most of any given tick, and a reminder
   * dropped because nobody was listening is a reminder that never happened (WL-006 / WL-008).
   */
  scanClears(report: HealthReport | null, now = Date.now()): ClearEvent[] {
    if (!this.repo || !report) return [];
    const st = loadStall(this.repo);
    const cl = { ...(st.clears || {}) };
    const events: ClearEvent[] = [];
    for (const snap of report.clears) {
      // Unknown is never counted and never reset. A role we cannot read this tick keeps whatever
      // baseline it had: forgetting it would silently re-baseline the session on the next readable
      // tick, and an unreadable status file would become a way to erase the evidence.
      if (snap.unknown || !snap.sessionId) continue;
      const prev = cl[snap.role];
      if (!prev || prev.session !== snap.sessionId) {
        // A NEW SESSION — a first sighting, or a `/clear` and re-bind. Everything the status file
        // already names is the baseline and is NOT evidence: on a re-bind `last_handled` still names
        // the block that was just finished, and counting it would report a violation on the exact
        // dispatch that did the right thing.
        //
        // AND THE BASELINE DROPS WHAT BELONGED TO THE OLD SESSION. `last_handled` survives a clear —
        // the worker rewrites its status file, it does not start one — so seeding the new session
        // with it would carry a finished block across the boundary and name it in a later reminder.
        // Caught by its own test, not by reading: a reminder after one clear read "at least 3
        // handoff ids in ONE session (CL-002, CL-001, CL-003)" when that session had carried two.
        // Only ids we already knew under the OLD session can be dropped — on a FIRST sighting there
        // is nothing to compare against, so everything present is the baseline and the count is a
        // floor, which is exactly why the message says "at least".
        //
        // CL-002 · AND WHAT IS DROPPED IS REMEMBERED AS DROPPED. Subtracting the old session's ids
        // from the baseline without recording them puts them back in play: they are still sitting in
        // `last_handled`, they are in neither `ids` nor `reported`, so on the VERY NEXT tick they
        // read as fresh arrivals and are counted and named against the new session. Measured, not
        // reasoned — the §12 sequence produced `blocks: 2, ids: ["B-2", "B-1"]` where B-1 belonged
        // to the session that had just been cleared, which is precisely the defect the line above
        // exists to prevent, alive again one tick later through the same subtraction.
        const carried = prev
          ? [...prev.ids, ...(prev.reported || []), ...(prev.seen || []), ...(prev.dropped || [])] : [];
        const dropped = snap.ids.filter((i) => carried.includes(i));
        cl[snap.role] = { session: snap.sessionId, ids: snap.ids.filter((i) => !dropped.includes(i)),
                          since: new Date(now).toISOString(), reported: [], seen: [], dropped };
        continue;
      }
      const known = [...prev.ids, ...(prev.reported || [])];
      // An id this session INHERITED in its status file is not an arrival into it and never becomes
      // one, however long it sits there. It is not in `known` either: it is not this session's block
      // and must not be counted toward its floor.
      const arrived = snap.ids.filter((i) => !known.includes(i) && !(prev.dropped || []).includes(i));
      // EVERY arrival is remembered as SEEN, even the ones nobody could be told about yet. Only
      // `reported` retires an event, so an undelivered arrival is still raised again next tick —
      // but it no longer crosses a `/clear` boundary and get counted against the new session.
      if (arrived.length) {
        cl[snap.role] = { ...prev, seen: [...new Set([...(prev.seen || []), ...arrived])] };
      }
      // CL-002 · §12 IS VIOLATED BY A SECOND BLOCK, SO ONE IS NOT A FINDING.
      //
      // The floor, not the arrival, is what decides. A session known to hold ONE block is a worker
      // doing exactly what it should, and the §12 dispatch produces that state BY CONSTRUCTION: the
      // orchestrator resets the status file in the same breath as the `/clear`, the baseline drops
      // what belonged to the old session, and the first real block then lands on an empty one. So
      // the detector fired at every correctly-dispatched fresh session — at the dispatch that did
      // the right thing, seconds after it did it.
      //
      // AND THE GUARD GOES HERE, AT THE PUSH, NOT IN `arrived`. Suppressing it earlier would keep it
      // out of `seen`, and `seen` is the only thing that stops an unreported arrival being seeded
      // into the NEXT session's baseline and named in a later reminder. Silence is the requirement;
      // forgetting is not, and forgetting here would cost the fix above. So the arrival is recorded
      // in full, and only the TELLING is withheld until there is something to tell.
      //
      // The floor is untouched: `blocks` still counts what is KNOWN since `since`, the message still
      // says "at least", and a session first sighted already holding one block still reports 2 on the
      // next — a first sighting cannot know what came before it, and that is why the word is there.
      if (known.length + arrived.length < 2) continue;
      for (const id of arrived) {
        events.push({ repo: this.repo, role: snap.role, sessionId: snap.sessionId, newId: id,
                      // A FLOOR, not a total: only blocks seen to arrive since `since` are here.
                      blocks: known.length + arrived.length, ids: [...known, ...arrived],
                      since: prev.since });
      }
    }
    st.clears = cl;
    saveStall(this.repo, st);
    return events;
  }

  /** Record a DELIVERED clear reminder, so the same block is not raised again next tick. */
  markClearReported(role: string, id: string): void {
    if (!this.repo) return;
    const st = loadStall(this.repo);
    const cl = { ...(st.clears || {}) };
    const prev = cl[role];
    if (!prev) return;                       // never seen a session for this role: nothing to retire
    if ((prev.reported || []).includes(id) || prev.ids.includes(id)) return;
    cl[role] = { ...prev, reported: [...(prev.reported || []), id] };
    st.clears = cl;
    saveStall(this.repo, st);
  }

  /**
   * The sentence an orchestrator actually reads. It is a TRIGGER, not a verdict.
   *
   * What it deliberately is NOT, because the owner was explicit about what these messages are for
   * ("a reminder… for them if they ever get sidetracked"): not a gate, not a score, not a percentage
   * of anyone's conduct, and above all not anything that reads as permission to stop working. It
   * names the role, the floor count with the window it was measured over, and the ONE action —
   * clear and re-bind at the next dispatch. Nothing here needs undoing and the sentence says so,
   * because an orchestrator that reads this as a fault will go back and re-do finished work.
   */
  clearReminder(ev: ClearEvent): string {
    return `[loom-clears] ${ev.role} has now carried at least ${ev.blocks} handoff ids in ONE session ` +
      `(${ev.ids.join(", ")}) — nothing has cleared it since ${ev.since}. ` +
      `Playbook §12: a worker is cleared and re-bound between every handoff, so each block starts ` +
      `from an empty transcript and the handoff file is the whole brief. A worker holding several ` +
      `blocks answers exactly like a fresh one until it answers from a block it was never given, and ` +
      `it re-reads that whole transcript every turn. Nothing is blocked and nothing needs undoing — ` +
      `clear ${ev.role} and re-bind it on your NEXT dispatch to it.`;
  }

  /** Deliver it to the ORCHESTRATOR — it is the one that dispatches, so it is the only one that can
   *  act on it. Addressed through the tag's frame id, like every other message to the orchestrator. */
  remindClears(ev: ClearEvent, orchestratorRole: string,
               done?: (ok: boolean, note: string) => void): void {
    const tag = getOrchestrator(ev.repo);
    injectTo({ role: orchestratorRole, webviewId: tag ? tag.webviewId : null, repo: ev.repo },
             this.clearReminder(ev), "clear-debug.json", done);
  }

  /** Tell the orchestrator a worker appears stuck. Fire-and-forget, like the other injectors, and
   *  addressed by the tag's frame id for the same reason (see inject.ts). */
  alert(ev: StallEvent, orchestratorRole: string, done?: (ok: boolean, note: string) => void): void {
    const why = ev.gate === "spent"
      ? " Its gate declaration is for a block it has already answered, so nothing is running."
      : ev.gate === "none" ? " It never declared a gate, so nothing was suppressing this." : "";
    const msg = `[loom-stall] ${ev.role} has been "${ev.status}" with no status update for ` +
      `${ev.staleHours.toFixed(1)}h.${why} Check whether it is stuck, blocked, or finished without saying so.`;
    const tag = getOrchestrator(ev.repo);
    injectTo({ role: orchestratorRole, webviewId: tag ? tag.webviewId : null, repo: ev.repo },
             msg, "stall-debug.json", done);
  }
}
