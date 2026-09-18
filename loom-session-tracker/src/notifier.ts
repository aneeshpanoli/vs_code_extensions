// notifier.ts — ONE JOB: watch each worker's status.json on the bus and, when a worker FINISHES
// (working -> idle/blocked), notify the tagged orchestrator session so it can pick up the outbox
// without the human relaying. Notification = a toast for the human + an injected "check outbox"
// prompt into the orchestrator's composer via the battle-tested loom_cdp.py inject path.
// FAIL-PROOF: every read is try/caught; a missing/foreign status.json is just skipped; injection
// failures are logged to the bus (notify-debug.json), never thrown.
//
// NF-001 · A FINISH IS RETIRED WHEN IT IS DELIVERED, NEVER WHEN IT IS DETECTED. Detection only
// QUEUES: `pending` holds what the orchestrator is owed, and a key reaches `announced` (= delivered)
// through `settle` alone. The orchestrator is mid-turn precisely when it is working, so the busy
// composer refuses exactly the messages most worth sending; retiring at detection made every one of
// those a finish nobody was ever told about. delegation.ts had already argued this for a reminder,
// which is advisory — this is the one message the whole bus exists to carry.

import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { injectTo } from "./inject";
import { boardRoles } from "./registry";
import { getOrchestrator } from "./orchestrator";
import { isWorkingLike } from "./health";

const LOOM_ROOT = path.join(os.homedir(), ".claude", "loom");

interface RoleStatus { status: string; current?: string; last_line?: string; updated_at?: string; }

/** What the notifier remembers between ticks — persisted on the bus so it survives an IDE restart
 *  (a worker that finished while the IDE was closed still gets announced) and so two windows
 *  watching the same repo can't both announce the same finish. */
interface NotifyState {
  prev: Record<string, { status: string; current: string }>;
  /** DELIVERED keys. Before NF-001 this word meant "detected", and the rename is the whole fix. */
  announced: string[];
  /** Owed to the orchestrator and not yet delivered. At most one per role (see `scan`). */
  pending: PendingEvent[];
  /** Finishes that left the queue WITHOUT being delivered, newest last. Nothing else on this bus
   *  records them, and a drop nobody can see is the original defect wearing a different hat. */
  dropped?: DroppedEvent[];
  updatedAt?: string;
}

const ANNOUNCED_CAP = 500;
const DROPPED_CAP = 20;
/** A backstop, not a policy. The queue is already one-per-role; this only stops a role that will
 *  never come back from sitting in the state file forever. */
const PENDING_MAX_AGE_MS = 24 * 60 * 60 * 1000;
/** How long an undelivered finish may sit before it is a fact somebody has to act on. */
export const BACKLOG_WARN_MS = 10 * 60 * 1000;
/** RETRY FLAT AT FIRST, THEN EASE OFF. A mid-turn orchestrator often frees within a tick or two, so
 *  the first FIVE attempts go on consecutive ticks — about a minute at the 15 s default — and only
 *  then does the wait grow. Past that, an event that keeps being refused would spawn an injector
 *  every 15 s for as long as it is owed (5,760 processes a day for ONE finish) to buy back a delay
 *  capped at two minutes. `attempts` was recorded and acted on nowhere. */
const RETRY_FLAT_ATTEMPTS = 4;
const RETRY_BACKOFF_MS = 60_000;
const RETRY_BACKOFF_CAP_MS = 120_000;

function stateFile(repo: string): string { return path.join(LOOM_ROOT, repo, "notify-state.json"); }

