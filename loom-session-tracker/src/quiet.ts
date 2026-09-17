// quiet.ts — ONE JOB: notice when a PROJECT (not a role) stops completely, and say WHEN it stopped.
// Answers three things and nothing else: WHICH project, WHEN it stopped, WHAT was last done.
//
// Why an aggregate: every other detector on this bus is scoped to one ROLE, to the tagged
// orchestrator's frame (delegation.ts, watchers.ts, notifier.ts), or to all roles at once
// (health.countWorking). A worker idling while its orchestrator thinks is not a stopped project.
//
// 1 · THE UNIT IS THE PROJECT; worktrees collapse onto their repo and the project's sessions are
//     UNIONed. Measured 2026-09-17 over 36h of real transcripts: session-as-unit gives 540 false
//     stops/day at N=15min; collapsing turns 27 apparent projects into 10 real ones and cuts that
//     to 27/day.
// 2 · `stoppedAt` IS THE MOMENT ACTIVITY ENDED, not the moment we noticed (they differ by up to N):
//     `lastActivityAt` is recorded when activity is OBSERVED and reported as-is — never `now - N`
//     (a guess), never `now` (a lie).
// 3 · THE LATCH KEYS ON THE EVENT, NOT THE CONDITION. `notifiedFor` stores the `lastActivityAt` we
//     notified for, so flickering quietness cannot clear it; only a genuinely NEWER watermark
//     re-arms it. Anti-precedent: health.ts:676 clears its latch whenever the role is not stalled
//     ON THIS TICK — a transient condition — and so fired at the orchestrator four times in one day.

import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { boardRoles, busRepos } from "./registry";
import { readGate, gateStateOf, boardSessionId, statusSessionId, sessionAgreement } from "./health";
import { getOrchestrator } from "./orchestrator";
import { transcriptFor } from "./context";
import { lastAssistantText } from "./watchers";
import { truncateHonestly } from "./push";

const LOOM_ROOT = path.join(os.homedir(), ".claude", "loom");

/** What a project looked like on ONE tick. Every field is something the tracker already computes. */
export interface ProjectSignals {
  repo: string;
  /** Frames attributed to this project that are MID-TURN this tick (sessions.isBusy). */
  busyFrames: number;
  /** Frames attributed to this project at all — 0 means every window of it is closed or unreadable. */
  framesSeen: number;
  /** Any role of this project has a declared gate positively identified as ALIVE (health.gateStateOf).
   *  Positive evidence of work during a stretch that produces no frames and no file writes. */
  gateRunning: boolean;
  /** Newest `status.json` write across this project's roles, ms epoch, or null when unreadable.
   *  Same clock health.ts's stall check uses, read as an ACTIVITY signal rather than a staleness one. */
  newestStatusAt: number | null;
  /** Newest transcript append across this project's sessions, ms epoch, or null when not measured.
   *  Null means UNMEASURED, never "nothing happened" — see `activityAt`. */
  newestTranscriptAt: number | null;
  /** One line naming the last thing that finished, for the body of the message. */
  lastWhat: string | null;
}

export interface ProjectQuiet {
  /** The moment activity ENDED, as observed. The notification reports this, and the latch keys on it. */
  lastActivityAt: number;
  /** The last thing that finished, carried alongside the watermark it belongs to. */
  lastWhat: string;
  /** THE LATCH: the `lastActivityAt` value we have already notified for, or null. */
  notifiedFor: number | null;
  /** Have we ever OBSERVED this project active? A project we have never seen working has no stop to
   *  report — this is what stops 71 dormant repos on this machine notifying every night. */
  seenActive: boolean;
}

export interface QuietState { projects: Record<string, ProjectQuiet>; }

export interface QuietFinding {
  repo: string;
  /** ms epoch — the moment activity ended. */
  stoppedAt: number;
  /** How long it has been quiet when we decided, in minutes (>= quietMinutes). */
  quietMinutes: number;
  lastWhat: string;
}

