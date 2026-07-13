// statusView.ts — ONE JOB: render the tracker's agent model as a VS Code sidebar tree.
// Projects at the top level, agents beneath, each showing live (●) / stale (○) + role + webviewId.
// Pure presentation over Tracker.view(); holds no CDP/IO logic of its own.

import * as vscode from "vscode";
import { Tracker, AgentView } from "./tracker";
import { isLocked } from "./locks";
import { getOrchestrator } from "./orchestrator";

type Node = { kind: "repo"; repo: string } | { kind: "agent"; agent: AgentView };

export class SessionTreeProvider implements vscode.TreeDataProvider<Node> {
  private _onDidChange = new vscode.EventEmitter<Node | undefined | void>();
  readonly onDidChangeTreeData = this._onDidChange.event;

  constructor(private tracker: Tracker) {}

  refresh(): void { this._onDidChange.fire(); }

  getTreeItem(node: Node): vscode.TreeItem {
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
      const repos = Array.from(new Set(all.map((a) => a.repo))).sort();
      return repos.map((repo) => ({ kind: "repo", repo }));
    }
    if (node.kind === "repo") {
      return all.filter((a) => a.repo === node.repo).map((agent) => ({ kind: "agent", agent }));
    }
    return [];
  }
}
