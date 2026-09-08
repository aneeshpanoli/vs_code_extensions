// limits.ts — ONE JOB: notice when a Loom session is blocked by a usage limit, and wake it back up
// once the limit lifts.
//
// WHAT THE UI ACTUALLY SHOWS (read out of the shipped webview bundle, 2.1.263 — not guessed):
//   blocked   : "You've hit your <label> · resets in 2h"      (status "rejected")
//   winding up: "Usage limit reached · finishing up"           (grace, current turn completes)
//   covered   : "Usage limit reached · a little extra on us, then your credits"
//   warning   : "You've used 85% of your <label> · resets ..." / "Approaching <label> ..."
//   labels    : session limit | weekly limit | weekly Opus limit | weekly Sonnet limit |
//               Fable limit | usage credit limit
// The reset time is rendered only as a COARSE relative string ("soon" / "in 45m" / "in 2h" / "in
// 3d"), floored — so it is good for display but not for scheduling.
//
// HOW WE RESUME: not by trusting that ETA, but by watching the banner DISAPPEAR. When the limit
// lifts the banner is removed, which is an exact signal. We require it to stay clear for a couple
// of consecutive ticks so a momentary partial DOM read cannot trigger a false resume.
//
// FALSE-POSITIVE GUARD: a frame's text is the whole conversation, and a conversation can *discuss*
// limits (this one does). The banner lives at the bottom next to the composer, so we only ever look
// at the tail of the rendered text.

import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { execFile } from "child_process";

const LOOM_ROOT = path.join(os.homedir(), ".claude", "loom");
const LOOM_CDP = path.join(LOOM_ROOT, "loom_cdp.py");
const INJECT_TIMEOUT_MS = 60_000;

/** Only the end of the panel text can hold the banner (it sits by the composer). */
export const TAIL_CHARS = 1500;
/** Consecutive clear ticks required before we believe a limit really lifted. */
export const CLEAR_TICKS_REQUIRED = 2;

const APOS = "['‘’´]";
const BLOCKED_RE = new RegExp("You" + APOS + "?ve hit your ([^\\n·]+?)\\s*(?:·|\\n|$)", "i");
const GRACE_RE = /Usage limit reached\s*·\s*([^\n·]+)/i;
const RESETS_RE = /resets\s+(?:in\s+)?(?:(\d+)\s*([mhd])|(soon))/i;

export interface LimitInfo {
  /** True when the session is blocked or winding down — i.e. it cannot keep working. */
  limited: boolean;
  /** "session limit", "weekly limit", ... or the grace phrase. */
  kind: string;
  /** The UI's own coarse text, e.g. "in 2h" — for display only. */
  etaText: string | null;
  /** Earliest plausible reset (ms epoch) derived from that coarse text, or null. */
  notBefore: number | null;
}

/** Parse the coarse "resets in 2h" text into a lower-bound timestamp. */
export function parseEta(tail: string, now = Date.now()): { etaText: string | null; notBefore: number | null } {
  const m = RESETS_RE.exec(tail);
  if (!m) return { etaText: null, notBefore: null };
  if (m[3]) return { etaText: "soon", notBefore: now + 60_000 };
  const n = parseInt(m[1], 10);
  const unit = m[2].toLowerCase();
  const ms = unit === "m" ? n * 60_000 : unit === "h" ? n * 3_600_000 : n * 86_400_000;
  return { etaText: `in ${n}${unit}`, notBefore: now + ms };
}

/** Read a limit banner out of a panel's rendered text. null = no banner (session is fine). */
export function detectLimit(text: string | null | undefined, now = Date.now()): LimitInfo | null {
  const tail = String(text || "").slice(-TAIL_CHARS);
  if (!tail) return null;
  const eta = parseEta(tail, now);
  const blocked = BLOCKED_RE.exec(tail);
  if (blocked) return { limited: true, kind: blocked[1].trim(), ...eta };
  const grace = GRACE_RE.exec(tail);
  if (grace) {
    const phrase = grace[1].trim();
    // "finishing up" = about to stop. "a little extra on us..." = still running on credits.
    return { limited: /finishing/i.test(phrase), kind: "usage limit (" + phrase + ")", ...eta };
  }
  return null;   // "You've used 85% of ..." / "Approaching ..." are warnings, not blocks
}

