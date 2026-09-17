// inject.ts — ONE JOB: put a message in a session's composer, through the one battle-tested path
// (~/.claude/loom/loom_cdp.py inject). Fire-and-forget, never throws, always logs what happened.
//
// WHY THIS EXISTS AS ITS OWN MODULE: three call sites (finish notifier, stall alert, context memory) all
// need to reach the ORCHESTRATOR, and reaching the orchestrator by ROLE does not work. loom_cdp.py's
// find_role() carries a deliberate self-guard: any frame whose text detects as product-owner is dropped
// from the candidate rows, and frames absent from the targetmap are dropped too. That guard exists because
// content-based matching once injected a worker's prompt into the orchestrator's own tab (the "self-woke"
// recorded in gaming/board.json). It also means `inject --role product-owner` can never land.
//
// So the orchestrator is addressed by its exact webviewId instead — the stable UUID the tracker already
// reads off the frame's shell URL, recorded on the tag. That is strictly safer than matching on content:
// there is nothing to misidentify. `--webview-id` tells loom_cdp.py the caller knows the frame, and the
// content self-guard steps aside for that ONE frame only.
//
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
   * The project this role belongs to. ROLE NAMES ARE PROJECT-SCOPED — the bus directory namespaces
   * them — so a bare name that two buses share (`developer`: Gaming + livegita; `productowner`:
   * Gaming + shwab_docker, both measured live 2026-09-09) is ambiguous on its own.
   *
   * loom_cdp.py's `_role_repo()` used to resolve such a name by scanning every board and taking the
   * FIRST hit, and sorted() puts `Gaming` first — so a livegita binding was written to Gaming's bus.
   * That is the 2026-09-08 LG-001 misroute, and the reason livegita's developer was ever renamed
   * `gitadeveloper`. It now refuses an ambiguous bare name instead of guessing, and takes `--repo`.
   *
   * One project per editor window, so this window always knows the answer — pass it and the prefix
   * workaround is unnecessary.
   */
  repo?: string | null;
}

export interface InjectResult { ok: boolean; note: string; }

// ── THE ORCHESTRATOR IS NEVER CLEARED BY THIS EXTENSION (owner directive 2026-09-16 · CX-001) ──
//
// "Do not ever clear the orchestrator's context. Remove that from the loom-session-tracker add-on."
//
// WHY A GUARD AND NOT ONLY A DELETION. memory.ts no longer produces a clear step at all, and that
// deletion is the real removal. But a property enforced only by the absence of a call site is
// unfalsifiable — there is nothing left to mutate, nothing to assert against, and the next person to
// add a trigger inherits nothing. So the rule also lives HERE, at the one point every injection
// passes through, keyed on WHO the target is. A caller written next month gets the refusal without
// knowing this rule exists.
//
// WHAT IS NOT TOUCHED, AND THIS IS THE HALF THAT MATTERS: a WORKER's `/clear`. Playbook §12 — a
// worker is cleared and re-bound between every handoff — is a standing owner directive from
// 2026-09-08, and it is the ORCHESTRATOR that types those clears, not this extension. The guard is
// keyed on the TARGET'S ROLE, so a worker-addressed clear passes through byte-identical.
//
// Nor does it touch `health.ts`'s `clearReminder` / `remindClears`: that is prose ("[loom-clears] …
// clear <role> and re-bind it on your NEXT dispatch") telling an orchestrator to clear its WORKERS.
// It is orchestrator-addressed and its debug file is literally named `clear-debug.json`, so a guard
// keyed on the debug NAME, or on the word "clear" appearing anywhere, would silently undo §12. The
// key is: the MESSAGE IS A CLEAR COMMAND, and the TARGET IS AN ORCHESTRATOR. Both, or nothing.

/**
 * Is this message the context-clearing COMMAND (as opposed to prose that merely discusses clearing)?
 *
 * A composer executes a line as a command only when it STARTS with the slash — which is the same
 * rule `withContract` below already relies on, and the same one loom_cdp.py's `compose_outgoing()`
 * uses. So leading whitespace is stripped and nothing else counts: `clearReminder`'s body mentions
 * "clear <role>" in the middle of a sentence and is not a command, and must not be read as one.
 * `\b` after `clear` so a future `/clearcache` is not swept up by accident, while `/clear` with any
 * argument, or in any case, is.
 */
export function isClearCommand(message: string): boolean {
  return /^\/clear\b/i.test(String(message || "").trimStart());
}

