// live-check.js — assert, against the RUNNING editor and the REAL bus, the things the unit tests
// cannot: that the world still looks the way the code assumes it does.
//
// WHY THIS EXISTS. The suite is thorough (308 checks, 95% of lines) and it did not catch a single one
// of the four defects found on 2026-09-08/09. It could not: every fixture in it was written from the
// same model of the world as the code, so where the model was wrong the tests agreed with it.
//   * board fixtures always listed the role the test then tagged — so "the tag names `product-owner`,
//     which no board carries, so there is no transcript and the cycle can never fire" had no fixture;
//   * every test supplied ONE window's frames — so "readFrames is editor-wide, and the only candidate
//     belongs to another project" had no fixture;
//   * every test's orchestrator frame carried a LOOMROLE=product-owner sign-off — so "real ones do
//     not, and cannot be tagged at all" had no fixture.
// Coverage says which lines ran. It cannot say which realities were considered. This file is the
// other half: a small set of invariants checked against what is actually there, so the next drift
// between assumption and reality is one command away instead of a bespoke script.
//
// READ-ONLY. It opens a CDP read and reads files. It never injects, never writes to the bus, never
// closes anything. Safe to run against a live working editor at any time.
//
//   ./live.sh                  (there is no `node` on this machine; live.sh runs it under the
//                               editor's bundled one, exactly as test.sh does for the suite)

const path = require("path");
const OUT = path.join(__dirname, "out");
const { readFrames } = require(path.join(OUT, "cdp.js"));
const { detectOwner, attributeRepo, classify } = require(path.join(OUT, "roles.js"));
const { busRepos, boardRoles, boardOwnerFrames, busDeclaredFrames, rivalDeclarers, freshestClaimant } =
  require(path.join(OUT, "registry.js"));
const fsx = require("fs");
const { isOwnerRole, ownerRoleFor, roleAliases, OWNER_ALIASES, ROLE_VOCABULARY,
        inVocabulary, baseRole } = require(path.join(OUT, "naming.js"));
const { getOrchestrator } = require(path.join(OUT, "orchestrator.js"));
const { isBusy } = require(path.join(OUT, "sessions.js"));
const { boardSessionId, transcriptFor, readTranscriptContext } = require(path.join(OUT, "context.js"));
const memory = require(path.join(OUT, "memory.js"));
const { scanWorktrees } = require(path.join(OUT, "health.js"));

const results = [];
const record = (level, name, detail) => results.push({ level, name, detail });
const pass = (n, d) => record("PASS", n, d);
const warn = (n, d) => record("WARN", n, d);
const fail = (n, d) => record("FAIL", n, d);
const info = (n, d) => record("INFO", n, d);

