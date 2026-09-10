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
import { getOrchestrator, setOrchestrator, setOrchestratorFrame, ORCHESTRATOR_CANDIDATES } from "./orchestrator";
import { ownerRoleFor, publishNaming } from "./naming";
import { Notifier } from "./notifier";
import { readCount } from "./sessions";
import { LimitWatcher } from "./limits";
import { ModelPolicy, DEFAULT_PREMIUM } from "./models";
import { buildDigest, renderDigest, Digest } from "./digest";
import { HealthWatcher, checkHealth, countWorking, publishWorking, scanWorktrees, removeWorktree } from "./health";
import { decide, loadState, saveState, defaultMemoryFile, statMemory, readOrchestratorContext,
         MemoryConfig, Step } from "./memory";
import { injectTo } from "./inject";
import { DEFAULT_WINDOW_TOKENS, pct } from "./context";

let timer: NodeJS.Timeout | undefined;

export function activate(context: vscode.ExtensionContext) {
  try {
    const cfg = () => vscode.workspace.getConfiguration("loomSessionTracker");
    const repo = currentRepo();     // THIS window's project — the tracker shows/writes only this repo
    // Publish the owner alias contract so loom_cdp.py reads the same set this extension enforces.
    publishNaming();
    const tracker = new Tracker(repo);
    const coord = new Coordinator(tracker, repo);
    // THIS project's roster, read from ITS board — not from the global {role: repo} map, which is
    // last-writer-wins across buses. Measured: `alpha`/`prototyping`/`art`/`developer` are each
    // claimed by two projects, so a shared role name silently emptied this window's spawn list.
    const rosterRoles = () => (repo ? boardRoles(repo) : []);
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
    // ── orchestrator context memory ────────────────────────────────────────────────────────
    // The orchestrator is the session that actually fills up (measured: shwab_docker's had
    // auto-compacted four times). Past the threshold it is asked to write its working memory to a
    // file, and ONLY once that file is verifiably on disk is /clear sent, followed by a prompt that
    // reads the memory back and reconciles it with the docs. Every rule lives in memory.decide();
    // this function is the I/O around it.
    let contextNote = "";
    // Identifies this window for the duration of its life. Two windows are routinely scoped to the
    // same project (a worktree window resolves to its parent repo id), and only one may drive a cycle.
    const windowId = `${process.pid}:${Math.random().toString(36).slice(2, 8)}`;
    const contextConfig = (): MemoryConfig => ({
      enabled: cfg().get<boolean>("contextMemory", true) === true,
      thresholdPct: Math.min(95, Math.max(10, Number(cfg().get("contextThresholdPct", 50)) || 50)),
      saveTimeoutMinutes: Math.max(1, Number(cfg().get("contextSaveTimeoutMinutes", 10)) || 10),
      clearTimeoutMinutes: Math.max(1, Number(cfg().get("contextClearTimeoutMinutes", 5)) || 5),
      cooldownMinutes: Math.max(0, Number(cfg().get("contextCooldownMinutes", 15)) ?? 15),
    });
    const runContextMemory = (force = false): Step | null => {
      if (!repo) return null;
      const orch = getOrchestrator(repo);
      if (!orch) { contextNote = ""; return null; }
      // WHICH FRAME IS THIS PROJECT'S ORCHESTRATOR. The CDP read is editor-wide, so "the only
      // detected orchestrator frame" is not this window's — measured 2026-09-09, one shwab_docker PO
      // frame had been adopted as the orchestrator of BOTH Gaming and livegita, and a cycle there
      // would have banked Gaming's memory into a session that has never seen Gaming. So a frame is
      // only used when it is ATTRIBUTABLE to this project (dominant `loom/<repo>/` path mentions),
      // whether it was adopted this tick or recorded at tag time. Unattributable = no frame = the
      // cycle holds and says so.
      const mine = tracker.ownerView().filter((o) => o.repo === repo);
      // The tagged frame if it is still here, else adopt only a STRONG candidate and only when it is
      // the only one: a weak candidate (attributed but not self-identified) is a person's click, not
      // something to start typing `/clear` into on our own.
      const strong = mine.filter((o) => o.strong);
      const known = mine.find((o) => o.webviewId === orch.webviewId) ||
                    (strong.length === 1 ? strong[0] : undefined);
      if (known && known.webviewId !== orch.webviewId) setOrchestratorFrame(repo, known.webviewId);
      const state = loadState(repo);
      const windowTokens = Math.max(1000, Number(cfg().get("contextWindowTokens", DEFAULT_WINDOW_TOKENS)) || DEFAULT_WINDOW_TOKENS);
      const reading = readOrchestratorContext(repo, orch.role, state, windowTokens);
      const memoryFile = String(cfg().get("contextMemoryFile", "") || "") || defaultMemoryFile(repo, orch.role);
      const mem = statMemory(memoryFile);
      const base = contextConfig();
      const step = decide({
        repo, role: orch.role,
        webviewId: known ? known.webviewId : null,
        reading, busy: known ? known.busy : false, frameSeen: !!known, windowId,
        panelPct: known ? known.contextPct : null,
        panelChars: known ? known.chars : null,
        memoryFile, memoryMtime: mem.mtime, memorySize: mem.size, now: Date.now(),
        // A manual run skips the threshold and the cooldown — and NOTHING else. Every safety rule
        // (verified save, not mid-turn, timeouts) still applies.
        cfg: force ? { ...base, enabled: true, thresholdPct: 0, cooldownMinutes: 0 } : base,
        state,
      });
      // The panel's own number when the compact button is up, the transcript estimate otherwise.
      const panelPct = known ? known.contextPct : null;
      contextNote = panelPct !== null
        ? `${Math.round(panelPct)}% context used (its own figure)`
        : reading ? `~${pct(reading.fraction)}% context (${reading.tokens.toLocaleString()} tok, estimated)` : "";
      // Persist BEFORE injecting: if the injection fails, the phase still advances and the cycle
      // times out with a warning — a clear can never be sent twice.
      saveState(repo, step.next);
      debugLog({ contextMemory: { step: step.kind, note: step.note, phase: step.next.phase, reading } });
      if (step.kind === "none") return step;
      if (step.kind === "abort") { vscode.window.showWarningMessage(`Loom: ${step.note}`); return step; }
      const target = { role: orch.role, webviewId: known ? known.webviewId : null };
      const label = step.kind === "save" ? `Loom: ${step.note}`
        : step.kind === "clear" ? `Loom: ${orch.role} — ${step.note} (its context is being reset)`
        : `Loom: ${step.note}`;
      vscode.window.showInformationMessage(label);
      injectTo(target, step.message || "", "context-debug.json", (ok, note) => {
        if (!ok) vscode.window.showWarningMessage(
          `Loom: could not deliver the context-memory ${step.kind} to ${orch.role} (${note}).`);
      });
      return step;
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
        runContextMemory();
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
            (contextNote ? `\n\nOrchestrator: ${contextNote}` : "") +
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
        const live = new Set(tracker.view().filter((a) => a.liveness === "live").map((a) => a.role));
        const found = scanWorktrees(repo, root, live);
        if (!found.length) { vscode.window.showInformationMessage("Loom: no worktrees found for this project."); return; }
        const orphans = found.filter((w) => w.orphaned);
        // Offer ONLY what every safeguard clears: orphaned, clean, on a branch, no precious
        // ignored files, and not backing a live session.
        const removable = orphans.filter((w) => !w.dirty && w.branch && !w.risky.length && !w.live);
        const detached = found.filter((w) => !w.branch);
        const risky = found.filter((w) => w.risky.length);
        const lines = [
          `${found.length} worktree(s); ${orphans.length} orphaned (no role on the board); ` +
          `${removable.length} of those are clean and removable.`, "",
          ...(detached.length ? [`${detached.length} on a DETACHED HEAD — refused, their commits are on no branch.`] : []),
          ...(risky.length ? [`${risky.length} hold gitignored files git cannot restore (.env/keys/db) — refused.`] : []),
          "",
          ...found.map((w) => `${w.orphaned ? "orphan " : "on-board"} ${w.dirty ? "DIRTY" : "clean"}` +
            `${w.live ? " LIVE" : ""}${w.risky.length ? " RISKY" : ""}` +
            `${w.ahead ? ` +${w.ahead}` : ""}  ${w.branch || "DETACHED"}  ${w.role}`),
        ];
        const action = removable.length ? `Remove ${removable.length} orphaned clean worktree(s)` : undefined;
        const choice = await vscode.window.showInformationMessage(lines.join("\n"), { modal: true },
          ...(action ? [action] : []));
        if (!action || choice !== action || !root) return;
        const confirm = await vscode.window.showWarningMessage(
          `Remove ${removable.length} worktree(s)?\n\nOnly the checked-out directory is deleted. Every branch and ` +
          `commit is kept, and each removal is logged with its restore command in ` +
          `~/.claude/loom/worktree-removals.json.\n\nRefused automatically: dirty, still-rostered, live, ` +
          `detached-HEAD, or holding gitignored files git cannot restore.`,
          { modal: true }, "Remove");
        if (confirm !== "Remove") return;
        const notes = removable.map((w) => removeWorktree(root, w).note);
        vscode.window.showInformationMessage("Loom worktree cleanup:\n" + notes.join("\n"), { modal: true });
        await runTick();
      }),
      // Bank the orchestrator's memory now, whatever its context is. The clear still only happens
      // after the memory doc is verified on disk, on a later tick.
      vscode.commands.registerCommand("loomSessionTracker.bankContext", async () => {
        if (!repo) { vscode.window.showWarningMessage("Loom: no project in this window."); return; }
        const orch = getOrchestrator(repo);
        if (!orch) { vscode.window.showWarningMessage("Loom: no orchestrator tagged — nothing to bank."); return; }
        const ok = await vscode.window.showWarningMessage(
          `Ask '${orch.role}' to write its working memory, then CLEAR its context?\n\n` +
          `The clear is only sent once the memory file exists and was written after this request. ` +
          `If it is not written, nothing is cleared.`,
          { modal: true }, "Bank & clear");
        if (ok !== "Bank & clear") return;
        const step = runContextMemory(true);
        if (step && step.kind === "none") vscode.window.showInformationMessage(`Loom: ${step.note}`);
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
          // The name THIS bus already uses for its owner mailbox goes first (livegita -> `po`),
          // then the other accepted spellings, then the worker roles.
          const mine = ownerRoleFor(target);
          const owners = [mine, ...ORCHESTRATOR_CANDIDATES.filter((r) => r !== mine)];
          const others = Array.from(new Set([...boardRoles(target), ...tracker.view().map((a) => a.role)]))
            .filter((r) => !owners.includes(r)).sort();
          const roles = [...owners, ...others];
          return vscode.window.showQuickPick(roles, { placeHolder: "Which role is the orchestrator (receives finish notifications)?" });
        });
        if (!role) return;
        // A candidate node knows the exact frame; recording it is what makes the orchestrator
        // injectable at all (see inject.ts).
        // The clicked candidate's frame, else the one unambiguous candidate FOR THIS PROJECT —
        // never "the only frame in the editor", which belongs to whichever project it belongs to.
        const forTarget = tracker.ownerView().filter((o) => o.repo === target);
        const wid = (node && typeof node.webviewId === "string") ? node.webviewId
          : (forTarget.length === 1 ? forTarget[0].webviewId : null);
        setOrchestrator(target, role, wid);
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
