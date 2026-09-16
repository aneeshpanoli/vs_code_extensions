// tracker.ts — ONE JOB: orchestrate a single refresh (read frames → detect roles → partition by
// project → persist), and hold the live agent model for the UI. FAIL-PROOF: a failed/empty read
// NEVER wipes the model — agents not seen this tick are marked STALE (kept), so the sidebar and the
// targetmaps degrade gracefully instead of going blank on a transient CDP hiccup.

import { readFrames, Frame } from "./cdp";
import { classify, detectOwner, attributeRepo } from "./roles";
import { canonicalRole, isOwnerRole } from "./naming";
import { Agent, roleToRepo, boardRoles, busDeclaredFrames, declarationHolds, rivalDeclarers,
         freshestClaimant, writeTargetmaps, loadBindings, busRepos } from "./registry";
import { countSessions, publishCount, SessionCount, isBusy } from "./sessions";
import { sessionOwners, rebindFrame, RebindLog } from "./rebind";
import { detectLimit, LimitInfo } from "./limits";
import { detectModel, ModelInfo } from "./models";

export type Liveness = "live" | "stale";
export interface AgentView extends Agent { liveness: Liveness; limit?: LimitInfo | null; model?: ModelInfo | null; }

/** An ORCHESTRATOR/PO frame. Never a tracked agent (classify() excludes owners so it can never be
 *  retired/deleted) — surfaced separately purely so the UI can show it and let the user tag it.
 *
 *  TWO STRENGTHS, because the strong signal misses the sessions that need this most. `detectOwner`
 *  wants a `LOOMROLE=product-owner` sign-off or three distinct roles quoted; measured live
 *  2026-09-09, exactly ONE frame editor-wide passed it, while funisland's orchestrator — sitting at
 *  71% context, the very session the memory cycle exists for — passed neither that nor role
 *  classification, and so could not be tagged at all. A frame that is attributed to a project and is
 *  NOT one of its workers is therefore offered as a candidate too. The strengths are kept apart:
 *  a weak candidate can be TAGGED (a person's click), never silently adopted. */
export interface OwnerView {
  webviewId: string; lastSeen: number; liveness: Liveness;
  /** Mid-turn right now. The context-memory cycle must never type into a working composer. */
  busy: boolean;
  /** The panel's own "% context used" (its compact button). null below ~50%, where it isn't rendered. */
  contextPct: number | null;
  /** Which project this orchestrator frame is about, by dominant path mentions. null = can't tell.
   *  The CDP read is editor-wide, so without this every window adopts the same frame. */
  repo: string | null;
  /** The board names this frame as the orchestrator's. Beats a stale tag and content detection. */
  declared: boolean;
  /** True when the frame identifies itself as the orchestrator (a `LOOMROLE=product-owner` sign-off,
   *  or three distinct roles quoted). Only a strong candidate is ever adopted without a click. */
  strong: boolean;
  /** How much text the panel is showing. A freshly cleared panel holds a couple of hundred
   *  characters, which is how a `/clear` is confirmed when there is no transcript to check. */
  chars: number;
  /** The model on this frame's footer, so the policy can keep the orchestrator on the premium tier. */
  model: ModelInfo | null;
}

export interface TickResult {
  ok: boolean;                 // did the CDP read succeed (≥1 frame)?
  changedRepos: string[];      // repos whose targetmap was rewritten
  liveRoles: string[];
  /** Bus records this tick pointed at a new frame, because a session id said so. Empty on every
   *  ordinary tick — the writer is change-only. Logged by the caller with old→new. */
  rebinds: RebindLog[];
  error?: string;
}

/** Priority of a role identified by its CLAUDE SESSION ID.
 *
 *  It sits just above the `/loom` binding and the bus declaration (both 2), and RB-001 asked for
 *  "the same authority as a /loom binding". Same class, and deliberately half a step above it,
 *  because the two can disagree and when they do the session id is right: a declaration names a
 *  webviewId, and a webviewId is minted fresh by every IDE restart, while the session id is the same
 *  one it was yesterday. The id file is the cache; this is the address. */
const P_SESSION = 2.5;

const STALE_AFTER_MS = 90_000;   // an agent unseen this long is dropped from the model entirely

