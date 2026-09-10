// coordinator.ts — ONE JOB: spawn / retire role sessions, behind HARD boundaries.
//
// THE SELF-DELETION BOUNDARY (structural, not a bolt-on):
//   retire() can ONLY act on a role that is currently a CONFIRMED, LIVE, tracked agent of THIS project.
//   The orchestrator is NEVER a tracked agent (the classifier excludes it: distinctRoles≥2 / owner), so it
//   is impossible for retire() to receive the orchestrator as a target. Plus explicit owner-role refusal.
//   Nothing here auto-fires: spawn/retire run only on an explicit command.

import * as vscode from "vscode";
import { Tracker } from "./tracker";
import { closeWebview } from "./cdp";
import { isLocked } from "./locks";
import { deleteSession } from "./deleter";
import { roleToRepo } from "./registry";
import { isOwnerRole } from "./naming";

// The owner test is naming.ts's `isOwnerRole`, NOT a literal set. Measured 2026-09-09: this file
// carried its own `new Set(["product-owner","productowner"])`, so livegita's orchestrator — named
// `po` — passed every refusal below and was a legal spawn/retire/delete target.
// HARD CAP: at most this many sessions OPEN at once, INCLUDING the orchestrator — so orchestrator +
// (cap - 1) agents. spawn() refuses past it.
//
// Raised from 3 to 5 on 2026-09-10 to make room for numbered role instances (developer1/2/3).
//
// NOT the same limit as ring.py's `CAP`, and the difference matters: this one counts sessions that
// are OPEN, while ring.py caps how many may be MID-TURN simultaneously (it staggers activations and
// refuses to light up more at once). ring.py stays at 2 deliberately — concurrency is what costs
// memory, and systemd-oomd killed the editor's whole cgroup twice on this machine when the agent
// fleet ran hot. Five sessions may sit open; at most two of them work at the same time.
export const MAX_ACTIVE_TOTAL = 5;

export class Coordinator {
  /** `maxActive` overrides the cap (the `loomSessionTracker.maxActiveSessions` setting). */
  constructor(private tracker: Tracker, private repo: string | null,
              private maxActive: number = MAX_ACTIVE_TOTAL) {}

  /** The cap in force for this window. */
  cap(): number {
    const n = Math.floor(Number(this.maxActive));
    return Number.isFinite(n) && n >= 2 ? n : MAX_ACTIVE_TOTAL;   // never below orchestrator + 1
  }

  /** Roles of THIS project that are NOT currently live — candidates to spawn. */
  spawnableRoles(rosterRoles: string[]): string[] {
    const live = new Set(this.tracker.view().filter((a) => a.liveness === "live").map((a) => a.role));
    return rosterRoles.filter((r) => !isOwnerRole(r) && !live.has(r)).sort();
  }

  /** Confirmed LIVE agents of THIS project — the only things retire() will touch. */
  retirableAgents(): { role: string; webviewId: string }[] {
    return this.tracker.view()
      .filter((a) => a.liveness === "live" && (!this.repo || a.repo === this.repo) && !isOwnerRole(a.role))
      .map((a) => ({ role: a.role, webviewId: a.webviewId }));
  }

  /** Live agents of THIS project + 1 for the orchestrator = current active total. */
  activeTotal(): number {
    return this.tracker.view().filter((a) => a.liveness === "live" && (!this.repo || a.repo === this.repo)).length + 1;
  }

  /** Open a fresh session; the caller binds it with `/loom <role>`. Enforces the active-session cap. */
  async spawn(role: string): Promise<string> {
    if (isOwnerRole(role)) throw new Error(`refuse: '${role}' is an orchestrator role, not a spawnable agent`);
    const total = this.activeTotal();
    if (total >= this.cap()) {
      throw new Error(`REFUSED: cap reached — max ${this.cap()} active sessions ` +
        `(orchestrator + ${this.cap() - 1} agents). ${total} active now. Retire an agent first.`);
    }
    await vscode.commands.executeCommand("claude-vscode.editor.open");
    return `opened a new session (${total + 1}/${this.cap()} active) — bind it by running:  /loom ${role}`;
  }

  /**
   * Close a CONFIRMED live agent's tab. HARD BOUNDARIES enforced here:
   *  1) never an owner/orchestrator role name;
   *  2) the role MUST be a currently-tracked LIVE agent of THIS project (orchestrator is never one → can't match);
   *  3) destructive → the CALLER must confirm before invoking.
   */
  async retire(role: string): Promise<string> {
    if (isOwnerRole(role)) throw new Error(`REFUSED: '${role}' is an orchestrator role — never closed.`);
    if (isLocked(this.repo || "", role)) throw new Error(`REFUSED: '${role}' is LOCKED 🔒 — unlock it first to retire.`);
    const agent = this.retirableAgents().find((a) => a.role === role);
    if (!agent) {
      throw new Error(`REFUSED: '${role}' is not a confirmed live agent of ${this.repo || "this project"} — nothing closed. ` +
        `(The orchestrator and other projects can never be retired here.)`);
    }
    const r = await closeWebview(agent.webviewId);
    if (!r.ok) throw new Error(`close did not confirm for '${role}' (${agent.webviewId.slice(0, 8)}): ${r.note}`);
    return `retired '${role}' (${agent.webviewId.slice(0, 8)}) — ${r.note}`;
  }

  /** Roles of THIS project (from board.json) that are NOT owners/locked — candidates to delete. */
  deletableRoles(): string[] {
    return Array.from(roleToRepo().entries())
      .filter(([role, repo]) => (!this.repo || repo === this.repo) && !isOwnerRole(role) && !isLocked(this.repo || "", role))
      .map(([role]) => role).sort();
  }

  /**
   * DELETE a role's session artifacts (recoverable — see deleter.ts). HARD BOUNDARIES:
   *  - never an owner/orchestrator role (structurally not in a worker roster + explicit refuse);
   *  - never a LOCKED role;
   *  - role must be in THIS project's board roster (so never another project, never the orchestrator);
   *  - refuse-if-worktree-dirty happens inside deleteSession (job must be banked).
   * Closes the tab first if it's live. `stamp` = a timestamp for the archive filename (from the caller).
   */
  async delete(role: string, repoRoot: string | null, stamp: string): Promise<string> {
    if (isOwnerRole(role)) throw new Error(`REFUSED: '${role}' is an orchestrator role — never deleted.`);
    if (isLocked(this.repo || "", role)) throw new Error(`REFUSED: '${role}' is LOCKED 🔒 — unlock it first to delete.`);
    const inRoster = roleToRepo().get(role);
    if (!inRoster || (this.repo && inRoster !== this.repo)) {
      throw new Error(`REFUSED: '${role}' is not a role of ${this.repo || "this project"} — nothing deleted.`);
    }
    // best-effort close the tab if it's currently live
    const live = this.retirableAgents().find((a) => a.role === role);
    if (live) await closeWebview(live.webviewId);
    const res = deleteSession(this.repo || "", role, repoRoot, stamp);
    if (!res.ok) throw new Error(res.error || "delete failed");
    return `deleted '${role}' — ${res.steps.join("; ") || "no artifacts"} (recoverable in deleted-sessions/ + git branch)`;
  }
}
