// workledger.ts — ONE JOB: answer "how much of this week's output actually SHIPS?" from evidence a
// session cannot author about itself. Pure fs + `git`; no vscode import, so it is testable headless.
//
// WHY THIS FILE EXISTS (owner audit, 2026-09-15). Two products ran ~70,000 agent turns and ~15
// billion cache-read tokens in seven days, and the owner's reading of it was "coding nonstop for
// days and the product hasn't moved much at all." Measured from git, it had not: 10.7 % of
// ReciEats' changed lines reached a user's screen, 171 of 614 commits did nothing but update the
// guide, 0 releases were ever cut. The panel could not have told anyone, because EVERYTHING it
// showed — status.json's `last_line`, the ledger's test counts, "DEV-219 landed" — is the agents'
// own account of themselves, and by that account the week was excellent.
//
// So the rule this module is built to, and the one thing to preserve when editing it:
//   EVERY FIGURE HERE COMES FROM GIT OR FROM THE LEDGER FILE. Nothing may come from what an agent
//   wrote about itself. A number an agent can author is a number that says the week went well.
// The ledger is admissible because its lines are appended by the EXTENSION observing a role's
// transitions (models.ts), not typed by the role — with one honest exception noted at loopBackRate.
//
// NEVER THROWS. A tick calls this; a half-written, absent or not-a-git-repo path returns a
// well-formed empty result. A figure that cannot be computed is null and renders as "unknown",
// never as 0 — a measured zero and an unreadable value are opposites (the `numOrNull` lesson,
// CH-001).

import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { execFileSync } from "child_process";

const LOOM_ROOT = path.join(os.homedir(), ".claude", "loom");

export const DEFAULT_WINDOW_DAYS = 7;
export const DEFAULT_INTERVAL_MIN = 10;

/** What ships to a user, per repo, until someone configures otherwise (R4).
 *  These two are the audited projects; every other repo falls to the heuristic and SAYS SO. */
export const DEFAULT_PRODUCT_PATHS: Record<string, string[]> = {
  ReciEats: ["src/app/**", "src/lib/**"],
  pleodo: ["web/src/**", "engine/**", "blocks/**", "app/**"],
};

/** The colour bands (R2/R4). Green at or above `good`, red below `bad`, amber between — except the
 *  two where LOW is good, which invert. Kept here so the view and the settings agree by construction. */
export interface Thresholds {
  shipsGood: number; shipsBad: number;           // high is good  (≥40 green, <20 red)
  loopBackGood: number; loopBackBad: number;     // low  is good  (≤20 green, >50 red)
  narrationGood: number; narrationBad: number;   // low  is good  (≤10 green, >25 red)
  /** Dollars of list-price equivalent per NET product line above which the row goes red (R6). */
  costPerLine: number;
  /** WL-007: unshipped product as a PERCENTAGE of the window's own net product. A share, not an
   *  absolute count, because the first version of this band went red on 13 unshipped lines — any
   *  product landing on main before a version bump turned the project red, which reproduces the
   *  permanent-red defect this block removes. A share self-scales: a trickle is fine on any repo,
   *  and most of a week sitting unshipped is not fine on any repo. */
  unshippedShareGood: number; unshippedShareBad: number;
}
export const DEFAULT_THRESHOLDS: Thresholds = {
  shipsGood: 40, shipsBad: 20,
  loopBackGood: 20, loopBackBad: 50,
  narrationGood: 10, narrationBad: 25,
  unshippedShareGood: 10, unshippedShareBad: 50,
  costPerLine: 0.25,
};

/** `[input, output, cacheRead, cacheWrite1h]` in dollars per MTok — LIST PRICE, for the equivalent
 *  figure only. Verified 2026-09-15 against the current published model table: Fable 5.1 $10/$50,
 *  Opus 5 $5/$25, Sonnet 5 $2/$10, Haiku 4.5 $1/$5, with the standard cache multipliers (a read is
 *  0.1× input, a 1-hour write is 2× input).
 *
 *  THE ONE EXCEPTION, ratified 2026-09-15 (WL-001-R7): Claude Fable 5.1 prices cache READS at
 *  $0.25/MTok, not the $1.00 that 0.1× input would give. Cache reads are ~100× every other class and
 *  the ORCHESTRATOR is the session on Fable, so $1.00 overstates the single largest line in the whole
 *  figure fourfold. WL-001's handoff carried $1.00; it was checked against the published table and
 *  corrected, and the correction was ratified.
 *
 *  THESE ARE DATED CONSTANTS AND PRICES MOVE. A stale number here is the failure mode of a cost
 *  figure — it stays plausible while being wrong, which is the one thing this module must not do.
 *  The whole table is settings-overridable (`loomSessionTracker.modelPrices`); re-check it against
 *  the published pricing rather than trusting this comment's date. */
export type PriceRow = [number, number, number, number];
export const DEFAULT_MODEL_PRICES: Record<string, PriceRow> = {
  "claude-fable-5-1": [10, 50, 0.25, 20],
  "claude-fable-5": [10, 50, 1, 20],
  "claude-opus-5": [5, 25, 0.5, 10],
  "claude-opus-4-8": [5, 25, 0.5, 10],
  "claude-sonnet-5": [2, 10, 0.2, 4],
  "claude-haiku-4-5": [1, 5, 0.1, 2],
};

export interface ChurnEntry { file: string; touches: number; net: number; }

export interface WorkLedger {
  repo: string;
  /** Absolute path the figures were measured from, or null when there was nothing to measure. */
  repoPath: string | null;
  windowDays: number;
  computedAt: string;
  /** True when this result is empty because the path is not a git repo / has no commits in window.
   *  An empty result is still well-formed; the panel must be able to say WHY it is empty. */
  empty: boolean;
  emptyReason: string | null;
  /** Did `productPaths` name this repo, or did we guess? A guess presented as a measurement is the
   *  same lie in a new place, so this travels all the way to the tooltip. */
  heuristic: boolean;

  commits: number;
  /** Percent of changed lines (added+deleted) landing in product paths. null when nothing changed. */
  shipsToUser: number | null;
  productLines: number;
  totalLines: number;

  /** Percent of commits whose ENTIRE file set is documentation. null when there are no commits. */
  narrationShare: number | null;
  narrationCommits: number;

  /** test+script+tooling lines ÷ product lines. null when no product line moved (the ratio would
   *  be a division by zero, and "infinitely more rig than product" is not a number). */
  rigRatio: number | null;
  rigLines: number;

  /** Percent of ledger handoffs that needed at least one loop-back. null when the ledger is empty. */
  loopBackRate: number | null;
  handoffs: number;
  loopBackHandoffs: number;
  /** Median wall-clock minutes per handoff, over POSITIVE values only. null when none qualify. */
  medianWallMinutes: number | null;

  /** Commits since the newest tag, and days since it. `tag: null` = never released, which is the
   *  ReciEats case and must render as a WARNING, never as a blank. */
  tag: string | null;
  blocksSinceRelease: number | null;
  daysSinceRelease: number | null;

  topChurn: ChurnEntry[];

  // ── R6 · the cost side. The owner's question, verbatim: "for the amount of tokens consumed how
  // much output did I get in terms of the product". Everything above is a SHARE of lines and does
  // not answer it; these are the ratio.
  /** Every token billed in the window, from the transcripts' own `usage` — cache reads INCLUDED.
   *  Cache reads dominate by ~100×; a figure that omits them is wrong by two orders of magnitude.
   *
   *  NULL WHEN NO TRANSCRIPT DIRECTORY MATCHED THE REPO AT ALL — unmeasured, not zero. The two
   *  were one value until WL-002, and the panel therefore printed the CHEAPEST POSSIBLE WEEK
   *  ($0.00/line, green, under every alarm threshold) for a repo it could not see. `0` is reserved
   *  for the honest case: directories were found and nothing in them falls in the window. */
  tokensSpent: number | null;
  tokensByModel: Record<string, ModelTokens>;
  /** LIST-PRICE EQUIVALENT, not a bill. The owner is on a subscription and does not pay this
   *  invoice — it is the resource figure. Every label that shows it says so. */
  costEquivalent: number | null;
  /** Tokens belonging to model ids with no price row: counted as tokens, NOT as dollars. The row
   *  must say so rather than silently undercounting. */
  unpricedTokens: number;
  unpricedModels: string[];
  /** NET product lines (added − deleted) over the product paths. NOT churn: a file rewritten 118
   *  times has produced nothing if it is the same size. This is the denominator. */
  netProductLines: number | null;
  /** Files ADDED under the product paths in the window — what separates building from revising. */
  newUserFacingFiles: number | null;
  tokensPerProductLine: number | null;
  costPerProductLine: number | null;
  /** Transcript files read, and whether any were found at all. */
  transcriptFiles: number;
  /** Project directories that matched the repo. `0` is the unmeasured case and is the ONLY thing
   *  that distinguishes it from a genuinely quiet week. */
  transcriptDirs: number;
  /** Where we looked. Shown whenever `transcriptDirs` is 0, because "cannot see it" is only
   *  actionable if the row names the directory it searched. */
  transcriptsRoot: string;

  // ── WL-003 · the orchestrator's own blocks, not the project's score ──────────────────────────
  /** Commits (newest first) since one last touched a product path. `0` means the newest commit
   *  CHANGED PRODUCT CODE; `null` when there is no commit in the window to say. THE TRIGGER FIGURE:
   *  it names what to do next, where a percentage only invites being optimised.
   *
   *  WL-011 · IT COUNTS COMMITS THAT CHANGED PRODUCT, AND CHANGING PRODUCT IS NOT REACHING A USER.
   *  The field was right and its sentence was not: `:1657` rendered it as "N block(s) since anything
   *  reached a user", and this repo is its own counterexample — a briefing carried "2 block(s) since
   *  anything reached a user" beside "5 block(s) since loom-session-tracker 0.40.0 reached a user
   *  (deployed artifact)", two disagreeing claims about reaching a user in one message. Only the
   *  second measures a release. Reaching a user is `release`, and nothing here; this counts work.
   *  Same class as WL-010-R1: a value whose rendering claims more than the value ever measured. */
  blocksSinceProduct: number | null;
  /** How many of the newest commits, in an unbroken run, changed ONLY docs and handoffs. */
  narrationRun: number;
  /** Where this repo's sessions spent their tool calls in the window. */
  allocation: BlockAllocation;
  /** R5: what reached a user, and which of the three sources says so. `tag` stays as CORROBORATION
   *  only — it was the sole source, and it was wrong about this repo 42 deploys running. */
  release: ReleaseSignal;
}

/** One word, in the row AND in the nudge AND in the report. WL-002: the panel said `$?` in one
 *  place and `$0.00` in another for the same missing fact. */
export const UNMEASURED = "unmeasured";

/** True when nothing was looked at — not when nothing was found. */
export function tokensUnmeasured(w: WorkLedger): boolean {
  return w.tokensSpent === null;
}

/** One model's four billed token classes, exactly as the transcripts name them. */
export interface ModelTokens {
  input: number; output: number; cacheRead: number; cacheCreate: number;
}

// ── path classification ───────────────────────────────────────────────────────────────────────

/** Minimal glob matcher: `**` crosses separators, `*` does not, `?` is one non-separator char.
 *  Deliberately small — the alternative is a dependency, and this extension has one (`ws`). */
export function globToRe(glob: string): RegExp {
  let re = "";
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === "*") {
      if (glob[i + 1] === "*") {
        // `**/` may match nothing at all, so `src/**/x` matches `src/x` as well as `src/a/b/x`.
        if (glob[i + 2] === "/") { re += "(?:.*/)?"; i += 2; } else { re += ".*"; i += 1; }
      } else re += "[^/]*";
    } else if (c === "?") re += "[^/]";
    else re += c.replace(/[.+^${}()|[\]\\]/g, "\\$&");
  }
  return new RegExp("^" + re + "$");
}