(async () => {
  const repos = busRepos();
  const frames = (await readFrames()).filter((f) => f.webviewId);
  if (!frames.length) {
    fail("CDP read", "no frames — is the editor running with --remote-debugging-port?");
    return report();
  }
  pass("CDP read", `${frames.length} webview frame(s) across the editor`);

  // Classify every frame the way the tracker does.
  // Frames each board DECLARES to be its orchestrator's — authoritative, and the only way to find a
  // PO whose team is too small for the >=3-quoted-roles self-tell (see registry.boardOwnerFrames).
  // webviewId -> the repo that OWNS this declared orchestrator frame. Resolved exactly as tracker.ts
  // resolves it, via freshestClaimant, and not by "whichever bus this loop reached first": iteration
  // is alphabetical, so first-wins handed 113ae63b to Gaming and left ReciEats — whose PO was writing
  // status every few minutes — with no candidate at all. live-check re-implementing the tracker's
  // rule instead of calling it is how this file lied about the world once already.
  const declared = new Map();
  for (const r of repos) {
    for (const w of boardOwnerFrames(r)) {
      const rivals = rivalDeclarers(r, w);
      if (!rivals.length) { declared.set(w, r); continue; }
      const d = busDeclaredFrames(r).find((x) => x.webviewId === w);
      const winner = freshestClaimant(r, d.role, w);
      if (winner === r || (winner === null && !declared.has(w))) declared.set(w, r);
    }
  }
  const panels = frames.map((f) => {
    const owned = declared.get(f.webviewId);
    if (owned) {
      return { wid: f.webviewId, repo: owned, role: null, strong: true,
               pct: f.contextPct, chars: f.text.length, busy: isBusy(f.text), declared: owned };
    }
    const repo = attributeRepo(f.text, repos).repo;
    const role = repo ? classify(f.text, new Set(boardRoles(repo)), repo).role : null;
    return { wid: f.webviewId, repo, role, strong: detectOwner(f.text),
             pct: f.contextPct, chars: f.text.length, busy: isBusy(f.text), declared: null };
  });
  const candidates = panels.filter((p) => !p.role && (p.strong || p.repo));

  // ── 1. one frame is at most one project's orchestrator ────────────────────────────────────
  // The 2026-09-09 defect: ownerView() is editor-wide, so one shwab_docker frame was tagged as the
  // orchestrator of Gaming, funisland AND livegita at once.
  const byFrame = new Map();
  for (const repo of repos) {
    const tag = getOrchestrator(repo);
    if (tag && tag.webviewId) byFrame.set(tag.webviewId, [...(byFrame.get(tag.webviewId) || []), repo]);
  }
  const shared = [...byFrame.entries()].filter(([, rs]) => rs.length > 1);
  if (shared.length) {
    fail("one frame, one orchestrator",
      shared.map(([w, rs]) => `${w.slice(0, 8)} is tagged by ${rs.join(", ")}`).join("; "));
  } else pass("one frame, one orchestrator", `${byFrame.size} tag(s), none shared`);

  // ── 1b. THE NAMING CONTRACT holds on every real bus ───────────────────────────────────────
  // The 2026-09-09 defect: livegita spells its orchestrator `po`, which was in NONE of the four
  // hardcoded owner sets. Its PO was therefore never offerable as a candidate AND was a legal
  // spawn/retire/delete target. This asserts against the ACTUAL board keys and mailbox directories,
  // so a new project inventing a fifth spelling is reported here instead of failing silently.
  for (const repo of repos) {
    const roster = boardRoles(repo);
    const owners = roster.filter((r) => isOwnerRole(r));
    const ownerish = roster.filter((r) => !isOwnerRole(r) &&
      /^(p\.?o|po[_-]?\w*|.*product.?owner.*|.*orchestrat.*|.*owner.*|pm)$/i.test(r));
    if (ownerish.length) {
      fail(`${repo}: owner naming`, `roster has owner-LOOKING role(s) the contract does not accept: ` +
        `${ownerish.join(", ")} — add the spelling to OWNER_ALIASES in src/naming.ts, or rename the ` +
        `bus directory. Until then it is a deletable worker.`);
    } else if (owners.length > 1) {
      warn(`${repo}: owner naming`, `${owners.length} owner spellings on one bus (${owners.join(", ")}) ` +
        `— harmless, but only ${ownerRoleFor(repo)} is the one tagging will use`);
    } else if (owners.length === 1) {
      pass(`${repo}: owner naming`, `${owners[0]} recognised; tags write ${ownerRoleFor(repo)}`);
    } else {
      warn(`${repo}: owner naming`, `no orchestrator role on the bus at all — a tag here would create ` +
        `${ownerRoleFor(repo)}/`);
    }
  }

  // ── 1c. an orchestrator that EXISTS on the bus is actually tagged ─────────────────────────
  // A real PO mailbox with no orchestrator.json is invisible: no ★ in the sidebar, no finish
  // notifications, no context cycle. livegita was in exactly this state — a 42 KB inbox and three
  // queued tickets under po/, and no tag.
  for (const repo of repos) {
    const owners = boardRoles(repo).filter((r) => isOwnerRole(r));
    if (!owners.length) continue;
    if (getOrchestrator(repo)) continue;
    const mine = candidates.filter((c) => c.repo === repo);
    warn(`${repo}: orchestrator untagged`,
      `the bus has ${owners.join(", ")}/ but no orchestrator.json — ` +
      (mine.length ? `click the ★ on ${mine.map((c) => c.wid.slice(0, 8)).join(" or ")}`
                   : `and no session of this project is currently offerable, so its PO tab is not open`));
  }

  // ── 1d. per-project role aliases point at roles that exist ────────────────────────────────
  // An alias must COLLAPSE INTO a real on-disk role; one pointing at a name that is not on the bus
  // would silently erase a session's identity.
  for (const repo of repos) {
    const al = roleAliases(repo);
    if (!al.size) continue;
    const roster = new Set(boardRoles(repo));
    const bad = [...al.entries()].filter(([, to]) => !roster.has(to));
    if (bad.length) {
      fail(`${repo}: role aliases`, bad.map(([f, t]) => `${f} -> ${t}, which is not a role of this bus`).join("; "));
    } else {
      pass(`${repo}: role aliases`, [...al.entries()].map(([f, t]) => `${f} -> ${t}`).join(", "));
    }
  }

  // ── 2. every tag resolves to a live, attributable frame ───────────────────────────────────
  for (const repo of repos) {
    const tag = getOrchestrator(repo);
    if (!tag) continue;
    const mine = candidates.filter((c) => c.repo === repo);
    const hit = mine.find((c) => c.wid === tag.webviewId);
    if (hit) pass(`${repo}: tag resolves`, `${tag.role} @ ${hit.wid.slice(0, 8)}`);
    else if (mine.length) {
      warn(`${repo}: tag is stale`,
        `tagged ${String(tag.webviewId).slice(0, 8)}, which is not a frame of this project. ` +
        `Click the ★ on ${mine.map((c) => c.wid.slice(0, 8)).join(" or ")} to re-point it.`);
    } else {
      warn(`${repo}: tag is stale`, `tagged ${String(tag.webviewId).slice(0, 8)}, and no session in ` +
        `this project is currently offerable as its orchestrator`);
    }
  }

  // ── 1e. how far each bus is from the four-role vocabulary ─────────────────────────────────
  // Reporting only. The vocabulary (product-owner / developer / designer / monetization) is the
  // target shape; these are the roles that are not on it yet. INFO, never a failure — funisland's 13
  // agents are real, and a migration of a live bus is a decision, not a cleanup.
  for (const repo of repos) {
    const roster = boardRoles(repo);
    if (!roster.length) continue;
    const off = roster.filter((r) => !inVocabulary(r));
    // Numbered instances (developer1, developer2, …) are several agents in ONE role, so report the
    // function once with its instance count rather than as four separate off-vocabulary names.
    const byBase = new Map();
    for (const r of roster.filter((x) => inVocabulary(x))) {
      const b = baseRole(r);
      byBase.set(b, [...(byBase.get(b) || []), r]);
    }
    const shape = [...byBase.entries()]
      .map(([b, rs]) => (rs.length > 1 ? `${b} ×${rs.length}` : b)).sort().join(", ");
    if (!off.length) pass(`${repo}: role vocabulary`, `all ${roster.length} role(s) on the standard four — ${shape}`);
    else info(`${repo}: role vocabulary`, `${roster.length - off.length}/${roster.length} on the four` +
      (shape ? ` (${shape})` : "") + `; off-vocabulary: ${off.join(", ")}`);
  }

  // ── 1e. A PROJECT THAT HAS A LIVE ORCHESTRATOR MUST BE ABLE TO SHOW IT ────────────────────
  // Derived from the BUS, not from anything the classifier believes: if a project's orchestrator
  // mailbox was written in the last day, that session exists, and the sidebar must be able to offer
  // it. This is the check that would have caught ReciEats — its PO was running and writing status
  // every few minutes while the sidebar listed nothing, because the extension did not know the
  // `<role>.id` convention the buses use and the PO's frame attributed to no project at all.
  // A test written from the code's own idea of "declared" cannot catch that; this one can.
  const DAY = 24 * 3600 * 1000;
  for (const repo of repos) {
    const owners = boardRoles(repo).filter((r) => isOwnerRole(r));
    let freshest = 0, which = null;
    for (const role of owners) {
      try {
        const m = fsx.statSync(path.join(require("os").homedir(), ".claude", "loom", repo, role, "status.json")).mtimeMs;
        if (m > freshest) { freshest = m; which = role; }
      } catch { /* no mailbox */ }
    }
    if (!freshest || Date.now() - freshest > DAY) continue;      // no recently-active orchestrator
    const offered = candidates.filter((c) => c.repo === repo || c.declared === repo);
    const ago = Math.round((Date.now() - freshest) / 60000);
    if (offered.length) {
      pass(`${repo}: orchestrator is findable`,
        `${which}/status.json written ${ago}m ago; offered as ${offered.map((c) => c.wid.slice(0, 8)).join(", ")}`);
    } else {
      fail(`${repo}: orchestrator is INVISIBLE`,
        `${which}/status.json was written ${ago}m ago, so that session is running — but nothing in ` +
        `this read can be offered as ${repo}'s orchestrator. Check ${repo}/${which}.id (line 1 must be ` +
        `the webviewId, not the session_id) and whether its frame is open.`);
    }
  }

  // ── 1e2. every window is RUNNING the version that is deployed ─────────────────────────────
  // A window keeps the code it loaded at its last reload, so "deployed" and "running" drift and a
  // symptom looks like a bug that was already fixed. Measured 2026-09-10 00:27: 0.21.1 registered
  // while a window still wrote a targetmap only a pre-0.19.2 build produces, and the fix looked
  // broken for an hour. Reported as a FAILURE because everything else here describes a world that
  // window is not living in.
  try {
    const pkgV = JSON.parse(fsx.readFileSync(path.join(__dirname, "package.json"), "utf8")).version;
    const stamp = JSON.parse(fsx.readFileSync(
      path.join(require("os").homedir(), ".claude", "loom", "running-versions.json"), "utf8"));
    const behind = Object.entries(stamp).filter(([, v]) => v && v.version !== pkgV);
    const fresh = Object.entries(stamp).filter(([, v]) => v && Date.now() - Date.parse(v.at) < 10 * 60000);
    if (!fresh.length) {
      warn("running version", `no window has ticked in the last 10 minutes — cannot tell what is running`);
    } else if (behind.length) {
      fail("windows are running an OLD build",
        behind.map(([r, v]) => `${r} is on ${v.version}`).join("; ") +
        ` — deployed is ${pkgV}. Reload those windows (Developer: Reload Window); until then they ` +
        `behave like the build they loaded, whatever this file says.`);
    } else {
      pass("running version", `${fresh.length} window(s) on ${pkgV}`);
    }
  } catch {
    warn("running version", "no ~/.claude/loom/running-versions.json yet — every window predates the " +
      "version stamp (0.22.0); reload them and it will appear");
  }

  // ── 1e3. no bus's cache claims another bus's ORCHESTRATOR as a worker ─────────────────────
  // targetmap.json is a cache of the tracker's guess; a declaration is the session's own statement.
  // When a stale window guesses wrong the cache poisons everything downstream, because loom_cdp reads
  // it as an authoritative hint. Measured 2026-09-10: funisland/targetmap.json mapped 7614c6be ->
  // "scriptwriter", and 7614c6be is tfg_ua's PRODUCT OWNER — the model policy typed
  // `/model claude-opus-5` into the orchestrator eight times before anyone noticed.
  const orchFrames = new Map();                     // webviewId -> "repo/role"
  for (const repo of repos) {
    for (const d of busDeclaredFrames(repo)) if (isOwnerRole(d.role)) orchFrames.set(d.webviewId, `${repo}/${d.role}`);
    const t = getOrchestrator(repo);
    if (t && t.webviewId) orchFrames.set(t.webviewId, `${repo}/${t.role}`);
  }
  for (const repo of repos) {
    for (const file of ["targetmap.json", "bindings.json"]) {
      let m = {};
      try { m = JSON.parse(fsx.readFileSync(path.join(require("os").homedir(), ".claude", "loom", repo, file), "utf8")); }
      catch { continue; }
      for (const [wid, role] of Object.entries(m)) {
        const whose = orchFrames.get(wid);
        if (whose && !isOwnerRole(role)) {
          fail(`${repo}: ${file} POISONED`,
            `it maps ${wid.slice(0, 8)} to the worker role "${role}", but that frame is ${whose}'s ` +
            `orchestrator. Anything dispatching by role name will type into that PO. Delete the entry ` +
            `and reload the ${repo} window — a stale build wrote it.`);
        }
      }
    }
  }

  // ── 1f. one frame, one bus ────────────────────────────────────────────────────────────────
  // Two buses declaring the same frame is drift, and it made one ReciEats session appear as Gaming's
  // developer: `Gaming/*.id` and `ReciEats/*.id` carry the same webviewIds because the ReciEats bus
  // was copied from Gaming's. The tracker breaks the tie, but the duplicate files are the real fix.
  const declaredBy = new Map();
  for (const repo of repos) {
    for (const d of busDeclaredFrames(repo)) {
      const k = d.webviewId;
      declaredBy.set(k, [...(declaredBy.get(k) || []), `${repo}/${d.role}`]);
    }
  }
  for (const [wid, claims] of declaredBy) {
    // Only ACROSS buses: one bus naming a frame under two of its own role aliases (livegita's
    // `po` and `productowner` are the same session) is the alias arrangement working, not drift.
    const buses = new Set(claims.map((c) => c.split("/")[0]));
    if (buses.size > 1) {
      warn("declaration is contested", `${wid.slice(0, 8)} is declared by ${claims.join(" and ")} — ` +
        `the tracker resolves it by the freshest role mailbox, but one of those id files is a stale copy`);
    }
  }

  // ── 2b. no tag names a WORKER role ────────────────────────────────────────────────────────
  // Measured 2026-09-09: livegita/orchestrator.json read `{"role":"gitadeveloper"}`. Reported as a
  // FAILURE, not a warning — the context cycle's endpoint is a `/clear`, and the only thing holding
  // it was a null frame id that a tick refills. memory.ts now refuses this outright; this says so out
  // loud, because the wrong TAG is still a state a person has to fix.
  for (const repo of repos) {
    const tag = getOrchestrator(repo);
    if (!tag) continue;
    if (isOwnerRole(tag.role)) {
      pass(`${repo}: tag names the orchestrator`, `${tag.role}`);
    } else {
      fail(`${repo}: tag names a WORKER`, `orchestrator.json says role "${tag.role}", which is not an ` +
        `orchestrator name (accepted: ${OWNER_ALIASES.join(", ")}). The cycle refuses to run, so ` +
        `nothing will be cleared — but this project has no working orchestrator tag. Re-tag it: ` +
        `untag from the ★ node, then star the real PO session (this bus's name for it is ` +
        `${ownerRoleFor(repo)}).`);
    }
  }

  // ── 3. a tagged orchestrator has SOME way to read its context ─────────────────────────────
  // The defect this exists for: `product-owner` is on no board, so boardSessionId is null, so with a
  // transcript-only design the cycle sat inert forever.
  for (const repo of repos) {
    const tag = getOrchestrator(repo);
    if (!tag) continue;
    const sid = boardSessionId(repo, tag.role);
    const file = sid ? transcriptFor(sid) : null;
    const frame = candidates.find((c) => c.wid === tag.webviewId);
    const panelPct = frame ? frame.pct : null;
    if (file) pass(`${repo}: context source`, `transcript ${path.basename(file)}`);
    else if (panelPct !== null) pass(`${repo}: context source`, `panel says ${panelPct}% used`);
    else if (!frame) {
      // Don't blame the compact button for a tag that resolves to no panel at all — say which it is.
      const mine = candidates.filter((c) => c.repo === repo && c.pct !== null);
      warn(`${repo}: context source`,
        `role "${tag.role}" has no board session_id, and the tagged frame is not here to read a ` +
        `percentage off` + (mine.length
          ? ` — but ${mine.map((c) => `${c.wid.slice(0, 8)} is at ${c.pct}%`).join(", ")}, so re-pointing the tag is all it needs`
          : ``));
    } else warn(`${repo}: context source`,
      `role "${tag.role}" has no board session_id and its panel shows no compact button ` +
      `(the button only renders past 50% used) — the cycle holds until one of those appears`);
  }

  // ── 4. what the cycle would do RIGHT NOW, per project ─────────────────────────────────────
  for (const repo of repos) {
    const tag = getOrchestrator(repo);
    if (!tag) continue;
    const mine = candidates.filter((c) => c.repo === repo);
    const strong = mine.filter((c) => c.strong);
    const known = mine.find((c) => c.wid === tag.webviewId) || (strong.length === 1 ? strong[0] : undefined);
    const state = memory.loadState(repo);
    const memFile = memory.defaultMemoryFile(repo, tag.role);
    const mem = memory.statMemory(memFile);
    const step = memory.decide({
      repo, role: tag.role, webviewId: known ? known.wid : null,
      reading: memory.readOrchestratorContext(repo, tag.role, state),
      busy: known ? known.busy : false, frameSeen: !!known,
      panelPct: known ? known.pct : null, panelChars: known ? known.chars : null,
      memoryFile: memFile, memoryMtime: mem.mtime, memorySize: mem.size,
      now: Date.now(), cfg: memory.DEFAULT_CONFIG, state,
    });
    record(step.kind === "none" ? "PASS" : "INFO", `${repo}: next step`, `${step.kind} — ${step.note}`);
  }

  // ── 5. every board role with a session_id has a transcript ────────────────────────────────
  let missing = [];
  for (const repo of repos) {
    for (const role of boardRoles(repo)) {
      const sid = boardSessionId(repo, role);
      if (sid && !transcriptFor(sid)) missing.push(`${repo}/${role}`);
    }
  }
  if (missing.length) {
    // Bus drift, not an extension fault: a board keeps a session_id long after that transcript is
    // archived or deleted. It matters because it is the only thing "reopen this session" can use.
    warn("board session_ids resolve", `${missing.length} point at no transcript (bus drift; ` +
      `"Reopen sessions" cannot restore these): ${missing.slice(0, 6).join(", ")}` +
      (missing.length > 6 ? `, +${missing.length - 6} more` : ""));
  }
  else pass("board session_ids resolve", "every recorded session_id has a transcript");

  // ── 6. no rostered role's worktree reads as orphaned ──────────────────────────────────────
  // The 2026-09-08 defect: a broken roster made 7 live roles' worktrees look removable.
  for (const repo of repos) {
    const root = path.join(process.env.HOME, "Containers", repo);
    const found = scanWorktrees(repo, root, new Set());
    if (!found.length) continue;
    const roster = new Set(boardRoles(repo));
    const wrong = found.filter((w) => w.orphaned && roster.has(w.role));
    if (wrong.length) fail(`${repo}: worktree roster`, `${wrong.map((w) => w.role).join(", ")} on the board but flagged orphaned`);
    else pass(`${repo}: worktree roster`, `${found.length} worktree(s), ${found.filter((w) => w.orphaned).length} orphaned, none rostered`);
  }

  // ── 7. what is offerable, for the record ──────────────────────────────────────────────────
  for (const c of candidates) {
    record("INFO", "candidate", `${c.wid.slice(0, 8)} repo=${c.repo || "unattributed"} ` +
      `${c.strong ? "STRONG" : "weak"} ctx=${c.pct === null ? "-" : c.pct + "%"} chars=${c.chars}`);
  }
  report();
})().catch((e) => { fail("live-check", String((e && e.stack) || e)); report(); });

function report() {
  const C = { PASS: "\x1b[32m", WARN: "\x1b[33m", FAIL: "\x1b[31m", INFO: "\x1b[36m" };
  for (const r of results) console.log(`  ${C[r.level]}${r.level}\x1b[0m ${r.name}: ${r.detail}`);
  const n = (l) => results.filter((r) => r.level === l).length;
  console.log(`\n${n("PASS")} passed, ${n("WARN")} warning(s), ${n("FAIL")} failure(s)`);
  process.exit(n("FAIL") ? 1 : 0);
}