function loadState(repo: string): NotifyState | null {
  try {
    const st = JSON.parse(fs.readFileSync(stateFile(repo), "utf8"));
    if (st && typeof st === "object" && st.prev && typeof st.prev === "object") {
      // A 0.62.0 state file has no `pending` and its `announced` means DETECTED. It is carried over
      // as-is and NOT cleared: clearing would re-announce every finish already acted on, on every
      // bus, at upgrade. The events that build lost stay lost — the same ones it had already lost —
      // and the first finish after the upgrade is delivered under the new rule.
      return {
        prev: st.prev,
        announced: Array.isArray(st.announced) ? st.announced : [],
        pending: Array.isArray(st.pending) ? st.pending.filter(isPending) : [],
        dropped: Array.isArray(st.dropped) ? st.dropped : [],
      };
    }
  } catch { /* none yet */ }
  return null;
}

function isPending(p: any): p is PendingEvent {
  return !!p && typeof p === "object" && typeof p.key === "string" && typeof p.role === "string" &&
         typeof p.repo === "string" && typeof p.status === "string" && typeof p.id === "string";
}

/** Atomic, change-only, never throws. */
function saveState(repo: string, st: NotifyState): void {
  try {
    const next = JSON.stringify({ ...st, updatedAt: new Date().toISOString() }, null, 2);
    const f = stateFile(repo);
    try {
      const cur = JSON.parse(fs.readFileSync(f, "utf8"));
      // ignore updatedAt when deciding whether anything actually changed (no churn every tick)
      if (JSON.stringify({ prev: cur.prev, announced: cur.announced, pending: cur.pending,
                           dropped: cur.dropped }) ===
          JSON.stringify({ prev: st.prev, announced: st.announced, pending: st.pending,
                           dropped: st.dropped })) return;
    } catch { /* missing -> write */ }
    fs.mkdirSync(path.dirname(f), { recursive: true });
    const tmp = f + ".tmp." + process.pid;
    fs.writeFileSync(tmp, next);
    fs.renameSync(tmp, f);
  } catch { /* never throw from a tick */ }
}

export interface FinishEvent {
  repo: string;
  role: string;
  status: string;        // idle | blocked (the post-work state)
  task: string;          // handoff id ('' if none recorded)
  lastLine: string;
}

/** A finish event the orchestrator is owed. `attempts` and `lastNote` are what a reader of the bus
 *  sees when delivery keeps failing — the toast is a popup for a human looking at the editor, and
 *  the party that has to act on a stuck notification is an agent. */
export interface PendingEvent extends FinishEvent {
  /** THIS QUEUED INSTANCE, and not the kind of thing it is. `key` is `role|task|status` and a role
   *  that reruns the same handoff produces the SAME key twice — `notifier.test.js` has a suite for
   *  exactly that. An injection may still be in flight while a second finish under that key is
   *  queued (60 s timeout against a 15 s tick), and a `settle` matching on `key` would then retire
   *  an event it never delivered: NF-001's own defect, wearing the retirement key. */
  id: string;
  key: string;
  firstSeen: string;     // ISO — the instant the worker finished, not the instant we got through
  attempts: number;
  lastNote?: string;
  lastAttemptAt?: string;
  /** Not before this instant — see RETRY_FLAT_ATTEMPTS. Absent means "now". */
  nextAttemptAt?: string;
}

/** A finish that left the queue without reaching anybody. */
export interface DroppedEvent {
  key: string; role: string; task: string; firstSeen: string; at: string; why: string;
  attempts: number;
}

function readStatus(repo: string, role: string): RoleStatus | null {
  try {
    const s = JSON.parse(fs.readFileSync(path.join(LOOM_ROOT, repo, role, "status.json"), "utf8"));
    if (s && typeof s.status === "string") return s;
  } catch { /* no status yet */ }
  return null;
}

/** What the bus is owed right now, for whoever has to act on it being owed. */
export interface Backlog {
  count: number; oldestAgeMs: number; oldest: PendingEvent | null;
  /** Finishes that reached NOBODY. Not an error the tracker can fix — a fact whoever reads this
   *  bus has to act on, which is the whole of the handoff's fifth requirement. */
  dropped: DroppedEvent[];
}

export class Notifier {
  constructor(private repo: string | null) {}

