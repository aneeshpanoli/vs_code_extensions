// models.ts — ONE JOB: every session on the tier its work actually needs.
//
// WHY: every session draws on ONE shared usage pool, and the top tier costs ~2x the Opus tier per
// token ($10/$50 vs $5/$25 per MTok). Workers doing mechanical handoff work do not need it; the
// orchestrator, which reasons over the whole board, may.
//
// Two rules, and they stack. The FLOOR is the tier boundary: the premium tier is the orchestrator's
// alone, and no handoff, setting or worker may cross it. Above that floor the ORCHESTRATOR picks
// per handoff (MP-001, owner 2026-09-13) between Opus 5 and Sonnet 5 by writing `model:` into the
// handoff's frontmatter; this file reads that choice, enforces it in BOTH directions, escalates a
// worker that loops back twice, and appends a ledger line so the rubric can be judged in a month.
//
// HOW A SESSION'S MODEL IS READ (measured live, 2026-09-08): the composer footer renders as
//   ... | Remote Control | Opus 5 | Medium | Bypass permissions
// i.e. model, then effort, then the permission chip. Matching that whole run — anchored on the
// permission chip and taking the LAST match — means a conversation that merely *mentions* a model
// name cannot be mistaken for the footer.
//
// HOW IT IS CORRECTED: inject `/model <id>` into the offending session, the same way `/loom <role>`
// binds one. A role stays pending until it is SEEN on a cheaper model; attempts repeat on a growing
// backoff, so a switch that fails or silently does not take effect is retried rather than forgotten.
//
// THE CHIP LAGS THE SWITCH (measured 2026-09-13 05:49–05:53 on ReciEats/developer2): `/model
// claude-opus-5` printed "Set model to Opus 5 for this session only" at once, but the footer chip
// still read "Fable 5.1" sixty seconds later, so the policy typed the command AGAIN; the chip only
// flipped to "Opus 5" when the session's next turn began. The panel is therefore read for that
// acknowledgement: a `You: /model <id>` echo followed by "Set model to <name>" with no later turn is
// a switch that took, and the role is left alone until the chip catches up.
//
// THE ORCHESTRATOR IS NEVER SWITCHED — BY ANY PATH, IN EITHER DIRECTION (owner, 2026-09-16:
// "The extension changing orchestrators model version. Must stop. It only applies to
// non-orchestrators.").
//
// This REVERSES two earlier directions of his that this file used to cite, and they are gone rather
// than disabled: the 2026-09-13 promotion of the tagged orchestrator to the premium tier ("only the
// orchestrator is supposed to be on Fable 5.1"), and MS-001 R3 (2026-09-14), the self-shift through
// `<repo>/orchestrator-model.json`. Neither is a live rule any more, and nothing here should be read
// as rationale for bringing either back. A `<repo>/orchestrator-model.json` left on any bus is inert
// by code: no function in this file reads that path.
//
// WHAT THE POLICY STILL IS, and all of it is about WORKERS: a worker runs the tier its handoff asks
// for, in both directions; a worker on the orchestrator's own tier is a violation and is switched
// down (the premium FLOOR); a handoff asking for a premium id is refused with a note. The
// orchestrator appears in this file only as an exemption — three of them, in `check()` — and as the
// refusal in `enforce()`, which is the single chokepoint every `/model` injection passes through.
// A handoff with no `model:` line is not a silent default either: it is noted once (MS-001 R1).

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
// ("Sonnet 5") and the id `/model` TAKES (`claude-sonnet-5`). Everything downstream compares a chip
// to a desired id, so the mapping is stated ONCE, here, rather than re-derived at each call site by
// lowercasing and hyphenating — which would silently produce `claude-fable-5.1` for "Fable 5.1" and
// switch nothing. `isPremium` above still answers for CHIPS (that is what `premiumModels` holds);
// `idIsPremium` is its counterpart for ids, and it is the one that guards a handoff's request.
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
// orchestrator's own tier is nobody's business here, and is never switched by any path (see the
// header). A `model:` line is a worker's tier, and there is no longer any other kind.
//
// A frontmatter the tracker cannot read changes NOTHING: no file, no block, no `model:` line, a
// malformed block, a premium id, an unknown id — every one of those falls back to the configured
// `workerModel`, and the two that are a REQUEST rather than an absence say so in tracker-debug.json.
// This is principle 16 pointed the other way: a read that cannot answer must not be read as licence.
// Since MS-001 R1 the plain ABSENCE of a `model:` line is said too, once per handoff (`noteDefaulted`).

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
 * The `files:` line of that same block, as the path patterns a handoff DECLARES it will touch
 * (CH-001, playbook §19: "one handoff is one merge", and two live handoffs on one bus must not
 * touch the same files).
 *
 * `frontmatter()` itself cannot carry this: it is typed `Record<string, string>` and every caller
 * relies on that, so the list is parsed beside it rather than folded into its return type — the
 * `files:` half of the same block, one function along.
 *
 * Tolerant on purpose, because a human and an orchestrator both write this line: comma- OR
 * space-separated (§19's own example uses commas, MP-001's inbox used spaces), quotes and stray
 * whitespace dropped, `./` and trailing slashes normalised, duplicates collapsed, order kept.
 *
 * AN ABSENT LINE IS AN EMPTY LIST AND NOT A CLAIM ABOUT ANYTHING. Principle 16 pointed the same way
 * as MP-001's `model:`: a handoff that declares nothing is not a handoff that declares it touches
 * nothing, so the overlap guard must have no opinion there rather than read the silence as licence
 * to refuse. Every refusal below needs a `files:` line on BOTH sides.
 *
 * BOTH YAML SPELLINGS ARE READ (OV-001). CH-001 shipped the one-line form and stated the bound
 * honestly: a multi-line list parsed as an empty value and declared nothing. That was the safe
 * direction, and it was also — measured on the real bus with the compiled build — the reason this
 * guard had NEVER REFUSED ANYTHING HERE. This bus writes every handoff's `files:` as an indented
 * list, so `handoffFiles()` returned `[]` for all three roles and `overlapFor()` was always null.
 * The one-worker-per-file rule was being kept by hand, by the orchestrator, with nothing checking it.
 *
 *     files: src/a.ts, src/b.ts        <- the one-line form. Three other buses write this.
 *     files:                           <- the list form. This bus writes this.
 *       - src/a.ts
 *       - src/b.ts
 *
 * THE ONE-LINE FORM'S BEHAVIOUR IS UNCHANGED, deliberately and by construction: the list is only
 * looked for when the `files:` key's own value is EMPTY, so a `files:` that carries paths is read
 * exactly as it was and indented lines under it are ignored as they always were. pleodo, hackomics
 * and tfg_ua depend on that and must not move. Both spellings then converge on ONE splitting loop
 * below, so there is no second set of rules for quoting, commas, globs or duplicates to drift.
 *
 * Doubt still declares NOTHING. Collection stops at the first line under `files:` that is not a
 * `- item`, so a malformed or half-written block yields the entries it could read and no guess about
 * the rest — and where it can read none, an empty list, which the guard has no opinion about.
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
// R1 fixed `(NEW)` and pinned `(new file)` as a known limit, because the splitting loop runs BEFORE
// `normalizeDeclaredPath` and a spaced annotation arrives as `(new` and `file)` — two fragments,
// neither wholly bracketed, both read as paths. Two handoffs annotating that way REFUSED EACH OTHER
// on `(new`, which is the expensive direction (§3): a stalled dispatch over a parenthetical.
//
// THE FIX IS A PRE-PASS, NOT A NEW SPLITTER, and that is the whole of why it is safe. One regex
// removes annotation RUNS from the raw line before the existing loop splits it; the loop, the
// normaliser, quoting, globs and duplicate collapsing are all untouched. The predicate inside the
// brackets EXTENDS `normalizeDeclaredPath`'s — no slash, no dot, no nested bracket, and additionally
// no comma and no `*` — so a spaced annotation and a space-free one are dropped for closely related
// reasons and there is no second splitting rule to drift.
//
// THE TWO EXTRA EXCLUSIONS ARE NOT TIDINESS; A REFUTATION PASS FOUND BOTH. The bracket boundaries
// bound where a run STARTS and ENDS but not how LONG it is, so a run can span many tokens — and every
// token in between disappears with it. Two shapes made that dangerous rather than merely surprising:
//  - A REAL PATH WITH NO DOT IN IT. `Makefile`, `LICENSE` and `Dockerfile` are dot-free and
//    slash-free, so `files: (new` + `Makefile` + `file)` swallowed a genuinely declared file and left
//    an ABSENCE — the failure mode with nothing printed anywhere: no refusal, and no waiver note
//    either, because nothing was exempted. Excluding the COMMA, plus `listUnderKey` joining its items
//    with one, is what confines a run to a single declared item.
//  - A WILDCARD. `overlap.ts` states that a `*` is NEVER exempted away, and `files: (new` + `*` +
//    `file)` erased one. Excluding `*` from the inner text keeps that invariant true HERE too, which
//    matters because this function runs first: a claim on every file that has been deleted before the
//    guard sees it cannot be refused by anything downstream.
//
// IT ONLY FIRES ON A WHOLE-TOKEN RUN, which is what keeps this a narrowing and not a rewrite: the `(`
// must start the token (line start, or after a comma or space) and the `)` must END it (line end, or
// before a comma or space). So:
//   `src/a.ts (new file)`  -> the run is its own token(s); dropped. The path survives.
//   `src/a (b).ts`         -> `(b)` is followed by `.`, NOT a token end; NOTHING is stripped, and the
//                             behaviour is bit-for-bit what it was: `src/a` and `(b).ts` both refuse.
//   `src/a.ts(NEW)`        -> the `(` does not start a token; untouched, still one refusing path.
// A real path with a space-separated bracketed fragment therefore cannot be swallowed BEYOND the
// annotation itself — the fragment that is not annotation-shaped stays, and it still refuses.
//
// The replacement KEEPS the captured delimiter and adds a space, so the token structure around the
// removed run is untouched. Be honest about that detail rather than claim a save: because the `)` can
// only end a token, no reachable input glues two paths even if the delimiter were dropped — the space
// is belt-and-braces against a future edit to the boundary, not a fix for a case anyone found. No
// mutant is written for it, because no test could kill one.
//
// THE SHAPES LEFT REFUSING — all of them, enumerated, because the first draft of this comment named
// one and a refutation pass immediately found four more. An annotation is LEFT ALONE, and therefore
// still read as paths and still able to refuse, when it:
//  - contains a `/` or a `.` — `(see docs/spec.md)`, `(rewrite v2.0)`;
//  - contains a comma or a `*` — `(new, big)` spanning items, `(rewrite everything *)`;
//  - is NESTED or UNBALANCED — `((new))`, `(new (file))`, a lone `(new` with no closing bracket;
//  - uses square or curly brackets — `[NEW]`, `{NEW}`. R1 left those out deliberately ("not attested
//    in any `files:` line on this machine") and R2 does not add them: every spelling admitted here is
//    a real filename someone can no longer declare, and this list is already at the edge of that.
// THE FIRST TWO ARE THE PRINCIPLED ONES and the reason is R1's finding: the inner text is the ONLY
// thing distinguishing `(NEW)` from `(src/shared.ts)`, a bracketed REAL PATH, and dropping one of
// those loses a guard in SILENCE. Given `docs/spec.md)` there is no way to tell the tail of a prose
// annotation from a path someone bracketed. So the expensive direction is chosen knowingly: it
// REFUSES, the orchestrator re-reads two briefs, and nobody edits an unguarded file.
//
// The residual ambiguity that cannot be closed, stated rather than hidden: a dot-free REAL path
// written INSIDE a bracket run on a single comma-free line — `files: (new Makefile file)` — is still
// swallowed, because a bare dot-free word is exactly what an annotation is made of. It is now the
// only such shape (the list form is confined item-by-item), and the old code turned that same line
// into three junk paths, so nothing regressed. A writer's remedy is a comma.
//
// A NARROWING CAN ONLY REMOVE REFUSALS, and this one is checked against that claim directly: every
// token the pre-pass removes was, by construction, a token `normalizeDeclaredPath` would keep only
// because it had been split in half. Fewer paths on either side of `firstShared` can never produce a
// collision that was not already there. The §19 size ledger moves with it, deliberately and
// consistently with R1's call: `filesDeclared` counts what `handoffFiles` returns, so a block
// annotating one path `(new file)` now ledgers 1 rather than 3 — "is this a file at all" belongs in
// the count.
const SPACED_ANNOTATION = /(^|[,\s])\([^()/.,*]*\)(?=[,\s]|$)/g;