export function matchesAny(file: string, globs: string[]): boolean {
  const f = file.replace(/^\.?\//, "");
  return globs.some((g) => { try { return globToRe(g).test(f); } catch { return false; } });
}

const DOC_RE = /(^|\/)(docs?|guide|handoffs?)\//i;
const MD_RE = /\.(md|markdown|txt|rst|adoc)$/i;
const RIG_RE = /(^|\/)(tests?|spec|specs|__tests__|__mocks__|e2e|scripts?|tools?|fixtures?)\//i;
const RIG_FILE_RE = /\.(test|spec)\.[a-z]+$/i;
const LOCK_RE = /(^|\/)(package-lock\.json|yarn\.lock|pnpm-lock\.yaml|poetry\.lock|Cargo\.lock|go\.sum)$/i;
const CONFIG_RE = /(^|\/)(\.[^/]+|[^/]*\.(json|ya?ml|toml|ini|cfg|lock))$/i;

/** Documentation, for narrationShare: the "guide + handoff" commits. */
export function isDoc(file: string): boolean { return MD_RE.test(file) || DOC_RE.test(file); }

/** Verification rig + tooling, for rigRatio. */
export function isRig(file: string): boolean {
  return RIG_FILE_RE.test(file) || RIG_RE.test(file);
}

/** The fallback when `productPaths` does not name this repo: everything EXCEPT rig, docs, lockfiles
 *  and config. Its answers are honest but coarse, so every caller that uses it flags `heuristic`. */
export function heuristicIsProduct(file: string): boolean {
  if (isDoc(file) || isRig(file) || LOCK_RE.test(file)) return false;
  if (CONFIG_RE.test(file)) return false;
  return true;
}

export interface Classifier {
  isProduct(file: string): boolean;
  /** Matched an exclusion — subtracted from product, and counted as rig instead. */
  isExcluded(file: string): boolean;
  heuristic: boolean;
}

/**
 * R7a — SUBTRACTED FROM PRODUCT, WHATEVER `productPaths` SAYS, and kept as its own visible list
 * rather than buried inside the product globs, so the next person can see what was taken out.
 *
 * This exists because it was measured wrong. `productPaths` for ReciEats is `src/app/**` +
 * `src/lib/**`, and 39,150 of the 63,225 "product" lines those globs matched over the audited week
 * were TEST files living under `src/` — `src/app/page.test.tsx` alone was +10,782, the single
 * largest file in the product figure. A ledger whose entire purpose is to separate what reached a
 * user from the rig around it, and which counts `page.test.tsx` as product, reports exactly the
 * number it exists to refute. With this applied ReciEats reports +24,075 net, and its headline
 * shipping share falls from 56.8 % to 25.1 %.
 *
 * The leading globstar on each pattern is deliberate: a root-anchored `__tests__` pattern would miss
 * `src/__tests__/`, which is where they actually live.
 */
export const DEFAULT_EXCLUDE_PATHS = [
  "**/*.test.*", "**/*.spec.*", "**/__tests__/**", "**/__mocks__/**",
];

export function classifierFor(repo: string, productPaths: Record<string, string[]>,
                              excludePaths: string[] = DEFAULT_EXCLUDE_PATHS): Classifier {
  const excl = Array.isArray(excludePaths) ? excludePaths : DEFAULT_EXCLUDE_PATHS;
  const isExcluded = (f: string) => matchesAny(f, excl);
  const globs = productPaths && productPaths[repo];
  // An EMPTY list is a configuration that says "nothing here ships", not an absent one. Falling
  // through to the heuristic on `[]` would silently overrule what a person wrote.
  if (Array.isArray(globs)) {
    return { isProduct: (f) => !isExcluded(f) && matchesAny(f, globs), isExcluded, heuristic: false };
  }
  return { isProduct: (f) => !isExcluded(f) && heuristicIsProduct(f), isExcluded, heuristic: true };
}

// ── git ───────────────────────────────────────────────────────────────────────────────────────

/** Every git call in this file goes through here. `stderr: "ignore"` is deliberate: the ordinary
 *  answers are on stderr — `describe --tags` on an untagged repo says "fatal: No names found", which
 *  is not an error but ReciEats' actual state — and this runs on a 15-second tick inside an editor.
 *  A failure is reported by returning null, which every caller already turns into a null figure. */
function git(repoPath: string, args: string[]): string | null {
  try {
    return execFileSync("git", ["-C", repoPath, ...args],
      { encoding: "utf8", timeout: 20_000, maxBuffer: 64 * 1024 * 1024,
        stdio: ["ignore", "pipe", "ignore"] });
  } catch { return null; }
}

/** Commit delimiter: printed by --format=%x01, and no file path can contain it. */
const SOH = "\u0001";

interface Commit { files: string[]; lines: Array<{ file: string; added: number; deleted: number }>; }

/** Parse ONE `git log --numstat` stream into commits. The single pass is the performance
 *  requirement: a repo with 600 commits in the window costs one process, not 600. */
export function parseNumstat(out: string): Commit[] {
  const commits: Commit[] = [];
  let cur: Commit | null = null;
  for (const raw of out.split("\n")) {
    const line = raw.replace(/\r$/, "");
    if (line.startsWith(SOH)) {                     // our commit delimiter
      cur = { files: [], lines: [] };
      commits.push(cur);
      continue;
    }
    if (!line.trim() || !cur) continue;
    const m = /^(\d+|-)\t(\d+|-)\t(.*)$/.exec(line);
    if (!m) continue;
    // A rename prints `old => new` (or `dir/{a => b}/f`); attribute it to the NEW path, which is
    // where the code lives now. `-` is a binary file: it counts as a touch, never as lines.
    const file = renamedTo(m[3]);
    const added = m[1] === "-" ? 0 : Number(m[1]);
    const deleted = m[2] === "-" ? 0 : Number(m[2]);
    cur.files.push(file);
    cur.lines.push({ file, added, deleted });
  }
  return commits;
}

export function renamedTo(spec: string): string {
  const brace = /^(.*)\{(.*) => (.*)\}(.*)$/.exec(spec);
  if (brace) return (brace[1] + brace[3] + brace[4]).replace(/\/\//g, "/");
  const plain = /^(.*) => (.*)$/.exec(spec);
  if (plain) return plain[2];
  return spec;
}

// ── the ledger (loop-backs, wall time) ────────────────────────────────────────────────────────

export interface LedgerLine {
  id: string; role: string; model: string; loopBacks: number;
  wallMinutes: number | null; finished: string | null; self?: boolean;
}

/** Read `model-ledger.jsonl`, keeping only real handoffs inside the window.
 *  Skipped deliberately: `{self:true}` lines (an orchestrator's own tier shift is not a handoff)
 *  and `*-ack` ids (models.ts writes one when a handoff is acknowledged; counting it would double
 *  every block and score it 0 loop-backs). A malformed line is skipped, never fatal. */
export function readLedger(repo: string, sinceMs: number, root = LOOM_ROOT): LedgerLine[] {
  let raw: string;
  try { raw = fs.readFileSync(path.join(root, repo, "model-ledger.jsonl"), "utf8"); }
  catch { return []; }
  const out: LedgerLine[] = [];
  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    let o: any;
    try { o = JSON.parse(line); } catch { continue; }
    if (!o || typeof o !== "object" || o.self === true) continue;
    const id = String(o.id || "");
    if (!id || /-ack$/.test(id)) continue;
    const finished = typeof o.finished === "string" ? o.finished : null;
    const at = finished ? Date.parse(finished) : NaN;
    // A line with no readable `finished` is kept — dropping it would quietly shrink the
    // denominator, and a handoff that never recorded its end is still a handoff that happened.
    if (Number.isFinite(at) && at < sinceMs) continue;
    out.push({
      id, role: String(o.role || ""), model: String(o.model || ""),
      loopBacks: Number.isFinite(Number(o.loopBacks)) ? Number(o.loopBacks) : 0,
      wallMinutes: Number.isFinite(Number(o.wallMinutes)) ? Number(o.wallMinutes) : null,
      finished,
    });
  }
  return out;
}

/** Median of positive wall times. NON-POSITIVE VALUES ARE DROPPED, NOT SHOWN AS 0: the `started`
 *  bug is real and known (an ack line stamps started === finished, and a restart can stamp a
 *  negative), and a 0 in this column would read as "that handoff took no time", which is the exact
 *  shape of self-flattering number this module exists to refuse. */
export function medianPositive(values: Array<number | null>): number | null {
  const v = values.filter((x): x is number => typeof x === "number" && Number.isFinite(x) && x > 0)
    .sort((a, b) => a - b);
  if (!v.length) return null;
  const mid = Math.floor(v.length / 2);
  return v.length % 2 ? v[mid] : Math.round(((v[mid - 1] + v[mid]) / 2) * 10) / 10;
}

// ── R6 · tokens, from the transcripts' own usage fields ───────────────────────────────────────

const PROJECTS_ROOT = path.join(os.homedir(), ".claude", "projects");

/** `claude-opus-5[1m]` and `claude-opus-5` are one model at one price; the context-window suffix is
 *  a harness annotation, not a SKU. A dated snapshot (`claude-haiku-4-5-20251001`) is the same
 *  model too, so it is matched by longest-prefix below rather than being left unpriced. */
export function normalizeModelId(id: string | null | undefined): string {
  return String(id || "").trim().replace(/\[[^\]]*\]$/, "").toLowerCase();
}

/** The price row for a model id, or null when nothing prices it. Longest matching prefix wins, so a
 *  dated snapshot inherits its family's row and a genuinely unknown id stays unpriced (and visible)
 *  rather than being quietly folded into whatever row sorts first. */
export function priceFor(id: string, prices: Record<string, PriceRow>): PriceRow | null {
  const norm = normalizeModelId(id);
  if (prices[norm]) return prices[norm];
  let best: string | null = null;
  for (const k of Object.keys(prices)) {
    if (norm.startsWith(k) && (!best || k.length > best.length)) best = k;
  }
  return best ? prices[best] : null;
}

const EMPTY_TOKENS = (): ModelTokens => ({ input: 0, output: 0, cacheRead: 0, cacheCreate: 0 });

export interface TokenScan {
  byModel: Record<string, ModelTokens>;
  total: number;
  files: number;
  /** How many `~/.claude/projects/*` directories matched the repo at all. ZERO IS NOT A TOKEN
   *  COUNT — it means nothing was looked at, and `total: 0` beside it is unmeasured, not quiet. */
  dirs: number;
}

/** Which `~/.claude/projects/*` directories belong to a repo. The directory name is the project
 *  path with separators flattened, so `-home-aneesh-Containers-ReciEats` and every
 *  `…-ReciEats--claude-worktrees-developer1` belong to ReciEats — the worktree sessions are the bulk
 *  of the spend and dropping them would undercount the answer by most of itself. */
export function canonProject(s: string): string {
  return String(s || "").toLowerCase().replace(/[_.]/g, "-");
}

export function transcriptDirsFor(repo: string, root = PROJECTS_ROOT): string[] {
  if (!repo) return [];
  let names: string[];
  try { names = fs.readdirSync(root); } catch { return []; }
  const needle = canonProject(repo);
  if (!needle) return [];
  return names
    // CANONICALIZE, THEN ANCHOR. Both sides go through the same encoding, then the separator guard
    // applies to the canonical forms — the guard is not relaxed to buy the match.
    .filter((n) => { const l = canonProject(n);
                     // The repo IS the last segment, or a dot-directory of the repo follows it.
                     // `--` is an encoded `/.`, which is what every worktree path
                     // (`…/<repo>/.claude/worktrees/<role>`) becomes, and is the ONLY thing allowed
                     // after the repo name. A bare `-` here would match a SIBLING repo:
                     // `-…-pleodo-archive` contains `-pleodo-`, so the guard this replaces let
                     // `pleodo` swallow `pleodo-archive` after all, which its comment denied.
                     return l.endsWith("-" + needle) || l.includes("-" + needle + "--"); })
    .map((n) => path.join(root, n));
}

/**
 * Sum every billed token class in the window, BY MODEL, from the transcripts' `usage` objects.
 *
 * CACHE READS ARE INCLUDED AND THAT IS THE POINT. They run ~100× the other classes — one measured
 * day was 2.93 billion cache-read tokens — so a total that omits them turns a 15-billion-token week
 * into a 100-million-token one, which is the exact self-flattering error this module exists to
 * refuse. `mutation.py` carries a mutant that drops them.
 *
 * Usage is read ONLY off assistant messages: a user or summary line carries no usage of its own,
 * and counting the assistant usage a second time from a replayed line would double every figure.
 * Window is by file mtime, as the handoff specifies — coarse, and stated wherever it is shown.
 */
export function scanTranscripts(repo: string, sinceMs: number, root = PROJECTS_ROOT): TokenScan {
  const byModel: Record<string, ModelTokens> = {};
  let total = 0, files = 0;
  const matched = transcriptDirsFor(repo, root);
  for (const dir of matched) {
    let entries: string[];
    try { entries = fs.readdirSync(dir); } catch { continue; }
    for (const name of entries) {
      if (!name.endsWith(".jsonl")) continue;
      const file = path.join(dir, name);
      try { if (fs.statSync(file).mtimeMs < sinceMs) continue; } catch { continue; }
      let raw: string;
      try { raw = fs.readFileSync(file, "utf8"); } catch { continue; }
      files++;
      for (const line of raw.split("\n")) {
        if (!line.trim()) continue;
        let o: any;
        try { o = JSON.parse(line); } catch { continue; }       // a torn last line is normal
        const m = o && o.message;
        if (!m || o.type !== "assistant") continue;
        const u = m.usage;
        if (!u || typeof u !== "object") continue;
        const key = normalizeModelId(m.model) || "unknown";
        const t = (byModel[key] = byModel[key] || EMPTY_TOKENS());
        const n = (v: any) => (Number.isFinite(Number(v)) ? Number(v) : 0);
        t.input += n(u.input_tokens);
        t.output += n(u.output_tokens);
        t.cacheRead += n(u.cache_read_input_tokens);
        t.cacheCreate += n(u.cache_creation_input_tokens);
      }
    }
  }
  for (const t of Object.values(byModel)) total += t.input + t.output + t.cacheRead + t.cacheCreate;
  return { byModel, total, files, dirs: matched.length };
}

export interface CostResult { dollars: number; unpricedTokens: number; unpricedModels: string[]; }

/** List-price equivalent. An UNPRICED model contributes its tokens to `tokensSpent` but no dollars,
 *  and is named — a silent undercount presented as a cost is the same failure as a silent guess
 *  presented as a measurement. */
export function costEquivalent(byModel: Record<string, ModelTokens>,
                               prices: Record<string, PriceRow> = DEFAULT_MODEL_PRICES): CostResult {
  let dollars = 0, unpricedTokens = 0;
  const unpricedModels: string[] = [];
  for (const [id, t] of Object.entries(byModel)) {
    const n = t.input + t.output + t.cacheRead + t.cacheCreate;
    // A model that spent NOTHING is not an undercount. `<synthetic>` appears on every bus with an
    // all-zero usage object (measured: 18 lines in ReciEats), and listing it as "unpriced" would
    // put a permanent warning on a figure that is exactly right.
    if (!n) continue;
    const p = priceFor(id, prices);
    if (!p) {
      unpricedTokens += n;
      unpricedModels.push(id);
      continue;
    }
    dollars += (t.input * p[0] + t.output * p[1] + t.cacheRead * p[2] + t.cacheCreate * p[3]) / 1e6;
  }
  return { dollars: Math.round(dollars * 100) / 100, unpricedTokens, unpricedModels: unpricedModels.sort() };
}

/** git's empty tree. A repo whose entire history is inside the window has no commit BEFORE it, and
 *  diffing from this is what makes "everything here is new" come out right instead of empty.
 *  Measured 2026-09-15: pleodo is exactly this case — no commit older than 7 days. */
const EMPTY_TREE = "4b825dc642cb6eb9a060e54bf8d69288fbee4904";

/**
 * NET product lines in a `git diff --numstat` body: added minus deleted, over the files the
 * classifier calls product, binary files skipped because no line count exists for them.
 *
 * WL-007 extracted this from `productDelta` when `netProductSince` was written as a verbatim copy
 * of the same eight lines. Two copies of a measurement are two things to keep in agreement, and the
 * defect this very block fixes was one reader drifting from another — so a second copy of the
 * arithmetic was exactly the wrong thing to add. It also gives the mutation gate ONE line to aim at
 * rather than an ambiguous match, which is how the duplication was noticed.
 */
function netProductLinesIn(out: string, cls: Classifier): number {
  let net = 0;
  for (const raw of out.split("\n")) {
    const m = /^(\d+|-)\t(\d+|-)\t(.*)$/.exec(raw);
    if (!m) continue;
    const file = renamedTo(m[3]);
    if (!cls.isProduct(file)) continue;
    if (m[1] === "-" || m[2] === "-") continue;                 // binary: no line count exists
    net += Number(m[1]) - Number(m[2]);
  }
  return net;
}

/**
 * NET product lines and newly ADDED product files in the window, as a TWO-POINT DIFF
 * (`<base>..HEAD`), where base is the last commit before the window opened.
 *
 * NOT a sum of per-commit numstat, and the difference is the entire point of the figure. Summing
 * commits counts a line once per commit that touched it, so a file rewritten 118 times reports
 * thousands of lines of "production" while the file ends the same size. The two-point diff reports
 * what actually exists now that did not exist then — the only denominator for which "cost per
 * product line" means anything. Returns nulls (not zeros) when git cannot answer.
 */
export function productDelta(repoPath: string | null, since: string,
                             cls: Classifier): { net: number | null; added: number | null;
                                                 base: string | null } {
  if (!repoPath) return { net: null, added: null, base: null };
  const before = (git(repoPath, ["rev-list", "-1", `--before=${since}`, "HEAD"]) || "").trim();
  const base = before || EMPTY_TREE;
  const range = `${base}..HEAD`;
  const out = git(repoPath, ["diff", "--numstat", range]);
  if (out === null) return { net: null, added: null, base };
  const net = netProductLinesIn(out, cls);
  const addOut = git(repoPath, ["diff", "--diff-filter=A", "--name-only", range]);
  let added: number | null = null;
  if (addOut !== null) {
    const seen = new Set<string>();
    for (const raw of addOut.split("\n")) {
      const f = raw.trim();
      if (f && cls.isProduct(f)) seen.add(f);
    }
    added = seen.size;
  }
  return { net, added, base };
}

// ── WL-003-R5 · what "released" means when a project has never cut a tag ──────────────────────
//
// A RELEASE IS THE ACT THAT PUTS THE CODE IN FRONT OF ITS USER, AND TAGS ARE NOT IT. This extension
// has no marketplace: `./deploy.sh` writing `~/.vscode-oss/extensions/<publisher>.<name>-<version>`
// is the release. Measured 2026-09-15: 42 deployed versions, 56 manifest bumps in history, 0 tags —
// and the panel reported "never released", which is the proxy-for-the-thing error this module
// exists to refuse, made about the repo the module lives in.
//
// THE CREDIBILITY OF THE ONE LINE THAT MATTERS IS SET BY THE LEAST CREDIBLE LINE IN THE BLOCK. The
// bus-mechanics count is the point of WL-003, and it sat next to a line that told its reader the
// briefing was broken.

/** WL-010 added `tag`. Where a repo's tags name a release NEWER than anything its manifest records,
 *  that is a MEASUREMENT and must be rendered as one — answering "I cannot tell" everywhere replaces
 *  a false verdict with a useless one. `unmeasured` is reserved for what nothing can account for. */
export type ReleaseSource = "deployed" | "manifest" | "tag" | "unmeasured";

