// delegation.ts — ONE JOB: notice an orchestrator that is doing the work itself.
//
// THE OWNER'S RULE, 2026-09-17, quoted because the whole file is a reading of one sentence:
//
//   "They keep picking up every job and trying to do it themselves. If an orchestrator has been
//    working for a while and it hasn't woken up any of its loom agents, then it's time to remind it."
//
// Playbook §8 says the same thing from the other side — "You don't build: orchestrator specs/banks/
// verifies/routes; it never writes the specialist's code" — and §19 puts numbers on it. Neither is
// enforced anywhere, and the owner has been doing the enforcing personally.
//
// THIS IS RANK 3 (detect + remind) AND THAT IS A DEMOTION, NOT A DEFAULT. Ranks 1 (refuse) and 2
// (supply) are unreachable here and the reason is the same one: nobody but the orchestrator can
// decide WHAT to delegate or to WHOM. A tool that refused to let an orchestrator work would be
// refusing the thing it is for, and a tool that "supplied" a dispatch would be writing handoffs it
// cannot spec. The decision is genuinely the orchestrator's, which is exactly the case rank 3 names.
//
// ───────────────────────────────────────────────────────────────────────────────────────────────
// WHAT "HAS BEEN WORKING FOR A WHILE" IS MEASURED BY, AND THE THREE THINGS IT IS NOT
//
// CHOSEN: ticks on which the orchestrator's OWN frame was observed mid-turn (`OwnerView.busy`, from
// `isBusy()` against the frame's rendered tail). Every tick is 15 s, so a count of busy ticks is a
// direct measure of time the session actually spent taking turns. It is the session's own activity,
// which is what the rule is about, and it costs nothing extra: the tracker already computes it on
// every tick for the context cycle and the model policy.
//
// REJECTED — wall-clock since the last dispatch. This is the lazy signal and it measures the CLOCK,
// not the session. An orchestrator that dispatched at 18:00 and whose human went to bed has "not
// delegated for fourteen hours" at breakfast, and would be greeted by a reminder for having done
// nothing at all. Worse, it is loudest exactly when the session is least at fault.
//
// REJECTED — the panel's context percentage (`OwnerView.contextPct`). It genuinely tracks a session
// filling up, but §14 records that the panel only renders the compact button past 50 % used, so the
// number is null for the whole first half of every thread — and the first half is where an
// orchestrator decides whether to delegate. A signal that is absent precisely when the question is
// live is not a signal.
//
// REJECTED — the frame's character count (`OwnerView.chars`). Playbook §6: "The transcript is
// VIRTUALIZED (Monaco virtual-scroll): text markers scroll out of the rendered DOM." So `chars`
// measures what is currently PAINTED, not what has been said; it falls as a long thread scrolls. It
// is sound for what it is used for today (confirming a cleared panel holds ~170 characters) and
// unsound as a growth signal.
//
// REJECTED — transcript file growth on disk. This is the most accurate measure of a session working
// and it is the one I would pick if the address were reliable. It is not: the transcript is found by
// session id, and a session id goes stale at every clear and every respawn. §14 records fourteen
// bank/clear/restore cycles in one night on one stale id, and the false alarm this same block fixes
// (see health.scanClears) is a second instance of the same staleness. Building the new reminder on
// the address that has already produced two failures would be choosing the defect knowingly.
//
// ───────────────────────────────────────────────────────────────────────────────────────────────
// WHAT COUNTS AS "WOKEN AN AGENT", AND WHY THE OTHER THREE CANDIDATES ARE WRONG
//
// CHOSEN: a NEW handoff id appearing in a role's `inbox.md`. Only the orchestrator writes a role's
// inbox, and writing one is the act of handing work over. It is the fact the model ledger already
// records as `openedAt` (models.ts `ledgerTick`), so it is observed by this process rather than
// asserted by anyone, and it is the only candidate that means THE ORCHESTRATOR CAUSED A WORKER TO
// START — which is the fact the rule is about.
//
// REJECTED — a ring. An orchestrator can ring a role that is already busy, ring the wrong role, or
// ring to say "nice work". A ring is a message, not work handed over, and counting it would let the
// reminder be satisfied by typing at somebody. There is also no record to read: `injectTo` writes
// one debug file per KIND and overwrites it, so no history of rings exists to count in the first
// place.
//
// REJECTED — a worker's `status.json` moving. The worker writes that file. It moves when a worker
// updates its own `last_line` mid-block, and it would go on moving for an hour after a dispatch, so
// it measures the WORKER's activity and credits it to the orchestrator.
//
// REJECTED — `gatesWoken` (health.ts). That is the TRACKER waking a worker whose gate exited. It is
// this extension's own act, not the orchestrator's, and counting it would have the tool congratulate
// the orchestrator for the tool's work.
//
// ───────────────────────────────────────────────────────────────────────────────────────────────
// THE TWO THINGS THAT MUST NEVER FIRE — and they are the whole reason anyone would believe this
//
// (a) A BUS WITH NO WORKERS BOUND. A solo orchestrator on a project with no roles has nobody to
//     delegate to. "Has not delegated" and "has nobody to delegate to" are different states and only
//     the first is a finding; `reason` names the second explicitly rather than folding it into
//     silence, so a reader of the state file can tell "checked, nothing to say" from "not checked".
//
// (b) EVERY BOUND WORKER ALREADY BUSY. An orchestrator waiting on three running workers is following
//     §8's concurrency cap exactly, and nudging it would be punishing the correct behaviour. This is
//     the case that decides whether the reminder is believed, so the detector requires a worker that
//     is actually AVAILABLE — idle, and therefore dispatchable — before it will say a word.
//
// ───────────────────────────────────────────────────────────────────────────────────────────────
// SUPPRESSION: ONCE PER UNDELEGATED STRETCH, AND THE PRECEDENT IS READ AS A WARNING
//
// The stall alarm's `alerted` map re-arms the moment a role stops being reported stalled, so a role
// that flickers in and out of the stall window is re-alerted every time it comes back. Measured on
// this bus: it fired at the orchestrator four times in one day. That is the failure to avoid.
//
// So this latch is NOT keyed on the condition. It is keyed on the DISPATCH WATERMARK — the last
// handoff-open instant known when the reminder was sent — and the ONLY thing that re-arms it is a
// dispatch that is newer than that watermark. An orchestrator that reads the reminder and keeps
// working is not told twice; an orchestrator that delegates has the latch re-armed by the act
// itself. The busy-tick counter resets at the same moment, so the next stretch is measured from the
// dispatch and not from the reminder. It lives on disk beside the other latches, because a latch
// held in memory fires again on every window reload.

