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
}
export const DEFAULT_THRESHOLDS: Thresholds = {
  shipsGood: 40, shipsBad: 20,
  loopBackGood: 20, loopBackBad: 50,
  narrationGood: 10, narrationBad: 25,
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
   *  reached a user; `null` when there is no commit in the window to say. THE TRIGGER FIGURE: it
   *  names what to do next, where a percentage only invites being optimised. */
  blocksSinceProduct: number | null;
  /** How many of the newest commits, in an unbroken run, changed ONLY docs and handoffs. */
  narrationRun: number;
  /** Where this repo's sessions spent their tool calls in the window. */
  allocation: BlockAllocation;
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
  let net = 0;
  for (const raw of out.split("\n")) {
    const m = /^(\d+|-)\t(\d+|-)\t(.*)$/.exec(raw);
    if (!m) continue;
    const file = renamedTo(m[3]);
    if (!cls.isProduct(file)) continue;
    if (m[1] === "-" || m[2] === "-") continue;                 // binary: no line count exists
    net += Number(m[1]) - Number(m[2]);
  }
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
}

/** R6's half of the compute, split out so the token figures can be tested without a git repo —
 *  and so `computeWorkLedger`'s two empty-result paths cannot silently skip them. */
function tokenFigures(repo: string, repoPath: string | null, sinceMs: number, cls: Classifier,
                      opts: ComputeOpts):
    Pick<WorkLedger, "tokensSpent" | "tokensByModel" | "costEquivalent" | "unpricedTokens" |
                     "unpricedModels" | "netProductLines" | "newUserFacingFiles" |
                     "tokensPerProductLine" | "costPerProductLine" | "transcriptFiles" |
                     "transcriptDirs" | "transcriptsRoot" | "allocation"> {
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
  // facts a dispatching orchestrator can act on: how long since anything reached a user, and how
  // much of the recent past was only talk about the work.
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
export function figuresFor(w: WorkLedger, t: Thresholds = DEFAULT_THRESHOLDS): Figure[] {
  const win = `window ${w.windowDays}d · computed ${w.computedAt}`;
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
      value: w.tag === null
        ? `never released — ${w.commits} commit(s) this window`
        : `${w.blocksSinceRelease ?? "?"} commit(s) since ${w.tag}` +
          `${w.daysSinceRelease === null ? "" : `, ${w.daysSinceRelease}d ago`}`,
      // NEVER RELEASED IS A WARNING, NOT A BLANK. This is ReciEats' answer (0 tags, 221 blocks) and
      // rendering it as an empty cell is how it stayed invisible for a week.
      band: w.tag === null ? "bad" : "unknown",
      detail: w.tag === null
        ? `This repo has NO tag. Nothing measured here has ever been cut as a release.\n${win}`
        : `Newest tag ${w.tag}.\n${win}` },
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
    w.tag === null ? `no release in ${w.commits} blocks` : `${w.blocksSinceRelease ?? "?"} since ${w.tag}`,
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
  if (!shipsBad && !costBad && !nothingShipped && !unmeasured) return null;
  const today = new Date(nowMs).toISOString().slice(0, 10);
  if (notifiedOn === today) return null;
  return `[loom-ledger] ${w.repo}: ` +
         `${w.shipsToUser === null ? "?" : w.shipsToUser}% of this week's changed lines reach a user; ` +
         `${w.narrationShare === null ? "?" : w.narrationShare}% of commits only update the guide; ` +
         `${w.tag === null ? `no release in ${w.commits} blocks` :
            `${w.blocksSinceRelease ?? "?"} blocks since ${w.tag}`}. ` +
         `${unmeasured ? `Tokens and cost are ${UNMEASURED} — no transcript directory under ` +
              `${w.transcriptsRoot} matches this repo, so its spend is invisible here. This is NOT ` +
              `a cheap week; it is an unwatched one. It` :
            `${fmtTokens(w.tokensSpent as number)} tokens (${w.costEquivalent === null ? UNMEASURED :
               fmtMoney(w.costEquivalent)} list-price equivalent, not a bill)`} produced ` +
         `${nothingShipped ? "NO net product lines" :
            `${w.netProductLines === null ? "?" : `${w.netProductLines >= 0 ? "+" : ""}${w.netProductLines}`} ` +
            `net product line(s)` +
            `${w.costPerProductLine === null ? "" : ` at ${fmtMoney(w.costPerProductLine)}/line`}`}` +
         `${w.newUserFacingFiles === null ? "" : `, ${w.newUserFacingFiles} new user-facing file(s)`}. ` +
         `Consider whether the next block ships something.`;
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
  const scope = ownBlocks ? "you made" : "across this bus";

  if (w.blocksSinceProduct !== null && w.blocksSinceProduct > 0) {
    L.push(`${w.blocksSinceProduct} block(s) since anything reached a user` +
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
  if (w.tag === null && w.commits > 0) {
    L.push(`No release in ${w.commits} blocks.`);
  } else if (w.blocksSinceRelease !== null && w.blocksSinceRelease > 0) {
    L.push(`${w.blocksSinceRelease} blocks since ${w.tag}.`);
  }
  if (w.handoffs > 0 && w.loopBackHandoffs > 0) {
    L.push(`${w.loopBackHandoffs} of ${w.handoffs} handoff(s) this window came back for another ` +
           `pass.`);
  }
  if (!L.length) return [];
  return [`[loom-ledger] ${w.repo}, last ${w.windowDays} days:`, ...L.map((x) => `  · ${x}`)];
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
               `${r.wallMinutes === null || r.wallMinutes <= 0 ? "—" : r.wallMinutes} | ` +
               `${r.linesShipped === null ? "— (no commit names it)" : r.linesShipped} |`);
      }
      L.push("");
    } else {
      L.push("_No handoffs recorded in `model-ledger.jsonl` for this window._", "");
    }
  }
  L.push("---", "",
         "`—` means **not measured**, never zero. A non-positive wall time is dropped rather than",
         "shown as 0 (the `started` stamp bug), and a handoff no commit names shows `—` rather than 0",
         "lines: “no commit mentioned it” and “it shipped nothing” are different claims.");
  return L.join("\n");
}
