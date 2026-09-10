// inject.ts — ONE JOB: put a message in a session's composer, through the one battle-tested path
// (~/.claude/loom/loom_cdp.py inject). Fire-and-forget, never throws, always logs what happened.
//
// WHY THIS EXISTS AS ITS OWN MODULE: three call sites (finish notifier, stall alert, context memory) all
// need to reach the ORCHESTRATOR, and reaching the orchestrator by ROLE does not work. loom_cdp.py's
// find_role() carries a deliberate self-guard: any frame whose text detects as product-owner is dropped
// from the candidate rows, and frames absent from the targetmap are dropped too. That guard exists because
// content-based matching once injected a worker's prompt into the orchestrator's own tab (the "self-woke"
// recorded in gaming/board.json). It also means `inject --role product-owner` can never land.
//
// So the orchestrator is addressed by its exact webviewId instead — the stable UUID the tracker already
// reads off the frame's shell URL, recorded on the tag. That is strictly safer than matching on content:
// there is nothing to misidentify. `--webview-id` tells loom_cdp.py the caller knows the frame, and the
// content self-guard steps aside for that ONE frame only.
//
// Role targeting is still used for workers (`/model ...`, resume nudges), where the guard is correct.

import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { execFile } from "child_process";

const LOOM_ROOT = path.join(os.homedir(), ".claude", "loom");
const LOOM_CDP = path.join(LOOM_ROOT, "loom_cdp.py");
export const INJECT_TIMEOUT_MS = 60_000;

export interface InjectTarget {
  role: string;
  /** Exact frame, when known. Required to reach the orchestrator; optional for a worker. */
  webviewId?: string | null;
  /**
   * The project this role belongs to. ROLE NAMES ARE PROJECT-SCOPED — the bus directory namespaces
   * them — so a bare name that two buses share (`developer`: Gaming + livegita; `productowner`:
   * Gaming + shwab_docker, both measured live 2026-09-09) is ambiguous on its own.
   *
   * loom_cdp.py's `_role_repo()` used to resolve such a name by scanning every board and taking the
   * FIRST hit, and sorted() puts `Gaming` first — so a livegita binding was written to Gaming's bus.
   * That is the 2026-09-08 LG-001 misroute, and the reason livegita's developer was ever renamed
   * `gitadeveloper`. It now refuses an ambiguous bare name instead of guessing, and takes `--repo`.
   *
   * One project per editor window, so this window always knows the answer — pass it and the prefix
   * workaround is unnecessary.
   */
  repo?: string | null;
}

export interface InjectResult { ok: boolean; note: string; }

/**
 * Type `message` into the target's composer and submit it. Never throws; `done` always gets a verdict.
 * `debugName` is a file under ~/.claude/loom that records the last attempt (out/err truncated), so a
 * silent failure is diagnosable after the fact.
 */
export function injectTo(target: InjectTarget, message: string, debugName: string,
                         done?: (ok: boolean, note: string) => void): void {
  const args = [LOOM_CDP, "inject", "--role", target.role, "--message", message, "--submit"];
  if (target.webviewId) args.push("--webview-id", target.webviewId);
  if (target.repo) args.push("--repo", target.repo);
  execFile("python3", args, { timeout: INJECT_TIMEOUT_MS }, (err, stdout, stderr) => {
    const out = String(stdout || "");
    // loom_cdp.py prints a result dict and exits 0 even when it could not find the frame; a report that
    // says ok=False is a failure, not a success.
    const reportedFail = /'ok':\s*False|"ok":\s*false/i.test(out);
    const ok = !err && !reportedFail;
    const note = ok ? "injected"
      : reportedFail ? (/'note':\s*'([^']+)'/.exec(out)?.[1] || "inject reported not ok")
      : String((err && err.message) || stderr || "inject failed");
    try {
      fs.writeFileSync(path.join(LOOM_ROOT, debugName), JSON.stringify({
        at: new Date().toISOString(), target, ok, note,
        message: message.slice(0, 300),
        out: out.slice(-400), err: String((err && err.message) || stderr || "").slice(-400),
      }, null, 2));
    } catch { /* a failed log must never break the caller */ }
    done?.(ok, note);
  });
}