  /**
   * One pass. Returns the finish events newly QUEUED this tick (never throws). Detection no longer
   * retires anything: the return value is what to put in front of the human, and `duePending` is
   * what to deliver.
   *
   * State lives on the bus, so the comparison baseline survives an IDE restart: work that completed
   * while the editor was closed is announced on the first tick after it comes back. Only a bus that
   * has never been scanned baselines silently.
   */
  scan(now = Date.now()): FinishEvent[] {
    if (!this.repo) return [];
    const orch = getOrchestrator(this.repo);
    const persisted = loadState(this.repo);
    const prev = persisted ? new Map(Object.entries(persisted.prev)) : null;
    const announced = new Set<string>(persisted?.announced ?? []);
    // keyed by role: SUPERSEDED means one per role. A finish says "read this role's outbox", and
    // the newest such statement is the true one — an older undelivered finish for the same role is
    // about an outbox that has since been written again, so delivering it would point at the same
    // file with a stale reason.
    const pending = new Map<string, PendingEvent>();
    for (const p of persisted?.pending ?? []) pending.set(p.role, p);

    const events: FinishEvent[] = [];
    /** The events this pass ADDED — the only ones the merge below has to carry in itself. */
    const queued: PendingEvent[] = [];
    /** Roles observed WORKING-LIKE this pass — the supersede set, applied at save against a fresh
     *  read rather than against the snapshot this pass started from. */
    const working = new Set<string>();
    const cur: Record<string, { status: string; current: string }> = {};
    for (const role of boardRoles(this.repo)) {
      if (orch && role === orch.role) continue;    // never watch the orchestrator itself
      const s = readStatus(this.repo, role);
      if (!s) continue;
      cur[role] = { status: s.status, current: String(s.current || "") };
      // A role back at work clears its old announcements, so its NEXT finish is announced
      // even if it repeats the same handoff id.
      if (isWorkingLike(s.status)) {
        for (const k of Array.from(announced)) if (k.startsWith(role + "|")) announced.delete(k);
        // …AND IT SUPERSEDES WHAT IT WAS OWED. Recorded here, ACTED ON AT THE MERGE and nowhere
        // else: a `pending.delete(role)` on this line as well read like the rule and was inert,
        // because the merge decides the queue against a fresh read and never consults this map. A
        // mutant that deleted it survived the whole suite, which is how it was found — and a second
        // copy of a rule is exactly what DG-001-R2 caught between digest.ts and gc.ts.
        working.add(role);
        continue;
      }
      const before = prev?.get(role);
      // WORKING-LIKE, not literally "working". The protocol says idle | working | blocked, but the
      // sessions do not all obey it — measured 2026-09-08, shwab_docker/trader sat in "active" and
      // livegita/po in "orchestrating". Comparing `before.status === "working"` meant a role that
      // works under any other name could NEVER announce a finish: the transition was invisible and
      // the orchestrator was never told. health.ts already reports this as a protocol violation;
      // now the notifier survives it instead of going silent. (Finishing INTO an off-protocol status
      // always worked — only the baseline was too strict.)
      if (!before || !isWorkingLike(before.status)) continue;   // only working -> done counts
      const task = String(s.current || before.current || "");
      const key = `${role}|${task}|${s.status}`;
      if (announced.has(key)) continue;                    // already DELIVERED
      if (pending.get(role)?.key === key) continue;        // already owed; not owed twice
      const ev: FinishEvent = {
        repo: this.repo, role, status: s.status, task,
        lastLine: String(s.last_line || "").slice(0, 160),
      };
      const queuedEv: PendingEvent = {
        ...ev, key, id: `${key}#${now}-${Math.random().toString(36).slice(2, 8)}`,
        firstSeen: new Date(now).toISOString(), attempts: 0,
      };
      pending.set(role, queuedEv);
      queued.push(queuedEv);
      events.push(ev);
    }

    // Never-scanned bus: record the baseline, announce nothing.
    const firstEver = prev === null;
    if (firstEver) { saveState(this.repo, { prev: cur, announced: [], pending: [], dropped: [] }); return []; }

    // ── THE SAVE IS A MERGE, NOT A WRITE-BACK ────────────────────────────────────────────────────
    // Everything above was decided from a snapshot taken at the top of this pass, and a pass reads
    // `board.json` plus one `status.json` per role before it gets here — milliseconds of file I/O
    // in which a `settle` can land: this window's own injection callback, or another window's, on
    // the state file they share. Writing the snapshot back would erase that delivery AND resurrect
    // the event it delivered, which is a second copy typed into the composer and a delivery record
    // rolled back. `settle` already re-reads for this reason; a scan that did not was the same gap
    // at the other end of the same injection.
    const fresh = loadState(this.repo) ?? { prev: {}, announced: [], pending: [], dropped: [] };
    const announcedFinal = fresh.announced.filter((k) => !working.has(k.split("|")[0]));
    const delivered = new Set(announcedFinal);
    const dropped: DroppedEvent[] = [];
    const drop = (p: PendingEvent, why: string) =>
      dropped.push({ key: p.key, role: p.role, task: p.task, firstSeen: p.firstSeen,
                     at: new Date(now).toISOString(), why, attempts: p.attempts || 0 });
    let queue: PendingEvent[] = [];
    for (const p of fresh.pending) {
      if (working.has(p.role)) { drop(p, "superseded: the role went back to work"); continue; }
      if (delivered.has(p.key)) continue;                     // settled while this pass was reading
      const at = Date.parse(p.firstSeen || "");
      if (Number.isFinite(at) && now - at >= PENDING_MAX_AGE_MS) {
        drop(p, "expired: owed for a day and never delivered"); continue;
      }
      queue.push(p);
    }
    // ONE PER ROLE still holds after the merge: if a fresher pass already queued something for this
    // role, ours is the same observation seen twice, not a second finish.
    for (const ev of queued) {
      if (delivered.has(ev.key)) continue;                    // delivered under our feet
      if (!queue.some((p) => p.role === ev.role)) queue.push(ev);
    }
    queue.sort((a, b) => Date.parse(a.firstSeen) - Date.parse(b.firstSeen));
    saveState(this.repo, {
      prev: cur, announced: announcedFinal.slice(-ANNOUNCED_CAP), pending: queue,
      dropped: [...(fresh.dropped ?? []), ...dropped].slice(-DROPPED_CAP),
    });
    return events;
  }