export interface ReleaseSignal {
  /** WHICH OF THE THREE ANSWERED. Shown wherever the line is, so the claim carries its own basis. */
  source: ReleaseSource;
  manifestPath: string | null;
  /** Which product the answer is about — set when the repo holds more than one manifest, so the
   *  line cannot silently be about a different product than the reader assumes. */
  product: string | null;
  /** The manifest's current version. */
  version: string | null;
  /** The version actually in front of a user, when that can be seen. */
  releasedVersion: string | null;
  /** Commits since the release commit. `0` means the released version is what HEAD holds.
   *
   *  WL-007: KEPT, BUT NO LONGER THE HEADLINE. It counts commits, and a commit is not work — on
   *  2026-09-15 this repo read `blocksSince: 3` where all three were HANDOVER and version commits
   *  the orchestrator made after deploying. "3 blocks since release" overstated the drift by three.
   *  A commit count is a proxy for "how far ahead of the user is main"; `unshippedProduct` is the
   *  thing itself, measured the way WL-001 measures everything else. */
  blocksSince: number | null;
  /** The release commit, so the caller can measure forward from it. */
  commit: string | null;
  /** NET product lines that exist on HEAD and are NOT in front of a user: the two-point diff over
   *  the product paths from the release commit to HEAD. `0` means everything that reached product has
   *  shipped, whatever the commit count says. Null when there is no release commit to measure from. */
  unshippedProduct: number | null;
  /** The manifest is tracked but its version has never changed — the ONLY case in which "no release
   *  in N blocks" is a true statement, AND ONLY when that manifest can answer for the repo. */
  neverMoved?: boolean;
  /** WL-010 · why a manifest was refused authority over the whole repo, when it was. Carried so the
   *  reader can say WHAT it could not measure instead of only that it could not. */
  unmeasuredReason?: string;
  /** The newest tag, when one contradicted the manifest — named so a reader can go and look. */
  newestTag?: string | null;
  /** Where a deployed artifact was looked for — named when the answer is `unmeasured`. */
  lookedIn: string[];
  /** WL-011 · HOW `commit` WAS IDENTIFIED, carried for the same reason `source` is: a claim travels
   *  with its basis. `content` means the artifact's own bytes matched that commit and the answer is
   *  evidence; `manifest-bump` means it is the commit where the version CHANGED, which is right
   *  about the version and can be several blocks early about the code; `tag` is the tagged commit;
   *  `none` means no anchor could be placed, so every distance is unmeasured. */
  anchor?: "content" | "manifest-bump" | "tag" | "none";
  /** How many shipped files the content anchor matched — the weight behind an `content` answer. */
  anchorFiles?: number;
  /** WL-011 · the anchor names a real release that is NOT on the history being measured — a release
   *  train cut on a side branch, which is what Lumen's 40 iOS/Android tags are. Both distances are
   *  refused in that case, and this is why, so a reader can say so instead of only going quiet. */
  anchorOffHistory?: boolean;
}

/** Standard per-user extension directories. The ROOTS are conventional; the artifact NAME is derived
 *  from the manifest's own publisher/name, never hardcoded. */
export const DEFAULT_DEPLOY_ROOTS = [
  path.join(os.homedir(), ".vscode-oss", "extensions"),
  path.join(os.homedir(), ".vscode", "extensions"),
];

interface Manifest { rel: string; name: string; publisher: string; version: string;
                     /** How many manifests this repo holds. >1 means the line must name which. */
                     siblings: number; }

/** WL-012 · how deep the TRACKED sweep below will look. Gaming's manifest is at depth 2
 *  (`cairn/shell/package.json`) and that is the deepest real product manifest in the corpus; three
 *  is one level of headroom. Deeper than that is fixture and vendor territory, and a manifest found
 *  there would answer for a product nobody ships. */
export const MANIFEST_MAX_DEPTH = 3;

/**
 * The project's manifest: the root `package.json`, else a single-level subdirectory one, else the
 * most recently touched TRACKED one anywhere within `MANIFEST_MAX_DEPTH`.
 *
 * A REPO CAN HOLD SEVERAL PRODUCTS AND THIS ONE DOES — `claude-auto-accept`, `claude-chat-reader`
 * and `loom-session-tracker`. Taking the first by name picked `claude-auto-accept` and reported
 * "111 blocks since 1.0.0 reached a user" for a repo whose active product had shipped that morning:
 * the same confidently-wrong line R5 exists to remove, one layer down. The ACTIVE one is chosen
 * instead — most recently touched by a commit — and the line says which product it is about.
 *
 * WL-012 · THE THIRD STEP EXISTS BECAUSE THIS IS A GATE, NOT A STEP. `manifestAuthority` and the
 * deployed-artifact anchor both run only after this function answers, so a repo it cannot see is
 * not measured and rejected — it is never asked, and a repo that renders `unmeasured` generates no
 * complaint. Measured across the bus 2026-09-16: of the four repos this returned `null` for, three
 * (funisland, tfg_ua, hackomics) have no release signal of any kind and `unmeasured` is their
 * correct answer — but GAMING has 648 commits, 40 tags whose newest is ON this history, and two
 * tracked manifests at DEPTH 2, one level below where the scan stopped. It was never Python that
 * hid it. It was a Node repo the Node finder could not reach, and its 40 tags were never read.
 *
 * The sweep asks GIT rather than the filesystem, which is the whole reason it is safe to widen:
 * `ls-files` enumerates only TRACKED paths, so `node_modules`, build output and anything ignored
 * are excluded by the mechanism instead of by a blocklist that has to be kept correct. Across all
 * eleven bus repos it returns zero junk. It runs ONLY where the answer is currently `null`, so no
 * repo that resolves today can change its reading because of it.
 */
export function findManifest(repoPath: string, explicit?: string | null): Manifest | null {
  const tryOne = (rel: string): Manifest | null => {
    try {
      const o = JSON.parse(fs.readFileSync(path.join(repoPath, rel), "utf8"));
      if (o && typeof o.version === "string" && o.version && typeof o.name === "string" && o.name) {
        return { rel, name: o.name, publisher: String(o.publisher || ""), version: o.version,
                 siblings: 1 };
      }
    } catch { /* not one */ }
    return null;
  };
  // MOST RECENTLY TOUCHED WINS — the product actually being worked on, not the first alphabetically.
  // One place, so the deep sweep cannot pick a different product than the shallow scan would.
  const active = (found: Manifest[]): Manifest | null => {
    if (!found.length) return null;
    let best = found[0], bestAt = -1;
    for (const m of found) {
      const t = Number(((git(repoPath, ["log", "-1", "--format=%ct", "--", m.rel]) || "").trim()));
      if (Number.isFinite(t) && t > bestAt) { bestAt = t; best = m; }
    }
    return { ...best, siblings: found.length };
  };
  if (explicit) return tryOne(explicit);
  const root = tryOne("package.json");
  if (root) return root;
  let entries: string[] = [];
  try { entries = fs.readdirSync(repoPath); } catch { /* fall through to the tracked sweep */ }
  const found: Manifest[] = [];
  for (const d of entries.sort()) {
    if (d.startsWith(".") || d === "node_modules") continue;
    const m = tryOne(path.join(d, "package.json"));
    if (m) found.push(m);
  }
  if (found.length) return active(found);
  // WL-012 · THE POPULATION THAT WAS NEVER ASKED. Nothing shallow answered; ask git.
  const tracked = (git(repoPath, ["ls-files", "*package.json"]) || "")
    .split("\n").map((x) => x.trim()).filter(Boolean)
    .filter((rel) => !rel.split("/").includes("node_modules"))
    .filter((rel) => rel.split("/").length - 1 <= MANIFEST_MAX_DEPTH);
  const deep: Manifest[] = [];
  for (const rel of tracked.sort()) {
    const m = tryOne(rel);
    if (m) deep.push(m);
  }
  return active(deep);
}

/** Versions of this extension currently deployed, newest-looking last. Matched on the manifest's own
 *  `<publisher>.<name>-<version>` shape, with a bare `<name>-<version>` accepted too. */
export function deployedVersions(m: Manifest, roots = DEFAULT_DEPLOY_ROOTS): string[] {
  return deployedArtifacts(m, roots).map((a) => a.version);
}

/** WL-011 · the same artifacts, WITH THE DIRECTORY THEY LIVE IN. `deployedVersions` is derived from
 *  this so the two can never disagree about what is deployed. The directory is the point: the
 *  artifact is a COPY OF THE SOURCE ON DISK, which is how `deployedCommit` can identify what was
 *  shipped instead of inferring it from a version number. Insertion order is preserved — a caller
 *  falls back to `[0]` when nothing else can answer. */
export function deployedArtifacts(m: Manifest, roots = DEFAULT_DEPLOY_ROOTS):
    Array<{ version: string; dir: string }> {
  const out: Array<{ version: string; dir: string }> = [];
  const seen = new Set<string>();
  const pats = [m.publisher ? `${m.publisher}.${m.name}-` : null, `${m.name}-`]
    .filter((x): x is string => !!x);
  for (const root of roots) {
    let names: string[];
    try { names = fs.readdirSync(root); } catch { continue; }
    for (const n of names) {
      for (const p of pats) {
        if (n.startsWith(p)) {
          const v = n.slice(p.length);
          if (/^\d/.test(v) && !seen.has(v)) { seen.add(v); out.push({ version: v, dir: path.join(root, n) }); }
          break;
        }
      }
    }
  }
  return out;
}

// ── WL-011 · THE RELEASE ANCHOR IS THE DEPLOY, NOT THE VERSION BUMP ───────────────────────────
//
// MEASURED 2026-09-16 against this repo's own 49 deployed artifacts. `releaseCommit(rel, want)` is
// PATHSPEC-LIMITED TO THE MANIFEST, so it answers "the newest commit that TOUCHED package.json and
// held this version" — the version BUMP. When two blocks ship under one version number, which is
// this bus's normal practice (0.38.5, 0.39.0 and 0.40.0 were each two blocks), the second block's
// commits land after that bump and are measured as unshipped while sitting INSIDE the shipped build.
//
// The numbers, so the size of the claim is on the record:
//   · the anchor lands on the WRONG COMMIT in 22 of 48 measurable artifacts (46%);
//   · the RENDERED NUMBER is wrong in 4 of 48 (8.3%) — the other 18 had only docs in the gap;
//   · those four: +216, +152, +13 and −412 net product lines.
//   · 0.40.0 is the +152: anchored at 4ed59da (MP-002's bump), it rendered "152 product line(s) not
//     in front of a user" MINUTES AFTER those lines were deployed. The true figure is 0.
//   · 0.33.0 is the −412, AND IT RUNS THE OTHER WAY: that artifact's source PREDATES its own
//     version-bump commit, so the tile UNDER-reported unshipped work by 412 lines. A false green,
//     which is the direction that never provokes a complaint — WL-010's finding again.
//
// THE FIX IS TO STOP INFERRING. A deployed artifact is a copy of the source on disk, so the commit
// that was deployed is EVIDENCE: hash the artifact's files and find the newest commit whose blobs
// are byte-identical. On the 49-artifact corpus this resolved 49 times; the manifest anchor resolved
// 48. So the content anchor is better on availability AND on correctness, which is why it is
// preferred rather than merely added.
//
// WHEN IT CANNOT BE READ, IT IS `unmeasured` — NEVER A NUMBER (WL-007's rule, and WL-010's). An
// artifact whose content matches no commit means the deploy came from a tree git cannot see; the
// release is still real and still named, and it is the DISTANCE that is unknown. That is the branch
// this module already had for "deployed, but no commit holds that version", and it is reused.

/**
 * The commit whose tracked content IS what the artifact ships, or null when nothing matches.
 *
 * Only paths that are tracked at HEAD *and* present in the artifact are compared — a built `out/`
 * and a vendored `node_modules/` are in the shipped directory but in no commit, and a file the
 * artifact does not carry is evidence about neither side. Bounded like `releaseCommit`: the log is
 * limited to the compared paths, so it walks the commits that could possibly change the answer
 * rather than one per commit in the repo.
 */
export function deployedCommit(repoPath: string, manifestRel: string, artifactDir: string,
                               cap = 80): { sha: string; matched: number } | null {
  const dir = path.dirname(manifestRel);
  const scope = dir === "." || dir === "" ? "." : dir;
  const prefix = scope === "." ? "" : scope + "/";
  const tracked = git(repoPath, ["ls-tree", "-r", "--name-only", "HEAD", "--", scope]);
  if (tracked === null) return null;
  const want = new Map<string, string>();
  for (const rel of tracked.split("\n").map((x) => x.trim()).filter(Boolean)) {
    const shipped = path.join(artifactDir, rel.startsWith(prefix) ? rel.slice(prefix.length) : rel);
    try { if (!fs.statSync(shipped).isFile()) continue; } catch { continue; }
    const h = (git(repoPath, ["hash-object", shipped]) || "").trim();
    if (/^[0-9a-f]{40}$/.test(h)) want.set(rel, h);
  }
  if (!want.size) return null;
  const paths = Array.from(want.keys());
  const log = git(repoPath, ["log", "--format=%H", "-n", String(cap), "--"].concat(paths));
  if (log === null) return null;
  for (const sha of log.split("\n").map((x) => x.trim()).filter(Boolean)) {
    const tree = git(repoPath, ["ls-tree", "-r", sha, "--", scope]);
    if (tree === null) continue;
    const at = new Map<string, string>();
    for (const line of tree.split("\n")) {
      // `<mode> SP blob SP <sha> TAB <path>`. A path git had to quote will not match and the answer
      // becomes `unmeasured` — the safe direction, and never a number.
      const mm = /^\d+ blob ([0-9a-f]{40})\t(.*)$/.exec(line);
      if (mm) at.set(mm[2], mm[1]);
    }
    let all = true;
    for (const [p, h] of want) if (at.get(p) !== h) { all = false; break; }
    if (all) return { sha, matched: want.size };
  }
  return null;
}

// ── WL-011 · A DISTANCE IS ONLY MEASURABLE FROM AN ANCHOR THAT LIES ON THIS HISTORY ───────────
//
// FOUND BY MEASURING THE CORPUS FOR THIS BLOCK, AND IT IS BIGGER THAN THE DEFECT THE BLOCK WAS
// SCOPED TO. Lumen, verified 2026-09-16: 40 release tags, newest `cairn-ios-v0.1.0` (94198a4), an
// iOS train that is NOT AN ANCESTOR OF HEAD. `rev-list --count 94198a4..HEAD` counts what HEAD can
// reach and the tag cannot, which here is 189 — THE REPO'S ENTIRE HISTORY, 189 of 189 commits — and
// `git diff <tag>..HEAD` is a two-point diff between two branches, so `unshippedProduct` is a large,
// specific, false number. The panel reports that a repo which cuts release trains has shipped
// nothing. WL-002's lie-with-a-number-on-it, produced by an anchor rather than by arithmetic.
//
// IT IS UNDETECTABLE BY INSPECTION, which is why it lasted: both git commands SUCCEED and return a
// plausible figure. Nothing is thrown, no branch is skipped, no band goes red for the right reason.
//
// THE REFUSAL SITS AT THE CHOKEPOINT, NOT AT THE CALLER — MP-002's lesson. Both measurements from an
// anchor go through `onThisHistory` first, so a future reader that measures from a new anchor
// inherits the guard instead of having to remember it. The release is still REAL and still NAMED;
// it is the DISTANCE that is unmeasured, which is the same treatment `unmeasured` already gets.

/**
 * Is `sha` an ancestor of HEAD — i.e. does the history being measured actually run through it?
 *
 * `merge-base --is-ancestor` exits 1 for "no", which `git()` reports as null, and 0 with EMPTY
 * output for "yes" — so this tests `!== null` and NOT truthiness. An unknown sha also exits
 * non-zero and is correctly refused.
 */
export function onThisHistory(repoPath: string | null, sha: string | null): boolean {
  if (!repoPath || !sha) return false;
  return git(repoPath, ["merge-base", "--is-ancestor", sha, "HEAD"]) !== null;
}

/**
 * WL-011 · THE DISTANCES A READER IS ENTITLED TO RENDER — the READER's chokepoint.
 *
 * `releaseSignal` already nulls both when the anchor is off this history, so in production these
 * fields cannot disagree with `anchorOffHistory`. This exists because a reader that TRUSTS an
 * upstream invariant is not holding the claim, it is inheriting it — and that is precisely what
 * WL-010-R1 was: the enum was guarded and the sentence was not, so the sentence drifted. Found here
 * by the test rather than by review: set `unshippedProduct` on an off-history reading and the tile
 * rendered "3468.8% of this window's net product" off an anchor that cannot measure anything.
 */
