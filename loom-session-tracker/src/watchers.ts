// watchers.ts — ONE JOB: notice an orchestrator that has armed a watcher, and say §17 to it once.
//
// Playbook §17: "an orchestrator arms no watchers, Monitors or `/loop`." It is woken by the
// session-tracker instead — a status change, a stall, a usage limit lifting, a restart, the memory
// cycle — at a cost of one tick's latency.
//
// ENFORCEABLE because a session WRITES ITS OWN TOOL CALLS TO DISK, one JSONL record per turn, and
// workledger.ts `scanBlocks` already parses exactly those records. A watcher is not a frame fact
// (§6 virtualization means the panel would never see it) but it is a FILE fact.
//
// MEASURED 2026-09-17 over all 3,965 transcripts under ~/.claude/projects. Structured `tool_use`
// records only (never text — see false positive (1)), main session, sidechains excluded:
//
//     in ORCHESTRATOR-or-solo dirs        in WORKER worktree dirs
//     Bash bg polling the bus   452       Bash bg polling the bus     0
//     Monitor                   283       Monitor                   112
//     CronCreate                 11       CronCreate                  0
//     ScheduleWakeup              7       ScheduleWakeup              9
//
// ReciEats' root sessions alone hold 158 of the 452. THE SPECIFICITY RESULT IS THE ONE THAT MATTERS:
// the bus-polling signature is absent — ZERO — from the entire population it must never fire on.
//
// RANK 3 (detect + remind), and as in delegation.ts that is a DEMOTION. RANK 1 (refuse) is
// unreachable: the extension types into a composer, so there is no call to intercept. RANK 2
// (supply) has no rung here — the substitute IS the tracker's own tick, already supplied. RANK 3 is
// honest because only the orchestrator knows whether it is polling the bus or waiting on a deploy.
//
// ── THE SEVEN FALSE POSITIVES, NAMED BEFORE ANY THRESHOLD ──────────────────────────────────────
//
// (1) TEXT THAT MENTIONS A WATCHER. Measured: a probe grepping every transcript for
//     `<command-name>/loop</command-name>` got exactly one hit — its own grep command, echoed into
//     its own transcript. A substring detector also reads skill files and this source as violations.
//     So nothing here matches text: a watcher counts only as a parsed `tool_use` block with a `name`.
// (2) A SUBAGENT'S WATCHER. 84 of the Monitor calls on this machine are `isSidechain: true`; §4 asks
//     for the fan-out and that context is the subagent's own. Dropped in `classifyCall`.
// (3) LEGITIMATE ONE-SHOT BACKGROUND WORK. 1,873 background Bash calls in orchestrator dirs are
//     one-shot builds/deploys/tests. `run_in_background` is not a watcher; a LOOP is.
// (4) A BOUNDED WAIT ON A BUILD LOG. 787 background loops are `until grep -qE '[0-9]+ passed'
//     /tmp/…/lane.log; do sleep 3; done` — a GATE, not the BUS. Requiring loop shape AND a bus path
//     is what cuts 1,239 loops down to the 452 that are §17's subject.
// (5) HISTORY. The transcript is append-only and holds watchers armed before §17 existed and ones
//     long stopped; counting the file would report last Tuesday as now. First sight of a session
//     baselines the byte offset and counts NOTHING.
// (6) A HUMAN-ARMED WATCHER IN AN ORCHESTRATOR TAB. The brief names this one. A typed command is
//     a `user` record; only `assistant` records carrying `tool_use` are read.
// (7) A STALE SESSION ID. PB-001's defect, and the reason delegation.ts rejected transcript evidence
//     outright ("a session id goes stale at every clear and every respawn"). PB-001 shipped the fix:
//     identity is the AND of the records that name it, and a board vs status.json disagreement means
//     a transition is in flight. This reads the transcript only while those records AGREE.
//
// IT CANNOT TELL WHETHER A WATCHER IS STILL RUNNING. Measured across every session on every board:
// watcher-shaped calls with no matching `tool_result` numbered ZERO — a `run_in_background` Bash
// returns its shell id immediately while the process keeps running, and a Monitor that returned may
// have been re-armed. So the finding is "this session ARMED a watcher", never "a watcher is running
// now", which is not knowable.
//
// COST. The orchestrator transcript is the largest file on the bus and is NOT re-read per tick:
// state carries a byte offset and each tick reads only what was appended (zero bytes on a quiet
// tick). Measured on this bus's orchestrator (a92e26bd, 2.32 MB): whole-file read 0.5 ms, 256 KB
// tail read under 0.1 ms. The offset exists because the 171 MB transcript on this machine would not
// be cheap, and the design must not depend on every bus staying small.

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

/** A background command is a watcher only if it LOOPS — false positive (3), 1,873 of 3,112
 *  background calls in orchestrator dirs. */
const LOOP_SHAPE = /(^|[\s;&|(])(while|until|watch|sleep)([\s;&|)]|$)/;

