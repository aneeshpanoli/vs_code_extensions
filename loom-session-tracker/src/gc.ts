// gc.ts — ONE JOB: collect the garbage that accumulates ACROSS projects, where no single window is
// looking. Read-only planning is separated from acting, so the policy is a pure function the tests
// can assert against a fixture world and the applier is dumb I/O.
//
// WHY, measured 2026-09-13 on this machine:
//   * 34 deployed extension versions, 99 MB, exactly ONE registered — but NINE windows were still
//     RUNNING 0.29.0, a version `extensions.json` no longer names. Archiving what the registry calls
//     superseded would have pulled the code out from under nine live editors.
//   * 2.4 GB of transcripts; 931 files untouched for 14 days.
//   * funisland has 75 worktrees, 72 belonging to no board role (4.7 GB); Gaming 13 of 8.
//   * boards name dead sessions: Gaming 5 of 6, lowercase `gaming` 10 of 10, shwab_docker 1.
//   * 1.4 GB of checkpoints; 19 `.bak-<epoch>` files.
// The bytes are not the point: orphan worktrees and dead buses feed straight back into an
// orchestrator's context (one `git worktree list` of funisland fills a panel), and a dead transcript
// is a WRONG-LOOKUP hazard — Lumen's orchestrator was banked, cleared and restored fourteen times in
// one night against a stale transcript copy in Gaming's directory (see context.ts `transcriptFor`).
// Garbage here is not waste, it is misinformation.
//
// THE ONE RULE THIS FILE OBEYS: every action has a written way back, in `gc-debug.json`. Almost
// every action is a MOVE into `~/.claude/loom/_archive/<date>/` or a field added to a board entry,
// and those are reversible by copying the file back.
//
// ONE PATH IS NOT, and saying "nothing is ever deleted" hid it for two versions: tier 2's
// `kind: "worktree"` calls `health.removeWorktree`, which runs `git worktree remove` — the BRANCH
// and its commits survive (restore command recorded in `worktree-removals.json`), but the working
// DIRECTORY is gone, and with it anything git was never told about. So a worktree is only ever
// CONSIDERED once the roster has let it past: the roster is the WIDEST rule here — it counts a role
// at ANY age, and `planWorktrees` skips a rostered worktree before any refusal is weighed. What
// survives that is then refused on ALL SEVEN of: dirty trees, a live session, detached HEADs,
// gitignored files git cannot restore, unmerged branches, a merge state that could not be
// determined, and near-miss role names. Over-keeping a worktree costs a directory listing, and the
// mistake in the other direction cannot be undone.
//
// THE SECOND RULE: a plan is a guess about a moment that has passed. Every safeguard in the planner
// is CHECKED AGAIN in the applier against the world as it is when the move happens — a session can
// go live, a tree can go dirty, and a board entry can be rewritten between the two.
//
// fs-only — no `vscode` import — so the planner runs under the test harness and under live.sh.

import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { execFileSync } from "child_process";
import { boardRoles, busRepos, busDeclaredFrames, rivalDeclarers } from "./registry";
import { transcriptFor } from "./context";
import { isOwnerRole, canonicalRole } from "./naming";
import { scanWorktrees, removeWorktree, WorktreeFinding } from "./health";

const HOME = () => os.homedir();
const LOOM_ROOT = () => path.join(HOME(), ".claude", "loom");
const PROJECTS_ROOT = () => path.join(HOME(), ".claude", "projects");
const EXTENSIONS_ROOT = () => path.join(HOME(), ".vscode-oss", "extensions");
const CHECKPOINTS_ROOT = () => path.join(HOME(), ".claude", "checkpoints");
const ARCHIVE_ROOT = () => path.join(LOOM_ROOT(), "_archive");
const GC_STATE = () => path.join(LOOM_ROOT(), "gc-state.json");
const GC_DEBUG = () => path.join(LOOM_ROOT(), "gc-debug.json");
const RUNNING_VERSIONS = () => path.join(LOOM_ROOT(), "running-versions.json");

const DAY_MS = 86_400_000;
const HOUR_MS = 3_600_000;
/** The deployed-extension directory name this repo produces (deploy.sh: `<publisher>.<name>-<version>`). */
const EXT_PREFIX = "local.loom-session-tracker-";
/** Directory names under the loom root that are never a project bus. */
const NON_BUS_DIRS = new Set(["_archive", "node_modules", "tools", "__pycache__"]);

// ── configuration ───────────────────────────────────────────────────────────────────────────

export interface GcConfig {
  enabled: boolean;
  intervalHours: number;
  transcriptDays: number;
  backupDays: number;
  /** Reused from the digest's existing setting — a bus untouched this long is a tier-3 question. */
  staleBusDays: number;
}

// Default OFF for 0.33.0 (product decision, 2026-09-13): the first pass on this machine would move
// ~700 MB unattended, so a person runs "Show plan" then "Run tiers 1+2" once and WE FLIP the default
// after one clean pass — an outstanding commitment, not a description; `enabled` is still false.
// Everything is reversible either way.
export const DEFAULT_GC_CONFIG: GcConfig = {
  enabled: false, intervalHours: 24, transcriptDays: 14, backupDays: 7, staleBusDays: 30,
};

// ── the plan ────────────────────────────────────────────────────────────────────────────────

export type GcKind =
  | "extension"        // a deployed build no window is running and the editor has not registered
  | "transcript"       // an old .jsonl nothing anywhere references
  | "backup"           // a *.bak-<epoch> under the loom root
  | "worktree"         // an orphaned, clean, merged worktree
  | "boardEntry"       // a board entry whose session_id has no transcript anywhere
  | "staleBus"         // a whole bus nobody has touched
  | "busFrameMismatch" // an owner id file pointing at another bus's frame
  | "riskyWorktree"    // orphaned but unmerged, dirty, live, or a near-miss of a real role name
  | "checkpoints";     // reported by size only; no policy yet

export interface GcItem {
  tier: 1 | 2 | 3;
  kind: GcKind;
  /** What the digest shows. */
  label: string;
  detail: string;
  bytes: number;
  /** Source path, for the kinds that move something. */
  src?: string;
  /** Where it would go. Absent for the kinds that do not move anything. */
  dest?: string;
  repo?: string;
  role?: string;
  /** The session id this item is about, so the applier can re-check it against the live roster. */
  sessionId?: string;
}

export interface GcPlan {
  /** UTC date stamp; the archive directory for this run. */
  date: string;
  tier1: GcItem[];
  tier2: GcItem[];
  tier3: GcItem[];
  /** Anything the planner could not read, or refused wholesale. Reported, never thrown. */
  notes: string[];
}

export interface GcInput {
  now: number;
  cfg: GcConfig;
  /** THIS window's build version. Must be a semver, or the extension tier is refused entirely. */
  currentVersion: string;
  /** `${repo}/${role}` for every role with a LIVE tab. A live role's worktree, board entry and
   *  transcript are all untouchable. */
  liveRoles: Set<string>;
  /** repo id → checkout root. Only repos listed here have their worktrees considered at all. */
  repoRoots: Record<string, string>;
}

// ── small, no-throw helpers ─────────────────────────────────────────────────────────────────

