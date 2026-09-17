// memory.ts — ONE JOB: stop the orchestrator from dying of a full context, by making it bank what it is
// doing into a memory doc, and — when a PERSON chooses to clear it — bringing it back with that doc loaded.
//
// ── CX-001 · THIS SUBSYSTEM NO LONGER CLEARS ANYTHING (owner directive 2026-09-16) ────────────
// "Do not ever clear the orchestrator's context. Remove that from the loom-session-tracker add-on."
// The cycle was THREE steps — save, /clear, restore — and the middle one is gone. What is left is
// worth keeping and is the reason this was not deleted wholesale: banking is the half that makes an
// orchestrator's context survivable at all, and a person clearing by hand needs the memory doc to
// exist BEFORE they do it, not after. So the extension asks for the bank, then WATCHES. The clear is
// the person's, on their timing; when one is observed, the restore prompt still goes out and the
// fresh session still comes back knowing who it is and what to read.
// The guarantee is enforced twice over, deliberately (see inject.ts): `decide()` never returns a
// `clear` step, AND `injectTo` refuses a clear command aimed at an orchestrator whatever produced it.
// WORKER clearing under playbook §12 is untouched — the orchestrator types those, not this extension.
//
// WHY THE ORCHESTRATOR SPECIFICALLY: workers finish a handoff and stop; the orchestrator runs for days
// across every role, so it is the session that actually fills. Measured on the live transcripts
// 2026-09-08, shwab_docker's orchestrator had auto-compacted FOUR times (at 999,703 / 999,195 / 750,540 /
// 999,343 tokens). Auto-compaction is a summary the session does not choose, does not review, and cannot
// re-read later — after it, the thread of what each role was waiting on is whatever the summariser kept.
// Banking to a file first is the same act done deliberately: the session decides what matters, writes it
// somewhere durable, and the next context starts by reading it.
//
// THE SAVE MUST BE REAL before the cycle believes it, because the whole point is that the doc is on disk
// before a person clears:
//   * the doc's mtime must be NEWER than the moment the save prompt was injected, and the file must be
//     non-trivial — an old file, or an empty one, is not a save;
//   * if the doc never appears within the save timeout the cycle ABORTS and warns.
// The state machine lives on the bus, so an IDE restart mid-cycle resumes where it was.
//
// THE BUSY / IDLE GATE IS GONE, and its absence is a decision rather than an oversight. It existed for
// one reason — "a /clear typed into a working composer would interrupt it" — and it guarded the step
// that no longer exists. A save prompt is a MESSAGE: it queues behind the current turn (dispatch.ts),
// so there is nothing to protect it from. A gate left standing over a deleted act reads to the next
// person as a live safety rule and would be maintained as one.
//
// decide() is pure: every rule above is a test, not a hope.

import * as fs from "fs";
import * as os from "os";
import * as path from "path";

import { isOwnerRole } from "./naming";
import { ContextReading, pct, transcriptFor, newestTranscriptIn, boardSessionId, readTranscriptContext,
         DEFAULT_WINDOW_TOKENS } from "./context";

const LOOM_ROOT = path.join(os.homedir(), ".claude", "loom");

/** A memory doc smaller than this is not a handoff — treat it as "not written yet". */
/** KEPT DELIBERATELY (WL-004). Not an instruction to anyone — the check that something was actually
 *  written before the cycle believes a save happened. A floor on evidence, not a target for prose. */
export const MIN_MEMORY_BYTES = 200;
/**
 * INTERNAL ONLY — this number must never reach a string an agent reads (WL-004, asserted by test).
 *
 * It exists so the panel can OBSERVE that a memory is large (Lumen's reached 56 KB / 653 lines,
 * 2026-09-13), which is a real cost worth seeing. It is not a cap, not a target, and not a budget:
 * as a sentence in the save prompt it made an orchestrator delete the record of the owner's stated
 * product goal in order to fit, twice in one day. A threshold an agent can see is a threshold an
 * agent will trade facts to satisfy.
 */
export const MAX_MEMORY_BYTES = 12_000;
/** How long one window's claim on a cycle stands before another may take it over. Longer than the
 *  save timeout, so a live owner is never overtaken mid-cycle; short enough that a window closed
 *  mid-cycle does not strand the project. */
