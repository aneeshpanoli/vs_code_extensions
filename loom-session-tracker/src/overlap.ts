// overlap.ts — ONE JOB: two live handoffs on one bus must not touch the same files (CH-001, §19).
//
// §19's parallelism rule (one developer per file-disjoint package) is the half a machine can enforce:
// the handoff's frontmatter declares `files:`, and this refuses to spawn a second handoff that
// intersects a first. The cost of getting it wrong is paid at MERGE time, hours later, by the
// orchestrator rather than by whoever made the mistake.
//
// NO OPINION WHERE NOTHING WAS DECLARED (principle 16; the handoff's law "Never refuse on absence of
// a `files:` line"). An undeclared handoff is one we cannot judge, not one that touches nothing, and
// refusing on silence would make `files:` compulsory by stealth for every bus that has not adopted it.
//
// SAME FILE means two things: a `*` wildcard translated to `.*` as the handoff specifies, and a
// SEGMENT-anchored suffix match, because one file is declared from two different roots on this bus
// (`src/models.ts` vs `loom-session-tracker/src/models.ts` — string equality called that "disjoint").
// Anchoring on `/` keeps it from also matching `other/src/mymodels.ts`. The suffix rule over-matches
// in one shape — a bare `models.ts` hits any directory's — and that is the correct direction to be
// wrong in (an over-match costs a re-read; an under-match costs a merge conflict), and the writer
// controls it by declaring a path with a directory in it.

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
// These three files are touched by almost every handoff here and conflict in none: `package.json`
// churns by a one-line `version` bump, `test/mutation.py` by appending to its `MUTATIONS` table,
// `HANDOVER.md` by appending a dated section. The orchestrator has resolved all three by union
// repeatedly, with no judgement — that history, not a property claim, is the evidence. Over the last
// 30 non-merge commits (435 pairs) roughly two refused pairs in three were refused over a version
// line. Quote that RATIO with its window, never a count: the counts move a lot between windows.
// The handover is third on OV-001-R1 §2, which the orchestrator ratified — worth knowing, because the
// FOURTH entry was later admitted on the same argument and then reversed.
//
// WHY THE BLUNT FORM. The rule everyone wants is about the KIND of change ("a manifest whose only
// churn is a version line"), and the kind of a file is not expressible in the declaration format we
// have; making it expressible (a `files-append:` key, say) changes what every bus on the machine
// writes and belongs to whoever owns the handoff format. Until then §2 governs: a correct blunt rule
// beats a clever wrong one. Not configurable, because both forms share the same misuse mode — name a
// real source file and the guard goes quiet for the file it exists to protect — and hardcoding at
// least makes that mistake arrive as a reviewable DIFF. The price is real but unpaid: a `package.json`
// where two lanes rewrite dependencies IS the collision this module exists for, and there the
// exemption is wrong and unfixable without a per-bus list — measured, though, no other bus collides
// at all today, so the bill is zero until it arrives, and the per-bus list is the remedy then.
//
// THE EXEMPTION MUST NEVER BE SILENT (OV-001-R1 §1(3)): a refusal prints `overlaps X on Y`, so a
// non-refusal caused by this must be reported too — `exemptionFor` below is that other half, rendered
// at the same two places a refusal is.
//
// DIRECTION OF FAILURE. This guard REFUSES, so a false positive stalls a dispatch (§3). The exemption
// strictly shrinks both declarations before comparing, so it can only ever REMOVE a refusal: its
// worst case is a missed collision on the three cheapest merges in the repo, never a stall.
//
// A WILDCARD IS NEVER EXEMPTED AWAY. The test is literal on the declared path, so `test/*` or `*`
// keeps its full claim. Expanding the wildcard would be the dangerous reading: `*` matches
// `package.json`, so a sloppy `files: *` would exempt ITSELF and refuse nothing at all.

// `README.md` WAS A FOURTH AND WAS TAKEN BACK (OV-001-R2 §1). This extension is ONE build serving
// every bus, so the list judges every README every bus declares — and on hackomics the README IS the
// product (`~/.claude/loom/hackomics/developer1/inbox.md` declares
// `files: public/index.html, public/styles.css, README.md`). Meet that case before proposing a docs
// exemption again; it bought under 1% of parallelism at its historical best and none today.
// `HANDOVER.md` survives the same test only because no bus declares it as product — a guard that goes
// quiet is judged by what the QUIETEST bus loses, never by what the busiest gains.
//
// AND IT STOPS AT THREE: the next candidate is a judgement about one bus's habits, i.e. a per-bus list.
//
// Segment-anchored and literal, so `docs/HANDOVER.md` or `node_modules/x/package.json` is exempt too,
// and a glob that would have claimed one (`docs/**`) goes quiet — the same over-match `package.json`
// already has, in the direction that can only drop refusals.
const MECHANICAL_MERGE = ["package.json", "test/mutation.py", "HANDOVER.md"];

/** Is this declared path one of the three files whose merge is a mechanical union (see above)?
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
 *  null. The exact complement of `sharedFile`: a real shared file means the pair refuses anyway.
 *
 *  Reports the EXEMPT side of the first suppressed pair, which is not always the side being judged
 *  (`mine: ["*"]` against `theirs: ["package.json"]` is suppressed by the other side's manifest).
 *  The exempt file is the actionable one: it is what two roles are about to edit unguarded. */
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
 * Judged against every OTHER `working` role of this bus, plus `alsoLive` — roles being opened in the
 * same breath. That case matters most: one `open-requests.json` naming two roles whose briefs collide
 * would otherwise spawn both without the disjointness rule ever being consulted.
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
 * What `overlapFor` decided NOT to refuse — or null when it refused, or when the pair is genuinely
 * disjoint and no judgement was made at all.
 *
 * A REFUSAL WINS: a note about a waved-through file is noise on top of a blocked spawn. Deliberately
 * the same others-set in the same sorted order as `overlapFor`, so the note cannot disagree with the
 * decision it annotates.
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
