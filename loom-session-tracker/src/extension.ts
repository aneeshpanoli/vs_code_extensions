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
import { getOrchestrator, setOrchestrator, setOrchestratorFrame, ORCHESTRATOR_CANDIDATES, rebindSession } from "./orchestrator";
import { ownerRoleFor, publishNaming } from "./naming";
import { Notifier } from "./notifier";
import { readCount } from "./sessions";
import { LimitWatcher } from "./limits";
import { ModelPolicy, DEFAULT_PREMIUM, DEFAULT_WORKER_MODELS, desiredModel,
         chipFor, detectModel, isPremium, handoffId, lastDispatchAt } from "./models";
import { supplyReachBack } from "./reachback";
import { delegationTick, loadDelegation, saveDelegation, markReminded, delegationReminder,
         DEFAULT_WORK_MINUTES } from "./delegation";

/** What the spawn path's `/model` step actually did, recorded in spawn-debug.json (MS-001 R2b).
 *  `ok: false` means the tab is on the premium tier and must NOT be bound. */
interface PreModel { role: string; webviewId: string; want: string | null; typed: number;
                     acknowledged: string | null; chip: string | null; onPremium: boolean;
                     ok: boolean; note: string; }
import { buildDigest, renderDigest, Digest } from "./digest";
import { missingRoles, previouslyLive, strandedRoles, resumableFrom, ReopenCandidate } from "./reopen";
import { blankShells, closableShells } from "./blanks";
import { frameWatcher, openAndIdentify } from "./newframe";
import { rebindFrame, RebindLog, roleWorktree } from "./rebind";
import { planOpen, writeResult, strandedNote, Opened } from "./requests";
import { overlapFor, overlapReason } from "./overlap";
import { planFocus } from "./focus";
import { readFrames, openWindowRoots } from "./cdp";
import { isOwnerRole } from "./naming";
import { eligibleTargets, resolveOrchestrator } from "./dispatch";
import { HealthWatcher, checkHealth, countWorking, publishWorking, scanWorktrees, removeWorktree,
         isWorkingLike, boardSessionId, statusSessionId, sessionAgreement } from "./health";
import { watcherTick, loadWatchers, saveWatchers, markWatcherReminded,
         watcherReminder } from "./watchers";
import { gatherWork, collisions, overlapFinding, markOverlapReminded, overlapReminder,
         loadOverlapState, saveOverlapState, baseBranch } from "./duties";
import { quietTick, gatherSignals, loadQuiet, saveQuiet, markNotified, markDropped, quietMessage,
         gateByOpenWindow, DEFAULT_QUIET_MINUTES, FrameSeen, orchestratorSaid } from "./quiet";
import { sendPush, preflight, pushKey, DEFAULT_CONTAINER, DEFAULT_TIMEOUT_SEC } from "./push";
import { decide, loadState, saveState, defaultMemoryFile, statMemory, readOrchestratorContext,
         MemoryConfig, Step } from "./memory";
import { injectTo, setSenderWindow, setBuildVersion } from "./inject";
import { DEFAULT_WINDOW_TOKENS, pct, transcriptFor } from "./context";
import { planGc, applyGc, renderGc, gcSummary, fmtBytes, loadGcState, saveGcState, dueForAuto,
         finishAuto, refreshLease, liveSessionIdsOf, busLiveRoles, GcConfig, GcPlan, ApplyOptions,
         DEFAULT_GC_CONFIG } from "./gc";
import { refreshWorkLedger, computeWorkLedger, readCache, writeCache, handoffRows, renderReport, ledgerAlert, todayKey, briefingBlock,
         DEFAULT_PRODUCT_PATHS, DEFAULT_EXCLUDE_PATHS, DEFAULT_THRESHOLDS,
         DEFAULT_WINDOW_DAYS, DEFAULT_INTERVAL_MIN,
         Thresholds, WorkLedger } from "./workledger";

let timer: NodeJS.Timeout | undefined;

/** This build's version, read from the extension's own package.json — the only honest source. */
let VERSION = "unknown";