export const LEASE_MS = 15 * 60_000;

/** A panel holding less than this has been cleared. Measured: a cleared tab renders ~170 characters;
 *  a live orchestrator conversation ran 145,680. Two orders of magnitude of daylight. */
export const CLEARED_PANEL_CHARS = 4000;
/** The app renders its compact button only once this much of the usable window is used. */
export const PANEL_BUTTON_PCT = 50;

/**
 * `banked` was called `clearing` until CX-001, and the rename is the block in one word: the phase
 * used to mean "we have typed /clear and are waiting to see it land", and now means "the memory is
 * on disk and we are watching in case a PERSON clears". The watching is identical — a fresh session
 * id, or the panel emptying — but nothing is waited ON. A phase named for an act the extension no
 * longer performs would have been the last place the removed behaviour still looked alive.
 */
export type Phase = "watch" | "saving" | "banked";

export interface ContextState {
  phase: Phase;
  /** The orchestrator role this cycle is about, and the file it was told to write. Both are pinned
   *  at the start: if either changes mid-cycle the cycle is abandoned rather than judged against a
   *  file it never asked for. */
  role?: string;
  memoryFile?: string;
  /** Transcript identity being watched. After a clear this becomes the NEW session id. */
  sessionId?: string;
  /** Directory holding that transcript — where the post-clear session will appear. */
  transcriptDir?: string;
  /** When the current phase began (epoch ms). */
  phaseAt?: number;
  /** mtime of the memory doc when the save was asked for; the save must beat it. */
  memoryBaseline?: number;
  /**
   * How much text the panel held at the moment the memory was banked — the "before" the emptied-panel
   * witness is a comparison against.
   *
   * CX-001 · WHY THIS IS SUDDENLY NEEDED. "The panel emptied" used to be read only in the seconds
   * after this extension had itself typed `/clear`, so an empty panel could only mean the clear
   * landed. Now the same phase is entered by BANKING, and then sits there for as long as nobody
   * clears — so a panel that is merely SMALL, or one read partially, would be read as a clear that
   * never happened, and a restore prompt would be injected into a session mid-work. Caught by the
   * extension-level test on 2026-09-17: the banked phase restored on its very next tick because the
   * fixture's panel holds a few hundred characters and always did.
   *
   * So the witness now requires a FALL: the panel must have been full when we banked and empty now.
   * `null`/absent means we never saw the panel then — the witness is unavailable rather than assumed,
   * and the fresh-session-id witness (which needs no panel at all) carries those cases.
   */
  bankedChars?: number | null;
  triggerTokens?: number;
  triggerPct?: number;
  /** Did the trigger come from the panel's own figure, or from the transcript estimate? */
  triggerFromPanel?: boolean;
  cycles?: number;
  aborts?: number;
  /** Which window is running this cycle. Measured 2026-09-09: nine editor windows were open, the CDP
   *  read is editor-wide, and a worktree window resolves to its PARENT repo id — so two windows are
   *  routinely scoped to the same project, and both were deciding the same step off the same state.
   *  Both would send the save prompt, and then both would send `/clear` — the second landing in the
   *  session the first had just restored. The bus is the only place they can agree, so the claim
   *  lives here. */
  owner?: string;
  ownerAt?: number;
  /** End of the last cycle (epoch ms) — the cooldown runs from here. */
  lastCycleAt?: number;
  lastNote?: string;
  updatedAt?: string;
}

export interface MemoryConfig {
  enabled: boolean;
  /** Fire when the context is at least this percent full. */
  thresholdPct: number;
  saveTimeoutMinutes: number;
  /** How long the cycle watches for a clear it did not cause before going back to watching context.
   *  NOT a deadline on anyone: a person clears when they choose, and if they never do, the cycle
   *  simply re-asks for a fresh bank later — which is what keeps the memory doc current. CX-001
   *  replaced `clearTimeoutMinutes` with this; that one timed a `/clear` this extension had sent. */
  cooldownMinutes: number;
}

export const DEFAULT_CONFIG: MemoryConfig = {
  enabled: true, thresholdPct: 30, saveTimeoutMinutes: 10, cooldownMinutes: 15,
};

