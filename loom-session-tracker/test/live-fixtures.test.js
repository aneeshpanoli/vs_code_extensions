// live-fixtures.test.js — the suite's answer to its own worst failure.
//
// On 2026-09-09 this project went from 349 to 376 passing tests across one night in which the LIVE
// system misrouted six different ways: it typed `/model` 38 times into a diagnostic session, sent one
// project's resume into another project's tab, tagged a developer as the orchestrator, and let three
// usage limits sit expired for hours. Every fixture then in the suite had been hand-written from the
// code's own model of the world, so wherever that model was wrong the tests agreed with it.
//
// These fixtures are different in kind: they are REAL panels captured from the running editor by
// test/fixtures/capture.js, which redacts the user's prose but keeps every token classification reads
// — sign-off lines, worktree and project paths, the model footer, limit banners, the busy chip — at
// their real positions and real repetition counts. Capture REFUSES to write a fixture whose behaviour
// differs from the live frame it came from, so a fixture cannot quietly drift from reality.
//
// `manifest.json` records what each frame MEASURED as. The per-window expectations below are stated
// by hand from evidence outside the code (board.json, orchestrator.json, each session's own sign-off)
// — that is the part the code must not be allowed to write for itself.

const { suite, ok, eq, load, makeRepo, busPath, writeJson } = require("./harness");
const fs = require("fs"), path = require("path");
const DIR = path.join(__dirname, "fixtures", "live");
const { classify, attributeRepo, detectOwner } = load("roles.js");
const { detectModel } = load("models.js");
const { detectLimit } = load("limits.js");
const { isBusy } = load("sessions.js");
const { boardRoles } = load("registry.js");

const manifest = JSON.parse(fs.readFileSync(path.join(DIR, "manifest.json"), "utf8"));
const textOf = (id) => fs.readFileSync(path.join(DIR, id + ".txt"), "utf8");

// Rebuild the captured BUSES inside the sandbox HOME. Classification reads each project's roster and
// its naming aliases, so frames alone are half a world — without this every fixture classifies as
// null and the suite passes by describing nothing.
for (const [repo, b] of Object.entries(manifest.bus || {})) {
  const board = {};
  for (const role of b.roles) board[role] = {};
  for (const d of (b.declared || []).filter((x) => x.source === "board")) {
    board[d.role] = { ...(board[d.role] || {}), webviewId: d.webviewId };
  }
  makeRepo(board, repo);
  writeJson(busPath(repo, "naming.json"), { aliases: b.aliases || {}, owner: b.ownerRole });
  // the `<role>.id` files, and the mailbox mtimes that decide a contested declaration
  for (const d of (b.declared || []).filter((x) => x.source === "idfile")) {
    fs.writeFileSync(busPath(repo, `${d.role}.id`), d.webviewId + (d.guard ? "\n" + d.guard + "\n" : "\n"));
  }
  for (const [role, at] of Object.entries(b.mailboxWritten || {})) {
    if (at === null) continue;
    const f = busPath(repo, role, "status.json");
    fs.mkdirSync(path.dirname(f), { recursive: true });
    fs.writeFileSync(f, JSON.stringify({ role }));
    fs.utimesSync(f, at / 1000, at / 1000);
  }
}

// ── ground truth, stated by hand ────────────────────────────────────────────────────────────────
// What each captured panel ACTUALLY is, established from board.json / orchestrator.json / its own
// sign-off at capture time — never from what the classifier said about it.
const TRUTH = {
  a57ba8a7: { is: "livegita's orchestrator", repo: "livegita", role: null, owner: true,
              why: "signs LOOMROLE=productowner; board.json declares it for `po` AND `productowner`; orchestrator.json tags it" },
  "45962fe2": { is: "livegita's developer", repo: "livegita", role: "developer", owner: false,
              why: "signs its own role; board.json gitadeveloper -> this frame; naming.json aliases gitadeveloper -> developer" },
  "79c00a21": { is: "funisland's gamification worker", repo: "funisland", role: "gamification", owner: false,
              why: "signs LOOMROLE=gamification" },
  "849774ff": { is: "ReciEats' developer", repo: "ReciEats", role: "developer", owner: false,
              why: "signs LOOMROLE=developer and its paths are ReciEats'; NOT Gaming's, though Gaming's board also has a `developer`" },
  // NOTE its `owner` is deliberately absent below: this session PRINTS `LOOMROLE=` lines while
  // debugging, so detectOwner reads true for it, and that is the documented residual of a text-based
  // self-tell (HANDOVER.md). Being a candidate is harmless — a candidate is offered for a click and is
  // never a target — so what must hold is the two lines asserted separately: it is nobody's WORKER and
  // nothing is ever typed into it. Those are checked here and in dispatch.test.js.
  "3c22c91c": { is: "a diagnostic session about this extension", repo: null, role: null,
              why: "prints other roles' worktree paths while debugging; belongs to no project. It received 38 /model injections." },
};

