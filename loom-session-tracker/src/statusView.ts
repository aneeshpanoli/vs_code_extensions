// statusView.ts — ONE JOB: render the tracker's agent model as a VS Code sidebar tree.
// Projects at the top level, agents beneath, each showing live (●) / stale (○) + role + webviewId.
// Pure presentation over Tracker.view(); holds no CDP/IO logic of its own.

import * as vscode from "vscode";
import { Tracker, AgentView } from "./tracker";
import { ownerRoleFor } from "./naming";
import { isLocked } from "./locks";
import { getOrchestrator } from "./orchestrator";
import { readCache, figuresFor, summaryLine, Figure, WorkLedger, Thresholds, DEFAULT_THRESHOLDS,
         Band } from "./workledger";

type Node =
  | { kind: "repo"; repo: string }
  | { kind: "agent"; agent: AgentView }
  // WL-001 R2: what this project actually PRODUCED, measured from git — one line carrying the
  // verdict, above the agents, which are all self-report.
  | { kind: "ledger"; repo: string; w: WorkLedger }
  | { kind: "figure"; repo: string; figure: Figure }
  | { kind: "orchestrator"; repo: string; role: string; frameOk: boolean }
  // A detected-but-untagged PO session: shown so the orchestrator is visible and one click taggable.
  | { kind: "ownerCandidate"; role: string; webviewId: string; liveness: string; strong: boolean; declared: boolean;
      contextPct: number | null };

/** One icon/colour per band, shared by the ledger node and its figures so they cannot disagree. */
const ICON: Record<Band, string> = { good: "pass", warn: "warning", bad: "error", unknown: "info" };
const COLOR: Record<Band, string> = {
  good: "charts.green", warn: "charts.yellow", bad: "charts.red", unknown: "descriptionForeground",
};

export class SessionTreeProvider implements vscode.TreeDataProvider<Node> {
  private _onDidChange = new vscode.EventEmitter<Node | undefined | void>();
  readonly onDidChangeTreeData = this._onDidChange.event;

  constructor(private tracker: Tracker, private repo: string | null = null) {}

  /** Follow the tracker when the window toggles between one project and all of them. */
  setRepo(repo: string | null): void { this.repo = repo; }

  refresh(): void { this._onDidChange.fire(); }

  /** Thresholds from settings, falling back field-by-field so a partial object still works. */
  private thresholds(): Thresholds {
    const t = vscode.workspace.getConfiguration("loomSessionTracker")
      .get<Partial<Thresholds>>("workLedgerThresholds", {}) || {};
    const num = (v: any, d: number) => (Number.isFinite(Number(v)) ? Number(v) : d);
    return {
      shipsGood: num(t.shipsGood, DEFAULT_THRESHOLDS.shipsGood),
      shipsBad: num(t.shipsBad, DEFAULT_THRESHOLDS.shipsBad),
      loopBackGood: num(t.loopBackGood, DEFAULT_THRESHOLDS.loopBackGood),
      loopBackBad: num(t.loopBackBad, DEFAULT_THRESHOLDS.loopBackBad),
      narrationGood: num(t.narrationGood, DEFAULT_THRESHOLDS.narrationGood),
      narrationBad: num(t.narrationBad, DEFAULT_THRESHOLDS.narrationBad),
      unshippedShareGood: num(t.unshippedShareGood, DEFAULT_THRESHOLDS.unshippedShareGood),
      unshippedShareBad: num(t.unshippedShareBad, DEFAULT_THRESHOLDS.unshippedShareBad),
      costPerLine: num(t.costPerLine, DEFAULT_THRESHOLDS.costPerLine),
    };
  }

  /** This project's cached work ledger, or null when it is switched off or nothing is measured yet.
   *  Read-only: the view never runs git — the tick owns the compute and the cache. */
  private ledgerFor(repo: string): WorkLedger | null {
    if (vscode.workspace.getConfiguration("loomSessionTracker")
        .get<boolean>("workLedgerEnabled", true) !== true) return null;
    return readCache(repo)?.ledger ?? null;
  }

