// inject.ts — ONE JOB: put a message in a session's composer via ~/.claude/loom/loom_cdp.py inject.
// Fire-and-forget, never throws, always logs what happened.
//
// The ORCHESTRATOR is found by exact webviewId, not by role MATCHING: loom_cdp.py's find_role() drops
// any frame whose text detects as product-owner (the "self-woke" incident, gaming/board.json), so
// `--role product-owner` alone can never land. `--role` is still passed on every injection; it is
// `--webview-id` naming one frame that makes the content self-guard stand aside, for that frame only.
// Role targeting is still used for workers (`/model ...`, resume nudges), where the guard is correct.

import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { execFile } from "child_process";

import { isOwnerRole } from "./naming";
import { getOrchestrator } from "./orchestrator";

const LOOM_ROOT = path.join(os.homedir(), ".claude", "loom");
const LOOM_CDP = path.join(LOOM_ROOT, "loom_cdp.py");
export const INJECT_TIMEOUT_MS = 60_000;

export interface InjectTarget {
  role: string;
  /** Exact frame, when known. Required to reach the orchestrator; optional for a worker. */
  webviewId?: string | null;
  /**
   * The project this role belongs to. ROLE NAMES ARE PROJECT-SCOPED (the bus directory namespaces
   * them), so a bare name two buses share is ambiguous — loom_cdp.py now refuses such a name rather
   * than guessing the first board in sorted() order (the 2026-09-08 LG-001 misroute), and takes
   * `--repo`. One project per editor window, so this window always knows the answer: pass it.
   */
  repo?: string | null;
}

export interface InjectResult { ok: boolean; note: string; }

// ── THE ORCHESTRATOR IS NEVER CLEARED BY THIS EXTENSION (owner directive 2026-09-16 · CX-001) ──
//
// memory.ts no longer produces a clear step at all; the guard also lives HERE, at the one point every
// injection passes through, so the rule is falsifiable and a future call site inherits it.
//
// A WORKER's `/clear` is untouched — playbook §12 (clear and re-bind between every handoff) is a
// standing owner directive and the ORCHESTRATOR types those clears, not this extension. Likewise
// health.ts's clearReminder / remindClears: that is prose telling an orchestrator to clear its
// workers, and its debug file is named `clear-debug.json`, so a guard keyed on the debug name or on
// the word "clear" would silently undo §12. The key is MESSAGE IS A CLEAR COMMAND *and* TARGET IS AN
// ORCHESTRATOR — both, or nothing.

/**
 * Is this message the context-clearing COMMAND (as opposed to prose that discusses clearing)?
 * A composer executes a line as a command only when it STARTS with the slash — the same rule
 * `withContract` and loom_cdp.py's `compose_outgoing()` use — so leading whitespace is stripped and
 * nothing else counts: clearReminder's mid-sentence "clear <role>" must not read as one. `\b` keeps a
 * future `/clearcache` out, while `/clear` with any argument, in any case, is in.
 */
export function isClearCommand(message: string): boolean {
  return /^\/clear\b/i.test(String(message || "").trimStart());
}

/**
 * Is this target the session that reports upward — the one that must never be cleared by the tool?
 *
 * TWO INDEPENDENT ANSWERS, because each covers the other's gap (mirroring `ModelPolicy.enforce`'s
 * chokepoint in models.ts):
 *   * by NAME — an owner-named role is never a worker; holds on a bus with no tag at all, the state
 *     every project starts in.
 *   * by TAG — catches an orchestrator named something `OWNER_ALIASES` never heard of (measured
 *     2026-09-09: livegita's real orchestrator is `po`, and its tag once read `gitadeveloper`).
 * `taggedRole` is passed in so the decision is PURE and testable without a bus on disk.
 */
export function isOrchestratorTarget(role: string | null | undefined,
                                     taggedRole: string | null | undefined): boolean {
  const r = String(role || "");
  if (!r) return false;
  if (isOwnerRole(r)) return true;
  return !!taggedRole && taggedRole === r;
}

/**
 * The refusal as a pure function: the note to record, or `null` to proceed. Returning the NOTE rather
 * than a boolean puts the reason in the debug log and the caller's `done`, so a refusal is never a
 * silent no-op that looks like a broken injector.
 */
export function clearRefusal(role: string | null | undefined, message: string,
                             taggedRole: string | null | undefined): string | null {
  if (!isClearCommand(message)) return null;
  if (!isOrchestratorTarget(role, taggedRole)) return null;
  const why = isOwnerRole(String(role || "")) ? "an owner-named role" : "this project's tagged orchestrator";
  return `refused: ${role} is ${why}, and this extension never clears an orchestrator ` +
    `(owner directive 2026-09-16). A worker's /clear between handoffs is untouched — playbook §12.`;
}