export class Tracker {
  private agents = new Map<string, Agent>();   // role -> most recent confident detection
  private owners = new Map<string, {
    lastSeen: number; busy: boolean; contextPct: number | null; repo: string | null; chars: number;
    strong: boolean; model: ModelInfo | null;
    /** The BOARD names this frame as the orchestrator's (registry.boardOwnerFrames). Authoritative:
     *  beats a stale tag and beats content detection. A click cannot override the board. */
    declared: boolean;
  }>();
  private lastOk = 0;
  private models = new Map<string, ModelInfo | null>();   // role -> model shown in its footer
  private limits = new Map<string, LimitInfo | null>();   // role -> usage-limit banner state
  private sessions: SessionCount | null = null;   // simultaneous Claude conversations, editor-wide
  private lastTickOk = false;   // did the MOST RECENT tick succeed? (a failed read must not keep claiming "live")
  private lastError = "";

  /** repoFilter: when set, ONLY this project's agents are tracked/shown/written — never another
   *  project's info in this window. null = track all (e.g. a windowless standalone run). */
  constructor(private repoFilter: string | null = null) {}

  /** This window's workspace folder name (`workspaceFolders[0].name`). Set by the extension; tests set
   *  it directly. With it, a frame whose window is a DIFFERENT folder is skipped outright — not a
   *  worker, not a candidate, not a declared owner — unless that folder is one of this project's
   *  roles (a worktree window of the same project). See cdp.Frame.windowRoot. */
  windowRoot: string | null = null;
  setWindowRoot(name: string | null): void { this.windowRoot = name || null; }

  /** This window's workspace FOLDER PATH (not just its name). Only used to find a role's worktree
   *  when its board entry does not record one — see rebind.roleWorktree. */
  windowCwd: string | null = null;
  setWindowCwd(p: string | null): void { this.windowCwd = p || null; }

  /** Is this frame in a window that belongs to this project? Legacy reads (no parentId) pass. */
  inMyWindow(f: { windowRoot: string | null; windowKnown: boolean }, roster: Set<string>): boolean {
    if (!this.repoFilter || !this.windowRoot || !f.windowKnown) return true;
    if (!f.windowRoot) return false;                                 // a window with no folder is nobody's
    return f.windowRoot === this.windowRoot || f.windowRoot === this.repoFilter || roster.has(f.windowRoot);
  }

  /** Switch between this project only and every project. Clears the model so nothing leaks across. */
  setFilter(repo: string | null): void {
    if (repo === this.repoFilter) return;
    this.repoFilter = repo;
    this.agents.clear(); this.owners.clear(); this.limits.clear(); this.models.clear(); this.busyRoles.clear();
  }
  filter(): string | null { return this.repoFilter; }

  /**
   * An EXPLICIT frame source, for driving `tick()` from a known frame list.
   *
   * A seam already existed — rebind.test.js swaps the `cdp.readFrames` module binding — so the
   * honest statement about WL-008 is not "this was untestable": it is that nothing ever drove
   * `tick()` to check BUSY-NESS, and every test of busy-ness drove the pure `isBusy()` helper
   * beside it instead. A helper can be perfect while the state built from it latches, which is
   * exactly what happened. This field is null by default so the module binding stays swappable
   * (resolving `readFrames` at CALL time, not at construction, which capturing it here would break).
   */
  private readFramesFn: (() => Promise<Frame[]>) | null = null;

  /** Drive this tracker from a known frame list. Test seam; the default is the live CDP read. */
  setFrameSource(fn: () => Promise<Frame[]>): void { this.readFramesFn = fn; }