export interface QuietResult {
  state: ProjectQuiet;
  finding: QuietFinding | null;
  /** Why nothing fired. Always set when `finding` is null, so the panel can say what it is doing. */
  skip: string | null;
}

/** Default N. Defended by measurement — see the note on `quietTick`. */
export const DEFAULT_QUIET_MINUTES = 15;

/**
 * Is this project doing anything on this tick, and if so, when?
 *
 * THREE-VALUED: the ms-epoch instant of observed activity when active, `false` when positively
 * observed doing nothing, and `null` when UNKNOWN — we could not see the project this tick, and
 * unknown is not idle. A tick that cannot see a project must neither advance its watermark nor start
 * its clock (the rule delegation.ts applies to an unreadable orchestrator frame and health.ts to an
 * unidentifiable gate).
 */
export function activityAt(s: ProjectSignals, now: number): number | false | null {
  // POSITIVE WORK, in descending order of directness; both mean "working AT THIS INSTANT", so the
  // watermark is `now`. A mid-turn frame is the most direct observation there is.
  if (s.busyFrames > 0) return now;
  // A live gate is work that produces no frames and no writes for ~18 minutes at a stretch. Without
  // this, every mutation gate on the bus reads as a stopped project (health.ts paid for that once, WL-006).
  if (s.gateRunning) return now;

  // FILE-OBSERVED WORK: instants in the PAST, which is what makes `stoppedAt` retroactive rather than
  // a guess. These are WATERMARKS, NOT LIVENESS — whether the project is quiet is decided by the
  // watermark's AGE in `quietTick`, never here; collapsing the two makes a project whose status.json
  // was last written hours ago read as "active" for ever and never fire.
  const stamps = [s.newestStatusAt, s.newestTranscriptAt].filter(
    (t): t is number => typeof t === "number" && Number.isFinite(t),
  );
  if (stamps.length > 0) return Math.max(...stamps);

  // Nothing positive and no timestamp. Two different cases, and collapsing them is the
  // `unmeasured`-as-zero mistake health.ts names:
  //   · frames seen, none mid-turn — positively idle. No NEW watermark, but one already recorded still
  //     ages, so the quiet check must run; returning null would mean a project whose status files
  //     became unreadable could never be reported, however long it sat dead.
  //   · nothing seen at all — UNKNOWN, not idle. Do not start its clock.
  if (s.framesSeen > 0) return false;
  return null;
}

/**
 * One project, one tick.
 *
 * WHY N = 15, measured over 36h of this machine's real transcripts on 2026-09-17:
 *   · within-session gaps: p50 0.6s, p90 13.3s, p99 3.2min, p99.5 exactly 10.0min — 15min sits beyond
 *     99.5% of natural pauses (a thinking pause, a long tool call, a slow build).
 *   · project-union interior gaps (pauses that RESUMED, i.e. false stops) fall 41 -> 32 -> 28 at
 *     N = 15 -> 20 -> 30min: 15 is the elbow, and another 15min of latency buys only 22%.
 *   · he is away from his desk, so latency is the cost he feels. Configurable: another bus, another elbow.
 *
 * THE CLOCK RUNS FROM THE WATERMARK, not from when the project first looked quiet. One already 9
 * minutes old reaches N nine minutes sooner — correct, and the same fact that makes `stoppedAt` true.
 */