  getTreeItem(node: Node): vscode.TreeItem {
    if (node.kind === "ledger") {
      // COLLAPSED, one line, carrying the verdict — the figure that would have shown the audited
      // week on day two has to be readable without a click.
      const it = new vscode.TreeItem("work ledger", vscode.TreeItemCollapsibleState.Collapsed);
      it.description = summaryLine(node.w);
      const worst = figuresFor(node.w, this.thresholds())
        .some((f) => f.band === "bad") ? "bad"
        : figuresFor(node.w, this.thresholds()).some((f) => f.band === "warn") ? "warn" : "good";
      it.iconPath = new vscode.ThemeIcon(ICON[worst], new vscode.ThemeColor(COLOR[worst]));
      it.tooltip =
        `What ${node.w.repo} PRODUCED in the last ${node.w.windowDays} days, measured from git and ` +
        `model-ledger.jsonl.\n` +
        `NOTHING here comes from what an agent wrote about itself — not status.json's last_line, ` +
        `not a test count a session reported.\n\n` +
        `${node.w.commits} commit(s) · computed ${node.w.computedAt}` +
        `${node.w.heuristic ? `\n⚠ product paths for this repo are a HEURISTIC, not configured ` +
                              `(loomSessionTracker.productPaths).` : ""}` +
        `${node.w.empty ? `\n⚠ ${node.w.emptyReason}` : ""}\n\n` +
        `Expand for each figure; "Loom: work ledger" opens the full report.`;
      it.contextValue = "loomWorkLedger";
      it.command = { command: "loomSessionTracker.workLedgerReport", title: "Work ledger report",
                     arguments: [{ repo: node.repo }] };
      return it;
    }
    if (node.kind === "figure") {
      const f = node.figure;
      const it = new vscode.TreeItem(f.label, vscode.TreeItemCollapsibleState.None);
      // A red row STATES THE NUMBER. A bare warning icon is exactly the thing being replaced: it
      // tells a reader something is wrong without telling them how wrong, so it gets ignored.
      it.description = f.value;
      it.iconPath = new vscode.ThemeIcon(ICON[f.band], new vscode.ThemeColor(COLOR[f.band]));
      // The raw numbers — numerator, denominator, window and computedAt — so a STALE cache is
      // obvious rather than being read as this morning's measurement.
      it.tooltip = `${f.label}: ${f.value}\n\n${f.detail}`;
      it.contextValue = "loomWorkLedgerFigure";
      it.command = { command: "loomSessionTracker.workLedgerReport", title: "Work ledger report",
                     arguments: [{ repo: node.repo }] };
      return it;
    }
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
      it.command = { command: "loomSessionTracker.focusSession", title: "Show this session",
                     arguments: [{ repo: node.repo, role: node.role }] };
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
    // Click -> bring this session's tab forward (focus.ts decides whether it can be done safely).
    it.command = { command: "loomSessionTracker.focusSession", title: "Show this session",
                   arguments: [{ repo: a.repo, role: a.role }] };
    return it;
  }

  /** Detected orchestrator/PO frames as taggable nodes. */
  private candidateNodes(repo?: string | null): Node[] {
    return this.tracker.ownerView()
      // In a project window, only candidates attributed to THAT project — the CDP read is
      // editor-wide, so everything else belongs to someone else's window.
      // A candidate the bus DECLARED belongs to that project even when its text mentions no paths at
      // all — ReciEats' orchestrator (113ae63b) attributed to nothing and was offered to no window,
      // while `productowner.id` had named it the whole time.
      .filter((o) => (repo ? (o.repo === repo || o.declared) : true))
      // When the board DECLARES this project's orchestrator frame, that is the only candidate worth a
      // click — offering weak content-attributed sessions beside it is how a diagnostic session got
      // starred twice on 2026-09-09. Declared first, then strong, then weak.
      // …but only a declaration whose frame is LIVE may suppress. Frame ids die at every restart, and
      // on 2026-09-12 shwab_docker's declared AND tagged frames were both dead — so its real, running
      // orchestrator was hidden behind two ghosts and the sidebar showed nothing to click.
      .filter((o, _, all) => o.declared ||
        !all.some((x) => x.declared && x.liveness === "live" && x.repo === o.repo))
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
      // …or when it has a WORK LEDGER. Without this a project with no live agent and no tagged
      // orchestrator gets no node at all, so its ledger is invisible — and a project nobody is
      // actively running is exactly the one whose week you most need to be able to read.
      if (this.repo && (getOrchestrator(this.repo) || this.candidateNodes(this.repo).length ||
                        this.ledgerFor(this.repo))) repos.add(this.repo);
      const top: Node[] = Array.from(repos).sort().map((repo) => ({ kind: "repo", repo } as Node));
      // Window with no project folder: no repo group to nest under, so list candidates at top level.
      if (!this.repo) top.push(...this.candidateNodes());
      return top;
    }
    if (node.kind === "ledger") {
      return figuresFor(node.w, this.thresholds())
        .map((figure) => ({ kind: "figure", repo: node.repo, figure } as Node));
    }
    if (node.kind === "repo") {
      const orch = getOrchestrator(node.repo);
      const nodes: Node[] = [];
      // WL-001 R2: ABOVE the agents. Everything below this line is the agents' account of
      // themselves; this one node is the only thing in the panel they did not write.
      // Read-only from the cache the tick maintains — the view never runs git.
      const wl = this.ledgerFor(node.repo);
      if (wl) nodes.push({ kind: "ledger", repo: node.repo, w: wl });
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
