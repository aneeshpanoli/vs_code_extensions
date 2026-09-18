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
// SUPPRESSION is a DELIVERED flag re-armed only by a DISPATCH, never keyed on the condition: the
// stall alarm's `alerted` map re-arms whenever the condition flickers and so fired at this
// orchestrator four times in one day. Only a dispatch newer than the watermark re-arms this latch,
// and the busy-tick counter resets at the same instant. It lives on disk; a latch held in memory
// fires again on every reload.
//
// The flag is a BOOLEAN and not the watermark itself, which is DG-001: storing `since ?? null` made
// one `null` mean both "no dispatch has ever been seen" and "nothing has been delivered", so on a
// bus that had never dispatched the latch could never suppress and the reminder fired every
// qualifying tick — 133 of them at livegita's orchestrator, 33 minutes, until the feature was
// switched off for every bus to stop it. A latch keys on what WE did; the watermark is what the
// world did, and it is allowed to be absent.
//
// "ONCE PER STRETCH" IS NOW A PROPERTY OF THE PRODUCT, NOT ONLY OF THIS FUNCTION (DG-001-R1). Two
// routes in extension.ts repeated a reminder this function had already decided against, and neither
// was visible from here because nothing exercised `runDelegation` itself — 22 green tests on a pure
// function said nothing about what a bus receives. Both are closed, each by ONE mechanism and not
// two, because a property held by two mechanisms is a property no single mutant can falsify:
//  (a) NOTHING MARKED AN INJECTION IN FLIGHT. `loom_cdp.py` runs for up to INJECT_TIMEOUT_MS — four
//      ticks — and each of those ticks re-read a file the previous one had not yet latched, so one
//      due reminder was delivered up to four times. `claimInjection` now takes an atomic, expiring
//      claim BEFORE the injector is spawned, and the latch is set when the attempt comes back.
//  (b) EVERY WINDOW TICKED THE SAME FILE. `currentRepo()` resolves through the shared repository
//      directory, so N editor windows on one project each delivered a reminder and each incremented
//      `busyTicks`, which made the threshold arrive in 30/N minutes. The claim is a FILE, so it is
//      shared by exactly the windows that share the state; and the counter now advances at most
//      once per `tickMs` of wall clock however many windows are observing (`DelegationInput.at`).
//
// STAMPING BEFORE THE INJECT IS THE OPPOSITE TRADE FROM A WAKE, AND BOTH ARE RIGHT. A WAKE MUST
// REACH ITS WORKER: lose one and work stalls until a human notices, which is why the gate wake and
// the model policy latch ONLY on confirmed delivery, and why that rule cost six findings to arrive
// at (WL-006, WL-008, CL-001). THAT RULE IS NOT REVERSED HERE AND MUST NOT BE READ AS REVERSED — it
// governs every message this tool sends to a WORKER. A reminder to an ORCHESTRATOR is advisory: a
// missed one costs nothing, because the condition persists and the next stretch says it again,
// while a repeated one costs the owner's patience, which is what took this feature off every bus.
// Opposite cost asymmetry, opposite trade, and the two live one import apart on purpose.

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

/** How long a claim on the injector stays good. MIRRORS `INJECT_TIMEOUT_MS` in inject.ts, which is
 *  the wall a spawned `loom_cdp.py` actually dies at; models.ts and limits.ts each keep the same
 *  local copy for the same reason — importing inject.ts here would pull the editor-facing module
 *  graph into a file whose whole value is being testable without one. If that constant moves, this
 *  one moves with it: a claim shorter than the injector's life expires while its injector is still
 *  typing, which is the repeat this block exists to close. */
export const INJECT_TIMEOUT_MS = 60_000;

/** How much LONGER than the injector a claim stays good. The two clocks do not start together: the
 *  claim is stamped inside `claimInjection`, and `execFile`'s timeout starts a few milliseconds
 *  later at the spawn, after a state write and the message being composed. Equal windows therefore
 *  leave a gap that is small but ALWAYS THERE, in which a hung injector is still alive — still
 *  holding the composer, possibly already typed — while its claim has expired and a second window
 *  is free to take it over and inject again. The band is the gap made impossible rather than made
 *  unlikely; its cost is a few seconds of extra silence after a genuine crash. */
export const CLAIM_GRACE_MS = 10_000;

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
  /** WHEN this observation was taken, ms. Supplied, never read off the clock in here, because it is
   *  what makes the counter idempotent across WINDOWS: N editor windows on one project share one
   *  state file, ticked it N times a tick, and drove the threshold to 30/N minutes. A busy tick is
   *  counted only once per `tickMs` of wall clock, so "30 minutes of observed work" means the same
   *  with one window open as with four.
   *
   *  ABSENT MEANS "NO INSTANT SUPPLIED", AND THEN EVERY BUSY TICK COUNTS — the pre-DG-001-R1
   *  behaviour, which is what the pure tests drive when they loop a tick n times with no clock.
   *  Deduplicating needs a clock and a caller that has none cannot be given one here; the PRODUCT
   *  always supplies it (extension.ts), and the wiring test is what holds it to that, because this
   *  default degrades silently by design. */
  at?: number | null;
}

