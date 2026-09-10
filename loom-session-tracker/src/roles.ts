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

import { isOwnerRole, canonicalRole } from "./naming";

export interface Classification {
  role: string | null;
  purity: number;
  /** Which signal identified the role. A `marker` is the session signing its OWN name; a `path` is
   *  merely text that mentions a worktree — and any session that DISPLAYS a board or a diff mentions
   *  worktrees. Measured 2026-09-09: a 325 KB diagnostic session that had printed livegita's board a
   *  few times classified as `developer` by path with purity 1, tied the real developer (69 KB, signs
   *  `LOOMROLE=gitadeveloper`, also purity 1) and WON the role on length. The tracker then sent that
   *  stranger the developer's usage-limit resume. Purity cannot separate these; the source can. */
  source: "marker" | "path" | null;
}

const LOOMROLE_LINE_RE = /^[\s>*`|\-]*LOOMROLE[\s=:]+([a-z][a-z0-9\-]+)\s*$/gim;
const WORKTREE_RE = /worktrees[\/\\]([a-z][a-z0-9\-]+)/gi;
const PURITY_MIN = 0.8;

export function classify(text: string, validRoles: Set<string>, repo?: string | null): Classification {
  text = text || "";
  // Fold this project's role aliases (bus `naming.json`) so two names for one agent score as ONE
  // role. Measured 2026-09-09: livegita's developer signs `LOOMROLE=gitadeveloper` but works in
  // `worktrees/developer`, so the two signals disagreed and the SAME session read as two agents
  // depending on which one happened to be on screen.
  const alias = (r: string) => canonicalRole(repo ?? null, r);

  // A) markers
  const markers: string[] = [];
  let m: RegExpExecArray | null;
  LOOMROLE_LINE_RE.lastIndex = 0;
  while ((m = LOOMROLE_LINE_RE.exec(text)) !== null) {
    const r = alias(m[1].toLowerCase());
    if (validRoles.has(r)) markers.push(r);
  }
  // ANY owner sign-off present settles it: a worker signs only its own role, and that role is never
  // an owner name. A CLEAN single marker was not enough — measured 2026-09-09, livegita's PO signed
  // `productowner` four times and quoted its developer's sign-off once, so the set was mixed, the
  // clean-single branch below did not fire, and nineteen `worktrees/developer` mentions carried it to
  // `developer`. This mirrors loom_cdp.py's own self-guard. A worker that merely QUOTES a PO handoff
  // is excluded too, and that is the safe direction: it becomes an un-targetable candidate rather
  // than a spawn/retire/delete/inject target, and a declaration or /loom binding still names it.
  if (markers.some((r) => isOwnerRole(r))) return { role: null, purity: 1, source: null };

  // (owner markers are already gone by here, so `markers` holds only worker roles)
  const distinctMarkers = new Set(markers);
  if (distinctMarkers.size === 1) return { role: markers[0], purity: 1, source: "marker" };
  // (distinctMarkers.size 0 or >=2 -> fall through to worktree paths; do NOT return null here)

  // B) dominant worktree path
  const score = new Map<string, number>();
  WORKTREE_RE.lastIndex = 0;
  while ((m = WORKTREE_RE.exec(text)) !== null) {
    const r = alias(m[1].toLowerCase());
    if (validRoles.has(r)) score.set(r, (score.get(r) || 0) + 1);
  }
  if (score.size === 0) return { role: null, purity: 0, source: null };
  let total = 0, dom = "", domN = 0;
  for (const [r, n] of score) { total += n; if (n > domN) { dom = r; domN = n; } }
  const purity = domN / total;
  if (isOwnerRole(dom)) return { role: null, purity, source: null };
  if (purity >= PURITY_MIN || score.size === 1) return { role: dom, purity, source: "path" };
  return { role: null, purity, source: null };            // ambiguous on BOTH signals -> orchestrator/viewer
}

/**
 * Is this frame the ORCHESTRATOR/PO session? classify() deliberately returns null for it (so it can
 * never be a retire/delete target), which also made it invisible in the sidebar — and therefore
 * impossible to tag. This detector exists ONLY to surface it as a tag candidate. Mirrors
 * loom_cdp.py's detect_role self-guard: a session that signs itself product-owner, or that quotes
 * three or more DISTINCT roles' sign-offs (a real worker only ever signs its own).
 */
export function detectOwner(text: string): boolean {
  text = text || "";
  const marks: string[] = [];
  LOOMROLE_LINE_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = LOOMROLE_LINE_RE.exec(text)) !== null) marks.push(m[1].toLowerCase());
  if (marks.some((r) => isOwnerRole(r))) return true;
  return new Set(marks.filter((r) => !isOwnerRole(r))).size >= 3;
}

/** The canonical orchestrator role name. `ownerRoleFor(repo)` is what tagging actually uses — it
 *  prefers the owner mailbox the bus already has (livegita's `po/`). See naming.ts. */
export { OWNER_CANONICAL as OWNER_ROLE_NAME, isOwnerRole, ownerRoleFor } from "./naming";

// ── which PROJECT a frame is about ──────────────────────────────────────────────────────────
// A worker frame says which role it is (above). An ORCHESTRATOR frame says no such thing — it is
// excluded from role classification by design — so nothing here could tell which project's
// orchestrator it was. That mattered the moment tagging worked: `ownerView()` is editor-WIDE (the
// CDP read sees every window), so "the only detected orchestrator frame" was adopted by every
// project window at once. Measured live 2026-09-09, one frame (a8faad83) was tagged as the
// orchestrator of BOTH Gaming and livegita while being neither: its text mentions shwab_docker 24
// times and the other two zero times.
//
// A session working on a project cannot avoid naming its paths — its bus (`loom/<repo>/`) and its
// checkout (`Containers/<repo>/`). Measured across the same read, the signal is not close:
//   9130bb00 Gaming:76   3c1e2d8b livegita:115   51d1f960 funisland:36   a8faad83 shwab_docker:24
// and only one frame mentioned two projects at all (funisland:3 Gaming:2 — correctly ambiguous).
const REPO_PATH_RE = (repo: string) =>
  new RegExp(`(?:loom|Containers|worktrees)[\\/\\\\]${repo.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}[\\/\\\\]`, "g");

export interface RepoAttribution { repo: string | null; purity: number; hits: number; }

/**
 * Which project a frame is about, by dominant path mentions. `null` when nothing is mentioned or no
 * project dominates — an unattributable frame is never adopted, which is the safe direction: the
 * cycle then reports that it cannot identify the orchestrator instead of typing into a stranger.
 */
export function attributeRepo(text: string, repos: string[]): RepoAttribution {
  const t = text || "";
  let total = 0, dom: string | null = null, domN = 0;
  for (const repo of repos) {
    if (!repo) continue;
    const n = (t.match(REPO_PATH_RE(repo)) || []).length;
    if (!n) continue;
    total += n;
    if (n > domN) { dom = repo; domN = n; }
  }
  if (!dom) return { repo: null, purity: 0, hits: 0 };
  const purity = domN / total;
  return purity >= PURITY_MIN ? { repo: dom, purity, hits: domN } : { repo: null, purity, hits: domN };
}