export function quietTick(s: ProjectSignals, prev: ProjectQuiet | undefined, now: number,
                          quietMinutes = DEFAULT_QUIET_MINUTES): QuietResult {
  const st: ProjectQuiet = prev
    ? { ...prev }
    : { lastActivityAt: 0, lastWhat: "", notifiedFor: null, seenActive: false };

  const at = activityAt(s, now);

  // ── UNKNOWN ─────────────────────────────────────────────────────────────────────────────────
  if (at === null) {
    return { state: st, finding: null, skip: "project not observed this tick" };
  }

  // ── ADVANCE THE WATERMARK, and RE-ARM if it genuinely moved ─────────────────────────────────
  // `false` means observed-idle: no new watermark, but the quiet check below still runs on the old one.
  if (at !== false && at > st.lastActivityAt) {
    st.lastActivityAt = at;
    // THE RE-ARM, and the only one: nothing else in this function clears `notifiedFor`, which is what
    // makes "one notification per stop" hold however the quiet condition flickers. A watermark that did
    // NOT move is not new activity — without this guard a status file rewritten with an unchanged mtime
    // would re-open the latch every tick.
    st.notifiedFor = null;
    if (s.lastWhat) st.lastWhat = s.lastWhat;
    st.seenActive = true;
  }

  // ── QUIET? ──────────────────────────────────────────────────────────────────────────────────
  // A project never seen working has no stop to report: 71 transcript directories exist on this machine
  // and 10 were active in the last 36h, so without this the other 61 announce themselves the first night
  // the feature is on. It also stops a fresh state file firing a backlog.
  if (!st.seenActive) {
    return { state: st, finding: null, skip: "never observed active — no stop to report" };
  }
  if (st.lastActivityAt <= 0) {
    return { state: st, finding: null, skip: "no activity watermark recorded" };
  }
  const quietFor = (now - st.lastActivityAt) / 60_000;
  if (quietFor < quietMinutes) {
    return { state: st, finding: null, skip: "active" };
  }
  // THE LATCH: keyed on the activity watermark — an event — and NOT on the quiet condition.
  if (st.notifiedFor !== null && st.notifiedFor === st.lastActivityAt) {
    return { state: st, finding: null, skip: "already notified for this stop" };
  }
  return {
    state: st,
    finding: {
      repo: s.repo,
      stoppedAt: st.lastActivityAt,
      quietMinutes: Math.round(quietFor * 10) / 10,
      lastWhat: st.lastWhat || "no completed block recorded",
    },
    skip: null,
  };
}

// ── NT-001-R1 · ONLY A PROJECT WHOSE WINDOW IS OPEN ────────────────────────────────────────────
//
// The owner's convention, supplied out of band: "The notification should only be sent about project
// windows that are open. So if I walk away from something, I will close it." A closed window IS the
// expression of intent NT-001's honest-limits list said this bus could not observe — so this is not a
// heuristic but a convention to honour exactly, including where it is inconvenient.
//
// "OPEN" is keyed on `cdp.openWindowRoots` — every `type: "page"` target, one per VS Code window,
// present whether or not the window hosts a Claude panel — matching a window's folder basename against
// the repo id OR one of the project's board role names, which is how a worktree window
// (`.claude/worktrees/developer1`) presents itself; the same mapping `tracker.inMyWindow` uses in the
// other direction. Frames are deliberately NOT the signal: a window open with no conversation panel
// still means "tell me".
export type Openness = "open" | "closed" | "unknown";

/**
 * Three-valued, and `unknown` is the one that matters.
 *
 * A failed or partial read of the window list is NOT evidence of a closed window; treating it as one
 * silently loses real notifications — a failure nobody complains about, its symptom being the absence
 * of a message. So both `null` (read failed) and `pages <= 0` (read succeeded and listed no window at
 * all, contradicting the fact that this code runs inside one — a partial `/json/list` is far likelier
 * than a machine with zero windows) are `unknown`, and the caller withholds and SAYS SO. Only a
 * successful read that DID see windows, none of them this project's, is `closed`.
 */
export function windowOpenness(read: { pages: number; roots: string[] } | null,
                               repo: string, roles: string[]): Openness {
  if (!read || !Array.isArray(read.roots)) return "unknown";
  if (!Number.isFinite(read.pages) || read.pages <= 0) return "unknown";
  const names = new Set<string>([repo, ...roles]);
  for (const r of read.roots) if (r && names.has(r)) return "open";
  return "closed";
}

