// duties.ts — §19: TWO LIVE BLOCKS ON ONE FILE.
//
// ── THE DUTY ───────────────────────────────────────────────────────────────────────────────────
//
// Owner: "It is better for us to make the files modular so there is never more than one worker on
// any file", and "the add-on should remind us to refactor when things get out of hand." Then, in
// the same sitting: "this should also be part of the session add-on, so the orchestrators know
// their duties."
//
// Playbook §19 is the parallelism clause: one handoff is one merge, and two live handoffs must not
// be working the same file. The decision is genuinely the ORCHESTRATOR's — it chooses what to
// dispatch, to whom, and when — so this is rank 3 on PB-001's ladder (DETECTED and reminded), not
// rank 4 (text). It attaches no duty list and no playbook digest to any message: that was the trap
// this block's brief named, and it is the one PB-001 hit.
//
// ── WHAT THIS DETECTOR IS NOT, AND WHY ─────────────────────────────────────────────────────────
//
// The brief proposed collision-ness over history: "this file was touched by N of the last M blocks,
// so any two of them could not have run in parallel under §19." I built that first, measured it, had
// a subagent try to refute it, and the refutation held. Three things killed it, and they are
// recorded here because the next person will propose it again:
//
// 1. IT IS CHURN WEARING A DISGUISE. Of 88 cross-role block PAIRS sharing `test/mutation.py`, only
//    7 were ever LIVE AT THE SAME TIME — 8%. Counting blocks that touched a file over four days
//    answers "who edited this", not "who could not run in parallel". Those are different questions
//    and on this repo the ratio between them is about 12:1. MOD-001 reached the same conclusion from
//    the other end: removing `extension.ts` from every handoff changed colliding pairs by ZERO.
//
// 2. ITS TOP RESULT WAS A FALSE POSITIVE. The ranking put `test/mutation.py` first — 2,583 lines of
//    an append-only `MUTATIONS = [...]` list, where every block appends its own tuples under its own
//    banner. Appends to disjoint regions of a list literal are the cheapest merge git has. A
//    reminder whose first firing says "refactor this, work cannot be parallel" about a file that
//    merges cleanly by construction burns its credibility on its first firing — which is exactly how
//    the stall alarm was devalued.
//
// 3. THE ROLE SIGNAL WAS TOO THIN TO CARRY IT. Role per block comes from `model-ledger.jsonl`, and 7
//    of the last 30 blocks have no row there. Reassigning those 7 adversarially flips two of the
//    three files it fired on, and flips one it excluded INTO firing. A verdict that changes under
//    the unknowns is not a verdict.
//
// So the history metric is gone, and with it the "is this file splittable" judgement it needed —
// which was the part that excluded `package.json` (a real, constant collider) while firing on
// `mutation.py` (not one). A rule that has to rank files by taste is a lint, and the brief was
// explicit that a lint is what this must not be.
//
// ── WHAT IT IS INSTEAD ─────────────────────────────────────────────────────────────────────────
//
// The thing §19 actually says, measured directly and in the present tense: TWO ROLES THAT ARE
// WORKING RIGHT NOW, AND HAVE BOTH ALREADY EDITED THE SAME FILE. Not a proxy for it — the condition
// itself, read off the worktrees.
//
// This is better than the history metric on every axis that mattered:
//   · No inference. It does not ask whether two blocks COULD have collided; it observes that two
//     live ones HAVE.
//   · No declarations. `overlap.ts` already enforces §19 from the handoffs' `files:` front-matter,
//     and it has never refused anything on this bus — 3 of 25 blocks declare `files:` at all, and
//     `declaredFiles` reads one line so a multi-line YAML list declares nothing. This reads what the
//     worktrees actually contain, so it works on the six buses out of seven that declare nothing.
//     (It does not touch `overlap.ts`, which is owned by another live handoff.)
//   · No taste. There is no "is this file splittable" question, because the finding is not "refactor
//     this" — it is "these two are on it NOW". `package.json` is handled by an exclusion that is
//     stated and tested, not by a judgement about file kinds.
//   · It is actionable BEFORE the cost is paid. A history-based reminder arrives after the collision;
//     this one arrives while both workers are still typing, when the orchestrator can still sequence
//     the merges or move one of them off the file.
//
// ── BELIEVABILITY (brief §4) ───────────────────────────────────────────────────────────────────
//
// Four reminders exist and one was wrong four times in two days. Every false-positive class below is
// named here, excluded before any threshold, and asserted in BOTH directions in test/duties.test.js
// — an exclusion that also suppressed the true positive would be worse than no detector. The latch
// is on the EVENT (the pair of handoffs), never on the condition: delegation.ts is the precedent and
// the stall alarm, which re-armed whenever its condition cleared, is the anti-precedent.