/**
 * Is this target the session that reports upward — the one that must never be cleared by the tool?
 *
 * TWO INDEPENDENT ANSWERS, because neither alone is sufficient and each covers the other's gap.
 * Mirrors `ModelPolicy.enforce`'s chokepoint (models.ts), deliberately: one rule, recognisable twice.
 *   * by NAME — an owner-named role is never a worker, tagged or not (`isOwnerRole`). This holds on a
 *     bus with no tag at all, which is the state every project starts in.
 *   * by TAG — the role this project has actually tagged as its orchestrator. This catches a project
 *     whose orchestrator is named something `OWNER_ALIASES` has never heard of; measured 2026-09-09,
 *     livegita's real orchestrator is named `po`, and its tag once read `{"role":"gitadeveloper"}`.
 * `taggedRole` is passed in rather than read here so the whole decision is a PURE function and the
 * claim is testable without a bus on disk.
 */
export function isOrchestratorTarget(role: string | null | undefined,
                                     taggedRole: string | null | undefined): boolean {
  const r = String(role || "");
  if (!r) return false;
  if (isOwnerRole(r)) return true;
  return !!taggedRole && taggedRole === r;
}

/**
 * The refusal, as a pure function: the note to record when this injection must not happen, or `null`
 * when it may proceed. Returning the NOTE rather than a boolean means the reason reaches the debug
 * log and the caller's `done`, so a refusal is never a silent no-op — the failure mode that would
 * make this look like a broken injector rather than an enforced rule.
 */
export function clearRefusal(role: string | null | undefined, message: string,
                             taggedRole: string | null | undefined): string | null {
  if (!isClearCommand(message)) return null;
  if (!isOrchestratorTarget(role, taggedRole)) return null;
  const why = isOwnerRole(String(role || "")) ? "an owner-named role" : "this project's tagged orchestrator";
  return `refused: ${role} is ${why}, and this extension never clears an orchestrator ` +
    `(owner directive 2026-09-16). A worker's /clear between handoffs is untouched — playbook §12.`;
}

/** The same decision, reading the tag off the bus. A tag can be set or moved between ticks, so it is
 *  read fresh at every injection: a stale answer here is exactly the injection this must not make. */
export function refuseClear(target: { role: string; repo?: string | null }, message: string): string | null {
  if (!isClearCommand(message)) return null;   // the common case — do not touch the disk for it
  let tagged: string | null = null;
  try { tagged = getOrchestrator(target.repo ?? null)?.role ?? null; } catch { /* untagged */ }
  return clearRefusal(target.role, message, tagged);
}

// ── the RETURN ADDRESS (user rule, 2026-09-12) ─────────────────────────────────────────────────
// "Any time any session communicates with another, it should always broadcast its ID and how to
// communicate back." loom_cdp.py prefixes every non-command message with a header line; this side
// supplies who the extension is and how a session should answer it, per kind of message — because
// the extension reads no chat, and a session told to "reply" to it would otherwise talk to nobody.
let senderWindow: string | null = null;
/** The workspace folder this window is scoped to; set once at activation. */
export function setSenderWindow(root: string | null): void { senderWindow = root || null; }

// ── WHICH BUILD SAID THIS (MOD-001 §5, from CL-002 §6) ────────────────────────────────────────
//
// An alarm in the owner's window used to be unfalsifiable evidence. A live `[loom-clears]` was read
// as a statement about `main`, and establishing that it had actually come from 0.44.0 — a stale
// build in one window, already fixed on main — cost a whole block's attention. A reminder that
// cannot name its own build cannot be checked against the tree, so a fixed defect goes on arguing
// for itself out of a window nobody reloaded.
//
// STAMPED HERE, not in the nine message builders, for the same reason the reporting contract is
// (see `withContract`): every injected message passes through this one point, so no reminder can be
// ADDED without provenance and none can drift out of it. It also reaches the reminders this block
// may not edit — `watchers.ts` is owned by another live handoff — without touching their files.
//
// It is a SUFFIX and it leaves the `[loom-…]` tag alone: the tag is matched literally by tests and
// by readers, and widening it to `[loom-clears 0.52.0]` would break those matches to say the same
// thing in a place with less room. One short line, for the reason the contract is one line.
let buildVersion = "unknown";
/** This build's version, read from the extension's own package.json; set once at activation. */
export function setBuildVersion(v: string | null): void { buildVersion = String(v || "").trim() || "unknown"; }

/** The provenance footer every non-command injection carries. Exported so the claim is testable. */
export function buildStamp(): string { return `[loom-session-tracker ${buildVersion}]`; }