  /** One refresh. Never throws. */
  async tick(): Promise<TickResult> {
    let frames: Frame[] = [];
    try { frames = await (this.readFramesFn ? this.readFramesFn() : readFrames()); }
    catch (e: any) { this.lastError = String(e && e.message || e).slice(0, 120); frames = []; }

    if (frames.length === 0) {
      // FAIL-PROOF: read failed/empty -> keep the model, just age it. Never wipe, never write.
      // The agents stay, but we can no longer vouch for them, so they render STALE.
      this.lastTickOk = false;
      this.ageOut();
      return { ok: false, changedRepos: [], liveRoles: this.liveRoles(), rebinds: [],
               error: this.lastError || "no frames" };
    }
    this.lastOk = Date.now();
    this.lastTickOk = true;
    this.lastError = "";

    const r2repo = roleToRepo();
    // ROSTER SOURCE: when this window is filtered to a project, take its roles from THAT project's own
    // board.json — so a duplicate role name in another bus (e.g. `prototyping` in both `Gaming` and a
    // stale lowercase `gaming`) can't hijack the mapping and get the role filtered out of its own window.
    // A detected role in this roster is ALWAYS attributed to repoFilter (never the collision-prone global map).
    const validRoles = this.repoFilter ? new Set(boardRoles(this.repoFilter)) : new Set(r2repo.keys());
    // AUTHORITATIVE bindings recorded at /loom-inject time (webviewId->role) in bindings.json — a file the
    // tracker NEVER writes, so a /loom self-binding is durable and can't be clobbered by our own detection cache.
    const authoritative = this.repoFilter ? loadBindings(this.repoFilter) : new Map<string, string>();
    const allRepos = busRepos();          // for attributing an orchestrator frame to ONE project
    // Frames the BOARD declares to be the orchestrator's. Authoritative: it beats content detection,
    // which cannot identify a PO whose team is too small for the ≥3-quoted-roles self-tell.
    // Frames the BUS declares — board webviewIds AND `<role>.id` files, the convention the projects
    // themselves use (ReciEats/README-ids.md). A declaration beats content in both directions: it is
    // how an orchestrator is found at all, and how a worker's own tab keeps its role when a bystander
    // merely prints its worktree paths.
    // {claude session id -> role} for THIS project. The one identity that survives a restart.
    const bySession = this.repoFilter ? sessionOwners(this.repoFilter, this.windowCwd) : new Map();
    const declared = this.repoFilter ? busDeclaredFrames(this.repoFilter) : [];
    const declaredBy = new Map<string, typeof declared[number]>();
    for (const d of declared) {
      if (declaredBy.has(d.webviewId)) continue;
      if (this.repoFilter && rivalDeclarers(this.repoFilter, d.webviewId).length) {
        // Contested: a bus forked from another keeps its predecessor's id files. Attribution decides;
        // but an orchestrator works on `main` and names few project paths, so attribution is silent
        // for exactly the frame that matters most — the freshest role mailbox decides those.
        const owned = attributeRepo(
          (frames.find((f) => f.webviewId === d.webviewId) || { text: "" }).text || "", allRepos).repo;
        if (owned !== this.repoFilter &&
            (owned !== null || freshestClaimant(this.repoFilter, d.role, d.webviewId) !== this.repoFilter)) continue;
      }
      declaredBy.set(d.webviewId, d);
    }
    const ownerFrames = new Set(Array.from(declaredBy.values())
      .filter((d) => isOwnerRole(d.role)).map((d) => d.webviewId));
    // role -> best frame. `priority`: 2 = authoritative /loom binding (always wins), else the classify purity.
    const best = new Map<string, { webviewId: string; priority: number; len: number; repo: string;
                                   text: string; signed: boolean; viaSession: boolean;
                                   /** The panel's own "% context used", carried through so a WORKER's
                                    *  context is knowable too and not only an owner's: CH-001's ledger
                                    *  records where a handoff FINISHED, and §19 judges size by it. */
                                   contextPct: number | null }>();
    const now0 = Date.now();
    /** Owner roles matched by session id this tick (owners are not tracked agents, so they cannot
     *  ride in `best`, but their frame still has to be written back to the bus). */
    const sessionMatched = new Map<string, { webviewId: string; text: string }>();
    for (const f of frames) {
      if (!f.webviewId) continue;
      // ── THE SESSION ID COMES FIRST, ahead of even the window filter.
      // The window rule exists to stop CONTENT from being misattributed: a panel can print anything,
      // but it is in exactly one window. A session id is not content — it is minted by Claude Code,
      // read off the frame's own URL, unique across the machine, and matched only against THIS
      // project's own board and worktrees. Nothing another project holds can collide with it, so the
      // window heuristic has nothing left to protect against here, and applying it would re-break the
      // case this exists for: after a restart a role's tab is frequently reopened into a window that
      // is not its own.
      const sessOwner = f.claudeSessionId ? bySession.get(f.claudeSessionId) : undefined;
      if (sessOwner && this.repoFilter) {
        const role = canonicalRole(this.repoFilter, sessOwner.role);
        if (isOwnerRole(role)) {
          // The orchestrator is never a tracked agent (classify excludes owners so it can never be
          // retired). Recording it here is what lets a PO be found after a restart with nobody typing.
          this.owners.set(f.webviewId, {
            lastSeen: now0, busy: isBusy(f.text), contextPct: f.contextPct ?? null,
            repo: this.repoFilter, chars: (f.text || "").length, strong: true, declared: true,
            model: detectModel(f.text),
          });
          sessionMatched.set(role, { webviewId: f.webviewId, text: f.text });
          continue;
        }
        const prev = best.get(role);
        if (!prev || prev.priority < P_SESSION)
          best.set(role, { webviewId: f.webviewId, priority: P_SESSION, len: f.text.length,
                           repo: this.repoFilter, text: f.text, signed: true, viaSession: true,
                           contextPct: f.contextPct ?? null });
        continue;
      }
      // WINDOW FIRST. Whatever a panel prints, it is in exactly one window, and one project per
      // window is the convention: a frame from another folder's window is not this project's.
      if (!this.inMyWindow(f, validRoles)) continue;
      // 0) THE BOARD WINS. A frame the board names as the orchestrator's is the orchestrator, even
      //    when its text reads exactly like a worker's (it quotes their sign-offs).
      const decl = declaredBy.get(f.webviewId);
      if (decl && !declarationHolds(decl, f.text, isBusy(f.text))) {
        // A STALE declared id: its guard string is absent from an idle tab. Trust nothing from the
        // declaration; fall through to content.
      } else if (decl && !isOwnerRole(decl.role) && this.repoFilter) {
        // Declared a WORKER: authoritative, like a /loom binding, above any content guess.
        const role = canonicalRole(this.repoFilter, decl.role);
        const prev = best.get(role);
        if (!prev || prev.priority < 2)
          best.set(role, { webviewId: f.webviewId, priority: 2, len: f.text.length,
                           repo: this.repoFilter, text: f.text, signed: true, viaSession: false,
                           contextPct: f.contextPct ?? null });
        continue;
      }
      if (ownerFrames.has(f.webviewId)) {
        this.owners.set(f.webviewId, {
          lastSeen: now0, busy: isBusy(f.text), contextPct: f.contextPct ?? null,
          repo: this.repoFilter, chars: (f.text || "").length, strong: true, declared: true,
          model: detectModel(f.text),
        });
        continue;
      }
      // 1) CONTENT-DETECT first (reverse-engineering) — the live, current-reality signal.
      const c = classify(f.text, validRoles, this.repoFilter);
      let role: string | null = c.role;
      // A session SIGNING its own role (marker) outranks a session that merely MENTIONS a worktree
      // (path): 1.2 vs purity <= 1. Measured 2026-09-09, a 325 KB diagnostic frame that had printed
      // the board classified as `developer` by path and beat the real, signing developer on length.
      let priority = c.source === "marker" ? 1.2 : c.purity;
      // PATH EVIDENCE NEEDS CORROBORATION; A SIGN-OFF DOES NOT.
      // A marker is the session naming ITSELF — self-identification, and enough on its own. A
      // worktree path is circumstantial: any session that greps a board, reads a handoff or prints
      // `git worktree list` mentions another role's paths. So a path-only classification counts only
      // when the frame's dominant project paths also say THIS project.
      //
      // Measured 2026-09-09 23:11, with both halves of the bug live in one window:
      //   * this diagnostic session mentioned five buses at 0.77 purity, so attributeRepo returned
      //     NULL (below the 0.8 threshold) — "unattributable", which the earlier rule let through —
      //     and it took Gaming's `developer` by path. It had received 38 `/model` injections.
      //   * the REAL worker signs `LOOMROLE=developer` but attributes to ReciEats, so the same rule
      //     correctly kept it out of Gaming's window — leaving the stranger unopposed.
      // Requiring corroboration for paths (and never for markers) resolves both: the stranger is not
      // a worker anywhere, and a signing worker is still found wherever its roster carries the name.
      // A marker names the ROLE, not the PROJECT: `LOOMROLE=developer` is true of Gaming's
      // developer and of ReciEats', and both boards carry the name. So a frame whose dominant paths
      // say ANOTHER project is never this window's worker, whatever it signs — while a frame that
      // names no project at all (a fresh session right after /clear, its paths swamped by a
      // `git worktree list`) is still trusted on its signature alone.
      // Measured 2026-09-09 23:13: frame 849774ff signs `developer` and attributes to ReciEats at
      // 0.87; before this it was adopted by Gaming's window AND ReciEats'.
      if (role && this.repoFilter && !authoritative.get(f.webviewId)) {
        const owned = attributeRepo(f.text, allRepos).repo;
        const conflicts = owned !== null && owned !== this.repoFilter;
        const uncorroborated = c.source === "path" && owned !== this.repoFilter;
        if (conflicts || uncorroborated) { role = null; priority = 0; }
      }
      // 2) GAP-FILLER: only when content is SILENT (marker scrolled out AND no dominant path) do we fall back to
      //    the authoritative /loom binding. It never OVERRIDES live content — a stale binding can't mislabel a
      //    frame the classifier can actually read.
      if (!role) {
        // Alias the binding through the project's naming contract too, so a `/loom` self-binding
        // and live content can never resolve the SAME frame to two different role names.
        const authRole = authoritative.get(f.webviewId);
        if (authRole) { role = canonicalRole(this.repoFilter, authRole); priority = 1.5; }
      }
      if (!role) {
        // Not a worker frame. If it looks like the orchestrator/PO, remember it as a tag candidate.
        // Not a worker. Strong signal = it says it is the orchestrator; weak = it is unmistakably
        // working on ONE project without being one of that project's roles.
        const owned = attributeRepo(f.text, allRepos).repo;
        const strong = detectOwner(f.text);
        if (strong || owned) {
          this.owners.set(f.webviewId, {
            lastSeen: now0, busy: isBusy(f.text), contextPct: f.contextPct ?? null,
            repo: owned, chars: (f.text || "").length, strong, declared: false,
            model: detectModel(f.text),
          });
        }
        continue;
      }
      // In a filtered window, `role` is already guaranteed to be in repoFilter's roster (validRoles came
      // from its board), so attribute it to repoFilter directly. Unfiltered: use the global map.
      const repo = this.repoFilter ? this.repoFilter : r2repo.get(role);
      if (!repo) continue;
      const prev = best.get(role);
      if (!prev || priority > prev.priority || (priority === prev.priority && f.text.length > prev.len))
        best.set(role, { webviewId: f.webviewId, priority, len: f.text.length, repo, text: f.text,
                         signed: priority >= 1.2, viaSession: false,
                         contextPct: f.contextPct ?? null });   // marker (1.2) or authoritative binding (1.5)
    }

    const now = Date.now();
    this.limits = new Map();
    this.models = new Map();
    // WL-008 · REBUILT EVERY TICK, like `limits` and `models` beside it. It was a Set that was only
    // ever ADDED to: its single `clear()` is in setFilter(), which runs when a human switches the
    // project filter. So the first tick that saw a role mid-turn latched it busy FOR EVER.
    //
    // That silently disabled the WL-006 gate wake in the field, twice, and could never have done
    // anything else: to LAUNCH a gate a worker must be mid-turn, so it is always observed busy
    // before its gate can possibly exit. wake() then took its `frame.busy` early return on every
    // tick, markWoken was never reached, and `gatesWoken` stayed `{}` — which is precisely what was
    // measured across both real gates. The stall alarm was unaffected because it never reads this.
    this.busyRoles = new Set();
    for (const [role, b] of best) {
      this.agents.set(role, { role, repo: b.repo, webviewId: b.webviewId, lastSeen: now,
                              contextPct: b.contextPct });
      // No injection gate here (tried 0.17.1, removed the same night): resumes MUST reach a worker
      // whose sign-off scrolled off — measured, that was every limited funisland role after the
      // restart. Cross-project misroutes are stopped by the attribution rule above instead.
      this.limits.set(role, detectLimit(b.text, now));
      this.models.set(role, detectModel(b.text));
      if (isBusy(b.text)) this.busyRoles.add(role);
    }
    this.ageOut();

    // Editor-wide concurrency: count every Claude conversation panel in the read, not just
    // this project's agents, and publish it for the sessions/scripts to read.
    const boundIds = new Set<string>([
      ...Array.from(this.agents.values()).map((a) => a.webviewId),
      ...Array.from(this.owners.keys()),
    ]);
    this.sessions = countSessions(frames, boundIds, this.liveRoles(), this.repoFilter);
    publishCount(this.sessions);

    const changedRepos = writeTargetmaps(Array.from(this.agents.values()));

    // REBIND ON THE BUS — the ONE case in which this tracker writes a binding. `bindings.json` is
    // otherwise never written here, so that a `/loom` self-binding stays durable and cannot be
    // clobbered by our own detection cache; that rule is narrowed by exactly this clause and no
    // other. Only a role whose frame was identified BY SESSION ID is rewritten. Content never
    // rewrites anything, and a frame whose session id could not be read changes nothing at all.
    const rebinds: RebindLog[] = [];
    if (this.repoFilter) {
      for (const [role, b] of best) {
        if (!b.viaSession) continue;
        const log = rebindFrame(this.repoFilter, role, b.webviewId, b.text, isBusy(b.text));
        if (log) rebinds.push(log);
      }
      for (const [role, m] of sessionMatched) {
        const log = rebindFrame(this.repoFilter, role, m.webviewId, m.text, isBusy(m.text));
        if (log) rebinds.push(log);
      }
    }
    return { ok: true, changedRepos, liveRoles: this.liveRoles(), rebinds };
  }

