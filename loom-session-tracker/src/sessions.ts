// sessions.ts — ONE JOB: count how many Claude conversations are open SIMULTANEOUSLY across the
// whole editor, not just this window's project, and publish that count on the bus.
//
// WHY: the per-project counter (`Loom: n/3 active`) only ever sees its own repo's agents, so with
// several project windows open it badly understates real concurrency — measured live 2026-09-08:
// every window read "2/3" while 18 Claude conversations were actually open. Anthropic imposes no
// cap on concurrent sessions, but they all draw down ONE shared usage pool, so the honest number
// is the thing worth watching.
//
// HOW a conversation panel is recognised (validated against a live 32-frame read):
//   - it is a webview (has a webviewId; the bare window shells have none), AND
//   - it shows the composer footer / permission chip ("Bypass permissions", "Ready for your
//     input", the ctrl-esc hint, ...), AND
//   - it is not Claude's own sessions-list sidebar, which STARTS with "ACCOUNT & USAGE".
// The sidebar test is anchored on purpose: a long conversation that merely quotes that phrase must
// still count as a session (an unanchored test mis-filed 2 real conversations).

import * as fs from "fs";
import * as os from "os";
import * as path from "path";

const LOOM_ROOT = path.join(os.homedir(), ".claude", "loom");
const COUNT_FILE = path.join(LOOM_ROOT, "active-sessions.json");

/** Composer/footer text present in a live Claude conversation panel in any permission mode. */
const PANEL_MARKERS = /Bypass permissions|Accept edits|Plan mode|Ask each time|ctrl esc to focus|unfocus Claude|Ready for your input/;
/** Claude's sessions-list sidebar begins with this; a chat quoting it does not. */
const SESSIONS_LIST = /^\s*ACCOUNT & USAGE/;

export interface FrameLike { webviewId?: string | null; text?: string; }

/** How far back from the end the working indicator can sit (it renders just above the footer chips). */
export const BUSY_TAIL_CHARS = 400;
/** Measured 2026-09-08 on two mid-turn panels: the footer reads
 *  "... Stewing... ⏎ Claude is working ⏎ Remote Control ⏎ Opus 5 ⏎ Medium ⏎ Bypass permissions",
 *  while an idle panel goes straight from the last reply to "Remote Control". The spinner WORD varies
 *  ("Stewing", "Finagling", ...) so it is useless as a marker; the accessibility line does not. */
const BUSY_RE = /Claude is working|esc to interrupt|Stop responding/i;

/** Is this panel in the middle of a turn? Only the tail is examined, so a conversation that merely
 *  discusses the phrase (this one does) is not mistaken for a working session. */
export function isBusy(text: string | null | undefined): boolean {
  return BUSY_RE.test(String(text || "").slice(-BUSY_TAIL_CHARS));
}

export interface SessionCount {
  at: string;
  /** Claude conversations open simultaneously in this editor (all windows). */
  sessions: number;
  /** Editor windows open (frames with no webviewId are window shells). */
  windows: number;
  /** Of `sessions`, how many this window could resolve to a Loom role. */
  boundHere: number;
  /** Those roles, for context. */
  rolesHere: string[];
  /** Which project window published this snapshot ("(unscoped)" = no folder open). */
  updatedBy: string;
}

/** Is this frame a live Claude conversation panel? */
export function isSessionFrame(frame: FrameLike): boolean {
  if (!frame || !frame.webviewId) return false;
  const t = frame.text || "";
  if (SESSIONS_LIST.test(t)) return false;
  return PANEL_MARKERS.test(t);
}

export function countSessions(
  frames: FrameLike[], boundIds: Set<string>, rolesHere: string[], repo: string | null,
): SessionCount {
  const panels = frames.filter(isSessionFrame);
  return {
    at: new Date().toISOString(),
    sessions: panels.length,
    windows: frames.filter((f) => !f.webviewId).length,
    boundHere: panels.filter((f) => boundIds.has(String(f.webviewId))).length,
    rolesHere: [...rolesHere].sort(),
    updatedBy: repo || "(unscoped)",
  };
}

/**
 * Publish the count so the Loom sessions themselves (and any script) can read it:
 *   cat ~/.claude/loom/active-sessions.json
 * Atomic and change-only apart from the timestamp, so it never churns. Never throws.
 */
export function publishCount(c: SessionCount): void {
  try {
    const same = (() => {
      try {
        const cur = JSON.parse(fs.readFileSync(COUNT_FILE, "utf8"));
        return cur.sessions === c.sessions && cur.windows === c.windows &&
          cur.boundHere === c.boundHere && JSON.stringify(cur.rolesHere) === JSON.stringify(c.rolesHere) &&
          cur.updatedBy === c.updatedBy;
      } catch { return false; }
    })();
    if (same) return;
    fs.mkdirSync(LOOM_ROOT, { recursive: true });
    const tmp = COUNT_FILE + ".tmp." + process.pid;
    fs.writeFileSync(tmp, JSON.stringify(c, null, 2));
    fs.renameSync(tmp, COUNT_FILE);
  } catch { /* a monitor must never break a tick */ }
}

export function readCount(): SessionCount | null {
  try { return JSON.parse(fs.readFileSync(COUNT_FILE, "utf8")); } catch { return null; }
}