function statOf(p: string): fs.Stats | null {
  try { return fs.statSync(p); } catch { return null; }
}
/** Does anything at all sit at this path — including a DANGLING SYMLINK, which statSync calls absent. */
function existsAny(p: string): boolean {
  try { fs.lstatSync(p); return true; } catch { return false; }
}
function readdir(p: string): string[] {
  try { return fs.readdirSync(p); } catch { return []; }
}
function readJson(p: string): any {
  try { return JSON.parse(fs.readFileSync(p, "utf8")); } catch { return null; }
}
/** The role container of a board, nested (`{roles:{…}}`) or flat. */
function boardRolesObject(repo: string): any {
  const d = readJson(path.join(LOOM_ROOT(), repo, "board.json"));
  if (!d || typeof d !== "object") return null;
  return (d.roles && typeof d.roles === "object" && !Array.isArray(d.roles)) ? d.roles : d;
}

export interface Measured { bytes: number; truncated: boolean }

/**
 * Recursive byte total, bounded so a pathological tree cannot hang a tick. `truncated` says the
 * budget ran out — which makes the number a LOWER BOUND, and the copy-verify below treats a lower
 * bound as "unknown" rather than as agreement.
 */
export function measure(p: string, budget = 20000): Measured {
  let bytes = 0;
  let truncated = false;
  const walk = (d: string) => {
    for (const e of readdir(d)) {
      if (budget-- <= 0) { truncated = true; return; }
      const f = path.join(d, e);
      let st: fs.Stats;
      try { st = fs.lstatSync(f); } catch { continue; }
      if (st.isDirectory()) walk(f);
      else bytes += st.size;
    }
  };
  let st: fs.Stats | null;
  try { st = fs.lstatSync(p); } catch { return { bytes: 0, truncated: false }; }
  if (!st.isDirectory()) return { bytes: st.size, truncated: false };
  walk(p);
  return { bytes, truncated };
}

export function dirBytes(p: string, budget = 20000): number { return measure(p, budget).bytes; }

/** UTC `YYYY-MM-DD` — deterministic, so a test can assert the archive path. */
export function gcDate(now: number): string {
  return new Date(now).toISOString().slice(0, 10);
}

function archiveDir(now: number, ...rest: string[]): string {
  return path.join(ARCHIVE_ROOT(), gcDate(now), ...rest);
}

function git(cwd: string, args: string[], timeout = 5000): string | null {
  try {
    return execFileSync("git", ["-C", cwd, ...args],
      { encoding: "utf8", timeout, stdio: ["ignore", "pipe", "pipe"] }).trim();
  } catch { return null; }
}