/**
 * WL-012 · AND THE SECOND THING A NET DIFF CANNOT SAY.
 *
 * `unshippedProduct` is a TWO-POINT NET diff from the release commit to HEAD, so a release followed
 * by a large deletion comes out NEGATIVE. Every reader then took `un <= 0` to mean "nothing
 * unshipped" and banded it `good`.
 *
 * MEASURED ON GAMING 2026-09-16, the repo this block brought into the population: 228 commits since
 * `cairn-ios-v0.1.0`, +2,695 / −171,230 lines — a whole `lumen/` subtree removed — for a net of
 * −152,056 over the product paths. The tile said "cairn-ios-v0.1.0 was tagged as released — nothing
 * unshipped", in GREEN, about a repo with 2,695 lines of product added since its release and not in
 * front of anyone. A false GREEN, which is the direction that never provokes a complaint.
 *
 * Note WHERE this was found. `un <= 0` has been here since the field existed and no repo on the bus
 * could reach it, because the only repo whose net had gone negative was one `findManifest` never
 * looked at. A gate does not only hide repos; it hides the defects downstream of it, and they stay
 * hidden for exactly as long as the population goes unasked.
 *
 * So a negative net is refused as a QUANTITY OF UNSHIPPED WORK — it is not one, and zero is not what
 * it means — while `netShrank` carries the figure so a reader can QUALIFY rather than go quiet
 * (WL-011-R1). `blocksSince` is untouched: the commit distance is still perfectly measurable, and
 * refusing a figure that is sound would be the same error pointed the other way.
 */
export function measurableDistance(r: ReleaseSignal):
    { blocksSince: number | null; unshippedProduct: number | null; netShrank: number | null } {
  if (r.anchorOffHistory) return { blocksSince: null, unshippedProduct: null, netShrank: null };
  if (r.unshippedProduct !== null && r.unshippedProduct < 0) {
    return { blocksSince: r.blocksSince, unshippedProduct: null, netShrank: r.unshippedProduct };
  }
  return { blocksSince: r.blocksSince, unshippedProduct: r.unshippedProduct, netShrank: null };
}

/** The newest commit at which the manifest held `want` (or, with no `want`, the newest commit that
 *  CHANGED the version). Bounded: a manifest with a long history is walked from the top and stops as
 *  soon as it can answer, so this costs a few `git show`s, not one per commit. */
function releaseCommit(repoPath: string, rel: string, want: string | null, cap = 80):
    { sha: string; version: string } | null {
  const log = git(repoPath, ["log", "--format=%H", "-n", String(cap), "--", rel]);
  if (log === null) return null;
  const shas = log.split("\n").map((x) => x.trim()).filter(Boolean);
  let prev: string | null = null;
  for (let i = 0; i < shas.length; i++) {
    const body = git(repoPath, ["show", `${shas[i]}:${rel}`]);
    let v: string | null = null;
    try { const o = JSON.parse(body || "{}"); v = typeof o.version === "string" ? o.version : null; }
    catch { /* unparseable at that commit */ }
    if (!v) continue;
    if (want !== null) { if (v === want) return { sha: shas[i], version: v }; continue; }
    // No target: the newest commit whose version differs from the one before it IS the bump.
    if (prev === null) { prev = v; continue; }
    if (v !== prev) return { sha: shas[i - 1], version: prev };
    prev = v;
  }
  return null;
}

/**
 * WL-010 · CAN THIS MANIFEST SPEAK FOR THE WHOLE REPO?
 *
 * MEASURED 2026-09-16 across the 12 buses this ledger reads. `findManifest` recognises NODE
 * manifests only, and then its state is rendered as a claim about the entire project:
 *
 *   · Lumen    — 40 tags (newest cairn-ios-v0.1.0, 2026-08-23), ships iOS/Android from Gradle and
 *                Xcode. Its one JS corner, `shell/package.json`, has never moved off 0.1.0, so the
 *                panel said "never released", RED, about a repo that cuts release trains.
 *   · livegita — 36 tags, newest ios-v1.11.18-2 dated THREE DAYS before the reading, while
 *                package.json last changed version on 2026-05-26. It measured unshipped product
 *                from that May commit and announced "44476 product line(s) not in front of a user
 *                ... and no build is queued". Worse than Lumen: a precise magnitude and a specific
 *                claim, both false. WL-002's lie-with-a-number-on-it in its strongest form.
 *
 * So the defect is NOT the `neverMoved` branch. It is any verdict derived from one Node manifest
 * while something else in the repo contradicts it, and it runs in both directions — toward a false
 * red and toward a false green.
 *
 * The rule: a manifest may answer for the repo only when nothing contradicts it. Two contradictions
 * are checked, both cheap and both evidence the repo itself provides:
 *
 *   1. A TAG NEWER THAN THE MANIFEST'S OWN RELEASE COMMIT. WL-007 demoted tags to corroboration and
 *      then never read them again — but a demoted signal still has one job, which is contradicting
 *      a confident claim. Corroboration that is never consulted is deleted data with extra steps.
 *   2. BUILD FILES FROM ECOSYSTEMS THE MANIFEST CANNOT ACCOUNT FOR. A repo that also builds with
 *      Gradle, Xcode, Cargo, Maven, Go or Flutter is not described by its package.json.
 *
 * When either holds the answer is `unmeasured` — never a verdict. That is WL-002's rule in its
 * third costume: a missing measurement rendered as a verdict is the same lie as one rendered as 0.
 */
// EVERY PATTERN IS DEPTH-ANYWHERE. The first version used bare `build.gradle`, which as a git
// pathspec matches only the repo ROOT — so `android/build.gradle` was invisible and the polyglot
// repo this rule exists for went on being judged by its `web/package.json`. Found by the test,
// which is the only reason it is not still in the product: a guard that looks right and matches
// nothing is indistinguishable from no guard at all.
// WL-012 · PYTHON, AND WHY IT IS KEYED ON A MANIFEST RATHER THAN ON `*.py`. pleodo is a Python
// engine with a web shell: 218 tracked `.py` files and a root `pyproject.toml`, against a
// `web/package.json` that has never moved off 0.1.0. The panel read that manifest and rendered
// "never released — pleodo-web 0.1.0 has never changed version" in the RED band, with 48,819
// product lines called unshipped, about a project whose releases this manifest cannot see. That is
// the livegita shape in a second ecosystem, and the veto was written for exactly this case.
//
// THE PATTERN IS THE WHOLE DECISION. Keying on `*.py` would have vetoed livegita (26 `.py` files,
// 38 tags, currently a correct `tag` reading) and this very repo (5 `.py` files — the mutation
// harness — currently a correct content-anchored `deployed` reading), destroying two right answers
// to fix one wrong one. A repo that HAS a Python script is not a repo that RELEASES from Python;
// a repo carrying a Python build manifest is. Measured on the corpus: `*pyproject.toml` changes
// pleodo (a false red retired) and widens shwab_docker's existing Gradle reason to name Python too.
// `requirements.txt` is deliberately NOT here — it is a dependency list, not a version-bearing
// manifest, and on this corpus it would have vetoed nothing that is not already vetoed.
export const FOREIGN_BUILD_FILES: Array<[string, string]> = [
  ["*build.gradle", "Gradle"], ["*build.gradle.kts", "Gradle"], ["*settings.gradle", "Gradle"],
  ["*pom.xml", "Maven"], ["*Cargo.toml", "Cargo"], ["*go.mod", "Go"],
  ["*Package.swift", "SwiftPM"], ["*pubspec.yaml", "Flutter"], ["*.xcodeproj/project.pbxproj", "Xcode"],
  ["*pyproject.toml", "Python"], ["*setup.py", "Python"],
];

export interface ManifestAuthority {
  /** May this manifest answer for the whole repo? */
  ok: boolean;
  /** Why not, in the words the reader is shown. */
  reason: string | null;
  /** The newest tag, when there is one — named so a reader can go and look. */
  newestTag: string | null;
  /** That tag's commit, so unshipped product can be measured FROM it. */
  newestTagSha: string | null;
  /** Ecosystems present that this manifest cannot account for. */
  foreign: string[];
}

export function manifestAuthority(repoPath: string, manifestRel: string,
                                  releaseSha: string | null): ManifestAuthority {
  const foreignSet = new Set<string>();
  for (const [glob, label] of FOREIGN_BUILD_FILES) {
    const hit = git(repoPath, ["ls-files", glob]);
    if (hit && hit.trim()) foreignSet.add(label);
  }
  const foreign = [...foreignSet].sort();
  // The newest tag by creation date, and whether it POSTDATES the manifest's release commit. A tag
  // older than the bump corroborates rather than contradicts, so it must not veto.
  const newestTag = ((git(repoPath, ["for-each-ref", "--sort=-creatordate", "--count=1",
                                     "--format=%(refname:short)", "refs/tags"]) || "").trim()) || null;
  let tagWins = false;
  let newestTagSha: string | null = null;
  if (newestTag) {
    newestTagSha = ((git(repoPath, ["rev-list", "-1", newestTag]) || "").trim()) || null;
    const tagAt = Number((git(repoPath, ["log", "-1", "--format=%ct", newestTag]) || "").trim());
    const relAt = releaseSha
      ? Number((git(repoPath, ["log", "-1", "--format=%ct", releaseSha]) || "").trim())
      : NaN;
    // With no release commit to compare against (the manifest never moved), ANY tag contradicts it.
    tagWins = Number.isFinite(tagAt) && (!Number.isFinite(relAt) || tagAt > relAt);
  }
  if (tagWins) {
    return { ok: false, newestTag, newestTagSha, foreign,
             reason: `the newest tag ${newestTag} is more recent than anything ${manifestRel} `
                   + `records, so this manifest is not how this project releases` };
  }
  if (foreign.length) {
    return { ok: false, newestTag, newestTagSha, foreign,
             reason: `this repo also builds with ${foreign.join(" and ")}, which ${manifestRel} `
                   + `cannot account for` };
  }
  return { ok: true, reason: null, newestTag, newestTagSha, foreign };
}

/**
 * The release signal, in the order the owner decided: a deployed artifact beats a manifest bump,
 * and NEITHER BEING VISIBLE IS `unmeasured` — not "never released". A project whose releases cannot
 * be seen is not a project that has never released, which is WL-002's rule applied to the figure
 * that was wrong about this repo 42 times over.
 */
export function releaseSignal(repoPath: string | null, opts: {
  manifestPath?: string | null; deployRoots?: string[];
} = {}): ReleaseSignal {
  const roots = opts.deployRoots || DEFAULT_DEPLOY_ROOTS;
  const none = (): ReleaseSignal => ({ source: "unmeasured", manifestPath: null, product: null,
                                       version: null, releasedVersion: null, blocksSince: null,
                                       commit: null, unshippedProduct: null, lookedIn: roots, anchor: "none" });
  if (!repoPath) return none();
  const m = findManifest(repoPath, opts.manifestPath);
  if (!m) return none();
  const base = { manifestPath: m.rel, product: m.siblings > 1 ? m.name : null,
                 version: m.version, lookedIn: roots,
                 commit: null as string | null, unshippedProduct: null as number | null };
  const blocks = (sha: string): number | null => {
    // WL-011 · the same chokepoint as `netProductSince`. `rev-list --count A..HEAD` counts what HEAD
    // reaches and A does not, which for an anchor off this history is very nearly the whole repo —
    // 189 of 189 commits on Lumen. Unmeasured, not a number.
    if (!onThisHistory(repoPath, sha)) return null;
    const n = git(repoPath, ["rev-list", "--count", `${sha}..HEAD`]);
    const k = Number((n || "").trim());
    return Number.isFinite(k) ? k : null;
  };

  /**
   * WL-010 · what a refused manifest resolves to. A TAG that postdates it is EVIDENCE — it names a
   * release and carries a commit — so it answers, and unshipped product is measured from there.
   * Only when nothing can account for the repo is the answer `unmeasured`: a product that says
   * "I cannot tell" everywhere has replaced a false verdict with a useless one.
   */
  const fromAuthority = (auth: ManifestAuthority): ReleaseSignal =>
    auth.newestTag && auth.newestTagSha
      ? { ...base, source: "tag", releasedVersion: auth.newestTag,
          // WL-011 · `blocks` and `netProductSince` both refuse a tag that is off this history, so
          // Lumen's iOS train no longer renders 189 of 189 commits as unshipped. The release is
          // still named; only the distance goes quiet — AND IT SAYS WHY, which is WL-010's rule.
          blocksSince: blocks(auth.newestTagSha), commit: auth.newestTagSha, anchor: "tag",
          anchorOffHistory: !onThisHistory(repoPath, auth.newestTagSha),
          newestTag: auth.newestTag, unmeasuredReason: auth.reason || undefined }
      : { ...base, source: "unmeasured", releasedVersion: null, blocksSince: null, anchor: "none",
          unmeasuredReason: auth.reason || undefined, newestTag: auth.newestTag };

  // 1 · a deployed artifact whose version the manifest history knows.
  const deployed = deployedVersions(m, roots);
  if (deployed.length) {
    // The CURRENT manifest version being deployed means HEAD is what the user has.
    const want = deployed.includes(m.version) ? m.version : null;
    const hit = want ? releaseCommit(repoPath, m.rel, want)
                     : deployed.map((v) => releaseCommit(repoPath, m.rel, v))
                         .filter((x): x is { sha: string; version: string } => !!x)
                         .map((x) => ({ x, n: blocks(x.sha) }))
                         .filter((y) => y.n !== null)
                         .sort((a, b) => (a.n as number) - (b.n as number))[0]?.x || null;
    // WL-011 · THE CONTENT ANCHOR, PREFERRED OVER THE VERSION BUMP. The version number selects WHICH
    // artifact to believe; the artifact's own bytes then say WHICH COMMIT it is. Exactly one
    // directory is content-matched — the one this manifest history already chose, or the deployed
    // version itself when it chose none — so the walk costs one bounded pass, not one per artifact.
    const chosen = hit ? hit.version : (want || deployed[0]);
    const art = deployedArtifacts(m, roots).find((a) => a.version === chosen);
    const byContent = art ? deployedCommit(repoPath, m.rel, art.dir) : null;
    if (byContent) return { ...base, source: "deployed", releasedVersion: chosen,
                            blocksSince: blocks(byContent.sha), commit: byContent.sha,
                            anchor: "content", anchorFiles: byContent.matched };
    // The manifest bump is the FALLBACK, and it says so rather than passing itself off as the
    // deploy: it is right about the version and can be several blocks early about the commit.
    if (hit) return { ...base, source: "deployed", releasedVersion: hit.version,
                      blocksSince: blocks(hit.sha), commit: hit.sha, anchor: "manifest-bump" };
    // Deployed, but no commit in the walked history holds that version AND its content matches
    // nothing: still released, and the distance is what is unknown — reported as such, never as 0.
    return { ...base, source: "deployed", releasedVersion: deployed[0], blocksSince: null,
             anchor: "none" };
  }

  // 2 · no artifact, but the manifest version moved: released at that commit — IF this manifest may
  // answer for the repo. livegita's could not: 36 tags, newest three days old, against a manifest
  // that last moved in May, and the panel announced 44,476 lines "not in front of a user ... no
  // build is queued" about a project that shipped that week.
  const bump = releaseCommit(repoPath, m.rel, null);
  if (bump) {
    const auth = manifestAuthority(repoPath, m.rel, bump.sha);
    if (!auth.ok) return fromAuthority(auth);
    return { ...base, source: "manifest", releasedVersion: bump.version,
             blocksSince: blocks(bump.sha), commit: bump.sha, anchor: "manifest-bump" };
  }

  // 3 · the manifest is tracked but its version has NEVER MOVED. This is the one case where "no
  // release in N blocks" is a TRUE statement, so it is said — with N counted from the commit that
  // introduced the manifest, not from the window, since "never" is a claim about all of it.
  const first = git(repoPath, ["log", "--format=%H", "--reverse", "--", m.rel]);
  const firstSha = (first || "").split("\n").map((x) => x.trim()).filter(Boolean)[0] || null;
  if (firstSha) {
    // THE LUMEN CASE. A manifest that never moved is only evidence of "never released" when it
    // speaks for the repo. Lumen's 40 tags say it does not, and a demoted signal's one remaining
    // job is to contradict a confident claim.
    const auth = manifestAuthority(repoPath, m.rel, null);
    if (!auth.ok) return fromAuthority(auth);
    return { ...base, source: "manifest", releasedVersion: null, blocksSince: blocks(firstSha),
             commit: firstSha, neverMoved: true, anchor: "manifest-bump" };
  }
  // 4 · a manifest on disk that git has never seen (untracked, or a checkout with no history for
  // it). Nothing can be concluded, so nothing is: UNMEASURED, and emphatically not `0 blocks`,
  // which would render "we cannot see it" as "shipped just now".
  return { ...base, source: "unmeasured", releasedVersion: null, blocksSince: null,
           anchor: "none" };
}

