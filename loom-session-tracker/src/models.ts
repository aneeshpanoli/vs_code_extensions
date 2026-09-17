// models.ts — ONE JOB: every session on the tier its work actually needs.
//
// WHY: every session draws on ONE shared usage pool, and the premium tier costs ~2x the Opus tier
// per token ($10/$50 vs $5/$25 per MTok). Workers doing mechanical handoff work do not need it; the
// orchestrator, which reasons over the whole board, may.
//
// TWO RULES, AND THEY STACK. The FLOOR: the premium tier is the orchestrator's alone, and no
// handoff, setting or worker may cross it. Above it the ORCHESTRATOR picks per handoff (MP-001,
// owner 2026-09-13) between Opus 5 and Sonnet 5 by writing `model:` into the handoff's frontmatter;
// this file enforces that choice in BOTH directions, escalates a worker that loops back twice, and
// appends a ledger line so the rubric can be judged in a month.
//
// A SESSION'S MODEL IS READ off the footer run `model [· effort] · permission-chip` (measured live
// 2026-09-08), anchored on the permission chip and taking the LAST match, so a conversation that
// merely mentions a model name cannot be mistaken for the footer. THE CHIP LAGS THE SWITCH
// (measured 2026-09-13): it can still read the old model a minute after "Set model to <name>", and
// only flips at the session's next turn — so an acknowledged switch with no later turn is left
// alone until the chip catches up. Correction is `/model <id>` injected into the session, the same
// way `/loom <role>` binds one; a role stays pending until SEEN on a cheaper model, retried on a
// growing backoff, because a switch can report success and not take effect.
//
// THE ORCHESTRATOR IS NEVER SWITCHED — BY ANY PATH, IN EITHER DIRECTION (owner, 2026-09-16). This
// REVERSES two earlier directions this file used to cite; they are gone rather than disabled, and
// nothing here is rationale for bringing either back. A `<repo>/orchestrator-model.json` left on
// any bus is inert by code: no function in this file reads that path.
//
// EVERYTHING ELSE IS ABOUT WORKERS: a worker runs the tier its handoff asks for, in both
// directions; a worker on the orchestrator's own tier is switched down (the premium FLOOR); a
// handoff asking for a premium id is refused with a note; a handoff with no `model:` line is noted
// once (MS-001 R1). The orchestrator appears here only as three exemptions in `check()` and the
// refusal in `enforce()`, the single chokepoint every `/model` injection passes through.

import * as fs from "fs";
import * as os from "os";
import * as path from "path";

import { isOwnerRole } from "./naming";
import { getOrchestrator } from "./orchestrator";
import { senderArgs, injectVerdict } from "./inject";
import { execFile } from "child_process";

const LOOM_ROOT = path.join(os.homedir(), ".claude", "loom");
const LOOM_CDP = path.join(LOOM_ROOT, "loom_cdp.py");
const INJECT_TIMEOUT_MS = 60_000;

/** Only the footer region can hold the model chip. */
export const FOOTER_CHARS = 400;

/** The top pricing tier ($10/$50 per MTok) — reserved for the orchestrator. */
export const DEFAULT_PREMIUM = ["Fable 5.1", "Fable 5", "Mythos 5.1", "Mythos 5"];

const MODEL_NAMES = "Fable 5\\.1|Fable 5|Mythos 5\\.1|Mythos 5|Opus 5|Opus 4\\.8|Opus 4\\.7|Opus 4\\.6|Sonnet 5|Sonnet 4\\.6|Haiku 4\\.5";
const EFFORTS = "Low|Medium|High|XHigh|Max";
const PERMISSION_CHIP = "Bypass permissions|Accept edits|Plan mode|Ask each time";
// model [· effort] · permission-chip, as rendered at the bottom of a live panel.
const FOOTER_RE = new RegExp(
  `\\b(${MODEL_NAMES})\\s*[\\n·|]\\s*(?:(${EFFORTS})\\s*[\\n·|]\\s*)?(?:${PERMISSION_CHIP})`, "gi");

export interface ModelInfo { model: string; effort: string | null;
  /** A `/model` switch the session has ACKNOWLEDGED since its last turn ("Set model to <name>"),
   *  which the footer chip has not caught up with yet. null when there is no fresh acknowledgement. */
  acknowledged?: string | null; }

/** The model a live panel is currently running, read off its footer. null if not determinable. */
export function detectModel(text: string | null | undefined): ModelInfo | null {
  const tail = String(text || "").slice(-FOOTER_CHARS);
  if (!tail) return null;
  FOOTER_RE.lastIndex = 0;
  let m: RegExpExecArray | null, last: RegExpExecArray | null = null;
  while ((m = FOOTER_RE.exec(tail)) !== null) last = m;   // the LAST match is the footer
  if (!last) return null;
  const ack = acknowledgedSwitch(text);
  return ack ? { model: last[1], effort: last[2] || null, acknowledged: ack } : { model: last[1], effort: last[2] || null };
}

/** As the panel renders a switch: the echo of the typed command, then the CLI's result line. */
const SWITCH_ACK_RE = new RegExp(`Set model to (${MODEL_NAMES})\\b`, "i");

/** The model a panel's LAST `/model` command switched to, when nothing has happened since: the
 *  final `You: /model …` echo is followed by "Set model to <name>" and by no later `You:` turn. A
 *  switch that old lines quote (a resumed session, a conversation about switching) is not fresh
 *  and yields null — after a restart the chip is the truth again. */
export function acknowledgedSwitch(text: string | null | undefined): string | null {
  const t = String(text || "");
  const at = t.lastIndexOf("You: /model");
  if (at < 0) return null;
  const after = t.slice(at + "You: /model".length);
  const m = SWITCH_ACK_RE.exec(after);
  if (!m) return null;
  // the result line must belong to THIS echo (no turn between), and nothing may follow it
  const before = after.slice(0, m.index), since = after.slice(m.index + m[0].length);
  if (before.includes("You:") || since.includes("You:")) return null;
  return m[1];
}

export function isPremium(model: string | null | undefined, premium: string[] = DEFAULT_PREMIUM): boolean {
  if (!model) return false;
  return premium.some((p) => p.toLowerCase() === model.toLowerCase());
}

// ── the chip ↔ id table (MP-001) ────────────────────────────────────────────────────────────────
// Two vocabularies meet here and neither is convertible by rule: the footer chip a panel RENDERS
// ("Sonnet 5") and the id `/model` TAKES (`claude-sonnet-5`) — lowercasing and hyphenating would
// silently produce `claude-fable-5.1` for "Fable 5.1" and switch nothing. So the mapping is stated
// ONCE, here. `isPremium` answers for CHIPS (that is what `premiumModels`, a real VS Code setting,
// holds); `idIsPremium` is its counterpart for ids, and it is the one that guards a handoff's
// request.
export const MODEL_TABLE: ReadonlyArray<{ id: string; chip: string; premium: boolean }> = [
  { id: "claude-fable-5-1",  chip: "Fable 5.1",  premium: true },
  { id: "claude-fable-5",    chip: "Fable 5",    premium: true },
  { id: "claude-mythos-5-1", chip: "Mythos 5.1", premium: true },
  { id: "claude-mythos-5",   chip: "Mythos 5",   premium: true },
  { id: "claude-opus-5",     chip: "Opus 5",     premium: false },
  { id: "claude-opus-4-8",   chip: "Opus 4.8",   premium: false },
  { id: "claude-opus-4-7",   chip: "Opus 4.7",   premium: false },
  { id: "claude-opus-4-6",   chip: "Opus 4.6",   premium: false },
  { id: "claude-sonnet-5",   chip: "Sonnet 5",   premium: false },
  { id: "claude-sonnet-4-6", chip: "Sonnet 4.6", premium: false },
  { id: "claude-haiku-4-5",  chip: "Haiku 4.5",  premium: false },
];