/** The same decision, reading the tag off the bus. A tag can move between ticks, so it is read fresh
 *  at every injection: a stale answer here is exactly the injection this must not make. */
export function refuseClear(target: { role: string; repo?: string | null }, message: string): string | null {
  if (!isClearCommand(message)) return null;   // the common case — do not touch the disk for it
  let tagged: string | null = null;
  try { tagged = getOrchestrator(target.repo ?? null)?.role ?? null; } catch { /* untagged */ }
  return clearRefusal(target.role, message, tagged);
}

// ── the RETURN ADDRESS (user rule, 2026-09-12: every session broadcasts its ID and how to reply) ──
// loom_cdp.py prefixes every non-command message with a header line; this side supplies who the
// extension is and how to answer it per kind — the extension reads no chat, so a session told to
// "reply" to it would otherwise talk to nobody.
let senderWindow: string | null = null;
/** The workspace folder this window is scoped to; set once at activation. */
export function setSenderWindow(root: string | null): void { senderWindow = root || null; }

// ── WHICH BUILD SAID THIS (MOD-001 §5, from CL-002 §6) ────────────────────────────────────────
// A reminder that cannot name its own build cannot be checked against the tree, so a defect already
// fixed on main goes on arguing for itself out of a stale window (a live `[loom-clears]` read as a
// statement about main turned out to come from 0.44.0). Stamped here, not in the nine message
// builders, so no reminder can be added without provenance — this reaches watchers.ts without
// editing it. SUFFIX only: the `[loom-…]` tag is matched literally by tests and readers.
let buildVersion = "unknown";
/** This build's version, read from the extension's own package.json; set once at activation. */
export function setBuildVersion(v: string | null): void { buildVersion = String(v || "").trim() || "unknown"; }

/** The provenance footer every non-command injection carries. Exported so the claim is testable. */
export function buildStamp(): string { return `[loom-session-tracker ${buildVersion}]`; }

export const REPLY_FOR: Record<string, string> = {
  "notify-debug.json":  "act on the outbox named here; this tool reads no chat",
  "stall-debug.json":   "ring the role named here; this tool reads no chat",
  "restart-debug.json": "for any missing role tab, write ~/.claude/loom/<repo>/open-requests.json",
  // CL-001 · there is nothing to reply TO — the action is the next dispatch, not an answer. Do not
  // harmonise this onto the "reads no chat" formula above: that leaves a reader hunting for a reply.
  "clear-debug.json":   "no reply — clear and re-bind the role named here on your next dispatch to it",
  // PB-001 · the action is a DISPATCH, not an answer. Not "ring the role named here" — wrong the way
  // the stall hint was when it named the orchestrator itself: an uncarryable instruction stops being read.
  "delegate-debug.json": "no reply — write a handoff into the idle role's inbox.md and dispatch it",
  // WC-001 · must not say "stop the watcher named here": the arming is readable but its liveness is
  // not (watchers.ts), so that would assert what the tool cannot see.
  "watch-debug.json":   "no reply — drop the watcher; the tracker's own tick is what wakes you",
  // DU-001 · §19. A SEQUENCING decision with nothing to answer; must not say "tell them to stop" —
  // both workers are doing what their handoff asked, and the dispatcher is who can resolve it.
  "overlap-debug.json": "no reply — sequence the banks, or move one worker off the shared file",
  "resume":             "keep status.json current; nothing else is read",
  "model":              "none needed — your footer is re-read every tick",
  // MC-001 · memory.ts sends THREE messages down one debug log ("context-debug.json"), so one reply
  // key spoke for all three (a restored session was told to "write the memory file"). Keyed by
  // StepKind instead. "abort"/"none" never reach injectTo (extension.ts), so they need no entry.
  "context-save":       "write the memory file named here; nothing else is read",
  // The body IS the literal "/clear", and compose_outgoing() skips the header for anything starting
  // with "/", so this hint is NEVER delivered. Kept as documentation that this subsystem sends the
  // message at all — see MC-001.
  "context-clear":      "no reply — a bare /clear carries no header; this line is never delivered",
  "context-restore":    "no reply — nothing to bank; read the memory file named here and get on with the work it names",
};

