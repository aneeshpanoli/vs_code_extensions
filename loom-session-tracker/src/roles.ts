// roles.ts — ONE JOB: decide whose session a frame is, ROBUSTLY, combining TWO signals so neither alone
// causes a miss:
//   A) LOOMROLE=<role> sign-off markers — a session signs its OWN role. A CLEAN single-role marker set is a
//      strong identity (handles a FRESH session right after /clear+/loom, whose worktree paths are swamped by a
//      `git worktree list`).
//   B) the DOMINANT worktree path (`worktrees/<role>`) — pervades a working session's output; survives scroll.
// DECISION: clean single marker -> that role; ELSE if one worktree path dominates -> that role; else null.
// The key fix (2026-07-11): MIXED markers do NOT short-circuit to null — a working session that merely QUOTED
// another role's sign-off (a handoff/diff) still resolves via its dominant worktree path. Only a frame that is
// ambiguous on BOTH signals (many roles, no dominant) is excluded as an orchestrator/viewer.

export interface Classification { role: string | null; purity: number; }

const LOOMROLE_LINE_RE = /^[\s>*`|\-]*LOOMROLE[\s=:]+([a-z][a-z0-9\-]+)\s*$/gim;
const WORKTREE_RE = /worktrees[\/\\]([a-z][a-z0-9\-]+)/gi;
const OWNER_ROLES = new Set(["product-owner", "productowner"]);
const PURITY_MIN = 0.8;

export function classify(text: string, validRoles: Set<string>): Classification {
  text = text || "";

  // A) markers
  const markers: string[] = [];
  let m: RegExpExecArray | null;
  LOOMROLE_LINE_RE.lastIndex = 0;
  while ((m = LOOMROLE_LINE_RE.exec(text)) !== null) {
    const r = m[1].toLowerCase();
    if (validRoles.has(r)) markers.push(r);
  }
  const distinctMarkers = new Set(markers);
  if (distinctMarkers.size === 1) {                       // clean single sign-off -> authoritative-ish
    const role = markers[0];
    if (!OWNER_ROLES.has(role)) return { role, purity: 1 };
  }
  // (distinctMarkers.size 0 or >=2 -> fall through to worktree paths; do NOT return null here)

  // B) dominant worktree path
  const score = new Map<string, number>();
  WORKTREE_RE.lastIndex = 0;
  while ((m = WORKTREE_RE.exec(text)) !== null) {
    const r = m[1].toLowerCase();
    if (validRoles.has(r)) score.set(r, (score.get(r) || 0) + 1);
  }
  if (score.size === 0) return { role: null, purity: 0 };
  let total = 0, dom = "", domN = 0;
  for (const [r, n] of score) { total += n; if (n > domN) { dom = r; domN = n; } }
  const purity = domN / total;
  if (OWNER_ROLES.has(dom)) return { role: null, purity };
  if (purity >= PURITY_MIN || score.size === 1) return { role: dom, purity };
  return { role: null, purity };                          // ambiguous on BOTH signals -> orchestrator/viewer
}