export interface ContextInput {
  repo: string;
  role: string;
  /** The exact frame to inject into. Without it the orchestrator cannot be reached (see inject.ts). */
  webviewId: string | null;
  /** Current occupancy, or null when no transcript could be read — which is the NORMAL case for an
   *  orchestrator: measured 2026-09-09, both live tags name `product-owner`, and no board lists that
   *  role (they list `productowner` or `po`), so there is no session_id to find a transcript by. The
   *  cycle therefore must not require one. */
  reading: ContextReading | null;
  /** The panel's OWN "% context used", off its compact button (cdp.ts). null when the button is not
   *  rendered — which the app does below 50% used, so its absence is itself information. This is the
   *  app's own arithmetic over its own window, so it OUTRANKS the transcript estimate whenever
   *  present. The transcript is still needed for the token count and the session identity. */
  panelPct: number | null;
  /** Is the session mid-turn? Never type into a working composer. */
  busy: boolean;
  /** Identifies THIS window, stable for its lifetime. Two windows on one project must not both drive
   *  a cycle; whichever claims it first owns it until it finishes or its lease goes stale. */
  windowId: string;
  /** How much text the panel is showing, or null when the frame was not seen. A cleared panel holds
   *  a couple of hundred characters (playbook §13: "a cleared tab is ~170 characters"), which is how
   *  a /clear is confirmed when no transcript identifies the session. */
  panelChars: number | null;
  /** Was the orchestrator's frame actually seen in this tick's CDP read? When it was not, `busy` is a
   *  guess rather than a fact, and the SAVE prompt should not be sent on a guess about a frame we
   *  cannot see at all. The `banked` phase is exempt on purpose: a freshly cleared panel holds almost
   *  no text, so it stops detecting as the orchestrator — requiring a sighting there would strand
   *  every cycle at the restore, which is the one step that only ever helps. */
  frameSeen: boolean;
  memoryFile: string;
  /** WL-003: the orchestrator's audit, already rendered, appended to the RESTORE message. Empty
   *  string when there is nothing worth saying — the bootstrap then reads exactly as before. */
  briefing?: string;
  memoryMtime: number | null;
  memorySize: number;
  now: number;
  cfg: MemoryConfig;
  state: ContextState;
}

/**
 * `"clear"` IS STILL HERE, AND `decide()` NEVER RETURNS IT. That is the point.
 *
 * CX-001 §4, and MP-002's lesson before it: if the rule "this extension never clears an
 * orchestrator" is enforced only by the absence of code, there is nothing left to assert against —
 * the property becomes unfalsifiable, no mutant can express its violation, and the test that would
 * catch someone re-adding a threshold-triggered clear cannot even be written, because the kind it
 * would have to name would not compile. Keeping the variant keeps the claim expressible: `decide()`
 * is asserted never to produce it, and `injectTo` is asserted to refuse it. Two guards, two tests,
 * one rule. Anything that constructs a `clear` step is dead on arrival at the injector.
 */
export type StepKind = "none" | "save" | "clear" | "restore" | "abort";

export interface Step {
  kind: StepKind;
  /** What to inject (absent for "none"/"abort"). */
  message?: string;
  /** Human-readable reason, for the toast, the status bar and the debug log. */
  note: string;
  /** The state to persist after this step. */
  next: ContextState;
}

