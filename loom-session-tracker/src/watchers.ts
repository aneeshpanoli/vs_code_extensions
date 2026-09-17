// watchers.ts — ONE JOB: notice an orchestrator that has armed a watcher, and say §17 to it once.
//
// Playbook §17, quoted because this file is a reading of one sentence: "an orchestrator arms no
// watchers, Monitors or `/loop`." It is woken by the session-tracker instead — a status change, a
// stall, a usage limit lifting, a restart, the memory cycle — at a cost of one tick's latency.
//
// §17 was the most expensive unenforced rule on the bus. The block that produced this file was
// asked a prior question — IS IT ENFORCEABLE AT ALL? — with "no, reclassify it" named in advance as
// a complete and successful answer. The measurement said yes. What follows is the evidence, because
// the answer was not obvious and the next person to doubt it deserves the numbers rather than a
// claim.
//
// ───────────────────────────────────────────────────────────────────────────────────────────────
// THE MEASUREMENT, 2026-09-17, over all 3,965 transcripts under ~/.claude/projects
//
// THE BRIEF'S OWN HYPOTHESIS WAS RANK 1 — IMPOSSIBLE — on the reasoning that "the extension does not
// intercept a session's tool calls, and a watcher is armed inside the session, not through the
// tool." The first half is true and the second half does not follow. The extension does not need to
// intercept anything: a session WRITES ITS OWN TOOL CALLS TO DISK as it makes them, one JSONL record
// per turn, and this extension already parses exactly those records for something else
// (workledger.ts `scanBlocks` reads `message.content[].type === "tool_use"` to bucket calls). The
// watcher is not a frame fact — §6's virtualization means the DOM is not the session, and the panel
// would never see it — but it is a FILE fact, and the file is already being read.
//
// Counted as structured `tool_use` records (never as text — see the self-poisoning note below), main
// session only, sidechains excluded:
//
//     in ORCHESTRATOR-or-solo project dirs        in WORKER worktree dirs
//     Bash bg polling the bus   452               Bash bg polling the bus     0
//     Monitor                   283               Monitor                   112
//     CronCreate                 11               CronCreate                  0
//     ScheduleWakeup              7               ScheduleWakeup              9
//
// ReciEats' root sessions alone hold 158 of those 452, and ReciEats is one of the two buses §17 was
// written from. So the violation is not hypothetical, it is the thing that was measured at 7,610
// turns in a day — and it is legible from here.
//
// THE SPECIFICITY RESULT IS THE ONE THAT MATTERS: the bus-polling signature fires 452 times in
// orchestrator dirs and ZERO times in worker dirs. A detector whose signal is absent from the entire
// population it must never fire on is the rare case where believability can be argued from data
// rather than asserted.
//
// ───────────────────────────────────────────────────────────────────────────────────────────────
// RANK 3 (detect + remind), AND — AS IN delegation.ts — THAT IS A DEMOTION, NOT A DEFAULT
//
// RANK 1 (refuse) is genuinely unreachable, and the brief was right about the mechanism even though
// its conclusion went the other way: the extension types into a composer, it does not sit between a
// session and its tools. There is no call to intercept and nothing to refuse. Confirmed, not assumed.
//
// RANK 2 (supply) is meaningless here, and this is the one place the ladder simply has no rung: the
// substitute for a watcher is ALREADY SUPPLIED and has been since §17 was written — the tracker's
// own tick is the wake-up. There is nothing left to hand over. An orchestrator that arms a watcher
// is not missing a capability, it is declining one it already has.
//
// RANK 3 is therefore the honest landing, and it is legitimate for the same reason it is in
// delegation.ts: the decision is genuinely the orchestrator's. Only it knows whether it is polling
// the bus or waiting on a deploy it must see finish.
//
// ───────────────────────────────────────────────────────────────────────────────────────────────
// THE SEVEN FALSE POSITIVES, NAMED BEFORE ANY THRESHOLD — the brief found two, the measurement four
// more, and the first one was found by this detector's own probe catching itself
//
// (1) TEXT THAT MENTIONS A WATCHER. Measured, and it is not a hypothetical: the probe written to
//     answer §1 grepped every transcript for `<command-name>/loop</command-name>` and got exactly one
//     hit — ITS OWN grep command, echoed into its own transcript by the tool call that ran it. Any
//     substring detector reads a session DISCUSSING watchers, a skill file that documents `/loop`
//     (the loom skill offers workers one), and its own source, as violations. So nothing here ever
//     matches text: a watcher counts only as a parsed `tool_use` block with a `name`.
//
// (2) A SUBAGENT'S WATCHER. 84 of the Monitor calls on this machine are `isSidechain: true`. §4
//     tells every role to fan out into subagents, and a subagent waiting on its own work is doing
//     what it was spawned to do — the context it burns is its own, not the orchestrator's 900k. The
//     rule is about the session that never clears. Sidechain records are dropped in `classifyCall`.
//
// (3) LEGITIMATE ONE-SHOT BACKGROUND WORK. 1,873 background Bash calls in orchestrator dirs are
//     one-shot — a build, a deploy, a test run. `run_in_background` is not a watcher; a LOOP is.
//     Requiring loop shape excludes all 1,873.
//
// (4) A BOUNDED WAIT ON A BUILD LOG. This is the one that would have sunk the whole thing, and it is
//     invisible unless you read the commands: 787 background loops in orchestrator dirs are
//     `until grep -qE '[0-9]+ passed' /tmp/…/lane.log; do sleep 3; done` — waiting for a GATE, not
//     polling the BUS. Loop shape alone would fire on every one of them. So a finding requires loop
//     shape AND a bus path (`status.json`, `board.json`, `outbox.md`, `~/.claude/loom/`), which is
//     what cuts 1,239 loops down to the 452 that are §17's actual subject.
//
// (5) HISTORY. The transcript is append-only and holds the whole life of the session, including
//     watchers armed before this extension started, before §17 existed, and ones long since stopped.
//     Counting the file would report a violation from last Tuesday as if it were happening now. So
//     the FIRST sight of any session baselines the byte offset and counts NOTHING; only records that
//     appear after this detector was already watching can ever produce a finding.
//
// (6) A HUMAN-ARMED WATCHER IN AN ORCHESTRATOR TAB. The brief names this one. A command the human
//     types is a `user` record; a watcher the session arms is an `assistant` record carrying a
//     `tool_use` block. Only the latter is read, so a human who types `/loop` into an orchestrator
//     tab is never reported to the session as if the session had done it.
//
// (7) A STALE SESSION ID. PB-001's defect exactly, and the reason delegation.ts REJECTED transcript
//     evidence outright ("the transcript is found by session id, and a session id goes stale at
//     every clear and every respawn"). That rejection was correct when it was written and is no
//     longer, because PB-001 shipped the rule that fixes it: session identity is the AND of the
//     records that name it, and a disagreement between the board and the role's own status.json
//     means a transition is in flight. This detector reads the transcript only while those records
//     AGREE; a disagreement counts nothing and re-baselines nothing. The address defect is not
//     inherited, it is the one thing this file refuses to do without.
//
// ───────────────────────────────────────────────────────────────────────────────────────────────
// WHAT THIS CANNOT DO, STATED HERE SO THE MESSAGE NEVER OVERCLAIMS IT
//
// IT CANNOT TELL WHETHER A WATCHER IS STILL RUNNING. Measured: across every session on every board,
// watcher-shaped calls with no matching `tool_result` numbered ZERO. A `run_in_background` Bash
// returns its shell id IMMEDIATELY while the process keeps running, so the result block proves the
// CALL returned and says nothing about the loop; and a Monitor that has returned may have been
// re-armed since. There is no liveness signal in the file.
//
// So the finding is "this session ARMED a watcher", which is a fact, and never "a watcher is running
// now", which is not knowable. The message says `armed` for that reason, and says plainly that it
// may already have been stopped. A reminder that asserted a live watcher would be wrong a fraction
// of the time with no way to tell which fraction — and one reminder that fires wrongly costs more
// than the two that currently work are worth.
//
// ───────────────────────────────────────────────────────────────────────────────────────────────
// COST — the brief required this be answered rather than hand-waved
//
// The orchestrator transcript is the largest file on the bus, and it is NOT re-read per tick. State
// carries a byte offset; each tick opens the file, seeks, and reads only what was appended, which on
// a quiet tick is zero bytes. Measured on this bus's orchestrator (a92e26bd, 2.32 MB): a whole-file
// read is 0.5 ms and a 256 KB tail read is under 0.1 ms. Even the pathological case is cheap — the
// point of the offset is that the 171 MB transcript on this machine would not be, and the design
// must not depend on every bus staying small.