// ── persistence: which roles are limited, so a resume survives an IDE restart ───────────────
interface LimitRecord { since: string; kind: string; etaText: string | null; notBefore: number | null; clearTicks: number; }
interface LimitState { roles: Record<string, LimitRecord>; updatedAt?: string; }

function stateFile(repo: string): string { return path.join(LOOM_ROOT, repo, "limit-state.json"); }

export function loadLimitState(repo: string): LimitState {
  try {
    const st = JSON.parse(fs.readFileSync(stateFile(repo), "utf8"));
    if (st && st.roles && typeof st.roles === "object") return { roles: st.roles };
  } catch { /* none yet */ }
  return { roles: {} };
}

function saveLimitState(repo: string, st: LimitState): void {
  try {
    const f = stateFile(repo);
    const next = JSON.stringify({ roles: st.roles, updatedAt: new Date().toISOString() }, null, 2);
    try {
      const cur = JSON.parse(fs.readFileSync(f, "utf8"));
      if (JSON.stringify(cur.roles) === JSON.stringify(st.roles)) return;   // change-only
    } catch { /* missing -> write */ }
    fs.mkdirSync(path.dirname(f), { recursive: true });
    const tmp = f + ".tmp." + process.pid;
    fs.writeFileSync(tmp, next);
    fs.renameSync(tmp, f);
  } catch { /* never throw from a tick */ }
}

export interface ResumeEvent { repo: string; role: string; kind: string; blockedSince: string; }

/**
 * Tracks which roles are limited and emits a ResumeEvent when a limit lifts.
 * State lives on the bus, so a session limited before an IDE restart is still resumed after it.
 */
export class LimitWatcher {
  constructor(private repo: string | null) {}

  /** `current` = role -> LimitInfo for roles seen this tick (absent/null = not limited). */
  scan(current: Map<string, LimitInfo | null>, liveRoles: Set<string>): ResumeEvent[] {
    if (!this.repo) return [];
    const st = loadLimitState(this.repo);
    const events: ResumeEvent[] = [];
    const nowIso = new Date().toISOString();

    for (const [role, info] of current) {
      if (info && info.limited) {
        const prev = st.roles[role];
        st.roles[role] = {
          since: prev ? prev.since : nowIso,
          kind: info.kind, etaText: info.etaText, notBefore: info.notBefore, clearTicks: 0,
        };
      }
    }
    for (const role of Object.keys(st.roles)) {
      const info = current.get(role);
      const stillLimited = !!(info && info.limited);
      if (stillLimited) continue;
      // Only judge a role we can actually see right now; an unseen role keeps waiting.
      if (!liveRoles.has(role)) continue;
      const rec = st.roles[role];
      rec.clearTicks = (rec.clearTicks || 0) + 1;
      if (rec.clearTicks >= CLEAR_TICKS_REQUIRED) {
        events.push({ repo: this.repo, role, kind: rec.kind, blockedSince: rec.since });
        delete st.roles[role];
      }
    }
    saveLimitState(this.repo, st);
    return events;
  }

  /** Roles currently believed limited (for the UI), regardless of this tick's visibility. */
  limitedRoles(): Record<string, LimitRecord> {
    return this.repo ? loadLimitState(this.repo).roles : {};
  }

  /** Wake the session back up by injecting a prompt into its composer. Fire-and-forget. */
  resume(ev: ResumeEvent, message: string, done?: (ok: boolean, note: string) => void): void {
    execFile("python3", [LOOM_CDP, "inject", "--role", ev.role, "--message", message, "--submit"],
      { timeout: INJECT_TIMEOUT_MS },
      (err, stdout, stderr) => {
        const ok = !err;
        try {
          fs.writeFileSync(path.join(LOOM_ROOT, "resume-debug.json"), JSON.stringify({
            at: new Date().toISOString(), event: ev, ok,
            out: String(stdout || "").slice(-400),
            err: String((err && err.message) || stderr || "").slice(-400),
          }, null, 2));
        } catch { /* ignore */ }
        done?.(ok, ok ? "resumed" : String((err && err.message) || "inject failed"));
      });
  }
}
