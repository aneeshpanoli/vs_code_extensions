// memory.ts — ONE JOB: stop the orchestrator from dying of a full context, by making it bank what it is
// doing into a memory doc, clearing, and coming back with that doc loaded.
//
// WHY THE ORCHESTRATOR SPECIFICALLY: workers finish a handoff and stop; the orchestrator runs for days
// across every role, so it is the session that actually fills. Measured on the live transcripts
// 2026-09-08, shwab_docker's orchestrator had auto-compacted FOUR times (at 999,703 / 999,195 / 750,540 /
// 999,343 tokens). Auto-compaction is a summary the session does not choose, does not review, and cannot
// re-read later — after it, the thread of what each role was waiting on is whatever the summariser kept.
// Banking to a file first is the same act done deliberately: the session decides what matters, writes it
// somewhere durable, and the next context starts by reading it.
//
// THE ONE DANGEROUS STEP is `/clear`: it is irreversible from inside the session. Everything here exists to
// make sure it can only happen AFTER the memory doc is on disk:
//   * the doc's mtime must be NEWER than the moment the save prompt was injected, and the file must be
//     non-trivial — an old file, or an empty one, is not a save;
//   * the session must not be mid-turn (a /clear typed into a working composer would interrupt it);
//   * if the doc never appears within the save timeout the cycle ABORTS and warns. It never clears anyway.
// The state machine lives on the bus, so an IDE restart mid-cycle resumes rather than re-clearing.
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
export const MIN_MEMORY_BYTES = 200;
/** How long one window's claim on a cycle stands before another may take it over. Longer than the
 *  save and clear timeouts combined, so a live owner is never overtaken mid-cycle; short enough that
 *  a window closed mid-cycle does not strand the project. */
export const LEASE_MS = 15 * 60_000;

/** A panel holding less than this has been cleared. Measured: a cleared tab renders ~170 characters;
 *  a live orchestrator conversation ran 145,680. Two orders of magnitude of daylight. */
export const CLEARED_PANEL_CHARS = 4000;

export type Phase = "watch" | "saving" | "clearing";

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
  clearTimeoutMinutes: number;
  cooldownMinutes: number;
}

export const DEFAULT_CONFIG: MemoryConfig = {
  enabled: true, thresholdPct: 50, saveTimeoutMinutes: 10, clearTimeoutMinutes: 5, cooldownMinutes: 15,
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
   *  guess rather than a fact — and a `/clear` typed into a turn that is still running interrupts it.
   *  So the two steps that carry consequences wait for a frame we can see. The RESTORE step is exempt
   *  on purpose: a freshly cleared panel holds almost no text, so it stops detecting as the
   *  orchestrator at all — requiring it there would strand every cycle at the last step. */
  frameSeen: boolean;
  memoryFile: string;
  memoryMtime: number | null;
  memorySize: number;
  now: number;
  cfg: MemoryConfig;
  state: ContextState;
}

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
  return `[loom-context] Your context is ${percent}% full` +
    `${tokens ? ` (${tokens.toLocaleString()} tokens)` : ""}. ` +
    `Before it fills up, write your working memory to ${memoryFile} — overwrite it, keep it current:\n` +
    `  • what you are doing RIGHT NOW and the exact next step;\n` +
    `  • every role: what it was handed, what it owes you, what it is waiting on;\n` +
    `  • decisions already made (and why), so they are not re-litigated;\n` +
    `  • open questions and anything you are deliberately not doing yet.\n` +
    `Write the FILE — do not summarise in chat. Assume the reader has none of this conversation, ` +
    `because after you write it this session is cleared and that file is what you get back.`;
}

export const CLEAR_MESSAGE = "/clear";