export const REPLY_FOR: Record<string, string> = {
  "notify-debug.json":  "act on the outbox named here; this tool reads no chat",
  "stall-debug.json":   "ring the role named here; this tool reads no chat",
  "restart-debug.json": "for any missing role tab, write ~/.claude/loom/<repo>/open-requests.json",
  // CL-001 · there is nothing to reply TO — the action is the next dispatch, not an answer. Saying
  // "reads no chat" alone would leave an orchestrator looking for something to respond to.
  "clear-debug.json":   "no reply — clear and re-bind the role named here on your next dispatch to it",
  // PB-001 · the action is a DISPATCH, not an answer. "Ring the role named here" would be wrong in
  // the same way the stall hint was wrong when it named the orchestrator itself: an instruction that
  // cannot be carried out teaches the reader to stop reading.
  "delegate-debug.json": "no reply — write a handoff into the idle role's inbox.md and dispatch it",
  // WC-001 · the action is to STOP something, and there is nothing to answer. It must also not say
  // "stop the watcher named here": the arming is readable but its liveness is not (watchers.ts), so
  // an instruction to stop a specific running thing would be asserting what the tool cannot see.
  "watch-debug.json":   "no reply — drop the watcher; the tracker's own tick is what wakes you",
  "resume":             "keep status.json current; nothing else is read",
  "model":              "none needed — your footer is re-read every tick",
  // MC-001 · the context-memory subsystem (memory.ts) sends THREE different messages down the SAME
  // debug log ("context-debug.json"), and a single "context-debug.json" reply key spoke for all
  // three — so a freshly-restored session, whose whole job is to READ its memory file, was told
  // "write the memory file named here". Keyed by StepKind instead, one per message this subsystem
  // actually sends. ("abort" and "none" never reach injectTo — see extension.ts — so they need no
  // entry here; there is nothing to reply to because nothing is ever typed.)
  "context-save":       "write the memory file named here; nothing else is read",
  // The message body IS the literal string "/clear" — loom_cdp.py's compose_outgoing() skips the
  // return-address header entirely for anything starting with "/", so this reply hint is NEVER
  // actually delivered. Kept (rather than omitted) so the table stays honest about every message
  // this subsystem sends, and documented rather than assumed — see MC-001.
  "context-clear":      "no reply — a bare /clear carries no header; this line is never delivered",
  "context-restore":    "no reply — nothing to bank; read the memory file named here and get on with the work it names",
};

// ── the REPORTING CONTRACT (owner directive 2026-09-16 · playbook §21) ─────────────────────────
//
// "Make sure that orchestrators always talk product, not the number of lines they did, number of
// commits they pushed — all that is available in the work ledger. I don't need to know that. I need
// to know where the product is going." Said three times in one session, about three different
// reports ("500 lines of garbage. Just bullet points only.").
//
// WHY IT LIVES HERE AND NOT IN THE PLAYBOOK. A rule in a doc is advice; behaviour flows from the
// text a session actually READS. This product has been bitten three times by a rule that lived in
// prose while the tool kept typing something else — so the rule is attached to the messages
// themselves, at the one choke point every injection passes through, and a new orchestrator-facing
// message cannot be added without choosing a side of the table below.
//
// ONE BOUNDARY ONLY: orchestrator → human. A WORKER's report to its orchestrator MUST keep its full
// counts, grade blocks and measurements — that is the evidence the orchestrator banks a block on —
// so putting this on a worker message would suppress exactly the evidence this bus runs on. The
// worker kinds below are excluded deliberately, and that is the load-bearing half of this table.
//
// KEPT TO ONE LINE, deliberately: the complaint being fixed is volume standing in for a decision,
// so a fix that appended three paragraphs to every message would BE the defect, shipped.
export const REPORTING_CONTRACT =
  "[contract] To the owner, in a few bullets: what works, what is broken for a user, what the next " +
  "block changes for a user, the decision the owner must make. Not figures — those are yours.";

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
  "context-save",        // memory.ts     — write your working memory before the clear
  "context-restore",     // memory.ts     — fresh context; here is who you are and what to read
  // "context-clear" is UNREACHABLE as of CX-001 — memory.ts produces no clear step, and a clear
  // aimed at an orchestrator is refused above whatever produces it. Its REPLY_FOR entry is kept as
  // the record of a message this subsystem once sent; it was never in this set anyway, because a
  // command carries no header and no contract (see `withContract`).
]);

/**
 * The kinds that reach a WORKER. Not merely "everything else": named, so that the exclusion is a
 * decision on the record and a reviewer can see that `gate-debug.json` was considered and kept out.
 * A worker owes its orchestrator counts and measurements; the contract would suppress them.
 */
