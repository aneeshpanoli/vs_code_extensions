// naming.test.js — the ROLE NAMING CONTRACT.
//
// Every fixture here is written from a name MEASURED on a live bus on 2026-09-09, not from what the
// code expected to find. That distinction is the whole point: the previous suite passed 349/349
// while livegita's orchestrator was unreachable, because no fixture ever spelled the owner role
// anything but `product-owner` or `productowner` — the two spellings the code already knew.
//
// What was actually on the buses:
//   Gaming        board `productowner`   mailbox productowner/
//   shwab_docker  board `productowner`   mailbox productowner/
//   livegita      board `po`             mailbox po/            <- in no owner set anywhere
//   funisland     no owner entry at all  no mailbox
//
// The `po` case had two live consequences and the tests below pin both:
//   1. it could never be OFFERED as a tag candidate (classify returned it as a worker);
//   2. being a "worker" made it a legal spawn / retire / delete / close target, punching a hole in
//      the one boundary that is supposed to make the orchestrator undeletable.

const { suite, ok, eq, load, makeRepo, busPath, writeJson } = require("./harness");
const { isOwnerRole, canonicalRole, ownerRoleFor, roleAliases, publishNaming,
        OWNER_CANONICAL, OWNER_ALIASES } = load("naming.js");
const { classify, detectOwner } = load("roles.js");
const { boardRoles } = load("registry.js");
const fs = require("fs");
const path = require("path");

const marker = (r) => "\nLOOMROLE=" + r + "\n";

// ── the owner test ───────────────────────────────────────────────────────────────────────────────

suite("naming: every spelling measured on a live bus is recognised as the owner", () => {
  for (const r of ["product-owner", "productowner", "po"]) {
    ok(isOwnerRole(r), `${r} must be an owner role — it is one on a real bus`);
  }
  // `po` is THE regression: it was in no owner set in roles.ts, coordinator.ts, orchestrator.ts or
  // loom_cdp.py, while being livegita's actual board key and mailbox directory.
  ok(isOwnerRole("po"), "po (livegita) — the 2026-09-09 defect");
});

suite("naming: a worker role is never mistaken for the owner", () => {
  for (const r of ["developer", "gitadeveloper", "curriculum", "quant", "robinhoodmcp", "", null]) {
    ok(!isOwnerRole(r), `${JSON.stringify(r)} must NOT be an owner role`);
  }
});

suite("naming: the owner test is case- and whitespace-insensitive", () => {
  // Board keys are hand-edited; a stray capital or space must not reopen the hole.
  ok(isOwnerRole("PO"), "uppercase");
  ok(isOwnerRole("  Product-Owner "), "padded and mixed case");
});

// ── classification: the owner is excluded under EVERY spelling ───────────────────────────────────

suite("naming: a `po` sign-off is excluded from worker classification (the live defect)", () => {
  // Before the fix this returned {role:"po"} — a tracked, retirable, deletable agent.
  const roster = new Set(["developer", "po"]);
  eq(classify("orchestrating" + marker("po"), roster, "livegita").role, null,
    "a clean `po` marker must NOT resolve to a worker role");
  ok(detectOwner("orchestrating" + marker("po")),
    "and it must be DETECTED as the owner, so it is offered as a tag candidate");
});

suite("naming: a dominant `worktrees/po` path is excluded too", () => {
  const roster = new Set(["developer", "po"]);
  eq(classify("see worktrees/po/a worktrees/po/b", roster, "livegita").role, null,
    "owner worktree path -> null under the `po` spelling");
});

// ── the coordinator boundary ─────────────────────────────────────────────────────────────────────