/**
 * Split this tick's findings by the openness of each project's window, AT SEND TIME.
 *
 * The two silent outcomes are different facts and must not share a mechanism:
 *   · `dropped`  — positively observed closed. DROPPED, NOT DEFERRED: the caller latches it with
 *                  `markDropped`, so a reopened window gets no backfilled buzz about work that ended
 *                  hours ago. Reopening a window is not a request for what happened while it was shut.
 *   · `withheld` — we do not know. Nothing sent and NOTHING LATCHED, so the stop is reconsidered next
 *                  tick; latching here would turn one unreadable tick into a permanently lost
 *                  notification.
 * Evaluated immediately before sending, never when the stop was detected: he may walk away and then
 * close the window before N elapses, and by his convention that means do not tell him.
 */
export interface OpenGate<T> { send: T[]; dropped: T[]; withheld: T[] }
export function gateByOpenWindow<T extends { repo: string }>(
  findings: T[], read: { pages: number; roots: string[] } | null,
  rolesOf: (repo: string) => string[] = boardRoles,
): OpenGate<T> {
  const g: OpenGate<T> = { send: [], dropped: [], withheld: [] };
  for (const f of findings) {
    let roles: string[] = [];
    try { roles = rolesOf(f.repo) || []; } catch { roles = []; }
    const state = windowOpenness(read, f.repo, roles);
    if (state === "open") g.send.push(f);
    else if (state === "closed") g.dropped.push(f);
    else g.withheld.push(f);
  }
  return g;
}

/**
 * Record a stop DELIBERATELY NOT SENT because the project's window was closed.
 *
 * It sets the same latch as `markNotified` on purpose: the latch stores "the stop we have finished
 * dealing with", and a stop he asked not to hear about is finished. UNLIKE A FAILED SEND, which must
 * NOT latch — that message is still owed to him. Only a POSITIVE observation of closure may come here,
 * which is why `windowOpenness` never returns "closed" on doubt.
 */
export function markDropped(st: ProjectQuiet): ProjectQuiet {
  return markNotified(st);
}

/**
 * Record a DELIVERED notification.
 *
 * Only delivery latches. A send that failed — container down, docker missing, non-zero exit — is a
 * notification nobody received, and latching it would mean "told" for a phone that was never told.
 * That asserted-is-not-reached shape has cost this project six findings (WL-006, WL-008, CL-001).
 */
export function markNotified(st: ProjectQuiet): ProjectQuiet {
  return { ...st, notifiedFor: st.lastActivityAt };
}

/** Local wall-clock time, for a human reading a phone. */
export function stoppedClock(ms: number): string {
  const d = new Date(ms);
  const hh = String(d.getHours()).padStart(2, "0");
  const mm = String(d.getMinutes()).padStart(2, "0");
  return `${hh}:${mm}`;
}

/**
 * The two lines he reads on his phone. NOT a status dump, a count, or advice: the title names the
 * project and the body leads with the clock time, because "when it stopped" is the half he cannot
 * reconstruct on arrival. `title` is capped at 200 chars because `Notification.title` is varchar(200).
 */
export function quietMessage(f: QuietFinding, said?: LastWord | null): { title: string; body: string } {
  const title = `${f.repo} stopped`.slice(0, 200);
  let body = `Quiet since ${stoppedClock(f.stoppedAt)} (${f.quietMinutes} min). Last: ${f.lastWhat}`;
  // NT-001-R2 · and when there is no readable summary this line simply does not run, which is the
  // fallback stated as a requirement: exactly what NT-001 sends today, never nothing.
  if (said && said.text) {
    body += `\n\nWhat ${said.role} last said:\n${truncateHonestly(said.text)}`;
  }
  return { title, body };
}