// ── the three prompts ───────────────────────────────────────────────────────────────────────
/** Asked BEFORE the clear. It has to be explicit that the file is the only thing that survives. */
export function saveMessage(memoryFile: string, tokens: number | null, percent: number): string {
  const notes = memoryFile.replace(/memory\.md$/, "notes.md");
  return `[loom-context] Your context is ${percent}% full` +
    `${tokens ? ` (${tokens.toLocaleString()} tokens)` : ""}. ` +
    `Before it fills up, write your working memory to ${memoryFile} — overwrite it, keep it current:\n` +
    `  • what you are doing RIGHT NOW and the exact next step;\n` +
    `  • every role: what it was handed, what it owes you, what it is waiting on;\n` +
    `  • decisions already made (and why), so they are not re-litigated;\n` +
    `  • open questions, anything you are deliberately not doing yet, and a section "UNSURE" listing ` +
    `what you believe but have not verified this thread.\n` +
    // WL-004 · NO NUMBER HERE, EVER. A byte target handed to an agent, about the one artifact that
    // survives its own erasure, converts "write down what matters" into "hit a number" — and an
    // agent that cannot fit trades facts for bytes. MEASURED 2026-09-15: the orchestrator trimmed
    // its own memory to satisfy this sentence and destroyed the section recording the owner's
    // stated product goal, the most important thing in the file, twice. The number produced that.
    // Concision is asked for as a matter of FORM, with the reason attached, and the reason is true:
    // the next session pays for every line, in full, before it has done anything.
    `Write it TIGHT — every line has to earn its place, because the whole file is re-read at the ` +
    `start of every fresh context and the next session pays for it before it has done any work. ` +
    `Prefer the fact over the narration of the fact; drop anything a fresh reader would not act on. ` +
    `Being short is not the same as being incomplete: if something matters, it stays, and you make ` +
    `room by cutting words rather than by cutting what is true.\n` +
    // R4 · the split is what keeps the working memory small now that no number does.
    `THE SPLIT IS HOW THIS STAYS SMALL: durable lessons — traps, conventions, anything true across ` +
    `threads — go in ${notes}, appended, never rewritten. ${memoryFile} holds ONLY what changes ` +
    `each cycle. If you find yourself about to delete something durable to make the working memory ` +
    `shorter, it belongs in ${notes} instead — move it, do not lose it.\n` +
    `Write the FILE — do not summarise in chat. Assume the reader has none of this conversation, ` +
    `because after you write it this session is cleared and that file is what you get back.`;
}

// CX-001 · `CLEAR_MESSAGE` (the literal "/clear") WAS HERE, and it is deleted rather than left
// unused: it was the only string in this extension's source that a composer would have executed as a
// context clear, and the cheapest way to keep it un-typed is for it not to exist. The refusal in
// inject.ts is the guard for everything a deletion cannot reach — a clear reconstructed by a future
// caller, or handed in from a user setting, which is exactly how `limits.ts` could take one.

/** Injected into the FRESH context. Also the "update the memory from the docs" half of the cycle. */
export function restoreMessage(memoryFile: string, repo: string, role: string,
                               briefing = ""): string {
  const notes = memoryFile.replace(/memory\.md$/, "notes.md");
  return `[loom-context] Fresh context — you are ${role}, the orchestrator of ${repo}. ` +
    `Start by reading, in this order:\n` +
    `  1. ${memoryFile} — your own working memory, written moments ago;\n` +
    `  2. ${notes} — your durable notes, if the file exists (read once; append rarely). READ THIS EVEN ` +
    `IF ${memoryFile} IS SHORT — a short working memory means more of what you need is in the notes, ` +
    `not less. The working memory is only what changed this cycle; the notes are everything that ` +
    `stays true, and they are never rewritten to save room;\n` +
    `  3. ~/.claude/loom/${repo}/board.json and each role's status.json — the roster and where each role is;\n` +
    `  4. ONLY the project docs the memory names — not CLAUDE.md and docs/ wholesale.\n` +
    `Reconcile them: where the memory disagrees with the board or the docs, the board and the docs win — ` +
    `correct ${memoryFile} on the spot so it stays the accurate account.\n` +
    `  5. REBIND: the clear gave you a NEW session id. Your ~/.claude/loom/${repo}/board.json entry has ` +
    `been updated with the id that was seen to appear; confirm it equals your $CLAUDE_SESSION_ID and fix ` +
    `it if not (a stale session_id reads as a dead, still-full transcript). Your ${role}.id file is unchanged.\n` +
    `Do NOT arm watchers, Monitors or /loop in this session: the session-tracker wakes you when a role ` +
    `finishes, stalls or is resumed, and every wake costs your whole context (playbook §17). ` +
    `Then continue from the next step the memory names, and keep updating it as you work.` +
    ` If any role's tab is missing, do not ask a person and do not park its work: write ` +
    `~/.claude/loom/${repo}/open-requests.json {"roles":[...],"requestedAt":"<iso>"} — the tab is ` +
    `opened within seconds and its webviewId written back for you to ring (playbook §15).\n` +
    // MP-002 (owner 2026-09-16): the WORKER rule is all that is left here. The self-shift sentence
    // this paragraph used to carry told every orchestrator on every project to write
    // `orchestrator-model.json`, and prose is where the behaviour actually flowed from — leaving it
    // would have kept the file being written, and the habit alive, after the code stopped reading it.
    `MODELS: every handoff you write carries a model: line (§18: claude-opus-5 or claude-sonnet-5) — ` +
    `the tracker warns once per handoff when it is missing. That is a rule about WORKERS. Your own ` +
    `tier is not the tracker's business and it will never change it: set it yourself with /model if ` +
    `you want a different one.` +
    // WL-003 · THIS MESSAGE IS ALREADY READ, so the audit rides free. A fresh orchestrator is
    // deciding what the next block does with nothing but its own memory file to go on, which is
    // precisely when it cannot see that the last four blocks reached no user. Appended, not
    // prepended: the bind instructions are what the session must act on first.
    briefing;
}

