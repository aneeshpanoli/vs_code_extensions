// context.ts — ONE JOB: measure how full a session's context window is, from its own transcript.
//
// TWO SOURCES, AND WHICH WINS. The panel knows its own number, but not in a way innerText can see.
// Read out of the shipped webview bundle (2.1.263), the compact affordance is
//     <button title="73% context used — click to compact"><svg pie/></button>
// with a hover popup ("N% of context remaining until auto-compact." / "Click to compact now."). The
// figure is an ATTRIBUTE, which is why a plain text read of the panel finds nothing — and the button
// is rendered ONLY when `100 - used >= 50` is false, so it simply does not exist below ~50% used.
// Its denominator is the app's own `contextWindow - maxOutputTokens - 13000` — the usable window, not
// the raw one. So when the button is up, that percentage is the best number available and cdp.ts
// reads it (measured 2026-09-08: of 23 live panels exactly one carried it, at 52%).
//
// This module is the other source, and it is still needed for three things the button cannot give:
// a figure BELOW the button's threshold, the token COUNT, and the session IDENTITY that proves a
// /clear actually happened. (Note: the percentages in Claude's sessions sidebar are usage-LIMIT
// percentages — session/weekly/Fable — and have nothing to do with context.)
//
// WHAT THE TRANSCRIPT SAYS: ~/.claude/projects/<cwd-slug>/<sessionId>.jsonl, one JSON object per line.
// Every `type:"assistant"` line carries message.usage, and the tokens the model was given for that turn are
//     input_tokens + cache_read_input_tokens + cache_creation_input_tokens
// (measured on Gaming/developer: 2 + 115,282 + 885 = 116,169). The LAST such line is therefore the current
// context occupancy. `isSidechain:true` lines are a subagent's own turns, not the main thread's context —
// they are skipped, or a big subagent read would look like the session filling up.
//
// THE WINDOW (for the estimate): not inferable from the model id here. Measured on this machine, sessions reporting
// `claude-opus-5` reached 910,221 tokens, and the four auto-compaction points found in
// shwab_docker/trader's transcript sit at 999,703 / 999,195 / 750,540 / 999,343 — i.e. a 1,000,000-token
// window, not the 200k the bare model id would imply. So the window is a SETTING with that measured
// default; under-reading it only means the guard fires late, which is the safe direction.
//
// Everything here is read-only and never throws. Transcripts get large (one live file is 63 MB), so only
// the TAIL is ever read.

import * as fs from "fs";
import * as os from "os";
import * as path from "path";

const PROJECTS_ROOT = path.join(os.homedir(), ".claude", "projects");

/** Measured auto-compaction ceiling on this machine (999,703 / 999,195 / 999,343). */
export const DEFAULT_WINDOW_TOKENS = 1_000_000;
/** How much of the transcript tail to read. One turn's JSON line is a few KB; 512 KB is many turns. */
export const TAIL_BYTES = 512 * 1024;

export interface ContextReading {
  /** Tokens the model was given on the last main-thread turn = current occupancy. */
  tokens: number;
  /** Fraction of the window, 0..1+. */
  fraction: number;
  model: string | null;
  /** ISO timestamp of that turn. */
  at: string | null;
  sessionId: string;
  file: string;
}

/** Read the tail of a file as text. Never throws. */
function tail(file: string, bytes = TAIL_BYTES): string | null {
  let fd: number | null = null;
  try {
    const size = fs.statSync(file).size;
    const start = Math.max(0, size - bytes);
    const len = size - start;
    if (len <= 0) return "";
    const buf = Buffer.alloc(len);
    fd = fs.openSync(file, "r");
    fs.readSync(fd, buf, 0, len, start);
    const text = buf.toString("utf8");
    // A mid-line start would produce one unparseable fragment; drop it rather than guess.
    return start > 0 ? text.slice(text.indexOf("\n") + 1) : text;
  } catch { return null; }
  finally { if (fd !== null) { try { fs.closeSync(fd); } catch { /* ignore */ } } }
}

/** Tokens carried by one assistant turn's usage block. */
export function usageTokens(usage: any): number {
  if (!usage || typeof usage !== "object") return 0;
  const n = (v: any) => (Number.isFinite(v) ? Number(v) : 0);
  return n(usage.input_tokens) + n(usage.cache_read_input_tokens) + n(usage.cache_creation_input_tokens);
}

/**
 * Current context occupancy of one transcript. Reads only the tail; returns null when the file has no
 * main-thread assistant turn in it (a brand-new session, or a tail that is all tool output).
 */
export function readTranscriptContext(file: string, windowTokens = DEFAULT_WINDOW_TOKENS): ContextReading | null {
  const text = tail(file);
  if (text === null) return null;
  const lines = text.split("\n");
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i];
    if (!line || line.indexOf('"usage"') === -1) continue;
    let d: any;
    try { d = JSON.parse(line); } catch { continue; }
    if (d.type !== "assistant" || d.isSidechain === true) continue;
    const msg = d.message || {};
    const tokens = usageTokens(msg.usage);
    if (!tokens) continue;
    const win = windowTokens > 0 ? windowTokens : DEFAULT_WINDOW_TOKENS;
    return {
      tokens,
      fraction: tokens / win,
      model: typeof msg.model === "string" ? msg.model : null,
      at: typeof d.timestamp === "string" ? d.timestamp : null,
      sessionId: String(d.sessionId || path.basename(file, ".jsonl")),
      file,
    };
  }
  return null;
}

/** The transcript file for a session id, wherever its project directory happens to be. */
export function transcriptFor(sessionId: string): string | null {
  if (!sessionId) return null;
  let dirs: string[] = [];
  try { dirs = fs.readdirSync(PROJECTS_ROOT); } catch { return null; }
  for (const d of dirs) {
    const f = path.join(PROJECTS_ROOT, d, `${sessionId}.jsonl`);
    try { if (fs.statSync(f).isFile()) return f; } catch { /* next */ }
  }
  return null;
}

/**
 * The newest transcript in a project directory, optionally only ones touched since `sinceMs` and not
 * `excludeSessionId`. This is how a session is re-found after `/clear`: the clear starts a NEW session
 * id, so the old file simply stops growing and a new one appears in the same directory.
 */
export function newestTranscriptIn(dir: string, opts: { sinceMs?: number; exclude?: string } = {}): string | null {
  let best: { file: string; mtime: number } | null = null;
  let names: string[] = [];
  try { names = fs.readdirSync(dir); } catch { return null; }
  for (const n of names) {
    if (!n.endsWith(".jsonl")) continue;
    if (opts.exclude && n === `${opts.exclude}.jsonl`) continue;
    const f = path.join(dir, n);
    let m: number;
    try { m = fs.statSync(f).mtimeMs; } catch { continue; }
    if (opts.sinceMs !== undefined && m < opts.sinceMs) continue;
    if (!best || m > best.mtime) best = { file: f, mtime: m };
  }
  return best ? best.file : null;
}

/** The `session_id` a board records for a role, if it records one. */
export function boardSessionId(repo: string, role: string): string | null {
  try {
    const d = JSON.parse(fs.readFileSync(path.join(os.homedir(), ".claude", "loom", repo, "board.json"), "utf8"));
    const entry = (d.roles || d)[role];
    const sid = entry && (entry.session_id || entry.sessionId);
    return typeof sid === "string" && sid ? sid : null;
  } catch { return null; }
}

/** Percent, rounded, for display. */
export function pct(fraction: number): number { return Math.round(fraction * 100); }
