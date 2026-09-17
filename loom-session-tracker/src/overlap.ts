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
// FOUR FILES IN THIS REPO ARE TOUCHED BY ALMOST EVERY HANDOFF AND CONFLICT IN NONE OF THEM.
// `package.json` churns by a one-line `version` bump; `test/mutation.py` churns by APPENDING to its
// `MUTATIONS` table; `HANDOVER.md` and `README.md` churn by appending a section or a line. The
// orchestrator has resolved all four by union repeatedly, mechanically, with no judgement.
//
// THE MEASUREMENT, AND ITS WINDOW. Over this repo's last 30 non-merge commits, all 435 pairs: 307
// collide, 86 with the manifest and the registry exempted, 83 with all four. So roughly THREE pairs
// in five were refused over a version line and could have run in parallel. The digit moves: the same
// script read 288/88 when OV-001 was written two days ago, and 87-98 across six adjacent windows, so
// the finding is robust and the number is not — quote the ratio, never the count.
//
// THE TWO DOCS BUY ALMOST NOTHING TODAY (86 -> 83, three pairs), and they are in the list anyway,
// because the argument for them is the argument for `test/mutation.py` and a list that holds one and
// not the others is a list that will be re-litigated. Their throughput case is weaker than the
// manifest's by an order of magnitude and should not be claimed otherwise.
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
// THE SILENCE IS FIXED (OV-001-R1 §1(3)), and it was the worst of the three findings. A refusal
// prints `overlaps X on Y`; a non-refusal CAUSED by this exemption printed nothing anywhere, so the
// guard made a judgement on the orchestrator's behalf and never said it had. `exemptionFor` below is
// the other half of `overlapFor`, reported at the same two places a refusal is — the spawn result and
// the status-bar warning — naming the file it let through. That defect class is what this product has
// been chasing all week: a value computed and then never rendered.
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

// FOUR FILES, NOT TWO (OV-001-R1 §2). The principle that exempts the first two reaches the two docs
// as well, and the orchestrator agreed it did. `HANDOVER.md` collides in 6 of this repo's last 435
// commit pairs and `README.md` in 3, and both churn the way `test/mutation.py` does: an APPEND — a
// new dated section at the end of the handover, a new line in a feature list. A doc merge here is as
// mechanical as a version bump, and nobody has ever had to think about one.
//
// AND IT STOPS AT FOUR. The next candidate is a judgement about a specific bus's habits rather than
// about the kind of change, which is a per-bus list and a different block.
//
// THE BILL HAS ALREADY ARRIVED, and it is worth being exact about rather than hedging. When the first
// two were exempted, the cost was written here as a bill that COULD arrive on some other bus. It has:
// `~/.claude/loom/hackomics/developer1/inbox.md` declares `files: public/index.html,
// public/styles.css, README.md` — on that bus the README is the product, the copy of a landing page,
// edited in earnest by whoever owns the page. This extension is one build serving every bus on the
// machine, so from now on two hackomics roles rewriting that README in parallel are dispatched
// unguarded. They are not dispatched SILENTLY — the exemption note names the file, which is the whole
// of §1(3)'s value here — but the note is all they get. The remedy is the per-bus list, and it is a
// different block. Added anyway because the orchestrator ordered it knowing the principle; the
// measured counter-example is recorded here so nobody has to rediscover it.
//
// Segment-anchored and literal, so a `docs/README.md` or a `node_modules/x/README.md` in any
// directory is exempt too, and a glob that would have claimed one (`docs/**` against
// `docs/README.md`) now goes quiet. That is the same over-match `package.json` already has, in the
// direction that can only drop refusals — and one more reason the list stops here.
const MECHANICAL_MERGE = ["package.json", "test/mutation.py", "HANDOVER.md", "README.md"];

/** Is this declared path one of the four files whose merge is a mechanical union (see above)?
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

/** The file this exemption LET THROUGH, when it is the only reason there is no refusal — otherwise
 *  null. Pure, and the exact complement of `sharedFile`: a real shared file means the pair refuses
 *  anyway and nothing was suppressed, so there is nothing to report.
 *
 *  The name reported is the EXEMPT side of the first suppressed pair, which is not always the side
 *  being judged: `mine: ["*"]` against `theirs: ["package.json"]` is suppressed by the OTHER side's
 *  manifest, and `*` is what was claimed, not what was let through. Naming the exempt file is what
 *  makes the note actionable — it is the file two roles are about to edit unguarded. */
export function exemptedShare(mine: string[], theirs: string[]): string | null {
  if (sharedFile(mine, theirs)) return null;         // it refuses on its own merits; nothing was let through
  for (const m of mine) for (const t of theirs) {
    if (!pathsCollide(m, t)) continue;
    return isMechanicalMerge(m) ? normalizeDeclaredPath(m) : normalizeDeclaredPath(t);
  }
  return null;                                       // genuinely disjoint: the guard judged nothing
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

/** A collision the exemption suppressed: the pair runs, and this is the file nobody is guarding. */
export interface Exemption {
  /** The role being judged — the one that is NOT being refused. */
  role: string;
  /** The working (or same-breath) role it shares the file with. */
  other: string;
  /** The mechanically-mergeable file that was let through. */
  file: string;
}

/**
 * What `overlapFor` decided NOT to refuse, and why — or null when it refused, or when the pair is
 * genuinely disjoint and no judgement was made at all.
 *
 * A REFUSAL WINS. If any other role refuses `role`, this returns null: the dispatch is not happening,
 * so a note about a file that would have been waved through is noise on top of a blocked spawn. This
 * is deliberately the same others-set, in the same sorted order, as `overlapFor` — the two answer one
 * question between them, and a note that disagreed with the decision it annotates would be worse than
 * silence.
 */
export function exemptionFor(repo: string | null, role: string, alsoLive: string[] = []): Exemption | null {
  if (!repo || !role) return null;
  const mine = handoffFiles(repo, role);
  if (!mine.length) return null;                     // declared nothing -> no judgement to report
  const others = new Set<string>(alsoLive);
  for (const r of workingRoles(repo)) others.add(r);
  others.delete(role);
  let found: Exemption | null = null;
  for (const other of Array.from(others).sort()) {
    const theirs = handoffFiles(repo, other);
    if (sharedFile(mine, theirs)) return null;       // this pair refuses; the refusal is the report
    const file = exemptedShare(mine, theirs);
    if (file && !found) found = { role, other, file };
  }
  return found;
}

/** The one clause an exemption carries, so the spawn result and the warning cannot drift apart.
 *  Short by instruction: it sits beside `overlaps X on Y`, and reads as its opposite. */
export function exemptionReason(e: Exemption): string {
  return `shares ${e.file} with ${e.other}, allowed as a mechanical merge`;
}