  /**
   * The ONE finish event to deliver on this tick, oldest first, or null.
   *
   * ONE PER TICK, AND THEY DO NOT COALESCE. If five workers finished while the orchestrator was
   * mid-turn, it gets five messages on five successive ticks in the order the workers finished —
   * not five at once, and not one merged message. Each event names a different role's outbox and a
   * different handoff; merging them would make ONE composer entry the orchestrator has to
   * decompose, and — the deciding reason — a merged message can only be retired as a whole, so a
   * refusal that arrives after the first outbox was read would either re-deliver the lot or retire
   * what was never read. One event, one delivery, one retirement. The pacing costs a tick per
   * worker and buys an orchestrator that can go busy again after any one of them without losing
   * the rest.
   */
  duePending(now = Date.now()): PendingEvent | null {
    if (!this.repo) return null;
    const st = loadState(this.repo);
    for (const p of st?.pending ?? []) {
      const not = Date.parse(p.nextAttemptAt || "");
      if (Number.isFinite(not) && now < not) continue;        // backing off, not forgotten
      return p;
    }
    return null;
  }

  /**
   * Record what an injection did. `verdict` comes from `settleInjection` in delegation.ts — the same
   * discrimination, not a second copy of it: loom_cdp.py's fast `ok:False` is TWO failures, and
   * "typed but NOT submitted … text still in composer (verified)" means the message IS in the
   * composer, so retrying it appends a duplicate. Reading the boolean alone would re-open the very
   * defect DG-001-R1 closed.
   *
   * RE-READS the state rather than writing back what the caller captured: the injector may have
   * been running for up to a minute, and this window's later ticks (and other windows) have moved
   * on since.
   */
  settle(ev: PendingEvent, verdict: "latch" | "retry", note?: string | null,
         now = Date.now()): void {
    if (!this.repo) return;
    const st = loadState(this.repo) ?? { prev: {}, announced: [], pending: [], dropped: [] };
    const announced = new Set(st.announced);
    // MATCHED ON THE INSTANCE, AND THE GUARD APPLIES TO BOTH VERDICTS. The role may have gone back
    // to work while the injector was typing, which drops what it was owed — and may then have
    // FINISHED AGAIN under the same `role|task|status` key, since rerunning a handoff is ordinary
    // here. Retiring by key would mark that second finish delivered on the strength of an injection
    // that carried the first: a finish retired without being delivered, which is the exact defect
    // this block exists to close. If the instance we injected is gone, this settle records nothing.
    const still = st.pending.some((p) => p.id === ev.id);
    if (!still) return;
    if (verdict === "latch") {
      announced.add(ev.key);
      st.pending = st.pending.filter((p) => p.id !== ev.id);
    } else {
      st.pending = st.pending.map((p) => {
        if (p.id !== ev.id) return p;
        const attempts = (p.attempts || 0) + 1;
        const wait = attempts <= RETRY_FLAT_ATTEMPTS ? 0
          : Math.min(RETRY_BACKOFF_MS * (attempts - RETRY_FLAT_ATTEMPTS), RETRY_BACKOFF_CAP_MS);
        return { ...p, attempts, lastNote: String(note || "").slice(0, 160),
                 lastAttemptAt: new Date(now).toISOString(),
                 ...(wait ? { nextAttemptAt: new Date(now + wait).toISOString() } : {}) };
      });
    }
    saveState(this.repo, { prev: st.prev, announced: Array.from(announced).slice(-ANNOUNCED_CAP),
                           pending: st.pending, dropped: st.dropped ?? [] });
  }

