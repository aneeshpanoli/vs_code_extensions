// overlap.ts — ONE JOB: two live handoffs on one bus must not touch the same files.
//
// WHY (CH-001, playbook §19, owner decision 2026-09-13). The fixed cost of a handoff is the same
// whatever its size — ~40 mechanical orchestrator calls, three gate runs, a merge — so §19 sets a
// size rule (one handoff is one merge) and a parallelism rule (one developer per file-disjoint
// package). The parallelism rule is the one a machine can enforce: the handoff's frontmatter
// declares `files:`, and this refuses to spawn a second handoff that intersects a first.
//
// A rule nobody enforces drifts. Two developers on one file is not a hypothetical here: the branches
// are isolated worktrees precisely because it happened, and the cost is paid at MERGE time, hours
// after the mistake, by the orchestrator rather than by whoever made it.
//
// THE GUARD HAS NO OPINION WHERE NOTHING WAS DECLARED, and that is deliberate (principle 16, and the
// handoff's own law: "Never refuse on absence of a `files:` line"). Both sides need a declaration.
// An undeclared handoff is not a handoff that touches nothing — it is one we cannot judge, and
// refusing a spawn on a silence would make the `files:` line compulsory by stealth, breaking every
// bus on the machine that has not adopted it yet.
//
// WHAT COUNTS AS THE SAME FILE. Two rules, both of which had to exist:
//  - a `*` wildcard, translated to `.*` as the handoff specifies, so `src/*.ts` collides with
//    `src/models.ts`;
//  - a SEGMENT-anchored suffix match, because the same file is written from two different roots on
//    this very bus: CH-001's own frontmatter says `src/models.ts` (relative to the extension dir)
//    while RB-001's status.json listed `loom-session-tracker/src/models.ts` (relative to the repo
//    root). Comparing those as strings would have called the collision this guard exists for
//    "disjoint". Anchoring on `/` is what keeps it from also matching `other/src/mymodels.ts`.
//
// The suffix rule can over-match in one shape — a bare `models.ts` collides with any directory's
// `models.ts` — and that direction is the correct one to be wrong in: an over-match costs the
// orchestrator one re-read of two briefs, an under-match costs a merge conflict discovered an hour
// later. It is also entirely in the writer's hands: declare a path with a directory in it.

import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { boardRoles } from "./registry";
import { handoffFiles, normalizeDeclaredPath } from "./models";

const LOOM_ROOT = path.join(os.homedir(), ".claude", "loom");

/** A declared pattern as a segment-anchored suffix regex. `*` -> `.*`, everything else literal. */
function patternRe(p: string): RegExp {
  const body = p.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*");
  return new RegExp(`(?:^|/)${body}$`);
}

/** Do two declared paths name the same file? Symmetric: either may be the wildcard or the longer root. */
export function pathsCollide(a: string | null | undefined, b: string | null | undefined): boolean {
  const x = normalizeDeclaredPath(a), y = normalizeDeclaredPath(b);
  if (!x || !y) return false;                        // an empty declaration collides with nothing
  try { return patternRe(x).test(y) || patternRe(y).test(x); } catch { return false; }
}

/** The first of `mine` that any of `theirs` also claims, or null. Pure — the whole decision, testable
 *  without a bus on disk. Reported in MINE's spelling: it is the declaration being refused. */
export function firstShared(mine: string[], theirs: string[]): string | null {
  for (const m of mine) for (const t of theirs) if (pathsCollide(m, t)) return m;
  return null;
}

/** A role's status.json `status`, lowercased, or null when it is absent or unreadable. */
function statusOf(repo: string, role: string): string | null {
  try {
    const d = JSON.parse(fs.readFileSync(path.join(LOOM_ROOT, repo, role, "status.json"), "utf8"));
    if (!d || typeof d !== "object") return null;
    const s = String(d.status || "").trim().toLowerCase();
    return s || null;
  } catch { return null; }
}

/** Roles of this bus that say they are WORKING right now. The roster is `boardRoles` — the board
 *  UNION every role owning a mailbox — for the same reason the worktree guard uses it (principle 17):
 *  it is the set that actually holds handoffs, at any age. */
export function workingRoles(repo: string): string[] {
  return boardRoles(repo).filter((r) => statusOf(repo, r) === "working");
}

export interface Overlap {
  /** The role being judged. */
  role: string;
  /** The working role it collides with. */
  other: string;
  /** The first shared file, in `role`'s own spelling. */
  file: string;
}

/**
 * The overlap that should refuse `role`, or null.
 *
 * Judged against every OTHER role of this bus that is currently `working`, plus `alsoLive` — roles
 * that are not working yet but are being opened in this same breath, which is the case §19 cares
 * about most: one `open-requests.json` naming two roles whose briefs collide would otherwise spawn
 * both and the disjointness rule would never have been consulted at all.
 */
export function overlapFor(repo: string | null, role: string, alsoLive: string[] = []): Overlap | null {
  if (!repo || !role) return null;
  const mine = handoffFiles(repo, role);
  if (!mine.length) return null;                     // declared nothing -> no opinion. Never refuse on absence.
  const others = new Set<string>(alsoLive);
  for (const r of workingRoles(repo)) others.add(r);
  others.delete(role);                               // a role never overlaps itself
  for (const other of Array.from(others).sort()) {
    const file = firstShared(mine, handoffFiles(repo, other));
    if (file) return { role, other, file };
  }
  return null;
}

/** The one sentence a refusal carries, so the spawn path and the warning cannot drift apart. */
export function overlapReason(o: Overlap): string {
  return `overlaps ${o.other} on ${o.file}`;
}