/** The raw `files:` line with whole-token `( ... )` annotations replaced by a space — see above. The
 *  bracket must open a token and close one, and the inside must be annotation-shaped (no `/`, no `.`,
 *  no nested bracket), so this can only ever remove tokens, never re-spell a path. */
function stripSpacedAnnotations(raw: string): string {
  return raw.replace(SPACED_ANNOTATION, "$1 ");
}

/**
 * The `- item` lines directly under `key:` in the SAME frontmatter block, joined into the one-line
 * spelling so `declaredFiles` has a single splitting loop for both forms. `""` when the key is
 * absent, carries its own value, or has no list under it.
 *
 * Only the frontmatter block is searched — the regex is `frontmatter()`'s own, so a `---` further
 * down a document stays a horizontal rule — and collection STOPS at the first line that is not an
 * `- item`, which is what keeps the next key (`version:`, `---`) from being swallowed.
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
  // JOINED WITH A COMMA, NOT A SPACE (OV-001-R2, found by the refutation pass). Both are the one-line
  // spelling as far as the splitting loop is concerned — it splits on `[,\s]+` — but the annotation
  // pre-pass cannot cross a comma, and with a SPACE join it could: `- (new` / `- Makefile` / `- file)`
  // arrived as one line, the run `(new Makefile file)` matched, and the real `Makefile` item vanished
  // with it. One list item's brackets must never reach another item's, so the join is the delimiter
  // that stops them.
  return items.join(",");
}

// ── what is not a path at all (OV-001-R1 §1(2)) ─────────────────────────────────────────────────
//
// TWO LIVE tfg_ua DECLARATIONS WERE BEING READ AS FILENAMES, and both produced the expensive failure
// (§3): a REFUSAL on a word. `files: none` is how a standby role on that bus says it touches nothing,
// and it parsed as a path named `none`, so its two standby roles refused each other. `files:
// tools/cardmaker/** (NEW), docs/social/card-design.md (NEW)` annotates its paths by hand, and the
// annotation parsed as a third path, so any second annotated handoff on that bus was refused on a
// parenthetical shared with the first.
//
// WHY THIS IS ALLOWED WHERE A FORMAT CHANGE IS NOT (OV-001 decision (a) forbids changing what a valid
// single-line list MEANS). Neither of these changes the reading of any path: they narrow what counts
// as a path in the first place, and a declaration with fewer paths in it can only ever REMOVE
// refusals, never create one. That is the safe direction for a guard that refuses.
//
// THE SPELLING CHOSEN, and its cost. A token is dropped only when the WHOLE declaration is one:
//  - a SENTINEL — `none`, `n/a` or `-`, case-insensitively, and nothing else. Not `nil`, `todo`,
//    `tbd` or `null`: those are not written on any bus measured today, and every word added here is
//    a filename someone can no longer declare.
//  - a PARENTHESISED annotation — `(NEW)`, `(rewrite)`: `(` to `)` around the entire token, AND a
//    plain word inside it. Deliberately NOT brackets generally: `[...]` and `{...}` are not attested
//    in any `files:` line on this machine, and inventing a rule for a spelling nobody writes only
//    costs real paths.
//
// WHY THE INSIDE OF THE BRACKET IS TESTED TOO, which the first draft of this did not do. `^\(.*\)$`
// also eats `(src/shared.ts)` — a REAL path someone bracketed — and that is the one narrowing case
// that loses a guard SILENTLY: the declaration becomes an absence, so nothing refuses and the
// exemption note does not fire either, because nothing was exempted. Two roles then edit the file
// with no refusal and no note anywhere. A refutation pass found it. So the inner text must be a plain
// word: no `/`, no `.`, no nested bracket. `(NEW)` is dropped; `(src/shared.ts)`, `(draft.md)` and
// `(a)(b)` are kept and refuse as paths. Keeping is the safe direction — it can only refuse MORE.
//
// THE SPACED ANNOTATION IS NOW FIXED (OV-001-R2 §3), one function up. R1 found that a `(new file)`
// arrives here as `(new` and `file)` because the splitting loop runs first, pinned it as a limit, and
// raised it rather than changing the loop — which R1 was not authorised to do. R2 authorised it, and
// `stripSpacedAnnotations` removes whole-token annotation RUNS from the raw line before the split,
// using THIS function's predicate for what is inside the brackets. The shape still refusing — an
// annotation containing a `/` or a `.`, which cannot be told from a bracketed real path — is named
// there.
//
// THE COST. A file genuinely NAMED `none`, `n/a` or `(NEW)` can no longer be declared, and the guard
// would go quiet on it. Nothing named that exists in any repo here, and the writer's remedy is a path
// with a directory in it. NORMALISATION RUNS FIRST, so `./none` and `none/` are sentinels too. A path
// that merely CONTAINS one of these is untouched — `src/none-handler.ts` and `docs/(draft)-spec.md`
// still refuse — because the test is on the whole token, which is the only reason this narrowing is
// as small as it claims to be.
//
// AND IT SHRINKS THE §19 SIZE LEDGER, deliberately, unlike the exemption. `filesDeclared` counts what
// `handoffFiles` returns, so a block declaring `files: none` now ledgers 0 files and one annotating
// two paths ledgers 2 rather than 3. That is the OPPOSITE call from overlap.ts's exemption, which is
// kept out of this function precisely so it cannot move that number — and the two are consistent:
// "is this a file at all" belongs in the count, "is this file's merge mechanical" does not.
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
 *  maps all three to 0, which in a ledger line is not a missing value but a measured one, and a 0 %
 *  context or 0 tests would be read as fact. (Found while adding `contextPctAtFinish`, which is null
 *  far more often than it is a number; the same hole was open under `testsBefore`.) */
