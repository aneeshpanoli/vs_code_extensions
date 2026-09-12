// blanks.ts — ONE JOB: recognise a RESTORED-BUT-EMPTY Claude panel, safely enough to close one.
//
// WHY THEY EXIST. Claude Code's restore path discards the session id — `deserializeWebviewPanel`
// reads only `isFullEditor` and calls `setupPanel(panel, undefined, undefined, …)` — so VSCodium
// faithfully restores every Claude panel that was open at shutdown and each comes back as a blank
// "Untitled" conversation. A window that had three Claude tabs open gets three blanks. Measured
// 2026-09-12 after a restart: 26 Claude panels across 9 windows, 8 of them blank shells of
// 359–428 characters carrying no session, no role and no project path at all.
//
// The extension's restart path then reopens the REAL sessions from their transcripts as additional
// tabs, so every previously-live role appears twice — the blank shell and the session. Closing the
// shell is the only way to remove the duplicate, and closing Claude tabs is otherwise forbidden here
// (a v1.0.x auto-reopen closed live loom role tabs and lost work). So the test below is deliberately
// narrow, and the caller closes ONLY panels it saw blank before it reopened anything.

/** Longest a restored shell has been measured at, with room to spare. A real session's panel is
 *  orders of magnitude larger — the smallest live one in that same read was 38,851 characters. */
export const BLANK_MAX_CHARS = 1200;

/** Things that appear in any panel with a conversation in it. A blank shell has NONE of them. */
const IDENTITY = /LOOMROLE|worktrees[\/\\]|Containers[\/\\]|loom[\/\\][A-Za-z0-9_.-]+[\/\\]|\bYou:/;

/** The placeholder Claude Code renders into a fresh panel. Required, not merely allowed: a panel
 *  that is small for some OTHER reason (a failed render, a half-loaded session) is not a blank we
 *  understand, and we do not close what we do not understand. */
const PLACEHOLDER = /Untitled/;

/**
 * Is this panel a restored-empty shell — safe to close because there is provably nothing in it?
 * Three independent conditions, all required:
 *   1. tiny (a conversation cannot fit);
 *   2. carries the "Untitled" placeholder (it is a FRESH panel, not a broken one);
 *   3. carries no identity of any kind (no role marker, no worktree, no project path, no user turn).
 */
export function isBlankShell(text: string | null | undefined): boolean {
  const t = String(text || "");
  if (!t.trim()) return false;                 // an empty read is not evidence of anything
  if (t.length > BLANK_MAX_CHARS) return false;
  if (!PLACEHOLDER.test(t)) return false;
  return !IDENTITY.test(t);
}

export interface FrameLike { webviewId?: string | null; text?: string | null }

/** The blank shells in a CDP read, as webviewIds. */
export function blankShells(frames: FrameLike[]): string[] {
  return frames.filter((f) => f.webviewId && isBlankShell(f.text)).map((f) => String(f.webviewId));
}

/**
 * Which shells may be closed after a reopen. Deliberately conservative, and every clause is load
 * bearing:
 *  - `before`: only panels that were ALREADY blank when we started. A panel that went blank later is
 *    someone opening a new conversation, and closing that would take a tab out from under them.
 *  - still blank in `after`: if the reopen reused a shell, that shell is now the session — the
 *    single most dangerous case, and the one this clause exists for.
 *  - `limit`: never close more than we opened, so a bug cannot cascade into a tab massacre.
 */
export function closableShells(before: string[], after: FrameLike[], limit: number): string[] {
  if (limit <= 0) return [];
  const stillBlank = new Set(blankShells(after));
  const present = new Set(after.map((f) => String(f.webviewId || "")));
  return before.filter((w) => present.has(w) && stillBlank.has(w)).slice(0, limit);
}
