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
// THE OTHER DIRECTION (user direction 2026-09-13: "new tabs should always be Opus 5, not Fable;
// only the orchestrator is supposed to be on Fable 5.1"): the default model pinned in
// ~/.claude/settings.json is the cheaper tier, so every spawned or restored tab starts there, and
// the TAGGED orchestrator is promoted to the premium tier when it is seen on anything else.

import * as fs from "fs";
import * as os from "os";
import * as path from "path";

import { isOwnerRole } from "./naming";
import { senderArgs } from "./inject";
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
// enforces it; the ledger judges the rubric a month later. The orchestrator switching ITSELF is not
// part of this — `checkOrchestrator` below is unchanged and still reads the settings.
//
// A frontmatter the tracker cannot read changes NOTHING: no file, no block, no `model:` line, a
// malformed block, a premium id, an unknown id — every one of those falls back to the configured
// `workerModel`, and the two that are a REQUEST rather than an absence say so in tracker-debug.json.
// This is principle 16 pointed the other way: a read that cannot answer must not be read as licence.

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

function inboxFile(repo: string, role: string): string {
  return path.join(LOOM_ROOT, repo, role, "inbox.md");
}

/** The `id:` of the handoff currently sitting in a role's inbox, or null. */
export function handoffId(repo: string | null, role: string): string | null {
  if (!repo) return null;
  try { return frontmatter(fs.readFileSync(inboxFile(repo, role), "utf8"))["id"] || null; }
  catch { return null; }
}

/** A role's status.json, or null when it is absent or unreadable. */
function readStatus(repo: string, role: string): any | null {
  try {
    const d = JSON.parse(fs.readFileSync(path.join(LOOM_ROOT, repo, role, "status.json"), "utf8"));
    return d && typeof d === "object" ? d : null;
  } catch { return null; }
}

function numOrNull(v: any): number | null {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
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
  const raw = frontmatter(text)["model"];
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
  loopBacks: number; testsBefore: number | null;
  /** Its line has been appended. The record survives until the handoff id changes, purely so the
   *  same block is not written again on every idle tick that follows. */
  closed?: boolean; }
interface PolicyState { pending: Record<string, PolicyRecord>;
  escalations?: Record<string, EscalationRecord>;
  ledger?: Record<string, LedgerRecord>;
  updatedAt?: string; }

function stateFile(repo: string): string { return path.join(LOOM_ROOT, repo, "model-policy.json"); }

function loadState(repo: string): PolicyState {
  try {
    const st = JSON.parse(fs.readFileSync(stateFile(repo), "utf8"));
    // A pre-0.7.2 file carries {corrected}; ignore it so those roles are re-checked (the fix).
    if (st && st.pending && typeof st.pending === "object") {
      return { pending: st.pending,
               escalations: (st.escalations && typeof st.escalations === "object") ? st.escalations : {},
               ledger: (st.ledger && typeof st.ledger === "object") ? st.ledger : {} };
    }
  } catch { /* none yet */ }
  return { pending: {}, escalations: {}, ledger: {} };
}