// ── the decision ────────────────────────────────────────────────────────────────────────────
const MIN_TO_MS = 60_000;

/**
 * The whole policy, as a pure function of what is currently true. Returns the step to take and the state
 * to persist. Every refusal is deliberate; none of them is a fallthrough.
 */
export function decide(input: ContextInput): Step {
  const { cfg, now } = input;
  const phase: Phase = input.state.phase || "watch";

  // ── who is driving ────────────────────────────────────────────────────────────────────────
  // A cycle belongs to ONE window from the moment it starts. Another window may take it over only
  // once the lease goes stale, which means the owner is gone (closed, or its extension host died).
  const heldByOther = !!input.state.owner && input.state.owner !== input.windowId &&
    now - (input.state.ownerAt ?? 0) < LEASE_MS;
  // The owner keeps its claim alive as it goes, at half-life so the file is not rewritten every tick.
  const owning = input.state.owner === input.windowId;
  const state: ContextState = (owning && now - (input.state.ownerAt ?? 0) > LEASE_MS / 2)
    ? { ...input.state, ownerAt: now } : input.state;
  const claim = { owner: input.windowId, ownerAt: now };
  const release = { owner: undefined, ownerAt: undefined };

  const keep = (note: string, next: ContextState = state): Step => ({ kind: "none", note, next });

  if (!cfg.enabled) return keep("context memory is off");
  if (heldByOther) {
    return keep(`another window is running this cycle (phase ${phase}) — one driver per project`,
                input.state);
  }
  if (!input.webviewId) return keep("the orchestrator's frame is not identified — cannot inject safely");


  // A cycle is about ONE role and ONE file. Re-tag the orchestrator, or point `contextMemoryFile`
  // somewhere else, and the next tick would be judging a DIFFERENT file against the baseline taken
  // from the old one — an unrelated file that happens to be newer would read as "banked" and send a
  // /clear. Retagging is not hypothetical: three tags were re-pointed by hand on 2026-09-09.
  if (phase !== "watch" &&
      ((state.role && state.role !== input.role) ||
       (state.memoryFile && state.memoryFile !== input.memoryFile))) {
    return {
      kind: "abort",
      note: `the cycle was for ${state.role} → ${state.memoryFile}, and it is now ${input.role} → ` +
        `${input.memoryFile} — abandoned rather than judged against the wrong file. Nothing cleared.`,
      next: { ...state, ...release, phase: "watch", phaseAt: now, lastCycleAt: now,
              aborts: (state.aborts ?? 0) + 1, lastNote: "target changed mid-cycle" },
    };
  }

  // Placed AFTER the mid-cycle abort on purpose: if a RUNNING cycle is re-tagged to a worker, the
  // abort above is the better outcome — it releases the lease and records the abandonment, where this
  // guard would merely hold. This catches the case the abort cannot: a cycle that never started
  // because the tag was wrong from the beginning.
  // THE TAG MUST NAME AN ORCHESTRATOR. This cycle's endpoint is a `/clear` — it destroys the
  // target session's context — so it must never run against a WORKER, whatever the tag says.
  // Measured live 2026-09-09: livegita's orchestrator.json read `{"role":"gitadeveloper"}`, tagged by
  // hand at 17:36 because the real PO (named `po`, in no owner set) was never offered as a candidate,
  // so the only livegita node available to star was the developer's. The cycle was held ONLY by that
  // tag's `webviewId: null`, and a tick populates that field the moment the frame is identifiable —
  // at which point this would have asked a developer mid-task to bank and clear itself.
  // Accepted spellings live in naming.ts; a project whose orchestrator has a genuinely new name adds
  // it there, which is a deliberate one-line act rather than a silent misfire.
  if (!isOwnerRole(input.role)) {
    return keep(`the tag names '${input.role}', which is not an orchestrator role — refusing to run ` +
                `the context cycle against a worker session (add the spelling to OWNER_ALIASES in ` +
                `src/naming.ts if it really is this project's orchestrator)`);
  }
  const unseen = !input.frameSeen && phase !== "banked";
  if (unseen) return keep("the orchestrator's frame was not seen this tick — not asking it to bank on a guess");

  if (phase === "saving") {
    const wrote = input.memoryMtime !== null &&
      input.memoryMtime > (state.memoryBaseline ?? 0) &&
      input.memorySize >= MIN_MEMORY_BYTES;
    if (wrote) {
      // THE CYCLE ENDS HERE AS FAR AS TYPING GOES (CX-001). The memory is on disk; the next act is a
      // person's, or nobody's. `kind: "none"` — nothing is injected, and the note is what the panel
      // shows: it must not read as though a clear is imminent, because none is coming.
      return {
        kind: "none",
        // WL-004 R2 · AN OBSERVATION FOR THE PANEL, NOT A TRIM ORDER. The size is a real cost and
        // worth seeing; "trim it" is an instruction to an agent to cut content to reach a number,
        // which is the same defect as the prompt. The threshold stays internal and is never phrased
        // as a cap: this note says what the file costs, and leaves what to do about it to a person.
        note: `memory banked (${input.memorySize} bytes${input.memorySize > MAX_MEMORY_BYTES
                 ? ` — large; every fresh context re-reads it in full` : ""}) — ` +
              `this tool will not clear ${input.role}; clear it by hand when you choose and it will ` +
              `be restored from the file`,
        next: { ...state, ...claim, phase: "banked", phaseAt: now,
                bankedChars: input.panelChars,
                sessionId: input.reading ? input.reading.sessionId : state.sessionId,
                lastNote: "memory banked; no clear sent" },
      };
    }
    if (now - (state.phaseAt ?? now) > cfg.saveTimeoutMinutes * MIN_TO_MS) {
      return {
        kind: "abort",
        note: `${input.role} did not write ${input.memoryFile} within ${cfg.saveTimeoutMinutes}m — ` +
          `nothing is banked. Its context is still ${pct(input.reading?.fraction ?? 0)}% full.`,
        next: { ...state, ...release, phase: "watch", phaseAt: now, lastCycleAt: now,
                aborts: (state.aborts ?? 0) + 1, lastNote: "save timed out; clear refused" },
      };
    }
    return keep("waiting for the memory doc to be written");
  }

  if (phase === "banked") {
    // TWO independent witnesses that a clear happened, because only one of them is always available:
    //   * a NEW session id in the same project directory (when a transcript identifies the session);
    //   * the PANEL emptying out — a cleared tab renders a couple of hundred characters and loses its
    //     compact button. This is the one that works for an orchestrator with no board entry.
    const fresh = !!(input.reading && input.reading.sessionId !== state.sessionId);
    // A FALL, not a level. See `bankedChars`: an empty panel is only evidence of a clear if this
    // panel was FULL when we banked.
    //
    // ABSENT AND NULL ARE DIFFERENT THINGS HERE, and the difference is the whole reliability of the
    // witness. `null` is this version's own record that it LOOKED and the frame was not in that
    // tick's read — no "before" exists, so the witness is withheld and `fresh` below carries the
    // cycle. `undefined` is a state file written before this field existed (≤ 0.43.0), where the
    // phase could only have been entered by a clear we ourselves sent; withholding there would
    // strand an in-flight cycle across the upgrade, so it stays permissive exactly as it was.
    const wasFull = state.bankedChars === undefined ||
      (state.bankedChars !== null && state.bankedChars >= CLEARED_PANEL_CHARS);
    const emptied = wasFull && input.panelChars !== null && input.panelChars < CLEARED_PANEL_CHARS &&
      (input.panelPct === null || input.panelPct === undefined);
    if (fresh || emptied) {
      return {
        kind: "restore",
        message: restoreMessage(input.memoryFile, input.repo, input.role, input.briefing || ""),
        note: `${input.role} was cleared (${fresh ? "new session id" : "panel emptied"}) — ` +
          `restoring it from ${path.basename(input.memoryFile)}`,
        next: { ...state, ...release, phase: "watch", phaseAt: now, lastCycleAt: now,
                sessionId: input.reading ? input.reading.sessionId : state.sessionId,
                transcriptDir: input.reading ? path.dirname(input.reading.file) : state.transcriptDir,
                memoryBaseline: undefined,
                cycles: (state.cycles ?? 0) + 1, lastNote: "cycle complete" },
      };
    }
    // NOT AN ABORT, and not a timeout on a person (CX-001). Nothing has gone wrong when nobody
    // clears: the memory doc is written and safe, which was the whole objective. This just stops the
    // cycle sitting in `banked` forever holding the lease — it returns to watching the context, and
    // `lastCycleAt` starts the cooldown so the threshold can ask for a FRESH bank later rather than
    // leaving an ageing file to be restored from. The old code aborted here with "no fresh session
    // appeared after /clear", which under this block would be a warning about a clear never sent.
    if (now - (state.phaseAt ?? now) > cfg.cooldownMinutes * MIN_TO_MS) {
      return keep(
        `${input.role} was not cleared; its memory doc is banked and safe — watching its context ` +
        `again, and it will be asked to re-bank if it fills further`,
        { ...state, ...release, phase: "watch", phaseAt: now, lastCycleAt: now,
          lastNote: "banked; no clear observed" });
    }
    return keep(`memory banked — watching in case ${input.role} is cleared; nothing will be typed`);
  }

  // watch
  // The panel's figure when it has one, the transcript's when it does not. They can disagree: the
  // panel divides by the USABLE window (its own `contextWindow - maxOutputTokens - 13000`), while the
  // transcript only knows the tokens sent. Where the app has an opinion, the app is right — and it is
  // the only source that needs nothing else to work.
  const fromPanel = typeof input.panelPct === "number" && isFinite(input.panelPct);
  if (!fromPanel && !input.reading) {
    return keep("context unknown — no compact button on the panel and no transcript for this role");
  }
  // THE PANEL'S SILENCE IS AN OPINION. The app renders the compact button only past 50% used
  // (cdp.ts), so a panel we can see, holding a real conversation, with NO button, is telling us it
  // is under 50% — and the transcript estimate cannot overrule that. Measured 2026-09-13, 00:13 to
  // 04:21: Lumen's orchestrator was banked, cleared and restored FOURTEEN times, once per cooldown,
  // on a 57% "estimate" read off a transcript the session had stopped writing days earlier, while
  // the fresh panel in front of the tracker showed no button every time. The estimate still serves
  // a threshold below 50, the token count in the prompt, and the session's identity.
  if (!fromPanel && input.frameSeen && input.panelChars !== null && input.panelChars >= CLEARED_PANEL_CHARS &&
      cfg.thresholdPct >= PANEL_BUTTON_PCT) {
    return keep(`panel shows no compact button (under ${PANEL_BUTTON_PCT}%) — ` +
      `the ${pct((input.reading as ContextReading).fraction)}% transcript estimate is not trusted over it`);
  }
  const percent = fromPanel ? Math.round(input.panelPct as number) : pct((input.reading as ContextReading).fraction);
  if (percent < cfg.thresholdPct) {
    return keep(`context ${percent}% (< ${cfg.thresholdPct}%)${fromPanel ? "" : ", estimated"}`);
  }
  const since = now - (state.lastCycleAt ?? 0);
  if (state.lastCycleAt && since < cfg.cooldownMinutes * MIN_TO_MS) {
    return keep(`context ${percent}% but within the ${cfg.cooldownMinutes}m cooldown`);
  }
  if (input.busy) return keep(`context ${percent}% — waiting for the current turn to finish`);
  return {
    kind: "save",
    message: saveMessage(input.memoryFile, input.reading ? input.reading.tokens : null, percent),
    note: `context ${percent}%${fromPanel ? "" : " (estimated)"}` +
      `${input.reading ? ` (${input.reading.tokens.toLocaleString()} tokens)` : ""}` +
      ` — asking ${input.role} to bank its memory`,
    next: {
      ...state, ...claim, phase: "saving", phaseAt: now, role: input.role, memoryFile: input.memoryFile,
      sessionId: input.reading ? input.reading.sessionId : undefined,
      transcriptDir: input.reading ? path.dirname(input.reading.file) : undefined,
      memoryBaseline: input.memoryMtime ?? 0,
      triggerTokens: input.reading ? input.reading.tokens : undefined,
      triggerPct: percent, triggerFromPanel: fromPanel,
      lastNote: "save requested",
    },
  };
}

