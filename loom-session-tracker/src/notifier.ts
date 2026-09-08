// notifier.ts — ONE JOB: watch each worker's status.json on the bus and, when a worker FINISHES
// (working -> idle/blocked), notify the tagged orchestrator session so it can pick up the outbox
// without the human relaying. Notification = a toast for the human + an injected "check outbox"
// prompt into the orchestrator's composer via the battle-tested loom_cdp.py inject path.
// FAIL-PROOF: every read is try/caught; a missing/foreign status.json is just skipped; injection
// failures are logged to the bus (notify-debug.json), never thrown; per-(role,task) dedupe so a
// finish is announced exactly once.

import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { execFile } from "child_process";
import { boardRoles } from "./registry";
import { getOrchestrator } from "./orchestrator";

const LOOM_ROOT = path.join(os.homedir(), ".claude", "loom");
const LOOM_CDP = path.join(LOOM_ROOT, "loom_cdp.py");
const INJECT_TIMEOUT_MS = 60_000;

interface RoleStatus { status: string; current?: string; last_line?: string; updated_at?: string; }

/** What the notifier remembers between ticks — persisted on the bus so it survives an IDE restart
 *  (a worker that finished while the IDE was closed still gets announced) and so two windows
 *  watching the same repo can't both announce the same finish. */
interface NotifyState {
  prev: Record<string, { status: string; current: string }>;
  announced: string[];
  updatedAt?: string;
}

const ANNOUNCED_CAP = 500;

function stateFile(repo: string): string { return path.join(LOOM_ROOT, repo, "notify-state.json"); }

function loadState(repo: string): NotifyState | null {
  try {
    const st = JSON.parse(fs.readFileSync(stateFile(repo), "utf8"));
    if (st && typeof st === "object" && st.prev && typeof st.prev === "object") {
      return { prev: st.prev, announced: Array.isArray(st.announced) ? st.announced : [] };
    }
  } catch { /* none yet */ }
  return null;
}

/** Atomic, change-only, never throws. */
function saveState(repo: string, st: NotifyState): void {
  try {
    const next = JSON.stringify({ ...st, updatedAt: new Date().toISOString() }, null, 2);
    const f = stateFile(repo);
    try {
      const cur = JSON.parse(fs.readFileSync(f, "utf8"));
      // ignore updatedAt when deciding whether anything actually changed (no churn every tick)
      if (JSON.stringify({ prev: cur.prev, announced: cur.announced }) ===
          JSON.stringify({ prev: st.prev, announced: st.announced })) return;
    } catch { /* missing -> write */ }
    fs.mkdirSync(path.dirname(f), { recursive: true });
    const tmp = f + ".tmp." + process.pid;
    fs.writeFileSync(tmp, next);
    fs.renameSync(tmp, f);
  } catch { /* never throw from a tick */ }
}

export interface FinishEvent {
  repo: string;
  role: string;
  status: string;        // idle | blocked (the post-work state)
  task: string;          // handoff id ('' if none recorded)
  lastLine: string;
}

function readStatus(repo: string, role: string): RoleStatus | null {
  try {
    const s = JSON.parse(fs.readFileSync(path.join(LOOM_ROOT, repo, role, "status.json"), "utf8"));
    if (s && typeof s.status === "string") return s;
  } catch { /* no status yet */ }
  return null;
}

export class Notifier {
  constructor(private repo: string | null) {}

  /**
   * One pass. Returns the finish events detected (already deduped). Never throws.
   * State lives on the bus, so the comparison baseline survives an IDE restart: work that
   * completed while the editor was closed is announced on the first tick after it comes back.
   * Only a bus that has never been scanned baselines silently.
   */
  scan(): FinishEvent[] {
    if (!this.repo) return [];
    const orch = getOrchestrator(this.repo);
    const persisted = loadState(this.repo);
    const prev = persisted ? new Map(Object.entries(persisted.prev)) : null;
    const announced = new Set<string>(persisted?.announced ?? []);

    const events: FinishEvent[] = [];
    const cur: Record<string, { status: string; current: string }> = {};
    for (const role of boardRoles(this.repo)) {
      if (orch && role === orch.role) continue;    // never watch the orchestrator itself
      const s = readStatus(this.repo, role);
      if (!s) continue;
      cur[role] = { status: s.status, current: String(s.current || "") };
      // A role back at work clears its old announcements, so its NEXT finish is announced
      // even if it repeats the same handoff id.
      if (s.status === "working") {
        for (const k of Array.from(announced)) if (k.startsWith(role + "|")) announced.delete(k);
        continue;
      }
      const before = prev?.get(role);
      if (!before || before.status !== "working") continue;   // only working -> done counts
      const task = String(s.current || before.current || "");
      const key = `${role}|${task}|${s.status}`;
      if (announced.has(key)) continue;
      announced.add(key);
      events.push({
        repo: this.repo, role, status: s.status, task,
        lastLine: String(s.last_line || "").slice(0, 160),
      });
    }

    // Never-scanned bus: record the baseline, announce nothing.
    const firstEver = prev === null;
    const trimmed = Array.from(announced).slice(-ANNOUNCED_CAP);
    saveState(this.repo, { prev: cur, announced: firstEver ? [] : trimmed });
    return firstEver ? [] : events;
  }

  /** Inject a "check the outbox" prompt into the orchestrator's composer. Fire-and-forget. */
  notifyOrchestrator(ev: FinishEvent, done?: (ok: boolean, note: string) => void): void {
    const orch = getOrchestrator(ev.repo);
    if (!orch) { done?.(false, "no orchestrator tagged"); return; }
    const verb = ev.status === "blocked" ? "raised a loop-back (blocked)" : "finished";
    const msg =
      `[loom-notify] ${ev.role} ${verb}${ev.task ? ` on ${ev.task}` : ""}` +
      `${ev.lastLine ? ` — "${ev.lastLine}"` : ""}. ` +
      `Read ~/.claude/loom/${ev.repo}/${ev.role}/outbox.md and act on it.`;
    execFile(
      "python3", [LOOM_CDP, "inject", "--role", orch.role, "--message", msg, "--submit"],
      { timeout: INJECT_TIMEOUT_MS },
      (err, stdout, stderr) => {
        const ok = !err;
        this.debug({
          at: new Date().toISOString(), event: ev, orchestrator: orch.role, ok,
          out: String(stdout || "").slice(-400), err: String((err && err.message) || stderr || "").slice(-400),
        });
        done?.(ok, ok ? "injected" : String((err && err.message) || "inject failed"));
      });
  }

  private debug(obj: unknown): void {
    try {
      fs.writeFileSync(path.join(LOOM_ROOT, "notify-debug.json"), JSON.stringify(obj, null, 2));
    } catch { /* ignore */ }
  }
}