import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { execFileSync } from "child_process";

const LOOM_ROOT = path.join(os.homedir(), ".claude", "loom");

/**
 * FALSE POSITIVE 1 — files the bus SERIALISES ON PURPOSE.
 *
 * Every block bumps the manifest version, so two live blocks always touch `package.json`, and this
 * detector would fire on it every single time. It is a true collision and a useless reminder: the
 * orchestrator already handles it by assigning each block its own version (0.53.0 to OV-001 and
 * 0.54.0 to DU-001, in this very pair of blocks), and banks them in sequence. A reminder that fires
 * on the one collision the process has already solved is the noise that devalues the other four.
 *
 * NARROW ON PURPOSE. This is a list of files the bus's own process serialises, not a list of files
 * that are "allowed" to collide — and it is asserted in both directions, because a version bump
 * hiding a real `package.json` change (a new dependency, a changed entry point) is exactly the kind
 * of exclusion that quietly swallows a true positive.
 */
export const SERIALISED_BY_PROCESS: ReadonlyArray<RegExp> = [
  /(^|\/)package\.json$/,
  /(^|\/)package-lock\.json$/,
];

/** FALSE POSITIVE 2 — build output. `status --porcelain` honours .gitignore, but a branch diff can
 *  still carry committed build artefacts, and two workers both compiling is not a §19 finding. */
export const NOT_SOURCE: ReadonlyArray<RegExp> = [
  /(^|\/)out\//,
  /(^|\/)node_modules\//,
  /(^|\/)dist\//,
];

/** Is this path one the detector has an opinion about? */
export function isCollidable(file: string): boolean {
  const f = String(file || "").trim();
  if (!f) return false;
  for (const re of SERIALISED_BY_PROCESS) if (re.test(f)) return false;
  for (const re of NOT_SOURCE) if (re.test(f)) return false;
  return true;
}

/** What one role has touched in its current block. */
export interface RoleWork {
  role: string;
  /** The block the role is on, for the latch and for the message. */
  handoff: string | null;
  /** Repo-relative paths this role has edited — committed on its branch, or still uncommitted. */
  files: string[];
}

/** Two live roles on one file. */
export interface Collision {
  /** Sorted, so a pair has ONE identity however the roles were ordered. */
  roles: [string, string];
  handoffs: [string | null, string | null];
  /** Every file they share, sorted. The message names the first and counts the rest. */
  files: string[];
}

/**
 * The whole decision, as a PURE function of what each role has touched.
 *
 * Pure on purpose: every claim this detector makes is then testable against literal file lists, with
 * no git, no worktrees, no clock and no bus. `gatherWork` below is the only part that touches the
 * filesystem, and it has nothing to decide.
 */
export function collisions(works: ReadonlyArray<RoleWork>): Collision[] {
  // FALSE POSITIVE 3 — a single-worker bus. With fewer than two live roles there is no pair, so
  // there is nothing to say. Most buses on this machine are in this state most of the time.
  const live = works.filter((w) => w && w.role && Array.isArray(w.files) && w.files.length);
  if (live.length < 2) return [];
  const out: Collision[] = [];
  for (let i = 0; i < live.length; i++) {
    for (let j = i + 1; j < live.length; j++) {
      const a = live[i];
      const b = live[j];
      // FALSE POSITIVE 4 — a role never collides with itself. A role that appears twice (a stale
      // board entry beside a live one) would otherwise report itself as a collision.
      if (a.role === b.role) continue;
      const bFiles = new Set(b.files.filter(isCollidable));
      const shared = a.files.filter((f) => isCollidable(f) && bFiles.has(f));
      if (!shared.length) continue;
      const roles: [string, string] = a.role < b.role ? [a.role, b.role] : [b.role, a.role];
      const handoffs: [string | null, string | null] =
        a.role < b.role ? [a.handoff, b.handoff] : [b.handoff, a.handoff];
      out.push({ roles, handoffs, files: Array.from(new Set(shared)).sort() });
    }
  }
  return out;
}