  /** What is owed and for how long — the fact a toast cannot carry. Written to the bus by the
   *  caller so an AGENT can read it; `notify-state.json` holds the queue itself, attempts and the
   *  injector's last refusal included. */
  backlog(now = Date.now()): Backlog {
    const st = (this.repo && loadState(this.repo)) || null;
    const q = st?.pending ?? [];
    const dropped = st?.dropped ?? [];
    if (!q.length) return { count: 0, oldestAgeMs: 0, oldest: null, dropped };
    const oldest = q[0];
    const at = Date.parse(oldest.firstSeen || "");
    return { count: q.length, oldestAgeMs: Number.isFinite(at) ? Math.max(0, now - at) : 0,
             oldest, dropped };
  }

  /** Inject a "check the outbox" prompt into the orchestrator's composer. Fire-and-forget.
   *  Addressed by the tag's FRAME id when it has one: `--role product-owner` cannot reach the
   *  orchestrator at all (loom_cdp.py's self-guard drops owner-detected frames), which is why this
   *  path had never actually delivered anything. */
  notifyOrchestrator(ev: FinishEvent, done?: (ok: boolean, note: string) => void): void {
    const orch = getOrchestrator(ev.repo);
    if (!orch) { done?.(false, "no orchestrator tagged"); return; }
    const verb = ev.status === "blocked" ? "raised a loop-back (blocked)" : "finished";
    const msg =
      `[loom-notify] ${ev.role} ${verb}${ev.task ? ` on ${ev.task}` : ""}` +
      `${ev.lastLine ? ` — "${ev.lastLine}"` : ""}. ` +
      `Read ~/.claude/loom/${ev.repo}/${ev.role}/outbox.md and act on it.`;
    injectTo({ role: orch.role, webviewId: orch.webviewId, repo: ev.repo }, msg, "notify-debug.json", done);
  }

}