// ── WL-003 · where the ORCHESTRATOR's own blocks went ─────────────────────────────────────────
//
// `shipsToUser`, `$/line` and `rigRatio` score the PROJECT. They do not tell the session deciding
// what to do next how it spent its own turns, and that is the thing the add-on exists to change.
//
// The bus tree is NOT a git repository — measured 2026-09-15, `~/.claude/loom` has no `.git` of any
// kind — so "bus mechanics from the loom tree's history" cannot be had, and mtimes cannot supply it
// either: a `board.json` rewritten two hundred times carries ONE mtime, so the volume of bus work is
// exactly the quantity mtimes destroy. The transcripts DO record every tool call with its input, so
// that is what this counts. It is the same thing the owner counted by hand.

/** A tool call is BUS MECHANICS when its input names the bus rather than the product: the loom tree
 *  itself, the files the roles talk through, or the two scripts that drive tabs and composers. */
const BUS_CALL = new RegExp([
  "\\.claude/loom", "board\\.json", "open-requests", "orchestrator-model\\.json",
  "inbox\\.md", "outbox\\.md", "status\\.json", "work-ledger\\.json",
  "reach_po", "loom_cdp", "LOOMROLE",
].join("|"));

export function isBusMechanics(text: string): boolean {
  return BUS_CALL.test(String(text || ""));
}

export type Bucket = "product" | "rig" | "narration" | "bus" | "other";

/** Path-ish tokens in a tool call's input, repo-relativised. A Bash command is matched by the paths
 *  it NAMES — coarse, and said so wherever the figure is shown. */