export interface DelegationState {
  /** Ticks the orchestrator has been observed mid-turn since the last dispatch. */
  busyTicks: number;
  /** The dispatch watermark this stretch is being measured from. */
  since: string | null;
  /** THE LATCH: has a reminder been DELIVERED for the stretch now being measured? A BOOLEAN, not a
   *  watermark, because DG-001 was exactly the watermark-as-latch-key trap: `since` is a nullable
   *  OBSERVATION and the old latch stored it, so on a bus that had never dispatched the key was
   *  `null` — indistinguishable from "nothing delivered yet" — and the check never suppressed.
   *  Delivery is a fact about US; it must not be expressed in a field that can be absent because
   *  the WORLD had nothing to report. */
  reminded: boolean;
  /** When the last reminder was delivered, ISO. A RECORD for whoever reads the state file, never
   *  read by the latch: it is not cleared by a re-arm, so it answers "when did this bus last hear
   *  from us" across stretches, which `reminded` deliberately cannot. */
  deliveredAt?: string | null;
  /** The instant of the last busy tick that was COUNTED, ISO. The cadence gate for `busyTicks`: a
   *  second window observing the same minute of the same orchestrator must not bank it twice. Like
   *  `busyTicks` it belongs to the stretch, so a dispatch clears it. */
  lastTickAt?: string | null;
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

const EMPTY: DelegationState = { busyTicks: 0, since: null, reminded: false, deliveredAt: null,
                                 lastTickAt: null };

function file(repo: string): string {
  return path.join(LOOM_ROOT, repo, "delegation-state.json");
}

/** The claim. A SEPARATE file from the state on purpose: the state is a record every window rewrites
 *  each tick, and a claim has to be taken by exactly one of them at once, which a read-modify-write
 *  of a shared JSON file cannot promise. */
function claimFile(repo: string): string {
  return path.join(LOOM_ROOT, repo, "delegation-inflight.lock");
}

export function loadDelegation(repo: string): DelegationState {
  try {
    const st = JSON.parse(fs.readFileSync(file(repo), "utf8"));
    if (st && typeof st === "object") {
      const since = typeof st.since === "string" ? st.since : null;
      // MIGRATION. A file written before DG-001 has no `reminded`; it has the old watermark latch.
      // Deriving the flag by REPLAYING the old suppression condition (`remindedAt` present AND equal
      // to `since`) carries over exactly the suppression that file actually had, so an unaffected
      // bus stays silent and no bus is re-reminded for a stretch it was already told about. The
      // affected shape — `since` null, so `remindedAt` null — derives `false`, which is the truth:
      // its 133 reminders latched nothing. It is therefore due ONE reminder on first load, and
      // latched from then on. One is not a burst.
      const legacyLatched = typeof st.remindedAt === "string" && st.remindedAt === since;
      return {
        busyTicks: Number.isFinite(st.busyTicks) ? Number(st.busyTicks) : 0,
        since,
        reminded: typeof st.reminded === "boolean" ? st.reminded : legacyLatched,
        deliveredAt: typeof st.deliveredAt === "string" ? st.deliveredAt : null,
        lastTickAt: typeof st.lastTickAt === "string" ? st.lastTickAt : null,
      };
    }
  } catch { /* none yet */ }
  return { ...EMPTY };
}

/**
 * Change-only and atomic, like every other latch on this bus: a tick that changed nothing must not
 * churn the file, and a half-written latch must never be what the next tick reads.
 *
 * AND THE LATCH ONLY EVER GOES UP WITHIN A STRETCH. Every window on a project writes this one file,
 * and a window computes its next state from a read taken up to a whole tick earlier — so the window
 * that did NOT deliver would otherwise write `reminded: false` back over the one that did, purely by
 * landing second, and the next tick would remind again. That is the same repeat this block closes,
 * arriving by a race instead of by a missing marker. A DISPATCH still re-arms it, because a dispatch
 * changes `since` and this rule is scoped to the stretch being measured.
 */
export function saveDelegation(repo: string, st: DelegationState): void {
  try {
    const f = file(repo);
    let next = st;
    try {
      const cur = JSON.parse(fs.readFileSync(f, "utf8"));
      if (cur && cur.reminded === true && !st.reminded && (cur.since ?? null) === st.since) {
        next = { ...st, reminded: true, deliveredAt: cur.deliveredAt ?? st.deliveredAt ?? null };
      }
      if (cur && cur.busyTicks === next.busyTicks && (cur.since ?? null) === next.since
          && cur.reminded === next.reminded
          && (cur.deliveredAt ?? null) === (next.deliveredAt ?? null)
          && (cur.lastTickAt ?? null) === (next.lastTickAt ?? null)) return;
    } catch { /* write */ }
    fs.mkdirSync(path.dirname(f), { recursive: true });
    const tmp = f + ".tmp." + process.pid;
    fs.writeFileSync(tmp, JSON.stringify({ ...next, updatedAt: new Date().toISOString() }, null, 2));
    fs.renameSync(tmp, f);
  } catch { /* ignore */ }
}

/**
 * TAKE THE RIGHT TO INJECT, or report that someone else holds it. Called immediately BEFORE the
 * injector is spawned and released when it comes back — so the window between "this tick decided to
 * remind" and "the latch records that we did" is covered, which is the window four reminders used to
 * fit inside.
 *
 * ATOMIC, because the thing it guards against is two windows deciding in the same instant: the claim
 * is taken with an exclusive create (`wx`), which the filesystem grants to exactly one caller. A
 * read-then-write of the state file cannot make that promise and would leave the answer to §4 as
 * "one, usually".
 *
 * EXPIRING, because a window that dies mid-injection would otherwise hold the claim for ever and
 * silence this bus permanently — the swallow that is the quiet cousin of the spam. A claim older
 * than `timeoutMs` is one whose injector cannot still be alive, and it is taken over by RENAMING it
 * away: rename resolves a race to a single winner (the loser's rename fails, because the file it
 * names is gone), where unlink-then-create would let both windows through.
 */
export function claimInjection(repo: string, now = Date.now(),
                               timeoutMs = INJECT_TIMEOUT_MS + CLAIM_GRACE_MS): boolean {
  const f = claimFile(repo);
  const readAt = (file: string): number => {
    try { return Number(JSON.parse(fs.readFileSync(file, "utf8")).at); } catch { return NaN; }
  };
  // WRITTEN IN FULL BEFORE IT EXISTS. `open(…,"wx")` then `write` leaves the claim ZERO BYTES for as
  // long as the write takes, and the expiry path below reads that content: a second window arriving
  // inside that window reads an empty file, cannot parse an `at`, correctly concludes it cannot be
  // shown to be live, and takes the claim away from a window that is about to inject. So the bytes
  // go to a private temp file first and `link` publishes them — link fails if the name exists, which
  // is the same exclusivity `wx` gives, with no moment where the claim exists but says nothing.
  const take = (): boolean => {
    const tmp = f + ".tmp." + process.pid + "." + Math.random().toString(36).slice(2, 8);
    try {
      fs.mkdirSync(path.dirname(f), { recursive: true });
      fs.writeFileSync(tmp, JSON.stringify({ at: now, pid: process.pid }));
      fs.linkSync(tmp, f);
      return true;
    } catch { return false; }
    finally { try { fs.unlinkSync(tmp); } catch { /* the link, if made, keeps the content */ } }
  };
  if (take()) return true;
  // Held. Only an EXPIRED claim may be taken over, and an unreadable or unparseable one counts as
  // expired: a claim nobody can age out is the permanent silence this whole path exists to avoid.
  const started = readAt(f);
  if (Number.isFinite(started) && now - started < timeoutMs) return false;
  // THE TAKEOVER, and it must prove it took over the claim it JUDGED. Two windows can both decide
  // "expired" and then rename in turn — the second renaming a claim the first has already replaced
  // with a live one, which hands out two claims for one stretch. `rename` resolves a race among
  // callers contending for one file, not the case where the file was swapped underneath them, so
  // the instant is re-read from the renamed file: whoever moved something newer than what it judged
  // has taken a live claim by accident and puts it back.
  const parked = f + ".expired." + process.pid + "." + Math.random().toString(36).slice(2, 8);
  try { fs.renameSync(f, parked); } catch { return false; }
  const moved = readAt(parked);
  if (Number.isFinite(moved) && now - moved < timeoutMs) {
    try { fs.linkSync(parked, f); } catch { /* someone else already re-claimed it */ }
    try { fs.unlinkSync(parked); } catch { /* best effort */ }
    return false;
  }
  try { fs.unlinkSync(parked); } catch { /* best effort */ }
  return take();
}

/** Give the claim back. Called on EVERY outcome of the injection, including the failures: whether
 *  the bus stays quiet after a failed attempt is `settleInjection`'s decision and the latch's job,
 *  never a lock left lying around. */
export function releaseInjection(repo: string): void {
  try { fs.unlinkSync(claimFile(repo)); } catch { /* never held, or already gone */ }
}

/**
 * What an injection that has come back means for the latch.
 *
 * `ok` — it was typed and submitted. Latch.
 *
 * NOT ok BUT THE TEXT IS IN THE COMPOSER — latch. `injectTo` reports ONE boolean for failures that
 * mean opposite things, and `loom_cdp.py` puts the distinguishing fact in the NOTE it prints. Its
 * two fast refusals are not alike: "composer not found" typed nothing, while "typed but NOT
 * submitted: … text still in composer (verified)" means the injector put the whole reminder in the
 * orchestrator's composer and only the send button failed. Retrying THAT appends a second copy of
 * the reminder to a composer that already holds one — which is the livegita symptom exactly, a
 * fifteen-second repeat, arriving by a route the boolean cannot see. The note is already passed to
 * the caller, so reading it costs nothing.
 *
 * NOT ok AND IT RAN THE WHOLE TIMEOUT — latch. An injector killed at `INJECT_TIMEOUT_MS` is killed
 * AFTER it has had the composer, so it may have typed and simply never got to say so.
 *
 * NOT ok, FAST, AND NOTHING WAS TYPED — nothing was delivered, so nothing is latched and the next
 * tick may try again. That is the wake rule, applied where it is cheap, not abandoned.
 *
 * The asymmetry is deliberate in one direction: the cost of latching a reminder that was genuinely
 * lost is silence until the next dispatch, and a reminder is advisory; the cost of retrying one that
 * landed is the repeat this whole block exists to close.
 */
/** The injector's own words for "the text is in the composer" — the one fast failure that must not
 *  be retried. Keyed on the phrase loom_cdp.py prints, which is the same discipline inject.ts uses
 *  for the reporting contract: a proxy (elapsed time, an exit code) is what got this wrong before. */
const TYPED_BUT_UNSENT = /typed but NOT submitted/i;

export function settleInjection(ok: boolean, elapsedMs: number, note?: string | null,
                                timeoutMs = INJECT_TIMEOUT_MS): "latch" | "retry" {
  if (ok) return "latch";
  if (note && TYPED_BUT_UNSENT.test(note)) return "latch";
  return elapsedMs >= timeoutMs ? "latch" : "retry";
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
  // function clears `reminded`, which is what makes "once per undelegated stretch" mean what it
  // says.
  if (input.lastDispatch && input.lastDispatch !== st.since) {
    st.since = input.lastDispatch;
    st.busyTicks = 0;
    st.reminded = false;
    st.lastTickAt = null;
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
  // ── THE COUNTER, ONCE PER TICK OF WALL CLOCK AND NOT ONCE PER WINDOW ─────────────────────────
  // Four windows open on one project ticked this same file four times a tick, so "30 minutes of
  // observed work" arrived in seven and a half. The orchestrator being observed is ONE session, so
  // the second window's look at the same minute is the same minute, not more work.
  //
  // `>= tickMs` and not a fraction of it: a whole interval must have passed. `setInterval` fires
  // late rather than early, so a single window is unaffected in practice, and a tick dropped for
  // landing a millisecond early costs one tick out of 120 and errs toward a LATER reminder — the
  // safe direction, and the same direction every other threshold in this file leans.
  if (input.busy) {
    const at = typeof input.at === "number" && Number.isFinite(input.at) ? input.at : null;
    const last = st.lastTickAt ? Date.parse(st.lastTickAt) : NaN;
    // A mark in the FUTURE is not a tick that has not happened yet — it is a clock that stepped, a
    // machine resumed from suspend, or an older build's write. Read literally it would hold the gate
    // shut until wall clock caught up, and on a bus that is failing to dispatch nothing would ever
    // re-open it, because only a dispatch clears the mark. That is the permanent silence, arriving
    // through the half of this block that was supposed to be the cheap half. `claimInjection` above
    // refuses to obey a claim it cannot age out for exactly this reason; the same rule belongs here.
    const stale = !Number.isFinite(last) || (at !== null && last > at);
    const counted = at === null || stale || at - last >= tickMs;
    if (counted) {
      st.busyTicks += 1;
      if (at !== null) st.lastTickAt = new Date(at).toISOString();
    }
  }

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
  // THE LATCH. `reminded` is only ever cleared by a newer dispatch above, so a reported stretch
  // stays reported however long it runs and however the workers flicker. It says nothing about the
  // watermark on purpose — a stretch with no watermark is still a stretch, and DG-001 was the whole
  // cost of letting the two facts share a field.
  if (st.reminded) {
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
  return { ...st, reminded: true, deliveredAt: new Date().toISOString() };
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