import * as fs from "fs";
import * as os from "os";
import * as path from "path";

const LOOM_ROOT = path.join(os.homedir(), ".claude", "loom");

/** Tools that ARE a watcher by construction — there is no benign way for an orchestrator session to
 *  call one. Bash is deliberately absent: it is a watcher only in a particular shape (see
 *  `classifyCall`), and treating it as one wholesale is false positive (3). */
export const WATCHER_TOOLS: ReadonlySet<string> = new Set([
  "Monitor",        // blocks the session until a condition holds
  "ScheduleWakeup", // re-invokes this session on a timer
  "CronCreate",     // re-invokes it on a schedule that outlives the session
]);

/** A background command is a watcher only if it LOOPS. One-shot background work is false positive
 *  (3) and is the majority of it — 1,873 of 3,112 background calls in orchestrator dirs. */
const LOOP_SHAPE = /(^|[\s;&|(])(while|until|watch|sleep)([\s;&|)]|$)/;

/** …and only if it loops over THE BUS. Without this, the 787 `until grep … lane.log` waits on build
 *  logs all read as §17 violations — false positive (4), the one that would have sunk the detector. */
const BUS_PATH = /status\.json|board\.json|outbox\.md|[/\\]\.claude[/\\]loom[/\\]/;

/** What a single observed arming is. `kind` is the tool, or "loom-poll" for the Bash shape. */
export interface Arming {
  kind: string;
  /** ISO instant from the record, or null when the record carried none. */
  at: string | null;
}

