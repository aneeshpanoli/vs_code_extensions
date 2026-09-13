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

// ── the RETURN ADDRESS (user rule, 2026-09-12) ─────────────────────────────────────────────────
// "Any time any session communicates with another, it should always broadcast its ID and how to
// communicate back." loom_cdp.py prefixes every non-command message with a header line; this side
// supplies who the extension is and how a session should answer it, per kind of message — because
// the extension reads no chat, and a session told to "reply" to it would otherwise talk to nobody.
let senderWindow: string | null = null;
/** The workspace folder this window is scoped to; set once at activation. */
export function setSenderWindow(root: string | null): void { senderWindow = root || null; }

export const REPLY_FOR: Record<string, string> = {
  "notify-debug.json":  "act on the outbox named here; this tool reads no chat",
  "stall-debug.json":   "ring the role named here; this tool reads no chat",
  "context-debug.json": "write the memory file named here; nothing else is read",
  "restart-debug.json": "for any missing role tab, write ~/.claude/loom/<repo>/open-requests.json",
  "resume":             "keep status.json current; nothing else is read",
  "model":              "none needed — your footer is re-read every tick",
};

/** argv fragment naming the sender and the reply channel, for every inject the extension makes. */
export function senderArgs(kind: string, repo: string | null): string[] {
  const who = `loom-session-tracker (window ${senderWindow || "(no folder)"}${repo ? `, project ${repo}` : ""})`;
  const how = (REPLY_FOR[kind] || "none — this is a tool, not a session").replace("<repo>", repo || "<repo>");
  return ["--from", who, "--reply", how];
}

/**
 * Type `message` into the target's composer and submit it. Never throws; `done` always gets a verdict.
 * `debugName` is a file under ~/.claude/loom that records the last attempt (out/err truncated), so a
 * silent failure is diagnosable after the fact.
 */
export function injectTo(target: InjectTarget, message: string, debugName: string,
                         done?: (ok: boolean, note: string) => void): void {
  const args = [LOOM_CDP, "inject", "--role", target.role, "--message", message, "--submit",
                ...senderArgs(debugName, target.repo ?? null)];
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