  /** Drop agents unseen for > STALE_AFTER_MS (a tab genuinely closed). */
  private ageOut() {
    const cutoff = Date.now() - STALE_AFTER_MS;
    for (const [role, a] of this.agents) if (a.lastSeen < cutoff) this.agents.delete(role);
    for (const [wid, o] of this.owners) if (o.lastSeen < cutoff) this.owners.delete(wid);
  }

  /** Live = confirmed by the most recent SUCCESSFUL read. After a failed read nothing is "live". */
  private livenessOf(lastSeen: number): Liveness {
    return this.lastTickOk && this.lastOk > 0 && lastSeen >= this.lastOk ? "live" : "stale";
  }

  private liveRoles(): string[] {
    return Array.from(this.agents.values())
      .filter((a) => this.livenessOf(a.lastSeen) === "live")
      .map((a) => a.role).sort();
  }

  /** Snapshot for the UI: agents grouped, each tagged live (seen in the last good tick) or stale. */
  view(): AgentView[] {
    return Array.from(this.agents.values())
      .map((a) => ({ ...a, liveness: this.livenessOf(a.lastSeen), limit: this.limits.get(a.role) ?? null, model: this.models.get(a.role) ?? null }))
      .sort((x, y) => (x.repo === y.repo ? x.role.localeCompare(y.role) : x.repo.localeCompare(y.repo)));
  }