/** The repo's default branch — the thing a worktree branch must already be inside to be collectable. */
function defaultBranch(repoRoot: string): string | null {
  const head = git(repoRoot, ["symbolic-ref", "--short", "refs/remotes/origin/HEAD"]);
  if (head) return head.replace(/^origin\//, "");
  for (const b of ["main", "master"]) if (git(repoRoot, ["rev-parse", "--verify", "--quiet", b])) return b;
  return null;
}

/**
 * Is `branch` fully contained in the default branch? `null` when that cannot be established — which
 * is treated as NOT merged everywhere below, because the cost of the two answers is not symmetric:
 * a wrongly-kept worktree costs disk, a wrongly-removed one costs commits.
 */
export function isMerged(repoRoot: string, branch: string | null): boolean | null {
  if (!branch) return null;
  const base = defaultBranch(repoRoot);
  if (!base) return null;
  try {
    execFileSync("git", ["-C", repoRoot, "merge-base", "--is-ancestor", branch, base],
      { timeout: 5000, stdio: ["ignore", "ignore", "ignore"] });
    return true;
  } catch { return false; }   // non-zero exit = not an ancestor; a missing git also lands here
}

/** Levenshtein distance, capped — only used to spot a role name someone mistyped. */
export function editDistance(a: string, b: string): number {
  if (a === b) return 0;
  if (Math.abs(a.length - b.length) > 3) return 99;
  let prev = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    for (let j = 1; j <= b.length; j++) {
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
    prev = cur;
  }
  return prev[b.length];
}

// ── which buses exist, and what they reference ──────────────────────────────────────────────

/**
 * EVERY project directory under the loom root, not only the ones with a `board.json`. `busRepos()`
 * requires a board, and measured 2026-09-13 four buses have none — AgAI, Personality, growth-chamber,
 * aneeshpanoli.com — while holding a `context-state.json` that names a live session. Collecting a
 * transcript those buses point at is exactly the wrong-lookup hazard this file exists to reduce.
 */
export function loomDirs(): string[] {
  return readdir(LOOM_ROOT())
    .filter((n) => !n.startsWith(".") && !NON_BUS_DIRS.has(n))
    .filter((n) => !!statOf(path.join(LOOM_ROOT(), n))?.isDirectory())
    .sort();
}

/** A session id as Claude Code writes it: 36 characters of UUID. */
const SESSION_ID_RE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi;
/** Bounds on the universal sweep, so a huge bus cannot stall a tick. */
// 8 MB: a banked handover or a fat board is routinely over 2 MB, and skipping one silently was
// how a referenced session id went missing from the sweep.
const SCAN_MAX_FILE_BYTES = 8_000_000;
const SCAN_MAX_FILES = 4000;
const SCAN_MAX_DEPTH = 4;

/**
 * Every session id ANYTHING under the loom root still points at. FOUR explicit readers, then one
 * universal sweep, because the explicit list has been wrong twice already — the sweep is what makes
 * a third omission survivable:
 *   * board entries (`roles` wrapper or flat);
 *   * each project's `context-state.json`;
 *   * each role's `<repo>/<role>/status.json` — a worker writes its own id there;
 *   * `<repo>/open-requests.json`'s `opened[].sessionId` — what the orchestrator just had opened;
 * then the sweep: ANY 36-character session id appearing in ANY `*.json` / `*.md` under the loom root.
 * Measured 2026-09-13: eight live ids were referenced ONLY in a status.json or an open-requests
 * result. A transcript named anywhere here is live bookkeeping whatever its age — archiving it turns
 * a stale-but-findable id into an unfindable one, which is strictly worse than keeping a file.
 * Our OWN log is excluded: `gc-debug.json` records what we archived, and letting that count as a
 * reference would make the collector protect its own leavings forever.
 */
export interface ReferenceSweep {
  ids: Set<string>;
  /** True when the sweep gave up early — its `ids` are then a LOWER BOUND, not an answer. */
  truncated: boolean;
}

export function referencedSessions(): ReferenceSweep {
  const out = new Set<string>();
  let truncated = false;
  // Session ids are written in both cases across the buses; compare in one.
  const add = (v: any) => { if (typeof v === "string" && v) out.add(v.toLowerCase()); };

  for (const repo of loomDirs()) {
    const src = boardRolesObject(repo);
    if (src && typeof src === "object") {
      for (const v of Object.values<any>(src)) {
        if (v && typeof v === "object") { add(v.session_id); add(v.sessionId); }
      }
    }
    const ctx = readJson(path.join(LOOM_ROOT(), repo, "context-state.json"));
    if (ctx && typeof ctx === "object") { add(ctx.sessionId); add(ctx.session_id); }

    const req = readJson(path.join(LOOM_ROOT(), repo, "open-requests.json"));
    if (req && Array.isArray(req.opened)) {
      for (const o of req.opened) if (o && typeof o === "object") { add(o.sessionId); add(o.session_id); }
    }
    for (const name of readdir(path.join(LOOM_ROOT(), repo))) {
      const st = readJson(path.join(LOOM_ROOT(), repo, name, "status.json"));
      if (st && typeof st === "object") { add(st.session_id); add(st.sessionId); }
    }
  }

  // the universal sweep
  let budget = SCAN_MAX_FILES;
  const sweep = (dir: string, depth: number) => {
    for (const name of readdir(dir)) {
      if (budget <= 0) { truncated = true; return; }
      if (NON_BUS_DIRS.has(name) || name === "gc-debug.json") continue;
      const p = path.join(dir, name);
      const st = statOf(p);
      if (!st) continue;
      if (st.isDirectory()) {
        if (depth > 0) sweep(p, depth - 1);
        else truncated = true;              // there was more below than we agreed to look at
        continue;
      }
      if (!/\.(json|md)$/i.test(name)) continue;
      if (st.size > SCAN_MAX_FILE_BYTES) { truncated = true; continue; }
      budget--;
      let text: string;
      try { text = fs.readFileSync(p, "utf8"); } catch { continue; }
      SESSION_ID_RE.lastIndex = 0;
      let m: RegExpExecArray | null;
      while ((m = SESSION_ID_RE.exec(text)) !== null) out.add(m[0].toLowerCase());
    }
  };
  sweep(LOOM_ROOT(), SCAN_MAX_DEPTH);
  return { ids: out, truncated };
}

/** How recently a role's `status.json` must have been written for that role to count as live. */
export const BUS_LIVE_WINDOW_MS = 30 * 60_000;

/**
 * The live roster AS THE BUS SEES IT, across every project. `tracker.view()` is filtered to the
 * window's own repo by design, so a window driving the automatic pass knows nothing about any other
 * project's live roles — and the automatic pass is machine-wide. A role whose `status.json` was
 * written in the last half hour is a session that is running, whichever window it belongs to.
 *
 * NOT the guard for the worktree tier, despite looking like one — see `planWorktrees`.
 */
export function busLiveRoles(now: number, withinMs = BUS_LIVE_WINDOW_MS):
    { roles: Set<string>; sessionIds: Set<string> } {
  const roles = new Set<string>();
  const sessionIds = new Set<string>();
  for (const repo of loomDirs()) {
    for (const role of readdir(path.join(LOOM_ROOT(), repo))) {
      const f = path.join(LOOM_ROOT(), repo, role, "status.json");
      const st = statOf(f);
      // The file's mtime, not its `updated_at`: measured, a status file is rewritten by things that
      // do not maintain that field (health.ts, DRIFT_HOURS), so the timestamp inside lies and the
      // one the filesystem keeps does not.
      if (!st || !st.isFile() || now - st.mtimeMs > withinMs) continue;
      roles.add(`${repo}/${role}`);
      const d = readJson(f);
      for (const v of [d && d.session_id, d && d.sessionId]) {
        if (typeof v === "string" && v) sessionIds.add(v.toLowerCase());
      }
    }
  }
  return { roles, sessionIds };
}


/** The session ids belonging to roles that have a LIVE tab right now, from board and status.json. */
export function liveSessionIdsOf(liveRoles: Set<string>): Set<string> {
  const out = new Set<string>();
  const add = (v: any) => { if (typeof v === "string" && v) out.add(v.toLowerCase()); };
  for (const key of liveRoles) {
    const i = key.indexOf("/");
    if (i <= 0) continue;
    const repo = key.slice(0, i), role = key.slice(i + 1);
    const src = boardRolesObject(repo);
    const entry = src && src[role];
    if (entry && typeof entry === "object") { add(entry.session_id); add(entry.sessionId); }
    const st = readJson(path.join(LOOM_ROOT(), repo, role, "status.json"));
    if (st && typeof st === "object") { add(st.session_id); add(st.sessionId); }
  }
  return out;
}

interface TranscriptCandidate { file: string; sid: string; projectDir: string; mtimeMs: number; bytes: number; }

/**
 * Top-level `<projectDir>/<sid>.jsonl` files only. Anything nested — in particular a session's
 * `<sid>/subagents/` tree — is never a candidate in its own right; it moves WITH its parent session
 * or not at all, so a live session's subagent transcripts can never be collected out from under it.
 */
function transcriptCandidates(): { items: TranscriptCandidate[]; newestPerDir: Map<string, string> } {
  const items: TranscriptCandidate[] = [];
  const newestPerDir = new Map<string, string>();
  const newestAt = new Map<string, number>();
  for (const dir of readdir(PROJECTS_ROOT())) {
    const dirPath = path.join(PROJECTS_ROOT(), dir);
    if (!statOf(dirPath)?.isDirectory()) continue;
    for (const name of readdir(dirPath)) {
      if (!name.endsWith(".jsonl")) continue;
      const file = path.join(dirPath, name);
      const st = statOf(file);
      if (!st || !st.isFile()) continue;
      items.push({ file, sid: name.slice(0, -6), projectDir: dir, mtimeMs: st.mtimeMs, bytes: st.size });
      if (!newestAt.has(dir) || st.mtimeMs > newestAt.get(dir)!) {
        newestAt.set(dir, st.mtimeMs);
        newestPerDir.set(dir, file);
      }
    }
  }
  return { items, newestPerDir };
}

// ── the planner ─────────────────────────────────────────────────────────────────────────────

/**
 * Read the world and say what could be collected, in three tiers. PURE with respect to the disk:
 * it writes nothing. Every knob that could make it non-deterministic (`now`, the live roster, this
 * build's version, which repos have a checkout) is injected, so the tests assert real policy.
 */
export function planGc(input: GcInput): GcPlan {
  const plan: GcPlan = { date: gcDate(input.now), tier1: [], tier2: [], tier3: [], notes: [] };
  const liveSessions = liveSessionIdsOf(input.liveRoles);

  planExtensions(plan, input);
  planTranscripts(plan, input, liveSessions);
  planBackups(plan, input);
  planWorktrees(plan, input);
  planBoardEntries(plan, input);
  planBuses(plan, input);
  planCheckpoints(plan, input);

  return plan;
}

const SEMVER_RE = /^\d+\.\d+\.\d+([-+].*)?$/;

/** Versions stamped in `running-versions.json` recently enough to be a window that is still open. */
export interface RunningVersions {
  versions: Set<string>;
  /** False when the stamp file is missing, unparseable, or not an object. */
  readable: boolean;
}

/**
 * Which builds windows are actually running, from `running-versions.json`.
 *
 * THIS READ FAILS CLOSED. An empty keep-set is indistinguishable from "no window is running
 * anything", so the first version's empty-Set-for-an-absent-or-torn-file would have made 0.29.0 —
 * the build nine windows were on — look collectable after one interrupted write (ten windows rewrite
 * this file every 15 s). `readable: false` refuses the whole extension tier instead.
 *
 * TWO KEY SHAPES, unioned. Entries used to be keyed by REPO, which is wrong twice over: two windows
 * open on one project share a slot (so the one that ticks second hides the other's build), and every
 * folderless window collapses into a single "(no project)". They are keyed by windowId now, carrying
 * `repo` as a field. Mixed builds will write both shapes for a while and both are read: any version
 * any entry stamps inside the interval is a version some window may still be running.
 */
export function runningVersions(now: number, withinMs: number): RunningVersions {
  const versions = new Set<string>();
  const d = readJson(RUNNING_VERSIONS());
  if (!d || typeof d !== "object" || Array.isArray(d)) return { versions, readable: false };
  for (const v of Object.values<any>(d)) {
    if (!v || typeof v !== "object") continue;
    const at = Date.parse(String(v.at || ""));
    // An entry that cannot say WHEN it was written is not evidence of anything. Keeping it, as the
    // first version did, has no end to it: nothing ever ages such an entry out, so one damaged entry
    // pins its version in the keep-set for the life of the file and that build is never collectable
    // again. Dropping it is bounded and self-correcting in one tick — any window actually running
    // that build re-stamps within 15 seconds, with a timestamp.
    // NOT the torn-FILE case, which is untouched: when the file itself will not parse we see no
    // entries at all, cannot tell an empty keep-set from a real one, and refuse the whole tier
    // (`readable: false`). Here the file parsed and the other entries are readable.
    if (!Number.isFinite(at) || now - at > withinMs) continue;
    if (typeof v.version === "string" && v.version) versions.add(v.version);
  }
  return { versions, readable: true };
}

/**
 * TIER 1 — deployed builds nothing is using. THE HAZARD THIS GUARDS, measured 2026-09-13: the
 * registry said 0.32.0 while NINE windows were still running 0.29.0, because an editor keeps the code
 * it loaded until it is reloaded. Archiving "superseded" builds by the registry alone would have
 * pulled the extension directory out from under nine live editors mid-session.
 */
function planExtensions(plan: GcPlan, input: GcInput): void {
  const root = EXTENSIONS_ROOT();
  const names = readdir(root).filter((n) => n.startsWith(EXT_PREFIX));
  if (!names.length) return;

  // Without a trustworthy "this is the build I am" there is no keep-set worth acting on. VERSION is
  // "unknown" whenever package.json could not be read at activation, and that must not read as
  // "keep nothing".
  if (!SEMVER_RE.test(input.currentVersion)) {
    plan.notes.push(`this window's version is "${input.currentVersion}", not a semver — ` +
      "no deployed build is collectable this run");
    return;
  }

  // deploy.sh rewrites `extensions.json` on every deploy; the entries it leaves are what VSCodium
  // will actually load. The same id can appear more than once, so EVERY entry is kept, not the last.
  const exts = readJson(path.join(root, "extensions.json"));
  if (!Array.isArray(exts)) {
    plan.notes.push("extensions.json unreadable — no deployed build is collectable this run");
    return;                       // without it we cannot tell which build the editor loads: refuse
  }
  const registered = new Set<string>();
  for (const e of exts) {
    const id = e && e.identifier && e.identifier.id;
    if (id !== "local.loom-session-tracker") continue;
    const loc = e.location && (e.location.fsPath || e.location.path);
    // BOTH, not either: `location` says which directory is registered and `version` says which
    // version is, and a registry mid-rewrite can disagree with itself. Keeping both keeps the build
    // the editor will actually load, whichever field is the stale one.
    if (typeof loc === "string" && loc) registered.add(path.basename(loc));
    if (e.version) registered.add(`${EXT_PREFIX}${e.version}`);
  }

  const running = runningVersions(input.now, Math.max(1, input.cfg.intervalHours) * HOUR_MS);
  if (!running.readable) {
    plan.notes.push("running-versions.json is missing or unreadable — no deployed build is " +
      "collectable this run (an empty keep-set would archive the build live windows are on)");
    return;
  }
  const keep = new Set<string>([`${EXT_PREFIX}${input.currentVersion}`, ...registered]);
  for (const v of running.versions) keep.add(`${EXT_PREFIX}${v}`);

  for (const n of names.sort()) {
    if (keep.has(n)) continue;
    const src = path.join(root, n);
    plan.tier1.push({
      tier: 1, kind: "extension", label: n.slice(EXT_PREFIX.length),
      detail: `no window is running it (this window ${input.currentVersion}; registered ` +
        `${Array.from(registered).map((r) => r.slice(EXT_PREFIX.length)).join(", ") || "none"}; ` +
        `running ${Array.from(running.versions).sort().join(", ") || "none"})`,
      bytes: dirBytes(src), src, dest: path.join(archiveDir(input.now, "extensions"), n),
    });
  }
}

/** TIER 1 — old transcripts nothing references and that are not the newest in their project dir. */
function planTranscripts(plan: GcPlan, input: GcInput, liveSessions: Set<string>): void {
  const { items, newestPerDir } = transcriptCandidates();
  if (!items.length) return;
  const sweep = referencedSessions();
  if (sweep.truncated) {
    plan.notes.push("the reference sweep over ~/.claude/loom gave up early (too many files, too " +
      "deep, or a file over the size bound) — no transcript is collectable this run, because an " +
      "id it did not reach is indistinguishable from one nothing references");
    return;
  }
  const referenced = sweep.ids;
  const cutoff = input.now - input.cfg.transcriptDays * DAY_MS;
  for (const t of items) {
    if (t.mtimeMs >= cutoff) continue;                        // young enough to still be somebody's
    // A LIVE role's session is never garbage, board or no board. Its transcript can be old — an
    // orchestrator that has been idle for weeks still has the tab open — and losing it strands the
    // one thing "reopen this session" can use.
    const sid = t.sid.toLowerCase();
    if (liveSessions.has(sid)) continue;
    if (referenced.has(sid)) continue;                        // something on the bus points at it
    if (newestPerDir.get(t.projectDir) === t.file) continue;  // the freshest in its dir IS that dir's session
    // A session's own artifacts move together: the jsonl and, when it exists, `<sid>/` (its subagents).
    const companion = path.join(PROJECTS_ROOT(), t.projectDir, t.sid);
    const hasCompanion = !!statOf(companion)?.isDirectory();
    plan.tier1.push({
      tier: 1, kind: "transcript", label: `${t.projectDir}/${t.sid.slice(0, 8)}`,
      detail: `${Math.floor((input.now - t.mtimeMs) / DAY_MS)}d old, referenced nowhere` +
        (hasCompanion ? " (+ its subagents)" : ""),
      bytes: t.bytes + (hasCompanion ? dirBytes(companion) : 0), sessionId: t.sid,
      src: t.file, dest: path.join(archiveDir(input.now, "transcripts", t.projectDir), `${t.sid}.jsonl`),
    });
    if (hasCompanion) {
      plan.tier1.push({
        tier: 1, kind: "transcript", label: `${t.projectDir}/${t.sid.slice(0, 8)}/subagents`,
        detail: "subagent transcripts of the same archived session", bytes: 0, sessionId: t.sid,
        src: companion, dest: path.join(archiveDir(input.now, "transcripts", t.projectDir), t.sid),
      });
    }
  }
}

/** TIER 1 — `*.bak-<epoch>` scratch under the loom root. */
function planBackups(plan: GcPlan, input: GcInput): void {
  const cutoff = input.now - input.cfg.backupDays * DAY_MS;
  const re = /\.bak-(\d+)$/;
  const walk = (dir: string, depth: number) => {
    for (const name of readdir(dir)) {
      const p = path.join(dir, name);
      // never walk into the archive we are writing, or a bus's own deleted-sessions store
      if (NON_BUS_DIRS.has(name) || name === "deleted-sessions") continue;
      const st = statOf(p);
      if (!st) continue;
      if (st.isDirectory()) { if (depth > 0) walk(p, depth - 1); continue; }
      const m = re.exec(name);
      if (!m) continue;
      // The epoch in the NAME is when the backup was taken; mtime can be newer (a copy). Prefer the
      // name and fall back to mtime, so a re-copied backup is still judged by its real age.
      const epoch = Number(m[1]) * 1000;
      const at = Number.isFinite(epoch) && epoch > 0 ? epoch : st.mtimeMs;
      if (at >= cutoff) continue;
      plan.tier1.push({
        tier: 1, kind: "backup", label: path.relative(LOOM_ROOT(), p),
        detail: `${Math.floor((input.now - at) / DAY_MS)}d old backup file`, bytes: st.size,
        src: p, dest: path.join(archiveDir(input.now, "backups"), path.relative(LOOM_ROOT(), p)),
      });
    }
  };
  walk(LOOM_ROOT(), 2);
}

/** Is this worktree name a role of that project, allowing for the bus's own aliases? */
function rosterOf(repo: string): { canon: Set<string>; names: string[] } {
  const names = boardRoles(repo);
  return { canon: new Set(names.map((r) => canonicalRole(repo, r))), names };
}

/**
 * TIER 2 (clean + merged) / TIER 3 (anything else) — worktrees belonging to no board role.
 *
 * THIS IS THE ONE TIER THAT DELETES. Everything else in this file moves a file into `_archive/` or
 * adds a field to a board entry; tier 2 hands a finding to `health.removeWorktree`, which runs
 * `git worktree remove`. The branch and its commits survive and the restore line is recorded, but
 * the working directory does not, and neither does anything git was never told about.
 *
 * THE GUARD THAT ACTUALLY DECIDES IS THE ROSTER, NOT LIVENESS — stated plainly because the code
 * reads as though `input.liveRoles` stood between a worktree and `rm -rf`, and a GC-006 review
 * concluded exactly that and proposed widening the 30-minute window. It does not: `scanWorktrees`
 * marks a worktree orphaned only when its name is absent from `boardRoles(repo)`, and that roster is
 * the board UNION every role owning a MAILBOX on the bus — any directory holding a `status.json`,
 * `inbox.md` or `outbox.md`, at ANY age. A role whose session wrote status six hours ago, or six
 * months ago, is still on the roster and its worktree is never a candidate; the liveness window never
 * gets a say. Widening it would have added a strictly narrower test (a status.json is a mailbox)
 * inside a guard that already passed — an unreachable safeguard that reads as load-bearing, which is
 * worse than none.
 *
 * What that leaves collectable is the real target: a worktree named for a role with NO board entry
 * and NO mailbox anywhere on its project's bus — funisland's 72, measured 2026-09-13. Everything
 * that survives the roster still has to be clean, on a branch, fully merged, free of gitignored
 * files git cannot restore and not a near-miss of a real role name, or it goes to tier 3, where a
 * person decides. That is where an irreversible act belongs.
 */
function planWorktrees(plan: GcPlan, input: GcInput): void {
  for (const [repo, root] of Object.entries(input.repoRoots)) {
    if (!root) continue;
    const live = new Set(Array.from(input.liveRoles)
      .filter((k) => k.startsWith(repo + "/")).map((k) => k.slice(repo.length + 1)));
    let found: WorktreeFinding[] = [];
    try { found = scanWorktrees(repo, root, live); } catch { plan.notes.push(`${repo}: worktrees unreadable`); continue; }
    const { canon, names } = rosterOf(repo);
    for (const w of found) {
      // scanWorktrees compares the directory name to the RAW board roster. A project whose bus
      // renames a role (naming.json aliases) has worktrees named the other way — livegita's
      // `worktrees/developer` for `gitadeveloper` — and those are working directories, not garbage.
      const canonical = canonicalRole(repo, w.role);
      if (!w.orphaned || canon.has(canonical)) continue;
      // A near-miss of a real role name is somebody's typo, not a dead worktree. Measured
      // 2026-09-13: `Gaming/protyping` (one letter off `prototyping`) was being offered for removal.
      // The radius has to scale with the name. At distance 2, `po` matches `qa` and `dev` matches
      // `doc` — every short role name is "a typo" of every other, which would park real garbage in
      // tier 3 forever. At distance 1 on a two-letter name it is still a genuine near-miss.
      const near = names.find((r) => {
        const d = editDistance(canonicalRole(repo, r), canonical);
        return r.length >= 5 ? d <= 2 : d <= 1 && d > 0;
      });
      // Every one of these is a way removal could destroy something git cannot give back. They
      // duplicate removeWorktree()'s own refusals on purpose: the plan must not OFFER what the
      // applier will refuse, and the applier still refuses independently.
      const merged = w.dirty || !w.branch ? null : isMerged(root, w.branch);
      const blockers = [
        w.dirty ? "uncommitted work" : "",
        w.live ? "a LIVE session" : "",
        !w.branch ? "DETACHED HEAD (commits on no branch)" : "",
        w.risky.length ? `gitignored files git cannot restore (${w.risky.slice(0, 3).join(", ")})` : "",
        merged === false ? `unmerged (${w.ahead ?? "?"} commit(s) ahead)` : "",
        merged === null && !w.dirty && w.branch ? "merge state unknown" : "",
        near ? `its name is one typo away from the role "${near}"` : "",
      ].filter(Boolean);
      const bytes = dirBytes(w.path);
      if (blockers.length) {
        plan.tier3.push({
          tier: 3, kind: "riskyWorktree", label: `${repo}/${w.role}`,
          detail: `orphaned worktree kept — ${blockers.join("; ")}`, bytes, src: w.path, repo, role: w.role,
        });
      } else {
        plan.tier2.push({
          tier: 2, kind: "worktree", label: `${repo}/${w.role}`,
          detail: `orphaned, clean, ${w.branch} fully merged — branch and commits kept`,
          bytes, src: w.path, repo, role: w.role,
        });
      }
    }
  }
}

/** Would this board entry be marked dead, judged against the world right now? A reason, or null. */
function deadEntryReason(repo: string, role: string, liveRoles: Set<string>, entry: any): string | null {
  if (!entry || typeof entry !== "object" || Array.isArray(entry)) return null;
  // An owner role is never touched: its entry is what re-finds the orchestrator after a /clear,
  // and it is the one entry a person hand-repairs. A LIVE role is not dead by definition —
  // measured 2026-09-13, a fresh session's board id lags its transcript by seconds.
  if (isOwnerRole(role)) return null;
  if (liveRoles.has(`${repo}/${role}`)) return null;
  if (entry.status === "dead") return null;                     // already marked
  const sid = entry.session_id || entry.sessionId;
  if (typeof sid !== "string" || !sid) return null;
  if (transcriptFor(sid)) return null;                          // the transcript is there
  return sid;
}

/** TIER 2 — board entries naming a session that exists nowhere on disk. Marked, never removed. */
function planBoardEntries(plan: GcPlan, input: GcInput): void {
  for (const repo of busRepos()) {
    const src = boardRolesObject(repo);
    if (!src || typeof src !== "object") continue;
    const roster = new Set(boardRoles(repo));
    for (const [role, v] of Object.entries<any>(src)) {
      if (!roster.has(role)) continue;                       // a metadata key on a flat board
      const sid = deadEntryReason(repo, role, input.liveRoles, v);
      if (!sid) continue;
      plan.tier2.push({
        tier: 2, kind: "boardEntry", label: `${repo}/${role}`,
        detail: `session_id ${sid.slice(0, 8)} has no transcript anywhere — mark "dead"`,
        bytes: 0, repo, role, sessionId: sid,
      });
    }
  }
}

/** TIER 3 — whole buses, and owner id files that point somewhere else. A person decides. */
function planBuses(plan: GcPlan, input: GcInput): void {
  const cutoff = input.now - input.cfg.staleBusDays * DAY_MS;
  for (const repo of loomDirs()) {
    let newest = 0;
    const walk = (dir: string, depth: number) => {
      for (const name of readdir(dir)) {
        const p = path.join(dir, name);
        const st = statOf(p);
        if (!st) continue;
        if (st.isDirectory()) { if (depth > 0) walk(p, depth - 1); }
        else if (st.mtimeMs > newest) newest = st.mtimeMs;
      }
    };
    walk(path.join(LOOM_ROOT(), repo), 1);
    if (newest && newest < cutoff) {
      plan.tier3.push({
        tier: 3, kind: "staleBus", label: repo,
        detail: `bus untouched for ${Math.floor((input.now - newest) / DAY_MS)}d — archive the whole bus?`,
        bytes: dirBytes(path.join(LOOM_ROOT(), repo)), repo,
      });
    }
    // An owner `.id` file naming a frame another bus also declares is how ReciEats' orchestrator came
    // to be offered in Gaming's sidebar: the bus was copied, id files and all (registry.ts).
    for (const d of busDeclaredFrames(repo)) {
      if (d.source !== "idfile" || !isOwnerRole(d.role)) continue;
      const rivals = rivalDeclarers(repo, d.webviewId);
      if (!rivals.length) continue;
      plan.tier3.push({
        tier: 3, kind: "busFrameMismatch", label: `${repo}/${d.role}.id`,
        detail: `names frame ${d.webviewId.slice(0, 8)}, also declared by ${rivals.join(", ")} — ` +
          `one of these id files was copied and is lying`,
        bytes: 0, repo, role: d.role,
      });
    }
  }
}

/** TIER 3 — checkpoints, reported by size only. There is no policy for these yet, and inventing one
 *  quietly is exactly the kind of thing that loses work. */
function planCheckpoints(plan: GcPlan, input: GcInput): void {
  const root = CHECKPOINTS_ROOT();
  if (!statOf(root)?.isDirectory()) return;
  const bytes = dirBytes(root);
  if (!bytes) return;
  plan.tier3.push({
    tier: 3, kind: "checkpoints", label: "~/.claude/checkpoints",
    detail: `${fmtBytes(bytes)} of checkpoints — no retention policy defined; nothing will act on these`,
    bytes, src: root,
  });
}

// ── the applier ─────────────────────────────────────────────────────────────────────────────

export interface GcOutcome { item: GcItem; ok: boolean; note: string }
export interface GcResult {
  at: string;
  date: string;
  tiers: number[];
  done: GcOutcome[];
  skipped: GcOutcome[];
  bytesFreed: number;
}

/**
 * What the world looks like AT APPLY TIME. A plan can be minutes old — it is shown to a person who
 * reads it and clicks — and in that window a session can start, a tree go dirty and a board entry be
 * rewritten, so every safeguard is re-checked here against these.
 */
export interface ApplyOptions {
  repoRoots?: Record<string, string>;
  /** `${repo}/${role}` for every role with a live tab, right now. */
  liveRoles?: Set<string>;
  /** Session ids of those live roles, right now. */
  liveSessionIds?: Set<string>;
  /** Called BEFORE and AFTER each item so a long pass can keep its cross-window claim alive. Moving
   *  700 MB takes longer than the five-minute lease, and a lease that expires under its own holder
   *  is how two windows end up moving the same files. Throttled here, so the callback may be naive.
   *  Returns whether it actually WROTE the claim: `refreshLease` declines while the claim is still
   *  young, and a decline must not reset the throttle (see `applyGc`). */
  refresh?: () => boolean | void;
  /** How often `refresh` may actually fire, ms. Defaults to half the lease. Injectable because a
   *  test that moves three small files in a millisecond can never reach a 150-second throttle, and a
   *  callback no test can observe is a callback that can be silently unwired. */
  refreshEveryMs?: number;
  /** The clock the throttle reads. Injectable for the same reason `refreshEveryMs` is: the bug it
   *  exists to make visible — the throttle advancing on a refresh that wrote nothing — shows up only
   *  as a difference in WHEN attempts happen, which no test can see without owning the clock.
   *  Defaults to `Date.now`. */
  nowMs?: () => number;
}

/** Ensure a directory exists AND is writable. Returns a reason string when it is not. */
function ensureWritable(dir: string): string | null {
  try { fs.mkdirSync(dir, { recursive: true }); } catch (e: any) { return `archive dir not creatable (${String(e && e.code || e)})`; }
  try { fs.accessSync(dir, fs.constants.W_OK); } catch { return "archive dir not writable"; }
  return null;
}

/**
 * Did a copy land intact? Its own function because the EXDEV branch that calls it cannot be reached
 * from a test on one filesystem, and an unreachable safeguard is an untested one. TRUNCATION IS A
 * FAILURE, not a pass: `measure()` gives up after its budget, so a lower bound that happens to match
 * another lower bound is agreement about nothing.
 */
export function verifyCopy(before: Measured, after: Measured): string | null {
  if (before.truncated || after.truncated) return "copy failed, source left in place (too large to verify)";
  if (after.bytes !== before.bytes) return "copy failed, source left in place (verify mismatch)";
  return null;
}

/**
 * MOVE, never delete. `rename` where the two paths share a device; otherwise copy, VERIFY, and only
 * then release the source — so an interrupted move leaves the original, not a hole. A verify that
 * cannot be trusted (either side hit the walk budget) counts as a failure, and a failed verify takes
 * the half-written destination with it: a truncated archive that looks complete is worse than none.
 */
function moveTo(src: string, dest: string): string | null {
  const reason = ensureWritable(path.dirname(dest));
  if (reason) return reason;
  // lstat, not stat: a DANGLING SYMLINK is not "absent", and renaming over one silently adopts a
  // path somebody pointed somewhere on purpose.
  if (existsAny(dest)) return "destination already exists — left alone";
  try { fs.renameSync(src, dest); return null; } catch (e: any) {
    if (e && e.code !== "EXDEV") return `move failed (${String(e.code || e.message || e)})`;
  }
  const before = measure(src);
  try {
    fs.cpSync(src, dest, { recursive: true, errorOnExist: true, force: false });
  } catch (e: any) { return `copy failed (${String(e && e.code || e)})`; }
  const after = measure(dest);
  const bad = verifyCopy(before, after);
  if (bad) {
    // Remove the half-written copy. The SOURCE is never touched on this path.
    try {
      const st = fs.lstatSync(dest);
      if (st.isDirectory()) fs.rmSync(dest, { recursive: true, force: true }); else fs.unlinkSync(dest);
    } catch { /* best effort; the source is intact either way */ }
    return bad;
  }
  try {
    const st = fs.lstatSync(src);
    if (st.isDirectory()) fs.rmSync(src, { recursive: true }); else fs.unlinkSync(src);
  } catch (e: any) { return `copied, but the original could not be released (${String(e && e.code || e)})`; }
  return null;
}

/**
 * Add `status: "dead"` + a dated `gc_note` to one board entry. The entry itself always stays, and
 * every reason it might NOT be dead is asked again here, against the file as it is now: the board is
 * written by seven sessions and `loom_cdp.py`, so it changes under us.
 */
function markBoardEntryDead(item: GcItem, date: string, liveRoles: Set<string>): string | null {
  const repo = item.repo!, role = item.role!;
  const f = path.join(LOOM_ROOT(), repo, "board.json");
  // Re-read as late as possible: this is a read-modify-write on a file other sessions also write,
  // and the only thing that shrinks the lost-update window is doing less between the two.
  const board = readJson(f);
  if (!board || typeof board !== "object") return "board.json unreadable";
  const src = (board.roles && typeof board.roles === "object" && !Array.isArray(board.roles))
    ? board.roles : board;
  const entry = src && src[role];
  if (!entry || typeof entry !== "object") return "entry gone since the plan was made";
  const sid = entry.session_id || entry.sessionId;
  if (item.sessionId && sid !== item.sessionId) return "the entry was rebound since the plan was made";
  if (!deadEntryReason(repo, role, liveRoles, entry)) {
    return "no longer dead (live, an owner, already marked, or its transcript is back)";
  }
  entry.status = "dead";
  entry.gc_note = `${date}: session_id has no transcript`;
  try {
    const tmp = f + ".tmp." + process.pid;
    fs.writeFileSync(tmp, JSON.stringify(board, null, 2));
    fs.renameSync(tmp, f);
    return null;
  } catch (e: any) { return `board.json not writable (${String(e && e.code || e)})`; }
}

/**
 * Act on the plan, for the tiers named. Never throws: an item that cannot be collected is SKIPPED
 * and reported, and the rest of the run continues. Tier 3 is never acted on, whatever is passed —
 * it is the tier whose whole definition is "a person decides".
 */
export function applyGc(plan: GcPlan, tiers: number[], opts: ApplyOptions = {}): GcResult {
  const repoRoots = opts.repoRoots ?? {};
  const liveRoles = opts.liveRoles ?? new Set<string>();
  const liveSessionIds = opts.liveSessionIds ?? new Set<string>();
  const result: GcResult = {
    at: new Date().toISOString(), date: plan.date, tiers: tiers.filter((t) => t === 1 || t === 2),
    done: [], skipped: [], bytesFreed: 0,
  };
  const items = [
    ...(result.tiers.includes(1) ? plan.tier1 : []),
    ...(result.tiers.includes(2) ? plan.tier2 : []),
  ];
  const now = opts.nowMs ?? Date.now;
  const refreshEvery = opts.refreshEveryMs ?? LEASE_MS / 2;
  // The last moment the claim was actually WRITTEN, not the last moment we thought about writing it.
  // The first version reset this clock on every attempt, declines included (`refreshLease` declines
  // while the claim is young), so each decline pushed the next attempt another half-lease out from a
  // moment at which nothing had been written: a slow pass could drift a full lease between writes and
  // expire under its own holder.
  let lastWrite = now();
  /** Half-life, not every item: `refresh` writes a file, and tier 1 can be hundreds of items. */
  const tryRefresh = (): void => {
    if (!opts.refresh || now() - lastWrite < refreshEvery) return;
    let wrote: boolean | void;
    try { wrote = opts.refresh(); } catch { return; /* a refresh must never fail the pass */ }
    // `false` is the callback saying it wrote nothing. A callback that returns nothing at all tells
    // us nothing, and the safe reading of silence is "it wrote" — the alternative calls it on every
    // single item.
    if (wrote !== false) lastWrite = now();
  };
  for (const item of items) {
    tryRefresh();
    let reason: string | null = null;
    try {
      if (item.kind === "worktree") {
        const root = item.repo ? repoRoots[item.repo] : undefined;
        if (!root) reason = "no checkout for that project in this window";
        else {
          // scanWorktrees is re-run HERE, against the world as it is now — which is what re-checks
          // the roster, the guard that actually decides: a role that gained a mailbox between the
          // plan and this moment is no longer orphaned, and removeWorktree refuses it. The live set
          // is passed for defence in depth (it is the flag removeWorktree's third refusal reads),
          // though a live role always owns a mailbox and so never reaches that refusal from here.
          const live = new Set(Array.from(liveRoles)
            .filter((k) => k.startsWith(item.repo + "/")).map((k) => k.slice(item.repo!.length + 1)));
          const f = scanWorktrees(item.repo!, root, live).find((w) => w.role === item.role);
          if (!f) reason = "worktree gone since the plan was made";
          else if (isMerged(root, f.branch) !== true) reason = "no longer verifiably merged";
          else {
            const r = removeWorktree(root, f);
            reason = r.ok ? null : r.note;
          }
        }
      } else if (item.kind === "boardEntry") {
        reason = markBoardEntryDead(item, plan.date, liveRoles);
      } else if (item.src && item.dest) {
        // A transcript whose session went live between the plan and the click is not garbage.
        if (item.sessionId && liveSessionIds.has(item.sessionId)) reason = "its session is LIVE now";
        else reason = existsAny(item.src) ? moveTo(item.src, item.dest) : "gone since the plan was made";
      } else {
        reason = "nothing to do for this kind";
      }
    } catch (e: any) {
      reason = `unexpected: ${String(e && e.message || e).slice(0, 80)}`;
    }
    if (reason) result.skipped.push({ item, ok: false, note: reason });
    else { result.done.push({ item, ok: true, note: item.dest ? `moved to ${item.dest}` : "applied" });
           result.bytesFreed += item.bytes; }
    // AFTER the item as well as before it: one cross-device copy of a 700 MB transcript directory can
    // outlast the whole five-minute lease on its own, and refreshing only at the top of the loop
    // renews the claim just BEFORE the long wait and not again until the next item has also finished.
    // This does not protect the inside of a single long item — nothing here can; the guards for that
    // are `finishAuto`'s conditional release and the re-check of every safeguard at the move itself.
    tryRefresh();
  }
  logGc(result);
  return result;
}

/** Append-only record of what moved where, so every action has a written way back. */
function logGc(result: GcResult): void {
  try {
    const f = GC_DEBUG();
    let log: any[] = [];
    const prev = readJson(f);
    if (Array.isArray(prev)) log = prev;
    log.push({
      at: result.at, date: result.date, tiers: result.tiers, bytesFreed: result.bytesFreed,
      done: result.done.map((d) => ({ kind: d.item.kind, label: d.item.label, src: d.item.src, dest: d.item.dest, note: d.note })),
      skipped: result.skipped.map((s) => ({ kind: s.item.kind, label: s.item.label, note: s.note })),
    });
    fs.mkdirSync(path.dirname(f), { recursive: true });
    fs.writeFileSync(f, JSON.stringify(log.slice(-200), null, 2));
  } catch { /* the log is never allowed to fail the run */ }
}

// ── the automatic run, and its cross-window lease ───────────────────────────────────────────

export interface GcState {
  lastRunAt?: number;
  /** windowId of whoever is running a pass right now. */
  owner?: string;
  ownerAt?: number;
  lastNote?: string;
  lastResult?: { date: string; done: number; skipped: number; bytesFreed: number };
}

/** A lease this old means its holder is gone (window closed, or its extension host died). */
export const LEASE_MS = 5 * 60_000;

export function loadGcState(): GcState {
  const d = readJson(GC_STATE());
  return d && typeof d === "object" && !Array.isArray(d) ? d : {};
}

export function saveGcState(state: GcState): boolean {
  const f = GC_STATE();
  try {
    fs.mkdirSync(path.dirname(f), { recursive: true });
    const tmp = f + ".tmp." + process.pid;
    fs.writeFileSync(tmp, JSON.stringify(state, null, 2));
    fs.renameSync(tmp, f);
    return true;
  } catch { return false; }
}

export interface GcDecision { run: boolean; note: string; next: GcState }

/**
 * Should THIS window run the automatic tier-1 pass? A pure function of the persisted state, exactly
 * like memory.decide()'s lease: seven windows are routinely open on this machine and they all see the
 * same buses, so a pass belongs to ONE window from the moment it claims it. Another window may take
 * over only once the lease goes stale.
 *
 * A timestamp in the FUTURE is treated as expired rather than as fresh. Clocks move — an NTP step or
 * a VM resume writes one — and the alternative is a lease nothing can ever break, or an interval that
 * never elapses, both of which fail CLOSED and silently.
 */
export function dueForAuto(state: GcState, windowId: string, now: number, cfg: GcConfig): GcDecision {
  const keep = (note: string, next: GcState = state): GcDecision => ({ run: false, note, next });
  if (!cfg.enabled) return keep("garbage collection is off");
  const leaseAge = now - (state.ownerAt ?? 0);
  const heldByOther = !!state.owner && state.owner !== windowId && leaseAge >= 0 && leaseAge < LEASE_MS;
  if (heldByOther) return keep("another window is running this pass — one collector per machine");
  const sinceLast = now - (state.lastRunAt ?? 0);
  const every = Math.max(1, cfg.intervalHours) * HOUR_MS;
  if (state.lastRunAt && sinceLast >= 0 && sinceLast < every) {
    return keep(`last run ${(sinceLast / HOUR_MS).toFixed(1)}h ago; every ${cfg.intervalHours}h`);
  }
  return {
    run: true,
    note: !state.lastRunAt ? "first pass on this machine"
      : sinceLast < 0 ? "the last run is stamped in the future (clock skew) — treating it as due"
      : `due — ${(sinceLast / HOUR_MS).toFixed(1)}h since the last pass`,
    next: { ...state, owner: windowId, ownerAt: now },
  };
}

/**
 * Keep a claim alive during a long pass, at half-life so the file is not rewritten constantly.
 * Returns the state to persist, or null when the claim needs no refresh (or is not ours any more).
 * A pass over 2.4 GB of transcripts can outlive a five-minute lease, and a lease that expires
 * under its own holder is how two windows end up moving the same files.
 */
export function refreshLease(state: GcState, windowId: string, now: number): GcState | null {
  if (state.owner !== windowId) return null;
  const age = now - (state.ownerAt ?? 0);
  if (age >= 0 && age <= LEASE_MS / 2) return null;
  return { ...state, ownerAt: now };
}

/**
 * Release the claim and record the outcome. Always called after a claimed run, success or not.
 * The release is CONDITIONAL: if our lease went stale mid-pass and another window took the claim,
 * clearing `owner` here would hand that window's in-flight pass to a third. We record what we did
 * and leave the claim to whoever holds it.
 */
export function finishAuto(state: GcState, now: number, result: GcResult | null, note: string,
                           windowId?: string): GcState {
  const ours = windowId === undefined || state.owner === undefined || state.owner === windowId;
  const release = ours ? { owner: undefined, ownerAt: undefined } : {};
  return {
    ...state, ...release, lastRunAt: now, lastNote: note,
    lastResult: result
      ? { date: result.date, done: result.done.length, skipped: result.skipped.length, bytesFreed: result.bytesFreed }
      : state.lastResult,
  };
}

// ── rendering ───────────────────────────────────────────────────────────────────────────────

export function fmtBytes(n: number): string {
  if (n >= 1e9) return `${(n / 1e9).toFixed(1)} GB`;
  if (n >= 1e6) return `${(n / 1e6).toFixed(0)} MB`;
  if (n >= 1e3) return `${(n / 1e3).toFixed(0)} KB`;
  return `${n} B`;
}

function tierBytes(items: GcItem[]): number { return items.reduce((a, i) => a + i.bytes, 0); }

/** One-line summary for the status bar and live.sh. */
export function gcSummary(plan: GcPlan): string {
  return `tier1 ${plan.tier1.length} (${fmtBytes(tierBytes(plan.tier1))}) · ` +
    `tier2 ${plan.tier2.length} (${fmtBytes(tierBytes(plan.tier2))}) · ` +
    `tier3 ${plan.tier3.length} (${fmtBytes(tierBytes(plan.tier3))}) to decide`;
}

/** The digest's `gc` section. Tier 3 is listed by name — that is the whole point of tier 3. */
export function renderGc(plan: GcPlan): string {
  const L: string[] = [];
  const count = (items: GcItem[], kind: GcKind) => items.filter((i) => i.kind === kind).length;
  if (plan.tier1.length) {
    L.push(`Garbage, tier 1 — collected automatically, all reversible (${plan.tier1.length}, ${fmtBytes(tierBytes(plan.tier1))}):`);
    L.push(`   • ${count(plan.tier1, "extension")} superseded build(s), ` +
      `${count(plan.tier1, "transcript")} unreferenced transcript(s), ${count(plan.tier1, "backup")} old backup(s)` +
      ` → archived under _archive/${plan.date}/`);
  }
  if (plan.tier2.length) {
    L.push(`Garbage, tier 2 — collected on your click (${plan.tier2.length}, ${fmtBytes(tierBytes(plan.tier2))}):`);
    for (const i of plan.tier2) L.push(`   • ${i.label} — ${i.detail}`);
  }
  if (plan.tier3.length) {
    L.push(`Garbage, tier 3 — YOUR decision, nothing will act (${plan.tier3.length}, ${fmtBytes(tierBytes(plan.tier3))}):`);
    for (const i of plan.tier3) L.push(`   • ${i.label} — ${i.detail}`);
  }
  for (const n of plan.notes) L.push(`   ! ${n}`);
  return L.join("\n");
}