// ── persistence ─────────────────────────────────────────────────────────────────────────────
function stateFile(repo: string): string { return path.join(LOOM_ROOT, repo, "context-state.json"); }

export function loadState(repo: string): ContextState {
  try {
    const st = JSON.parse(fs.readFileSync(stateFile(repo), "utf8"));
    if (st && typeof st === "object" && typeof st.phase === "string") return st;
  } catch { /* none yet */ }
  return { phase: "watch" };
}

/** Atomic, change-only, never throws — the same contract as every other bus writer here. */
export function saveState(repo: string, st: ContextState): void {
  try {
    const f = stateFile(repo);
    try {
      const cur = JSON.parse(fs.readFileSync(f, "utf8"));
      const strip = (o: any) => { const { updatedAt, ...rest } = o || {}; return JSON.stringify(rest); };
      if (strip(cur) === strip(st)) return;
    } catch { /* write it */ }
    fs.mkdirSync(path.dirname(f), { recursive: true });
    const tmp = f + ".tmp." + process.pid;
    fs.writeFileSync(tmp, JSON.stringify({ ...st, updatedAt: new Date().toISOString() }, null, 2));
    fs.renameSync(tmp, f);
  } catch { /* never throw from a tick */ }
}

/** Default location of a role's working memory on its own bus. */
export function defaultMemoryFile(repo: string, role: string): string {
  return path.join(LOOM_ROOT, repo, role, "memory.md");
}