/** …and only if it loops over THE BUS. Without this the 787 `until grep … lane.log` build-log waits
 *  all read as §17 violations — false positive (4). */
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
 * PURE: every false-positive exclusion decidable from one record is decided here, so the claims are
 * testable against a literal JSONL line with no files, clock or composer. Returns null for
 * everything that is not a violation, which is almost everything.
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
 * NEVER THROWS — a tick must survive a transcript that is missing, truncated, mid-write or held open
 * elsewhere. A partial final line is discarded and its bytes are NOT consumed, so the record is
 * classified whole on the next tick rather than half-parsed on this one.
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
  // The last element is "" or a half-written record; either way it is not consumed — `consumed`
  // counts only bytes up to the final newline.
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

// ── NT-001-R2 · the stop notification carries the orchestrator's own last message ───────────────
//
// The owner asked for the closing summary on the phone notification; the line it carries today is a
// role's own status.json sentence. What it TOLD him lives only in the transcript, so this reads it,
// here, because this file already owns transcript reading under the identity rule that makes it safe.
//
// Same machinery as `scanAppended`: a bounded POSITIONAL read (stat, then `openSync`/`readSync` at an
// offset, never whole-file, never throwing), pointed at the other end — seek `size - TAIL` and walk
// records BACKWARDS to the first that qualifies. It runs at most once per stop, not once per tick.
//
// WHY 256 KB AND NOT LESS. Measured 2026-09-17 over 155 orchestrator transcripts active in the last
// three days: the distance from EOF back to the start of the last assistant-text record is p50
// 3.9 KB, p90 5.6 KB, max 17.6 KB, and a 64 KB tail captured it in 155 of 155. 256 KB is ~14x the
// measured worst case; the headroom is deliberate because ONE `tool_result` carrying a large file
// read can be hundreds of KB. A short tail corrupts nothing — it returns null and the notification
// falls back to what it sends today.
export const SUMMARY_TAIL_BYTES = 256 * 1024;

/** One message a session produced, as text. `at` is the record's own ISO instant, or null. */
export interface LastSaid {
  text: string;
  at: string | null;
}

/**
 * A line the EXTENSION typed into this session, recognised by SHAPE rather than by a list of names.
 *
 * Second line of defence; the first is structural. The extension's only path into a running session
 * is `inject.injectTo`, which types into the composer — it never writes a `.jsonl` — so an injected
 * message is authored by the USER side by construction and `rec.type !== "assistant"` already
 * excludes all twelve injection call sites. Measured over the same 155 transcripts: 24 `user` text
 * blocks begin with a `[loom-` marker and ZERO `assistant` ones do.
 *
 * This regex adds the one case that rule cannot reach: the session QUOTING our line back as its own
 * words. Keyed on the SHAPE `[loom-<word>]`, not on the nine markers that exist today, so a tenth is
 * covered without anyone coming back here. Only a LEADING marker counts — a marker mentioned halfway
 * through a sentence is still the orchestrator's own words and he should get it.
 */
const INJECTED_MARK = /^\s*\[loom-[a-z-]+\]/;

/**
 * Is THIS record the orchestrator speaking, and what did it say?
 *
 * PURE, like `classifyCall` and for the same reason. Returns null for everything that is not the
 * session's own words.
 *
 * THE FOUR THINGS IT IS NOT, each excluded structurally rather than by inspection:
 *   · not a TOOL CALL or TOOL RESULT — only blocks whose `type` is exactly `text` are read.
 *   · not THINKING — `thinking` blocks fail that same `type === "text"` test, not a separate check.
 *     He asked for what it told him, and thinking is what it did not.
 *   · not a SUBAGENT's message — `isSidechain` dropped here exactly as false positive (2) drops it.
 *   · not something WE injected — see `INJECTED_MARK`.
 */