/** An id as the table holds it: lower-cased, and without the `[1m]` context-window suffix that
 *  `claude-fable-5-1[1m]` carries (the suffix selects a context window, not a model). */
export function normalizeId(id: string | null | undefined): string {
  return String(id || "").trim().toLowerCase().replace(/\[[^\]]*\]\s*$/, "").trim();
}

/** The footer chip a model id renders as, or null when the id is not one we know. */
export function chipFor(id: string | null | undefined): string | null {
  const n = normalizeId(id);
  const row = MODEL_TABLE.find((m) => m.id === n);
  return row ? row.chip : null;
}

/** Is this model ID the orchestrator-only tier? Unknown ids are NOT premium — they are rejected by
 *  the allowlist instead, which is the check that gives a reason. */
export function idIsPremium(id: string | null | undefined): boolean {
  const n = normalizeId(id);
  const row = MODEL_TABLE.find((m) => m.id === n);
  return row ? row.premium : false;
}

/** The tiers a WORKER may be put on. Haiku is deliberately absent (owner, 2026-09-13). */
export const DEFAULT_WORKER_MODELS = ["claude-opus-5", "claude-sonnet-5"];

// ── the handoff chooses the tier (MP-001, owner 2026-09-13) ─────────────────────────────────────
// Workers do not all need the Opus tier. The ORCHESTRATOR judges difficulty as it writes a handoff
// and records the choice in that handoff's frontmatter (`model: claude-sonnet-5`); the tracker
// enforces it; the ledger judges the rubric a month later. This is a rule about WORKERS: the
// orchestrator's own tier is never switched by any path (see the header). A `model:` line is a
// worker's tier, and there is no longer any other kind.
//
// A frontmatter the tracker cannot read changes NOTHING: no file, no block, no `model:` line, a
// malformed block, a premium id, an unknown id — every one falls back to the configured
// `workerModel`. This is principle 16 pointed the other way: a read that cannot answer must not be
// read as licence. The two that are a REQUEST rather than an absence say so in tracker-debug.json,
// and since MS-001 R1 the plain ABSENCE is said too, once per handoff (`noteDefaulted`).

/** The `---` block at the very top of a handoff, as key → value. A `---` further down a document is
 *  a horizontal rule, not frontmatter, so the block must OPEN the file. */