// ── the REPORTING CONTRACT (owner directive 2026-09-16 · playbook §21) ─────────────────────────
//
// Attached to the messages themselves, at the one choke point every injection passes through: a rule
// in a doc is advice, and this product has been bitten three times by a rule that lived in prose
// while the tool kept typing something else. A new orchestrator-facing message cannot be added
// without choosing a side of the table below.
//
// ONE BOUNDARY ONLY: orchestrator → human. A WORKER's report MUST keep its full counts, grade blocks
// and measurements — that is the evidence a block is banked on — so the worker kinds are excluded
// deliberately, and that exclusion is the load-bearing half of this table.
//
// DU-001 (2026-09-17 rewrite): the banned things are NAMED (counts, hashes, versions, paths, ids)
// because a checkable list is enforceable where the old "not figures" category was arguable; it asks
// for DIRECTION, not the past; "the decision the owner must make" is REMOVED because as a standing
// instruction it funnels every question onto the one person who cannot be parallelised — "ask only
// what is his; decide the rest" keeps escalation open for direction, priorities, his
// money/machine/time, anything leaving the machine, anything expensive and irreversible; "he will
// ask" makes detail PULL.
//
// KEPT TO ONE LINE, and shorter than what it replaced (asserted by test): this line rides on EVERY
// orchestrator message, so a "fix" that lengthened it would be the complaint, shipped.
export const REPORTING_CONTRACT =
  "[contract] To the owner, in bullets: what works, what a user cannot do, where it goes next. " +
  "No counts, hashes, versions, paths, ids. Ask only what is his; decide the rest. He will ask.";

/**
 * The message kinds that reach an ORCHESTRATOR — the session that reports upward to the human.
 * Keyed by the same string `senderArgs` is (`replyKind ?? debugName`), so the two tables cannot
 * drift apart. Measured against every `injectTo` call site in the extension (PD-001 §3).
 */
export const ORCHESTRATOR_KINDS: ReadonlySet<string> = new Set([
  "notify-debug.json",   // notifier.ts   — a worker finished / raised a loop-back
  "stall-debug.json",    // health.ts     — a worker looks stuck
  "clear-debug.json",    // health.ts     — a worker has carried too many blocks unclear
  "restart-debug.json",  // extension.ts  — the editor restarted; pick the work back up
  "ledger-debug.json",   // extension.ts  — the once-a-day work-ledger alert
  "brief-debug.json",    // extension.ts  — the work-ledger briefing at a dispatch point
  "delegate-debug.json", // delegation.ts — you have been working alone while a role sat idle
  "watch-debug.json",    // watchers.ts   — §17: this session armed a watcher; the tick already wakes you
  "overlap-debug.json",  // duties.ts     — §19: two of your live blocks are editing the same file
  "context-save",        // memory.ts     — write your working memory before the clear
  "context-restore",     // memory.ts     — fresh context; here is who you are and what to read
  // "context-clear" is UNREACHABLE as of CX-001, and was never in this set anyway: a command carries
  // no header and no contract (see `withContract`).
]);

/**
 * The kinds that reach a WORKER. Not merely "everything else": named, so the exclusion is on the
 * record and a reviewer can see `gate-debug.json` was considered and kept out. A worker owes its
 * orchestrator counts and measurements; the contract would suppress them.
 */
export const WORKER_KINDS: ReadonlySet<string> = new Set([
  "gate-debug.json",     // health.ts  — YOUR gate exited; read its log and write your grade counts
  "spawn-debug.json",    // extension.ts — "/model …" and "/loom <role>", commands either way
  "resume",              // a resume nudge
  "model",               // a tier switch
]);

/**
 * The text that actually gets typed: the message, plus the contract when this kind reaches an
 * orchestrator. Pure, so the claim ("this kind carries it, that kind does not") is testable.
 *
 * A COMMAND NEVER CARRIES IT: compose_outgoing() returns anything starting with "/" untouched,
 * because the composer would execute the whole line — appending would corrupt the command.
 */
export function withContract(kind: string, message: string): string {
  const msg = String(message || "");
  if (!msg.trim() || msg.trimStart().startsWith("/")) return msg;
  // The build stamp goes on EVERY non-command message, worker-facing included — a worker reading
  // "[loom-gate] your gate exited" needs to know which build watched it. Hence stamping BEFORE the
  // kind test. The contract stays orchestrator-only, and that exclusion is load-bearing.
  const stamped = `${msg}\n\n${buildStamp()}`;
  if (!ORCHESTRATOR_KINDS.has(kind)) return stamped;
  return `${stamped}\n\n${REPORTING_CONTRACT}`;
}

/** argv fragment naming the sender and the reply channel, for every inject the extension makes. */
export function senderArgs(kind: string, repo: string | null): string[] {
  const who = `loom-session-tracker (window ${senderWindow || "(no folder)"}${repo ? `, project ${repo}` : ""})`;
  const how = (REPLY_FOR[kind] || "none — this is a tool, not a session").replace("<repo>", repo || "<repo>");
  return ["--from", who, "--reply", how];
}