function numOrNull(v: any): number | null {
  if (v === null || v === undefined || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

/** Wall-clock minutes between two timestamps, or null when either will not parse (CH-001 R3).
 *  NEVER a guess: the ledger's own test fixtures use "T1"/"T9" as stamps, and the honest answer to
 *  "how long did that take" for an unparseable pair is "unknown", not zero. A NEGATIVE result is
 *  returned as measured rather than nulled — a clock that went backwards is a fact about the bus,
 *  and silently rounding it to null would hide it. */
function wallMinutes(started: any, finished: any): number | null {
  const a = Date.parse(String(started || "")), b = Date.parse(String(finished || ""));
  if (!Number.isFinite(a) || !Number.isFinite(b)) return null;
  return Math.round(((b - a) / 60_000) * 10) / 10;
}

/**
 * Rewrite ONLY the `model:` line of a role's inbox frontmatter, and only while the file still
 * carries `expectId`. tmp+rename, so a half-written inbox is never what a `/loom` bind reads.
 *
 * THE ID RE-CHECK IS A SECOND LAYER, AND IT IS THE ONE THAT DECIDES THE RACE. `escalate` already
 * keys its counting by handoff id, so an inbox replaced BEFORE the decision is refused there — the
 * new id simply has no loop-backs yet. What only this re-check can refuse is an inbox replaced
 * BETWEEN the decision and the write, which is a real window: playbook §12 step 2 has the
 * orchestrator overwrite `inbox.md` with the next brief as its very first move after banking, and
 * a tick can land inside it. Raising the tier of a brief the orchestrator deliberately judged,
 * because of the PREVIOUS brief's loop-backs, is worse than never escalating at all.
 *
 * Exported for exactly that reason: the guard is unreachable through `escalate` (the id keying gets
 * there first), so a test driving escalate can only ever pass for the wrong reason, and a mutant on
 * this line survived one. It is pinned directly instead — principle 17.
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
// An earlier version marked a role "corrected" the moment a violation was raised — before the
// /model injection had even reported back. A failed switch (session closed, CDP hiccup) was then
// never retried, across restarts too, leaving the worker on the expensive tier in silence.
// Now a role is only forgotten when it is ACTUALLY seen on a non-premium model; until then the
// attempt is retried on a growing backoff. That also covers a switch that reports success but does
// not take effect.
export const BACKOFF_MS = [60_000, 120_000, 300_000, 900_000];
export function backoffFor(attempts: number): number {
  return BACKOFF_MS[Math.min(Math.max(attempts, 1), BACKOFF_MS.length) - 1];
}

interface PolicyRecord { model: string;
  /** The id this role is being switched TO. A record whose target has changed is a DIFFERENT
   *  correction, so the attempt count and the backoff restart — otherwise a role that had backed
   *  off to the 15-minute step on an old target would sit unswitched for a quarter of an hour
   *  after its handoff asked for a new one. */
  target?: string;
  attempts: number; nextAttempt: number; lastError?: string; lastAttemptAt?: string; }
/** Per-handoff escalation counting (R4). Keyed by HANDOFF ID, because that is what is being judged
 *  — a role's next handoff starts its count from zero. */
interface EscalationRecord { role: string; blocked: number; lastSeen?: string; escalated?: boolean; }
/** The line-in-progress for the ledger (R5): what we know about a (role, id) until it closes. */
interface LedgerRecord { id: string; role: string; model: string; chosenBy: string; started: string;
                        /** WL-005: the tracker's OWN clock at the tick that first saw this handoff.
                         *  `started` used to be the worker's `status.updated_at`, which at that
                         *  moment still belongs to the PREVIOUS block — see `ledgerTick`. */
                        openedAt?: string;
                        /** The worker's stamp when we opened, kept for diagnosis, never for arithmetic. */
                        workerStampAtOpen?: string | null;
  loopBacks: number; testsBefore: number | null;
  /** §19's SIZE rule, measured (CH-001). How many paths the handoff declared — the closest proxy for
   *  "split at file boundaries" that exists before the work is done. 0 means it declared none. */
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
 *  this purges whatever those runs already wrote, on the next save. The durable
 *  `model-ledger.jsonl` is append-only and deliberately left alone — only an in-progress ledger
 *  line, never yet appended, can be lost here. */
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
   *  landed in the PO's composer, which replied "that is a CLI command, and I cannot switch models
   *  from inside the session". Addressing the frame removes the guesswork entirely. */
  webviewId?: string | null; }

export class ModelPolicy {
  constructor(private repo: string | null) {}

  /**
   * Workers whose footer chip is not the model their HANDOFF asks for. Since MP-001 this runs in
   * BOTH directions — a worker on Opus whose handoff says Sonnet is switched down, and a worker on
   * Sonnet whose handoff says Opus (or says nothing, and so gets the configured default) is
   * switched up. The premium floor is unchanged and is checked independently of the desired tier:
   * a worker on the orchestrator's tier is always a violation, whatever `desired` returns.
   *
   * The orchestrator is exempt by design — it is the one session allowed the expensive tier.
   * Between attempts a role is held off by `backoffFor(attempts)`, so a stuck session is retried
   * periodically instead of every tick — and never silently abandoned.
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
      // A target whose chip we cannot name is not enforceable: we could never tell whether the
      // switch took, so the role would be typed into for ever. Leave it alone and say nothing —
      // `desiredModel` only ever returns allow-listed ids, so this is a settings error, not a tick.
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
  // A worker on Sonnet that has looped back TWICE on one handoff is not being stubborn, it is on
  // the wrong tier: the orchestrator's difficulty judgement was wrong for this block. Rather than
  // wait for a human to notice, the tracker rewrites that handoff's `model:` line to Opus and lets
  // R2's next idle tick perform the switch — one mechanism, not a second injection path.
  //
  // "Looped back" is `status.json.status === "blocked"`, which is what the /loom skill instructs a
  // worker to write when it raises one (SKILL.md: `idle` (or `blocked` if you raised a loop-back)),
  // and what developer1 in fact wrote for GC-006's loop-back. A report is counted ONCE: the same
  // `blocked` status is re-read every tick, so a new report is only a new `updated_at`.

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
  // One append-only line per (role, handoff id), so that in a month the rubric can be judged on
  // what actually happened rather than on how it felt: did the Sonnet blocks loop back more, take
  // longer, land fewer tests? A line is closed when the handoff id CHANGES (the orchestrator wrote
  // the next brief over it) or when the role reports idle having handled that id. A line that
  // cannot be completed is written with nulls rather than skipped — a missing line is invisible,
  // and the gap it leaves would bias exactly the comparison this exists to make.

  /**
   * Advance the ledger for one role. Call every tick; it writes only at a transition.
   *
   * `contextPct` is the role's frame's own "% context used", which is CDP data and therefore cannot
   * be read from here — `extension.ts` passes what the tick measured, or null. It is recorded at the
   * instant the line CLOSES, because §19 judges size by where a handoff finished ("under 30 % was
   * too small; the bank threshold was too big"). Its one honest bound is stated at `appendLedger`.
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
    // A CLOSED line is kept, not deleted, until its handoff is replaced. The inbox still holds the
    // id the role just finished and status.json still says idle, so deleting the record here would
    // have the next tick re-open that same block and close it again — one line per tick for as long
    // as the worker sat idle. (Measured by R5's own test before this guard existed.)
    if (cur && cur.closed) return;
    if (!cur && id) {
      const want = desiredModel(this.repo, role, workerModel, allow);
      const seen = String(status.updated_at || "");
      // WL-005 · `started` USED TO BE `status.updated_at`, AND THAT IS THE WHOLE DEFECT.
      //
      // At the moment a block opens, the worker's status.json still carries the stamp of the LAST
      // thing it wrote — which belongs to the block BEFORE this one. So every duration measured the
      // gap from some earlier block's activity to this one's end. MEASURED on this bus 2026-09-15,
      // every record in model-ledger.jsonl:
      //
      //   CH-001-ack  started 2026-09-13T23:14:58Z   finished 2026-09-13T23:14:58Z   wall 0
      //   WL-001      started 2026-09-13T23:14:58Z   finished 2026-09-15T16:10:15Z   wall 2455.3
      //               ^^^ the SAME instant as the previous block's, two days earlier
      //
      // Not one record's `started` was its own: each was either the previous block's `started` or
      // its `finished`. And because `finished` came from the worker's clock while `started` came
      // from a different record's write, the pair could invert — ReciEats rendered -39.3 minutes.
      // A negative duration was the visible half of this; 2455 was the invisible half.
      //
      // The honest stamp is the one THIS process observed: the tick that first saw the handoff. It
      // is late by at most one tick and never belongs to another block. The worker's stamp is kept
      // beside it for diagnosis, never used for arithmetic.
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
      // `updated_at` and nothing else — the same rule R4's escalation counting is built on, and the
      // same failure if it is broken: counting reads would make this a tick counter, which measures
      // how long the window was open rather than how many turns the block took.
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
   * WHY THE PRUNE IS HERE AND NOT ANYWHERE EARLIER. `escalations` is working state: it exists to
   * count loop-backs until a decision is made, and once the ledger line is on disk the DURABLE
   * record of that decision is the line (`chosenBy: "escalated"`, `loopBacks: n`). Left behind, the
   * record grows one entry per handoff for ever in a file that is re-read and re-written on a 15
   * second tick. But it must not be dropped a moment before the line exists: the append can fail
   * (a full disk, a read-only mount) and this method has always swallowed that so a ledger write
   * cannot break a tick. Pruning unconditionally would then lose BOTH records — the only copy of
   * "this block was escalated after two loop-backs" — so the boolean this now returns is the whole
   * point, and the mutant for it makes the prune unconditional.
   *
   * `contextPctAtFinish` has an honest bound worth knowing before anyone averages it: the panel only
   * renders its "% context used" button above roughly 50 %, so a block that finished comfortably
   * reads null here. That is exactly §19's "finished under 30 % context was too small" band — so
   * null is not missing data in that case, it is the measurement: no percentage rendered means the
   * session was nowhere near full. A NUMBER here always means at least half full.
   */
  private appendLedger(rec: LedgerRecord, status: any, now: Date, st: PolicyState,
                       contextPct: number | null = null): boolean {
    if (!this.repo) return false;
    // WL-005 · BOTH ENDS COME FROM ONE CLOCK. `finished` was the worker's `status.updated_at` while
    // `started` came from a different record's write, so the two were not commensurable and their
    // difference was not a duration. This process's own clock bounds the block by its own observed
    // start and end, which is the property that has to hold. The worker's stamp is still recorded —
    // it is useful, it is just not an endpoint.
    const closedAt = now.toISOString();
    const workerStampAtFinish = status.updated_at ? String(status.updated_at) : null;
    // A record opened before WL-005 carries no `openedAt`, and there is NOTHING here from which its
    // real start could be recovered. `unmeasured` is a state, not a zero and not a guess: the line
    // says it has no duration rather than reporting one it cannot support.
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
    // THE CHOKEPOINT (MP-002, owner 2026-09-16). Every `/model` the extension types goes through
    // this one method, so the "never an orchestrator" rule is enforced HERE rather than only at the
    // call sites that happen to exist today. `check()` already exempts the orchestrator three ways;
    // this is the guarantee that survives a fourth caller being written next month by someone who
    // has not read `check()`. Both tests of it are cheap and neither needs a live panel:
    //   * by NAME — an owner-named role is never a worker, tagged or not (`isOwnerRole`);
    //   * by FRAME — the target frame is the one this project has TAGGED as its orchestrator.
    // Refusing is silent except to the caller: `done` is told, so `recordResult` keeps the reason,
    // and nothing is typed. The bus is read fresh each time because a tag can be set or moved
    // between ticks, and a stale answer here is exactly the injection this must not make.
    const owner = isOwnerRole(v.role);
    const tagged = getOrchestrator(v.repo || null);
    const ownFrame = !!(v.webviewId && tagged && tagged.webviewId && v.webviewId === tagged.webviewId);
    const taggedRole = !!(tagged && tagged.role && tagged.role === v.role);
    if (owner || ownFrame || taggedRole) {
      const why = owner ? "an owner-named role" : ownFrame ? "the tagged orchestrator's own frame" : "the tagged orchestrator";
      done?.(false, `refused: ${v.role} is ${why} — the model policy applies to non-orchestrators only`);
      return;
    }
    // --repo: role names are PROJECT-SCOPED. Without it a `/model` nudge for a bare name two buses
    // share (`developer`: Gaming + livegita) can resolve to the OTHER project's frame. See inject.ts.
    // --webview-id addresses the EXACT frame; --repo scopes the fallback. Both, because a role name
    // alone is ambiguous the moment two buses share it, and four of them now carry `developer1`.
    execFile("python3", [LOOM_CDP, "inject", "--role", v.role, "--message", `/model ${targetModel}`,
                         "--submit", ...(v.repo ? ["--repo", v.repo] : []),
                         ...(v.webviewId ? ["--webview-id", v.webviewId] : []),
                         ...senderArgs("model", v.repo)],
      { timeout: INJECT_TIMEOUT_MS },
      (err, stdout, stderr) => {
        // MS-001 R2: the injector exits 0 and prints `{'ok': False, ..., 'note': 'typed text not
        // confirmed in composer; NOT submitted'}` when the switch did NOT happen (measured against
        // the orchestrator's own frame 2026-09-14T00:04:57Z). `ok = !err` recorded that as
        // "switched". The verdict is read off the output, the same way injectTo reads it.
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
 * This is the fact the delegation detector is built on, and it is deliberately read from the ledger
 * rather than recomputed: `openedAt` is the tick that FIRST SAW a new handoff id in a role's inbox,
 * which is this process's own observation of the orchestrator handing work over. See WL-005's note
 * above for why the worker's own stamp is never used for arithmetic — it belongs to the block
 * before. Records with no `openedAt` (opened before WL-005) are skipped rather than guessed at.
 *
 * Only OPEN records are in `model-policy.json`; a closed one is appended to `model-ledger.jsonl` and
 * dropped here when the next handoff lands over it. That is correct for this purpose: a bus whose
 * last block closed and whose next has not been written has no dispatch newer than the one still
 * recorded, and a bus that has genuinely never dispatched returns null — which the caller renders as
 * "no handoff to any role has been seen", never as "long ago".
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