export function statMemory(file: string): { mtime: number | null; size: number } {
  try { const st = fs.statSync(file); return { mtime: st.mtimeMs, size: st.size }; }
  catch { return { mtime: null, size: 0 }; }
}

/**
 * The reading `decide()` should judge, which depends on the phase: while CLEARING we are deliberately
 * looking for a DIFFERENT session — the fresh one `/clear` starts in the same project directory — and
 * everywhere else we follow the session id we already know (state first, then the board's record).
 * Falls back to the known session so a missing directory reads as "no fresh session yet", not as a clear.
 */
export function readOrchestratorContext(repo: string, role: string, state: ContextState,
                                        windowTokens = DEFAULT_WINDOW_TOKENS): ContextReading | null {
  const known = state.sessionId || boardSessionId(repo, role);
  const knownFile = known ? transcriptFor(known) : null;
  if (state.phase === "banked" && state.transcriptDir) {
    const fresh = newestTranscriptIn(state.transcriptDir,
      { sinceMs: state.phaseAt, exclude: known || undefined });
    if (fresh) {
      const r = readTranscriptContext(fresh, windowTokens);
      if (r) return r;
    }
  }
  // A TRANSCRIPT THAT STOPPED BEFORE THE LAST CLEAR IS NOT THE SESSION. When a clear is witnessed
  // by the panel emptying rather than by a new session id (the fresh transcript had not appeared, or
  // was looked for in the wrong directory), the state keeps the OLD id — and the old file keeps
  // reading as full. Measured 2026-09-13: fourteen cycles in four hours on Lumen's orchestrator,
  // every one triggered by 64938df2, a file last written before the first of them. So once a cycle
  // has completed, a known file older than it is dead: the session is whatever transcript has been
  // written in its directory SINCE the clear — and if none has, there is no reading, not a stale one.
  if (knownFile && state.lastCycleAt) {
    let mtime = 0;
    try { mtime = fs.statSync(knownFile).mtimeMs; } catch { /* unreadable -> dead */ }
    if (mtime < state.lastCycleAt) {
      const dir = state.transcriptDir || path.dirname(knownFile);
      const fresh = newestTranscriptIn(dir, { sinceMs: state.lastCycleAt, exclude: known || undefined });
      return fresh ? readTranscriptContext(fresh, windowTokens) : null;
    }
  }
  return knownFile ? readTranscriptContext(knownFile, windowTokens) : null;
}