/**
 * Is THIS record an orchestrator arming a watcher?
 *
 * PURE, and every false-positive exclusion that can be decided from one record is decided here, so
 * the claims are testable against a literal JSONL line with no files, clock or composer involved.
 * Returns null for everything that is not a violation, which is almost everything.
 */
export function classifyCall(rec: any): Arming | null {
  if (!rec || typeof rec !== "object") return null;
  // (6) Only the SESSION's own acts. A human typing into the tab is a `user` record.
  if (rec.type !== "assistant") return null;
  // (2) A subagent's watcher is the subagent's business — §4 asks for the fan-out.
  if (rec.isSidechain) return null;
  const content = rec.message && rec.message.content;
  if (!Array.isArray(content)) return null;
  const at = typeof rec.timestamp === "string" ? rec.timestamp : null;
  for (const b of content) {
    // (1) A watcher is a PARSED tool_use block with a name — never a substring of anything.
    if (!b || typeof b !== "object" || b.type !== "tool_use") continue;
    const name = typeof b.name === "string" ? b.name : "";
    if (WATCHER_TOOLS.has(name)) return { kind: name, at };
    if (name === "Bash") {
      const input = b.input && typeof b.input === "object" ? b.input : {};
      if (input.run_in_background !== true) continue;
      const cmd = typeof input.command === "string" ? input.command : "";
      // (3) AND (4): it must loop, and it must loop over the bus.
      if (LOOP_SHAPE.test(cmd) && BUS_PATH.test(cmd)) return { kind: "loom-poll", at };
    }
  }
  return null;
}

/** What one scan of an appended chunk found. */
export interface ScanResult {
  armings: Arming[];
  /** The offset to resume from next tick. */
  offset: number;
}

