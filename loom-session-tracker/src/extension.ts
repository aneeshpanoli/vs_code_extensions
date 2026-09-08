// extension.ts — ONE JOB: the VSCodium lifecycle. Create the Tracker, poll it on an interval, and
// surface it (status bar + sidebar). Everything is wrapped so a failure here can NEVER crash the editor.

import * as vscode from "vscode";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { Tracker } from "./tracker";
import { SessionTreeProvider } from "./statusView";
import { currentRepo, repoRoot } from "./project";
import { Coordinator, MAX_ACTIVE_TOTAL } from "./coordinator";
import { roleToRepo, boardRoles, busRepos } from "./registry";
import { setLock } from "./locks";
import { getOrchestrator, setOrchestrator, ORCHESTRATOR_CANDIDATES } from "./orchestrator";
import { Notifier } from "./notifier";
import { readCount } from "./sessions";
import { LimitWatcher } from "./limits";
import { ModelPolicy, DEFAULT_PREMIUM } from "./models";
import { buildDigest, renderDigest, Digest } from "./digest";
import { HealthWatcher, checkHealth, countWorking, publishWorking, scanWorktrees, removeWorktree } from "./health";

let timer: NodeJS.Timeout | undefined;

export function activate(context: vscode.ExtensionContext) {
  try {
    const cfg = () => vscode.workspace.getConfiguration("loomSessionTracker");
    const repo = currentRepo();     // THIS window's project — the tracker shows/writes only this repo
    const tracker = new Tracker(repo);
    const coord = new Coordinator(tracker, repo);
    const rosterRoles = () => Array.from(roleToRepo().entries()).filter(([, r]) => r === repo).map(([role]) => role);
    const tree = new SessionTreeProvider(tracker, repo);

    context.subscriptions.push(vscode.window.registerTreeDataProvider("loomSessions", tree));

    const status = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 50);
    status.command = "loomSessionTracker.refresh";
    status.text = "$(sync) Loom: …";
    status.tooltip = "Loom session agents tracked (click to refresh)";
    status.show();
    context.subscriptions.push(status);

    const debugLog = (obj: any) => {
      try {
        fs.writeFileSync(path.join(os.homedir(), ".claude", "loom", "tracker-debug.json"),
          JSON.stringify({ repo, ...obj }, null, 2));
      } catch { /* ignore */ }
    };
    const notifier = new Notifier(repo);
    const limitWatcher = new LimitWatcher(repo);
    const modelPolicy = new ModelPolicy(repo);
    const healthWatcher = new HealthWatcher(repo);
    // Roles that go `working` and never come back are invisible to the finish notifier, so watch
    // for them explicitly; and publish the cross-project working count that no single window sees.
    const runHealth = () => {
      const working = countWorking();
      publishWorking(working);
      if (cfg().get<boolean>("stallWatchdog", true) !== true) return;
      const report = checkHealth(repo, { stallMinutes: Number(cfg().get("stallMinutes", 45)) || 45 });
      const orch = repo ? getOrchestrator(repo) : null;
      for (const ev of healthWatcher.scan(report)) {
        vscode.window.showWarningMessage(
          `Loom: ${ev.role} has been "${ev.status}" for ${ev.staleHours.toFixed(1)}h with no status update — possibly stuck.`);
        if (orch) healthWatcher.alert(ev, orch.role, () => { /* logged to stall-debug.json */ });
      }
    };
    // Keep the expensive tier for the orchestrator only: workers found on a premium model get
    // switched back with `/model <default>`, the same way `/loom <role>` binds a session.
    const runModelPolicy = () => {
      if (cfg().get("enforceWorkerModel", true) !== true) return;
      const premium = (cfg().get("premiumModels", DEFAULT_PREMIUM) as string[]) || DEFAULT_PREMIUM;
      const target = String(cfg().get("workerModel", "claude-opus-5") || "claude-opus-5");
      const orch = repo ? getOrchestrator(repo) : null;
      const live = new Set(tracker.view().filter((a) => a.liveness === "live").map((a) => a.role));
      for (const v of modelPolicy.check(tracker.modelState(), orch ? orch.role : null, live, premium)) {
        // Toast the first attempt; retries stay quiet in the status bar so a stuck session
        // cannot spam notifications every backoff window.
        const what = `${v.role} is on ${v.model} (orchestrator-only tier) — switching to ${target}`;
        if (v.attempt === 1) vscode.window.showInformationMessage(`Loom: ${what}.`);
        else vscode.window.setStatusBarMessage(`Loom: ${what} (retry ${v.attempt}).`, 8000);
        modelPolicy.enforce(v, target, (ok, note) => {
          modelPolicy.recordResult(v, ok, note);
          if (!ok && v.attempt === 1) vscode.window.showWarningMessage(
            `Loom: could not switch ${v.role} off ${v.model} (${note}) — retrying, or run /model ${target} there.`);
        });
      }
    };
    const DEFAULT_RESUME =
      "[loom-resume] Your usage limit has reset. Pick up where you left off: re-read your inbox and " +
      "the handoff you were on, continue the work, and keep status.json current.";
    // Wake any role whose usage limit has lifted. Detection is the banner CLEARING (exact), not the
    // UI's coarse "resets in 2h" estimate.
    const runLimitWatcher = () => {
      if (cfg().get("autoResumeAfterLimit", true) !== true) return;
      const live = new Set(tracker.view().filter((a) => a.liveness === "live").map((a) => a.role));
      for (const ev of limitWatcher.scan(tracker.limitState(), live)) {
        const msg = String(cfg().get("resumeMessage", "") || DEFAULT_RESUME);
        vscode.window.showInformationMessage(
          `Loom: ${ev.role}'s ${ev.kind} has reset (blocked since ${new Date(ev.blockedSince).toLocaleTimeString()}) — resuming it.`);
        limitWatcher.resume(ev, msg, (ok, note) => {
          if (!ok) vscode.window.showWarningMessage(
            `Loom: could not auto-resume ${ev.role} (${note}) — nudge that session by hand.`);
        });
      }
    };
    const runNotifier = () => {
      if (cfg().get("notifyOrchestrator", true) !== true) return;
      for (const ev of notifier.scan()) {
        const what = ev.status === "blocked" ? "raised a loop-back" : "finished";
        vscode.window.showInformationMessage(`Loom: ${ev.role} ${what}${ev.task ? ` (${ev.task})` : ""} — notifying orchestrator.`);
        notifier.notifyOrchestrator(ev, (ok, note) => {
          if (!ok) vscode.window.showWarningMessage(
            `Loom: could not notify the orchestrator about ${ev.role} (${note}) — read its outbox manually.`);
        });
      }
    };

    const runTick = async () => {
      try {
        // One project, or all of them — the window can switch without reloading.
        const showAll = cfg().get<boolean>("showAllProjects", false) === true;
        tracker.setFilter(showAll ? null : repo);
        tree.setRepo(showAll ? null : repo);
        const r = await tracker.tick();
        debugLog({ ok: r.ok, error: r.error, liveRoles: r.liveRoles, agents: tracker.view().map((a) => `${a.repo}/${a.role}`) });
        runNotifier();
        runLimitWatcher();
        runModelPolicy();
        runHealth();
        tree.refresh();
        if (r.ok) {
          const total = coord.activeTotal();   // agents + orchestrator
          const sc = tracker.sessionCount();
          const warnAt = Math.max(1, Number(cfg().get("sessionWarnThreshold", 5)) || 5);
          const busy = !!sc && sc.sessions > warnAt;
          status.text = `$(broadcast) Loom: ${total}/${MAX_ACTIVE_TOTAL}` +
            (sc ? ` \u00b7 ${sc.sessions} open` : "");
          status.tooltip = `Active in ${repo || "this window"}: ${total}/${MAX_ACTIVE_TOTAL} ` +
            `(orchestrator + ${r.liveRoles.length} agent(s))\n` +
            `Agents: ${r.liveRoles.join(", ") || "none"}` +
            (sc ? `\n\nEDITOR-WIDE: ${sc.sessions} Claude conversation(s) open across ${sc.windows} window(s)` +
                  `\n${sc.boundHere} bound to a Loom role here` +
                  `\nAnthropic caps no session count, but all sessions share ONE usage pool` +
                  ` (it suggests 3-5 in parallel).` +
                  (busy ? `\n\u26a0 above your warn threshold of ${warnAt}` : "") : "") +
            (() => {
              const lim = Object.entries(limitWatcher.limitedRoles());
              return lim.length
                ? `\n\n\u23f8 LIMITED: ` + lim.map(([role, r]) =>
                    `${role} (${r.kind}${r.etaText ? ", resets " + r.etaText : ""})`).join(", ") +
                  `\nthey will be resumed automatically when the limit lifts`
                : "";
            })() +
            (r.changedRepos.length ? `\nmap updated: ${r.changedRepos.join(", ")}` : "");
          status.backgroundColor = (total >= MAX_ACTIVE_TOTAL || busy)
            ? new vscode.ThemeColor("statusBarItem.warningBackground") : undefined;
        } else {
          status.text = `$(warning) Loom: CDP?`;
          status.tooltip = `CDP read failed (keeping last-known map): ${r.error || ""}`;
          status.backgroundColor = new vscode.ThemeColor("statusBarItem.warningBackground");
        }
      } catch (e: any) {
        // never let a tick error escape
        debugLog({ threw: String(e && e.message || e).slice(0, 300) });
        status.text = "$(warning) Loom: err";
        status.tooltip = String(e && e.message || e).slice(0, 200);
      }
    };

    const schedule = () => {
      if (timer) clearInterval(timer);
      const ms = Math.max(5000, Number(cfg().get("intervalMs", 15000)) || 15000);
      timer = setInterval(runTick, ms);
      context.subscriptions.push({ dispose: () => timer && clearInterval(timer) });
    };

    // ── startup digest: what needs the user, computed once at activation and on demand ──────
    const computeDigest = (): Digest | null => buildDigest(repo, {
      liveRoles: new Set(tracker.view().filter((a) => a.liveness === "live").map((a) => a.role)),
      limited: limitWatcher.limitedRoles(),
      premiumPending: modelPolicy.pending(),
      repoRoot: repoRoot(),
      staleDays: Number(cfg().get("staleBusDays", 30)) || 30,
      stallMinutes: Number(cfg().get("stallMinutes", 45)) || 45,
      workingWarnAt: Number(cfg().get("workingWarnThreshold", 5)) || 5,
      checkUnbanked: cfg().get<boolean>("digestUnbankedCheck", true),
    });

    /** Offer to reopen roles whose session evaporated. Always an explicit click — never automatic. */
    const reopenMissing = async (d: Digest) => {
      const picks = await vscode.window.showQuickPick(
        d.missingSessions.map((m) => ({ label: m.role, description: m.sessionId.slice(0, 8), id: m.sessionId })),
        { canPickMany: true, placeHolder: "Reopen which role sessions?" });
      if (!picks || !picks.length) return;
      for (const p of picks) {
        try { await vscode.commands.executeCommand("claude-vscode.editor.open", p.id, undefined, undefined); }
        catch (e: any) { vscode.window.showErrorMessage(`Loom: could not reopen ${p.label}: ${String(e.message || e)}`); }
      }
      vscode.window.setStatusBarMessage(`Loom: reopened ${picks.length} session(s).`, 6000);
    };

    const showDigest = async (force: boolean) => {
      const d = computeDigest();
      if (!d) return;
      debugLog({ digest: renderDigest(d) });
      if (!force && (!d.actionable || !cfg().get<boolean>("showStartupDigest", true))) return;
      if (!d.actionable) { vscode.window.showInformationMessage("Loom: nothing needs your attention."); return; }
      const actions = ["Details"];
      if (!d.orchestratorTagged) actions.push("Tag orchestrator");
      if (d.missingSessions.length) actions.push("Reopen sessions");
      const headline =
        [d.awaitingPickup.length && `${d.awaitingPickup.length} response(s) waiting`,
         d.blocked.length && `${d.blocked.length} blocked on a decision`,
         d.limited.length && `${d.limited.length} usage-limited`,
         d.premium.length && `${d.premium.length} on the premium model`,
         d.unbanked.length && `${d.unbanked.length} with unbanked work`,
         d.missingSessions.length && `${d.missingSessions.length} session(s) not open`,
         !d.orchestratorTagged && "no orchestrator tagged"].filter(Boolean).join(" · ");
      const choice = await vscode.window.showInformationMessage(`Loom (${d.repo}): ${headline}`, ...actions);
      if (choice === "Details") vscode.window.showInformationMessage(renderDigest(d), { modal: true });
      else if (choice === "Tag orchestrator") await vscode.commands.executeCommand("loomSessionTracker.tagOrchestrator");
      else if (choice === "Reopen sessions") await reopenMissing(d);
    };

    // a tree node (from a context-menu command) carries {agent:{role,repo}}; fall back to a QuickPick.
    const roleFromArg = async (node: any, pick: () => Thenable<string | undefined>): Promise<string | undefined> =>
      (node && node.agent && node.agent.role) ? node.agent.role
      : (node && typeof node.role === "string" && node.role) ? node.role
      : await pick();

    context.subscriptions.push(
      vscode.commands.registerCommand("loomSessionTracker.refresh", runTick),
      vscode.commands.registerCommand("loomSessionTracker.digest", () => showDigest(true)),
      // Cross-project view: show every project's roles in this window, or just this one.
      vscode.commands.registerCommand("loomSessionTracker.toggleAllProjects", async () => {
        const now = cfg().get<boolean>("showAllProjects", false) === true;
        await vscode.workspace.getConfiguration("loomSessionTracker")
          .update("showAllProjects", !now, vscode.ConfigurationTarget.Global);
        vscode.window.setStatusBarMessage(
          `Loom: showing ${!now ? "ALL projects" : "only " + (repo || "this window")}.`, 5000);
        await runTick();
      }),
      // Worktree hygiene: report first; removal is a separate, confirmed step and never forces.
      vscode.commands.registerCommand("loomSessionTracker.worktreeReport", async () => {
        const root = repoRoot();
        const found = scanWorktrees(repo, root);
        if (!found.length) { vscode.window.showInformationMessage("Loom: no worktrees found for this project."); return; }
        const orphans = found.filter((w) => w.orphaned);
        const removable = orphans.filter((w) => !w.dirty);
        const lines = [
          `${found.length} worktree(s); ${orphans.length} orphaned (no role on the board); ` +
          `${removable.length} of those are clean and removable.`, "",
          ...found.map((w) => `${w.orphaned ? "orphan " : "on-board"} ${w.dirty ? "DIRTY" : "clean"}  ${w.role}`),
        ];
        const action = removable.length ? `Remove ${removable.length} orphaned clean worktree(s)` : undefined;
        const choice = await vscode.window.showInformationMessage(lines.join("\n"), { modal: true },
          ...(action ? [action] : []));
        if (!action || choice !== action || !root) return;
        const confirm = await vscode.window.showWarningMessage(
          `Remove ${removable.length} worktree(s)? Branches and commits are retained; dirty and on-board ones are refused.`,
          { modal: true }, "Remove");
        if (confirm !== "Remove") return;
        const notes = removable.map((w) => removeWorktree(root, w).note);
        vscode.window.showInformationMessage("Loom worktree cleanup:\n" + notes.join("\n"), { modal: true });
        await runTick();
      }),
      vscode.commands.registerCommand("loomSessionTracker.status", () => {
        const v = tracker.view();
        const lines = v.map((a) => `${a.liveness === "live" ? "●" : "○"} ${a.repo}/${a.role}  ${a.webviewId.slice(0, 8)}`);
        vscode.window.showInformationMessage("Loom agents:\n" + (lines.join("\n") || "none yet"), { modal: true });
      }),
      // SESSION COUNT — editor-wide simultaneous Claude conversations
      vscode.commands.registerCommand("loomSessionTracker.sessionCount", () => {
        const sc = tracker.sessionCount() || readCount();
        if (!sc) { vscode.window.showInformationMessage("Loom: no session count yet (waiting for the first CDP read)."); return; }
        const warnAt = Math.max(1, Number(cfg().get("sessionWarnThreshold", 5)) || 5);
        vscode.window.showInformationMessage(
          `Simultaneous Claude sessions: ${sc.sessions}\n` +
          `Editor windows: ${sc.windows}\n` +
          `Bound to a Loom role in ${sc.updatedBy}: ${sc.boundHere}` +
          (sc.rolesHere.length ? ` (${sc.rolesHere.join(", ")})` : "") + `\n` +
          `Unbound elsewhere: ${sc.sessions - sc.boundHere}\n\n` +
          (sc.sessions > warnAt
            ? `Above your threshold of ${warnAt}. Anthropic sets no cap on concurrent sessions, but they all draw on ONE usage pool.`
            : `Within your threshold of ${warnAt}.`) + `\n` +
          `Published for scripts at ~/.claude/loom/active-sessions.json`,
          { modal: true });
      }),
      // SPAWN — open a new session to bind as a role
      vscode.commands.registerCommand("loomSessionTracker.spawn", async () => {
        const opts = coord.spawnableRoles(rosterRoles());
        const role = await vscode.window.showQuickPick(opts, { placeHolder: "Spawn a session for which role?" });
        if (!role) return;
        try { vscode.window.showInformationMessage(await coord.spawn(role)); tree.refresh(); }
        catch (e: any) { vscode.window.showErrorMessage(String(e.message || e)); }
      }),
      // RETIRE — close a confirmed agent's session (destructive, confirmed, lock- and self-guarded)
      vscode.commands.registerCommand("loomSessionTracker.retire", async (node?: any) => {
        const role = await roleFromArg(node, () =>
          vscode.window.showQuickPick(coord.retirableAgents().map((a) => a.role), { placeHolder: "Retire (close) which agent?" }));
        if (!role) return;
        const ok = await vscode.window.showWarningMessage(
          `Close the '${role}' session? This ends that agent's tab.`, { modal: true }, "Retire");
        if (ok !== "Retire") return;
        try { vscode.window.showInformationMessage(await coord.retire(role)); tree.refresh(); }
        catch (e: any) { vscode.window.showErrorMessage(String(e.message || e)); }
      }),
      // DELETE — remove a role's session artifacts (recoverable; refuses if dirty/locked/owner). Extra friction.
      vscode.commands.registerCommand("loomSessionTracker.delete", async (node?: any) => {
        const role = await roleFromArg(node, () =>
          vscode.window.showQuickPick(coord.deletableRoles(), { placeHolder: "Delete which role's session? (archives worktree + transcript)" }));
        if (!role) return;
        const warn = await vscode.window.showWarningMessage(
          `DELETE '${role}'? Removes its worktree + transcript (recoverable: branch kept, transcript archived). ` +
          `Refuses if it has unbanked work.`, { modal: true }, "Delete");
        if (warn !== "Delete") return;
        const typed = await vscode.window.showInputBox({ prompt: `Type '${role}' to confirm deletion`, placeHolder: role });
        if (typed !== role) { vscode.window.showInformationMessage("Delete cancelled (name did not match)."); return; }
        try {
          const stamp = new Date().toISOString().replace(/[:.]/g, "-");
          vscode.window.showInformationMessage(await coord.delete(role, repoRoot(), stamp)); tree.refresh();
        } catch (e: any) { vscode.window.showErrorMessage(String(e.message || e)); }
      }),
      // TAG ORCHESTRATOR — mark which role's session receives finish notifications
      vscode.commands.registerCommand("loomSessionTracker.tagOrchestrator", async (node?: any) => {
        // A window with no folder open has no repo — ask which bus instead of dead-ending.
        const target = repo || await vscode.window.showQuickPick(busRepos(), { placeHolder: "Tag the orchestrator for which project?" });
        if (!target) {
          if (!repo) vscode.window.showWarningMessage("Loom: no project bus chosen — nothing tagged.");
          return;
        }
        const role = await roleFromArg(node, () => {
          // Orchestrator names FIRST (they're never in the board roster / tracked agents), then this
          // project's worker roles and any other detected sessions — so the PO is always taggable.
          const others = Array.from(new Set([...boardRoles(target), ...tracker.view().map((a) => a.role)]))
            .filter((r) => !ORCHESTRATOR_CANDIDATES.includes(r)).sort();
          const roles = [...ORCHESTRATOR_CANDIDATES, ...others];
          return vscode.window.showQuickPick(roles, { placeHolder: "Which role is the orchestrator (receives finish notifications)?" });
        });
        if (!role) return;
        setOrchestrator(target, role);
        vscode.window.showInformationMessage(`Loom: '${role}' tagged as orchestrator of ${target} — workers finishing will notify it automatically.`);
        tree.refresh();
      }),
      vscode.commands.registerCommand("loomSessionTracker.untagOrchestrator", async () => {
        const tagged = busRepos().filter((r) => getOrchestrator(r));
        const target = repo || (tagged.length === 1 ? tagged[0]
          : await vscode.window.showQuickPick(tagged, { placeHolder: "Untag the orchestrator of which project?" }));
        if (!target) return;
        const cur = getOrchestrator(target);
        if (!cur) { vscode.window.showInformationMessage("Loom: no orchestrator tagged for this project."); return; }
        setOrchestrator(target, null);
        vscode.window.showInformationMessage(`Loom: '${cur.role}' untagged from ${target} — finish notifications off.`);
        tree.refresh();
      }),
      // LOCK / UNLOCK — Photoshop-style protection from deletion
      vscode.commands.registerCommand("loomSessionTracker.lock", async (node?: any) => {
        const a = node && node.agent; if (!a) return;
        setLock(a.repo, a.role, true); tree.refresh();
      }),
      vscode.commands.registerCommand("loomSessionTracker.unlock", async (node?: any) => {
        const a = node && node.agent; if (!a) return;
        setLock(a.repo, a.role, false); tree.refresh();
      }),
      vscode.workspace.onDidChangeConfiguration((e) => { if (e.affectsConfiguration("loomSessionTracker.intervalMs")) schedule(); }),
    );

    // First pass immediately, then the startup digest once the roster is known.
    runTick().then(() => showDigest(false)).catch(() => { /* never break activation */ });
    schedule();    // then on interval
  } catch (e) {
    // activation must never throw
    console.error("[loom-session-tracker] activate failed:", e);
  }
}

export function deactivate() {
  if (timer) clearInterval(timer);
}