export function activate(context: vscode.ExtensionContext) {
  try {
    VERSION = String(JSON.parse(fs.readFileSync(
      path.join(context.extensionPath, "package.json"), "utf8")).version || "unknown");
  } catch { /* keep "unknown" */ }
  try {
    const cfg = () => vscode.workspace.getConfiguration("loomSessionTracker");
    const repo = currentRepo();     // THIS window's project — the tracker shows/writes only this repo
    // THIS window's folder. A transcript resumes only from the window whose cwd it was written under;
    // every reopen/open decision below is scoped to it (reopen.ts, measured 2026-09-13).
    const windowCwd: string | null = vscode.workspace.workspaceFolders?.[0]?.uri?.fsPath ?? null;
    // Publish the owner alias contract so loom_cdp.py reads the same set this extension enforces.
    publishNaming();
    const tracker = new Tracker(repo);
    tracker.setWindowRoot(vscode.workspace.workspaceFolders?.[0]?.name ?? null);
    tracker.setWindowCwd(windowCwd);
    setSenderWindow(vscode.workspace.workspaceFolders?.[0]?.name ?? null);
    // MOD-001 §5 · every reminder this extension injects names the build that sent it. VERSION is
    // read from the extension's own package.json above — the only honest source — so a stale window
    // stamps its OWN number rather than the tree's, which is the entire point.
    setBuildVersion(VERSION);
    const maxActive = () => Number(cfg().get("maxActiveSessions", MAX_ACTIVE_TOTAL)) || MAX_ACTIVE_TOTAL;
    const coord = new Coordinator(tracker, repo, maxActive());
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

    // Why the version stamp was NOT written this tick, or undefined when it was. Window state, not
    // a property of one log line: several things call debugLog in a tick and the file is
    // last-writer-wins, so a note attached to the tick's own call would be overwritten by the
    // garbage-collection note a few lines later and the refusal would be invisible.
    let stampNote: string | undefined;
    // Same reasoning for the model policy (MP-001): a handoff whose `model:` line was REFUSED, and a
    // spawned tab that never acknowledged its switch, are both states of this window rather than
    // events of one log line. Attached to their own debugLog call they would be overwritten within
    // the same tick — and an ignored frontmatter that says so nowhere is exactly the silence R1
    // exists to prevent.
    let modelNote: Record<string, any> | undefined;
    const noteModel = (k: string, v: any) => { modelNote = { ...(modelNote || {}), [k]: v }; };
    // And the same for CH-001's overlap warnings, for the same reason and it cost the same test
    // cycle: `runOverlapWarning` runs mid-tick, and `computeMissing`, `serveOpenRequests` and the
    // blank-shell note all debugLog AFTER it. A collision recorded on its own call is overwritten
    // within the tick that found it — the third time this file has learned that.
    let overlapNote: string[] | undefined;
    // NT-001 · what the stop notifier is doing, for the panel. The handoff requires that when the
    // transport is unavailable the feature is OFF AND SAYS SO rather than inventing another door.
    let quietNote: string | undefined;
    const debugLog = (obj: any) => {
      try {
        fs.writeFileSync(path.join(os.homedir(), ".claude", "loom", "tracker-debug.json"),
          JSON.stringify({ repo, ...(stampNote ? { stamp: stampNote } : {}),
                           ...(modelNote ? { model: modelNote } : {}),
                           ...(overlapNote ? { handoffOverlap: overlapNote } : {}),
                           ...(quietNote ? { quietNotifier: quietNote } : {}), ...obj }, null, 2));
      } catch { /* ignore */ }
    };
    const notifier = new Notifier(repo);
    const limitWatcher = new LimitWatcher(repo);
    const modelPolicy = new ModelPolicy(repo);
    const healthWatcher = new HealthWatcher(repo);
    // Roles that go `working` and never come back are invisible to the finish notifier, so watch
    // for them explicitly; and publish the cross-project working count that no single window sees.
    // WL-008 · how long a refused wake may go unremarked before the orchestrator is told. Ten
    // minutes: long enough that an ordinary mid-turn worker is never reported (the composer frees up
    // within a turn), short enough that 36 minutes of silence could not happen again.
    const PENDING_WAKE_MS = 10 * 60_000;
    const pendingWarned = new Set<string>();
    /** A role's status.json, or an empty object. Only `status` is read here; health.ts owns the
     *  richer reading and its stall clock. */
    const readRoleStatus = (forRepo: string, role: string): any => {
      try {
        return JSON.parse(fs.readFileSync(
          path.join(os.homedir(), ".claude", "loom", forRepo, role, "status.json"), "utf8")) || {};
      } catch { return {}; }
    };

    // ── PB-001 · §11 REACH-BACK, SUPPLIED RATHER THAN REMINDED ──────────────────────────────────
    //
    // Rank 2 of the owner's ranking: the tool provides the thing, so nobody has to remember it. It
    // produces NO message — which is the point, because a bus full of reminders is his own complaint
    // moved off him and onto the agents. Run on every tick so a handoff written between ticks is
    // still covered, and a no-op on every inbox that already carries one.
    const runReachBack = () => {
      if (!repo) return;
      if (cfg().get<boolean>("supplyReachBack", true) !== true) return;
      const tag = getOrchestrator(repo);
      if (!tag) return;                       // no sender to name; supplying an address would invent one
      for (const role of boardRoles(repo)) {
        if (role === tag.role) continue;
        const id = handoffId(repo, role);
        if (!id) continue;
        const r = supplyReachBack(repo, role, id, tag.role);
        if (r.supplied) debugLog({ reachBack: { role, id, note: r.note } });
      }
    };

    // ── PB-001 · §2 · THE ORCHESTRATOR IS DOING THE WORK ITSELF ──────────────────────────────────
    //
    // The owner: "If an orchestrator has been working for a while and it hasn't woken up any of its
    // loom agents, then it's time to remind it." Everything that decides whether this fires lives in
    // delegation.ts, pure and tested; this function only gathers the observation and delivers.
    const runDelegation = () => {
      if (!repo) return;
      if (cfg().get<boolean>("delegationReminders", true) !== true) return;
      const tag = getOrchestrator(repo);
      // THE ORCHESTRATOR'S OWN FRAME, and `null` when it was not seen. Unknown is not idle: a tick
      // that cannot see the frame must neither count work nor reset the stretch.
      const own = tag && tag.webviewId
        ? tracker.ownerView().find((o) => o.webviewId === tag.webviewId && o.liveness === "live")
        : null;
      const workers = (tag ? boardRoles(repo).filter((r) => r !== tag.role) : [])
        .map((role) => ({ role, working: isWorkingLike(readRoleStatus(repo, role).status) }));
      const prev = loadDelegation(repo);
      const mins = Number(cfg().get("delegationMinutes", DEFAULT_WORK_MINUTES)) || DEFAULT_WORK_MINUTES;
      const r = delegationTick(
        { repo, orchestrator: tag ? tag.role : null, busy: own ? own.busy : null,
          workers, lastDispatch: lastDispatchAt(repo) }, prev, mins);
      if (!r.finding) { saveDelegation(repo, r.state); return; }
      // Mid-turn is the normal state for a session that has been working for half an hour, so a
      // refusal here is expected and costs nothing: the latch is untouched and the next idle tick
      // delivers. LATCHED ONLY ON DELIVERY — see markReminded.
      if (own && own.busy) { saveDelegation(repo, r.state); return; }
      const f = r.finding;
      injectTo({ role: f.orchestrator, webviewId: tag && tag.webviewId ? tag.webviewId : null, repo },
               delegationReminder(f), "delegate-debug.json", (ok, note) => {
        if (ok) saveDelegation(repo, markReminded(r.state));
        debugLog({ delegation: { orchestrator: f.orchestrator, workedMinutes: f.workedMinutes,
                                 idle: f.idle, busy: f.busyWorkers, ok, note } });
      });
      saveDelegation(repo, r.state);
    };

    // ── DU-001 · §19 · TWO LIVE BLOCKS ON ONE FILE ──────────────────────────────────────────────
    //
    // The owner: "It is better for us to make the files modular so there is never more than one
    // worker on any file", and "this should also be part of the session add-on, so the orchestrators
    // know their duties." Everything that DECIDES lives in duties.ts, pure and tested; this function
    // only gathers the observation and delivers it.
    //
    // WHY IT READS WORKTREES RATHER THAN HANDOFFS. `overlap.ts` already enforces §19 from the
    // handoffs' `files:` front-matter and has never refused anything on this bus — 3 of 25 blocks
    // declare `files:` at all. This reads what the worktrees actually contain, so it does not depend
    // on a declaration nobody writes. It does not touch overlap.ts, which another live handoff owns.
    const runDuties = () => {
      if (!repo) return;
      if (cfg().get<boolean>("overlapReminders", true) !== true) return;
      const tag = getOrchestrator(repo);
      if (!tag) return;                      // nobody to tell; the finding is the orchestrator's
      // ONLY ROLES THAT ARE ACTUALLY WORKING. A finished worker's worktree still holds its whole
      // block until the orchestrator merges it, so counting idle roles would report every pair of
      // banked blocks as a live collision — the loudest possible false positive.
      const live = boardRoles(repo)
        .filter((r) => r !== tag.role)
        .filter((r) => isWorkingLike(readRoleStatus(repo, r).status));
      if (live.length < 2) return;           // no pair, nothing to say — the common case
      const works = live.map((role) => {
        const wt = roleWorktree(repo, role, windowCwd);
        if (!wt) return { role, handoff: handoffId(repo, role), files: [] as string[] };
        return gatherWork(wt, baseBranch(wt), handoffId(repo, role), role);
      });
      const prev = loadOverlapState(repo);
      const r = overlapFinding(prev, collisions(works));
      if (!r.finding) { saveOverlapState(repo, r.state); return; }
      const f = r.finding;
      injectTo({ role: tag.role, webviewId: tag.webviewId ? tag.webviewId : null, repo },
               overlapReminder(f), "overlap-debug.json", (ok, note) => {
        // LATCHED ONLY ON DELIVERY, like every other reminder here: a refused injection (a busy
        // composer) must leave the finding armed for the next tick rather than swallowing it.
        if (ok) saveOverlapState(repo, markOverlapReminded(r.state, f));
        debugLog({ overlapReminder: { roles: f.roles, handoffs: f.handoffs,
                                      files: f.files.slice(0, 5), ok, note } });
      });
      saveOverlapState(repo, r.state);
    };

    // ── NT-001 · TELL HIM WHEN A PROJECT GOES QUIET ─────────────────────────────────────────────
    //
    // The owner: "Any time activity stops completely in any of the windows I want to know which
    // project it is, and when it stopped … if I am away from my desk I should be able to come back
    // and check what's done." Everything that DECIDES lives in quiet.ts, pure and tested; everything
    // that SENDS lives in push.ts. This function only gathers the observation and delivers it.
    //
    // WHICH TABLE THIS MESSAGE BELONGS TO (0.43.0 reporting contract): NEITHER. `withContract` splits
    // messages into ORCHESTRATOR_KINDS and WORKER_KINDS, and both are things typed into a COMPOSER by
    // injectTo. This one goes to a phone. It is not injected, it reaches no session, and it must not
    // carry the reporting contract — appending "the decision the owner must make" to a push
    // notification would be nonsense. It is a third kind: extension -> human, out of band.
    //
    // OFF BY DEFAULT and opt-in. Nothing below can send anything while the setting is false, and the
    // setting's own description says plainly that it leaves the machine.
    const runQuiet = () => {
      if (cfg().get<boolean>("quietPushEnabled", false) !== true) return;
      const now = Date.now();
      // Every frame this window can see, reduced to (project, mid-turn?). A window sees the whole
      // editor, so one window's view covers every project open in it.
      const frames: FrameSeen[] = [
        ...tracker.view().filter((a: any) => a.liveness === "live")
                 .map((a: any) => ({ repo: a.repo ?? null, busy: tracker.busyRoles.has(a.role) })),
        ...tracker.ownerView().filter((o) => o.liveness === "live")
                 .map((o) => ({ repo: o.repo ?? null, busy: o.busy })),
      ];
      const mins = Number(cfg().get("quietMinutes", DEFAULT_QUIET_MINUTES)) || DEFAULT_QUIET_MINUTES;
      const pcfg = { container: String(cfg().get("quietPushContainer", DEFAULT_CONTAINER) || DEFAULT_CONTAINER),
                     timeoutSec: DEFAULT_TIMEOUT_SEC };
      const st = loadQuiet();
      const findings: { repo: string; title: string; body: string; key: string }[] = [];
      for (const sig of gatherSignals(frames, now)) {
        const r = quietTick(sig, st.projects[sig.repo], now, mins);
        st.projects[sig.repo] = r.state;
        if (r.finding) {
          // NT-001-R2 · HIS WORDS: "when a project is truly done it usually ends with a summary from
          // the orchestrator, and I want that summary to come along with the notification."
          //
          // READ HERE, AT DETECTION, and NOT at send time like the open-window gate — the two are
          // evaluated differently on purpose. Openness is a fact about HIM that can change while
          // preflight runs (he can close a window in those seconds), so it must be read as late as
          // possible. The last message is a fact about a project that this branch has just concluded
          // is QUIET: nothing is appending to that transcript, so re-reading it seconds later would
          // return the same bytes. Reading it here also means it costs nothing on the overwhelming
          // majority of ticks, which produce no finding at all.
          //
          // It resolves the orchestrator for THIS finding's repo, not for the window's — runQuiet is
          // cross-project by design, and a stop in another project must carry ITS orchestrator's
          // words, not this window's.
          const m = quietMessage(r.finding, orchestratorSaid(sig.repo));
          findings.push({ repo: sig.repo, title: m.title, body: m.body,
                          key: pushKey(sig.repo, r.finding.stoppedAt) });
        }
      }
      saveQuiet(st);                       // watermarks advance whether or not anything is sent
      if (findings.length === 0) return;
      // DELIVERY IS ASYNC so a dead container cannot hang a tick, and LATCHES ONLY ON DELIVERY: a
      // send that failed is a notification nobody received, and latching it would mean "told" for a
      // phone that was never told (WL-006/WL-008/CL-001, and delegation.markReminded for the same).
      void (async () => {
        const ready = await preflight(pcfg, undefined);
        if (!ready.delivered) {
          quietNote = `stop notifier ${ready.note}`;
          debugLog({ quiet: { skipped: findings.map((f) => f.repo), why: ready.note } });
          return;                          // NOT latched — it will be reported when the door works
        }
        // NT-001-R1 · HIS CONVENTION: only a project whose window is OPEN may be reported.
        // READ HERE, AFTER PREFLIGHT, AND NOT EARLIER. Openness is evaluated at SEND time because
        // preflight can take seconds and he may close the window in them — and by his convention a
        // stop that was pending when the window closed must not be told. The decision itself is
        // pure and lives in quiet.ts; this only supplies the observation and obeys the split.
        const gate = gateByOpenWindow(findings, await openWindowRoots());
        for (const f of gate.dropped) {
          // DROPPED, NOT DEFERRED — latched so a reopened window never backfills this stop.
          const cur = loadQuiet();
          if (cur.projects[f.repo]) { cur.projects[f.repo] = markDropped(cur.projects[f.repo]); saveQuiet(cur); }
          debugLog({ quiet: { repo: f.repo, dropped: "window closed — his convention says stay silent" } });
        }
        if (gate.withheld.length > 0) {
          // NOT latched: doubt is not closure, so these are reconsidered next tick and reported
          // once the window list can be read. Said out loud rather than silently swallowed.
          quietNote = `stop held: window list unreadable (${gate.withheld.map((f) => f.repo).join(", ")})`;
          debugLog({ quiet: { withheld: gate.withheld.map((f) => f.repo), why: "window list unreadable — not treated as closed" } });
        }
        if (gate.dropped.length > 0 && gate.send.length === 0 && gate.withheld.length === 0) {
          quietNote = `stop dropped: ${gate.dropped.map((f) => f.repo).join(", ")} window closed`;
        }
        for (const f of gate.send) {
          const res = await sendPush(pcfg, f.title, f.body, f.key, undefined);
          if (res.delivered) {
            const cur = loadQuiet();       // re-read: other projects' ticks may have written since
            if (cur.projects[f.repo]) {
              cur.projects[f.repo] = markNotified(cur.projects[f.repo]);
              saveQuiet(cur);
            }
          }
          quietNote = `${f.repo}: ${res.note}`;
          debugLog({ quiet: { repo: f.repo, title: f.title, delivered: res.delivered, note: res.note } });
        }
      })();
    };

    // ── WC-001 · §17 — THIS SESSION ARMED A WATCHER ─────────────────────────────────────────────
    //
    // Rank 3, and the rank was the deliverable: the block that produced this was asked whether §17
    // was enforceable AT ALL, with "no, reclassify it" accepted in advance. It is — a session writes
    // its own tool calls to disk and this extension already parses those records. All the judgement
    // lives in watchers.ts, pure and tested; this only resolves the address and delivers.
    const runWatchers = () => {
      if (!repo) return;
      if (cfg().get<boolean>("watcherReminders", true) !== true) return;
      const tag = getOrchestrator(repo);
      if (!tag) return;
      // PB-001's IDENTITY RULE, and this detector is unsafe without it: the transcript is addressed
      // by session id, so a stale id reads a DEAD session's records as today's. Identity is the AND
      // of the board and the role's own status.json; a disagreement is a transition in flight, and
      // `null` here makes watcherTick count nothing and re-baseline nothing.
      const boardSid = boardSessionId(repo, tag.role);
      const statusSid = statusSessionId(readRoleStatus(repo, tag.role));
      const agree = sessionAgreement(boardSid, statusSid);
      const sid = agree.agree ? (boardSid || statusSid) : null;
      const prev = loadWatchers(repo);
      const r = watcherTick({ repo, orchestrator: tag.role, sessionId: sid,
                              transcript: sid ? transcriptFor(sid) : null,
                              lastDispatch: lastDispatchAt(repo) }, prev);
      if (!r.finding) { saveWatchers(repo, r.state); return; }
      const own = tag.webviewId
        ? tracker.ownerView().find((o) => o.webviewId === tag.webviewId && o.liveness === "live")
        : null;
      // Mid-turn is refused, exactly as the delegation reminder is: the latch is untouched and the
      // next idle tick delivers. LATCHED ONLY ON DELIVERY — see markWatcherReminded.
      if (own && own.busy) { saveWatchers(repo, r.state); return; }
      const f = r.finding;
      injectTo({ role: f.orchestrator, webviewId: tag.webviewId ? tag.webviewId : null, repo },
               watcherReminder(f), "watch-debug.json", (ok, note) => {
        if (ok) saveWatchers(repo, markWatcherReminded(r.state, sid, f.lastDispatch));
        debugLog({ watchers: { orchestrator: f.orchestrator, kinds: f.kinds,
                               armings: f.armings.length, ok, note } });
      });
      saveWatchers(repo, r.state);
    };

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
      // WL-006 · WAKE THE ROLE WHOSE GATE HAS FINISHED. Its turn ended while the gate ran, so nothing
      // else will ever tell it; measured three times, most recently 18 minutes during which the
      // outbox still named the previous handoff. The role is woken, not the orchestrator: the
      // orchestrator did not launch the gate, and ringing it would put a person back in the
      // transport, which is the workaround this replaces.
      //
      // MARKED ONLY ON DELIVERY. A worker mid-turn cannot be typed into (dispatch.ts: the line would
      // queue as an ordinary message and never run), so a busy composer leaves the event unmarked and
      // the next tick tries again. Marking on attempt would mean "woken" for a role never told.
      //
      // WL-008 · THE FRAME, FOR A WORKER *OR* THE ORCHESTRATOR. `tracker.view()` is the tracked
      // AGENTS; the orchestrator's own frame lives in `ownerView()`. So an orchestrator that
      // declared a gate raised an event that could never find a frame and would have sat refused
      // for ever — the same silent failure as the busy latch, one role over, and invisible for the
      // same reason. It is resolved through the TAG, which is how every other message to the
      // orchestrator is addressed.
      const frameFor = (role: string, forRepo: string): { webviewId: string; busy: boolean } | null => {
        const a = tracker.view().find((v) => v.role === role && v.repo === forRepo
                                             && v.liveness === "live");
        if (a) return { webviewId: a.webviewId, busy: tracker.busyRoles.has(a.role) };
        const tag = repo ? getOrchestrator(repo) : null;
        if (tag && tag.role === role && tag.webviewId) {
          const o = tracker.ownerView().find((x) => x.webviewId === tag.webviewId
                                                   && x.liveness === "live");
          if (o) return { webviewId: o.webviewId, busy: o.busy };
        }
        return null;
      };
      for (const ev of healthWatcher.scanGates(report)) {
        healthWatcher.wake(ev, frameFor(ev.role, ev.repo), (ok, note) => {
          if (ok) healthWatcher.markWoken(ev.role, ev.key);
          // REFUSALS ARE RECORDED. Delivery-only marking is right, but it meant a wake refused on
          // every tick for 36 minutes changed nothing on disk, and "never finished" and "refused
          // 140 times" looked identical from outside. Now they do not.
          else healthWatcher.recordWakeRefused(ev.role, ev.key, note);
          debugLog({ gateWake: { role: ev.role, pid: ev.pid, log: ev.log, ok, note } });
        });
      }
      // CL-001 · A BLOCK DISPATCHED INTO A SESSION THAT WAS NEVER CLEARED. Playbook §12 has said to
      // clear and re-bind between every handoff since 2026-09-08 and, measured across every bus on
      // 2026-09-16, 18 of the 24 readable roles were carrying more than one block anyway — one of
      // them 22. A rule in prose is advice; this is the tool noticing. It is a REMINDER to the
      // orchestrator and nothing else: no gate, no score, nothing withheld, and it is marked only
      // once it was actually DELIVERED, so a busy composer means "tell it next tick", never
      // "consider it told".
      if (cfg().get<boolean>("clearReminders", true) === true) {
        for (const ev of healthWatcher.scanClears(report)) {
          if (!orch) { debugLog({ clearReminder: { role: ev.role, blocks: ev.blocks, ok: false,
                                  note: "no orchestrator tag on this bus — nobody to remind" } }); continue; }
          healthWatcher.remindClears(ev, orch.role, (ok, note) => {
            if (ok) healthWatcher.markClearReported(ev.role, ev.newId);
            debugLog({ clearReminder: { role: ev.role, newId: ev.newId, blocks: ev.blocks, ok, note } });
          });
        }
      }
      // A wake that has been refused continuously is itself a finding: the role is asleep with an
      // answer waiting and the mechanism meant to tell it cannot. Said ONCE per stuck wake, to the
      // orchestrator, because at this point a person is the only remaining transport.
      for (const p of healthWatcher.pendingBeyond(PENDING_WAKE_MS)) {
        if (!orch || pendingWarned.has(p.key)) continue;
        pendingWarned.add(p.key);
        vscode.window.showWarningMessage(
          `Loom: ${p.role}'s gate finished but the wake has been refused for ` +
          `${p.pendingMinutes.toFixed(0)} min (${p.attempts} attempts): ${p.note}`);
        healthWatcher.alert({ repo: report ? report.repo : (repo || ""), role: p.role,
                              status: "gate finished, wake refused", staleHours: p.pendingMinutes / 60 },
                            orch.role);
      }
    };
    // CH-001 R2, the half the tracker cannot refuse. The spawn path REFUSES an overlapping handoff
    // (requests.ts), because there the tab does not exist yet and withholding it costs nothing. A
    // role that is ALREADY BOUND is rung by the orchestrator through reach_po.py — off-git, no part
    // of this extension, nothing to intercept — so the only honest move is to say so, once per
    // colliding pair, and let the human read it. Warn only; the handoff's own words.
    //
    // Deliberately NOT gated behind a setting: it writes nothing, types nothing and opens nothing,
    // and a warning a project can switch off is one nobody sees the day it matters.
    const overlapWarned = new Set<string>();
    const runOverlapWarning = () => {
      if (!repo) return;
      const notes: string[] = [];
      for (const role of boardRoles(repo)) {
        if (isOwnerRole(role)) continue;
        let ov = null;
        try { ov = overlapFor(repo, role); } catch { continue; }   // a half-written bus is not a warning
        if (!ov) continue;
        // One warning per colliding PAIR, not per direction and not per tick: two working roles each
        // see the other, and the tick runs every 15 seconds.
        const key = [role, ov.other].sort().join("|");
        if (overlapWarned.has(key)) continue;
        overlapWarned.add(key);
        vscode.window.setStatusBarMessage(
          `Loom: ${role}'s handoff ${overlapReason(ov)}, which is working — one handoff is one merge (§19)`, 15000);
        notes.push(`${role} ${overlapReason(ov)}`);
      }
      if (notes.length) { overlapNote = [...(overlapNote || []), ...notes]; debugLog({}); }
    };
    // Keep the expensive tier for the orchestrator only: workers found on a premium model get
    // switched back with `/model <default>`, the same way `/loom <role>` binds a session.
    const runModelPolicy = () => {
      if (cfg().get("enforceWorkerModel", true) !== true) return;
      const premium = (cfg().get("premiumModels", DEFAULT_PREMIUM) as string[]) || DEFAULT_PREMIUM;
      const target = String(cfg().get("workerModel", "claude-opus-5") || "claude-opus-5");
      const allow = (cfg().get("workerModels", DEFAULT_WORKER_MODELS) as string[]) || DEFAULT_WORKER_MODELS;
      // The tier is the HANDOFF's choice now (MP-001): resolved per role, from that role's inbox
      // frontmatter, and only ever within the allowlist. A request the tracker refuses is noted
      // once per tick rather than swallowed — an ignored `model:` line that says nothing anywhere
      // is indistinguishable from one that worked.
      const notes: string[] = [];
      const defaulted: string[] = [];
      const wanted = (role: string) => {
        const d = desiredModel(repo, role, target, allow);
        if (d.note) notes.push(d.note);
        return d;
      };
      const orch = repo ? getOrchestrator(repo) : null;
      // A `/model` typed into a BUSY composer is queued as a message and never runs (see
      // tracker.busyRoles). Busy roles are withheld from this tick entirely: not a violation, not an
      // attempt, no backoff growth — they are judged on the first idle tick instead.
      const busy = tracker.busyRoles;
      // `/model` is a COMMAND: only an idle composer executes it. See dispatch.ts.
      const live = new Set(eligibleTargets(tracker.view(), busy, "command", repo).map((t) => t.role));
      const idleModels = new Map(Array.from(tracker.modelState()).filter(([r]) => live.has(r)));
      const frameOf = new Map(tracker.view().map((a) => [a.role, a.webviewId] as [string, string]));
      // R3 (CH-001): the ledger records where a block FINISHED in the worker's context, and that
      // number exists only on the panel — it is CDP data, so the tick has to hand it in. null below
      // ~50 %, where the panel renders no compact button at all; models.ts says why that is honest.
      const pctOf = new Map(tracker.view().map((a) => [a.role, a.contextPct ?? null] as [string, number | null]));
      // R4/R5 run over every role the bus knows, not only the idle ones: a loop-back is reported by
      // a role that has just STOPPED, and a ledger line must close for a role whose tab has gone.
      if (repo) for (const role of boardRoles(repo)) {
        if (isOwnerRole(role)) continue;
        try {
          const esc = modelPolicy.escalate(role, target, allow);
          if (esc) {
            debugLog({ modelEscalated: esc });
            vscode.window.showInformationMessage(
              `Loom: ${esc.role} has looped back twice on ${esc.id} — raising that handoff to ${esc.to}.`);
          }
          modelPolicy.ledgerTick(role, target, allow, new Date(), pctOf.get(role) ?? null);
          // MS-001 R1: a handoff with no `model:` line runs the default, as before — but says so,
          // once per (role, handoff id), persisted. Silent defaults were how MP-001 "worked" on
          // every bus but one for a day without anyone writing the line.
          const dn = modelPolicy.noteDefaulted(role, target, allow);
          if (dn) { vscode.window.setStatusBarMessage(`Loom: ${dn}`, 15000); defaulted.push(dn); }
        } catch { /* a tick must survive a half-written bus */ }
      }
      if (defaulted.length) { noteModel("defaulted", defaulted); debugLog({ modelDefaulted: defaulted }); }
      for (const v of modelPolicy.check(idleModels, orch ? orch.role : null, live, premium, Date.now(),
                                        frameOf, orch ? orch.webviewId ?? null : null, wanted)) {
        // Toast the first attempt; retries stay quiet in the status bar so a stuck session
        // cannot spam notifications every backoff window.
        const why = v.chosenBy === "frontmatter" ? "its handoff asks for" : "it is owed";
        const what = `${v.role} is on ${v.model} — ${why} ${v.target}`;
        if (v.attempt === 1) vscode.window.showInformationMessage(`Loom: ${what}.`);
        else vscode.window.setStatusBarMessage(`Loom: ${what} (retry ${v.attempt}).`, 8000);
        modelPolicy.enforce(v, v.target, (ok, note) => {
          modelPolicy.recordResult(v, ok, note);
          if (!ok && v.attempt === 1) vscode.window.showWarningMessage(
            `Loom: could not switch ${v.role} off ${v.model} (${note}) — retrying, or run /model ${v.target} there.`);
        });
      }
      if (notes.length) { noteModel("frontmatterIgnored", notes); debugLog({ modelFrontmatterIgnored: notes }); }
      // AND THAT IS THE WHOLE POLICY — it ends with the workers (MP-002, owner 2026-09-16: "The
      // extension changing orchestrators model version. Must stop. It only applies to
      // non-orchestrators."). Two blocks used to follow here and both typed `/model` into the
      // orchestrator's own frame: the PROMOTION to the premium tier (2026-09-13), and the SELF-SHIFT
      // through `<repo>/orchestrator-model.json` (MS-001 R3, 2026-09-14). Both owner directions are
      // reversed; both blocks are gone, along with their settings and every function they called.
      //
      // Nothing replaces them, deliberately — an orchestrator's tier is now set by the person or by
      // the session itself, and the extension has no opinion. `models.enforce()` refuses an
      // orchestrator frame outright, so re-adding a caller here would not resurrect the behaviour.
    };
    const DEFAULT_RESUME =
      "[loom-resume] Your usage limit has reset. Pick up where you left off: re-read your inbox and " +
      "the handoff you were on, continue the work, and keep status.json current.";
    // Wake any role whose usage limit has lifted. Detection is the banner CLEARING (exact), not the
    // UI's coarse "resets in 2h" estimate.
    const runLimitWatcher = () => {
      if (cfg().get("autoResumeAfterLimit", true) !== true) return;
      // A resume is a MESSAGE: queuing behind the current turn is correct. See dispatch.ts.
      const live = new Set(eligibleTargets(tracker.view(), tracker.busyRoles, "message", repo).map((t) => t.role));
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
    // file. CX-001: THE EXTENSION DOES NOT CLEAR IT — a person does, on their own timing, and when
    // that clear is observed the restore prompt reads the memory back and reconciles it with the
    // docs. Every rule lives in memory.decide(); this function is the I/O around it.
    let contextNote = "";
    // Identifies this window for the duration of its life. Two windows are routinely scoped to the
    // same project (a worktree window resolves to its parent repo id), and only one may drive a cycle.
    const windowId = `${process.pid}:${Math.random().toString(36).slice(2, 8)}`;
    const contextConfig = (): MemoryConfig => ({
      enabled: cfg().get<boolean>("contextMemory", true) === true,
      thresholdPct: Math.min(95, Math.max(10, Number(cfg().get("contextThresholdPct", 30)) || 30)),
      saveTimeoutMinutes: Math.max(1, Number(cfg().get("contextSaveTimeoutMinutes", 10)) || 10),
      // CX-001 · `contextClearTimeoutMinutes` was read here and is gone: it timed how long to wait
      // for a fresh session after a `/clear` THIS EXTENSION SENT, and it no longer sends one.
      cooldownMinutes: Math.max(0, Number(cfg().get("contextCooldownMinutes", 15)) ?? 15),
    });
    // ── WL-001 · the work ledger ───────────────────────────────────────────────────────────────
    // Read the settings once per call, so a change takes effect on the next tick without a reload.
    const workLedgerOpts = () => ({
      windowDays: Math.max(1, Number(cfg().get("workLedgerWindowDays", DEFAULT_WINDOW_DAYS)) || DEFAULT_WINDOW_DAYS),
      productPaths: (cfg().get<Record<string, string[]>>("productPaths", DEFAULT_PRODUCT_PATHS) ||
                     DEFAULT_PRODUCT_PATHS),
      // R7a: subtracted from product whatever productPaths matches, and kept separate so what was
      // taken out is visible rather than buried in the product globs.
      excludePaths: (cfg().get<string[]>("excludePaths", DEFAULT_EXCLUDE_PATHS) ||
                     DEFAULT_EXCLUDE_PATHS),
      intervalMin: Math.max(1, Number(cfg().get("workLedgerIntervalMin", DEFAULT_INTERVAL_MIN)) || DEFAULT_INTERVAL_MIN),
    });
    const thresholds = (): Thresholds => {
      const t = cfg().get<Partial<Thresholds>>("workLedgerThresholds", {}) || {};
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
    };

    /**
     * R1's cache refresh + R5's one line to the orchestrator. Never throws — a git repo that is
     * mid-rebase, absent, or not a repo at all must not cost this window its tick.
     *
     * R5 is the whole point of the handoff: the number has to reach the session that decides what
     * to build NEXT. So it goes to the tagged orchestrator only — never to a worker, who cannot
     * choose the next block — and only into an IDLE composer, the same discipline as `/model`
     * (dispatch.ts: a command typed into a busy composer queues as an ordinary message and never
     * executes). Once per project per calendar day, the day recorded in work-ledger.json beside the
     * figures, so a reload does not re-announce and two windows on one project cannot both announce.
     */
    const runWorkLedger = () => {
      if (!repo) return;
      if (cfg().get<boolean>("workLedgerEnabled", true) !== true) return;
      const cache = refreshWorkLedger(repo, repoRoot(), workLedgerOpts());
      if (!cache) return;
      const msg = ledgerAlert(cache.ledger, cache.notifiedOn, thresholds());
      if (!msg) return;
      const orch = getOrchestrator(repo);
      if (!orch) return;                                   // nobody decides the next block here yet
      // IDLE ONLY. `busy` is the frame's own mid-turn state; an alert typed over a running turn is
      // the noise that gets this feature switched off in a week.
      const frame = tracker.ownerView().find((o) => o.webviewId === orch.webviewId &&
                                                    o.liveness === "live");
      if (!frame || frame.busy) return;                    // not now; the day is still unspoken for
      // Stamp the day BEFORE injecting. injectTo is fire-and-forget over a subprocess, so a stamp
      // written in its callback can lose a race with the next tick 15 s later and announce twice;
      // at worst this costs one missed day, which is the cheaper failure by far.
      writeCache(repo, { ...cache, notifiedOn: todayKey() });
      debugLog({ workLedger: { repo, shipsToUser: cache.ledger.shipsToUser, notified: true } });
      injectTo({ role: orch.role, webviewId: orch.webviewId, repo }, msg, "ledger-debug.json");
    };

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
      // THE BOARD OUTRANKS THE TAG. Measured 2026-09-09: livegita's tag was pointed by hand at a
      // diagnostic session (5426095b) twice in one evening, because that was the only candidate the
      // sidebar offered; the finish notifier then typed a developer's loop-back into it. The board
      // entry for `po` had carried the real frame (f13a5e27) the whole time. So when the board names
      // exactly one frame for this project, that is the orchestrator — a stale or misclicked tag is
      // re-pointed at it, not honoured.
      const declared = mine.filter((o) => o.declared);
      const strong = mine.filter((o) => o.strong);
      const known = (declared.length === 1 ? declared[0] : undefined) ||
                    mine.find((o) => o.webviewId === orch.webviewId) ||
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
        // WL-003 · the one message a fresh orchestrator is guaranteed to read.
        briefing: briefingFor(repo, orch.role),
        // A manual run skips the threshold and the cooldown — and NOTHING else. Every safety rule
        // (verified save, not mid-turn, timeouts) still applies.
        cfg: force ? { ...base, enabled: true, thresholdPct: 0, cooldownMinutes: 0 } : base,
        state,
      });
      // The panel's own number when the compact button is up, the transcript estimate otherwise.
      const panelPct = known ? known.contextPct : null;
      contextNote = panelPct !== null
        ? `${Math.round(panelPct)}% context used (its own figure)`
        : reading ? `~${pct(reading.fraction)}% context (${reading.tokens.toLocaleString()} tok, estimated)` +
                    // a visible panel with no button is under 50%: say so next to the estimate (memory.ts)
                    (/no compact button/.test(step.note) ? ` — ${step.note}` : "")
                  : "";
      // Persist BEFORE injecting: if the injection fails, the phase still advances and the cycle
      // times out with a warning — a clear can never be sent twice.
      saveState(repo, step.next);
      // The clear gave the orchestrator a NEW session id; the board still records the old one, which
      // reads as a dead, still-full transcript forever (the fourteen-clear night). We are the party
      // that saw the fresh transcript appear, so record it — before the restore prompt goes out.
      if (step.kind === "restore" && step.next.sessionId && step.next.sessionId !== state.sessionId &&
          rebindSession(repo, orch.role, step.next.sessionId))
        debugLog({ rebound: { role: orch.role, sessionId: step.next.sessionId } });
      debugLog({ contextMemory: { step: step.kind, note: step.note, phase: step.next.phase, reading } });
      if (step.kind === "none") return step;
      if (step.kind === "abort") { vscode.window.showWarningMessage(`Loom: ${step.note}`); return step; }
      const target = { role: orch.role, webviewId: known ? known.webviewId : null, repo };
      // No `clear` arm: `decide()` cannot return one (memory.ts), and if some future edit made it,
      // `injectTo` refuses it by role (inject.ts). Nothing here needs to describe a reset.
      const label = `Loom: ${step.note}`;
      vscode.window.showInformationMessage(label);
      // MC-001 · the reply hint is keyed by WHICH of the three messages this is (save/clear/restore),
      // not by the shared debug log file — see inject.ts's REPLY_FOR and injectTo's `replyKind`.
      const replyKind = step.kind === "save" ? "context-save" : "context-restore";
      injectTo(target, step.message || "", "context-debug.json", (ok, note) => {
        if (!ok) vscode.window.showWarningMessage(
          `Loom: could not deliver the context-memory ${step.kind} to ${orch.role} (${note}).`);
      }, replyKind);
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

    // ── sessions that came back empty after a reload: offered EVERY tick until none are missing ──
    // Opening is always a click (never automatic — the 2026-07-12 rule). See reopen.ts.
    const reopenStatus = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 49);
    reopenStatus.command = "loomSessionTracker.reopenMissing";
    context.subscriptions.push(reopenStatus);
    let missingNow: ReopenCandidate[] = [];
    const computeMissing = () => {
      if (!repo) { missingNow = []; return; }
      const live = new Set<string>(tracker.view().filter((a) => a.liveness === "live").map((a) => a.role));
      // an orchestrator frame present in this window counts every owner spelling as live
      if (tracker.ownerView().some((o) => o.repo === repo && o.liveness === "live")) {
        for (const r of boardRoles(repo)) if (isOwnerRole(r)) live.add(r);
      }
      missingNow = missingRoles(repo, live, windowCwd);
      const stranded = strandedRoles(repo, live, windowCwd);
      if (missingNow.length) {
        reopenStatus.text = `$(history) Loom: reopen ${missingNow.length}`;
        reopenStatus.tooltip = `Sessions that are not open in this window:\n` +
          missingNow.map((m) => `  ${m.role}  ←  ${m.sessionId.slice(0, 8)} (${m.source}, ` +
            `${new Date(m.mtime).toLocaleString()})`).join("\n") + `\nClick to reopen them (each with its memory).` +
          (stranded.length ? `\nCannot be reopened from this window (would open blank):\n` +
            stranded.map((s) => `  ${s.role}  ←  ${s.sessionId.slice(0, 8)} lives under ${s.cwd || "another cwd"}`).join("\n") : "");
        reopenStatus.show();
      } else reopenStatus.hide();
    };
    // Click a role in the sidebar -> its tab comes to the front. Claude's editor.open reveals an
    // already-open session (see focus.ts); we only call it when the session is provably open.
    context.subscriptions.push(vscode.commands.registerCommand("loomSessionTracker.focusSession",
      async (arg: { repo?: string | null; role?: string } | undefined) => {
        const role = arg && arg.role; const target = (arg && arg.repo) || repo;
        if (!role) return;
        const plan = planFocus(target, role);
        if (plan.kind === "refuse") { vscode.window.setStatusBarMessage(`Loom: cannot show ${role} — ${plan.reason}`, 9000); return; }
        try { await vscode.commands.executeCommand("claude-vscode.editor.open", plan.sessionId, undefined, undefined); }
        catch (e: any) { vscode.window.showWarningMessage(`Loom: could not show ${role}: ${String(e && e.message || e)}`); }
      }));
    context.subscriptions.push(vscode.commands.registerCommand("loomSessionTracker.reopenMissing", async () => {
      computeMissing();
      if (!missingNow.length) { vscode.window.showInformationMessage("Loom: every role session is open."); return; }
      const items = missingNow.map((m) => ({
        label: m.role, description: `${m.sessionId.slice(0, 8)} · ${m.source}`,
        detail: new Date(m.mtime).toLocaleString(), id: m.sessionId, picked: true,
      }));
      const picks = await vscode.window.showQuickPick(items, {
        canPickMany: true, placeHolder: `Reopen ${items.length} session(s) with their memory — all are preselected`,
      });
      if (!picks || !picks.length) return;
      let n = 0;
      for (const p of picks) {
        try { await vscode.commands.executeCommand("claude-vscode.editor.open", p.id, undefined, undefined); n++; }
        catch (e: any) { vscode.window.showErrorMessage(`Loom: could not reopen ${p.label}: ${String(e.message || e)}`); }
      }
      vscode.window.setStatusBarMessage(`Loom: reopened ${n} session(s).`, 8000);
    }));

    // ── the RESTART path (user direction 2026-09-09: "remember their loom role, rebind them on
    // restart, then wake the PO to continue the work"). Roles that were live before the reload are
    // reopened from their freshest transcript WITHOUT a click — the one exception to the never-open-
    // tabs-automatically rule — and once the orchestrator's frame is back, it is woken once.
    const wasLive = repo ? previouslyLive(repo) : new Set<string>();
    let restartReopenDone = false;
    let wakePending = false;
    const restartReopen = async () => {
      if (restartReopenDone || !repo) return;
      restartReopenDone = true;
      if (!cfg().get<boolean>("autoReopenOnRestart", true)) return;
      computeMissing();
      const todo = missingNow.filter((m) => wasLive.has(m.role) || isOwnerRole(m.role));
      // Roles that were live but whose transcripts this window cannot resume are NOT reopened: that
      // is exactly the blank-tab path. They are logged; the orchestrator's wake tells it to spawn.
      const stranded = strandedRoles(repo, new Set(missingNow.map((m) => m.role)), windowCwd)
        .filter((s) => wasLive.has(s.role));
      if (stranded.length) debugLog({ restartStranded: stranded.map((s) => `${s.role}<-${s.sessionId.slice(0, 8)} @ ${s.cwd || "?"}`) });
      if (!todo.length) return;
      // Snapshot the blank shells BEFORE opening anything: only these are ever closable, and only
      // if they are still blank afterwards. See blanks.ts for why each clause matters. The SAME read
      // seeds the frame watcher, so identifying the reopened tabs costs no extra CDP round trip.
      let before: string[] = [];
      const watcher = frameWatcher(readFrames);
      let seeded = false;
      try { const snap = await readFrames(); before = blankShells(snap); watcher.seedFrom(snap); seeded = true; }
      catch { /* no read, no closing */ }
      if (!seeded) await watcher.seed();
      const reopenBinds: RebindLog[] = [];
      const ambiguous: string[] = [];
      // ONE AT A TIME, and each one's frame is written back to the bus. Belt and braces with the
      // tracker's session-id match: a panel that has only just been asked to open may not be able to
      // answer what session it is running for a tick or two, and this path knows the answer without
      // asking — it opened that tab, from that role's transcript, and watched exactly one frame
      // appear. Ambiguity (0 or ≥2 new frames) writes NOTHING and leaves the healing to the tracker.
      const n = await openAndIdentify(todo, (sessionId) =>
        vscode.commands.executeCommand("claude-vscode.editor.open", sessionId, undefined, undefined),
        watcher, {
        identified: (role, wid) => {
          // frameText null: we have not read this panel, and not reading it is not evidence against
          // whatever guard string its id file carries. See rebind.rebindFrame.
          const log = rebindFrame(repo, role, wid, null, false);
          if (log) reopenBinds.push(log);
        },
        failed: (role, error) => debugLog({ restartReopenFailed: role, error }),
        ambiguous: (role) => ambiguous.push(role),
      });
      if (reopenBinds.length) debugLog({ restartRebound: reopenBinds });
      if (ambiguous.length) debugLog({ restartReopenAmbiguous: ambiguous });
      // NO CLOSING HERE. 0.26.0 closed the blank shells once their sessions were back, through CDP
      // `/json/close` on the webview target — and that closes the OWNING WINDOW, not the tab. Three
      // windows (Gaming, funisland, shwab_docker) were lost on the next restart. The shells are
      // therefore left in place; `blanks.ts` still identifies them, for a future tab-scoped close via
      // vscode.window.tabGroups, which must be tested against a live window before it is trusted.
      if (before.length) debugLog({ blankShellsLeftInPlace: before.map((w) => w.slice(0, 8)) });
      wakePending = n > 0;
      vscode.window.setStatusBarMessage(`Loom: reopened ${n} session(s) after restart` +
        (wakePending ? " — waking the orchestrator when it is back" : ""), 12000);
      debugLog({ restartReopened: todo.map((m) => `${m.role}<-${m.sessionId.slice(0, 8)}`) });
    };
    // An orchestrator can write files and ring sessions, but only the extension can open a tab. This
    // serves `<repo>/open-requests.json` so a PO can bring its own roles back instead of asking the
    // user to click (see requests.ts for the boundaries).
    /**
     * Type `/model <desired>` into a freshly opened frame and wait, bounded, for the session to
     * acknowledge it — then return so the caller can bind. Returns what happened, for the debug log.
     *
     * Why acknowledge rather than fire-and-forget: the footer chip LAGS a switch by a whole turn
     * (models.ts, measured 2026-09-13), so the chip cannot confirm anything here; the panel's
     * "Set model to <name>" line can, and it appears at once. Why bounded: a tab that never answers
     * must not hold the whole spawn loop — every other role in the request is waiting behind it.
     */
    /** What the tab's footer says right now, or null when the frame cannot be read. */
    const frameModel = async (wid: string) => {
      try {
        const f = (await readFrames()).find((x) => String(x.webviewId) === wid);
        return f ? detectModel(String((f as any).text || "")) : null;
      } catch { return null; }
    };
    /** The ack outcome belongs in spawn-debug.json, which `injectTo` rewrites per injection — so it
     *  is MERGED in after the fact rather than written before and clobbered by the `/loom` that
     *  follows. Until MS-001 that file held only the bind, which is why three tabs could start a
     *  handoff on Fable with nothing on disk saying the `/model` step had done nothing. */
    const recordSpawnModel = (pm: PreModel) => {
      const f = path.join(os.homedir(), ".claude", "loom", "spawn-debug.json");
      let cur: any = {};
      try { cur = JSON.parse(fs.readFileSync(f, "utf8")) || {}; } catch { /* first write */ }
      try { fs.writeFileSync(f, JSON.stringify({ ...cur, model: pm }, null, 2)); } catch { /* never fatal */ }
    };
    const premodel = async (role: string, wid: string): Promise<PreModel> => {
      const base: PreModel = { role, webviewId: wid, want: null, typed: 0, acknowledged: null,
                               chip: null, onPremium: false, ok: true, note: "" };
      if (!repo || cfg().get("enforceWorkerModel", true) !== true) return { ...base, note: "disabled" };
      const dflt = String(cfg().get("workerModel", "claude-opus-5") || "claude-opus-5");
      const allow = (cfg().get("workerModels", DEFAULT_WORKER_MODELS) as string[]) || DEFAULT_WORKER_MODELS;
      const premium = (cfg().get("premiumModels", DEFAULT_PREMIUM) as string[]) || DEFAULT_PREMIUM;
      const want = desiredModel(repo, role, dflt, allow);
      if (want.note) { noteModel("frontmatterIgnored", [want.note]); debugLog({ modelFrontmatterIgnored: [want.note] }); }
      const chip = chipFor(want.model);
      const bound = Math.max(0, Number(cfg().get("modelAckMs", 8000)) || 0);
      // R2b (MS-001, measured on pleodo 2026-09-14T03:46:53Z): three tabs were spawned, all three
      // came up on FABLE 5.1, and the spawn typed nothing at all — their handoffs asked for
      // `claude-opus-5`, which IS the configured default, and the old early return
      // ("default tier — nothing to type") assumed a fresh tab always starts on the pin. It does
      // not. So the decision is made on what the FRAME says, not on the setting: type whenever the
      // chip is not already the wanted one and either the handoff asked for something else or the
      // tab is sitting on the premium tier. A frame we cannot read still falls back to the old rule.
      const MAX = 2;                                        // the first attempt, then one retry
      let seen = await frameModel(wid);
      const already = () => !!(seen && chip && seen.model.toLowerCase() === chip.toLowerCase());
      const premiumNow = () => isPremium(seen ? seen.model : null, premium);
      if (already()) return { ...base, want: want.model, chip, note: `already on ${chip}` };
      if (want.model === dflt && !premiumNow()) return { ...base, want: want.model, chip, note: "default tier — nothing to type" };
      let typed = 0, ack: string | null = null, lastNote = "";
      for (let attempt = 1; attempt <= MAX; attempt++) {
        typed = attempt;
        // The composer is idle here — the tab has no session yet — so a refused injection is worth
        // retrying at once rather than waiting for a tick that cannot type into a busy composer.
        const sent = await new Promise<{ ok: boolean; note: string }>((res) =>
          injectTo({ role, webviewId: wid, repo }, `/model ${want.model}`, "spawn-debug.json",
                   (ok, note) => res({ ok, note })));
        if (!sent.ok) { lastNote = `/model refused: ${sent.note}`; seen = await frameModel(wid); continue; }
        const deadline = Date.now() + bound;
        while (Date.now() < deadline) {
          await new Promise((r) => setTimeout(r, Math.min(500, Math.max(1, deadline - Date.now()))));
          seen = await frameModel(wid);
          const a = seen && seen.acknowledged ? seen.acknowledged : null;
          if (a && chip && a.toLowerCase() === chip.toLowerCase()) { ack = a; break; }
          if (already()) { ack = seen!.model; break; }          // the chip itself caught up
        }
        if (ack) return { ...base, want: want.model, chip, typed, acknowledged: ack, note: `acknowledged ${ack}` };
        lastNote = lastNote || `no acknowledgement within ${bound}ms`;
        seen = await frameModel(wid);
        if (already()) return { ...base, want: want.model, chip, typed, note: `chip reads ${chip}` };
      }
      // Out of attempts. A tab still on the PREMIUM tier must not be bound: `/loom <role>` starts the
      // inbox check, the composer is busy from that moment, and the idle tick can never switch it —
      // which is how three whole handoffs ran on Fable, 71/55/70 turns deep before anyone noticed.
      // Anywhere else (an unreadable frame, a cheaper-but-wrong tier) the bind still goes ahead: the
      // next idle tick corrects a mistuned worker, and an unbound tab just sits there.
      const onPremium = premiumNow();
      return { ...base, want: want.model, chip, typed, onPremium, ok: !onPremium,
               note: onPremium ? `on premium — /model refused (${lastNote || "no acknowledgement"})`
                               : `${lastNote} — bound anyway, the next idle tick will switch it` };
    };

    let serving = false;
    const serveOpenRequests = async () => {
      if (serving || !repo) return;
      if (cfg().get<boolean>("serveOpenRequests", true) !== true) return;
      const live = new Set(tracker.view().filter((a) => a.liveness === "live").map((a) => a.role));
      const slots = Math.max(0, coord.cap() - coord.activeTotal());
      const plan = planOpen(repo, live, slots, Date.now(), windowCwd);
      if (!plan.consumed) return;
      serving = true;
      try {
        const opened: Opened[] = [];
        // Frames before, so each new tab can be told apart and its id handed back to the orchestrator.
        // Shared with the restart path — see newframe.ts.
        const watcher = frameWatcher(readFrames);
        await watcher.seed();
        const newFrame = () => watcher.next();
        for (const c of plan.open) {
          try {
            await vscode.commands.executeCommand("claude-vscode.editor.open", c.sessionId, undefined, undefined);
            opened.push({ role: c.role, sessionId: c.sessionId, from: c.source, webviewId: await newFrame() });
          } catch (e: any) { plan.refused.push({ role: c.role, reason: `open failed: ${String(e && e.message || e)}` }); }
        }
        for (const role of plan.spawn) {
          // A role that has never had a session: open a fresh conversation and bind it, exactly as a
          // person would (`/loom <role>` is what records the binding). Only into the frame we watched
          // appear — never by role name, which is how a bind once landed in another project's tab.
          try {
            await vscode.commands.executeCommand("claude-vscode.editor.open", undefined, undefined, undefined);
            const wid = await newFrame();
            if (!wid) { plan.refused.push({ role, reason: "opened a new tab but could not tell which frame it is — bind it by hand" }); continue; }
            // R3 (MP-001): put the tab on the right tier BEFORE binding it. `/loom <role>` runs the
            // inbox check, and from that moment the composer is busy — a `/model` typed after it
            // would queue as an ordinary message and never execute (dispatch.ts). Only when the
            // handoff asks for something other than the configured default, because a fresh tab
            // already comes up on that. The bind is NOT conditional on the switch: on no
            // acknowledgement within the bound we bind anyway and leave the tier to the next idle
            // tick, which is R2's job — a role that is bound but on the wrong model gets corrected,
            // a role that is never bound just sits there.
            const pm = await premodel(role, wid);
            noteModel("spawn", pm); debugLog({ spawnModel: pm }); recordSpawnModel(pm);
            if (!pm.ok) {
              // R2b: a worker must never BEGIN a handoff on the premium tier. Hand the frame back
              // with the reason on it, so the orchestrator can ring the tab and type /model itself.
              opened.push({ role, sessionId: null, from: "spawned", webviewId: wid, bound: false, note: pm.note });
              plan.refused.push({ role, reason: `opened but NOT bound — ${pm.note}` });
              vscode.window.showWarningMessage(
                `Loom: ${role}'s new tab is on ${pm.chip ? `a premium model, not ${pm.chip}` : "the premium tier"} and /model was refused — NOT bound. ` +
                `Run /model ${pm.want} in that tab (${wid.slice(0, 8)}), then /loom ${role}.`);
              continue;
            }
            const st = plan.stranded.find((x) => x.role === role);
            await new Promise<void>((res) => injectTo({ role, webviewId: wid, repo }, `/loom ${role}`, "spawn-debug.json",
              (ok, note) => { recordSpawnModel(pm);   // the bind rewrote the file; put the ack outcome back
                              opened.push({ role, sessionId: null, from: "spawned", webviewId: wid, bound: ok,
                                            ...(st ? { note: strandedNote(st) } : {}) });
                              if (!ok) plan.refused.push({ role, reason: `opened but binding failed: ${note}` }); res(); }));
          } catch (e: any) { plan.refused.push({ role, reason: `spawn failed: ${String(e && e.message || e)}` }); }
        }
        writeResult(repo, opened, plan.refused);
        // The orchestrator just chose what the next block does. That is the decision the audit
        // exists to inform, so arm it here rather than on a timer.
        if (opened.length) briefPending = true;
        debugLog({ servedOpenRequest: { opened, refused: plan.refused } });
        if (opened.length) vscode.window.setStatusBarMessage(
          `Loom: ${repo} orchestrator asked for ${opened.length} session(s) — opened`, 10000);
        else if (plan.refused.length) vscode.window.setStatusBarMessage(
          `Loom: ${repo} open request refused (${plan.refused[0].reason})`, 10000);
      } finally { serving = false; }
    };

    // WL-003 · THE AUDIT, ADDRESSED TO THE SESSION THAT CAN ACT ON IT.
    //
    // Scoped to the orchestrator's OWN session id, because a developer's tool calls are not the
    // orchestrator's time and reporting them as such would be the same category error WL-001 was
    // written to refuse. The id lives in board.json, not in orchestrator.json (which carries only
    // the role and the frame), so it is read from there — and when it cannot be read the briefing
    // reports its allocation as UNMEASURED rather than as a clean zero.
    const briefingFor = (r: string, role: string): string => {
      try {
        const b = JSON.parse(fs.readFileSync(
          path.join(os.homedir(), ".claude", "loom", r, "board.json"), "utf8"));
        const sid = b && b[role] && typeof b[role].session_id === "string" ? b[role].session_id : null;
        const w = computeWorkLedger(r === repo ? repoRoot() : null,
                                    { nowMs: Date.now(), sessionIds: sid ? [sid] : null });
        return briefingBlock(w, true);
      } catch { return ""; }
    };

    // Delivered at the SECOND decision point: the orchestrator has just been given the tab(s) it
    // asked for, and what it does with the next block is open. Not typed into a running turn — the
    // same discipline every other injection here is held to — so it waits for an idle composer.
    let briefPending = false;
    const deliverBriefing = () => {
      if (!briefPending || !repo) return;
      const orch = getOrchestrator(repo);
      const frame = orch && orch.webviewId
        ? tracker.ownerView().find((o) => o.webviewId === orch.webviewId && o.liveness === "live") : null;
      if (!orch || !frame || frame.busy) return;       // mid-turn: try again next tick
      const text = briefingFor(repo, orch.role);
      briefPending = false;                            // spent either way; do not accumulate
      if (!text.trim()) return;
      injectTo({ role: orch.role, webviewId: orch.webviewId, repo }, text.trim(), "brief-debug.json");
    };

    const wakeOrchestrator = () => {
      if (!wakePending || !repo) return;
      const orch = getOrchestrator(repo);
      const frame = orch && orch.webviewId
        ? tracker.ownerView().find((o) => o.webviewId === orch.webviewId && o.liveness === "live") : null;
      if (!orch || !frame) return;                     // not back yet; try next tick
      wakePending = false;
      injectTo({ role: orch.role, webviewId: orch.webviewId, repo },
        "[loom-restart] The editor was restarted and your role sessions were reopened with their memory. " +
        "Re-read your inbox, the board and each role's status.json, then continue the work where it stood. " +
        "If a role's tab did NOT come back, do not wait for a person and do not hold its lane: write " +
        "~/.claude/loom/<repo>/open-requests.json {\"roles\":[...],\"requestedAt\":\"<iso>\"} and the tab is " +
        "opened for you within seconds, with its webviewId written back into the file (playbook §15). " +
        // PB-001 §4 · THE ONE POINTER, AND IT RIDES A MESSAGE THAT WAS ALREADY GOING OUT.
        //
        // The owner's standing rules live in 22 sections of a file an orchestrator only obeys if it
        // happens to have read it, and he has been the one reminding them it exists. But the fix for
        // that is NOT to attach the playbook, a digest of it, or a rules list to every message: his
        // two most recent complaints are "500 lines of garbage" and "just bullet points only", so a
        // version of this feature that makes every message longer is the thing he objected to,
        // shipped under a new name. Every other rule in this product reaches a session at the MOMENT
        // IT APPLIES, on the message that is already about that rule — §12 on the clear reminder,
        // §21 on the reporting contract, §8/§19 on the delegation reminder.
        //
        // What is worth its bytes exactly once is that the file EXISTS and where. This is the one
        // moment an orchestrator begins a thread with no memory of the last one and re-reads
        // everything anyway, and it is the only orchestrator-facing message the tool sends that is
        // about starting rather than about a specific event. The `/loom <role>` bind cannot carry
        // it — loom_cdp.py executes any line starting with "/" verbatim, so appended text would
        // corrupt the command — and the context RESTORE, the other candidate, no longer fires at an
        // orchestrator at all now that §22 has removed the automatic clear. So: here, once, 96
        // characters, naming the path and nothing else from those 533 lines.
        "Your standing rules are ~/.claude/loom/ORCHESTRATION-PLAYBOOK.md — read it once, now.",
        "restart-debug.json");
    };

    const runTick = async () => {
      try {
        // One project, or all of them — the window can switch without reloading.
        const showAll = cfg().get<boolean>("showAllProjects", false) === true;
        tracker.setFilter(showAll ? null : repo);
        tree.setRepo(showAll ? null : repo);
        const r = await tracker.tick();
        // A bus record moved because a SESSION ID said so — the only rewrite the tracker is licensed
        // to make (see rebind.ts). Logged with old→new so a rewrite is never silent: this is the file
        // a person reads when `reach_po.py @<repo>/<role>.id` starts reaching somebody new.
        if (r.rebinds.length) debugLog({ reboundBySessionId: r.rebinds });
        // STAMP THE RUNNING VERSION. Each editor window keeps the code it loaded at its last
        // reload, so "deployed" and "running" drift silently and every symptom looks like a bug that
        // was already fixed. Measured 2026-09-10 00:27: 0.21.1 was registered while a window was
        // still writing a targetmap only a pre-0.19.2 build produces. Now the bus says which build
        // each window is actually running, and `./live.sh` reports a window that is behind.
        stampNote = undefined;                   // this tick's answer, not the last one's
        try {
          // KEYED BY WINDOW, not by project. Two windows are routinely open on one project (a
          // worktree window resolves to its parent repo id) and would share a slot, so whichever
          // ticked second hid the other's build; every folderless window collapsed into one
          // "(no project)" entry. Garbage collection reads this to decide which builds are still in
          // use, so a hidden window is a build that looks collectable while an editor is running it.
          const stamp = path.join(os.homedir(), ".claude", "loom", "running-versions.json");
          // A READ THAT CANNOT ANSWER IS NOT PERMISSION TO REWRITE — principle 16, on the WRITER's
          // side of the file. The first version was `catch { /* first */ }`, which treats "there is
          // no file" and "I could not read the file" as the same thing, and they are opposites.
          // Starting from `{}` and then publishing ATOMICALLY erases every other window's entry, and
          // gc reads the result as a perfectly readable file naming ONE version — so every other
          // running build becomes collectable in tier 1, the unattended tier, for the ~15 s until
          // the other windows re-stamp. The ways that read fails are ordinary: a torn file from any
          // pre-0.33.0 window still rewriting this non-atomically every 15 s, EMFILE, a transient
          // EACCES. Only ENOENT means "first".
          let all: any = {};
          let raw: string | null = null;
          try {
            raw = fs.readFileSync(stamp, "utf8");
          } catch (e: any) {
            if (!e || e.code !== "ENOENT") stampNote = `read failed (${String(e && e.code || e)}) — not rewritten`;
          }
          if (!stampNote && raw !== null) {
            let parsed: any;
            let broke = false;
            try { parsed = JSON.parse(raw); } catch { broke = true; }
            if (broke) stampNote = "unparseable — not rewritten";
            else if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) stampNote = "not an object — not rewritten";
            else all = parsed;
          }
          // NO SELF-HEAL on a file that exists and will not parse. The tempting repair — re-read
          // after a moment and, if the bytes are identical, call it stably corrupt and start over —
          // is not provably safe: an old build rewriting this file non-atomically can leave it
          // truncated for longer than any re-read gap, so "unchanged" would license exactly the
          // erasure this guard exists to prevent. Refusing is bounded and visible instead: gc's
          // reader refuses the whole extension tier on the same file (over-keeping costs disk), the
          // reason is in `tracker-debug.json` every tick, and `rm running-versions.json` is a repair
          // a person can make in one line. A wedged stamp over-keeps builds; a confidently wrong one
          // archives a build out from under a live editor.
          if (!stampNote) {
            all[windowId] = { version: VERSION, at: new Date().toISOString(), repo: repo || null };
            // Prune entries no window has refreshed in a week, or the file grows a key per reload
            // forever (a new pid and a new windowId every time). An entry whose `at` will not parse
            // is pruned too: it can say neither that its window is alive nor when it last was, and
            // while it stays it holds its version in gc's keep-set with nothing that can ever age it
            // out. Every build writes ISO here, so an unparseable `at` is damage, not an older shape.
            const weekAgo = Date.now() - 7 * 86_400_000;
            for (const [k, v] of Object.entries<any>(all)) {
              if (k === windowId) continue;
              const at = Date.parse(String(v && v.at || ""));
              if (!Number.isFinite(at) || at < weekAgo) delete all[k];
            }
            // ATOMIC: ten windows rewrite this every 15 s, and gc refuses to collect any build when
            // it reads a torn file — so a plain write would routinely disable the extension tier.
            const tmp = stamp + ".tmp." + process.pid;
            fs.writeFileSync(tmp, JSON.stringify(all, null, 2));
            fs.renameSync(tmp, stamp);
          }
        } catch (e: any) {
          // A version stamp must never break a tick. `stampNote` is already set for the refusals
          // above; anything else that lands here is a write that failed.
          if (!stampNote) stampNote = `write failed (${String(e && e.code || e && e.message || e)})`;
        }
        debugLog({ version: VERSION, repo, ok: r.ok, error: r.error, liveRoles: r.liveRoles,
                   agents: tracker.view().map((a) => `${a.repo}/${a.role}`) });
        runNotifier();
        runLimitWatcher();
        runModelPolicy();
        runOverlapWarning();
        runHealth();
        try { runReachBack(); } catch { /* a supply must never break a tick */ }
        try { runDelegation(); } catch { /* a reminder must never break a tick */ }
        try { runWatchers(); } catch { /* a reminder must never break a tick */ }
        try { runDuties(); } catch { /* a reminder must never break a tick */ }
        try { runQuiet(); } catch { /* a notifier must never break a tick */ }
        runContextMemory();
        try { runWorkLedger(); } catch { /* a measurement must never break a tick */ }
        try { computeMissing(); wakeOrchestrator(); deliverBriefing(); } catch { /* a reopen offer must never break a tick */ }
        serveOpenRequests().catch(() => { /* never break a tick */ });
        tree.refresh();
        if (r.ok) {
          const total = coord.activeTotal();   // agents + orchestrator
          const sc = tracker.sessionCount();
          const warnAt = Math.max(1, Number(cfg().get("sessionWarnThreshold", 5)) || 5);
          const busy = !!sc && sc.sessions > warnAt;
          status.text = `$(broadcast) Loom: ${total}/${coord.cap()}` +
            (sc ? ` \u00b7 ${sc.sessions} open` : "");
          status.tooltip = `Active in ${repo || "this window"}: ${total}/${coord.cap()} ` +
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
          status.backgroundColor = (total >= coord.cap() || busy)
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
      // The automatic pass rides the interval, not just activation: a window left open for a week
      // would otherwise collect exactly once, at the moment it started. dueForAuto() makes every
      // other tick a single small JSON read.
      timer = setInterval(() => { runTick().then(() => runAutoGc()).catch(() => { /* never break the tick */ }); }, ms);
      context.subscriptions.push({ dispose: () => timer && clearInterval(timer) });
    };

    // ── garbage collection across projects ─────────────────────────────────────────────────
    // Nothing else in this extension looks ACROSS projects at what has stopped being used, and the
    // cost of that is not disk: an orphan worktree or a dead board id feeds straight back into an
    // orchestrator's context every time it reads a board or lists worktrees (gc.ts). Tier 1 is
    // automatic because every one of its actions is a move into `_archive/`; tier 2 needs a click
    // because it removes a directory; tier 3 is never acted on at all.
    const gcConfig = (): GcConfig => ({
      enabled: cfg().get<boolean>("gcEnabled", DEFAULT_GC_CONFIG.enabled) === true,
      intervalHours: Math.max(1, Number(cfg().get("gcIntervalHours", 24)) || 24),
      transcriptDays: Math.max(1, Number(cfg().get("gcTranscriptDays", 14)) || 14),
      backupDays: Math.max(1, Number(cfg().get("gcBackupDays", 7)) || 7),
      staleBusDays: Number(cfg().get("staleBusDays", DEFAULT_GC_CONFIG.staleBusDays)) || DEFAULT_GC_CONFIG.staleBusDays,
    });
    /** repo id -> checkout root. Only THIS window's project is known for certain; every other bus
     *  is probed at the conventional `~/Containers/<repo>` and accepted only if it is a git repo.
     *  A repo with no root here simply has no worktrees considered — the safe direction. */
    const gcRepoRoots = (): Record<string, string> => {
      const out: Record<string, string> = {};
      const root = repoRoot();
      if (repo && root) out[repo] = root;
      for (const r of busRepos()) {
        if (out[r]) continue;
        const guess = path.join(os.homedir(), "Containers", r);
        try { if (fs.statSync(path.join(guess, ".git")).isDirectory()) out[r] = guess; } catch { /* not there */ }
      }
      return out;
    };
    /**
     * The live roster garbage collection is judged against. `tracker.view()` is scoped to THIS
     * window's project by design, and the automatic pass is machine-wide — so on its own it reports
     * every other project as having nothing live, and every other project's worktrees and
     * transcripts lose their live protection. The bus knows better: a role whose `status.json` was
     * written in the last half hour is running, whoever is watching it. Union of the two.
     */
    const gcLive = (): { roles: Set<string>; sessionIds: Set<string> } => {
      const bus = busLiveRoles(Date.now());
      const mine = new Set(tracker.view().filter((a) => a.liveness === "live")
        .map((a) => `${a.repo}/${a.role}`));
      const roles = new Set<string>([...bus.roles, ...mine]);
      return { roles, sessionIds: new Set<string>([...bus.sessionIds, ...liveSessionIdsOf(mine)]) };
    };
    /** The world AS IT IS at apply time — read fresh, never carried over from planning. Without the
     *  live roster here, `health.removeWorktree`'s live refusal could never fire from gc at all. */
    const gcApplyOptions = (refresh?: () => boolean): ApplyOptions => {
      const live = gcLive();
      return { repoRoots: gcRepoRoots(), liveRoles: live.roles, liveSessionIds: live.sessionIds, refresh };
    };
    const computeGcPlan = (): GcPlan | null => {
      if (!gcConfig().enabled) return null;
      try {
        return planGc({ now: Date.now(), cfg: gcConfig(), currentVersion: VERSION,
                        liveRoles: gcLive().roles, repoRoots: gcRepoRoots() });
      } catch { return null; }         // planning must never break a tick
    };
    /** The once-per-machine-per-interval tier-1 pass, behind the cross-window lease. */
    const runAutoGc = () => {
      const c = gcConfig();
      const state = loadGcState();
      const decision = dueForAuto(state, windowId, Date.now(), c);
      if (!decision.run) { debugLog({ gc: decision.note }); return; }
      saveGcState(decision.next);                       // claim it before doing any work
      let result = null;
      let note = decision.note;
      try {
        const plan = computeGcPlan();
        // Planning walks every project directory and can outlast the lease on its own; refresh the
        // claim before the moves start, or the pass expires under its own holder mid-run.
        const mid = refreshLease(loadGcState(), windowId, Date.now());
        if (mid) saveGcState(mid);
        if (plan) {
          // Returns whether the claim was actually WRITTEN. `refreshLease` declines while the claim
          // is younger than half the lease, and the applier must not treat a decline as a refresh —
          // if it did, each decline would push the next attempt a further half-lease out from a
          // moment at which nothing was written.
          const keepClaim = (): boolean => {
            const r = refreshLease(loadGcState(), windowId, Date.now());
            return r ? saveGcState(r) : false;
          };
          result = applyGc(plan, [1], gcApplyOptions(keepClaim));
          note = `tier 1: ${result.done.length} collected (${fmtBytes(result.bytesFreed)}), ${result.skipped.length} skipped`;
          if (result.done.length) {
            vscode.window.setStatusBarMessage(
              `Loom: collected ${result.done.length} item(s), ${fmtBytes(result.bytesFreed)} — archived under _archive/${plan.date}.`, 8000);
          }
        } else note = "collection is off";
      } catch (e: any) { note = `aborted: ${String(e && e.message || e).slice(0, 80)}`; }
      saveGcState(finishAuto(loadGcState(), Date.now(), result, note, windowId));
      debugLog({ gc: note });
    };
    /** Tiers 1+2, after a confirmation that names the counts. */
    const collectGarbage = async (): Promise<void> => {
      const plan = computeGcPlan();
      if (!plan) { vscode.window.showInformationMessage("Loom: garbage collection is disabled (gcEnabled)."); return; }
      const n1 = plan.tier1.length, n2 = plan.tier2.length;
      if (!n1 && !n2) {
        vscode.window.showInformationMessage(
          "Loom: nothing to collect." + (plan.tier3.length ? ` ${plan.tier3.length} item(s) need your decision — see the digest.` : ""));
        return;
      }
      const answer = await vscode.window.showWarningMessage(
        `Loom: collect ${n1} tier-1 item(s) (archived) and ${n2} tier-2 item(s) (worktrees removed, ` +
        "branches kept; board entries marked dead)? Nothing is deleted — everything moves to " +
        `_archive/${plan.date} or keeps its branch.`, "Collect", "Cancel");
      if (answer !== "Collect") { vscode.window.setStatusBarMessage("Loom: nothing collected.", 4000); return; }
      const result = applyGc(plan, [1, 2], gcApplyOptions());
      saveGcState(finishAuto(loadGcState(), Date.now(), result, "manual tiers 1+2", windowId));
      vscode.window.setStatusBarMessage(
        `Loom: collected ${result.done.length} item(s), ${fmtBytes(result.bytesFreed)}; ${result.skipped.length} skipped.`, 8000);
      if (result.skipped.length) {
        vscode.window.showInformationMessage(
          "Loom: skipped —\n" + result.skipped.map((s) => `• ${s.item.label}: ${s.note}`).join("\n"), { modal: true });
      }
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
      gcPlan: computeGcPlan(),
    });

    /** Offer to reopen roles whose session evaporated. Always an explicit click — never automatic. */
    const reopenMissing = async (d: Digest) => {
      const picks = await vscode.window.showQuickPick(
        d.missingSessions.map((m) => ({ label: m.role, description: m.sessionId.slice(0, 8), id: m.sessionId })),
        { canPickMany: true, placeHolder: "Reopen which role sessions?" });
      if (!picks || !picks.length) return;
      let n = 0;
      for (const p of picks) {
        // The board's session id resumes only from the window it was written under; elsewhere
        // editor.open makes a blank tab (reopen.ts). Say so instead of opening one.
        const file = transcriptFor(p.id);
        if (file && !resumableFrom(file, windowCwd)) {
          vscode.window.showWarningMessage(`Loom: ${p.label}'s session ${p.id.slice(0, 8)} was written under another folder ` +
            `and cannot be reopened from this window — it would open blank.`);
          continue;
        }
        try { await vscode.commands.executeCommand("claude-vscode.editor.open", p.id, undefined, undefined); n++; }
        catch (e: any) { vscode.window.showErrorMessage(`Loom: could not reopen ${p.label}: ${String(e.message || e)}`); }
      }
      vscode.window.setStatusBarMessage(`Loom: reopened ${n} session(s).`, 6000);
    };

    const showDigest = async (force: boolean) => {
      const d = computeDigest();
      if (!d) return;
      debugLog({ digest: renderDigest(d) });
      if (!force && (!d.actionable || !cfg().get<boolean>("showStartupDigest", true))) return;
      // Garbage is machine-wide housekeeping, not this project's business, so it never makes an
      // otherwise-clear project look like it needs you — it rides along once the digest is up.
      const gcN = d.gc ? d.gc.tier1.length + d.gc.tier2.length : 0;
      if (!d.actionable) {
        const clear = "Loom: nothing needs your attention." +
          (gcN ? ` ${gcN} item(s) of garbage could be collected across projects.` : "");
        const c = await vscode.window.showInformationMessage(clear, ...(gcN ? ["Collect garbage"] : []));
        if (c === "Collect garbage") await collectGarbage();
        return;
      }
      const actions = ["Details"];
      if (!d.orchestratorTagged) actions.push("Tag orchestrator");
      if (d.missingSessions.length) actions.push("Reopen sessions");
      if (gcN) actions.push("Collect garbage");
      const headline =
        [d.awaitingPickup.length && `${d.awaitingPickup.length} response(s) waiting`,
         d.blocked.length && `${d.blocked.length} blocked on a decision`,
         d.limited.length && `${d.limited.length} usage-limited`,
         d.premium.length && `${d.premium.length} on the premium model`,
         d.unbanked.length && `${d.unbanked.length} with unbanked work`,
         d.missingSessions.length && `${d.missingSessions.length} session(s) not open`,
         gcN && `${gcN} collectable`,
         !d.orchestratorTagged && "no orchestrator tagged"].filter(Boolean).join(" · ");
      const choice = await vscode.window.showInformationMessage(`Loom (${d.repo}): ${headline}`, ...actions);
      if (choice === "Details") vscode.window.showInformationMessage(renderDigest(d), { modal: true });
      else if (choice === "Tag orchestrator") await vscode.commands.executeCommand("loomSessionTracker.tagOrchestrator");
      else if (choice === "Reopen sessions") await reopenMissing(d);
      else if (choice === "Collect garbage") await collectGarbage();
    };

    // a tree node (from a context-menu command) carries {agent:{role,repo}}; fall back to a QuickPick.
    const roleFromArg = async (node: any, pick: () => Thenable<string | undefined>): Promise<string | undefined> =>
      (node && node.agent && node.agent.role) ? node.agent.role
      : (node && typeof node.role === "string" && node.role) ? node.role
      : await pick();

    context.subscriptions.push(
      vscode.commands.registerCommand("loomSessionTracker.refresh", runTick),
      vscode.commands.registerCommand("loomSessionTracker.digest", () => showDigest(true)),
      // Garbage collection: the plan is always shown first; acting is a separate, confirmed pick.
      vscode.commands.registerCommand("loomSessionTracker.collectGarbage", async () => {
        const plan = computeGcPlan();
        if (!plan) { vscode.window.showInformationMessage("Loom: garbage collection is disabled (gcEnabled)."); return; }
        const pick = await vscode.window.showQuickPick(
          [{ label: "Show plan", description: gcSummary(plan) },
           { label: "Run tiers 1+2", description: "archive superseded builds/transcripts/backups; remove merged orphan worktrees" }],
          { placeHolder: `Loom garbage collection — ${gcSummary(plan)}` });
        if (!pick) return;
        if (pick.label === "Show plan") {
          vscode.window.showInformationMessage(renderGc(plan) || "Loom: nothing to collect.", { modal: true });
          return;
        }
        await collectGarbage();
      }),
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
      // Bank the orchestrator's memory now, whatever its context is. CX-001: banking is ALL this
      // does — nothing is cleared, by this command or by any tick that follows it.
      vscode.commands.registerCommand("loomSessionTracker.bankContext", async () => {
        if (!repo) { vscode.window.showWarningMessage("Loom: no project in this window."); return; }
        const orch = getOrchestrator(repo);
        if (!orch) { vscode.window.showWarningMessage("Loom: no orchestrator tagged — nothing to bank."); return; }
        const ok = await vscode.window.showInformationMessage(
          `Ask '${orch.role}' to write its working memory now?\n\n` +
          `Its context is NOT cleared — not by this and not afterwards. Once the file is on disk ` +
          `you can clear the session by hand whenever you choose, and it will be restored from the ` +
          `file automatically.`,
          { modal: true }, "Bank memory");
        if (ok !== "Bank memory") return;
        const step = runContextMemory(true);
        if (step && step.kind === "none") vscode.window.showInformationMessage(`Loom: ${step.note}`);
      }),
      // R3 — the full report. A MARKDOWN DOCUMENT, not a webview, and the reason is worth keeping:
      // this extension has no webview anywhere, a doc needs no CSP or asset plumbing to render a
      // table, and — the deciding one — the report exists to be pasted into a handoff or a message
      // to the orchestrator. A webview's contents cannot be selected out of it and sent anywhere.
      vscode.commands.registerCommand("loomSessionTracker.workLedgerReport", async (node?: any) => {
        const opts = workLedgerOpts();
        // The node's repo when invoked from the tree, this window's project otherwise, and every
        // project on the bus when the window has none — so the command is never a dead end.
        const repos = node && node.repo ? [String(node.repo)] : repo ? [repo] : busRepos();
        const entries = repos.map((r) => {
          // Recompute on demand rather than serving a cache that may be ten minutes old: a person
          // who asked for the report is asking about NOW, and the cost is one git pass.
          const w = computeWorkLedger(r === repo ? repoRoot() : null, { ...opts, nowMs: Date.now() });
          const since = Date.now() - opts.windowDays * 86_400_000;
          return { w, rows: handoffRows(r === repo ? repoRoot() : null, r, since,
                                        opts.productPaths, undefined, opts.excludePaths) };
        }).filter((e) => e.w.repo || e.rows.length);
        const doc = await vscode.workspace.openTextDocument({
          language: "markdown", content: renderReport(entries, thresholds()),
        });
        await vscode.window.showTextDocument(doc, { preview: false });
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
    runTick().then(() => showDigest(false)).then(() => runAutoGc()).catch(() => { /* never break activation */ });
    // Restored tabs render slowly; measured, blank shells are still filling in during the first tick.
    setTimeout(() => { restartReopen().catch(() => { /* never break activation */ }); }, 30_000);
    schedule();    // then on interval
  } catch (e) {
    // activation must never throw
    console.error("[loom-session-tracker] activate failed:", e);
  }
}

export function deactivate() {
  if (timer) clearInterval(timer);
}