/**
 * Read ONLY what was appended since `fromOffset` and classify it.
 *
 * NEVER THROWS — a tick must survive a transcript that is missing, truncated, being written to
 * mid-line, or held open by another process. A partial final line is discarded and its bytes are not
 * consumed, so the record is classified whole on the next tick rather than half-parsed on this one.
 */
export function scanAppended(fileP: string, fromOffset: number): ScanResult {
  let size = 0;
  try {
    size = fs.statSync(fileP).size;
  } catch {
    return { armings: [], offset: fromOffset };
  }
  // A file that SHRANK was replaced or rotated; resume from its start rather than from a stale
  // offset pointing into the middle of a record.
  let start = fromOffset;
  if (!Number.isFinite(start) || start < 0 || start > size) start = 0;
  if (size === start) return { armings: [], offset: size };

  let buf: Buffer;
  let fd = -1;
  try {
    fd = fs.openSync(fileP, "r");
    const len = size - start;
    buf = Buffer.allocUnsafe(len);
    fs.readSync(fd, buf, 0, len, start);
  } catch {
    return { armings: [], offset: fromOffset };
  } finally {
    if (fd >= 0) { try { fs.closeSync(fd); } catch { /* ignore */ } }
  }

  const text = buf.toString("utf8");
  const lines = text.split("\n");
  // The last element is either "" (the chunk ended on a newline) or a half-written record. Either
  // way it is not consumed: `consumed` counts only bytes up to the final newline.
  const tail = lines.pop() ?? "";
  const consumed = size - Buffer.byteLength(tail, "utf8");

  const armings: Arming[] = [];
  for (const line of lines) {
    if (!line.trim()) continue;
    // Cheap pre-filter: the overwhelming majority of records are not tool calls at all.
    if (line.indexOf("tool_use") === -1) continue;
    let rec: any;
    try { rec = JSON.parse(line); } catch { continue; }
    const hit = classifyCall(rec);
    if (hit) armings.push(hit);
  }
  return { armings, offset: consumed };
}

// ── NT-001-R2 · WHAT THE ORCHESTRATOR ACTUALLY SAID ────────────────────────────────────────────
//
// The owner: "when a project is truly done it usually ends with a summary from the orchestrator, and
// I want that summary to come along with the notification." He is away from his desk, so the phone is
// how he finds out. The stop notification already carries the project, the time and one line — but
// that line is a role's OWN `status.json` sentence, written about itself. What it TOLD him exists in
// exactly one place: its transcript. So this reads it, and it lives here because this file already
// owns transcript reading under the identity rule that makes it safe.
//
// WHY THIS IS THE SAME MACHINERY AND NOT A NEW READER. `scanAppended` above does a bounded POSITIONAL
// read — stat for the size, `openSync`/`readSync` at an offset, never a whole-file read, never
// throwing. This is that same read pointed at the other end of the file: instead of resuming at a
// stored offset and going forward, it seeks to `size - TAIL` and walks the records BACKWARDS to the
// first one that qualifies. Nothing else about the access pattern changes.
//
// WHAT IT COSTS, and the handoff required this be answered rather than waved at. One `statSync` plus
// one bounded read of at most `SUMMARY_TAIL_BYTES`, on a tick that has ALREADY decided a project is
// quiet — so it runs at most once per stop, not once per tick, and never on the 15-minutes-of-silence
// path that produces nothing. The measurement in the cost note above timed a 256 KB tail read on this
// bus's 2.32 MB orchestrator transcript at UNDER 0.1 ms; the whole-file read it replaces was 0.5 ms
// there and would be unbounded on the 171 MB transcript that also exists on this machine. The tail is
// the reason the cost does not depend on the size of the file.
//
// WHY 256 KB AND NOT LESS. Measured 2026-09-17 over 155 orchestrator transcripts active in the last
// three days: the distance from EOF back to the start of the last assistant-text record is p50 3.9 KB,
// p90 5.6 KB, max 17.6 KB, and a 64 KB tail captured it in 155 of 155. 256 KB is ~14x the measured
// worst case, and the headroom is deliberate — that distance is set by whatever records happen to
// follow the message, and ONE `tool_result` carrying a large file read can be hundreds of KB on its
// own. A tail that falls short does not corrupt anything; it returns null and the notification falls
// back to what it sends today. Paying 0.1 ms once per stop to make that fallback rare is the trade.
export const SUMMARY_TAIL_BYTES = 256 * 1024;