// ── 1. the primitives still read these panels the way they read them live ───────────────────────

suite("live: every fixture behaves exactly as the frame it was captured from", () => {
  ok(manifest.frames.length >= 10, `expected a real capture, got ${manifest.frames.length} frames`);
  for (const f of manifest.frames) {
    const t = textOf(f.id);
    const m = f.measured;
    const repo = attributeRepo(t, manifest.buses).repo;
    eq(repo, m.repo, `${f.id}: project attribution`);
    const c = repo ? classify(t, new Set(boardRoles(repo)), repo) : { role: null, source: null };
    // classify's owner-marker rule changed after capture (see roles.ts); the manifest records what
    // the code said THEN, so only assert the parts that are properties of the PANEL, not of the rule.
    eq(isBusy(t), m.busy, `${f.id}: busy chip`);
    eq((detectModel(t) || {}).model ?? null, m.model, `${f.id}: model footer`);
    eq(detectOwner(t), m.owner, `${f.id}: owner self-tell`);
    eq((detectLimit(t, 0) || {}).limited ?? false, m.limited, `${f.id}: limit banner`);
    eq(t.length, m.len, `${f.id}: length (it decides ties between frames)`);
    ok(c.source !== "path" || repo !== null, `${f.id}: path evidence without a project is never a role`);
  }
});

// ── 2. the panels we can name are classified as what they ARE ───────────────────────────────────

suite("live: livegita's orchestrator is not mistaken for its developer", () => {
  // THE 2026-09-09 defect, caught here by a real panel: the PO signs `productowner` and mentions
  // `worktrees/developer` eleven times. A clean owner sign-off must end the question.
  const t = textOf("a57ba8a7");
  ok(detectOwner(t), "the PO's own sign-off identifies it");
  const c = classify(t, new Set(["developer", "po", "productowner", "gitadeveloper"]), "livegita");
  eq(c.role, null, "and it is NOT a worker, despite 19 worktrees/developer mentions and a QUOTED " +
    "developer sign-off that makes its marker set mixed");
});

suite("live: every captured panel classifies as the thing it actually is", () => {
  for (const [id, want] of Object.entries(TRUTH)) {
    const t = textOf(id);
    const repo = attributeRepo(t, manifest.buses).repo;
    eq(repo, want.repo, `${id} (${want.is}): project — ${want.why}`);
    const c = repo ? classify(t, new Set(boardRoles(repo)), repo) : { role: null };
    eq(c.role, want.role, `${id} (${want.is}): role — ${want.why}`);
    if ("owner" in want) eq(detectOwner(t), want.owner, `${id} (${want.is}): owner self-tell`);
  }
});

suite("live: the diagnostic session is nobody's worker, in any project", () => {
  // It prints other roles' worktree paths and sign-offs constantly. It may be OFFERED (a candidate is
  // a click, never a target); it must never be classified as a worker anywhere, which is what made it
  // the recipient of 38 `/model` injections and one project's resume.
  const t = textOf("3c22c91c");
  for (const repo of manifest.buses) {
    const c = classify(t, new Set(boardRoles(repo)), repo);
    const owned = attributeRepo(t, manifest.buses).repo;
    const mine = c.source === "marker" ? (owned === null || owned === repo) : owned === repo;
    ok(!(c.role && mine), `${repo} would treat the diagnostic session as its ${c.role}`);
  }
});