/**
 * What an injection actually did, read off the injector's OUTPUT and not off its exit code:
 * loom_cdp.py exits 0 and prints a result dict even when it could not find the frame or could not
 * confirm the typed text (measured 2026-09-14, MS-001 R2: the model policy trusted the exit code and
 * recorded that refusal as "switched"). `ok` is: no error AND the printed dict does not carry
 * ok=False; the failure note is the dict's own. One reading for every injection — `injectTo` below
 * and `ModelPolicy.enforce`.
 */
export function injectVerdict(err: Error | null | undefined, stdout: string | Buffer | null | undefined,
                              stderr: string | Buffer | null | undefined): InjectResult & { reportedFail: boolean } {
  const out = String(stdout || "");
  const reportedFail = /'ok':\s*False|"ok":\s*false/i.test(out);
  const ok = !err && !reportedFail;
  const note = ok ? "injected"
    : reportedFail ? (/'note':\s*'([^']+)'/.exec(out)?.[1] || "inject reported not ok")
    : String((err && err.message) || stderr || "inject failed");
  return { ok, note, reportedFail };
}

/**
 * Type `message` into the target's composer and submit it. Never throws; `done` always gets a verdict.
 * `debugName` is a file under ~/.claude/loom recording the last attempt (out/err truncated), so a
 * silent failure is diagnosable after the fact.
 */
export function injectTo(target: InjectTarget, message: string, debugName: string,
                         done?: (ok: boolean, note: string) => void, replyKind?: string): void {
  // `debugName` is where the attempt is LOGGED; `replyKind` is what REPLY_FOR is keyed by. Usually
  // the same string, but memory.ts writes three KINDS down one debug file, so a caller sending more
  // than one kind must pass `replyKind`. PD-001 · the reporting contract rides the SAME key as the
  // reply hint, attached here rather than at the nine call sites so no orchestrator-facing message
  // can be added without one and no worker-facing one can pick it up by accident.
  const kind = replyKind ?? debugName;
  // CX-001 · BEFORE anything is composed or spawned, so no future edit between here and the execFile
  // can slip past it. A non-clear message never reads the bus.
  const refusal = refuseClear(target, message);
  if (refusal) {
    try {
      fs.writeFileSync(path.join(LOOM_ROOT, debugName), JSON.stringify({
        at: new Date().toISOString(), target, ok: false, note: refusal, refused: true,
        message: String(message || "").slice(0, 300), contract: false, out: "", err: "",
      }, null, 2));
    } catch { /* a failed log must never break the caller */ }
    done?.(false, refusal);
    return;
  }
  const outgoing = withContract(kind, message);
  const args = [LOOM_CDP, "inject", "--role", target.role, "--message", outgoing, "--submit",
                ...senderArgs(kind, target.repo ?? null)];
  if (target.webviewId) args.push("--webview-id", target.webviewId);
  if (target.repo) args.push("--repo", target.repo);
  execFile("python3", args, { timeout: INJECT_TIMEOUT_MS }, (err, stdout, stderr) => {
    const out = String(stdout || "");
    const { ok, note } = injectVerdict(err, stdout, stderr);
    try {
      fs.writeFileSync(path.join(LOOM_ROOT, debugName), JSON.stringify({
        at: new Date().toISOString(), target, ok, note,
        // what was actually TYPED, contract included — logging the pre-contract text would hide it
        // in the only record of the injection.
        message: outgoing.slice(0, 300),
        // …and the contract sits at the END, so the 300-char truncation above hides it on any longer
        // body (the briefing is 517) and the log would read as though it never went. This flag is the
        // claim itself. MOD-001 §5: it used to read `outgoing !== message`, a proxy that now reports
        // a worker's gate wake as carrying the contract (the exact claim PD-001 denies) because the
        // build stamp also appends. Keyed on the contract's own text, which cannot drift.
        contract: outgoing.includes(REPORTING_CONTRACT),
        /** Which build sent it — the debug file is what gets read when a reminder is disputed, and it
         *  is usually read instead of the message. */
        build: buildVersion,
        // PD-001 · 800, not 400: the contract occupies ~190 chars of any tail and pushed the
        // subcommand and role — WHAT WAS RUN — out of the window.
        out: out.slice(-800), err: String((err && err.message) || stderr || "").slice(-400),
      }, null, 2));
    } catch { /* a failed log must never break the caller */ }
    done?.(ok, note);
  });
}