import * as fs from "fs";
import * as os from "os";
import * as path from "path";

const LOOM_ROOT = path.join(os.homedir(), ".claude", "loom");

/** Default minutes of OBSERVED mid-turn time before the reminder is due. Thirty minutes of turns is
 *  most of a §19 handoff's worth of orchestrator effort spent without handing anything over. */
export const DEFAULT_WORK_MINUTES = 30;

/** One tick, in ms. The count is in ticks; the message speaks in minutes, because nobody thinks in
 *  ticks. Passed in rather than imported so a test can drive a different cadence. */
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

/** Why a tick produced no finding. Kept and reported rather than folded into silence — WL-002's
 *  rule, and the reason the false-positive cases are legible instead of merely absent. */
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
 * One tick of the detector. PURE — it takes the observation and the previous latch and returns the
 * next one, so every claim below is testable without a composer, a board or a clock.
 *
 * Order matters and is deliberate: the two false-positive exclusions are checked BEFORE the
 * threshold, so a bus with no workers (or with all of them busy) can never accumulate its way into a
 * finding no matter how long the orchestrator works.
 */
export function delegationTick(input: DelegationInput, prev: DelegationState,
                               workMinutes = DEFAULT_WORK_MINUTES,
                               tickMs = TICK_MS): DelegationResult {
  const st: DelegationState = { ...prev };

  // A DISPATCH RESETS EVERYTHING — the counter and the latch. This is the re-arm, and it is the only
  // one: nothing else in this function clears `remindedAt`. An orchestrator that delegates has both
  // the stretch and the suppression reset by the act itself, which is what makes "once per
  // undelegated stretch" mean what it says.
  if (input.lastDispatch && input.lastDispatch !== st.since) {
    st.since = input.lastDispatch;
    st.busyTicks = 0;
    st.remindedAt = null;
  }

  if (!input.orchestrator) {
    return { state: st, finding: null, skip: "no tagged orchestrator" };
  }
  // UNKNOWN IS NOT IDLE. A tick that could not see the orchestrator's frame neither counts nor
  // resets: forgetting would make an unreadable frame a way to erase the evidence, and counting
  // would credit work to a session that may have been closed.
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
  // THE LATCH. `remindedAt` is only ever cleared by a newer dispatch above, so a stretch that has
  // been reported stays reported however long it runs and however the workers flicker.
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

/** Record a DELIVERED reminder. Only delivery latches — an attempt that was refused because the
 *  composer was mid-turn is a reminder nobody received, and marking it here would mean "told" for a
 *  session that was never told. That asserted-is-not-reached shape has cost this project six
 *  findings (WL-006, WL-008, CL-001), so it is not repeated here. */
export function markReminded(st: DelegationState): DelegationState {
  return { ...st, remindedAt: st.since ?? null };
}

/**
 * The sentence an orchestrator reads.
 *
 * WHAT IT MUST NOT BE, and each of these is a defect this product has already shipped once:
 *  - not a score, threshold, quota or bar to clear. A line an orchestrator can satisfy by STOPPING
 *    WORK is the WL-001 defect aimed at the one reader who can act, and it would be a spectacular
 *    own-goal here, where the remedy for "you are working too much alone" must never read as "work
 *    less". So the minutes are stated as the OBSERVATION that raised the line, once, and no target
 *    is given and no comparison is drawn.
 *  - not a verdict on conduct. The orchestrator may be entirely right to be doing this; the tool
 *    cannot know, and the line says so.
 *  - not a recitation of the playbook. It names the file ONCE, by path, as somewhere to look — the
 *    rule that applies, at the moment it applies, and nothing else from those 533 lines.
 *
 * WHAT IT MUST BE: a specific next action. It names the roles that are actually free right now, so
 * the answer to "delegate to whom" is in the sentence rather than left as an exercise.
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
