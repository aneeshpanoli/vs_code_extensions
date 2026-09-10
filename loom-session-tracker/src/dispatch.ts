// dispatch.ts — ONE JOB: decide WHO gets typed into, and whether this tick may type at all.
//
// WHY THIS IS ITS OWN MODULE. Every injection this extension performs went through a closure inside
// `activate()`, reachable only by driving the whole extension with a vscode stub. So the decision
// that actually caused harm on 2026-09-09 — which frame receives a `/model`, a resume, a stall alert
// — had no direct test, and the suite passed 376/376 while the live system typed `/model` into a
// diagnostic session 38 times and a worker mid-turn swallowed 9 more. These are pure functions over
// a tick's state, so the choice of target can be asserted directly, against real captured panels.
//
// TWO KINDS OF INJECTION, and they are not interchangeable:
//   * a COMMAND (`/model …`, `/clear`) is executed by the composer, and ONLY when it is idle. Typed
//     mid-turn it is queued as an ordinary message and silently never runs.
//   * a MESSAGE (a resume nudge, a finish notification, a stall alert) is meant to be read, and
//     queuing behind the current turn is correct behaviour, not a failure.
// Measured: three `/model claude-opus-5` into a busy worker, all reported "typed + submitted", none
// produced a "Set model" line; the same command into an idle session ran at once.

import { isOwnerRole } from "./naming";

export type Purpose = "command" | "message";

export interface AgentLike {
  role: string;
  repo: string;
  webviewId: string;
  liveness: string;          // "live" | "stale"
}

export interface Target { role: string; repo: string; webviewId: string; }

/**
 * The agents of THIS window that may receive an injection of `purpose` this tick.
 * A stale agent is never a target: its frame id is from an earlier read and may now belong to
 * another conversation. A busy agent is withheld from COMMANDS only.
 */
export function eligibleTargets(agents: AgentLike[], busyRoles: Set<string>, purpose: Purpose,
                                repo: string | null): Target[] {
  return agents
    .filter((a) => a.liveness === "live")
    .filter((a) => !repo || a.repo === repo)
    .filter((a) => purpose === "message" || !busyRoles.has(a.role))
    .map((a) => ({ role: a.role, repo: a.repo, webviewId: a.webviewId }));
}

/** Is this role allowed to be typed into this tick, for this purpose? */
export function mayInject(role: string, agents: AgentLike[], busyRoles: Set<string>,
                          purpose: Purpose, repo: string | null): boolean {
  return eligibleTargets(agents, busyRoles, purpose, repo).some((t) => t.role === role);
}

export interface OrchestratorTagLike { role: string; webviewId?: string | null; }

export interface OrchestratorRefusal { ok: false; reason: string; }
export interface OrchestratorOk { ok: true; target: Target }
export type OrchestratorResolution = OrchestratorOk | OrchestratorRefusal;

/**
 * The frame to address the orchestrator at, or a REASON it cannot be addressed.
 *
 * Refusals, each from a state that was live on 2026-09-09:
 *  * no tag at all — livegita ran untagged for a day while its PO sat in an open tab;
 *  * a tag naming a WORKER (`{"role":"gitadeveloper"}`), one tick away from `/clear`-ing a developer
 *    mid-task, held back only by a null frame id that a later tick would have filled in;
 *  * a tag whose frame is not in this read — ids rotate on every window reload, so this is the
 *    ordinary state after a restart and must be a quiet refusal, not an error.
 */
export function resolveOrchestrator(repo: string | null, tag: OrchestratorTagLike | null,
                                    liveFrameIds: Set<string>): OrchestratorResolution {
  if (!repo) return { ok: false, reason: "this window is not scoped to a project" };
  if (!tag) return { ok: false, reason: "no orchestrator is tagged for this project" };
  if (!isOwnerRole(tag.role)) {
    return { ok: false, reason: `the tag names '${tag.role}', which is not an orchestrator role — ` +
      `refusing to address a worker as the orchestrator` };
  }
  if (!tag.webviewId) return { ok: false, reason: "the orchestrator's frame is not identified" };
  if (!liveFrameIds.has(tag.webviewId)) {
    return { ok: false, reason: `the tagged frame ${tag.webviewId.slice(0, 8)} is not in this read ` +
      `(frame ids rotate on every window reload — re-tag it)` };
  }
  return { ok: true, target: { role: tag.role, repo, webviewId: tag.webviewId } };
}