suite("live: no captured panel is claimed by two different projects", () => {
  // `developer` is a role on Gaming, livegita AND ReciEats. A frame may belong to at most one.
  const claims = new Map();
  for (const f of manifest.frames) {
    const t = textOf(f.id);
    for (const repo of manifest.buses) {
      const c = classify(t, new Set(boardRoles(repo)), repo);
      if (!c.role) continue;
      const owned = attributeRepo(t, manifest.buses).repo;
      // the tracker's rule: a marker names the ROLE, not the PROJECT; paths must corroborate
      const mine = c.source === "marker" ? (owned === null || owned === repo) : owned === repo;
      if (mine) claims.set(f.id, [...(claims.get(f.id) || []), `${repo}/${c.role}`]);
    }
  }
  for (const [id, cs] of claims) {
    eq(cs.length, 1, `${id} is claimed by ${cs.length} projects: ${cs.join(", ")}`);
  }
  ok(!claims.has("3c22c91c"), "the diagnostic session is nobody's worker");
});

// ── the category the previous fixture set could not express ─────────────────────────────────────

suite("live: a project whose orchestrator is running can SHOW it", async () => {
  // The 2026-09-09 report, verbatim: "I don't see any orchestrated session for ReciEats." Its PO was
  // running and writing status every few minutes; the sidebar listed nothing, because the extension
  // did not read the `<role>.id` files the buses use and that frame attributes to no project at all.
  // The previous fixtures could not catch it: they snapshotted only what the code already understood,
  // so they encoded its blind spot. This asserts from the BUS — a recently-written orchestrator
  // mailbox means that session exists and must be offerable.
  const { Tracker } = load("tracker.js"); const cdp = load("cdp.js");
  const { isOwnerRole } = load("naming.js");
  const frames = manifest.frames.map((f) => ({
    webviewId: f.webviewId, type: "iframe", targetUrl: `vscode-webview://${f.id}`,
    text: textOf(f.id), contextPct: f.contextPct,
  }));
  const DAY = 24 * 3600 * 1000;
  let checked = 0;
  for (const [repo, b] of Object.entries(manifest.bus)) {
    const owners = (b.roles || []).filter(isOwnerRole);
    const freshest = Math.max(0, ...owners.map((r) => (b.mailboxWritten || {})[r] || 0));
    if (!freshest || manifest.capturedAt && new Date(manifest.capturedAt).getTime() - freshest > DAY) continue;
    checked++;
    const t = new Tracker(repo); const real = cdp.readFrames;
    cdp.readFrames = async () => frames;
    try { await t.tick(); } finally { cdp.readFrames = real; }
    const offered = t.ownerView().filter((o) => o.repo === repo || o.declared);
    ok(offered.length > 0,
      `${repo}: its orchestrator mailbox was written ${Math.round((Date.now() - freshest) / 60000)}m ` +
      `before capture, so that session was running — but nothing was offerable as its orchestrator`);
  }
  ok(checked >= 2, `expected several projects with a running orchestrator, checked ${checked}`);
});

suite("live: a frame declared by two buses goes to the one whose mailbox is alive", () => {
  // Gaming/*.id and ReciEats/*.id carry the SAME webviewIds — the ReciEats bus was copied from
  // Gaming's. Gaming/productowner/status.json was last written 2026-07-11; ReciEats' minutes ago.
  const { rivalDeclarers, freshestClaimant, busDeclaredFrames } = load("registry.js");
  const contested = [];
  for (const repo of Object.keys(manifest.bus)) {
    for (const d of busDeclaredFrames(repo)) {
      if (rivalDeclarers(repo, d.webviewId).length) contested.push([repo, d]);
    }
  }
  ok(contested.length > 0, "the capture contains a contested declaration to reason about");
  for (const [repo, d] of contested) {
    const winner = freshestClaimant(repo, d.role, d.webviewId);
    ok(winner !== null, `${d.webviewId.slice(0, 8)} (${d.role}): someone must own it`);
    const winnerAt = (manifest.bus[winner].mailboxWritten || {})[d.role] || 0;
    for (const rival of rivalDeclarers(repo, d.webviewId)) {
      const rivalAt = (manifest.bus[rival].mailboxWritten || {})[d.role] || 0;
      ok(winnerAt >= rivalAt,
        `${d.role} ${d.webviewId.slice(0, 8)}: ${winner} won but ${rival}'s mailbox is fresher`);
    }
  }
});
