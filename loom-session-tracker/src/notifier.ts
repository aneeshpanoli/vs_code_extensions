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
  // role -> last seen {status,current}; null until the first baseline pass
  private prev: Map<string, { status: string; current: string }> | null = null;
  // dedupe: "role|task|status" keys already announced
  private announced = new Set<string>();

  constructor(private repo: string | null) {}

  /** One pass. Returns the finish events detected (already deduped). Never throws. */
  scan(): FinishEvent[] {
    if (!this.repo) return [];
    const orch = getOrchestrator(this.repo);
    const events: FinishEvent[] = [];
    const cur = new Map<string, { status: string; current: string }>();
    for (const role of boardRoles(this.repo)) {
      if (orch && role === orch.role) continue;    // never watch the orchestrator itself
      const s = readStatus(this.repo, role);
      if (!s) continue;
      cur.set(role, { status: s.status, current: String(s.current || "") });
      const before = this.prev?.get(role);
      const finished = before && before.status === "working" && s.status !== "working";
      if (!finished) continue;
      const task = String(s.current || before!.current || "");
      const key = `${role}|${task}|${s.status}`;
      if (this.announced.has(key)) continue;
      this.announced.add(key);
      events.push({
        repo: this.repo, role, status: s.status, task,
        lastLine: String(s.last_line || "").slice(0, 160),
      });
    }
    // Baseline on the very first pass: record states, announce nothing (don't fire for
    // work that finished before this window existed).
    const first = this.prev === null;
    this.prev = cur;
    return first ? [] : events;
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