// ── READING WHAT A WORKTREE CONTAINS ───────────────────────────────────────────────────────────

/** Injected so the pure logic above can be tested without a repo, and so a slow or broken git can
 *  never break the tick. Mirrors the `git()` wrapper already used in workledger.ts and health.ts. */
export type GitRunner = (cwd: string, args: string[]) => string | null;

export const realGit: GitRunner = (cwd, args) => {
  try {
    return execFileSync("git", ["-C", cwd, ...args], {
      encoding: "utf8",
      timeout: 5000,
      maxBuffer: 8 * 1024 * 1024,
      stdio: ["ignore", "pipe", "ignore"],
    });
  } catch {
    return null;
  }
};

/**
 * The branch a worker's block is measured AGAINST. Almost always `main`, but a bus on `master` would
 * otherwise get an empty diff from every role and never report anything — a silent detector that
 * looks healthy, which is the worst failure mode available. Probed, then defaulted.
 */
export function baseBranch(worktree: string, git: GitRunner = realGit): string {
  for (const cand of ["main", "master"]) {
    if (git(worktree, ["rev-parse", "--verify", "--quiet", cand])) return cand;
  }
  return "main";
}

/** `git status --porcelain` lines to paths, handling renames (`R  old -> new`). */
export function parsePorcelain(out: string | null): string[] {
  const files: string[] = [];
  for (const raw of String(out || "").split("\n")) {
    const line = raw.replace(/\r$/, "");
    if (line.length < 4) continue;
    let p = line.slice(3).trim();
    const arrow = p.indexOf(" -> ");
    if (arrow >= 0) p = p.slice(arrow + 4).trim();
    if (p.startsWith('"') && p.endsWith('"') && p.length > 1) p = p.slice(1, -1);
    if (p) files.push(p);
  }
  return files;
}

/**
 * Everything a role has touched in its current block: what it has committed on its own branch since
 * it diverged from `base`, plus what is still uncommitted in its worktree.
 *
 * BOTH HALVES ARE REQUIRED and each one alone is a defect. A worker that has committed but not been
 * merged is invisible to `status --porcelain`; a worker that has not committed yet — which is most
 * of a block, and was true of the other live role while this very block was being written — is
 * invisible to the branch diff. Measured on this bus 2026-09-17: the role working OV-001 had ZERO
 * committed files and its whole block lived in uncommitted state.
 */
export function gatherWork(
  worktree: string,
  base: string,
  handoff: string | null,
  role: string,
  git: GitRunner = realGit,
): RoleWork {
  const files = new Set<string>();
  // `base...HEAD` is the three-dot form deliberately: it asks what THIS branch changed since it
  // diverged, not what has happened on main in the meantime. With two dots, every commit the
  // orchestrator banked from the other worker would read as this worker's own work.
  for (const f of String(git(worktree, ["diff", "--name-only", `${base}...HEAD`]) || "").split("\n")) {
    const p = f.trim();
    if (p) files.add(p);
  }
  for (const p of parsePorcelain(git(worktree, ["status", "--porcelain"]))) files.add(p);
  return { role, handoff, files: Array.from(files).sort() };
}

// ── THE LATCH ──────────────────────────────────────────────────────────────────────────────────
//
// Keyed on the PAIR OF BLOCKS, which is the event. Two roles working the same file for an hour is
// ONE finding, not 240 of them at a 15-second tick. It re-arms when either role moves to a new
// block — a genuinely new pair of handoffs is a genuinely new collision — and never when the
// condition merely clears and returns, which is the stall alarm's bug.
//
// The FILE SET is deliberately NOT part of the latch key. If it were, every further file the two
// roles touched would re-arm the reminder and the pair would report itself again and again as the
// blocks grew — the same defect in slower motion.

