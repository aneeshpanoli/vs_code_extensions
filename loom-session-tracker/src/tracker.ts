// tracker.ts — ONE JOB: orchestrate a single refresh (read frames → detect roles → partition by
// project → persist), and hold the live agent model for the UI. FAIL-PROOF: a failed/empty read
// NEVER wipes the model — agents not seen this tick are marked STALE (kept), so the sidebar and the
// targetmaps degrade gracefully instead of going blank on a transient CDP hiccup.

import { readFrames, Frame } from "./cdp";
import { classify } from "./roles";
import { Agent, roleToRepo, boardRoles, writeTargetmaps, loadBindings } from "./registry";

export type Liveness = "live" | "stale";
export interface AgentView extends Agent { liveness: Liveness; }

export interface TickResult {
  ok: boolean;                 // did the CDP read succeed (≥1 frame)?
  changedRepos: string[];      // repos whose targetmap was rewritten
  liveRoles: string[];
  error?: string;
}

const STALE_AFTER_MS = 90_000;   // an agent unseen this long is dropped from the model entirely

export class Tracker {
  private agents = new Map<string, Agent>();   // role -> most recent confident detection
  private lastOk = 0;
  private lastError = "";

  /** repoFilter: when set, ONLY this project's agents are tracked/shown/written — never another
   *  project's info in this window. null = track all (e.g. a windowless standalone run). */
  constructor(private repoFilter: string | null = null) {}

  /** One refresh. Never throws. */
  async tick(): Promise<TickResult> {
    let frames: Frame[] = [];
    try { frames = await readFrames(); }
    catch (e: any) { this.lastError = String(e && e.message || e).slice(0, 120); frames = []; }

    if (frames.length === 0) {
      // FAIL-PROOF: read failed/empty -> keep the model, just age it. Never wipe, never write.
      this.ageOut();
      return { ok: false, changedRepos: [], liveRoles: this.liveRoles(), error: this.lastError || "no frames" };
    }
    this.lastOk = Date.now();
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
    // role -> best frame. `priority`: 2 = authoritative /loom binding (always wins), else the classify purity.
    const best = new Map<string, { webviewId: string; priority: number; len: number; repo: string }>();
    for (const f of frames) {
      if (!f.webviewId) continue;
      // 1) CONTENT-DETECT first (reverse-engineering) — the live, current-reality signal.
      const c = classify(f.text, validRoles);
      let role: string | null = c.role;
      let priority = c.purity;
      // 2) GAP-FILLER: only when content is SILENT (marker scrolled out AND no dominant path) do we fall back to
      //    the authoritative /loom binding. It never OVERRIDES live content — a stale binding can't mislabel a
      //    frame the classifier can actually read.
      if (!role) {
        const authRole = authoritative.get(f.webviewId);
        if (authRole) { role = authRole; priority = 1.5; }
      }
      if (!role) continue;
      // In a filtered window, `role` is already guaranteed to be in repoFilter's roster (validRoles came
      // from its board), so attribute it to repoFilter directly. Unfiltered: use the global map.
      const repo = this.repoFilter ? this.repoFilter : r2repo.get(role);
      if (!repo) continue;
      const prev = best.get(role);
      if (!prev || priority > prev.priority || (priority === prev.priority && f.text.length > prev.len))
        best.set(role, { webviewId: f.webviewId, priority, len: f.text.length, repo });
    }

    const now = Date.now();
    for (const [role, b] of best) this.agents.set(role, { role, repo: b.repo, webviewId: b.webviewId, lastSeen: now });
    this.ageOut();

    const changedRepos = writeTargetmaps(Array.from(this.agents.values()));
    return { ok: true, changedRepos, liveRoles: this.liveRoles() };
  }

  /** Drop agents unseen for > STALE_AFTER_MS (a tab genuinely closed). */
  private ageOut() {
    const cutoff = Date.now() - STALE_AFTER_MS;
    for (const [role, a] of this.agents) if (a.lastSeen < cutoff) this.agents.delete(role);
  }

  private liveRoles(): string[] {
    return Array.from(this.agents.values())
      .filter((a) => a.lastSeen >= this.lastOk && this.lastOk > 0)
      .map((a) => a.role).sort();
  }

  /** Snapshot for the UI: agents grouped, each tagged live (seen in the last good tick) or stale. */
  view(): AgentView[] {
    return Array.from(this.agents.values())
      .map((a) => ({ ...a, liveness: (a.lastSeen >= this.lastOk && this.lastOk > 0 ? "live" : "stale") as Liveness }))
      .sort((x, y) => (x.repo === y.repo ? x.role.localeCompare(y.role) : x.repo.localeCompare(y.repo)));
  }

  status(): { lastOk: number; lastError: string } {
    return { lastOk: this.lastOk, lastError: this.lastError };
  }
}