  /** Detected orchestrator/PO frames, for the UI's "tag me" affordance. */
  ownerView(): OwnerView[] {
    return Array.from(this.owners.entries())
      .map(([webviewId, o]) => ({
        webviewId, lastSeen: o.lastSeen, busy: o.busy, contextPct: o.contextPct,
        repo: o.repo, chars: o.chars, strong: o.strong, declared: o.declared, model: o.model,
        liveness: this.livenessOf(o.lastSeen),
      }))
      .sort((a, b) => b.lastSeen - a.lastSeen);
  }

  /** Last measured editor-wide session concurrency (null before the first good read). */
  sessionCount(): SessionCount | null { return this.sessions; }

  /** Usage-limit banner state per role, as of the last successful read. */
  limitState(): Map<string, LimitInfo | null> { return this.limits; }

  /** Model each role is running, as of the last successful read. */
  modelState(): Map<string, ModelInfo | null> { return this.models; }
  /** Roles whose frame is MID-TURN this tick. A slash command typed into a busy composer is queued as
   *  a message and never executes: measured 2026-09-09 23:04, three `/model claude-opus-5` injections
   *  into a worker running Bash, each reported "typed + submitted", none produced a "Set model" line,
   *  footer unchanged. Anything that types a COMMAND must wait for idle. */
  busyRoles = new Set<string>();

  status(): { lastOk: number; lastError: string } {
    return { lastOk: this.lastOk, lastError: this.lastError };
  }
}