// ── NT-001-R2 · FINDING THE ORCHESTRATOR'S OWN WORDS ───────────────────────────────────────────

/** The orchestrator's last message, with the role it belongs to so the body can attribute it. */
export interface LastWord { role: string; text: string; }

/**
 * Everything `orchestratorSaid` needs from the outside world, injected so the DECISION is testable with
 * no board, no transcript and no clock — the split this file keeps between `quietTick` (pure, tested)
 * and `gatherSignals` (the observation).
 */
export interface SaidDeps {
  orchestratorOf: (repo: string) => { role: string } | null;
  /** The session id under the AND-of-records rule — null when the records disagree. */
  sessionOf: (repo: string, role: string) => string | null;
  transcriptOf: (sessionId: string) => string | null;
  readLast: (file: string) => { text: string } | null;
}

function roleStatus(repo: string, role: string): any {
  try {
    return JSON.parse(fs.readFileSync(path.join(LOOM_ROOT, repo, role, "status.json"), "utf8"));
  } catch { return null; }
}

export const REAL_SAID_DEPS: SaidDeps = {
  orchestratorOf: (repo) => getOrchestrator(repo),
  // PB-001's IDENTITY RULE: a transcript is addressed BY SESSION ID, so a stale id reads a DEAD
  // session's last words as today's — a summary from a session that ended hours ago, presented as what
  // just finished, is worse than sending none. Identity is the AND of the board and the role's own
  // status.json; a disagreement is a transition in flight = UNKNOWN = no summary, NT-001 fallback.
  sessionOf: (repo, role) => {
    const boardSid = boardSessionId(repo, role);
    const statusSid = statusSessionId(roleStatus(repo, role));
    return sessionAgreement(boardSid, statusSid).agree ? (boardSid || statusSid) : null;
  },
  transcriptOf: (sid) => transcriptFor(sid),
  readLast: (f) => lastAssistantText(f),
};

/**
 * What the tagged orchestrator last told him, or null.
 *
 * EVERY FAILURE IS A NULL AND NEVER AN EXCEPTION: this may add to the notification and may never
 * subtract from it, so each of the four ways it comes up empty — no tagged orchestrator (a solo project
 * has none), identity in transition, no transcript on disk, no qualifying record in the tail — returns
 * null and the caller sends precisely what NT-001 sends today. Nothing here can throw into a tick.
 */
export function orchestratorSaid(repo: string, deps: SaidDeps = REAL_SAID_DEPS): LastWord | null {
  try {
    const tag = deps.orchestratorOf(repo);
    if (!tag || !tag.role) return null;
    const sid = deps.sessionOf(repo, tag.role);
    if (!sid) return null;
    const file = deps.transcriptOf(sid);
    if (!file) return null;
    const said = deps.readLast(file);
    if (!said || !said.text || !said.text.trim()) return null;
    return { role: tag.role, text: said.text.trim() };
  } catch {
    return null;                 // a notifier must never break a tick
  }
}

// ── state, gathering, and delivery ──────────────────────────────────────────────────────────────


/** GLOBAL, not per-repo: the question is cross-project ("any of the windows") and every window that
 *  runs a tick sees the same file, so two windows cannot both announce the same stop. The backstop if
 *  they race anyway is the UNIQUE `dedup_key` in Postgres — `pushKey` derives from (repo, stoppedAt),
 *  so a racing second send carries the SAME key and the backend dedupes rather than buzzing twice. */
export function quietStateFile(): string { return path.join(LOOM_ROOT, "quiet-state.json"); }

export function loadQuiet(): QuietState {
  try {
    const st = JSON.parse(fs.readFileSync(quietStateFile(), "utf8"));
    if (st && typeof st === "object" && st.projects && typeof st.projects === "object") {
      return { projects: st.projects };
    }
  } catch { /* none yet */ }
  return { projects: {} };
}