/** One message a session produced, as text. `at` is the record's own ISO instant, or null. */
export interface LastSaid {
  text: string;
  at: string | null;
}

/**
 * A line the EXTENSION typed into this session, recognised by SHAPE rather than by a list of names.
 *
 * This is a second line of defence and it is worth saying plainly that the FIRST one is structural.
 * The extension's only path into a running session is `inject.injectTo`, which shells out to
 * `loom_cdp.py` and TYPES INTO THE COMPOSER; it never writes a `.jsonl`, and every `.jsonl` reference
 * in `src/` is a read, a rename or a delete (context.ts, rebind.ts, reopen.ts, gc.ts, deleter.ts).
 * So an injected message is authored by the USER side of the conversation by construction, and
 * `rec.type !== "assistant"` already excludes all twelve injection call sites. Measured over the same
 * 155 transcripts: 24 `user` text blocks begin with a `[loom-` marker and ZERO `assistant` ones do.
 *
 * What this regex adds is the case the structural rule genuinely cannot reach — the session QUOTING
 * our line back as its own words, which is not exotic: an orchestrator that has just been sent
 * `[loom-watch] …` may well answer by repeating it. Keyed on the shape `[loom-<word>]` and NOT on the
 * nine markers that exist today (`[loom-notify|gate|clears|stall|delegate|watch|ledger|context|
 * restart]`), because a tenth added next month must be covered without anyone remembering to come
 * back here. Only a LEADING marker counts: a summary that mentions a reminder in passing, halfway
 * through a real sentence, is still the orchestrator's own words and he should get it.
 */
const INJECTED_MARK = /^\s*\[loom-[a-z-]+\]/;

/**
 * Is THIS record the orchestrator speaking, and what did it say?
 *
 * PURE, like `classifyCall` above and for the same reason: every rule about WHICH message qualifies
 * is decided from one record, so each claim is testable against a literal JSONL line with no file,
 * clock or composer involved. Returns null for everything that is not the session's own words.
 *
 * THE FOUR THINGS IT IS NOT, each excluded structurally rather than by inspection:
 *   · not a TOOL CALL and not a TOOL RESULT — only blocks whose `type` is exactly `text` are read,
 *     so `tool_use` and `tool_result` are skipped by the same test that skips everything else.
 *   · not THINKING — `thinking` blocks fail that test too. He asked for what it told him, and
 *     thinking is precisely the part it did not.
 *   · not a SUBAGENT's message — `isSidechain` records are a subagent talking to its parent, not the
 *     orchestrator talking to him. Dropped here exactly as false positive (2) drops them above.
 *   · not something WE injected — see `INJECTED_MARK`.
 */
export function assistantText(rec: any): LastSaid | null {
  if (!rec || typeof rec !== "object") return null;
  if (rec.type !== "assistant") return null;
  if (rec.isSidechain) return null;
  const content = rec.message && rec.message.content;
  let text = "";
  if (typeof content === "string") {
    // The legacy plain-string shape. Not seen in any of the 155 transcripts measured, and handled
    // anyway because the cost is one branch and the failure mode of omitting it is silent: an older
    // record would read as "nothing to say" rather than as an error.
    text = content;
  } else if (Array.isArray(content)) {
    const parts: string[] = [];
    for (const b of content) {
      if (!b || typeof b !== "object") continue;
      if (b.type !== "text") continue;
      if (typeof b.text === "string" && b.text.trim()) parts.push(b.text.trim());
    }
    text = parts.join("\n");
  } else {
    return null;
  }
  text = text.trim();
  if (!text) return null;
  if (INJECTED_MARK.test(text)) return null;
  return { text, at: typeof rec.timestamp === "string" ? rec.timestamp : null };
}