export function frontmatter(text: string | null | undefined): Record<string, string> {
  const m = /^\uFEFF?[ \t]*---[ \t]*\r?\n([\s\S]*?)\r?\n[ \t]*---[ \t]*(?:\r?\n|$)/.exec(String(text || ""));
  if (!m) return {};
  const out: Record<string, string> = {};
  for (const line of m[1].split(/\r?\n/)) {
    const kv = /^[ \t]*([A-Za-z0-9_-]+)[ \t]*:[ \t]*(.*)$/.exec(line);
    if (!kv) continue;
    let v = kv[2].replace(/\s+#.*$/, "").trim();
    if (v.length > 1 && ((v[0] === '"' && v.endsWith('"')) || (v[0] === "'" && v.endsWith("'")))) v = v.slice(1, -1).trim();
    out[kv[1].toLowerCase()] = v;
  }
  return out;
}

/**
 * The `files:` line of that same block: the path patterns a handoff DECLARES it will touch (CH-001,
 * playbook §19 "one handoff is one merge" — two live handoffs on one bus must not touch the same
 * files). Parsed beside `frontmatter()` and not inside it, whose `Record<string, string>` return
 * type every caller relies on.
 *
 * Tolerant on purpose, because a human and an orchestrator both write this line: comma- OR
 * space-separated, quotes and stray whitespace dropped, `./` and trailing slashes normalised,
 * duplicates collapsed, order kept.
 *
 * AN ABSENT LINE IS AN EMPTY LIST AND NOT A CLAIM ABOUT ANYTHING (principle 16, as for MP-001's
 * `model:`): silence is not licence to refuse, and every refusal below needs a `files:` line on
 * BOTH sides.
 *
 * BOTH YAML SPELLINGS ARE READ (OV-001) — `files: src/a.ts, src/b.ts` and the indented `- item`
 * list under a bare `files:`. CH-001 shipped only the one-line form, and because this bus writes
 * the list form the guard had — measured on the real bus with the compiled build — NEVER REFUSED
 * ANYTHING HERE. The one-line form is unchanged by construction: the list is only looked for when
 * the key's own value is EMPTY; pleodo, hackomics and tfg_ua depend on that and it must not move.
 * Both spellings converge on ONE splitting loop below, so no second set of quoting, comma, glob or
 * duplicate rules can drift.
 *
 * Doubt still declares NOTHING: collection stops at the first line under `files:` that is not a
 * `- item`, so a malformed block yields what it could read and no guess about the rest.
 */
export function declaredFiles(text: string | null | undefined): string[] {
  let raw = frontmatter(text)["files"];
  if (!raw) raw = listUnderKey(text, "files");   // empty inline value -> the `- item` form, if there is one
  if (!raw) return [];
  const out: string[] = [];
  for (const piece of stripSpacedAnnotations(raw).split(/[,\s]+/)) {
    const p = normalizeDeclaredPath(piece);
    if (p && !out.includes(p)) out.push(p);
  }
  return out;
}

// ── the SPACED annotation (OV-001-R2 §3) ────────────────────────────────────────────────────────
//
// The splitting loop runs BEFORE `normalizeDeclaredPath`, so `(new file)` arrives as `(new` and
// `file)` — two fragments, neither wholly bracketed, both read as paths. Two handoffs annotating
// that way REFUSED EACH OTHER on `(new`, the expensive direction (§3). R1 pinned it as a limit.
//
// THE FIX IS A PRE-PASS, NOT A NEW SPLITTER, and that is the whole of why it is safe: one regex
// removes annotation RUNS from the raw line before the existing loop, leaving the loop, the
// normaliser, quoting, globs and duplicate collapsing untouched. The predicate inside the brackets
// EXTENDS `normalizeDeclaredPath`'s — no slash, no dot, no nested bracket — plus two exclusions a
// refutation pass found, because the brackets bound where a run starts and ends but not how LONG it
// is, and every token in between disappears with it:
//  - NO COMMA: `Makefile`, `LICENSE`, `Dockerfile` are dot- and slash-free, so `(new Makefile file)`
//    swallowed a genuinely declared file and left an ABSENCE — no refusal, and no waiver note
//    either, because nothing was exempted. Excluding the comma, plus `listUnderKey` joining its
//    items with one, confines a run to a single declared item.
//  - NO `*`: overlap.ts states a `*` is NEVER exempted away, and `(new * file)` erased one. This
//    function runs first, so a claim deleted here cannot be refused by anything downstream.
//
// IT ONLY FIRES ON A WHOLE-TOKEN RUN — the `(` must start a token and the `)` must END one — which
// is what keeps this a narrowing and not a rewrite: `src/a.ts (new file)` drops the run and the
// path survives, while `src/a (b).ts` and `src/a.ts(NEW)` are untouched and still refuse. The
// replacement keeps the captured delimiter and adds a space: belt-and-braces against a future edit
// to the boundary, not a fix for a reachable case, so no mutant is written for it: no test could
// kill one.
//
// STILL READ AS PATHS, AND STILL ABLE TO REFUSE — enumerated in full because the first draft named
// ONE shape and a refutation pass immediately found four more: an annotation containing a `/` or
// a `.` (`(see docs/spec.md)`), a comma or a `*`, one NESTED or UNBALANCED (`((new))`, a lone `(new`), or
// one in square/curly brackets (`[NEW]`, `{NEW}` — not attested in any `files:` line on this
// machine, and every spelling admitted here is a filename someone can no longer declare). The first
// two are the principled ones: the inner text is the ONLY thing distinguishing `(NEW)` from a
// bracketed REAL PATH `(src/shared.ts)`, and dropping one of those loses a guard in SILENCE, so the
// expensive direction is chosen knowingly.
//
// The residual ambiguity, stated rather than hidden: a dot-free REAL path inside a bracket run on a
// single comma-free line — `files: (new Makefile file)` — is still swallowed; it is now the only
// such shape (the list form is confined item-by-item), the old code turned that line into three junk
// paths, so nothing regressed, and the writer's remedy is a comma.
//
// A NARROWING CAN ONLY REMOVE REFUSALS: every token removed was one `normalizeDeclaredPath` would
// have kept only because it had been split in half. Fewer paths on either side of `firstShared` can
// never produce a collision that was not already there. The §19 size ledger moves with it deliberately
// — `filesDeclared` counts what `handoffFiles` returns, so one path annotated `(new file)` ledgers
// 1 rather than 3: "is this a file at all" belongs in the count.
const SPACED_ANNOTATION = /(^|[,\s])\([^()/.,*]*\)(?=[,\s]|$)/g;

/** The raw `files:` line with whole-token `( ... )` annotations replaced by a space — see above. The
 *  bracket must open and close a token and the inside must be annotation-shaped (no `/`, no `.`, no
 *  nested bracket), so this can only ever remove tokens, never re-spell a path. */
function stripSpacedAnnotations(raw: string): string {
  return raw.replace(SPACED_ANNOTATION, "$1 ");
}

/**
 * The `- item` lines directly under `key:` in the SAME frontmatter block, joined into the one-line
 * spelling so `declaredFiles` has a single splitting loop for both forms. `""` when the key is
 * absent, carries its own value, or has no list under it. Only the frontmatter block is searched
 * (the regex is `frontmatter()`'s own), and collection STOPS at the first line that is not an
 * `- item`, which keeps the next key (`version:`, `---`) from being swallowed.
 */
function listUnderKey(text: string | null | undefined, key: string): string {
  const m = /^\uFEFF?[ \t]*---[ \t]*\r?\n([\s\S]*?)\r?\n[ \t]*---[ \t]*(?:\r?\n|$)/.exec(String(text || ""));
  if (!m) return "";
  const lines = m[1].split(/\r?\n/);
  const at = lines.findIndex((l) => {
    const kv = /^[ \t]*([A-Za-z0-9_-]+)[ \t]*:[ \t]*(.*)$/.exec(l);
    return !!kv && kv[1].toLowerCase() === key && !kv[2].replace(/\s+#.*$/, "").trim();
  });
  if (at < 0) return "";
  const items: string[] = [];
  for (let i = at + 1; i < lines.length; i++) {
    const it = /^[ \t]*-[ \t]+(.*)$/.exec(lines[i]);
    if (!it) break;                                    // the list ended; never read past it
    const v = it[1].replace(/\s+#.*$/, "").trim();
    if (v) items.push(v);
  }
  // JOINED WITH A COMMA, NOT A SPACE (OV-001-R2, found by the refutation pass). The splitting loop
  // splits on `[,\s]+` so both are the one-line spelling to it, but the annotation pre-pass cannot
  // cross a comma and with a SPACE join it could: `- (new` / `- Makefile` / `- file)` matched as one
  // run and the real `Makefile` item vanished. One list item's brackets must never reach another's.
  return items.join(",");
}

// ── what is not a path at all (OV-001-R1 §1(2)) ─────────────────────────────────────────────────
//
// TWO LIVE tfg_ua DECLARATIONS WERE BEING READ AS FILENAMES, both producing the expensive failure
// (§3), a REFUSAL on a word: `files: none` — how a standby role on that bus says it touches nothing
// — parsed as a path named `none` and its two standby roles refused each other; and a
// hand-annotated `tools/cardmaker/** (NEW), docs/social/card-design.md (NEW)` parsed its annotation
// as a third path, so any second annotated handoff on that bus was refused on a parenthetical.
//
// ALLOWED WHERE A FORMAT CHANGE IS NOT (OV-001 decision (a) forbids changing what a valid
// single-line list MEANS) because neither changes the reading of any path: they narrow what counts
// as a path at all, and fewer paths can only ever REMOVE refusals — the safe direction for a guard.
//
// A token is dropped only when the WHOLE declaration is one:
//  - a SENTINEL — `none`, `n/a` or `-`, case-insensitively, and nothing else. Not `nil`, `todo`,
//    `tbd` or `null`: not written on any bus measured today, and every word added here is a
//    filename someone can no longer declare.
//  - a PARENTHESISED annotation — `(NEW)`, `(rewrite)`: `(` to `)` around the entire token AND a
//    plain word inside it. Deliberately not brackets generally: `[...]` and `{...}` are not
//    attested in any `files:` line on this machine.
//
// THE INSIDE OF THE BRACKET IS TESTED TOO because `^\(.*\)$` also eats `(src/shared.ts)`, a REAL
// path someone bracketed — the one narrowing case that loses a guard SILENTLY: no refusal and no
// exemption note, because nothing was exempted (a refutation pass found it). So `(NEW)` is dropped
// while `(src/shared.ts)`, `(draft.md)` and `(a)(b)` are kept and refuse as paths. The SPACED form
// is handled one function up by `stripSpacedAnnotations`, using this predicate.
//
// THE COST: a file genuinely NAMED `none`, `n/a` or `(NEW)` can no longer be declared and the guard
// would go quiet on it; nothing named that exists in any repo here, and the remedy is a path with a
// directory in it. NORMALISATION RUNS FIRST, so `./none` and `none/` are sentinels too, and a path
// that merely CONTAINS one is untouched (`src/none-handler.ts`, `docs/(draft)-spec.md` refuse).
//
// AND IT SHRINKS THE §19 SIZE LEDGER, deliberately — a block declaring `files: none` now ledgers 0
// files. The OPPOSITE call from overlap.ts's exemption,
// which is kept out of this function precisely so it cannot move that number: "is this a file at
// all" belongs in the count, "is this file's merge mechanical" does not.
const PATH_SENTINELS = new Set(["none", "n/a", "-"]);

/** One declared path, in the one spelling the collision test compares. A sentinel or a bracketed
 *  annotation is an ABSENCE and normalises to `""` — see above; `""` collides with nothing and is
 *  dropped by `declaredFiles`, so it never becomes a file in any count either. */
export function normalizeDeclaredPath(p: string | null | undefined): string {
  let s = String(p || "").trim();
  s = s.replace(/^["']+/, "").replace(/["']+$/, "").trim();
  s = s.replace(/\\/g, "/").replace(/\/{2,}/g, "/").replace(/^(?:\.\/)+/, "").replace(/\/+$/, "");
  if (PATH_SENTINELS.has(s.toLowerCase())) return "";       // a word meaning "no files", not a file
  if (/^\([^()/.]*\)$/.test(s)) return "";                  // `(NEW)` — an annotation, not a path
  return s;
}

function inboxFile(repo: string, role: string): string {
  return path.join(LOOM_ROOT, repo, role, "inbox.md");
}

/** The `files:` a role's CURRENT inbox declares. Unreadable or absent -> empty, never a guess. */
export function handoffFiles(repo: string | null, role: string): string[] {
  if (!repo) return [];
  try { return declaredFiles(fs.readFileSync(inboxFile(repo, role), "utf8")); }
  catch { return []; }
}

/** An ORCHESTRATOR'S REPLY, not a handoff: `-ack` (case-insensitive, tolerant of trailing
 *  whitespace) is the suffix the PO appends to a handoff's own id when it writes its ack into the
 *  SAME inbox.md (FX-001 R1). Everything downstream keys off `handoffId()`, so this is the one
 *  point that decides — a ledger line, an escalation record and `model:` enforcement all read an
 *  ack as a block nobody will ever work. */
function isAckId(id: string | null | undefined): boolean {
  return /-ack\s*$/i.test(String(id ?? ""));
}

/** The `id:` of the handoff currently sitting in a role's inbox, or null. An id ending `-ack` is an
 *  ack, not a handoff (FX-001 R1) — see `isAckId`. */
export function handoffId(repo: string | null, role: string): string | null {
  if (!repo) return null;
  try {
    const id = frontmatter(fs.readFileSync(inboxFile(repo, role), "utf8"))["id"] || null;
    return isAckId(id) ? null : id;
  } catch { return null; }
}

/** A role's status.json, or null when it is absent or unreadable. */
function readStatus(repo: string, role: string): any | null {
  try {
    const d = JSON.parse(fs.readFileSync(path.join(LOOM_ROOT, repo, role, "status.json"), "utf8"));
    return d && typeof d === "object" ? d : null;
  } catch { return null; }
}

/** A number, or null. `null`, `undefined` and `""` are ABSENCES and must come back null — `Number()`
 *  maps all three to 0, which in a ledger line is a measured value, not a missing one, and a 0 %
 *  context or 0 tests would be read as fact. (The same hole was open under `testsBefore`.) */
function numOrNull(v: any): number | null {
  if (v === null || v === undefined || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

/** Wall-clock minutes between two timestamps, or null when either will not parse (CH-001 R3).
 *  NEVER a guess: the ledger's own test fixtures use "T1"/"T9" as stamps. A NEGATIVE result is
 *  returned as measured — a clock that went backwards is a fact about the bus, not one to hide. */
function wallMinutes(started: any, finished: any): number | null {
  const a = Date.parse(String(started || "")), b = Date.parse(String(finished || ""));
  if (!Number.isFinite(a) || !Number.isFinite(b)) return null;
  return Math.round(((b - a) / 60_000) * 10) / 10;
}

/**
 * Rewrite ONLY the `model:` line of a role's inbox frontmatter, and only while the file still
 * carries `expectId`. tmp+rename, so a half-written inbox is never what a `/loom` bind reads.
 *
 * THE ID RE-CHECK IS THE LAYER THAT DECIDES THE RACE. `escalate`'s id keying already refuses an
 * inbox replaced BEFORE the decision — the new id simply has no loop-backs yet; only this re-check
 * refuses one replaced BETWEEN the decision and the write, a real window because playbook §12
 * step 2 has the orchestrator overwrite `inbox.md` with the next brief as its first move after
 * banking, and a tick can land inside it. Raising the tier of a brief the orchestrator deliberately
 * judged, because of the PREVIOUS brief's loop-backs, is worse than never escalating at all.
 *
 * Exported for exactly that reason: the guard is unreachable through `escalate`, so a test driving
 * escalate can only pass for the wrong reason and a mutant on this line survived one. It is pinned
 * directly instead — principle 17.
 */
export function rewriteHandoffModel(repo: string, role: string, expectId: string, to: string): boolean {
  try {
    const f = inboxFile(repo, role);
    const text = fs.readFileSync(f, "utf8");
    if (frontmatter(text)["id"] !== expectId) return false;            // a different handoff now
    const block = /^(\uFEFF?[ \t]*---[ \t]*\r?\n)([\s\S]*?)(\r?\n[ \t]*---[ \t]*(?:\r?\n|$))/.exec(text);
    if (!block) return false;
    if (!/^[ \t]*model[ \t]*:/m.test(block[2])) return false;          // no line to rewrite
    const body = block[2].replace(/^([ \t]*model[ \t]*):[ \t]*.*$/m, `$1: ${to}`);
    const next = block[1] + body + block[3] + text.slice(block[0].length);
    const tmp = f + ".tmp." + process.pid;
    fs.writeFileSync(tmp, next);
    fs.renameSync(tmp, f);
    return true;
  } catch { return false; }
}

export interface Desired {
  model: string;
  chosenBy: "frontmatter" | "default" | "escalated";
  /** Set only when the handoff ASKED for something and was refused — a line for tracker-debug.json.
   *  An absent frontmatter is not a refusal and carries no note. */
  note: string | null;
}

/** The model `<repo>/<role>` should be running, per its CURRENT handoff. Pure and fs-only: it reads
 *  `inbox.md` and nothing else, and never writes. */
export function desiredModel(repo: string | null, role: string, fallback = "claude-opus-5",
                             allow: string[] = DEFAULT_WORKER_MODELS): Desired {
  const def: Desired = { model: fallback, chosenBy: "default", note: null };
  if (!repo || !role) return def;
  let text: string;
  try { text = fs.readFileSync(path.join(LOOM_ROOT, repo, role, "inbox.md"), "utf8"); }
  catch { return def; }                                     // no inbox yet, or unreadable -> default
  const fm = frontmatter(text);
  if (isAckId(fm["id"])) return def;      // an ack, not a handoff (FX-001 R1) — no model: enforcement
  const raw = fm["model"];
  if (!raw) return def;                                     // no block, or a block without a model
  const id = normalizeId(raw);
  if (!id) return def;
  // Premium is refused FIRST, and on the table rather than on the allowlist: the tier stays
  // orchestrator-only "regardless of what a frontmatter says", so a premium id must not become
  // enforceable merely because someone widened `workerModels`.
  if (idIsPremium(id)) {
    return { ...def, note: `${role}: handoff asks for '${raw}' — the premium tier is orchestrator-only; ignored` };
  }
  const hit = allow.find((a) => normalizeId(a) === id);
  if (!hit) {
    return { ...def, note: `${role}: handoff asks for '${raw}', which is not in workerModels [${allow.join(", ")}]; ignored` };
  }
  return { model: hit, chosenBy: "frontmatter", note: null };
}

// ── retry bookkeeping ───────────────────────────────────────────────────────────────────────
// An earlier version marked a role "corrected" the moment a violation was raised, before the
// injection had reported back. A failed switch (session closed, CDP hiccup) was then never retried,
// across restarts too, leaving the worker on the expensive tier in silence. Now a role is only
// forgotten when it is ACTUALLY seen on a non-premium model; until then the attempt is retried on a
// growing backoff. That also covers a switch that reports success but does not take effect.
export const BACKOFF_MS = [60_000, 120_000, 300_000, 900_000];
export function backoffFor(attempts: number): number {
  return BACKOFF_MS[Math.min(Math.max(attempts, 1), BACKOFF_MS.length) - 1];
}

interface PolicyRecord { model: string;
  /** The id this role is being switched TO. A record whose target has changed is a DIFFERENT
   *  correction, so the attempt count and the backoff restart — otherwise a role that had backed
   *  off to the 15-minute step on an old target would sit unswitched for a quarter of an hour after
   *  its handoff asked for a new one. */
  target?: string;
  attempts: number; nextAttempt: number; lastError?: string; lastAttemptAt?: string; }
/** Per-handoff escalation counting (R4). Keyed by HANDOFF ID, because that is what is being judged
 *  — a role's next handoff starts its count from zero. */
interface EscalationRecord { role: string; blocked: number; lastSeen?: string; escalated?: boolean; }
/** The line-in-progress for the ledger (R5): what we know about a (role, id) until it closes. */
interface LedgerRecord { id: string; role: string; model: string; chosenBy: string; started: string;
                        /** WL-005: the tracker's OWN clock at the tick that first saw this handoff.
                         *  `started` used to be the worker's `status.updated_at`, which at that
                         *  moment belongs to the PREVIOUS block — see `ledgerTick`. */
                        openedAt?: string;
                        /** The worker's stamp when we opened, kept for diagnosis, never for arithmetic. */
                        workerStampAtOpen?: string | null;
  loopBacks: number; testsBefore: number | null;
  /** §19's SIZE rule, measured (CH-001): how many paths the handoff declared — the closest proxy
   *  for "split at file boundaries" before the work is done. 0 means it declared none. */
  filesDeclared?: number;
  /** How many DISTINCT `status.json` `updated_at` values this block was seen with — the closest
   *  thing to a turn count the tracker can observe from outside a session. null while no
   *  `updated_at` has ever been readable: a count of zero would read as "it never moved". */
  statusUpdates?: number | null;
  /** The last `updated_at` counted, so re-reading an unchanged status.json counts nothing. The same
   *  report-not-read rule as R4's escalation counting, for the same reason. */
  seenUpdatedAt?: string;
  /** Its line has been appended. The record survives until the handoff id changes, purely so the
   *  same block is not written again on every idle tick that follows. */
  closed?: boolean; }
interface PolicyState { pending: Record<string, PolicyRecord>;
  escalations?: Record<string, EscalationRecord>;
  ledger?: Record<string, LedgerRecord>;
  /** MS-001 R1: `<role>|<handoff id>` pairs whose "no model: line" note has been shown. Persisted so
   *  a reload of the window does not toast the same handoff again — once per handoff id, ever. */
  defaulted?: string[];
  updatedAt?: string; }

function stateFile(repo: string): string { return path.join(LOOM_ROOT, repo, "model-policy.json"); }

function loadState(repo: string): PolicyState {
  try {
    const st = JSON.parse(fs.readFileSync(stateFile(repo), "utf8"));
    // A pre-0.7.2 file carries {corrected}; ignore it so those roles are re-checked (the fix).
    if (st && st.pending && typeof st.pending === "object") {
      return { pending: st.pending,
               escalations: (st.escalations && typeof st.escalations === "object") ? st.escalations : {},
               ledger: (st.ledger && typeof st.ledger === "object") ? st.ledger : {},
               defaulted: Array.isArray(st.defaulted) ? st.defaulted.map(String) : [] };
    }
  } catch { /* none yet */ }
  return { pending: {}, escalations: {}, ledger: {}, defaulted: [] };
}

/** Drop every `escalations` entry whose KEY is an ack id (that map is keyed by handoff id), and
 *  every `ledger` entry whose `.id` FIELD is one (that map is keyed by ROLE, not id — a role can
 *  hold a real handoff and an ack in sequence, so the key itself says nothing). FX-001 R1: an
 *  earlier build let acks open both before `handoffId()` was fixed to refuse them at the source;
 *  this purges what those runs wrote, on the next save. The durable `model-ledger.jsonl` is
 *  append-only and left alone — only an in-progress ledger line, never yet appended, can be lost
 *  here. */
function purgeAcks(st: PolicyState): void {
  if (st.escalations) for (const id of Object.keys(st.escalations)) if (isAckId(id)) delete st.escalations[id];
  if (st.ledger) for (const role of Object.keys(st.ledger)) if (isAckId(st.ledger[role]?.id)) delete st.ledger[role];
}

function saveState(repo: string, st: PolicyState): void {
  try {
    purgeAcks(st);
    const f = stateFile(repo);
    const same = (a: any, b: any) => JSON.stringify(a || {}) === JSON.stringify(b || {});
    try {
      const cur = JSON.parse(fs.readFileSync(f, "utf8"));
      // change-only, across EVERY section — comparing `pending` alone would drop an escalation
      // count or a ledger line whose tick happened not to move a pending record.
      if (same(cur.pending, st.pending) && same(cur.escalations, st.escalations) && same(cur.ledger, st.ledger)
          && same(cur.defaulted, st.defaulted)) return;
    } catch { /* missing -> write */ }
    fs.mkdirSync(path.dirname(f), { recursive: true });
    const tmp = f + ".tmp." + process.pid;
    fs.writeFileSync(tmp, JSON.stringify({ ...st, updatedAt: new Date().toISOString() }, null, 2));
    fs.renameSync(tmp, f);
  } catch { /* never throw from a tick */ }
}

export interface ModelViolation { repo: string; role: string; model: string; attempt: number;
  /** The model id to switch this role TO. Per-role since MP-001: two workers of one project can be
   *  owed different tiers on the same tick, so the target travels with the violation rather than
   *  being read once per tick from the settings. */
  target: string;
  /** How that target was chosen, for the message the human reads and for the ledger. */
  chosenBy?: Desired["chosenBy"];
  /** The exact frame the tracker resolved for this role. `/model` is addressed to THIS, never to the
   *  role name alone: measured 2026-09-10, four buses each carry a `developer1`, and a by-name
   *  injection content-resolved into tfg_ua's ORCHESTRATOR — 16 `/model claude-opus-5` messages
   *  landed in the PO's composer. */
  webviewId?: string | null; }

export class ModelPolicy {
  constructor(private repo: string | null) {}

  /**
   * Workers whose footer chip is not the model their HANDOFF asks for. Since MP-001 this runs in
   * BOTH directions — switched down, and switched up. The premium floor is checked independently of
   * the desired tier: a worker on the orchestrator's tier is always a violation, whatever `desired`
   * returns. The orchestrator is exempt by design. Between attempts a role is held off by
   * `backoffFor(attempts)`, so a stuck session is retried periodically and never silently abandoned.
   *
   * `desired` is injected rather than read here so the decision stays assertable without a bus on
   * disk; `extension.ts` passes `(role) => desiredModel(repo, role, workerModel, workerModels)`.
   */
  check(models: Map<string, ModelInfo | null>, orchestratorRole: string | null,
        liveRoles: Set<string>, premium: string[] = DEFAULT_PREMIUM, now = Date.now(),
        frames: Map<string, string> = new Map(), orchestratorFrame: string | null = null,
        desired: (role: string) => Desired = () => ({ model: "claude-opus-5", chosenBy: "default", note: null })): ModelViolation[] {
    if (!this.repo) return [];
    const st = loadState(this.repo);
    const out: ModelViolation[] = [];
    for (const [role, info] of models) {
      if (!info || !liveRoles.has(role)) continue;
      if (orchestratorRole && role === orchestratorRole) continue;      // the exempt session
      // Exempt by NAME as well as by tag: shwab_docker's `productowner` was pending here because the
      // policy ran 30s before its orchestrator.json was written, and an untagged project exempts
      // nothing. An owner-named role is never a worker, tag or no tag.
      if (isOwnerRole(role)) continue;
      // Exempt by FRAME: if the frame the tracker resolved for this role IS the tagged orchestrator's,
      // the role label is wrong and typing there would hit the PO. Never switch a model in that frame.
      const wid = frames.get(role) ?? null;
      if (wid && orchestratorFrame && wid === orchestratorFrame) continue;
      const want = desired(role);
      const wantChip = chipFor(want.model);
      // A target whose chip we cannot name is not enforceable: we could never tell whether the switch
      // took, so the role would be typed into for ever. `desiredModel` only ever returns allow-listed
      // ids, so this is a settings error, not a tick.
      if (!wantChip) { delete st.pending[role]; continue; }
      const onPremium = isPremium(info.model, premium);
      if (!onPremium && wantChip.toLowerCase() === String(info.model).toLowerCase()) {
        delete st.pending[role]; continue;                              // actually compliant now
      }
      // Switched, chip not yet redrawn: the panel acknowledged a move to the model we want since
      // its last turn. Typing again would only print the same line again. Wait for the chip.
      if (info.acknowledged && wantChip.toLowerCase() === info.acknowledged.toLowerCase()) continue;
      const rec = st.pending[role];
      // Same correction as last time = same model AND same target; either changing is a new one.
      const sameGoal = !!rec && rec.model.toLowerCase() === info.model.toLowerCase()
                            && normalizeId(rec.target || "") === normalizeId(want.model);
      if (sameGoal && now < rec.nextAttempt) continue;                  // backing off between retries
      const attempts = (sameGoal ? rec.attempts : 0) + 1;
      st.pending[role] = { model: info.model, target: want.model, attempts,
                           nextAttempt: now + backoffFor(attempts),
                           lastAttemptAt: new Date(now).toISOString() };
      out.push({ repo: this.repo, role, model: info.model, attempt: attempts, target: want.model,
                 chosenBy: want.chosenBy, webviewId: wid });
    }
    saveState(this.repo, st);
    return out;
  }

  // ── MS-001 R1 · a handoff with no `model:` line is noted, once ────────────────────────────────
  // Measured 2026-09-14: MP-001 had chosen a tier exactly ONCE on this machine. No inbox on any
  // other bus had ever carried a `model:` line, ReciEats' ledger was 10/10 `chosenBy: default`, and
  // nothing had said so. The RESOLUTION is unchanged (absent → the configured `workerModel`, owner
  // 2026-09-13); what changes is that the absence is now visible — once per (role, handoff id),
  // persisted, so neither a 15-second tick nor a window reload repeats it. Acks are not handoffs.

  /**
   * The note to show if `role`'s CURRENT handoff has no `model:` line and has not been noted before,
   * else null. Records the (role, id) pair as noted. A request the tracker REFUSED (a premium or
   * unknown id) is not an absence and is reported by `desiredModel`'s own note, not here.
   */
  noteDefaulted(role: string, workerModel = "claude-opus-5", allow: string[] = DEFAULT_WORKER_MODELS): string | null {
    if (!this.repo) return null;
    const id = handoffId(this.repo, role);              // null for no inbox, and for an ack (FX-001)
    if (!id) return null;
    const want = desiredModel(this.repo, role, workerModel, allow);
    if (want.chosenBy !== "default" || want.note) return null;
    const st = loadState(this.repo);
    const key = `${role}|${id}`;
    const seen = (st.defaulted = st.defaulted || []);
    if (seen.includes(key)) return null;
    seen.push(key);
    saveState(this.repo, st);
    return `${role}'s ${id} has no model: line — running the default ${want.model} (§18)`;
  }

  /** Record what the injection reported. A role is only cleared once it is SEEN on a cheaper model. */
  recordResult(v: ModelViolation, ok: boolean, note: string): void {
    if (!this.repo) return;
    const st = loadState(this.repo);
    const rec = st.pending[v.role];
    if (!rec) return;
    if (ok) delete rec.lastError; else rec.lastError = String(note).slice(0, 120);
    saveState(this.repo, st);
  }

  /** Roles still believed to be on a premium model, with their retry state (for the UI). */
  pending(): Record<string, PolicyRecord> {
    return this.repo ? loadState(this.repo).pending : {};
  }

  // ── R4 · escalation ───────────────────────────────────────────────────────────────────────────
  // A worker on Sonnet that has looped back TWICE on one handoff is not being stubborn, it is on the
  // wrong tier: the orchestrator's difficulty judgement was wrong for this block. The tracker
  // rewrites that handoff's `model:` line to Opus and lets R2's next idle tick perform the switch —
  // one mechanism, not a second injection path. "Looped back" is `status.json.status === "blocked"`,
  // which is what the /loom skill instructs a worker to write when it raises one. A report is
  // counted ONCE: the same `blocked` status is re-read every tick, so a new report is only a new
  // `updated_at`.

  /** Count a fresh loop-back and, on the second for one handoff, raise its tier. Returns what it
   *  did, or null when it did nothing. Never throws — a tick must survive a half-written bus. */
  escalate(role: string, workerModel = "claude-opus-5", allow: string[] = DEFAULT_WORKER_MODELS,
           now = new Date()): { id: string; role: string; to: string } | null {
    if (!this.repo) return null;
    const id = handoffId(this.repo, role);
    const status = readStatus(this.repo, role);
    if (!id || !status) return null;
    const st = loadState(this.repo);
    const esc = (st.escalations = st.escalations || {});
    const rec = esc[id] || (esc[id] = { role, blocked: 0 });
    const seenAt = String(status.updated_at || "");
    if (String(status.status || "") === "blocked" && seenAt !== rec.lastSeen) {
      rec.blocked += 1;
      rec.lastSeen = seenAt;
    }
    let done: { id: string; role: string; to: string } | null = null;
    // Only a role we are currently asking to run SONNET can be escalated; a handoff already on Opus
    // has nowhere to go, and one already escalated is not escalated twice however many times it
    // loops back after.
    if (rec.blocked >= 2 && !rec.escalated
        && normalizeId(desiredModel(this.repo, role, workerModel, allow).model) === "claude-sonnet-5"
        && rewriteHandoffModel(this.repo, role, id, "claude-opus-5")) {
      rec.escalated = true;
      done = { id, role, to: "claude-opus-5" };
    }
    saveState(this.repo, st);
    return done;
  }

  /** Was THIS handoff's tier reached by escalation rather than by the orchestrator's own choice? */
  wasEscalated(id: string | null): boolean {
    if (!this.repo || !id) return false;
    const rec = (loadState(this.repo).escalations || {})[id];
    return !!(rec && rec.escalated);
  }

  // ── R5 · the ledger ───────────────────────────────────────────────────────────────────────────
  // One append-only line per (role, handoff id), so that in a month the rubric can be judged on what
  // actually happened: did the Sonnet blocks loop back more, take longer, land fewer tests? A line
  // is closed when the handoff id CHANGES or when the role reports idle having handled that id. A
  // line that cannot be completed is written with nulls rather than skipped — a missing line is
  // invisible, and the gap would bias exactly the comparison this exists to make.

  /**
   * Advance the ledger for one role. Call every tick; it writes only at a transition.
   *
   * `contextPct` is CDP data and cannot be read from here — `extension.ts` passes what the tick
   * measured, or null. It is recorded at the instant the line CLOSES, because §19 judges size by
   * where a handoff finished. Its one honest bound is stated at `appendLedger`.
   */
  ledgerTick(role: string, workerModel = "claude-opus-5", allow: string[] = DEFAULT_WORKER_MODELS,
             now = new Date(), contextPct: number | null = null): void {
    if (!this.repo) return;
    const id = handoffId(this.repo, role);
    const status = readStatus(this.repo, role) || {};
    const st = loadState(this.repo);
    const led = (st.ledger = st.ledger || {});
    let cur = led[role];
    let dirty = false;
    if (cur && cur.id !== id) {                       // the next handoff landed over this one
      if (!cur.closed) this.appendLedger(cur, status, now, st, contextPct);
      delete led[role]; cur = undefined as any; dirty = true;
    }
    // A CLOSED line is kept, not deleted, until its handoff is replaced: the inbox still holds the id
    // the role just finished and status.json still says idle, so deleting it here would have the next
    // tick re-open and re-close that same block, one line per idle tick. (Measured by R5's own test
    // before this guard existed.)
    if (cur && cur.closed) return;
    if (!cur && id) {
      const want = desiredModel(this.repo, role, workerModel, allow);
      const seen = String(status.updated_at || "");
      // WL-005 · `started` USED TO BE `status.updated_at`, AND THAT IS THE WHOLE DEFECT. When a block
      // opens, the worker's status.json still carries the stamp of the LAST thing it wrote, which
      // belongs to the block BEFORE this one, so every duration measured from some earlier block's
      // activity to this one's end. Measured 2026-09-15: not one record's `started` was its own (one
      // read 2455.3 wall minutes), and because the two ends came from different clocks the pair
      // could invert — ReciEats rendered -39.3 minutes. The honest stamp is the one THIS process
      // observed: late by at most one tick, never another block's. The worker's stamp is kept beside
      // it for diagnosis, never used for arithmetic.
      const openedAt = now.toISOString();
      led[role] = { id, role, model: want.model,
                    chosenBy: this.wasEscalated(id) ? "escalated" : want.chosenBy,
                    openedAt,
                    workerStampAtOpen: seen || null,
                    started: openedAt,
                    loopBacks: 0, testsBefore: numOrNull(status.tests_before ?? status.testsBefore),
                    filesDeclared: handoffFiles(this.repo, role).length,
                    // the stamp this block OPENED on is the first distinct value we saw
                    statusUpdates: seen ? 1 : null, ...(seen ? { seenUpdatedAt: seen } : {}) };
      dirty = true;
    } else if (cur) {
      // keep the in-progress line current: the tier may have been escalated mid-handoff, and the
      // loop-back count lives in the escalation record that R4 maintains.
      const want = desiredModel(this.repo, role, workerModel, allow);
      const chosenBy = this.wasEscalated(id) ? "escalated" : want.chosenBy;
      const loopBacks = ((st.escalations || {})[id!] || { blocked: 0 }).blocked;
      const files = handoffFiles(this.repo, role).length;
      if (cur.model !== want.model || cur.chosenBy !== chosenBy || cur.loopBacks !== loopBacks
          || cur.filesDeclared !== files) {
        cur.model = want.model; cur.chosenBy = chosenBy; cur.loopBacks = loopBacks;
        cur.filesDeclared = files; dirty = true;
      }
      // R3: count REPORTS, not reads. status.json is re-read every tick, so a status update is a new
      // `updated_at` and nothing else — the same rule R4's escalation counting is built on. Counting
      // reads would make this a tick counter, measuring how long the window was open rather than how
      // many turns the block took.
      const seen = String(status.updated_at || "");
      if (seen && seen !== cur.seenUpdatedAt) {
        cur.statusUpdates = (cur.statusUpdates || 0) + 1;
        cur.seenUpdatedAt = seen; dirty = true;
      }
      // finished: the role says it is idle having handled exactly this id
      if (String(status.status || "") === "idle" && String(status.last_handled || "") === id) {
        this.appendLedger(cur, status, now, st, contextPct);
        cur.closed = true; dirty = true;
      }
    }
    if (dirty) saveState(this.repo, st);
  }

  /**
   * Write one closed block's line, and — only if that write actually landed — drop its escalation
   * record (CH-001 R4).
   *
   * THE PRUNE IS HERE AND NOWHERE EARLIER. `escalations` is working state; once the line is on disk
   * the DURABLE record of that decision is the line (`chosenBy: "escalated"`, `loopBacks: n`), and
   * left behind the map grows one entry per handoff for ever in a file re-written on a 15 second
   * tick. But the append can fail (a full disk, a read-only mount) and this method has always
   * swallowed that so a ledger write cannot break a tick, so pruning unconditionally would lose
   * BOTH records. Hence the boolean this returns; the mutant for it makes the prune unconditional.
   *
   * `contextPctAtFinish` has an honest bound worth knowing before anyone averages it: the panel
   * only renders "% context used" above roughly 50 %, so a block that finished comfortably reads
   * null — itself §19's "finished under 30 % was too small" band, not missing data. A NUMBER here
   * always means at least half full.
   */
  private appendLedger(rec: LedgerRecord, status: any, now: Date, st: PolicyState,
                       contextPct: number | null = null): boolean {
    if (!this.repo) return false;
    // WL-005 · BOTH ENDS COME FROM ONE CLOCK. `finished` was the worker's `status.updated_at` while
    // `started` came from a different record's write, so the two were not commensurable and their
    // difference was not a duration. The worker's stamp is still recorded — useful, but not an
    // endpoint.
    const closedAt = now.toISOString();
    const workerStampAtFinish = status.updated_at ? String(status.updated_at) : null;
    // A record opened before WL-005 carries no `openedAt`, and its real start cannot be recovered
    // from anything here. `unmeasured` is a state, not a zero and not a guess (the repo-wide
    // convention, also named in workledger.ts and health.ts): the line says it has no duration
    // rather than reporting one it cannot support.
    const openedAt = rec.openedAt ? String(rec.openedAt) : null;
    const line = {
      id: rec.id, role: rec.role, model: rec.model || null,
      chosenBy: this.wasEscalated(rec.id) ? "escalated" : (rec.chosenBy || null),
      started: openedAt,
      openedAt, closedAt,
      workerStampAtOpen: rec.workerStampAtOpen ?? null,
      workerStampAtFinish,
      finished: closedAt,
      loopBacks: ((st.escalations || {})[rec.id] || { blocked: rec.loopBacks || 0 }).blocked,
      testsBefore: rec.testsBefore,
      testsAfter: numOrNull(status.tests_after ?? status.testsAfter),
      contextPctAtFinish: numOrNull(contextPct),
      // Null in, null out: no observed open means no duration, however long ago the tick was.
      wallMinutes: openedAt ? wallMinutes(openedAt, closedAt) : null,
      filesDeclared: typeof rec.filesDeclared === "number" ? rec.filesDeclared : null,
      statusUpdates: rec.statusUpdates ?? null,
    };
    try {
      const f = path.join(LOOM_ROOT, this.repo, "model-ledger.jsonl");
      fs.mkdirSync(path.dirname(f), { recursive: true });
      fs.appendFileSync(f, JSON.stringify(line) + "\n");    // append-only: never read, never rewritten
    } catch { return false; }                               // a ledger write must never break a tick
    if (st.escalations && st.escalations[rec.id]) delete st.escalations[rec.id];
    return true;
  }

  /** Switch a role onto the model it is owed by injecting `/model <id>` into its composer. The id
   *  travels ON the violation (per-role since MP-001); the parameter only overrides it. */
  enforce(v: ModelViolation, targetModel: string = v.target, done?: (ok: boolean, note: string) => void): void {
    // THE CHOKEPOINT (MP-002, owner 2026-09-16). Every `/model` the extension types goes through this
    // one method, so the "never an orchestrator" rule is enforced HERE rather than only at the call
    // sites that happen to exist today — the guarantee that survives a fourth caller written next
    // month by someone who has not read `check()`. Two cheap tests, neither needing a live panel: by
    // NAME (an owner-named role is never a worker, tagged or not) and by FRAME (the frame this
    // project has TAGGED as its orchestrator). Refusing is silent except to `done`, so
    // `recordResult` keeps the reason and nothing is typed. The bus is read fresh each time because
    // a tag can be set or moved between ticks.
    const owner = isOwnerRole(v.role);
    const tagged = getOrchestrator(v.repo || null);
    const ownFrame = !!(v.webviewId && tagged && tagged.webviewId && v.webviewId === tagged.webviewId);
    const taggedRole = !!(tagged && tagged.role && tagged.role === v.role);
    if (owner || ownFrame || taggedRole) {
      const why = owner ? "an owner-named role" : ownFrame ? "the tagged orchestrator's own frame" : "the tagged orchestrator";
      done?.(false, `refused: ${v.role} is ${why} — the model policy applies to non-orchestrators only`);
      return;
    }
    // --webview-id addresses the EXACT frame; --repo scopes the fallback, because role names are
    // PROJECT-SCOPED and a bare name two buses share (`developer`: Gaming + livegita; four buses now
    // carry `developer1`) can otherwise resolve to the OTHER project's frame. See inject.ts.
    execFile("python3", [LOOM_CDP, "inject", "--role", v.role, "--message", `/model ${targetModel}`,
                         "--submit", ...(v.repo ? ["--repo", v.repo] : []),
                         ...(v.webviewId ? ["--webview-id", v.webviewId] : []),
                         ...senderArgs("model", v.repo)],
      { timeout: INJECT_TIMEOUT_MS },
      (err, stdout, stderr) => {
        // MS-001 R2: the injector exits 0 and prints `'ok': False, ... 'note': 'typed text not
        // confirmed in composer; NOT submitted'` when the switch did NOT happen (measured
        // 2026-09-14), and `ok = !err` recorded that as "switched". The verdict is read off the
        // output, the same way injectTo reads it.
        const verdict = injectVerdict(err, stdout, stderr);
        const ok = verdict.ok;
        try {
          fs.writeFileSync(path.join(LOOM_ROOT, "model-policy-debug.json"), JSON.stringify({
            at: new Date().toISOString(), violation: v, target: targetModel, ok, note: verdict.note,
            out: String(stdout || "").slice(-400),
            err: String((err && err.message) || stderr || "").slice(-400),
          }, null, 2));
        } catch { /* ignore */ }
        done?.(ok, ok ? "switched" : verdict.note);
      });
  }
}

/**
 * PB-001 · The most recent instant a handoff was OPENED on this bus — the dispatch watermark.
 *
 * Read from the ledger rather than recomputed: `openedAt` is the tick that FIRST SAW a new handoff
 * id in a role's inbox, this process's own observation of the orchestrator handing work over (see
 * WL-005 for why the worker's own stamp is never used for arithmetic). Records with no `openedAt`
 * (opened before WL-005) are skipped rather than guessed at.
 *
 * Only OPEN records are in `model-policy.json`; a closed one is appended to `model-ledger.jsonl`.
 * That is correct here: a bus whose last block closed has no dispatch newer than the one still
 * recorded, and a bus that has genuinely never dispatched returns null — which the caller renders
 * as "no handoff to any role has been seen", never as "long ago".
 */
export function lastDispatchAt(repo: string | null): string | null {
  if (!repo) return null;
  const led = loadState(repo).ledger || {};
  let best: string | null = null;
  for (const rec of Object.values(led)) {
    const at = rec && typeof (rec as any).openedAt === "string" ? String((rec as any).openedAt) : null;
    if (!at || !Number.isFinite(Date.parse(at))) continue;
    if (best === null || Date.parse(at) > Date.parse(best)) best = at;
  }
  return best;
}