/** Atomic, change-only, never throws — a monitor must never break a tick. */
export function saveQuiet(st: QuietState): void {
  try {
    try {
      const cur = JSON.parse(fs.readFileSync(quietStateFile(), "utf8"));
      if (JSON.stringify(cur.projects) === JSON.stringify(st.projects)) return;
    } catch { /* missing -> write */ }
    fs.mkdirSync(LOOM_ROOT, { recursive: true });
    const tmp = quietStateFile() + ".tmp." + process.pid;
    fs.writeFileSync(tmp, JSON.stringify({ ...st, updatedAt: new Date().toISOString() }, null, 2));
    fs.renameSync(tmp, quietStateFile());
  } catch { /* never throw from a tick */ }
}

/** A frame the tracker saw this tick, reduced to the two things this file needs. */
export interface FrameSeen { repo: string | null; busy: boolean; }

/**
 * Read the file-observed half of a project's signals: when any of its roles last wrote `status.json`,
 * whether any has a LIVE gate, and the last thing that finished.
 *
 * `newestStatusAt` uses the file's mtime, not the `updated_at` field inside it: health.ts measured
 * `updated_at` drifting six hours behind the file on real buses (DRIFT_HOURS), and for "did something
 * happen" the write itself is the event.
 */
export function gatherStatus(repo: string, now: number): {
  newestStatusAt: number | null; gateRunning: boolean; lastWhat: string | null;
} {
  let newest: number | null = null;
  let gateRunning = false;
  let lastWhat: string | null = null;
  let whatAt = -1;
  for (const role of boardRoles(repo)) {
    const f = path.join(LOOM_ROOT, repo, role, "status.json");
    let mtime = 0;
    try { mtime = fs.statSync(f).mtimeMs; } catch { continue; }
    if (newest === null || mtime > newest) newest = mtime;
    let obj: any = null;
    try { obj = JSON.parse(fs.readFileSync(f, "utf8")); } catch { continue; }
    if (gateStateOf(readGate(obj), now) === "running") gateRunning = true;
    // The freshest role's own sentence is the best one-line answer to "what's done" that this bus
    // computes. `last_handled` names the block; `last_line` is what the panel already shows.
    if (mtime > whatAt) {
      whatAt = mtime;
      const id = typeof obj.last_handled === "string" ? obj.last_handled : null;
      const line = typeof obj.last_line === "string" ? obj.last_line : null;
      if (id || line) {
        const short = line ? line.split(/(?<=[.!?])\s/)[0].slice(0, 160) : "";
        lastWhat = [role, id ? `${id}` : null, short || null].filter(Boolean).join(" · ");
      }
    }
  }
  return { newestStatusAt: newest, gateRunning, lastWhat };
}

/**
 * Build one tick's signals for every project with a bus.
 *
 * `busRepos()` is the universe on purpose, NOT `~/.claude/projects`: 71 transcript directories exist on
 * this machine and 10 did anything in the last 36h. A project without a board is not one this tool
 * watches, and enumerating transcripts is how you end up telling him about every repo he ever opened.
 */
export function gatherSignals(frames: FrameSeen[], now: number): ProjectSignals[] {
  const out: ProjectSignals[] = [];
  for (const repo of busRepos()) {
    const mine = frames.filter((f) => f.repo === repo);
    const { newestStatusAt, gateRunning, lastWhat } = gatherStatus(repo, now);
    out.push({
      repo,
      framesSeen: mine.length,
      busyFrames: mine.filter((f) => f.busy).length,
      gateRunning,
      newestStatusAt,
      // Not wired: per-project transcript growth. watchers.ts reads a transcript by byte offset, but
      // keyed to ONE session id; a project-wide union needs a repo -> transcript-directory map this bus
      // does not record. Left null rather than approximated, because null means UNMEASURED here and a
      // wrong number would silently become a stop time he reads off his phone.
      newestTranscriptAt: null,
      lastWhat,
    });
  }
  return out;
}
