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

// ── the mechanical-merge exemption (OV-001) ─────────────────────────────────────────────────────
//
// TWO FILES IN THIS REPO ARE TOUCHED BY ALMOST EVERY HANDOFF AND CONFLICT IN NEITHER. `package.json`
// churns by a one-line `version` bump; `test/mutation.py` churns by APPENDING to its `MUTATIONS`
// table. The orchestrator has resolved both by union repeatedly, mechanically, with no judgement.
// Measured over this repo's last 30 non-merge commits, all 435 pairs: 288 collide, and 253 of those
// are `test/mutation.py` or `package.json` alone. Exempt the two and it is 88 — so roughly four
// pairs in five could have run in parallel and were refused for a version line.
//
// WHY THE BLUNT FORM AND NOT THE PRINCIPLED ONE. The principled rule everyone wants is about the KIND
// of change — "a manifest whose only churn is a version line", "an append-only table". It is not
// derivable from what this function is given: a declared path STRING, judged before either handoff
// has been done. Whether a `package.json` is about to take a version bump or a dependency rewrite is
// a fact about an edit that does not exist yet, and the file on disk shows only its current state.
//
// An adversarial pass refused the stronger version of that claim, and it was right to. The intent is
// not unknowable — it is written in the brief's PROSE two lines away ("`0.53.0` is TAKEN by OV-001,
// this block is `0.54.0`"), and the `files:` list is itself a trusted statement about edits that have
// not happened, so a `files-append:` key would be the same trust at the same cost. tfg_ua already
// annotates its paths by hand (`files: tools/cardmaker/** (NEW)`). So the honest claim is narrower
// than "impossible": the KIND of a file is not expressible in the declaration format we have, and
// making it expressible means changing what every bus on the machine writes. That is a bigger change
// than this one and belongs to whoever decides the handoff format, not to the guard reading it.
// Until then §2 governs: a correct blunt rule beats a clever wrong one.
//
// WHY NOT CONFIGURABLE — and the honest cost of that. Both forms have the SAME misuse mode: name a
// real source file and the guard goes quiet for the file it exists to protect, saying nothing when it
// does. Hardcoding does not prevent that mistake; it makes the mistake arrive as a DIFF, reviewable,
// with this comment attached, instead of as a config edit nobody sees. The price is real and is paid
// by other buses: a `package.json` where two lanes rewrite dependencies IS the collision this module
// exists for, and on such a bus this exemption is wrong and unconfigurable. Measured today, no other
// bus collides at all, so the price is currently zero — but it is a bill that can arrive, and the
// remedy when it does is a per-bus list, not a cleverer rule.
//
// WHAT NEITHER FORM DOES, and it is the real gap: a refusal prints `overlaps X on Y`, while a
// NON-refusal caused by this exemption prints nothing anywhere. The guard is silent about the
// judgement it just made on the orchestrator's behalf.
//
// THE DIRECTION OF FAILURE. Unlike everything else on this bus, this guard REFUSES, so a false
// positive stalls a dispatch (§3). The exemption can only ever REMOVE a refusal, never create one —
// it strictly shrinks both declarations before they are compared — so its worst case is a missed
// collision on two files whose merge is the cheapest in the repo, and it cannot stall anything.
//
// A WILDCARD IS NEVER EXEMPTED AWAY. The test below is literal on the declared path: `*` is not
// expanded, so a handoff declaring `test/*` or `*` keeps that declaration in full and still collides
// with every real file the other side names. Only a declaration that IS one of these two files is
// dropped. Expanding the wildcard here would have been the dangerous reading — `*` matches
// `package.json`, so a sloppy `files: *` would have exempted ITSELF and refused nothing at all.

const MECHANICAL_MERGE = ["package.json", "test/mutation.py"];

/** Is this declared path one of the two files whose merge is a mechanical union (see above)?
 *  Segment-anchored like the collision test, so `loom-session-tracker/package.json` counts, but
 *  LITERAL — a declared `*` or `test/*` is a claim on more than the file and is never exempt. */
export function isMechanicalMerge(p: string | null | undefined): boolean {
  const s = normalizeDeclaredPath(p);
  if (!s) return false;
  return MECHANICAL_MERGE.some((n) => new RegExp(`(?:^|/)${n.replace(/[.+?^${}()|[\]\\*]/g, "\\$&")}$`).test(s));
}

/** The whole refusal decision, pure and testable without a bus: the first genuinely shared file of
 *  two declarations, with the mechanically-mergeable ones dropped from BOTH sides first. */
export function sharedFile(mine: string[], theirs: string[]): string | null {
  return firstShared(mine.filter((f) => !isMechanicalMerge(f)), theirs.filter((f) => !isMechanicalMerge(f)));
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
    const file = sharedFile(mine, handoffFiles(repo, other));
    if (file) return { role, other, file };
  }
  return null;
}

/** The one sentence a refusal carries, so the spawn path and the warning cannot drift apart. */
export function overlapReason(o: Overlap): string {
  return `overlaps ${o.other} on ${o.file}`;
}