/**
 * The last thing this session SAID, read from the tail of its transcript.
 *
 * NEVER THROWS, and every failure lands on `null` — missing file, unreadable file, a tail holding no
 * qualifying record, a truncated write in flight. `null` means "no readable summary", which the
 * caller turns into exactly the notification it sends today. That is the whole contract: this feature
 * may fail to add something, and may never subtract anything.
 */
export function lastAssistantText(fileP: string, maxTailBytes = SUMMARY_TAIL_BYTES): LastSaid | null {
  let size = 0;
  try { size = fs.statSync(fileP).size; } catch { return null; }
  if (size <= 0) return null;

  const start = size > maxTailBytes ? size - maxTailBytes : 0;
  let buf: Buffer;
  let fd = -1;
  try {
    fd = fs.openSync(fileP, "r");
    const len = size - start;
    buf = Buffer.allocUnsafe(len);
    fs.readSync(fd, buf, 0, len, start);
  } catch {
    return null;
  } finally {
    if (fd >= 0) { try { fs.closeSync(fd); } catch { /* ignore */ } }
  }

  const lines = buf.toString("utf8").split("\n");
  // A tail that began mid-file began mid-RECORD in all but a vanishing case, and that leading
  // fragment is not valid JSON. Dropped rather than parsed — the mirror of `scanAppended` refusing
  // to consume its trailing partial line.
  if (start > 0) lines.shift();

  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i];
    if (!line || !line.trim()) continue;
    // Cheap pre-filter, and safe: a qualifying record contains `"type":"assistant"`, so the plain
    // ASCII substring is present in any JSON encoding of it. This is what keeps a multi-hundred-KB
    // `tool_result` line from being parsed on the way past.
    if (line.indexOf("assistant") === -1) continue;
    let rec: any;
    try { rec = JSON.parse(line); } catch { continue; }
    const said = assistantText(rec);
    if (said) return said;
  }
  return null;
}

/** What one tick observes. Assembled by the caller from records the extension already keeps. */
export interface WatcherInput {
  repo: string;
  /** The tagged orchestrator's role. null when the bus has no tag — nothing is judged. */
  orchestrator: string | null;
  /** The session id the board and the role's status.json AGREE on (PB-001). null when they do not,
   *  or when neither names one — and null means nothing is read and nothing is re-baselined. */
  sessionId: string | null;
  /** The orchestrator's transcript, already resolved from `sessionId`. null when unresolvable. */
  transcript: string | null;
  /** The dispatch watermark — the same one delegation.ts latches on. */
  lastDispatch: string | null;
}

export interface WatcherState {
  /** The session whose offset is stored. A change re-baselines (false positive 5). */
  sessionId: string | null;
  /** Bytes of that transcript already classified. */
  offset: number;
  /** The dispatch watermark current when a reminder was last DELIVERED. The latch. */
  remindedAt: string | null;
  /** The session id current when that reminder was delivered — the second re-arm. */
  remindedSession: string | null;
  updatedAt?: string;
}

export interface WatcherFinding {
  repo: string;
  orchestrator: string;
  /** Every arming seen in this stretch's newly-appended records. Never empty in a finding. */
  armings: Arming[];
  /** The distinct kinds, for the message. */
  kinds: string[];
  lastDispatch: string | null;
}

/** Why a tick produced no finding — kept and reported rather than folded into silence, so a reader
 *  of the state file can tell "checked, nothing to say" from "not checked". */
export type WatcherSkip =
  | "no tagged orchestrator"
  | "identity records disagree — a session transition is in flight"
  | "no transcript for this session"
  | "first sight of this session — baselined, nothing counted"
  | "no watcher armed since the last scan"
  | "already reminded for this stretch";

