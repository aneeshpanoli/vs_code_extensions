// statusView.ts — ONE JOB: render the tracker's agent model as a VS Code sidebar tree.
// Projects at the top level, agents beneath, each showing live (●) / stale (○) + role + webviewId.
// Pure presentation over Tracker.view(); holds no CDP/IO logic of its own.

import * as vscode from "vscode";
import { Tracker, AgentView } from "./tracker";
import { OWNER_ROLE_NAME } from "./roles";
import { isLocked } from "./locks";
import { getOrchestrator } from "./orchestrator";

type Node =
  | { kind: "repo"; repo: string }
  | { kind: "agent"; agent: AgentView }
  | { kind: "orchestrator"; repo: string; role: string }
  // A detected-but-untagged PO session: shown so the orchestrator is visible and one click taggable.
  | { kind: "ownerCandidate"; role: string; webviewId: string; liveness: string };

export class SessionTreeProvider implements vscode.TreeDataProvider<Node> {
  private _onDidChange = new vscode.EventEmitter<Node | undefined | void>();
  readonly onDidChangeTreeData = this._onDidChange.event;

  constructor(private tracker: Tracker, private repo: string | null = null) {}

  /** Follow the tracker when the window toggles between one project and all of them. */
  setRepo(repo: string | null): void { this.repo = repo; }

  refresh(): void { this._onDidChange.fire(); }

  getTreeItem(node: Node): vscode.TreeItem {
    if (node.kind === "ownerCandidate") {
      const it = new vscode.TreeItem(node.role, vscode.TreeItemCollapsibleState.None);
      it.description = `${node.liveness === "live" ? "●" : "○"} untagged — click ★ to tag`;
      it.iconPath = new vscode.ThemeIcon("star-empty", new vscode.ThemeColor("charts.orange"));
      it.tooltip = `Orchestrator session detected (${node.webviewId.slice(0, 8)}) but NOT tagged.\n` +
        `Tag it so workers finishing automatically notify it.`;
      it.contextValue = "loomOwnerCandidate";
      it.command = { command: "loomSessionTracker.tagOrchestrator", title: "Tag as Orchestrator", arguments: [node] };
      return it;
    }
    if (node.kind === "orchestrator") {
      const it = new vscode.TreeItem(node.role, vscode.TreeItemCollapsibleState.None);
      it.description = "★ orchestrator";
      it.iconPath = new vscode.ThemeIcon("star-full", new vscode.ThemeColor("charts.orange"));
      it.tooltip = `${node.role} @ ${node.repo}\n★ ORCHESTRATOR — auto-notified when a worker finishes.\n` +
        `Not a tracked worker (never a retire/delete target).`;
      it.contextValue = "loomOrchestrator";
      return it;
    }
    if (node.kind === "repo") {
      const agents = this.tracker.view().filter((a) => a.repo === node.repo);
      const live = agents.filter((a) => a.liveness === "live").length;
      const it = new vscode.TreeItem(node.repo, vscode.TreeItemCollapsibleState.Expanded);
      it.description = `${live}/${agents.length} live`;
      it.iconPath = new vscode.ThemeIcon("folder");
      it.contextValue = "loomRepo";
      return it;
    }
    const a = node.agent;
    const locked = isLocked(a.repo, a.role);
    const isOrch = getOrchestrator(a.repo)?.role === a.role;
    const it = new vscode.TreeItem(a.role, vscode.TreeItemCollapsibleState.None);
    const lim = a.limit && a.limit.limited ? a.limit : null;
    it.description = `${isOrch ? "★ orchestrator · " : ""}${locked ? "🔒 " : ""}` +
      (lim ? `⏸ ${lim.kind}${lim.etaText ? ` · resets ${lim.etaText}` : ""} · ` : "") +
      (a.model ? `${a.model.model} · ` : "") +
      `${a.liveness === "live" ? "● live" : "○ stale"} · ${a.webviewId.slice(0, 8)}`;
    it.iconPath = new vscode.ThemeIcon(
      lim ? "debug-pause" : isOrch ? "star-full" : locked ? "lock" : (a.liveness === "live" ? "circle-filled" : "circle-outline"),
      new vscode.ThemeColor(lim ? "charts.red" : isOrch ? "charts.orange" : locked ? "charts.yellow" : (a.liveness === "live" ? "charts.green" : "descriptionForeground")));
    it.tooltip = `${a.role} @ ${a.repo}` +
      (lim ? `\n\u23f8 BLOCKED by ${lim.kind}${lim.etaText ? ` (resets ${lim.etaText})` : ""} — auto-resumes when it lifts` : "") +
      `${isOrch ? "  ★ ORCHESTRATOR (notified when workers finish)" : ""}` +
      `${locked ? "  🔒 LOCKED (protected from deletion)" : ""}\n` +
      `webviewId: ${a.webviewId}\nlast seen: ${new Date(a.lastSeen).toLocaleTimeString()}`;
    // contextValue drives which menu items show (Lock vs Unlock, Retire)
    it.contextValue = locked ? "loomAgentLocked" : "loomAgent";
    return it;
  }

  /** Detected orchestrator/PO frames as taggable nodes. */
  private candidateNodes(): Node[] {
    return this.tracker.ownerView().map((o) => ({
      kind: "ownerCandidate", role: OWNER_ROLE_NAME, webviewId: o.webviewId, liveness: o.liveness,
    } as Node));
  }

  getChildren(node?: Node): Node[] {
    const all = this.tracker.view();
    if (!node) {
      const repos = new Set(all.map((a) => a.repo));
      // Show the current project's node even with zero tracked agents, so a tagged orchestrator
      // (which is never a tracked agent) is still visible.
      // Ensure this project has a group when it has something orchestrator-ish to show,
      // even with zero tracked agents (tagged orchestrator, or an untagged candidate).
      if (this.repo && (getOrchestrator(this.repo) || this.tracker.ownerView().length)) repos.add(this.repo);
      const top: Node[] = Array.from(repos).sort().map((repo) => ({ kind: "repo", repo } as Node));
      // Window with no project folder: no repo group to nest under, so list candidates at top level.
      if (!this.repo) top.push(...this.candidateNodes());
      return top;
    }
    if (node.kind === "repo") {
      const orch = getOrchestrator(node.repo);
      const nodes: Node[] = [];
      if (orch) nodes.push({ kind: "orchestrator", repo: node.repo, role: orch.role });
      // Untagged: surface the detected PO session(s) so the orchestrator is visible + taggable.
      else if (this.repo === node.repo) nodes.push(...this.candidateNodes());
      // Dedupe: if the orchestrator role is also (unexpectedly) a tracked agent, don't list it twice.
      for (const agent of all.filter((a) => a.repo === node.repo && a.role !== orch?.role)) {
        nodes.push({ kind: "agent", agent });
      }
      return nodes;
    }
    return [];
  }
}
