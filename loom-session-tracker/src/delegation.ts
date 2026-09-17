// delegation.ts — ONE JOB: notice an orchestrator that is doing the work itself.
//
// The owner's rule, 2026-09-17: "If an orchestrator has been working for a while and it hasn't woken
// up any of its loom agents, then it's time to remind it." Playbook §8 and §19 say the same from the
// other side; neither is enforced anywhere else.
//
// RANK 3 (detect + remind), not 1 (refuse) or 2 (supply): only the orchestrator can decide WHAT to
// delegate and to WHOM, so refusing would refuse the thing the tool is for and supplying would mean
// writing handoffs this process cannot spec.
//
// "HAS BEEN WORKING FOR A WHILE" = ticks on which the orchestrator's OWN frame was observed mid-turn
// (`OwnerView.busy`, from `isBusy()`); the tracker already computes it every tick, so it is free.
// The rejected signals, each for a reason that still holds:
//  - wall-clock since the last dispatch: measures the clock, not the session, and is loudest when
//    the session is least at fault (dispatched 18:00, human asleep → "14 hours" at breakfast).
//  - `OwnerView.contextPct`: §14 — the panel renders the compact button only past 50 % used, so the
//    number is null for the whole first half of a thread, which is where the delegate decision lives.
//  - `OwnerView.chars`: §6 — the transcript is Monaco-virtualized, so `chars` measures what is
//    PAINTED and falls as a thread scrolls. Sound for confirming a cleared panel, unsound as growth.
//  - transcript file growth on disk: the most accurate measure, but addressed by session id, which
//    goes stale at every clear and every respawn (§14; health.scanClears is a second instance).
//
// "WOKEN AN AGENT" = a NEW handoff id in a role's `inbox.md`: only the orchestrator writes a role's
// inbox, and the model ledger already records the instant as `openedAt` (models.ts `ledgerTick`), so
// it is observed rather than asserted. Rejected:
//  - a ring: a message, not work handed over — and `injectTo` overwrites one debug file per KIND, so
//    no history of rings exists to count.
//  - a worker's `status.json` moving: the WORKER writes it, so it credits worker activity to the
//    orchestrator.
//  - `gatesWoken` (health.ts): the TRACKER waking a gated worker — the tool's own act.
//
// THE TWO THINGS THAT MUST NEVER FIRE: (a) a bus with no workers bound — "has nobody to delegate to"
// is a different state from "has not delegated", and `reason` names it so a reader of the state file
// can tell "checked, nothing to say" from "not checked"; (b) every bound worker already busy — that
// is §8's concurrency cap being followed correctly, so the detector requires an AVAILABLE worker.
//
// SUPPRESSION is keyed on the DISPATCH WATERMARK, never on the condition: the stall alarm's
// `alerted` map re-arms whenever the condition flickers and so fired at this orchestrator four times
// in one day. Only a dispatch newer than the watermark re-arms this latch, and the busy-tick counter
// resets at the same instant. It lives on disk; a latch held in memory fires again on every reload.

import * as fs from "fs";
import * as os from "os";
import * as path from "path";

const LOOM_ROOT = path.join(os.homedir(), ".claude", "loom");

/** Default minutes of OBSERVED mid-turn time before the reminder is due — most of a §19 handoff's
 *  worth of orchestrator effort spent without handing anything over. */
export const DEFAULT_WORK_MINUTES = 30;

/** One tick, in ms. The count is in ticks, the message speaks in minutes. Passed in rather than
 *  imported so a test can drive a different cadence. */
export const TICK_MS = 15_000;

/** What one tick observes. All of it comes from records the extension already keeps. */
export interface DelegationInput {
  repo: string;
  /** The tagged orchestrator's role. null when the bus has no tag — nothing is judged. */
  orchestrator: string | null;
  /** Is the orchestrator's own frame mid-turn RIGHT NOW? null when its frame was not seen this
   *  tick, which is unknown and must not be counted as either working or idle. */
  busy: boolean | null;
  /** Every non-orchestrator role on the board, with whether it is working-like right now. */
  workers: Array<{ role: string; working: boolean }>;
  /** The most recent instant any role's handoff was OPENED, as an ISO string, or null when this bus
   *  has never been seen to open one. This is the dispatch watermark. */
  lastDispatch: string | null;
}