suite("naming: coordinator refuses to spawn/retire/delete `po`", async () => {
  const { Coordinator } = load("coordinator.js");
  const repo = makeRepo({ developer: {}, po: {} }, "livegita-boundary");
  // A tracker whose view() claims `po` is a LIVE agent of this project — exactly the state the old
  // classifier produced for livegita, and the state in which every boundary below had to hold.
  const tracker = { view: () => [{ role: "po", repo, webviewId: "w1", liveness: "live" }] };
  const c = new Coordinator(tracker, repo);

  eq(c.spawnableRoles(["developer", "po"]).includes("po"), false, "po is not spawnable");
  eq(c.retirableAgents().some((a) => a.role === "po"), false, "po is not retirable even when 'live'");
  eq(c.deletableRoles().includes("po"), false, "po is not deletable");

  // And each destructive entry point must REJECT, with the orchestrator reason — not merely
  // fail for some incidental reason like 'not in the roster'.
  for (const [name, call] of [["spawn", () => c.spawn("po")],
                              ["retire", () => c.retire("po")],
                              ["delete", () => c.delete("po", null, "stamp")]]) {
    let msg = null;
    try { await call(); } catch (e) { msg = String(e && e.message || e); }
    ok(msg !== null, `${name}('po') must throw, not proceed`);
    ok(/orchestrator/i.test(msg), `${name}('po') must refuse BECAUSE it is an orchestrator role, got: ${msg}`);
  }

  // The control: a real worker is still spawnable/deletable, so the refusal is about the OWNER and
  // not a blanket block that would quietly disable the coordinator.
  ok(c.spawnableRoles(["developer", "po"]).includes("developer"), "developer is still spawnable");
  ok(c.deletableRoles().includes("developer"), "developer is still deletable");
});

// ── per-project aliases live on the bus ──────────────────────────────────────────────────────────

suite("naming: a bus alias collapses two names for one agent into the surviving one", () => {
  const repo = makeRepo({ developer: {}, gitadeveloper: {} }, "livegita-alias");
  writeJson(busPath(repo, "naming.json"), { aliases: { gitadeveloper: "developer" } });
  eq(canonicalRole(repo, "gitadeveloper"), "developer", "alias applied");
  eq(canonicalRole(repo, "developer"), "developer", "surviving name unchanged");

  // The measured bug: the SAME session read as two different agents depending on which signal was
  // visible — `LOOMROLE=gitadeveloper` while the marker was on screen, `worktrees/developer` after
  // it scrolled away. Both must now resolve to ONE role.
  const roster = new Set(boardRoles(repo));
  const bySignoff = classify("part 2 complete" + marker("gitadeveloper"), roster, repo).role;
  const byPath = classify("edited worktrees/developer/a.mjs worktrees/developer/b.mjs", roster, repo).role;
  eq(bySignoff, "developer", "sign-off resolves to the surviving name");
  eq(byPath, "developer", "worktree path resolves to the same name");
  eq(bySignoff, byPath, "one session, ONE identity, whichever signal is on screen");
});

suite("naming: a project with no naming.json is unaffected", () => {
  const repo = makeRepo({ developer: {} }, "no-aliases");
  eq(roleAliases(repo).size, 0, "no aliases");
  eq(canonicalRole(repo, "developer"), "developer", "identity");
  eq(canonicalRole(null, "developer"), "developer", "null repo is safe");
});

suite("naming: malformed and chained alias files cannot loop or crash", () => {
  const repo = makeRepo({ a: {}, b: {}, c: {} }, "bad-aliases");
  writeJson(busPath(repo, "naming.json"), { aliases: { a: "b", b: "c", self: "self", x: 5 } });
  const m = roleAliases(repo);
  // `a -> b` is dropped because `b` is itself an alias: resolution stays one step, so no loop.
  eq(m.has("a"), false, "chained alias dropped");
  eq(m.get("b"), "c", "one-step alias kept");
  eq(m.has("self"), false, "self-alias dropped");
  eq(m.has("x"), false, "non-string target dropped");

  fs.writeFileSync(busPath(repo, "naming.json"), "{ not json");
  eq(roleAliases(repo).size, 0, "unparseable file -> no aliases, no throw");
});

// ── which name a tag is written under ────────────────────────────────────────────────────────────

