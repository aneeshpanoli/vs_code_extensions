// statusView.ts — ONE JOB: render the tracker's agent model as a VS Code sidebar tree.
// Projects at the top level, agents beneath, each showing live (●) / stale (○) + role + webviewId.
// Pure presentation over Tracker.view(); holds no CDP/IO logic of its own.

import * as vscode from "vscode";
import { Tracker, AgentView } from "./tracker";
import { ownerRoleFor } from "./naming";
import { isLocked } from "./locks";
import { getOrchestrator } from "./orchestrator";

type Node =
  | { kind: "repo"; repo: string }
  | { kind: "agent"; agent: AgentView }
  | { kind: "orchestrator"; repo: string; role: string; frameOk: boolean }
  // A detected-but-untagged PO session: shown so the orchestrator is visible and one click taggable.
  | { kind: "ownerCandidate"; role: string; webviewId: string; liveness: string; strong: boolean; declared: boolean;
      contextPct: number | null };

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
      it.description = `${node.liveness === "live" ? "●" : "○"} ` +
        `${node.contextPct !== null ? `${node.contextPct}% context · ` : ""}` +
        `${node.declared ? "declared by the board" : node.strong ? "untagged" : "possible orchestrator"} — click ★ to tag`;
      it.iconPath = new vscode.ThemeIcon("star-empty", new vscode.ThemeColor("charts.orange"));
      it.tooltip = `${node.declared ? "This project's board names this frame as its orchestrator" : node.strong ? "Orchestrator session detected" : "Session working on this project, and not one of its roles"} ` +
        `(${node.webviewId.slice(0, 8)}) but NOT tagged.\n` +
        `Tag it so workers finishing automatically notify it` +
        `${node.contextPct !== null ? `, and so its context is banked before it fills (${node.contextPct}% used)` : ""}.`;
      it.contextValue = "loomOwnerCandidate";
      it.command = { command: "loomSessionTracker.tagOrchestrator", title: "Tag as Orchestrator", arguments: [node] };
      return it;
    }
    if (node.kind === "orchestrator") {
      const it = new vscode.TreeItem(node.role, vscode.TreeItemCollapsibleState.None);
      // A tag whose frame cannot be found in this project is not doing anything: nothing can be
      // injected into it. Say so on the node rather than looking healthy while being inert.
      it.description = node.frameOk ? "★ orchestrator" : "★ orchestrator · frame not identified";
      it.iconPath = new vscode.ThemeIcon(node.frameOk ? "star-full" : "warning",
        new vscode.ThemeColor(node.frameOk ? "charts.orange" : "charts.yellow"));
      it.tooltip = `${node.role} @ ${node.repo}\n★ ORCHESTRATOR — auto-notified when a worker finishes.\n` +
        `Not a tracked worker (never a retire/delete target).` +
        (node.frameOk ? "" :
          `\n\n\u26a0 No session in THIS project matches this tag, so notifications and the ` +
          `context-memory cycle cannot reach it. Tag the right session below.`);
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
  private candidateNodes(repo?: string | null): Node[] {
    return this.tracker.ownerView()
      // In a project window, only candidates attributed to THAT project — the CDP read is
      // editor-wide, so everything else belongs to someone else's window.
      .filter((o) => (repo ? o.repo === repo : true))
      // When the board DECLARES this project's orchestrator frame, that is the only candidate worth a
      // click — offering weak content-attributed sessions beside it is how a diagnostic session got
      // starred twice on 2026-09-09. Declared first, then strong, then weak.
      .filter((o, _, all) => o.declared || !all.some((x) => x.declared && x.repo === o.repo))
      .sort((a, b) => Number(b.declared) - Number(a.declared) || Number(b.strong) - Number(a.strong))
      .map((o) => ({
        kind: "ownerCandidate", role: ownerRoleFor(o.repo ?? repo ?? null), webviewId: o.webviewId, liveness: o.liveness,
        strong: o.strong, declared: o.declared, contextPct: o.contextPct,
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
      if (this.repo && (getOrchestrator(this.repo) || this.candidateNodes(this.repo).length)) repos.add(this.repo);
      const top: Node[] = Array.from(repos).sort().map((repo) => ({ kind: "repo", repo } as Node));
      // Window with no project folder: no repo group to nest under, so list candidates at top level.
      if (!this.repo) top.push(...this.candidateNodes());
      return top;
    }
    if (node.kind === "repo") {
      const orch = getOrchestrator(node.repo);
      const nodes: Node[] = [];
      const cands = this.repo === node.repo ? this.candidateNodes(node.repo) : [];
      if (orch) {
        const frameOk = cands.some((c: any) => c.webviewId === orch.webviewId);
        nodes.push({ kind: "orchestrator", repo: node.repo, role: orch.role, frameOk });
        // A tag pointing at a frame this project cannot see is stuck; offer the ones it can, so it
        // is re-pointable in one click instead of needing an untag first.
        if (!frameOk) nodes.push(...cands);
      } else {
        // Untagged: surface the candidate session(s) so the orchestrator is visible + taggable.
        nodes.push(...cands);
      }
      // Dedupe: if the orchestrator role is also (unexpectedly) a tracked agent, don't list it twice.
      for (const agent of all.filter((a) => a.repo === node.repo && a.role !== orch?.role)) {
        nodes.push({ kind: "agent", agent });
      }
      return nodes;
    }
    return [];
  }
}