export interface DelegationState {
  /** Ticks the orchestrator has been observed mid-turn since the last dispatch. */
  busyTicks: number;
  /** The dispatch watermark this stretch is being measured from. */
  since: string | null;
  /** The watermark that was current when a reminder was last DELIVERED. The latch. */
  remindedAt: string | null;
  updatedAt?: string;
}

export interface DelegationFinding {
  repo: string;
  orchestrator: string;
  /** Minutes of observed mid-turn time in this stretch. */
  workedMinutes: number;
  /** The idle workers it could hand something to. Never empty in a finding. */
  idle: string[];
  /** Every bound worker, so the message can say how many are busy without implying they are idle. */
  busyWorkers: string[];
  /** When the last dispatch on this bus was seen, or null if none ever was. */
  lastDispatch: string | null;
}

/** Why a tick produced no finding. Reported rather than folded into silence — WL-002's rule, and
 *  what makes the false-positive cases legible instead of merely absent. */
export type DelegationSkip =
  | "no tagged orchestrator"
  | "orchestrator frame not seen this tick"
  | "orchestrator is not working"
  | "no workers bound — nobody to delegate to"
  | "every bound worker is busy — waiting is correct"
  | "not yet worked long enough"
  | "already reminded for this stretch";

export interface DelegationResult {
  state: DelegationState;
  finding: DelegationFinding | null;
  skip: DelegationSkip | null;
}

const EMPTY: DelegationState = { busyTicks: 0, since: null, remindedAt: null };

function file(repo: string): string {
  return path.join(LOOM_ROOT, repo, "delegation-state.json");
}

export function loadDelegation(repo: string): DelegationState {
  try {
    const st = JSON.parse(fs.readFileSync(file(repo), "utf8"));
    if (st && typeof st === "object") {
      return {
        busyTicks: Number.isFinite(st.busyTicks) ? Number(st.busyTicks) : 0,
        since: typeof st.since === "string" ? st.since : null,
        remindedAt: typeof st.remindedAt === "string" ? st.remindedAt : null,
      };
    }
  } catch { /* none yet */ }
  return { ...EMPTY };
}

/** Change-only and atomic, like every other latch on this bus: a tick that changed nothing must not
 *  churn the file, and a half-written latch must never be what the next tick reads. */
export function saveDelegation(repo: string, st: DelegationState): void {
  try {
    const f = file(repo);
    try {
      const cur = JSON.parse(fs.readFileSync(f, "utf8"));
      if (cur && cur.busyTicks === st.busyTicks && (cur.since ?? null) === st.since
          && (cur.remindedAt ?? null) === st.remindedAt) return;
    } catch { /* write */ }
    fs.mkdirSync(path.dirname(f), { recursive: true });
    const tmp = f + ".tmp." + process.pid;
    fs.writeFileSync(tmp, JSON.stringify({ ...st, updatedAt: new Date().toISOString() }, null, 2));
    fs.renameSync(tmp, f);
  } catch { /* ignore */ }
}

/**
 * One tick of the detector. PURE — observation plus previous latch in, next latch out, so every
 * claim below is testable without a composer, a board or a clock.
 *
 * Order matters: the two false-positive exclusions are checked BEFORE the threshold, so a bus with
 * no workers (or with all of them busy) can never accumulate its way into a finding.
 */