suite("naming: tagging uses the owner mailbox the bus already has", () => {
  // Keeps memory.md and the restore prompt beside the PO's own inbox rather than in a second
  // directory named after the code's preference. Measured: livegita `po`, Gaming `productowner`.
  const lg = makeRepo({ developer: {}, po: {} }, "owner-po");
  fs.mkdirSync(busPath(lg, "po"), { recursive: true });
  eq(ownerRoleFor(lg), "po", "livegita-shaped bus -> po");

  const gm = makeRepo({ developer: {}, productowner: {} }, "owner-productowner");
  fs.mkdirSync(busPath(gm, "productowner"), { recursive: true });
  eq(ownerRoleFor(gm), "productowner", "Gaming-shaped bus -> productowner");

  const fi = makeRepo({ curriculum: {} }, "owner-none");
  eq(ownerRoleFor(fi), OWNER_CANONICAL, "no owner mailbox -> the canonical id");
});

suite("naming: a migrated bus starts returning the canonical name with no code change", () => {
  // The forward path chosen 2026-09-09: alias in code now, rename the directory later. When the
  // rename happens, ownerRoleFor must follow it on its own.
  const repo = makeRepo({ developer: {}, po: {} }, "owner-migrated");
  fs.mkdirSync(busPath(repo, "po"), { recursive: true });
  eq(ownerRoleFor(repo), "po", "before migration");
  fs.mkdirSync(busPath(repo, OWNER_CANONICAL), { recursive: true });
  eq(ownerRoleFor(repo), OWNER_CANONICAL, "canonical directory wins once it exists");
});

// ── the contract is shared, not copied ───────────────────────────────────────────────────────────

suite("naming: the owner alias table is published for loom_cdp.py", () => {
  // The defect this prevents: four independent copies of the owner set, three of which were missing
  // `po`. loom_cdp.py now reads THIS file, so adding a spelling in one place reaches both languages.
  const f = path.join(process.env.HOME, ".claude", "loom", "naming.json");
  // Order-independent: another suite in this run may already have published it.
  try { fs.unlinkSync(f); } catch { /* not there */ }
  ok(publishNaming(), "first publish writes the file");
  const t = JSON.parse(fs.readFileSync(f, "utf8"));
  eq(t.ownerCanonical, OWNER_CANONICAL, "canonical id published");
  for (const r of ["product-owner", "productowner", "po"]) {
    ok(t.ownerAliases.includes(r), `${r} published`);
  }
  eq(publishNaming(), false, "re-publishing identical content is a no-op (no churn)");
});

suite("naming: the canonical id is the first alias offered", () => {
  // The QuickPick lists ORCHESTRATOR_CANDIDATES in order; the bus's own name is moved to the front
  // by extension.ts, so the array order here only has to be stable and canonical-first.
  eq(OWNER_ALIASES[0], OWNER_CANONICAL, "canonical first");
  eq(new Set(OWNER_ALIASES).size, OWNER_ALIASES.length, "no duplicate spellings");
});

// ── the cycle refuses a worker-named tag ─────────────────────────────────────────────────────────

suite("naming: the context cycle refuses to run against a worker-named tag", () => {
  // The near-miss, measured 2026-09-09: livegita/orchestrator.json read `{"role":"gitadeveloper",
  // "webviewId":null}` — tagged by hand at 17:36 because the real PO (`po`) was never offered as a
  // candidate, so the only livegita node available to star was the developer's. The cycle was held
  // ONLY by the null frame, and a tick fills that field in as soon as the frame is identifiable, at
  // which point it would have asked a developer mid-task to bank its memory and `/clear`.
  const { decide, DEFAULT_CONFIG } = load("memory.js");
  const NOW = 1_800_000_000_000;
  const base = {
    repo: "livegita", webviewId: "wid-dev",
    reading: { tokens: 900_000, fraction: 0.9, model: "claude-opus-5", at: null,
               sessionId: "s", file: "/tmp/x/s.jsonl" },
    busy: false, frameSeen: true, panelPct: 90, panelChars: 150000, windowId: "win-A",
    memoryFile: "/tmp/livegita/developer/memory.md", memoryMtime: null, memorySize: 0,
    now: NOW, cfg: { ...DEFAULT_CONFIG }, state: { phase: "watch" },
  };

  // A worker-named tag, at 90% context — the condition that would otherwise START the cycle.
  const worker = decide({ ...base, role: "gitadeveloper" });
  eq(worker.kind, "none", "a worker-named tag must produce NO action");
  ok(/not an orchestrator role/i.test(worker.note), `refusal must say why, got: ${worker.note}`);

  // The control: the SAME state under the bus's real owner name does proceed, so the guard is about
  // the NAME and has not simply disabled the cycle.
  const owner = decide({ ...base, role: "po" });
  ok(owner.kind !== "none" || !/not an orchestrator role/i.test(owner.note || ""),
    `an owner-named tag must not hit this refusal, got: ${owner.kind} / ${owner.note}`);
});

