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