function saveState(repo: string, st: PolicyState): void {
  try {
    const f = stateFile(repo);
    const same = (a: any, b: any) => JSON.stringify(a || {}) === JSON.stringify(b || {});
    try {
      const cur = JSON.parse(fs.readFileSync(f, "utf8"));
      // change-only, across EVERY section — comparing `pending` alone would drop an escalation
      // count or a ledger line whose tick happened not to move a pending record.
      if (same(cur.pending, st.pending) && same(cur.escalations, st.escalations) && same(cur.ledger, st.ledger)) return;
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

  /**
   * The ORCHESTRATOR found on a non-premium model — the mirror of `check()`. With the default model
   * pinned to the cheaper tier, a restarted or restored orchestrator comes up on it; this puts it
   * back. Same backoff, same acknowledgement rule, same state file (under the key `<role>`, which a
   * worker can never share: an owner-named role is never in `check()`'s map).
   */
  checkOrchestrator(orchestratorRole: string | null, orchestratorFrame: string | null,
                    info: ModelInfo | null, busy: boolean, premium: string[] = DEFAULT_PREMIUM,
                    now = Date.now(), target = "claude-fable-5-1[1m]"): ModelViolation | null {
    if (!this.repo || !orchestratorRole || !orchestratorFrame || !info || busy) return null;
    const st = loadState(this.repo);
    const key = orchestratorRole;
    if (isPremium(info.model, premium)) { if (st.pending[key]) { delete st.pending[key]; saveState(this.repo, st); } return null; }
    if (info.acknowledged && isPremium(info.acknowledged, premium)) return null;   // switched, chip lagging
    const rec = st.pending[key];
    const sameModel = !!rec && rec.model.toLowerCase() === info.model.toLowerCase();
    if (sameModel && now < rec.nextAttempt) return null;
    const attempts = (sameModel ? rec.attempts : 0) + 1;
    st.pending[key] = { model: info.model, target, attempts, nextAttempt: now + backoffFor(attempts),
                        lastAttemptAt: new Date(now).toISOString() };
    saveState(this.repo, st);
    return { repo: this.repo, role: orchestratorRole, model: info.model, attempt: attempts,
             target, chosenBy: "default", webviewId: orchestratorFrame };
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

  /** Advance the ledger for one role. Call every tick; it writes only at a transition. */
  ledgerTick(role: string, workerModel = "claude-opus-5", allow: string[] = DEFAULT_WORKER_MODELS,
             now = new Date()): void {
    if (!this.repo) return;
    const id = handoffId(this.repo, role);
    const status = readStatus(this.repo, role) || {};
    const st = loadState(this.repo);
    const led = (st.ledger = st.ledger || {});
    let cur = led[role];
    let dirty = false;
    if (cur && cur.id !== id) {                       // the next handoff landed over this one
      if (!cur.closed) this.appendLedger(cur, status, now, st);
      delete led[role]; cur = undefined as any; dirty = true;
    }
    // A CLOSED line is kept, not deleted, until its handoff is replaced. The inbox still holds the
    // id the role just finished and status.json still says idle, so deleting the record here would
    // have the next tick re-open that same block and close it again — one line per tick for as long
    // as the worker sat idle. (Measured by R5's own test before this guard existed.)
    if (cur && cur.closed) return;
    if (!cur && id) {
      const want = desiredModel(this.repo, role, workerModel, allow);
      led[role] = { id, role, model: want.model,
                    chosenBy: this.wasEscalated(id) ? "escalated" : want.chosenBy,
                    started: String(status.updated_at || now.toISOString()),
                    loopBacks: 0, testsBefore: numOrNull(status.tests_before ?? status.testsBefore) };
      dirty = true;
    } else if (cur) {
      // keep the in-progress line current: the tier may have been escalated mid-handoff, and the
      // loop-back count lives in the escalation record that R4 maintains.
      const want = desiredModel(this.repo, role, workerModel, allow);
      const chosenBy = this.wasEscalated(id) ? "escalated" : want.chosenBy;
      const loopBacks = ((st.escalations || {})[id!] || { blocked: 0 }).blocked;
      if (cur.model !== want.model || cur.chosenBy !== chosenBy || cur.loopBacks !== loopBacks) {
        cur.model = want.model; cur.chosenBy = chosenBy; cur.loopBacks = loopBacks; dirty = true;
      }
      // finished: the role says it is idle having handled exactly this id
      if (String(status.status || "") === "idle" && String(status.last_handled || "") === id) {
        this.appendLedger(cur, status, now, st);
        cur.closed = true; dirty = true;
      }
    }
    if (dirty) saveState(this.repo, st);
  }

  private appendLedger(rec: LedgerRecord, status: any, now: Date, st: PolicyState): void {
    if (!this.repo) return;
    const line = {
      id: rec.id, role: rec.role, model: rec.model || null,
      chosenBy: this.wasEscalated(rec.id) ? "escalated" : (rec.chosenBy || null),
      started: rec.started || null,
      finished: String(status.updated_at || now.toISOString()),
      loopBacks: ((st.escalations || {})[rec.id] || { blocked: rec.loopBacks || 0 }).blocked,
      testsBefore: rec.testsBefore,
      testsAfter: numOrNull(status.tests_after ?? status.testsAfter),
    };
    try {
      const f = path.join(LOOM_ROOT, this.repo, "model-ledger.jsonl");
      fs.mkdirSync(path.dirname(f), { recursive: true });
      fs.appendFileSync(f, JSON.stringify(line) + "\n");    // append-only: never read, never rewritten
    } catch { /* a ledger write must never break a tick */ }
  }

  /** Switch a role onto the model it is owed by injecting `/model <id>` into its composer. The id
   *  travels ON the violation (per-role since MP-001); the parameter only overrides it. */
  enforce(v: ModelViolation, targetModel: string = v.target, done?: (ok: boolean, note: string) => void): void {
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
        const ok = !err;
        try {
          fs.writeFileSync(path.join(LOOM_ROOT, "model-policy-debug.json"), JSON.stringify({
            at: new Date().toISOString(), violation: v, target: targetModel, ok,
            out: String(stdout || "").slice(-400),
            err: String((err && err.message) || stderr || "").slice(-400),
          }, null, 2));
        } catch { /* ignore */ }
        done?.(ok, ok ? "switched" : String((err && err.message) || "inject failed"));
      });
  }
}