// ── the board identifies the orchestrator's frame ────────────────────────────────────────────────

suite("naming: a board-declared owner frame is the orchestrator, not the worker it quotes", async () => {
  // THE defect behind "the Gita PO doesn't show up", measured 2026-09-09. livegita's orchestrator
  // tab quotes its developer's `LOOMROLE=gitadeveloper` sign-off. detectOwner() only calls quoting a
  // self-tell at THREE distinct roles — and livegita runs ONE worker, so its PO can never reach
  // three. classify() therefore read the PO's own tab as a clean single-marker developer sign-off,
  // and it BEAT the real developer's frame on text length (159 KB vs 57 KB). The orchestrator was
  // showing up as the developer, and no PO candidate was ever offered.
  const { Tracker } = load("tracker.js");
  const cdp = load("cdp.js");
  const repo = makeRepo({}, "livegita-boardowner");
  const PO = "f13a5e27-po", DEV = "ecb08965-dev";
  writeJson(busPath(repo, "board.json"), {
    gitadeveloper: { session_id: "s-dev", branch: "worktree-developer", status: "idle", webviewId: DEV },
    // The PO writes its OWN webviewId here — this is the authoritative fact content cannot supply.
    po: { role: "orchestrator", webviewId: PO, bus: busPath(repo, "po") },
  });
  fs.mkdirSync(busPath(repo, "po"), { recursive: true });
  fs.writeFileSync(busPath(repo, "po", "inbox.md"), "ring me here");

  const t = new Tracker(repo);
  // The PO frame is LONGER and carries a quoted developer sign-off — exactly the live shape.
  const frames = [
    { webviewId: PO, type: "iframe", targetUrl: "vscode-webview://x",
      text: "orchestrating; developer reported:" + marker("gitadeveloper") + "x".repeat(4000) },
    { webviewId: DEV, type: "iframe", targetUrl: "vscode-webview://x",
      text: "working in worktrees/developer/a.mjs" + marker("gitadeveloper") },
  ];
  const real = cdp.readFrames;
  cdp.readFrames = async () => frames;
  try { await t.tick(); } finally { cdp.readFrames = real; }

  const agents = t.view();
  const po = agents.find((a) => a.webviewId === PO);
  ok(!po, `the orchestrator's frame must NOT become a tracked agent, got role=${po && po.role}`);
  const dev = agents.find((a) => a.role === "gitadeveloper" || a.role === "developer");
  ok(dev, "the real developer is still tracked");
  eq(dev.webviewId, DEV, "and it is the DEVELOPER's frame, not the PO's longer one");

  const cands = t.ownerView().map((o) => o.webviewId);
  ok(cands.includes(PO), "the PO frame is offered as an orchestrator candidate");
  ok(t.ownerView().find((o) => o.webviewId === PO).strong,
    "declared by the board, so it is a STRONG candidate — adoptable without a guess");
});

// ── the board outranks the tag ───────────────────────────────────────────────────────────────────