export interface WatcherResult {
  state: WatcherState;
  finding: WatcherFinding | null;
  skip: WatcherSkip | null;
}

const EMPTY: WatcherState = { sessionId: null, offset: 0, remindedAt: null, remindedSession: null };

function file(repo: string): string {
  return path.join(LOOM_ROOT, repo, "watcher-state.json");
}

export function loadWatchers(repo: string): WatcherState {
  try {
    const st = JSON.parse(fs.readFileSync(file(repo), "utf8"));
    if (st && typeof st === "object") {
      return {
        sessionId: typeof st.sessionId === "string" ? st.sessionId : null,
        offset: Number.isFinite(st.offset) && Number(st.offset) >= 0 ? Number(st.offset) : 0,
        remindedAt: typeof st.remindedAt === "string" ? st.remindedAt : null,
        remindedSession: typeof st.remindedSession === "string" ? st.remindedSession : null,
      };
    }
  } catch { /* none yet */ }
  return { ...EMPTY };
}

/** Change-only and atomic, like every other latch on this bus. */
export function saveWatchers(repo: string, st: WatcherState): void {
  try {
    const f = file(repo);
    try {
      const cur = JSON.parse(fs.readFileSync(f, "utf8"));
      if (cur && (cur.sessionId ?? null) === st.sessionId && Number(cur.offset) === st.offset
          && (cur.remindedAt ?? null) === st.remindedAt
          && (cur.remindedSession ?? null) === st.remindedSession) return;
    } catch { /* write */ }
    fs.mkdirSync(path.dirname(f), { recursive: true });
    const tmp = f + ".tmp." + process.pid;
    fs.writeFileSync(tmp, JSON.stringify({ ...st, updatedAt: new Date().toISOString() }, null, 2));
    fs.renameSync(tmp, f);
  } catch { /* ignore */ }
}

/**
 * One tick of the detector.
 *
 * `scan` is injected so the whole thing is testable without a transcript on disk; the caller passes
 * `scanAppended`. Order is deliberate: every exclusion that can suppress a finding is checked BEFORE
 * any arming is counted, so no amount of accumulated evidence can outrun a false-positive guard.
 */
export function watcherTick(
  input: WatcherInput,
  prev: WatcherState,
  scan: (f: string, off: number) => ScanResult = scanAppended,
): WatcherResult {
  const st: WatcherState = { ...prev };

  if (!input.orchestrator) {
    return { state: st, finding: null, skip: "no tagged orchestrator" };
  }
  // (7) PB-001. Identity is the AND of the records; a disagreement is a transition in flight, which
  // is UNKNOWN. Unknown counts nothing AND re-baselines nothing — re-baselining on a half-written
  // board would consume the new session's records unseen.
  if (!input.sessionId) {
    return { state: st, finding: null,
             skip: "identity records disagree — a session transition is in flight" };
  }
  if (!input.transcript) {
    return { state: st, finding: null, skip: "no transcript for this session" };
  }

  // A DISPATCH RE-ARMS, exactly as in delegation.ts: the orchestrator that hands work over has the
  // suppression cleared by the act itself. Nothing else clears it except a new session below.
  if (input.lastDispatch && input.lastDispatch !== st.remindedAt && st.remindedAt !== null
      && input.lastDispatch > st.remindedAt) {
    st.remindedAt = null;
    st.remindedSession = null;
  }

  // (5) FIRST SIGHT OF THIS SESSION — baseline and count nothing. This is what keeps a watcher armed
  // last Tuesday, or before this extension started, out of today's finding. A `/clear` lands here
  // too: a new session id is a new file, and its first tick establishes the mark.
  if (st.sessionId !== input.sessionId) {
    let size = 0;
    try { size = fs.statSync(input.transcript).size; } catch { size = 0; }
    st.sessionId = input.sessionId;
    st.offset = size;
    // A new session is a genuinely new stretch, so it re-arms too — the second and last re-arm.
    st.remindedAt = null;
    st.remindedSession = null;
    return { state: st, finding: null, skip: "first sight of this session — baselined, nothing counted" };
  }

  const res = scan(input.transcript, st.offset);
  st.offset = res.offset;

  if (res.armings.length === 0) {
    return { state: st, finding: null, skip: "no watcher armed since the last scan" };
  }
  // THE LATCH — once per stretch, cleared only by a newer dispatch or a new session.
  if (st.remindedAt !== null && st.remindedSession === input.sessionId) {
    return { state: st, finding: null, skip: "already reminded for this stretch" };
  }
  const kinds: string[] = [];
  for (const a of res.armings) if (!kinds.includes(a.kind)) kinds.push(a.kind);
  return {
    state: st,
    finding: { repo: input.repo, orchestrator: input.orchestrator, armings: res.armings, kinds,
               lastDispatch: input.lastDispatch },
    skip: null,
  };
}

