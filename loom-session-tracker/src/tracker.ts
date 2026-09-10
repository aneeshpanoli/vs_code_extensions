// tracker.ts — ONE JOB: orchestrate a single refresh (read frames → detect roles → partition by
// project → persist), and hold the live agent model for the UI. FAIL-PROOF: a failed/empty read
// NEVER wipes the model — agents not seen this tick are marked STALE (kept), so the sidebar and the
// targetmaps degrade gracefully instead of going blank on a transient CDP hiccup.

import { readFrames, Frame } from "./cdp";
import { classify, discussesLoom, detectOwner, attributeRepo } from "./roles";
import { canonicalRole } from "./naming";
import { Agent, roleToRepo, boardRoles, boardOwnerFrames, writeTargetmaps, loadBindings, busRepos } from "./registry";
import { countSessions, publishCount, SessionCount, isBusy } from "./sessions";
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
}

export interface TickResult {
  ok: boolean;                 // did the CDP read succeed (≥1 frame)?
  changedRepos: string[];      // repos whose targetmap was rewritten
  liveRoles: string[];
  error?: string;
}

const STALE_AFTER_MS = 90_000;   // an agent unseen this long is dropped from the model entirely

export class Tracker {
  private agents = new Map<string, Agent>();   // role -> most recent confident detection
  private owners = new Map<string, {
    lastSeen: number; busy: boolean; contextPct: number | null; repo: string | null; chars: number;
    strong: boolean;
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

  /** Switch between this project only and every project. Clears the model so nothing leaks across. */
  setFilter(repo: string | null): void {
    if (repo === this.repoFilter) return;
    this.repoFilter = repo;
    this.agents.clear(); this.owners.clear(); this.limits.clear(); this.models.clear();
  }
  filter(): string | null { return this.repoFilter; }

  /** One refresh. Never throws. */
  async tick(): Promise<TickResult> {
    let frames: Frame[] = [];
    try { frames = await readFrames(); }
    catch (e: any) { this.lastError = String(e && e.message || e).slice(0, 120); frames = []; }

    if (frames.length === 0) {
      // FAIL-PROOF: read failed/empty -> keep the model, just age it. Never wipe, never write.
      // The agents stay, but we can no longer vouch for them, so they render STALE.
      this.lastTickOk = false;
      this.ageOut();
      return { ok: false, changedRepos: [], liveRoles: this.liveRoles(), error: this.lastError || "no frames" };
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
    const ownerFrames = this.repoFilter ? boardOwnerFrames(this.repoFilter) : new Set<string>();
    // role -> best frame. `priority`: 2 = authoritative /loom binding (always wins), else the classify purity.
    const best = new Map<string, { webviewId: string; priority: number; len: number; repo: string; text: string }>();
    const now0 = Date.now();
    for (const f of frames) {
      if (!f.webviewId) continue;
      // 0) THE BOARD WINS. A frame the board names as the orchestrator's is the orchestrator, even
      //    when its text reads exactly like a worker's (it quotes their sign-offs).
      if (ownerFrames.has(f.webviewId)) {
        this.owners.set(f.webviewId, {
          lastSeen: now0, busy: isBusy(f.text), contextPct: f.contextPct ?? null,
          repo: this.repoFilter, chars: (f.text || "").length, strong: true, declared: true,
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
      const authRoleEarly = authoritative.get(f.webviewId);
      if (role && !authRoleEarly) {
        // A frame that DISCUSSES the Loom machinery is not a worker — it is a diagnostic session or
        // the orchestrator, both of which print other roles' paths and sign-offs. Same rule as
        // loom_cdp.py's SELF_RE; an authoritative /loom binding overrides it, as it does there.
        if (discussesLoom(f.text)) { role = null; priority = 0; }
        // A worker of THIS project must not read as another project's session. My window is scoped
        // to one bus; a frame whose dominant paths belong to a different bus (a Gaming-attributed
        // frame classifying as livegita's `developer` because both rosters have one) is not mine.
        else if (this.repoFilter) {
          const owned = attributeRepo(f.text, allRepos).repo;
          if (owned && owned !== this.repoFilter) { role = null; priority = 0; }
        }
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
        best.set(role, { webviewId: f.webviewId, priority, len: f.text.length, repo, text: f.text });
    }

    const now = Date.now();
    this.limits = new Map();
    this.models = new Map();
    for (const [role, b] of best) {
      this.agents.set(role, { role, repo: b.repo, webviewId: b.webviewId, lastSeen: now });
      this.limits.set(role, detectLimit(b.text, now));
      this.models.set(role, detectModel(b.text));
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
    return { ok: true, changedRepos, liveRoles: this.liveRoles() };
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
        repo: o.repo, chars: o.chars, strong: o.strong, declared: o.declared,
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

  status(): { lastOk: number; lastError: string } {
    return { lastOk: this.lastOk, lastError: this.lastError };
  }
}