export interface OverlapState {
  /** `role|role` -> the pair of handoffs we last reported for it. */
  reported: Record<string, string>;
}

export interface OverlapResult {
  state: OverlapState;
  finding: Collision | null;
  skip: string | null;
}

export function emptyOverlapState(): OverlapState {
  return { reported: {} };
}

/** The latch key for a pair: the two roles and the two blocks they are on. */
export function pairKey(c: Collision): string {
  return `${c.roles[0]}|${c.roles[1]}`;
}
function blockKey(c: Collision): string {
  return `${c.handoffs[0] ?? "?"}|${c.handoffs[1] ?? "?"}`;
}

/** Decide whether this set of live collisions earns a reminder. PURE. */
export function overlapFinding(state: OverlapState, found: ReadonlyArray<Collision>): OverlapResult {
  const st: OverlapState = { reported: { ...state.reported } };
  if (!found.length) return { state: st, finding: null, skip: "no two live roles share a file" };
  for (const c of found) {
    if (st.reported[pairKey(c)] === blockKey(c)) continue;
    return { state: st, finding: c, skip: null };
  }
  return { state: st, finding: null, skip: "already reminded for these blocks" };
}

/** Mark it delivered. Called ONLY on a successful injection, like every other reminder on this bus. */
export function markOverlapReminded(state: OverlapState, c: Collision): OverlapState {
  return { reported: { ...state.reported, [pairKey(c)]: blockKey(c) } };
}

/**
 * The message. ONE line of finding, ONE line of what to do. The build stamp and the reporting
 * contract are appended at the injection chokepoint (`withContract`), so this must repeat neither.
 *
 * It names the FILE and the two BLOCKS, because those are what the orchestrator acts on. It does
 * NOT say "refactor" or "split": the measurement supports "these two are on it now", and it does
 * not support a claim about how the file should be shaped. A reminder that overstates what it
 * measured is the kind that gets ignored.
 */
export function overlapReminder(c: Collision): string {
  const [r1, r2] = c.roles;
  const [h1, h2] = c.handoffs;
  const more = c.files.length > 1 ? ` (+${c.files.length - 1} more)` : "";
  const b1 = h1 ? ` (${h1})` : "";
  const b2 = h2 ? ` (${h2})` : "";
  return (
    `[loom-overlap] ${r1}${b1} and ${r2}${b2} are both editing ${c.files[0]}${more}\n` +
    `§19: one handoff is one merge. Sequence the banks, or move one of them off that file — ` +
    `whichever merges second will be resolving a conflict you can still prevent.`
  );
}

// ── STATE FILE ─────────────────────────────────────────────────────────────────────────────────
// Per-repo, atomic (tmp + rename), change-only, never throws — the idiom every other detector on
// this bus uses. A reminder subsystem that could break the tick would be worse than no reminder.

function file(repo: string, root = LOOM_ROOT): string {
  return path.join(root, repo, "duties-state.json");
}

export function loadOverlapState(repo: string, root = LOOM_ROOT): OverlapState {
  try {
    const raw = JSON.parse(fs.readFileSync(file(repo, root), "utf8"));
    if (raw && typeof raw === "object" && raw.reported && typeof raw.reported === "object") {
      return { reported: raw.reported };
    }
  } catch {
    /* absent or malformed — a fresh state is the right answer either way */
  }
  return emptyOverlapState();
}

export function saveOverlapState(repo: string, st: OverlapState, root = LOOM_ROOT): boolean {
  const f = file(repo, root);
  try {
    const cur = JSON.parse(fs.readFileSync(f, "utf8"));
    delete cur.updatedAt;
    if (JSON.stringify(cur) === JSON.stringify({ reported: st.reported })) return false;
  } catch {
    /* unreadable or absent — fall through and write */
  }
  try {
    fs.mkdirSync(path.dirname(f), { recursive: true });
    const tmp = f + ".tmp." + process.pid;
    fs.writeFileSync(tmp, JSON.stringify({ ...st, updatedAt: new Date().toISOString() }, null, 2));
    fs.renameSync(tmp, f);
    return true;
  } catch {
    return false;
  }
}