suite("naming: a declared frame outranks a misclicked tag, and hides weak candidates", async () => {
  // Measured 2026-09-09, twice in one evening: livegita's tag was pointed by hand at a diagnostic
  // session (5426095b) because it was the only candidate the sidebar offered, and the finish
  // notifier then typed a developer's loop-back into it. The board's `po` entry carried the real
  // frame the whole time. So: the board's frame is the only candidate shown when it exists, and it
  // is the frame the cycle uses even when the tag says otherwise.
  const { Tracker } = load("tracker.js");
  const { SessionTreeProvider } = load("statusView.js");
  const { setOrchestrator } = load("orchestrator.js");
  const cdp = load("cdp.js");
  const repo = makeRepo({}, "livegita-declared-vs-tag");
  const PO = "f13a5e27-po", DIAG = "5426095b-diag";
  writeJson(busPath(repo, "board.json"), { po: { role: "orchestrator", webviewId: PO } });
  fs.mkdirSync(busPath(repo, "po"), { recursive: true });
  fs.writeFileSync(busPath(repo, "po", "inbox.md"), "x");
  setOrchestrator(repo, "po", DIAG);                      // the misclick

  const t = new Tracker(repo);
  const busPathMention = `~/.claude/loom/${repo}/po/inbox.md `.repeat(6);   // attributes to repo
  const frames = [
    { webviewId: PO, type: "iframe", targetUrl: "u", text: "orchestrating " + busPathMention },
    { webviewId: DIAG, type: "iframe", targetUrl: "u", text: "debugging the tracker " + busPathMention },
  ];
  const real = cdp.readFrames; cdp.readFrames = async () => frames;
  try { await t.tick(); } finally { cdp.readFrames = real; }

  const owners = t.ownerView();
  const po = owners.find((o) => o.webviewId === PO), diag = owners.find((o) => o.webviewId === DIAG);
  ok(po && po.declared, "the board's frame is a DECLARED owner candidate");
  ok(diag && !diag.declared && !diag.strong, "the diagnostic session is only a weak candidate");

  const view = new SessionTreeProvider(t, repo);
  const offered = view.getChildren().flatMap((n) => (n.kind === "ownerCandidate" ? [n] : view.getChildren(n)))
    .filter((n) => n && n.kind === "ownerCandidate").map((n) => n.webviewId);
  ok(offered.includes(PO), "the declared frame is offered");
  ok(!offered.includes(DIAG), "the weak candidate is NOT offered beside a declared one — nothing to misclick");
});

// ── a stranger that prints the board is not the developer ───────────────────────────────────────

suite("tracker: a signing worker outranks a longer frame that only mentions its worktree", async () => {
  // Measured 2026-09-09 22:07: livegita's real developer (69 KB, signs LOOMROLE=gitadeveloper) lost the
  // `developer` role to a 325 KB diagnostic session that had printed board.json a few times — same
  // purity (1), longer text. That stranger then received the developer's usage-limit resume.
  const { Tracker } = load("tracker.js"); const cdp = load("cdp.js");
  const repo = makeRepo({ developer: {}, po: {} }, "lg-stranger");
  const DEV = "b3190fe4-dev", ME = "132f0ce0-me";
  const frames = [
    { webviewId: DEV, type: "iframe", targetUrl: "u", text: "editing worktrees/developer/a.mjs" + marker("developer") },
    { webviewId: ME,  type: "iframe", targetUrl: "u",
      text: ("board says worktree /home/aneesh/Containers/x/.claude/worktrees/developer ").repeat(40) + "z".repeat(300000) },
  ];
  const real = cdp.readFrames; cdp.readFrames = async () => frames;
  try { await new Tracker(repo).tick().then(() => {}); } finally { cdp.readFrames = real; }
  const t = new Tracker(repo); cdp.readFrames = async () => frames;
  try { await t.tick(); } finally { cdp.readFrames = real; }
  const dev = t.view().find((a) => a.role === "developer");
  ok(dev, "developer is tracked");
  eq(dev.webviewId, DEV, "and it is the frame that SIGNS, not the longer one that only mentions paths");
});

