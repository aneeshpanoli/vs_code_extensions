// naming.ts — ONE JOB: the ROLE NAMING CONTRACT. The single place that decides what a role is
// CALLED, so that four independent mechanisms stop disagreeing about it.
//
// WHY THIS EXISTS. Measured live 2026-09-09, the orchestrator role was spelled four different ways
// and every owner check hardcoded its own set of two:
//
//   bus            board key        mailbox dir     session title
//   Gaming         productowner     productowner/   —
//   shwab_docker   productowner     productowner/   severence-productowner
//   livegita       po               po/             gita-productowner
//   funisland      (none at all)    —               Loom curriculum
//
//   OWNER_ROLES = new Set(["product-owner", "productowner"])   ← roles.ts
//   OWNER_ROLES = new Set(["product-owner", "productowner"])   ← coordinator.ts
//   ORCHESTRATOR_CANDIDATES = ["product-owner", "productowner"] ← orchestrator.ts
//   ("product-owner", "productowner")                          ← loom_cdp.py, twice
//
// `po` was in NONE of them. The consequences were not cosmetic, and both directions were live:
//   * livegita's orchestrator could never be OFFERED as a tag candidate — `classify()` saw a clean
//     `LOOMROLE=po` sign-off, found `po` was not an owner name, and returned it as an ordinary
//     WORKER called `po`. So the Gita PO showed up nowhere: not in the sidebar as the orchestrator,
//     not in the QuickPick, and livegita has no `orchestrator.json` to this day.
//   * worse, being a "worker" made it a legal target for spawn / retire / delete and for the stall
//     watchdog. Every one of coordinator.ts's owner refusals is spelled with the same two names, so
//     none of them would have fired for `po`. The boundary that exists precisely to make the
//     orchestrator undeletable had a hole in it for one project.
//
// THE CONTRACT.
//   1. There is ONE canonical orchestrator id, `product-owner`. Everything that reasons about roles
//      uses `isOwnerRole()` — never a literal — so a new spelling is added HERE, once.
//   2. Bus directory names are NOT renamed by this module. A role's mailbox stays where it is, so
//      every `LOOM_ROOT/<repo>/<role>/status.json` path in health/digest/notifier/memory keeps
//      working untouched. `ownerRoleFor()` returns the name the bus actually uses, which is why
//      tagging livegita writes `po` and not `product-owner`. After a bus is renamed to the canonical
//      directory, the same function starts returning the canonical name with no code change.
//   3. Per-project role aliases live ON THE BUS, in `~/.claude/loom/<repo>/naming.json`, because
//      "these two names are the same agent" is a fact about that project, not about this code.
//      Adding one needs no rebuild and no redeploy.
//
// The alias direction is deliberate: aliases COLLAPSE INTO an existing on-disk name. `gitadeveloper`
// resolves to `developer` because `developer/` is a real mailbox and `worktrees/developer` is a real
// path, so the surviving name is classifiable by BOTH signals. Collapsing the other way would leave
// a role identifiable only by a sign-off marker that scrolls out of the panel — which is exactly the
// failure that made livegita's developer read as two different agents.

import * as fs from "fs";
import * as os from "os";
import * as path from "path";

const LOOM_ROOT = path.join(os.homedir(), ".claude", "loom");

/** The one canonical orchestrator role id. Written by new tags on a bus that has no owner mailbox. */
export const OWNER_CANONICAL = "product-owner";

/**
 * Every spelling of the orchestrator role seen in the wild, canonical first.
 * `product-owner`/`productowner` — Gaming, shwab_docker, and loom_cdp.py's self-guard.
 * `po`                           — livegita's board key and mailbox dir.
 * `owner`/`orchestrator`/`pm`    — not currently on any bus; accepted so a hand-typed variant in a
 *                                  new project's board cannot silently become a deletable worker.
 * Order matters only for the QuickPick, which offers these before the worker roles.
 */
export const OWNER_ALIASES: readonly string[] = [
  OWNER_CANONICAL, "productowner", "product_owner", "po", "owner", "orchestrator", "pm",
];

const OWNER_SET = new Set<string>(OWNER_ALIASES);

/**
 * THE ROLE VOCABULARY — the four roles a Loom project is meant to have, decided 2026-09-09.
 *
 * Role names are PROJECT-SCOPED: the bus directory namespaces them, so every project uses these same
 * four and nothing needs a project prefix. That is only safe because role resolution is now scoped —
 * `loom_cdp.py` takes `--repo` and refuses an ambiguous bare name rather than scanning every board and
 * taking the first hit (which is what wrote a livegita binding onto Gaming's bus on 2026-09-08 and
 * forced the `gitadeveloper` prefix). One project per editor window, so the window always knows.
 *
 * This is a TARGET, not an enforcement. Existing buses carry richer rosters — funisland runs 13
 * genuinely distinct agents (curriculum, gamification, art, music, …) — and nothing here renames a
 * mailbox or refuses a role that is not on the list. `./live.sh` reports the divergence so a migration
 * is a visible decision rather than a silent drift.
 */
export const ROLE_VOCABULARY: readonly string[] = [
  OWNER_CANONICAL, "developer", "designer", "monetization",
];