function callPaths(input: any, repo: string): string[] {
  const out: string[] = [];
  const push = (v: any) => { if (typeof v === "string" && v) out.push(v); };
  if (input && typeof input === "object") {
    push(input.file_path); push(input.path); push(input.notebook_path);
    for (const m of String(input.command || "").matchAll(/[\w./@-]*\.[A-Za-z]\w*/g)) out.push(m[0]);
  }
  const rel = new RegExp(`(?:^|/)${repo.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}/`);
  return out.map((f) => { const i = f.search(rel);
                          return (i >= 0 ? f.slice(i).replace(rel, "") : f).replace(/^\.?\//, ""); });
}

/** ONE bucket per call, bus first. A call that touches the bus IS bus work however it is spelled. */
export function bucketForCall(input: any, repo: string, cls: Classifier): Bucket {
  if (isBusMechanics(JSON.stringify(input ?? {}))) return "bus";
  for (const f of callPaths(input, repo)) {
    if (cls.isProduct(f)) return "product";
    if (isRig(f) || cls.isExcluded(f)) return "rig";
    if (isDoc(f)) return "narration";
  }
  return "other";
}

export interface BlockAllocation {
  calls: number;
  product: number; rig: number; narration: number; bus: number; other: number;
  /** Transcripts that contributed. */
  sessions: number;
  /** WL-002's rule: nothing found is UNMEASURED, never a tidy set of zeros. */
  unmeasured: boolean;
}

const EMPTY_ALLOC = (unmeasured: boolean): BlockAllocation =>
  ({ calls: 0, product: 0, rig: 0, narration: 0, bus: 0, other: 0, sessions: 0, unmeasured });

/** Every tool call this repo's sessions made in the window, bucketed. */
export function scanBlocks(repo: string, sinceMs: number, cls: Classifier,
                           root = PROJECTS_ROOT,
                           sessionIds?: string[] | null): BlockAllocation {
  const dirs = transcriptDirsFor(repo, root);
  if (!dirs.length) return EMPTY_ALLOC(true);
  // SCOPED TO ONE SESSION when asked. "Where did the bus spend its turns" and "where did YOU spend
  // yours" are different questions, and the orchestrator was handed the second one: a developer's
  // tool calls are not the orchestrator's time and must not be reported to it as such.
  const only = sessionIds && sessionIds.length
    ? new Set(sessionIds.map((x) => String(x).toLowerCase())) : null;
  const a = EMPTY_ALLOC(false);
  for (const dir of dirs) {
    let entries: string[];
    try { entries = fs.readdirSync(dir); } catch { continue; }
    for (const name of entries) {
      if (!name.endsWith(".jsonl")) continue;
      if (only && !only.has(name.slice(0, -6).toLowerCase())) continue;
      const file = path.join(dir, name);
      try { if (fs.statSync(file).mtimeMs < sinceMs) continue; } catch { continue; }
      let raw: string;
      try { raw = fs.readFileSync(file, "utf8"); } catch { continue; }
      let sawCall = false;
      for (const line of raw.split("\n")) {
        if (!line.trim()) continue;
        let o: any;
        try { o = JSON.parse(line); } catch { continue; }
        if (!o || o.type !== "assistant") continue;
        const content = o.message && o.message.content;
        if (!Array.isArray(content)) continue;
        for (const b of content) {
          if (!b || b.type !== "tool_use") continue;
          sawCall = true;
          a.calls++;
          a[bucketForCall(b.input, repo, cls)]++;
        }
      }
      if (sawCall) a.sessions++;
    }
  }
  // A SESSION FILTER THAT MATCHED NOTHING IS UNMEASURED, not a tidy row of zeros — the same rule
  // WL-002 fixed for tokens. An orchestrator whose own transcript was not found must be told that,
  // not told it made zero bus calls, which reads as a perfect week.
  if (only && !a.sessions) return EMPTY_ALLOC(true);
  return a;
}

/**
 * WL-007 · NET product lines between a commit and HEAD — "what exists that a user does not have".
 *
 * The same two-point diff as `productDelta`, from a KNOWN commit rather than from a date, because
 * "since the release" is a point in history and not a point in time. Reported instead of a commit
 * count: three of this repo's "blocks since release" on 2026-09-15 were HANDOVER and version commits,
 * which are not work, so the count overstated the drift by three while the honest answer was zero.
 */
export function netProductSince(repoPath: string | null, commit: string | null,
                                cls: Classifier): number | null {
  if (!repoPath || !commit) return null;
  // WL-011 · THE CHOKEPOINT. `git diff A..HEAD` is a TWO-POINT diff, so an anchor on a side branch
  // is compared tree-to-tree and yields a large, confident, meaningless figure — Lumen's 40-tag iOS
  // train reads as "nothing has shipped". An anchor off this history cannot measure a distance
  // along it, and the answer is `null` (unmeasured), never a number.
  if (!onThisHistory(repoPath, commit)) return null;
  const out = git(repoPath, ["diff", "--numstat", `${commit}..HEAD`]);
  if (out === null) return null;
  const net = netProductLinesIn(out, cls);
  return net;
}

// ── compute ───────────────────────────────────────────────────────────────────────────────────

export interface ComputeOpts {
  windowDays?: number;
  productPaths?: Record<string, string[]>;
  /** R7a: globs subtracted from product whatever `productPaths` matches. */
  excludePaths?: string[];
  /** Override the bus root (tests). */
  loomRoot?: string;
  /** Override "now" (tests). */
  nowMs?: number;
  /** R6: list prices per model, `[in, out, cacheRead, cacheWrite1h]` per MTok. */
  modelPrices?: Record<string, PriceRow>;
  /** Override ~/.claude/projects (tests). */
  projectsRoot?: string;
  /** WL-003: scope `allocation` to these session id(s) — the orchestrator's OWN blocks. Omit for
   *  the whole bus. */
  sessionIds?: string[] | null;
  /** R5: the manifest to read, and where a deployed artifact would be found. Both are settings so
   *  no machine's layout is baked in; the artifact NAME always derives from the manifest. */
  manifestPath?: string | null;
  deployRoots?: string[];
}

/** R6's half of the compute, split out so the token figures can be tested without a git repo —
 *  and so `computeWorkLedger`'s two empty-result paths cannot silently skip them. */
function tokenFigures(repo: string, repoPath: string | null, sinceMs: number, cls: Classifier,
                      opts: ComputeOpts):
    Pick<WorkLedger, "tokensSpent" | "tokensByModel" | "costEquivalent" | "unpricedTokens" |
                     "unpricedModels" | "netProductLines" | "newUserFacingFiles" |
                     "tokensPerProductLine" | "costPerProductLine" | "transcriptFiles" |
                     "transcriptDirs" | "transcriptsRoot" | "allocation" | "release"> {
  const scan = scanTranscripts(repo, sinceMs, opts.projectsRoot);
  const cost = costEquivalent(scan.byModel, opts.modelPrices || DEFAULT_MODEL_PRICES);
  const { net, added } = productDelta(repoPath, new Date(sinceMs).toISOString(), cls);
  // UNMEASURED IS NOT FREE. No directory matched, so there is no token fact here — and a repo we
  // cannot see must not be reported as the cheapest one on the panel. Every figure downstream of
  // the scan goes null together; the line counts stay, because git answered those.
  const unmeasured = scan.dirs === 0;
  // The ratio only exists when the denominator is a POSITIVE number of net lines. A week that
  // deleted more product than it added, or added nothing at all, has no cost-per-line — and
  // dividing by it would print either a negative dollar figure or Infinity, both of which read as
  // a bug rather than as the finding they actually are.
  const denom = net !== null && net > 0 ? net : null;
  return {
    tokensSpent: unmeasured ? null : scan.total, tokensByModel: scan.byModel,
    costEquivalent: unmeasured || !scan.total ? null : cost.dollars,
    unpricedTokens: cost.unpricedTokens, unpricedModels: cost.unpricedModels,
    netProductLines: net, newUserFacingFiles: added,
    tokensPerProductLine: denom && !unmeasured ? Math.round(scan.total / denom) : null,
    costPerProductLine: denom && !unmeasured ? Math.round((cost.dollars / denom) * 100) / 100 : null,
    transcriptFiles: scan.files,
    transcriptDirs: scan.dirs,
    transcriptsRoot: opts.projectsRoot || PROJECTS_ROOT,
    // Same scan discipline as the tokens: computed on EVERY path, including the empty ones, so a
    // repo with no commits still reports where its sessions' turns actually went.
    allocation: scanBlocks(repo, sinceMs, cls, opts.projectsRoot, opts.sessionIds),
    release: (() => {
      const r = releaseSignal(repoPath, opts);
      return { ...r, unshippedProduct: netProductSince(repoPath, r.commit, cls) };
    })(),
  };
}

function emptyLedger(repo: string, repoPath: string | null, windowDays: number, reason: string,
                     heuristic: boolean, computedAt: string): WorkLedger {
  return {
    repo, repoPath, windowDays, computedAt, empty: true, emptyReason: reason, heuristic,
    commits: 0, shipsToUser: null, productLines: 0, totalLines: 0,
    narrationShare: null, narrationCommits: 0, rigRatio: null, rigLines: 0,
    loopBackRate: null, handoffs: 0, loopBackHandoffs: 0, medianWallMinutes: null,
    tag: null, blocksSinceRelease: null, daysSinceRelease: null, topChurn: [],
    tokensSpent: 0, tokensByModel: {}, costEquivalent: null, unpricedTokens: 0, unpricedModels: [],
    netProductLines: null, newUserFacingFiles: null, tokensPerProductLine: null,
    costPerProductLine: null, transcriptFiles: 0, transcriptDirs: 0,
    transcriptsRoot: PROJECTS_ROOT,
    blocksSinceProduct: null, narrationRun: 0, allocation: EMPTY_ALLOC(true),
    release: { source: "unmeasured", manifestPath: null, product: null, version: null,
               releasedVersion: null, blocksSince: null, commit: null, unshippedProduct: null,
               lookedIn: DEFAULT_DEPLOY_ROOTS, anchor: "none" },
  };
}

const pct1 = (n: number, d: number): number | null =>
  d > 0 ? Math.round((n / d) * 1000) / 10 : null;

/**
 * The whole of R1. ONE `git log --numstat` pass, plus one cheap `describe`/`rev-list` for the tag.
 * Never throws: every failure path produces a well-formed empty result naming its reason.
 */
export function computeWorkLedger(repoPath: string | null, opts: ComputeOpts = {}): WorkLedger {
  const windowDays = Math.max(1, Number(opts.windowDays) || DEFAULT_WINDOW_DAYS);
  const nowMs = opts.nowMs ?? Date.now();
  const computedAt = new Date(nowMs).toISOString();
  const sinceMs = nowMs - windowDays * 86_400_000;
  const productPaths = opts.productPaths || DEFAULT_PRODUCT_PATHS;
  const repo = repoPath ? path.basename(repoPath) : "";
  const cls = classifierFor(repo, productPaths, opts.excludePaths);

  // Tokens are measured from the TRANSCRIPTS, not from the repo, so they exist even when git has
  // nothing to say. A week that burned 9 billion tokens into a repo with no commits is the single
  // most important thing this panel could report, and returning early would hide exactly that.
  const tok = () => tokenFigures(repo, repoPath, sinceMs, cls, opts);

  if (!repoPath) {
    return { ...emptyLedger(repo, null, windowDays, "no repository path", cls.heuristic, computedAt),
             ...tok() };
  }
  // `--git-common-dir` rather than `--is-inside-work-tree`, so a WORKTREE measures its parent repo's
  // history rather than looking like a separate project with a week of nothing in it.
  if (git(repoPath, ["rev-parse", "--git-common-dir"]) === null) {
    return { ...emptyLedger(repo, repoPath, windowDays, "not a git repository", cls.heuristic, computedAt),
             ...tok() };
  }

  const since = new Date(sinceMs).toISOString();
  const out = git(repoPath, ["log", `--since=${since}`, "--numstat", "--no-merges",
                             "--format=%x01%H"]);
  if (out === null) {
    return { ...emptyLedger(repo, repoPath, windowDays, "git log failed", cls.heuristic, computedAt),
             ...tok() };
  }
  const commits = parseNumstat(out);

  const led = readLedger(repo, sinceMs, opts.loomRoot);
  const loopBackHandoffs = led.filter((l) => l.loopBacks > 0).length;

  if (!commits.length) {
    const e = emptyLedger(repo, repoPath, windowDays,
      `no commits in the last ${windowDays} days`, cls.heuristic, computedAt);
    // The ledger half is still real even when git is silent — a week of handoffs that produced no
    // commit at all is precisely the week this module was written to make visible.
    e.handoffs = led.length;
    e.loopBackHandoffs = loopBackHandoffs;
    e.loopBackRate = pct1(loopBackHandoffs, led.length);
    e.medianWallMinutes = medianPositive(led.map((l) => l.wallMinutes));
    Object.assign(e, tagFigures(repoPath, nowMs), tok());
    return e;
  }

  let productLines = 0, totalLines = 0, rigLines = 0, narrationCommits = 0;
  const churn = new Map<string, ChurnEntry>();
  for (const c of commits) {
    // "entire file set is docs" — and a commit that touched NO file (an empty commit) is not
    // narration, it is nothing, so `.length &&` guards the vacuous-truth case.
    if (c.files.length && c.files.every(isDoc)) narrationCommits++;
    for (const l of c.lines) {
      const n = l.added + l.deleted;
      totalLines += n;
      if (cls.isProduct(l.file)) productLines += n;
      // R7c — WHAT IS SUBTRACTED FROM PRODUCT LANDS HERE. Before R7a the two sets overlapped: a
      // `src/app/page.test.tsx` was counted as product AND as rig, so the ratio understated the rig
      // by construction (1.18× on ReciEats) while the shipping share overstated the product. The
      // numerator and denominator must partition the week's lines, not share them.
      if (isRig(l.file) || cls.isExcluded(l.file)) rigLines += n;
      const e = churn.get(l.file) || { file: l.file, touches: 0, net: 0 };
      e.touches++;
      e.net += l.added - l.deleted;
      churn.set(l.file, e);
    }
  }

  // Newest-first, so the FIRST commit carrying a product line ends both runs. These are the two
  // facts a dispatching orchestrator can act on: how long since PRODUCT CODE LAST CHANGED, and how
  // much of the recent past was only talk about the work. WL-011: neither is "reached a user" —
  // that question is answered by `release`, from a deployed artifact, and only there.
  let blocksSinceProduct: number | null = null;
  for (let i = 0; i < commits.length; i++) {
    if (commits[i].lines.some((l) => cls.isProduct(l.file))) { blocksSinceProduct = i; break; }
  }
  if (blocksSinceProduct === null && commits.length) blocksSinceProduct = commits.length;
  let narrationRun = 0;
  for (const c of commits) {
    if (c.files.length && c.files.every(isDoc)) narrationRun++; else break;
  }

  const topChurn = Array.from(churn.values())
    // Ties broken by |net| then by name, so the order is stable across runs — an unstable list
    // makes a diff of two reports unreadable.
    .sort((a, b) => b.touches - a.touches || Math.abs(b.net) - Math.abs(a.net) ||
                    a.file.localeCompare(b.file))
    .slice(0, 5);

  return {
    repo, repoPath, windowDays, computedAt, empty: false, emptyReason: null, heuristic: cls.heuristic,
    commits: commits.length,
    shipsToUser: pct1(productLines, totalLines), productLines, totalLines,
    narrationShare: pct1(narrationCommits, commits.length), narrationCommits,
    // Guarded: with no product line moved this is a division by zero, and "infinitely more rig than
    // product" is not a number the panel can colour.
    rigRatio: productLines > 0 ? Math.round((rigLines / productLines) * 100) / 100 : null,
    rigLines,
    loopBackRate: pct1(loopBackHandoffs, led.length), handoffs: led.length, loopBackHandoffs,
    medianWallMinutes: medianPositive(led.map((l) => l.wallMinutes)),
    ...tagFigures(repoPath, nowMs),
    blocksSinceProduct, narrationRun,
    topChurn,
    ...tok(),
  };
}

/** Commits since the newest tag, and days since it. A repo with NO tag returns nulls with
 *  `tag: null` — the "never released" case, which the view renders as a warning, not a blank. */
function tagFigures(repoPath: string, nowMs: number):
    Pick<WorkLedger, "tag" | "blocksSinceRelease" | "daysSinceRelease"> {
  const tag = (git(repoPath, ["describe", "--tags", "--abbrev=0"]) || "").trim();
  if (!tag) return { tag: null, blocksSinceRelease: null, daysSinceRelease: null };
  const count = (git(repoPath, ["rev-list", "--count", `${tag}..HEAD`]) || "").trim();
  const when = (git(repoPath, ["log", "-1", "--format=%cI", tag]) || "").trim();
  const at = Date.parse(when);
  return {
    tag,
    blocksSinceRelease: /^\d+$/.test(count) ? Number(count) : null,
    daysSinceRelease: Number.isFinite(at) ? Math.floor((nowMs - at) / 86_400_000) : null,
  };
}

// ── the cache (R1's performance requirement) ──────────────────────────────────────────────────

export function cacheFile(repo: string, root = LOOM_ROOT): string {
  return path.join(root, repo, "work-ledger.json");
}

export interface CacheShape { ledger: WorkLedger; notifiedOn?: string; }

/** Read the cache. Never throws; an unreadable or wrong-shaped file is simply "no cache yet". */
export function readCache(repo: string, root = LOOM_ROOT): CacheShape | null {
  try {
    const o = JSON.parse(fs.readFileSync(cacheFile(repo, root), "utf8"));
    if (o && typeof o === "object" && o.ledger && typeof o.ledger === "object" &&
        typeof o.ledger.computedAt === "string") return o as CacheShape;
  } catch { /* none yet */ }
  return null;
}

/** Atomic (tmp+rename): the tick writes this while the view reads it, and a torn read here would
 *  make the panel report figures that were never measured. */
export function writeCache(repo: string, next: CacheShape, root = LOOM_ROOT): boolean {
  try {
    const f = cacheFile(repo, root);
    fs.mkdirSync(path.dirname(f), { recursive: true });
    const tmp = f + ".tmp." + process.pid;
    fs.writeFileSync(tmp, JSON.stringify(next, null, 2));
    fs.renameSync(tmp, f);
    return true;
  } catch { return false; }
}

/** Is a recompute due? Unreadable `computedAt` means yes — a value we cannot read is not a
 *  measurement we can rest on. */
export function dueForCompute(cache: CacheShape | null, intervalMin: number, nowMs: number): boolean {
  if (!cache) return true;
  const at = Date.parse(cache.ledger.computedAt);
  if (!Number.isFinite(at)) return true;
  return nowMs - at >= Math.max(1, intervalMin) * 60_000;
}

/**
 * The tick's entry point: recompute at most every `intervalMin`, otherwise hand back the cache.
 * `notifiedOn` (R5's once-per-day state) is carried across a recompute — it belongs to the project,
 * not to one measurement.
 */
export function refreshWorkLedger(repo: string, repoPath: string | null,
                                  opts: ComputeOpts & { intervalMin?: number } = {}): CacheShape | null {
  const root = opts.loomRoot || LOOM_ROOT;
  const nowMs = opts.nowMs ?? Date.now();
  const cache = readCache(repo, root);
  if (!dueForCompute(cache, opts.intervalMin ?? DEFAULT_INTERVAL_MIN, nowMs)) return cache;
  const ledger = computeWorkLedger(repoPath, opts);
  const next: CacheShape = { ledger, ...(cache?.notifiedOn ? { notifiedOn: cache.notifiedOn } : {}) };
  writeCache(repo, next, root);
  return next;
}

// ── colour bands (R2) ─────────────────────────────────────────────────────────────────────────

export type Band = "good" | "warn" | "bad" | "unknown";

/** `highIsGood: false` inverts the comparison for loop-backs and narration, where LOW is good.
 *  Boundaries are INCLUSIVE on the good side both ways — 40 % shipping is green, 20 % loop-backs is
 *  green — so the bands read the way the handoff states them (≥40 / 20-40 / <20, ≤20 / 20-50 / >50). */
export function band(value: number | null, good: number, bad: number, highIsGood = true): Band {
  if (value === null || !Number.isFinite(value)) return "unknown";
  if (highIsGood) return value >= good ? "good" : value < bad ? "bad" : "warn";
  return value <= good ? "good" : value > bad ? "bad" : "warn";
}

export interface Figure {
  key: string; label: string; value: string; band: Band; detail: string;
}

/** The rows the tree shows when the ledger node is expanded, and the report's table (R2/R3 share
 *  this so the panel and the document can never disagree about a number).
 *  A red row STATES THE NUMBER — a bare warning icon is the thing being replaced. */
/**
 * WL-007 · ONE ANSWER TO "DID THIS REACH A USER", FOR EVERY READER.
 *
 * WL-003-R5 rekeyed the COLLECTOR off git tags and exactly ONE of four readers. The other three kept
 * reading `w.tag`, which is null for ever on a repo with no tags — so on 2026-09-15, a day this bus
 * deployed five builds, the panel tile, the summary line and the orchestrator's own message all said
 * "no release in 88 blocks", and the tile hard-coded `band: "bad"`. That is WL-004-R6's lesson in a
 * new place: the fix was applied where the defect was NOTICED rather than everywhere the proxy was
 * read. This function exists so there is one place to change next time.
 *
 * THE BAND IS THE PART THAT MATTERS, because a fourth reader consumes it: statusView derives the
 * whole work-ledger node's icon from `figuresFor(...).some(f => f.band === "bad")`, so the hard-coded
 * red did not colour one row — it made every untagged project's HEADLINE verdict red regardless of
 * every other figure. `unmeasured` gets `unknown`, never a colour that means "you are failing".
 */
export function releaseReading(w: WorkLedger,
                               t: Thresholds = DEFAULT_THRESHOLDS): { text: string; band: Band; detail: string } {
  const r = w.release;
  const who = r.product ? `${r.product} ` : "";
  if (r.source === "unmeasured") {
    // WL-010 · SAY WHAT COULD NOT BE MEASURED, not merely that something could not. An unmeasured
    // reading with a reason is actionable ("point productPaths at the right manifest"); one without
    // is just a shrug, and a reader who cannot act on it learns to ignore it.
    const why = r.unmeasuredReason
      ? `${r.unmeasuredReason}. Its release state is ${UNMEASURED} rather than guessed from the ` +
        `one manifest that could be read`
      : `no manifest and no deployed artifact under ${r.lookedIn.join(" or ")}`;
    return { text: r.newestTag ? `release ${UNMEASURED} — newest tag ${r.newestTag}`
                               : `release ${UNMEASURED}`,
             band: "unknown",
             detail: `Whether anything has been released is ${UNMEASURED}: ${why}. ` +
                     `"I cannot measure this" and "this never shipped" are different statements.` };
  }
  if (r.neverMoved) {
    // The ONE case the old wording was right about: a tracked manifest whose version never changed.
    return { text: `never released — ${who}${r.version} has never changed version`, band: "bad",
             detail: `${r.manifestPath} is tracked and its version has never moved in ` +
                     `${r.blocksSince ?? "?"} commit(s). Nothing here has ever been cut.` };
  }
  // WL-010 · THE BASIS, AND HOW STRONGLY IT MAY SPEAK. A deployed artifact is evidence a user HAS
  // it. A manifest bump is evidence someone CUT a version — shwab_docker renders green off a
  // manifest alone at 0.0.0 with no artifact anywhere, and the old wording said it was "in front of
  // a user". That is not a second defect in the signal (WL-003-R5 deliberately answers from a
  // moved manifest, and its test says so); it is this reader claiming more than its basis carries.
  const basis = r.source === "deployed" ? "deployed artifact"
              : r.source === "tag" ? "git tag" : "manifest bump";
  const reached = r.source === "deployed" ? "is in front of a user"
                : r.source === "tag" ? "was tagged as released"
                : "was cut (manifest bump — not seen in front of a user)";
  // WL-011 · taken through the reader's own chokepoint, never straight off the field.
  const dist = measurableDistance(r);
  const un = dist.unshippedProduct;
  // WL-010 · NOT for a tag-sourced release. `pending` means "the manifest is AHEAD of what shipped",
  // which is only meaningful when both sides are the same KIND of version. Against a tag NAME
  // (`ios-v1.11.18-2`) the comparison is always unequal, so livegita read "1.0.0 is pending a build"
  // purely because a string differed from a tag. A comparison between two things that are not the
  // same kind of thing is not a measurement.
  const pending = r.source !== "tag" && r.version !== null && r.releasedVersion !== null
                  && r.version !== r.releasedVersion;
  // NOT the commit count. Three of this repo's "blocks since release" were HANDOVER and version
  // commits, which are not work; the honest question is how much PRODUCT a user does not have.
  // MEASURED AGAINST THE WINDOW'S OWN OUTPUT, not against a constant. The first version of this
  // band was binary — any unshipped product with no pending build read `bad` — and on this repo that
  // fired on THIRTEEN lines, which would have made the aggregate icon red again on a bus that ships
  // daily. Found by running it, not by reasoning about it. A share answers the question a reader
  // actually has: is a meaningful part of this week's product missing from the user's hands?
  const window = w.netProductLines !== null && w.netProductLines > 0 ? w.netProductLines : null;
  const share = un !== null && un > 0 && window !== null ? (un / window) * 100 : null;
  // WL-012 · `un === 0` and "the net came out negative" are DIFFERENT STATEMENTS and only the first
  // one is good news. A shrink bands `unknown`, never `good`: the quantity of unshipped work is not
  // known, and green is the one colour that tells a reader to stop looking.
  const band: Band = dist.netShrank !== null ? "unknown"
    : un === null ? "unknown"
    : un <= 0 ? "good"
    // A pending build is someone's intent to ship; it can warn, never fail.
    : pending ? "warn"
    : share === null ? "warn"
    : share >= t.unshippedShareBad ? "bad"
    : share <= t.unshippedShareGood ? "good" : "warn";
  // WL-011 · THE CLAIM, NOT ONLY THE BAND. When the anchor is off this history the honest sentence
  // is that the distance cannot be measured FROM HERE — Lumen's tag is a real release on a train
  // this branch never joined, and the old code answered it with 189 of 189 commits unshipped.
  const text = r.anchorOffHistory
    ? `${who}${r.releasedVersion} ${reached}; how far ahead of it this branch is, is ${UNMEASURED}`
    // WL-012 · the release is still REAL and still NAMED; it is the MAGNITUDE that is refused, and
    // the sentence says which way the diff ran so the reader knows why rather than only that.
    : dist.netShrank !== null
    ? `${who}${r.releasedVersion} ${reached}; product has NET SHRUNK by ` +
      `${Math.abs(dist.netShrank)} line(s) since, so how much is unshipped is ${UNMEASURED}`
    : un === null
    ? `${who}${r.releasedVersion} ${reached}`
    : un <= 0
      ? `${who}${r.releasedVersion} ${reached} — nothing unshipped`
      : `${un} product line(s) not in front of a user since ${who}${r.releasedVersion}` +
        `${pending ? `; ${r.version} is pending a build` : `, and no build is queued`}`;
  return { text, band,
    detail: `Newest ${basis}: ${who}${r.releasedVersion}. ` +
            // WL-011 · the explanation belongs to the NUMBER. When there is no number the clause
            // ran on anyway — "could not be measured. — the two-point diff over the product paths
            // from the release commit" — describing a measurement that was refused.
            `${dist.netShrank !== null
               ? `Unshipped product lines could not be measured: the two-point diff over the ` +
                 `product paths from the release commit came out NEGATIVE ` +
                 `(${dist.netShrank} net), so product has shrunk since the release rather than ` +
                 `grown. A net diff cannot count unshipped work across a deletion that large, and ` +
                 `0 is not what it means. `
               : un === null ? "Unshipped product lines could not be measured. " :
               `${un} NET product line(s) exist on HEAD that are not in it — the two-point diff ` +
               `over the product paths from the release commit, NOT a commit count: three of this ` +
               `repo's "blocks since release" were HANDOVER and version commits, which are not ` +
               `work. `}` +
            `Commits since: ${dist.blocksSince ?? "?"}. Manifest: ${r.version}.` +
            // WL-011 · HOW THE COMMIT WAS IDENTIFIED travels with the claim, exactly as `source`
            // does. "Anchored on the deployed artifact's own content" and "anchored on the commit
            // that bumped the version" are different strengths of evidence and the reader is owed
            // which one answered — a bump anchor is right about the version and can be several
            // blocks early about the code, which is how 0.40.0 rendered 152 lines the user had.
            `${r.anchor === "content"
               ? ` Anchored on the deployed artifact's own content, matched over ` +
                 `${r.anchorFiles ?? "?"} shipped file(s) — the commit that was DEPLOYED, not the ` +
                 `commit that bumped the version.`
               : r.anchor === "manifest-bump"
                 ? ` Anchored on the commit that BUMPED THE VERSION, which is not necessarily what ` +
                   `was deployed: work that ships under an existing version number lands after it.`
                 : r.anchor === "tag" ? ` Anchored on the tagged commit.` : ""}` +
            `${r.anchorOffHistory
               ? ` That anchor is NOT AN ANCESTOR OF HEAD — a release cut on a branch this one ` +
                 `never joined — so no distance is measured from it. Counting anyway would report ` +
                 `nearly the whole repository as unshipped, which is what Lumen's 40 release tags ` +
                 `used to read as.` : ""}` +
            `${share === null ? "" : ` That is ${Math.round(share * 10) / 10}% of this window's ` +
              `net product (red above ${t.unshippedShareBad}%, green at or below ` +
              `${t.unshippedShareGood}%) — a SHARE, because a fixed line count made 13 unshipped ` +
              `lines read as a failure.`}` +
            `${pending ? " The manifest is AHEAD of what is deployed, so a build is pending." : ""}` +
            // WL-011-R1 · THE DOUBT THE OBJECT ALREADY CARRIES. `unmeasuredReason` is computed
            // whenever a manifest is refused authority, but it was rendered ONLY on the `unmeasured`
            // branch — so on a TAG reading the line named a tag while never saying why the manifest
            // had been set aside. That is WL-010's own lesson one layer in: a demoted signal whose
            // one remaining job is to qualify a confident claim, and which nothing ever consults.
            //
            // IT QUALIFIES THE READING, IT DOES NOT SUPPRESS IT. Measured on livegita, whose tag IS
            // an ancestor of HEAD: "2 product line(s) not in front of a user since ios-v1.12.0-2"
            // over 5 commits is TRUE and specific, and refusing to say it would replace a correct
            // verdict with a useless one — which is the trade WL-010 explicitly declined. What makes
            // Lumen different is not the reason, it is the ANCESTRY, and that is guarded above.
            `${r.unmeasuredReason ? ` Measured against a tag rather than the manifest: ` +
               `${r.unmeasuredReason}.` : ""}` };
}

export function figuresFor(w: WorkLedger, t: Thresholds = DEFAULT_THRESHOLDS): Figure[] {
  const win = `window ${w.windowDays}d · computed ${w.computedAt}`;
  // Read ONCE: the value, the band and the detail of the release row must describe the same reading.
  const rel = releaseReading(w, t);
  const guess = w.heuristic
    ? "\nHEURISTIC: no productPaths configured for this repo, so 'product' is everything except " +
      "tests/scripts/tools/docs/lockfiles/config. Configure loomSessionTracker.productPaths to measure it."
    : "";
  return [
    { key: "shipsToUser", label: "ships to user",
      value: w.shipsToUser === null ? "unknown" : `${w.shipsToUser}%`,
      band: band(w.shipsToUser, t.shipsGood, t.shipsBad, true),
      detail: `${w.productLines} of ${w.totalLines} changed lines are in product paths, over ` +
              `${w.commits} commit(s).\n${win}${guess}` },
    { key: "loopBackRate", label: "loop-backs",
      value: w.loopBackRate === null ? "unknown" : `${w.loopBackRate}%`,
      band: band(w.loopBackRate, t.loopBackGood, t.loopBackBad, false),
      detail: `${w.loopBackHandoffs} of ${w.handoffs} handoff(s) in model-ledger.jsonl needed at ` +
              `least one loop-back` +
              `${w.medianWallMinutes === null ? "" : `; median ${w.medianWallMinutes} min each`}` +
              ` (non-positive wall times dropped, not shown as 0).\n${win}` },
    { key: "narrationShare", label: "narration",
      value: w.narrationShare === null ? "unknown" : `${w.narrationShare}%`,
      band: band(w.narrationShare, t.narrationGood, t.narrationBad, false),
      detail: `${w.narrationCommits} of ${w.commits} commit(s) touched documentation ONLY ` +
              `(*.md, guide/, docs/) — the "update the guide" commits.\n${win}` },
    { key: "rigRatio", label: "rig vs product",
      value: w.rigRatio === null ? "unknown" : `${w.rigRatio}×`,
      band: "unknown",           // a ratio with no agreed band: reported, never coloured
      detail: `${w.rigLines} line(s) of tests/scripts/tools against ${w.productLines} line(s) of ` +
              `product.\n${win}` },
    { key: "release", label: "release",
      // WL-007 · value, band AND detail all off `w.release`. The band used to be hard-coded `bad`
      // whenever `w.tag` was null, which on a repo with no tags is for ever — and statusView derives
      // the whole ledger node's icon from any `bad` band, so an untagged bus that ships daily was
      // permanently red at its headline. A release that IS in front of a user is not a failure, and
      // `unmeasured` is not one either.
      value: rel.text,
      band: rel.band,
      detail: `${rel.detail}\n${win}` },
    // ── R6 · the ratio the owner actually asked for ────────────────────────────────────────────
    { key: "tokensSpent", label: "tokens",
      value: w.tokensSpent === null ? UNMEASURED : w.tokensSpent ? fmtTokens(w.tokensSpent) : "0",
      band: "unknown",
      detail: w.tokensSpent === null
        ? `NOT MEASURED — no project directory matches this repo, so no transcript was read. This ` +
          `is NOT a token count of zero and nothing below it is a cost.\n` +
          `Looked in ${w.transcriptsRoot} for a directory ending in the repo name (or a ` +
          `\`--\`-suffixed worktree of it), compared with \`_\` and \`.\` folded to \`-\` the way ` +
          `the session encoder writes them.\n` +
          `AN UNMEASURED BUS IS A BUS NOBODY IS WATCHING.\n${win}`
        : `${w.tokensSpent.toLocaleString()} token(s) across ${w.transcriptFiles} transcript ` +
              `file(s), CACHE READS INCLUDED (they run ~100× the other classes; omitting them ` +
              `understates the total by two orders of magnitude).\n` +
              byModelLine(w) + `\nWindow is by transcript mtime.\n${win}` },
    { key: "costEquivalent", label: "list-price equivalent",
      value: w.costEquivalent === null
        ? (w.tokensSpent === null ? UNMEASURED : "unknown") : fmtMoney(w.costEquivalent),
      band: "unknown",
      detail: `LIST-PRICE EQUIVALENT — not a bill. This work runs on a subscription and nobody is ` +
              `invoiced this; it is the resource figure.\n` + byModelLine(w) +
              (w.unpricedModels.length
                ? `\n⚠ ${w.unpricedTokens.toLocaleString()} token(s) belong to unpriced model id(s) ` +
                  `(${w.unpricedModels.join(", ")}) and are counted as TOKENS but not as dollars — ` +
                  `the dollar figure is an undercount by that much.`
                : "") + `\n${win}` },
    { key: "netProductLines", label: "net product lines",
      value: w.netProductLines === null ? "unknown"
        : `${w.netProductLines >= 0 ? "+" : ""}${w.netProductLines}` +
          `${w.newUserFacingFiles === null ? "" : ` · ${w.newUserFacingFiles} new file(s)`}`,
      band: "unknown",
      detail: `NET (added − deleted) over the product paths — not churn. A file rewritten 118 times ` +
              `has produced nothing if it ends the same size.\n` +
              `${w.newUserFacingFiles === null ? "" :
                 `${w.newUserFacingFiles} file(s) were ADDED under the product paths, which is what ` +
                 `separates building from revising.\n`}${win}${guess}` },
    { key: "costPerProductLine", label: "$ per product line",
      value: w.costPerProductLine === null
        // UNMEASURED OUTRANKS every other reading of a null here: with no transcripts there is no
        // ratio, whatever git says about the denominator.
        ? (w.tokensSpent === null ? UNMEASURED
           : w.netProductLines !== null && w.netProductLines <= 0
            ? "no net product lines this window" : "unknown")
        : `${fmtMoney(w.costPerProductLine)}/line`,
      // NOT GREEN, AND NOT RED. An unmeasured repo has no value to band, and green is exactly the
      // lie WL-002 fixes: $0.00/line is the most flattering number this panel can print and it was
      // what it printed for a project it could not see at all.
      band: w.costPerProductLine === null
        // A window that produced NO net product line while spending tokens is not "unknown" — it is
        // the worst reading this panel can give, and it must not be the quietest one.
        ? ((w.tokensSpent ?? 0) > 0 && w.netProductLines !== null && w.netProductLines <= 0
            ? "bad" : "unknown")
        : (w.costPerProductLine > t.costPerLine ? "bad" : "good"),
      detail: (w.tokensSpent === null
        ? `UNMEASURED — no transcript directory matched this repo, so there is no cost and no ` +
          `ratio. This row is neither cheap nor expensive; it is unknown, and it is the one ` +
          `reading a threshold can never catch, because zero is under every threshold.\n`
        : "") +
              `${w.costEquivalent === null ? UNMEASURED : fmtMoney(w.costEquivalent)} of list-price ` +
              `equivalent ÷ ${w.netProductLines === null ? "?" : w.netProductLines} net product ` +
              `line(s)` +
              `${w.tokensPerProductLine === null ? "" :
                 `; ${w.tokensPerProductLine.toLocaleString()} tokens per net product line`}.\n` +
              `Red above ${fmtMoney(t.costPerLine)}/line.\n${win}` },
  ];
}

function fmtTokens(n: number): string {
  if (n >= 1e9) return `${Math.round(n / 1e8) / 10}B`;
  if (n >= 1e6) return `${Math.round(n / 1e5) / 10}M`;
  if (n >= 1e3) return `${Math.round(n / 100) / 10}k`;
  return String(n);
}

function fmtMoney(n: number): string {
  return n >= 100 ? `$${Math.round(n).toLocaleString()}`
       : n >= 1 ? `$${n.toFixed(2)}` : `$${n.toFixed(2)}`;
}

/** The per-model split, which is where the cost actually lives — one premium orchestrator can
 *  outweigh every worker, and that is a decision a person can only take if they can see it. */
function byModelLine(w: WorkLedger): string {
  const rows = Object.entries(w.tokensByModel)
    .map(([id, t]) => ({ id, n: t.input + t.output + t.cacheRead + t.cacheCreate, t }))
    .sort((a, b) => b.n - a.n);
  if (!rows.length) return "No transcript usage found for this project in the window.";
  return rows.map((r) => `  ${r.id}: ${fmtTokens(r.n)} ` +
    `(in ${fmtTokens(r.t.input)}, out ${fmtTokens(r.t.output)}, ` +
    `cache read ${fmtTokens(r.t.cacheRead)}, cache write ${fmtTokens(r.t.cacheCreate)})`).join("\n");
}

/** The one line the project node carries, which has to carry the verdict on its own.
 *  `tokens · $equiv · $/product line` sits next to the ships percentage because that trio IS the
 *  audit — it is the owner's question ("for the amount of tokens consumed how much output did I
 *  get") answered in one line, and the shares of lines beside it do not answer it. */
export function summaryLine(w: WorkLedger): string {
  if (w.empty && !w.handoffs && !w.tokensSpent) {
    return `no data — ${w.emptyReason || "nothing measured"}`;
  }
  const f = (v: number | null, s: string) => (v === null ? `${s} —` : `${s} ${v}%`);
  return [
    // An unmeasured repo SAYS SO on the one line it gets, rather than dropping the trio and
    // reading like a repo that simply spent nothing.
    ...(w.tokensSpent === null ? [`tokens ${UNMEASURED}`] : w.tokensSpent ? [
      fmtTokens(w.tokensSpent),
      `${w.costEquivalent === null ? UNMEASURED : fmtMoney(w.costEquivalent)} equiv`,
      w.costPerProductLine === null
        ? (w.netProductLines !== null && w.netProductLines <= 0 ? "NO net product lines"
           : `${UNMEASURED}/line`)
        : `${fmtMoney(w.costPerProductLine)}/line`,
    ] : []),
    f(w.shipsToUser, "ships") + (w.heuristic ? " (est)" : ""),
    f(w.loopBackRate, "loop-backs"),
    f(w.narrationShare, "narration"),
    // WL-007 · the same field and the same vocabulary as the tile and the nudge.
    releaseReading(w).text,
  ].join(" · ");
}

// ── R5 · the line the orchestrator is told, once per project per day ──────────────────────────

/** The message, or null when nothing warrants one. Separate from the sending so the DECISION is
 *  testable without a composer: shipsToUser must be RED, and the day must not already be spoken for. */
export function ledgerAlert(w: WorkLedger, notifiedOn: string | null | undefined,
                            t: Thresholds = DEFAULT_THRESHOLDS, nowMs = Date.now()): string | null {
  if (w.empty && !w.commits && !w.tokensSpent) return null;
  // EITHER half can raise it. Shipping share was the original trigger; cost per product line is the
  // owner's actual question, and a week can be green on shares while costing a fortune per line —
  // the two are not the same alarm and neither may be silent because the other is calm.
  const shipsBad = band(w.shipsToUser, t.shipsGood, t.shipsBad, true) === "bad";
  const costBad = w.costPerProductLine !== null && w.costPerProductLine > t.costPerLine;
  const nothingShipped = (w.tokensSpent ?? 0) > 0 &&
                         w.netProductLines !== null && w.netProductLines <= 0;
  // A THIRD TRIGGER. The cost alarm cannot fire on an unmeasured repo — zero is under every
  // threshold — so silence here means the panel is quietest about the project it can see least.
  // Once a day, it says so instead.
  const unmeasured = w.tokensSpent === null;
  // WL-007-R1 · A FOURTH TRIGGER, AND THE CONDITION ON THE RELEASE CLAUSE — one rule, both ways.
  //
  // This message used to append the release state unconditionally, to an alert raised by the
  // shipping and cost thresholds. So a release figure rode along on someone else's alarm and
  // carried the authority of an alarm without having earned it — which is exactly how the false
  // "no release in 87 blocks" reached the orchestrator mid-decision at 00:05Z on 2026-09-16. A
  // message that interrupts someone should state ITS OWN cause, not a digest of every figure.
  //
  // So the release state is now a trigger in its own right when it is genuinely bad, and the clause
  // renders IF AND ONLY IF that is one of the reasons the alert fired. The two cannot drift apart,
  // because they are the same boolean. This is safe to raise on only because WL-007 made the band
  // honest: `unmeasured` bands `unknown` and a deployed release with nothing outstanding bands
  // `good`, so neither can fire it — under the old tag proxy this would have alarmed every day.
  const releaseBad = releaseReading(w, t).band === "bad";
  if (!shipsBad && !costBad && !nothingShipped && !unmeasured && !releaseBad) return null;
  const today = new Date(nowMs).toISOString().slice(0, 10);
  if (notifiedOn === today) return null;
  return `[loom-ledger] ${w.repo}: ` +
         `${w.shipsToUser === null ? "?" : w.shipsToUser}% of this week's changed lines reach a user; ` +
         `${w.narrationShare === null ? "?" : w.narrationShare}% of commits only update the guide; ` +
         `${releaseBad ? `${releaseReading(w, t).text}. ` : ""}` +
         `${unmeasured ? `Tokens and cost are ${UNMEASURED} — no transcript directory under ` +
              `${w.transcriptsRoot} matches this repo, so its spend is invisible here. This is NOT ` +
              `a cheap week; it is an unwatched one. It` :
            `${fmtTokens(w.tokensSpent as number)} tokens (${w.costEquivalent === null ? UNMEASURED :
               // PD-001 · "equivalent" is what "not a bill" already says. Same claim, 11 fewer chars.
               fmtMoney(w.costEquivalent)} list-price, not a bill)`} produced ` +
         `${nothingShipped ? "NO net product lines" :
            `${w.netProductLines === null ? "?" : `${w.netProductLines >= 0 ? "+" : ""}${w.netProductLines}`} ` +
            `net product line(s)` +
            `${w.costPerProductLine === null ? "" : ` at ${fmtMoney(w.costPerProductLine)}/line`}`}` +
         `${w.newUserFacingFiles === null ? "" : `, ${w.newUserFacingFiles} new user-facing file(s)`}.`;
  // PD-001 §4 · "Consider whether the next block ships something." used to close this line and is
  // now CUT, to pay for the contract the message carries instead. It was the weakest kind of words:
  // it asked for no decision this alert does not already imply, and the briefing's own header now
  // says what these figures are for. Cutting it is how the message gets the contract without growing.
}

// ── WL-003 · the lines the ORCHESTRATOR is shown, where it decides ────────────────────────────
//
// R3, and it is a WORDING rule, not a reason to withhold anything: name what the week CONTAINED and
// let the orchestrator draw the conclusion. Never hand it a score. "orchestrator efficiency: 8.6%
// (below target)" is a number an agent can move without doing any of the work it stands for — the
// WL-001 failure class, aimed this time at the one reader who can act on it. So: no percentage of
// its own conduct, no target, no grade, no verdict word. Counts of things that happened.
//
// Kept to a handful of lines on purpose. An orchestrator handed a wall of figures skims it, and a
// skimmed audit is the panel behind the window all over again.

/** The audit, as trigger lines. Empty array when there is nothing worth interrupting for. */
export function orchestratorBriefing(w: WorkLedger, ownBlocks = false): string[] {
  const L: string[] = [];
  const a = w.allocation;
  // PRECISE ABOUT ITS OWN WINDOW. A scoped count reads ONE transcript — the session id currently in
  // board.json — so it covers this session, not the seven days in the header. A `/clear` starts a
  // new transcript and the count legitimately restarts; saying "this session" keeps that honest
  // instead of letting the header's window be read onto it.
  const scope = ownBlocks ? "you made this session" : "across this bus";

  if (w.blocksSinceProduct !== null && w.blocksSinceProduct > 0) {
    // WL-011 · SAYS WHAT IT COUNTS. The field is commits since a product path was last touched;
    // it has never been able to see a release, and the release line below is the one that can.
    L.push(`${w.blocksSinceProduct} block(s) since product code last changed` +
           (w.narrationRun > 0
             ? `; the last ${w.narrationRun} changed only docs and handoffs.` : "."));
  }
  if (!a.unmeasured && a.calls > 0) {
    // COUNTS, NOT A SHARE. "40 of 74" is a fact about the week; "54%" is a dial.
    L.push(`${a.bus} of the last ${a.calls} tool call(s) ${scope} went to bus mechanics — tabs, ` +
           `board and status writes, handoffs — against ${a.product} that touched product.`);
  } else if (a.unmeasured) {
    L.push(`Where the blocks went is ${UNMEASURED}: no transcript directory matches this repo ` +
           `under ${w.transcriptsRoot}.`);
  }
  // R5 · KEYED ON WHAT REACHED A USER, and it names which source answered, so the claim carries its
  // own basis. A line the reader can see is false costs the whole block its credibility.
  const r = w.release;
  if (r.source === "unmeasured") {
    // WL-010 · the SAME reason the tile gives. WL-007's lesson was that a rekeying is only done when
    // every reader is repointed, and it was learned on this exact field — so this one moves with it.
    L.push(`Whether anything has been released is ${UNMEASURED}: ` +
           (r.unmeasuredReason
             ? `${r.unmeasuredReason}${r.newestTag ? ` (newest tag ${r.newestTag})` : ""}.`
             : `no manifest and no deployed artifact under ${r.lookedIn.join(" or ")}.`));
  } else if (r.neverMoved) {
    L.push(`No release in ${r.blocksSince ?? "?"} block(s): ${r.product ? `${r.product} ` : ""}` +
           `${r.version} has never changed version.`);
  } else if (measurableDistance(r).blocksSince === null) {
    L.push(`Last reached a user at ${r.releasedVersion ?? UNMEASURED}` +
           `${r.releasedVersion ? ` (${r.source})` : ""}; how many blocks ago is ${UNMEASURED}` +
           // WL-011 · the reason, in the briefing too. A reader told only that something is
           // unmeasured cannot act; one told the release was cut on another branch can.
           `${r.anchorOffHistory ? " — it was cut on a branch this one never joined" : ""}` +
           // WL-011-R1 · both shapes of a tag reading carry the reason, not just the one that
           // still renders a number.
           `${r.unmeasuredReason ? `; ${r.unmeasuredReason}` : ""}.`);
  } else if ((measurableDistance(r).blocksSince as number) > 0) {
    // WL-011 · NAMES THE BASIS IT ACTUALLY HAS. This said "manifest bump" for every source that was
    // not `deployed`, so a TAG-sourced release — the answer livegita and Lumen get — was reported
    // under a basis it does not have, in the one reader the orchestrator reads before dispatching.
    // And a `deployed` reading now says whether the commit came from the artifact's own content or
    // from the version bump, because those are different strengths of evidence.
    const how = r.source === "deployed"
      ? (r.anchor === "content" ? "deployed artifact, anchored on its content"
                                : "deployed artifact, anchored on the version bump")
      : r.source === "tag" ? "git tag" : "manifest bump";
    L.push(`${measurableDistance(r).blocksSince} block(s) since ` +
           `${r.product ? `${r.product} ` : ""}${r.releasedVersion} reached a user (${how})` +
           // WL-012 · THE FOURTH READER GETS THE SAME QUALIFICATION. The commit distance here is
           // sound and stays, but an orchestrator told "228 block(s) since cairn-ios-v0.1.0" and
           // nothing else would reasonably read the magnitude as small. It is not small; it is
           // refused, and the briefing says so in the same breath as the number it kept.
           `${measurableDistance(r).netShrank !== null
              ? `; product has NET SHRUNK by ` +
                `${Math.abs(measurableDistance(r).netShrank as number)} line(s) since, so how much ` +
                `is unshipped is ${UNMEASURED}` : ""}` +
           // WL-011-R1 · and the doubt travels into the briefing too, for the same reason the
           // basis does: the orchestrator choosing the next block is owed both.
           `${r.unmeasuredReason ? `; ${r.unmeasuredReason}` : ""}.`);
  }
  if (w.handoffs > 0 && w.loopBackHandoffs > 0) {
    // PD-001 · "this window" is stated by the header this line sits under. Dropped, not lost.
    L.push(`${w.loopBackHandoffs} of ${w.handoffs} handoff(s) came back for another pass.`);
  }
  if (!L.length) return [];
  // PD-001 §2(b) · WHAT THESE NUMBERS ARE FOR, on the line they already had. The owner: "the
  // orchestrators never understood the real meaning of the ledger data… that serves as a reminder
  // for them if they ever get sidetracked." A REMINDER — not a gate, not a filter, not a thing to
  // recite upward. Both failures have happened here: an orchestrator that reads "40 of 74 went to
  // bus mechanics" as a threshold trims real work to move the number, and one that quotes the
  // figure to the owner has performed looking instead of looking. So the line says whose the
  // numbers are and what they decide, and names no target, no score and no verdict — folded into
  // the header rather than added beneath it, because a reminder against volume cannot cost a line.
  // (The wording dodges "score"/"grade"/"rating" deliberately: WL-003's own guard bans those words
  // from this text, and a purpose line that had to be exempted from the no-marks rule would be
  // arguing with it. It says what the figures are FOR, and names no mark to deny.)
  return [`[loom-ledger] ${w.repo}, last ${w.windowDays} days — yours, for choosing the next ` +
          `block; nothing here is a mark on you, and none of it is for repeating upward:`,
          ...L.map((x) => `  · ${x}`)];
}

/** The same thing as ONE block, ready to append to a message already being sent. Empty when the
 *  briefing is empty, so a caller can append unconditionally without emitting a stray header. */
export function briefingBlock(w: WorkLedger, ownBlocks = false): string {
  const lines = orchestratorBriefing(w, ownBlocks);
  return lines.length ? "\n\n" + lines.join("\n") : "";
}

export function todayKey(nowMs = Date.now()): string {
  return new Date(nowMs).toISOString().slice(0, 10);
}

// ── R3 · the report ───────────────────────────────────────────────────────────────────────────

export interface HandoffRow {
  id: string; role: string; model: string; loopBacks: number;
  wallMinutes: number | null; linesShipped: number | null;
}

/** Lines shipped by the commits that NAME a handoff id, per handoff. Second `git log` pass, on
 *  demand only (the report), never in a tick. A handoff no commit names gets null — not 0, because
 *  "no commit mentioned it" and "it shipped nothing" are different claims. */
export function handoffRows(repoPath: string | null, repo: string, sinceMs: number,
                            productPaths: Record<string, string[]> = DEFAULT_PRODUCT_PATHS,
                            loomRoot?: string, excludePaths?: string[]): HandoffRow[] {
  const led = readLedger(repo, sinceMs, loomRoot);
  const cls = classifierFor(repo, productPaths, excludePaths);
  const byId = new Map<string, number>();
  if (repoPath) {
    const out = git(repoPath, ["log", `--since=${new Date(sinceMs).toISOString()}`, "--numstat",
                               "--no-merges", "--format=%s"]);
    if (out !== null) {
      let subject = "";
      for (const raw of out.split("\n")) {
        if (raw.startsWith(SOH)) { subject = raw.slice(1); continue; }
        const m = /^(\d+|-)\t(\d+|-)\t(.*)$/.exec(raw);
        if (!m || !subject) continue;
        const file = renamedTo(m[3]);
        if (!cls.isProduct(file)) continue;
        const n = (m[1] === "-" ? 0 : Number(m[1])) + (m[2] === "-" ? 0 : Number(m[2]));
        for (const l of led) if (l.id && subject.includes(l.id)) {
          byId.set(l.id, (byId.get(l.id) || 0) + n);
        }
      }
    }
  }
  return led.map((l) => ({
    id: l.id, role: l.role, model: l.model, loopBacks: l.loopBacks, wallMinutes: l.wallMinutes,
    linesShipped: byId.has(l.id) ? byId.get(l.id)! : null,
  }));
}

/** The whole report, as markdown. A DOCUMENT rather than a webview: this extension has no webview
 *  anywhere, a markdown doc is copy-pasteable straight into a handoff, and it needs no CSP or asset
 *  plumbing to render a table. */
export function renderReport(entries: Array<{ w: WorkLedger; rows: HandoffRow[] }>,
                             t: Thresholds = DEFAULT_THRESHOLDS): string {
  const L: string[] = [
    "# Loom work ledger — what the agents actually produced",
    "",
    "Every figure below is computed from **git** and from `model-ledger.jsonl`.",
    "**Nothing here comes from what an agent wrote about itself** — not `status.json`'s `last_line`,",
    "not a test count a session reported, not “DEV-219 landed”. That was the failure this view",
    "was built to correct: by the agents' own account, a week in which 10.7 % of changed lines",
    "reached a user went excellently.",
    "",
  ];
  if (!entries.length) L.push("_No project bus has a work ledger yet._", "");
  for (const { w, rows } of entries) {
    L.push(`## ${w.repo}`, "");
    L.push(`${w.empty ? `**No git data:** ${w.emptyReason}. ` : ""}` +
           `Window ${w.windowDays} days · ${w.commits} commit(s) · computed ${w.computedAt}` +
           `${w.heuristic ? " · **product paths are a HEURISTIC, not configured**" : ""}`, "");
    L.push("| figure | value | measured from |", "|---|---|---|");
    for (const f of figuresFor(w, t)) {
      L.push(`| ${f.label} | ${f.band === "bad" ? `**${f.value}**` : f.value} | ` +
             `${f.detail.split("\n")[0]} |`);
    }
    L.push("");
    if (w.tokensSpent) {
      L.push("### Tokens, by model", "",
             "| model | input | output | cache read | cache write | total | list-price equiv |",
             "|---|---|---|---|---|---|---|");
      const prices = DEFAULT_MODEL_PRICES;
      for (const [id, k] of Object.entries(w.tokensByModel)
             .sort((a, b) => (b[1].input + b[1].output + b[1].cacheRead + b[1].cacheCreate) -
                             (a[1].input + a[1].output + a[1].cacheRead + a[1].cacheCreate))) {
        const n = k.input + k.output + k.cacheRead + k.cacheCreate;
        const p = priceFor(id, prices);
        const d = p ? (k.input * p[0] + k.output * p[1] + k.cacheRead * p[2] + k.cacheCreate * p[3]) / 1e6
                    : null;
        L.push(`| \`${id}\` | ${k.input.toLocaleString()} | ${k.output.toLocaleString()} | ` +
               `${k.cacheRead.toLocaleString()} | ${k.cacheCreate.toLocaleString()} | ` +
               `**${n.toLocaleString()}** | ${d === null ? "— (unpriced)" : fmtMoney(d)} |`);
      }
      L.push("",
        `**Cache reads are included and dominate.** They run ~100× the other classes; a total that ` +
        `omits them understates the week by two orders of magnitude.`,
        `**“List-price equivalent” is not a bill** — this work runs on a subscription. It is the ` +
        `resource figure.`, "");
      if (w.unpricedModels.length) {
        L.push(`> ⚠ ${w.unpricedTokens.toLocaleString()} token(s) belong to unpriced model id(s) ` +
               `(${w.unpricedModels.join(", ")}). They are counted as tokens but NOT as dollars, so ` +
               `the dollar figure is an undercount by that much.`, "");
      }
      L.push(`**Net product lines:** ` +
             `${w.netProductLines === null ? "unknown" :
                `${w.netProductLines >= 0 ? "+" : ""}${w.netProductLines}`} ` +
             `(two-point diff over the product paths — NET, not churn: a file rewritten 118 times ` +
             `has produced nothing if it ends the same size)` +
             `${w.newUserFacingFiles === null ? "" :
                ` · **${w.newUserFacingFiles} new user-facing file(s)**, which is what separates ` +
                `building from revising`}.`, "",
             `**${w.tokensPerProductLine === null ? "—" : w.tokensPerProductLine.toLocaleString()} ` +
             `tokens per net product line** · ` +
             `**${w.costPerProductLine === null ? "—" : fmtMoney(w.costPerProductLine)} per net ` +
             `product line** (list-price equivalent).`, "");
    }
    if (w.tokensSpent === null) {
      L.push(`> ⚠ **Tokens, cost and $/line are ${UNMEASURED} for this repo.** No directory under ` +
             `\`${w.transcriptsRoot}\` matches \`${w.repo}\`, so no transcript was read. The ` +
             `figures are absent, NOT zero — a repo this panel cannot see would otherwise report ` +
             `the cheapest week it can print, under every alarm threshold.`, "");
    }
    if (w.topChurn.length) {
      L.push("### Most-touched files in the window", "", "| file | touches | net lines |", "|---|---|---|");
      for (const c of w.topChurn) L.push(`| \`${c.file}\` | ${c.touches} | ${c.net >= 0 ? "+" : ""}${c.net} |`);
      L.push("");
    }
    if (rows.length) {
      L.push("### Handoffs in the window", "",
             "| id | role | model | loop-backs | wall (min) | product lines in commits naming it |",
             "|---|---|---|---|---|---|");
      for (const r of rows) {
        L.push(`| ${r.id} | ${r.role} | ${r.model} | ${r.loopBacks} | ` +
               // WL-005 · A NULL AND A SUPPRESSED VALUE ARE DIFFERENT FACTS. `—` for both meant a
               // block whose duration was never measured looked exactly like one whose duration was
               // nonsense, and the nonsense (2455 minutes from a stale `started`, -39.3 on ReciEats)
               // was hidden at render time while the same poisoned field fed the median. A negative
               // is now impossible from the recorded pair, so if one ever appears it is a fact about
               // the bus and is SHOWN rather than blanked.
               `${r.wallMinutes === null ? UNMEASURED : r.wallMinutes} | ` +
               `${r.linesShipped === null ? "— (no commit names it)" : r.linesShipped} |`);
      }
      L.push("");
    } else {
      L.push("_No handoffs recorded in `model-ledger.jsonl` for this window._", "");
    }
  }
  L.push("---", "",
         "`—` means **not measured**, never zero: a handoff no commit names shows `—` rather than 0",
         "lines, because “no commit mentioned it” and “it shipped nothing” are different claims.",
         "",
         "A duration reads `" + UNMEASURED + "` when the block's start was never observed — every block",
         "opened before 0.38.2 — and is otherwise bounded by that block's own observed start and end.",
         "**A NEGATIVE duration is shown, not blanked.** Until 0.38.2 `started` was read from the",
         "worker's `status.updated_at`, which at the moment a block opened still held the stamp of the",
         "block BEFORE it, so durations spanned other blocks (2455 minutes for a ~90-minute block) and",
         "could invert (-39.3). Blanking those said “not measured”, which was false — they were",
         "measured, wrongly — and it hid the defect at render time while the same field fed the median.");
  return L.join("\n");
}