export function assistantText(rec: any): LastSaid | null {
  if (!rec || typeof rec !== "object") return null;
  if (rec.type !== "assistant") return null;
  if (rec.isSidechain) return null;
  const content = rec.message && rec.message.content;
  let text = "";
  if (typeof content === "string") {
    // The legacy plain-string shape. Not seen in any of the 155 transcripts measured; handled anyway
    // because the cost is one branch and omitting it fails silently — an older record would read as
    // "nothing to say" rather than as an error.
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
 * NEVER THROWS, and every failure lands on `null` — missing file, unreadable file, no qualifying
 * record in the tail, a truncated write in flight. `null` means "no readable summary", which the
 * caller turns into exactly the notification it sends today: this feature may fail to add something
 * and may never subtract anything.
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
  // A tail that began mid-file began mid-RECORD in all but a vanishing case, and that fragment is
  // not valid JSON. Dropped — the mirror of `scanAppended` refusing its trailing partial line.
  if (start > 0) lines.shift();

  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i];
    if (!line || !line.trim()) continue;
    // Cheap pre-filter, and safe: a qualifying record contains `"type":"assistant"` in any JSON
    // encoding. This keeps a multi-hundred-KB `tool_result` line from being parsed on the way past.
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
  /** THE LATCH: a reminder was DELIVERED for this stretch. What WE did — never nullable, because
   *  "we delivered nothing" is a fact we always have. */
  reminded: boolean;
  /** The session that delivery happened in. The second half of the latch key. */
  remindedSession: string | null;
  /** THE WATERMARK: what the world had reported as its last dispatch at that delivery. What the
   *  WORLD did, so null is a real observation — no dispatch had been reported yet — and never a
   *  latch key. Compared to the live watermark by identity; the two are the same kind of fact. */
  remindedDispatch: string | null;
  /** When we delivered, for whoever reads this file. Nothing branches on it, which is the point:
   *  a delivery instant and a dispatch watermark are not comparable and no longer share a field. */
  deliveredAt?: string | null;
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

/** Why a tick produced no finding — reported rather than folded into silence, so a reader of the
 *  state file can tell "checked, nothing to say" from "not checked". */
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

const EMPTY: WatcherState = { sessionId: null, offset: 0, reminded: false, remindedSession: null,
                              remindedDispatch: null, deliveredAt: null };

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
        // MIGRATION. Nothing on disk says which kind of fact an old `remindedAt` held — that
        // ambiguity IS the defect — so it seeds the latch and NOT the watermark. A bus that has
        // dispatched therefore re-arms on its first tick after the upgrade: one reminder, not a
        // burst, and not silence.
        reminded: typeof st.reminded === "boolean" ? st.reminded
                  : typeof st.remindedAt === "string",
        remindedSession: typeof st.remindedSession === "string" ? st.remindedSession : null,
        remindedDispatch: typeof st.remindedDispatch === "string" ? st.remindedDispatch : null,
        deliveredAt: typeof st.deliveredAt === "string" ? st.deliveredAt : null,
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
          && (cur.reminded ?? false) === st.reminded
          && (cur.remindedSession ?? null) === st.remindedSession
          && (cur.remindedDispatch ?? null) === st.remindedDispatch) return;
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
 * `scan` is injected so this is testable without a transcript on disk. Order is deliberate: every
 * exclusion that can suppress a finding is checked BEFORE any arming is counted, so no amount of
 * accumulated evidence can outrun a false-positive guard.
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
  // (7) PB-001. A disagreement is a transition in flight, which is UNKNOWN. Unknown counts nothing
  // AND re-baselines nothing — re-baselining on a half-written board would consume the new session's
  // records unseen.
  if (!input.sessionId) {
    return { state: st, finding: null,
             skip: "identity records disagree — a session transition is in flight" };
  }
  if (!input.transcript) {
    return { state: st, finding: null, skip: "no transcript for this session" };
  }

  // A DISPATCH RE-ARMS, exactly as in delegation.ts: handing work over clears the suppression.
  // Nothing else clears it except a new session below.
  // Both sides are watermarks, so this asks whether the world's last dispatch CHANGED, not
  // whether it grew: ordering means nothing across two kinds of fact. It therefore re-arms on a
  // DECREASE too, which is a real event rather than a curiosity — the watermark is a max over OPEN
  // ledger records, so a record CLOSING lowers it. That is noise the old comparison did not make,
  // and it is the direction WT-001 chose.
  if (input.lastDispatch && st.reminded && input.lastDispatch !== st.remindedDispatch) {
    st.reminded = false;
    st.remindedSession = null;
    st.remindedDispatch = null;
  }

  // (5) FIRST SIGHT OF THIS SESSION — baseline and count nothing, which is what keeps a watcher
  // armed last Tuesday out of today's finding. A `/clear` lands here too: a new session id is a new
  // file, and its first tick establishes the mark.
  if (st.sessionId !== input.sessionId) {
    let size = 0;
    try { size = fs.statSync(input.transcript).size; } catch { size = 0; }
    st.sessionId = input.sessionId;
    st.offset = size;
    // A new session is a genuinely new stretch, so it re-arms too — the second and last re-arm.
    st.reminded = false;
    st.remindedSession = null;
    st.remindedDispatch = null;
    return { state: st, finding: null, skip: "first sight of this session — baselined, nothing counted" };
  }

  const res = scan(input.transcript, st.offset);
  st.offset = res.offset;

  if (res.armings.length === 0) {
    return { state: st, finding: null, skip: "no watcher armed since the last scan" };
  }
  // THE LATCH — once per stretch, cleared only by a CHANGED dispatch or a new session.
  if (st.reminded && st.remindedSession === input.sessionId) {
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
 *  mid-turn is a reminder nobody received. Same rule as delegation.ts, same three findings behind it. */
export function markWatcherReminded(st: WatcherState, sessionId: string | null,
                                    lastDispatch: string | null): WatcherState {
  return { ...st, reminded: true, remindedSession: sessionId,
           remindedDispatch: lastDispatch ?? null,
           deliveredAt: new Date().toISOString() };
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
 *  - not a score, threshold, quota or bar.
 *  - not a verdict on conduct. The orchestrator may have had a reason; the tool cannot know.
 *  - not a recitation of the playbook. §17 is named once, by number.
 *  - AND NOT A CLAIM THAT THE WATCHER IS RUNNING — unknowable (see the liveness note above), so the
 *    line says `armed` and says it may already be stopped. An orchestrator told "you have a watcher
 *    running" who has already stopped it learns the tool is guessing.
 *
 * WHAT IT MUST BE: a specific next action. The substitute is already built, so the line names the
 * five things that will wake it and the latency it is trading for.
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