/** Injected into the FRESH context. Also the "update the memory from the docs" half of the cycle. */
export function restoreMessage(memoryFile: string, repo: string, role: string): string {
  return `[loom-context] Fresh context — you are ${role}, the orchestrator of ${repo}. ` +
    `Start by reading, in this order:\n` +
    `  1. ${memoryFile} — your own working memory, written moments ago;\n` +
    `  2. ~/.claude/loom/${repo}/board.json — the roster and each role's state;\n` +
    `  3. the project docs (CLAUDE.md and docs/) for anything the memory asserts.\n` +
    `Reconcile them: where the memory disagrees with the docs or the board, the docs and the board win — ` +
    `correct ${memoryFile} on the spot so it stays the accurate account. Then continue from the next step ` +
    `it names, and keep updating it as you work.`;
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
  const unseen = !input.frameSeen && phase !== "clearing";
  if (unseen) return keep("the orchestrator's frame was not seen this tick — cannot tell if it is mid-turn");

  if (phase === "saving") {
    const wrote = input.memoryMtime !== null &&
      input.memoryMtime > (state.memoryBaseline ?? 0) &&
      input.memorySize >= MIN_MEMORY_BYTES;
    if (wrote) {
      if (input.busy) return keep("memory banked; waiting for the turn to end before clearing");
      return {
        kind: "clear",
        message: CLEAR_MESSAGE,
        note: `memory banked (${input.memorySize} bytes) — clearing`,
        next: { ...state, ...claim, phase: "clearing", phaseAt: now,
                sessionId: input.reading ? input.reading.sessionId : state.sessionId,
                lastNote: "cleared after a verified save" },
      };
    }
    if (now - (state.phaseAt ?? now) > cfg.saveTimeoutMinutes * MIN_TO_MS) {
      return {
        kind: "abort",
        note: `${input.role} did not write ${input.memoryFile} within ${cfg.saveTimeoutMinutes}m — ` +
          `NOT clearing. Its context is still ${pct(input.reading?.fraction ?? 0)}% full.`,
        next: { ...state, ...release, phase: "watch", phaseAt: now, lastCycleAt: now,
                aborts: (state.aborts ?? 0) + 1, lastNote: "save timed out; clear refused" },
      };
    }
    return keep("waiting for the memory doc to be written");
  }

  if (phase === "clearing") {
    // TWO independent witnesses that the clear landed, because only one of them is always available:
    //   * a NEW session id in the same project directory (when a transcript identifies the session);
    //   * the PANEL emptying out — a cleared tab renders a couple of hundred characters and loses its
    //     compact button. This is the one that works for an orchestrator with no board entry.
    const fresh = !!(input.reading && input.reading.sessionId !== state.sessionId);
    const emptied = input.panelChars !== null && input.panelChars < CLEARED_PANEL_CHARS &&
      (input.panelPct === null || input.panelPct === undefined);
    if (fresh || emptied) {
      return {
        kind: "restore",
        message: restoreMessage(input.memoryFile, input.repo, input.role),
        note: `cleared (${fresh ? "new session id" : "panel emptied"}) — ` +
          `restoring ${input.role} from ${path.basename(input.memoryFile)}`,
        next: { ...state, ...release, phase: "watch", phaseAt: now, lastCycleAt: now,
                sessionId: input.reading ? input.reading.sessionId : state.sessionId,
                memoryBaseline: undefined,
                cycles: (state.cycles ?? 0) + 1, lastNote: "cycle complete" },
      };
    }
    if (now - (state.phaseAt ?? now) > cfg.clearTimeoutMinutes * MIN_TO_MS) {
      return {
        kind: "abort",
        note: `no fresh session appeared after /clear within ${cfg.clearTimeoutMinutes}m — ` +
          `check ${input.role} by hand; its memory doc is written and safe.`,
        next: { ...state, ...release, phase: "watch", phaseAt: now, lastCycleAt: now,
                aborts: (state.aborts ?? 0) + 1, lastNote: "clear not observed" },
      };
    }
    return keep("waiting for the cleared session to appear");
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
  if (state.phase === "clearing" && state.transcriptDir) {
    const fresh = newestTranscriptIn(state.transcriptDir,
      { sinceMs: state.phaseAt, exclude: known || undefined });
    if (fresh) {
      const r = readTranscriptContext(fresh, windowTokens);
      if (r) return r;
    }
  }
  return knownFile ? readTranscriptContext(knownFile, windowTokens) : null;
}