suite("tracker: a frame attributed to ANOTHER project is not this window's worker", async () => {
  // Both Gaming and livegita have a `developer`. A frame whose dominant paths are Gaming's must not
  // be livegita's developer just because the name matches — that is the cross-project collision.
  const { Tracker } = load("tracker.js"); const cdp = load("cdp.js");
  const gaming = makeRepo({ developer: {} }, "Gaming-attr");
  const lg = makeRepo({ developer: {} }, "livegita-attr");
  const frames = [{ webviewId: "w-g", type: "iframe", targetUrl: "u",
    text: `working in Containers/${gaming}/src ` .repeat(10) + "worktrees/developer/a.ts" }];
  const t = new Tracker(lg); const real = cdp.readFrames; cdp.readFrames = async () => frames;
  try { await t.tick(); } finally { cdp.readFrames = real; }
  eq(t.view().length, 0, "the Gaming-attributed frame is not livegita's developer");
  const tg = new Tracker(gaming); cdp.readFrames = async () => frames;
  try { await tg.tick(); } finally { cdp.readFrames = real; }
  eq(tg.view().map((a) => a.role), ["developer"], "but it IS Gaming's");
});


suite("tracker: path evidence needs the project to agree; a sign-off does not", async () => {
  // Measured 2026-09-09 23:11: a diagnostic session mentioning five buses at 0.77 purity attributed
  // to NOBODY, and took Gaming's `developer` by path — 38 /model injections went into it.
  const { Tracker } = load("tracker.js"); const cdp = load("cdp.js");
  const gaming = makeRepo({ developer: {} }, "Gaming-corrob");
  const other = makeRepo({ developer: {} }, "Other-corrob");
  const real = cdp.readFrames;
  // (a) unattributable stranger that merely PRINTS the paths -> not a worker anywhere
  const stranger = `mentions Containers/${gaming}/a Containers/${other}/b loom/${other}/c `.repeat(6) +
                   "worktrees/developer/x worktrees/developer/y";
  let t = new Tracker(gaming);
  cdp.readFrames = async () => [{ webviewId: "w-strange", type: "iframe", targetUrl: "u", text: stranger }];
  try { await t.tick(); } finally { cdp.readFrames = real; }
  eq(t.view().length, 0, "an unattributable frame does not take a role by path alone");
  // (b) a real worker in ITS OWN worktree, marker scrolled off -> still found by path
  t = new Tracker(gaming);
  const worker = `editing Containers/${gaming}/src `.repeat(8) + "worktrees/developer/a.ts worktrees/developer/b.ts";
  cdp.readFrames = async () => [{ webviewId: "w-real", type: "iframe", targetUrl: "u", text: worker }];
  try { await t.tick(); } finally { cdp.readFrames = real; }
  eq(t.view().map((a) => a.role), ["developer"], "path evidence still works when the project agrees");
  // (c) a freshly-cleared worker names NO project; its signature alone is enough
  t = new Tracker(gaming);
  cdp.readFrames = async () => [{ webviewId: "w-fresh", type: "iframe", targetUrl: "u",
    text: "just started, nothing checked out yet" + marker("developer") }];
  try { await t.tick(); } finally { cdp.readFrames = real; }
  eq(t.view().map((a) => a.webviewId), ["w-fresh"], "an unattributed sign-off is accepted as-is");
  // (d) but a sign-off cannot claim a role in a window whose project the frame contradicts: a marker
  //     names the ROLE, not the PROJECT, and `developer` exists on both boards.
  t = new Tracker(gaming);
  cdp.readFrames = async () => [{ webviewId: "w-elsewhere", type: "iframe", targetUrl: "u",
    text: `working in Containers/${other}/src loom/${other}/x `.repeat(8) + marker("developer") }];
  try { await t.tick(); } finally { cdp.readFrames = real; }
  eq(t.view().length, 0, `a frame whose paths say ${other} is not ${gaming}'s developer`);
  const t2 = new Tracker(other);
  cdp.readFrames = async () => [{ webviewId: "w-elsewhere", type: "iframe", targetUrl: "u",
    text: `working in Containers/${other}/src loom/${other}/x `.repeat(8) + marker("developer") }];
  try { await t2.tick(); } finally { cdp.readFrames = real; }
  eq(t2.view().map((a) => a.role), ["developer"], "but it IS that project's developer");
});