export function delegationTick(input: DelegationInput, prev: DelegationState,
                               workMinutes = DEFAULT_WORK_MINUTES,
                               tickMs = TICK_MS): DelegationResult {
  const st: DelegationState = { ...prev };

  // A DISPATCH RESETS EVERYTHING — counter and latch. This is the only re-arm: nothing else in this
  // function clears `remindedAt`, which is what makes "once per undelegated stretch" mean what it
  // says.
  if (input.lastDispatch && input.lastDispatch !== st.since) {
    st.since = input.lastDispatch;
    st.busyTicks = 0;
    st.remindedAt = null;
  }

  if (!input.orchestrator) {
    return { state: st, finding: null, skip: "no tagged orchestrator" };
  }
  // UNKNOWN IS NOT IDLE. A tick that could not see the frame neither counts nor resets: forgetting
  // would make an unreadable frame a way to erase the evidence, and counting would credit work to a
  // session that may have been closed.
  if (input.busy === null) {
    return { state: st, finding: null, skip: "orchestrator frame not seen this tick" };
  }
  if (input.busy) st.busyTicks += 1;

  // ── (a) nobody to delegate to ────────────────────────────────────────────────────────────────
  if (input.workers.length === 0) {
    return { state: st, finding: null, skip: "no workers bound — nobody to delegate to" };
  }
  // ── (b) everyone already busy ────────────────────────────────────────────────────────────────
  const idle = input.workers.filter((w) => !w.working).map((w) => w.role);
  const busyWorkers = input.workers.filter((w) => w.working).map((w) => w.role);
  if (idle.length === 0) {
    return { state: st, finding: null, skip: "every bound worker is busy — waiting is correct" };
  }

  if (!input.busy && st.busyTicks === 0) {
    return { state: st, finding: null, skip: "orchestrator is not working" };
  }
  const needTicks = Math.max(1, Math.ceil((workMinutes * 60_000) / Math.max(1, tickMs)));
  if (st.busyTicks < needTicks) {
    return { state: st, finding: null, skip: "not yet worked long enough" };
  }
  // THE LATCH. `remindedAt` is only ever cleared by a newer dispatch above, so a reported stretch
  // stays reported however long it runs and however the workers flicker.
  if (st.remindedAt !== null && st.remindedAt === (st.since ?? null)) {
    return { state: st, finding: null, skip: "already reminded for this stretch" };
  }
  const workedMinutes = Math.round(((st.busyTicks * tickMs) / 60_000) * 10) / 10;
  return {
    state: st,
    finding: { repo: input.repo, orchestrator: input.orchestrator, workedMinutes, idle, busyWorkers,
               lastDispatch: input.lastDispatch },
    skip: null,
  };
}

/** Record a DELIVERED reminder. Only delivery latches — an attempt refused because the composer was
 *  mid-turn is a reminder nobody received. That asserted-is-not-reached shape has cost this project
 *  six findings (WL-006, WL-008, CL-001). */
export function markReminded(st: DelegationState): DelegationState {
  return { ...st, remindedAt: st.since ?? null };
}

/**
 * The sentence an orchestrator reads. Each "must not" is a defect this product has shipped once:
 *  - not a score, threshold or bar to clear. A line satisfiable by STOPPING WORK is the WL-001
 *    defect, and here the remedy for "you are working too much alone" must never read as "work
 *    less". The minutes are stated once as the OBSERVATION, with no target and no comparison.
 *  - not a verdict on conduct: the orchestrator may be right to be doing this and the tool cannot
 *    know.
 *  - not a recitation of the playbook: it names the file ONCE, by path, and nothing else of its 533
 *    lines.
 * It MUST name the roles that are free right now, so "delegate to whom" is answered in the sentence.
 */
export function delegationReminder(f: DelegationFinding): string {
  const idle = f.idle.join(", ");
  const waiting = f.busyWorkers.length
    ? ` (${f.busyWorkers.join(", ")} ${f.busyWorkers.length === 1 ? "is" : "are"} working, so ${f.busyWorkers.length === 1 ? "that lane is" : "those lanes are"} accounted for.)`
    : "";
  const last = f.lastDispatch
    ? `Nothing has been handed to a role since ${f.lastDispatch}.`
    : "No handoff to any role has been seen on this bus.";
  return `[loom-delegate] You have been mid-turn for ${f.workedMinutes} minutes of ticks and ` +
    `${idle} ${f.idle.length === 1 ? "has" : "have"} been idle throughout. ${last}${waiting} ` +
    `Playbook §8: the orchestrator specs, banks, verifies and routes — it does not write the ` +
    `specialist's code — and §19 sizes a handoff at one merge, so work that would take you an hour ` +
    `is a block, not a task. If what you are doing now is specifiable, write it into ` +
    `~/.claude/loom/${f.repo}/${f.idle[0]}/inbox.md and dispatch it. If it genuinely is not — a ` +
    `design call, a bank, a decision only you can make — then this is the wrong moment for the ` +
    `line and you should carry on; nothing is blocked and nothing needs undoing.`;
}
