// orchestrator.ts — ONE JOB: persist which role is THE orchestrator for a repo bus.
// Stored on the bus itself (~/.claude/loom/<repo>/orchestrator.json) so the tag survives
// window reloads and is visible to any tooling, not just this extension. fs-only, no vscode.

import * as fs from "fs";
import * as os from "os";
import * as path from "path";

const LOOM_ROOT = path.join(os.homedir(), ".claude", "loom");

// The orchestrator/PO session is NOT a worker role — it never appears in a board.json roster and the
// tracker excludes it from tracked agents. These canonical names must therefore always be offered as
// tag candidates independently, and loom_cdp.py's detect_role recognizes them for injection.
export const ORCHESTRATOR_CANDIDATES = ["product-owner", "productowner"];

export interface OrchestratorTag {
  role: string;
  taggedAt: string;   // ISO
  /** The exact frame the orchestrator is running in. Injection into the orchestrator MUST address this
   *  id: loom_cdp.py's find_role() drops any frame that content-detects as product-owner (the self-woke
   *  guard), so `--role product-owner` can never land. Refreshed each tick while it is detectable, and
   *  left alone when it is not — a stale id is better than none, and the injector reports a miss. */
  webviewId?: string | null;
}

function file(repo: string): string {
  return path.join(LOOM_ROOT, repo, "orchestrator.json");
}

export function getOrchestrator(repo: string | null): OrchestratorTag | null {
  if (!repo) return null;
  try {
    const t = JSON.parse(fs.readFileSync(file(repo), "utf8"));
    if (t && typeof t.role === "string" && t.role) return t;
  } catch { /* untagged */ }
  return null;
}

export function setOrchestrator(repo: string, role: string | null, webviewId?: string | null): void {
  const f = file(repo);
  if (role === null) {
    try { fs.unlinkSync(f); } catch { /* already gone */ }
    return;
  }
  fs.mkdirSync(path.dirname(f), { recursive: true });
  const tmp = f + ".tmp." + process.pid;
  fs.writeFileSync(tmp, JSON.stringify(
    { role, taggedAt: new Date().toISOString(), webviewId: webviewId ?? null }, null, 2));
  fs.renameSync(tmp, f);
}

/** Record the frame the orchestrator is in, keeping the tag otherwise intact. No-op when untagged or
 *  when nothing changed, so a tick never churns the file. */
export function setOrchestratorFrame(repo: string, webviewId: string | null): void {
  const cur = getOrchestrator(repo);
  if (!cur || !webviewId || cur.webviewId === webviewId) return;
  const f = file(repo);
  try {
    const tmp = f + ".tmp." + process.pid;
    fs.writeFileSync(tmp, JSON.stringify({ ...cur, webviewId }, null, 2));
    fs.renameSync(tmp, f);
  } catch { /* a frame refresh must never throw from a tick */ }
}
