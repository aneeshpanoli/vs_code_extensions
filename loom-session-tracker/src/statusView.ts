// statusView.ts — ONE JOB: render the tracker's agent model as a VS Code sidebar tree.
// Projects at the top level, agents beneath, each showing live (●) / stale (○) + role + webviewId.
// Pure presentation over Tracker.view(); holds no CDP/IO logic of its own.

import * as vscode from "vscode";
import { Tracker, AgentView } from "./tracker";
import { isLocked } from "./locks";
import { getOrchestrator } from "./orchestrator";

type Node =
  | { kind: "repo"; repo: string }
  | { kind: "agent"; agent: AgentView }
  | { kind: "orchestrator"; repo: string; role: string };

export class SessionTreeProvider implements vscode.TreeDataProvider<Node> {
  private _onDidChange = new vscode.EventEmitter<Node | undefined | void>();
  readonly onDidChangeTreeData = this._onDidChange.event;

  constructor(private tracker: Tracker, private repo: string | null = null) {}

  refresh(): void { this._onDidChange.fire(); }

  getTreeItem(node: Node): vscode.TreeItem {
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
    it.description = `${isOrch ? "★ orchestrator · " : ""}${locked ? "🔒 " : ""}` +
      `${a.liveness === "live" ? "● live" : "○ stale"} · ${a.webviewId.slice(0, 8)}`;
    it.iconPath = new vscode.ThemeIcon(
      isOrch ? "star-full" : locked ? "lock" : (a.liveness === "live" ? "circle-filled" : "circle-outline"),
      new vscode.ThemeColor(isOrch ? "charts.orange" : locked ? "charts.yellow" : (a.liveness === "live" ? "charts.green" : "descriptionForeground")));
    it.tooltip = `${a.role} @ ${a.repo}` +
      `${isOrch ? "  ★ ORCHESTRATOR (notified when workers finish)" : ""}` +
      `${locked ? "  🔒 LOCKED (protected from deletion)" : ""}\n` +
      `webviewId: ${a.webviewId}\nlast seen: ${new Date(a.lastSeen).toLocaleTimeString()}`;
    // contextValue drives which menu items show (Lock vs Unlock, Retire)
    it.contextValue = locked ? "loomAgentLocked" : "loomAgent";
    return it;
  }

  getChildren(node?: Node): Node[] {
    const all = this.tracker.view();
    if (!node) {
      const repos = new Set(all.map((a) => a.repo));
      // Show the current project's node even with zero tracked agents, so a tagged orchestrator
      // (which is never a tracked agent) is still visible.
      if (this.repo && getOrchestrator(this.repo)) repos.add(this.repo);
      return Array.from(repos).sort().map((repo) => ({ kind: "repo", repo }));
    }
    if (node.kind === "repo") {
      const orch = getOrchestrator(node.repo);
      const nodes: Node[] = [];
      if (orch) nodes.push({ kind: "orchestrator", repo: node.repo, role: orch.role });
      // Dedupe: if the orchestrator role is also (unexpectedly) a tracked agent, don't list it twice.
      for (const agent of all.filter((a) => a.repo === node.repo && a.role !== orch?.role)) {
        nodes.push({ kind: "agent", agent });
      }
      return nodes;
    }
    return [];
  }
}