export const WORKER_KINDS: ReadonlySet<string> = new Set([
  "gate-debug.json",     // health.ts  — YOUR gate exited; read its log and write your grade counts
  "spawn-debug.json",    // extension.ts — "/model …" and "/loom <role>", commands either way
  "resume",              // a resume nudge
  "model",               // a tier switch
]);

/**
 * The text that actually gets typed: the message, plus the contract when this kind of message
 * reaches an orchestrator. Pure, so the CLAIM ("this kind carries it, that kind does not") is
 * testable without a composer.
 *
 * A COMMAND NEVER CARRIES IT. loom_cdp.py's `compose_outgoing()` returns anything starting with "/"
 * untouched — no return-address header, nothing appended — because the composer would execute the
 * whole line. Appending here would corrupt the command rather than instruct anybody.
 */
export function withContract(kind: string, message: string): string {
  const msg = String(message || "");
  if (!msg.trim() || msg.trimStart().startsWith("/")) return msg;
  // The build stamp goes on EVERY non-command message, worker-facing ones included: a worker reading
  // "[loom-gate] your gate exited" needs to know which build watched it exactly as much as the
  // orchestrator does. The contract stays orchestrator-only — that exclusion is load-bearing.
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
 * Type `message` into the target's composer and submit it. Never throws; `done` always gets a verdict.
 * `debugName` is a file under ~/.claude/loom that records the last attempt (out/err truncated), so a
 * silent failure is diagnosable after the fact.
 */
/**
 * What an injection actually did, read off the injector's OUTPUT and not off its exit code.
 *
 * loom_cdp.py exits 0 and prints a result dict even when it could not find the frame, or typed text
 * it could not confirm in the composer — `{'ok': False, ..., 'note': 'typed text not confirmed in
 * composer; NOT submitted'}` (measured against the orchestrator's own frame 2026-09-14T00:04:57Z,
 * MS-001 R2: the model policy trusted the exit code and recorded that refusal as "switched"). So
 * `ok` is: no error AND the printed dict does not carry ok=False; the failure note is the dict's own.
 * One reading for every injection the extension makes — `injectTo` below and `ModelPolicy.enforce`.
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

export function injectTo(target: InjectTarget, message: string, debugName: string,
                         done?: (ok: boolean, note: string) => void, replyKind?: string): void {
  // `debugName` is where the attempt is LOGGED; `replyKind` is what REPLY_FOR is keyed by. They are
  // usually the same string (one message per debug file, at every other call site) but the
  // context-memory subsystem writes three different KINDS of message to the one debug file
  // ("context-debug.json") — see REPLY_FOR's "context-save/-clear/-restore" entries — so a caller
  // that sends more than one kind of message down one debug file must pass `replyKind` explicitly.
  // PD-001 · the reporting contract rides the SAME key as the reply hint, and is attached here
  // rather than at the nine call sites so that no orchestrator-facing message can be added without
  // one, and no worker-facing message can pick one up by accident.
  const kind = replyKind ?? debugName;
  // CX-001 · BEFORE anything is composed or spawned. The refusal is the first thing this function
  // does with the message, so no future edit between here and the execFile can slip past it, and the
  // one thing that must not happen costs nothing to prevent: a non-clear message never reads the bus.
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
        // what was actually TYPED, contract included — a log of the pre-contract text would make
        // the one thing this block adds invisible in the only record of the injection.
        message: outgoing.slice(0, 300),
        // …and the contract sits at the END, so on any body over ~300 chars (the briefing is 517)
        // the truncation above would hide it and the log would read as though it never went. This
        // flag is the claim itself, and it does not grow with the message.
        //
        // MOD-001 §5: this used to read `outgoing !== message`, which meant "something was appended"
        // and was only ever TRUE of the contract because the contract was the only thing that
        // appended. The build stamp appends to every non-command message, so that proxy would now
        // report a worker's gate wake as carrying the contract — the exact claim PD-001 exists to
        // deny. Keyed on the contract's own text instead, which cannot drift from what was typed.
        contract: outgoing.includes(REPORTING_CONTRACT),
        /** Which build sent it, in the log as well as in the composer — the debug file is what gets
         *  read when a reminder is disputed, and it is usually read instead of the message. */
        build: buildVersion,
        // PD-001 · 400 was enough while the longest message was short. The contract now occupies
        // ~190 chars of any tail, which pushed the subcommand and the role — the part that says
        // WHAT WAS RUN — out of the window, in the one file that exists to diagnose a silent
        // failure after the fact.
        out: out.slice(-800), err: String((err && err.message) || stderr || "").slice(-400),
      }, null, 2));
    } catch { /* a failed log must never break the caller */ }
    done?.(ok, note);
  });
}