/** Record a DELIVERED reminder. Only delivery latches — a reminder refused because the composer was
 *  mid-turn is a reminder nobody received, and marking it would mean "told" for a session that was
 *  never told. Same rule as delegation.ts, same three findings behind it. */
export function markWatcherReminded(st: WatcherState, sessionId: string | null,
                                    lastDispatch: string | null): WatcherState {
  return { ...st, remindedAt: lastDispatch ?? new Date().toISOString(), remindedSession: sessionId };
}

/** How each kind reads in the sentence. The Bash shape needs saying in words; the tools name
 *  themselves. */
function describe(kind: string): string {
  if (kind === "loom-poll") return "a background shell loop polling the bus";
  if (kind === "Monitor") return "a Monitor";
  if (kind === "ScheduleWakeup") return "a ScheduleWakeup";
  if (kind === "CronCreate") return "a CronCreate";
  return kind;
}

/**
 * The sentence an orchestrator reads.
 *
 * WHAT IT MUST NOT BE — the same three as delegation.ts, plus one this detector alone risks:
 *  - not a score, threshold, quota or bar. There is no count to beat here and none is given.
 *  - not a verdict on conduct. The orchestrator may have had a reason; the tool cannot know.
 *  - not a recitation of the playbook. §17 is named once, by number, as the rule that applies.
 *  - AND NOT A CLAIM THAT THE WATCHER IS RUNNING. It cannot be known (see the cost/liveness note
 *    above), so the line says `armed`, names when, and says outright that it may already be stopped.
 *    Getting this wrong is the specific way this reminder would lose the reader: an orchestrator
 *    told "you have a watcher running" who has already stopped it learns the tool is guessing.
 *
 * WHAT IT MUST BE: a specific next action. The substitute is already built, so the line names the
 * five things that will wake it and the latency it is trading for — the actual decision, stated in
 * the terms the orchestrator would use to make it.
 */
export function watcherReminder(f: WatcherFinding): string {
  const what = f.kinds.map(describe).join(" and ");
  const when = f.armings[f.armings.length - 1]?.at;
  const seen = when ? ` The most recent was at ${when}.` : "";
  const many = f.armings.length > 1 ? ` ${f.armings.length} armings were seen in this stretch.` : "";
  return `[loom-watch] This session armed ${what} since the last check.${seen}${many} It may already ` +
    `have been stopped — that is not readable from here, so this is about the arming, not about ` +
    `anything running now. Playbook §17: an orchestrator arms no watchers, Monitors or /loop, ` +
    `because a watcher wakes your whole context on every tick and re-reads all of it, which was ` +
    `measured as most of a day's tokens. You do not need one: the tracker already wakes you when a ` +
    `role's status.json goes working → idle/blocked, when a role stalls, when a usage limit lifts, ` +
    `after a restart, and on the memory cycle. The cost of dropping it is one tick — 15 seconds — of ` +
    `reaction latency. If you are waiting on something the tracker cannot see, that is the ROLE's ` +
    `job to report: have it write status.json when the thing happens and you will be woken. If this ` +
    `was a one-off wait on a deploy you had to watch finish, carry on — nothing is blocked and ` +
    `nothing needs undoing.`;
}
