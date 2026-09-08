// models.ts — ONE JOB: keep the expensive model for the orchestrator only.
//
// WHY: every session draws on ONE shared usage pool, and the top tier costs ~2x the Opus tier per
// token ($10/$50 vs $5/$25 per MTok). Workers doing mechanical handoff work do not need it; the
// orchestrator, which reasons over the whole board, may.
//
// HOW A SESSION'S MODEL IS READ (measured live, 2026-09-08): the composer footer renders as
//   ... | Remote Control | Opus 5 | Medium | Bypass permissions
// i.e. model, then effort, then the permission chip. Matching that whole run — anchored on the
// permission chip and taking the LAST match — means a conversation that merely *mentions* a model
// name cannot be mistaken for the footer.
//
// HOW IT IS CORRECTED: inject `/model <id>` into the offending session, the same way `/loom <role>`
// binds one. Corrections are deduped on the bus so a session is nudged once per drift, not every tick.

import * as fs from "fs";
import * as os from "os";
import * as path from "path";
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

export interface ModelInfo { model: string; effort: string | null; }

/** The model a live panel is currently running, read off its footer. null if not determinable. */
export function detectModel(text: string | null | undefined): ModelInfo | null {
  const tail = String(text || "").slice(-FOOTER_CHARS);
  if (!tail) return null;
  FOOTER_RE.lastIndex = 0;
  let m: RegExpExecArray | null, last: RegExpExecArray | null = null;
  while ((m = FOOTER_RE.exec(tail)) !== null) last = m;   // the LAST match is the footer
  if (!last) return null;
  return { model: last[1], effort: last[2] || null };
}

export function isPremium(model: string | null | undefined, premium: string[] = DEFAULT_PREMIUM): boolean {
  if (!model) return false;
  return premium.some((p) => p.toLowerCase() === model.toLowerCase());
}

// ── dedupe: which roles we have already corrected, so we nudge once per drift ───────────────
interface PolicyState { corrected: Record<string, { model: string; at: string }>; updatedAt?: string; }

function stateFile(repo: string): string { return path.join(LOOM_ROOT, repo, "model-policy.json"); }

function loadState(repo: string): PolicyState {
  try {
    const st = JSON.parse(fs.readFileSync(stateFile(repo), "utf8"));
    if (st && st.corrected && typeof st.corrected === "object") return { corrected: st.corrected };
  } catch { /* none yet */ }
  return { corrected: {} };
}

function saveState(repo: string, st: PolicyState): void {
  try {
    const f = stateFile(repo);
    try {
      const cur = JSON.parse(fs.readFileSync(f, "utf8"));
      if (JSON.stringify(cur.corrected) === JSON.stringify(st.corrected)) return;   // change-only
    } catch { /* missing -> write */ }
    fs.mkdirSync(path.dirname(f), { recursive: true });
    const tmp = f + ".tmp." + process.pid;
    fs.writeFileSync(tmp, JSON.stringify({ ...st, updatedAt: new Date().toISOString() }, null, 2));
    fs.renameSync(tmp, f);
  } catch { /* never throw from a tick */ }
}

export interface ModelViolation { repo: string; role: string; model: string; }

export class ModelPolicy {
  constructor(private repo: string | null) {}

  /**
   * Workers found on a premium model. The orchestrator is exempt by design — it is the one session
   * allowed the expensive tier. A role already corrected for the same model is not re-reported
   * until it goes back to a compliant model (so we nudge once per drift, not every tick).
   */
  check(models: Map<string, ModelInfo | null>, orchestratorRole: string | null,
        liveRoles: Set<string>, premium: string[] = DEFAULT_PREMIUM): ModelViolation[] {
    if (!this.repo) return [];
    const st = loadState(this.repo);
    const out: ModelViolation[] = [];
    for (const [role, info] of models) {
      if (!info || !liveRoles.has(role)) continue;
      if (orchestratorRole && role === orchestratorRole) continue;      // the exempt session
      if (!isPremium(info.model, premium)) { delete st.corrected[role]; continue; }
      const already = st.corrected[role];
      if (already && already.model.toLowerCase() === info.model.toLowerCase()) continue;
      st.corrected[role] = { model: info.model, at: new Date().toISOString() };
      out.push({ repo: this.repo, role, model: info.model });
    }
    saveState(this.repo, st);
    return out;
  }

  /** Switch a worker back to the default model by injecting `/model <id>` into its composer. */
  enforce(v: ModelViolation, targetModel: string, done?: (ok: boolean, note: string) => void): void {
    execFile("python3", [LOOM_CDP, "inject", "--role", v.role, "--message", `/model ${targetModel}`, "--submit"],
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
