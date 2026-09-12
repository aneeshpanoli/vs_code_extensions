// focus.ts — ONE JOB: bring a role's tab to the front when its node is clicked in the sidebar.
//
// HOW. Claude's own `claude-vscode.editor.open(sessionId)` ends in createPanel(), which does
// `sessionPanels.get(sessionId)` and, when the session is already open, calls `reveal()` and returns
// (verified in extension v2.1.263). So the extension's own command IS the focus primitive — for a
// session that is open. For one that is NOT, the same call opens the transcript in a NEW tab, which
// is the duplicate this project just spent a night removing. Everything below exists to make sure we
// only ever call it for a session that is open right now.
//
// WHICH SESSION. A frame does not announce its own session id: measured 2026-09-12, every live
// panel's text contained transcript ids — one panel quoted eleven, all other sessions' — so text is
// not evidence of identity. The board entry a role writes for ITSELF at bind time is; and a session
// that is open is WRITING its transcript, so that transcript's mtime is minutes old at most. Both are
// required before the call is made.

import * as fs from "fs";
import { boardSessionId, transcriptFor } from "./context";

/** A transcript older than this is not being written by an open session. Generous: a long tool call
 *  can hold a turn open without a write, but not for a quarter of an hour. */
export const FRESH_MS = 15 * 60_000;

export type FocusPlan =
  | { kind: "reveal"; sessionId: string; ageMs: number }
  | { kind: "refuse"; reason: string };

export function planFocus(repo: string | null, role: string, now = Date.now()): FocusPlan {
  if (!repo) return { kind: "refuse", reason: "this window is not scoped to a project" };
  const sid = boardSessionId(repo, role);
  if (!sid) return { kind: "refuse", reason: `${role} has no session_id on ${repo}'s board — it has not bound itself yet` };
  const file = transcriptFor(sid);
  if (!file) return { kind: "refuse", reason: `${role}'s board session ${sid.slice(0, 8)} has no transcript on disk` };
  let ageMs = Infinity;
  try { ageMs = now - fs.statSync(file).mtimeMs; } catch { /* unreadable -> Infinity */ }
  if (ageMs > FRESH_MS) {
    return { kind: "refuse", reason: `${role}'s board session ${sid.slice(0, 8)} was last written ` +
      `${Math.round(ageMs / 60000)}m ago — probably not the open tab, and opening it would create a duplicate. ` +
      `Ask the role to rebind (/loom ${role}) to refresh its entry.` };
  }
  return { kind: "reveal", sessionId: sid, ageMs };
}