/** Is this role one of the four? Reporting only — never a gate. */
export function inVocabulary(role: string | null | undefined): boolean {
  if (!role) return false;
  const r = role.trim().toLowerCase();
  return isOwnerRole(r) || ROLE_VOCABULARY.includes(r);
}

/** Is this role name the orchestrator, under ANY of its spellings? The only owner test in the codebase. */
export function isOwnerRole(role: string | null | undefined): boolean {
  return !!role && OWNER_SET.has(role.trim().toLowerCase());
}

// ── per-project role aliases (on the bus, not in code) ───────────────────────────────────────────

interface BusNaming { aliases?: Record<string, string>; }

/**
 * `{alias: survivingName}` for one project, from `~/.claude/loom/<repo>/naming.json`.
 * Self-referential and chained entries are dropped rather than followed: an alias must name a role
 * that is NOT itself an alias, so resolution is always one step and can never loop.
 */
export function roleAliases(repo: string | null): Map<string, string> {
  const out = new Map<string, string>();
  if (!repo) return out;
  let data: BusNaming;
  try { data = JSON.parse(fs.readFileSync(path.join(LOOM_ROOT, repo, "naming.json"), "utf8")); }
  catch { return out; }
  const a = data && data.aliases;
  if (!a || typeof a !== "object" || Array.isArray(a)) return out;
  for (const [from, to] of Object.entries(a)) {
    if (typeof from !== "string" || typeof to !== "string") continue;
    const f = from.trim().toLowerCase(), t = to.trim().toLowerCase();
    if (!f || !t || f === t) continue;
    out.set(f, t);
  }
  // one step only: drop any alias whose target is itself an alias
  for (const [f, t] of Array.from(out)) if (out.has(t)) out.delete(f);
  return out;
}

/**
 * The name this project actually uses for a role: a per-project alias applied, otherwise unchanged.
 * Owner spellings are deliberately NOT canonicalized here — `isOwnerRole()` is the owner test, and
 * rewriting `po` to `product-owner` would point every mailbox path at a directory that isn't there.
 */
export function canonicalRole(repo: string | null, role: string): string {
  const r = (role || "").trim().toLowerCase();
  return roleAliases(repo).get(r) || r;
}

/**
 * The role name to TAG this project's orchestrator with: the owner-aliased mailbox directory the bus
 * already has, else the canonical id. Keeps `memory.md` and the restore prompt beside the PO's own
 * inbox instead of in a second directory named after the code's preference.
 * Measured: livegita -> `po`, Gaming/shwab_docker -> `productowner`, funisland -> `product-owner`.
 */
export function ownerRoleFor(repo: string | null): string {
  if (!repo) return OWNER_CANONICAL;
  // An explicit `"owner"` in the bus's naming.json wins. Measured 2026-09-09: livegita ended up with
  // BOTH `po/` (42 KB inbox, 3 queued tickets, tools/) and an empty `productowner/` that the PO
  // session created for itself, noting on the board "same session as role 'po' ... this dir is an
  // alias". Alias ORDER cannot decide that; the project has to say which mailbox is the real one.
  try {
    const d = JSON.parse(fs.readFileSync(path.join(LOOM_ROOT, repo, "naming.json"), "utf8"));
    if (d && typeof d.owner === "string" && d.owner.trim()) return d.owner.trim().toLowerCase();
  } catch { /* no per-bus choice */ }
  let names: string[] = [];
  try { names = fs.readdirSync(path.join(LOOM_ROOT, repo)); } catch { return OWNER_CANONICAL; }
  // canonical wins if the bus has already been migrated to it
  const have = new Set(names.filter((n) => {
    try { return fs.statSync(path.join(LOOM_ROOT, repo, n)).isDirectory(); } catch { return false; }
  }).map((n) => n.toLowerCase()));
  for (const a of OWNER_ALIASES) if (have.has(a)) return a;
  return OWNER_CANONICAL;
}

/**
 * Publish the GLOBAL half of the contract to `~/.claude/loom/naming.json` so `loom_cdp.py` and any
 * other tooling read the same owner alias set this extension enforces, rather than keeping a second
 * copy that drifts. Written atomically, change-only, and never throws — a naming publish must not be
 * able to break activation. loom_cdp.py falls back to its own inline list if the file is absent.
 */
export function publishNaming(): boolean {
  const file = path.join(LOOM_ROOT, "naming.json");
  const next = JSON.stringify({
    _comment: "Written by loom-session-tracker (src/naming.ts). The owner alias contract, shared "
      + "with loom_cdp.py. Per-project role aliases live in <repo>/naming.json, not here.",
    ownerCanonical: OWNER_CANONICAL,
    ownerAliases: OWNER_ALIASES,
  }, null, 2);
  try {
    if (fs.readFileSync(file, "utf8").trim() === next.trim()) return false;
  } catch { /* missing -> write */ }
  try {
    fs.mkdirSync(LOOM_ROOT, { recursive: true });
    const tmp = file + ".tmp." + process.pid;
    fs.writeFileSync(tmp, next);
    fs.renameSync(tmp, file);
    return true;
  } catch { return false; }
}