suite("tracker: within ONE project, the frame that signs beats the longer frame that only mentions", () => {
  // The corroboration rule rejects a stranger from ANOTHER project, so it never exercises the tie
  // that source-ranking exists for: two frames both attributed to THIS project, one signing its role,
  // one merely printing that role's worktree — a PO reviewing a diff, a second session reading a
  // handoff. Before ranking, both scored purity 1 and the LONGER text won, which is how a 159 KB
  // panel took the role from the 57 KB one that actually signs it (measured 2026-09-09).
  const { Tracker } = load("tracker.js"); const cdp = load("cdp.js");
  const repo = makeRepo({ developer: {} }, "same-project-tie");
  const home = `Containers/${repo}/src `;
  const signer = home.repeat(10) + "edited a.ts" + marker("developer");
  const mentioner = home.repeat(10) + "worktrees/developer/a.ts worktrees/developer/b.ts ".repeat(5) +
                    "z".repeat(200000);                      // far longer, no sign-off
  return (async () => {
    const t = new Tracker(repo); const real = cdp.readFrames;
    cdp.readFrames = async () => [
      { webviewId: "w-mentioner", type: "iframe", targetUrl: "u", text: mentioner },
      { webviewId: "w-signer", type: "iframe", targetUrl: "u", text: signer },
    ];
    try { await t.tick(); } finally { cdp.readFrames = real; }
    const dev = t.view().find((a) => a.role === "developer");
    ok(dev, "developer is tracked");
    eq(dev.webviewId, "w-signer",
      "the SIGNING frame owns the role, though the other is 200 KB longer and same-project");
  })();
});

// ── numbered instances: several agents in the same role ─────────────────────────────────────────

suite("naming: developer1/2/3 are instances of one role, and distinct identities", () => {
  const { baseRole, inVocabulary, canonicalRole } = load("naming.js");
  for (const [role, base] of [["developer1", "developer"], ["developer2", "developer"],
                              ["developer-3", "developer"], ["designer2", "designer"]]) {
    eq(baseRole(role), base, `${role} is an instance of ${base}`);
    ok(inVocabulary(role), `${role} counts as on-vocabulary, so live.sh does not report it as drift`);
  }
  // A vocabulary name is never mangled, even ending in a digit-like suffix.
  eq(baseRole("developer"), "developer", "the bare role is left alone");
  eq(baseRole("product-owner"), "product-owner");
  eq(baseRole("lowpoly"), "lowpoly", "a non-vocabulary name with no number is unchanged");
  ok(!inVocabulary("lowpoly"), "and still reported as off-vocabulary");

  // IDENTITY is never collapsed: each instance has its own worktree and mailbox.
  const repo = makeRepo({ developer1: {}, developer2: {} }, "instances");
  eq(canonicalRole(repo, "developer2"), "developer2",
    "canonicalRole must NOT strip the number — worktrees/developer1 and /developer2 are different dirs");
});

suite("naming: instances never score each other, and an underscore form is invisible", () => {
  const roster = new Set(["developer1", "developer2"]);
  const mk = (r) => "\nLOOMROLE=" + r + "\n";
  eq(classify("work" + mk("developer2"), roster, null).role, "developer2", "sign-off");
  eq(classify("worktrees/developer2/a worktrees/developer2/b", roster, null).role, "developer2", "path");
  // 6 mentions of one instance and 1 of the other: 0.857 purity, above the 0.8 floor.
  eq(classify("worktrees/developer1/a ".repeat(6) + "worktrees/developer2/b", roster, null).role,
    "developer1", "the dominant instance wins; there is no prefix leak between them");
  // The trap: both regexes are [a-z][a-z0-9-]+, so an underscore makes a role invisible to BOTH signals.
  const under = new Set(["developer_2"]);
  eq(classify("x" + mk("developer_2"), under, null).role, null, "underscore names cannot be signed");
  eq(classify("worktrees/developer_2/a", under, null).role, null, "nor detected by path");
});
