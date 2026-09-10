// declarations.test.js — the bus's own way of addressing frames: `<repo>/<role>.id` files and board
// webviewIds. Added 2026-09-09 after "I don't see any orchestrated session for ReciEats": its PO was
// running and writing status every few minutes, and the sidebar listed nothing, because this
// extension had never read the id-file convention the buses use.

const { suite, ok, eq, load, makeRepo, busPath, writeJson } = require("./harness");
const { busDeclaredFrames, rivalDeclarers, freshestClaimant, declarationHolds, boardOwnerFrames } = load("registry.js");
const { Tracker } = load("tracker.js");
const cdp = load("cdp.js");
const fs = require("fs"), path = require("path");

const marker = (r) => "\nLOOMROLE=" + r + "\n";
const frame = (webviewId, text) => ({ webviewId, type: "iframe", targetUrl: "u", text });
const idFile = (repo, role, wid, guard) =>
  fs.writeFileSync(busPath(repo, `${role}.id`), wid + "\n" + (guard ? guard + "\n" : ""));
const touchStatus = (repo, role, at) => {
  const f = busPath(repo, role, "status.json");
  fs.mkdirSync(path.dirname(f), { recursive: true });
  fs.writeFileSync(f, JSON.stringify({ role }));
  fs.utimesSync(f, at / 1000, at / 1000);
};
const tick = async (repo, frames) => {
  const t = new Tracker(repo); const real = cdp.readFrames;
  cdp.readFrames = async () => frames;
  try { await t.tick(); } finally { cdp.readFrames = real; }
  return t;
};

suite("declarations: an id file names a frame's role; a session_id in line 1 is ignored", () => {
  const repo = makeRepo({ developer: {}, productowner: {} }, "decl-read");
  idFile(repo, "developer", "aaaaaaaa-1111-2222-3333-444444444444", "LOOMROLE=developer");
  idFile(repo, "productowner", "bbbbbbbb-1111-2222-3333-444444444444");
  fs.writeFileSync(busPath(repo, "designer.id"), "not-a-uuid\n");
  const d = busDeclaredFrames(repo);
  eq(d.filter((x) => x.source === "idfile").map((x) => x.role).sort(), ["developer", "productowner"],
    "both id files read; the malformed line 1 is skipped, not guessed at");
  eq(d.find((x) => x.role === "developer").guard, "LOOMROLE=developer", "line 2 kept as the guard");
  eq(d.find((x) => x.role === "productowner").guard, null, "line-1-only files are normal (funisland's)");
  ok([...boardOwnerFrames(repo)].includes("bbbbbbbb-1111-2222-3333-444444444444"),
    "the owner's declared frame is offered as an orchestrator frame");
});

suite("declarations: the line-2 guard rejects a stale id on an IDLE tab, not on a working one", () => {
  // The bus's own finding (ReciEats/README-ids.md): the transcript is virtualized, so on a session
  // that is working the sign-off scrolls out of the rendered DOM and a guard check false-refuses a
  // perfectly correct id. It happened to funisland's curriculum mid-row.
  const d = { webviewId: "w", role: "developer", source: "idfile", guard: "LOOMROLE=developer" };
  ok(declarationHolds(d, "…" + marker("developer"), false), "guard present on an idle tab -> holds");
  ok(!declarationHolds(d, "no sign-off here", false), "guard absent on an IDLE tab -> stale id");
  ok(declarationHolds(d, "no sign-off here", true), "guard absent on a BUSY tab -> inconclusive, trusted");
  ok(declarationHolds({ ...d, guard: null }, "anything", false), "no guard -> nothing to check");
});

suite("declarations: a declared WORKER keeps its role against a bystander printing its paths", async () => {
  // Measured 2026-09-09: ReciEats declares its developer in developer.id while a diagnostic session
  // that merely printed `worktrees/developer` was taking the role by path.
  const repo = makeRepo({ developer: {} }, "decl-worker");
  const REAL = "cccccccc-1111-2222-3333-444444444444";
  idFile(repo, "developer", REAL, "LOOMROLE=developer");
  const home = `Containers/${repo}/src `;
  const t = await tick(repo, [
    frame("w-bystander", home.repeat(10) + "worktrees/developer/a worktrees/developer/b ".repeat(6) + "z".repeat(120000)),
    frame(REAL, home.repeat(4) + "working" + marker("developer")),
  ]);
  const dev = t.view().find((a) => a.role === "developer");
  ok(dev, "developer is tracked");
  eq(dev.webviewId, REAL, "and it is the DECLARED frame, not the longer bystander");
});

suite("declarations: an orchestrator that names no project is still its project's candidate", async () => {
  // ReciEats' PO works on `main` and mentions almost no project paths, so attributeRepo returns null
  // and it was offered to NO window — a STRONG candidate belonging to nobody.
  const repo = makeRepo({ developer: {}, productowner: {} }, "decl-owner-nopaths");
  const PO = "dddddddd-1111-2222-3333-444444444444";
  idFile(repo, "productowner", PO);
  const t = await tick(repo, [frame(PO, "orchestrating; nothing here names a project at all")]);
  const cand = t.ownerView().find((o) => o.webviewId === PO);
  ok(cand, "the declared orchestrator is offered as a candidate");
  ok(cand.strong, "and strongly — the bus declared it, there is nothing to guess");
  ok(!t.view().some((a) => a.webviewId === PO), "while never being a worker");
});

suite("declarations: when two buses declare one frame, the live mailbox wins", async () => {
  // Gaming/*.id and ReciEats/*.id carry the SAME webviewIds — the ReciEats bus was copied from
  // Gaming's. Gaming/productowner/status.json was last written 2026-07-11; ReciEats' minutes ago.
  const older = makeRepo({ developer: {}, productowner: {} }, "decl-old");
  const newer = makeRepo({ developer: {}, productowner: {} }, "decl-new");
  const PO = "eeeeeeee-1111-2222-3333-444444444444";
  idFile(older, "productowner", PO);
  idFile(newer, "productowner", PO);
  touchStatus(older, "productowner", Date.now() - 60 * 86400_000);   // two months stale
  touchStatus(newer, "productowner", Date.now() - 60_000);           // a minute ago

  eq(rivalDeclarers(older, PO), [newer], "each bus sees the other's claim");
  eq(freshestClaimant(older, "productowner", PO), newer, "the live mailbox owns the frame");

  const text = "orchestrating, no project paths at all";
  const winner = await tick(newer, [frame(PO, text)]);
  ok(winner.ownerView().some((o) => o.webviewId === PO), `${newer} claims it`);
  const loser = await tick(older, [frame(PO, text)]);
  ok(!loser.ownerView().some((o) => o.webviewId === PO), `${older} does NOT — its mailbox is two months dead`);
});

suite("declarations: attribution outranks mailbox age when the frame names a project", async () => {
  const a = makeRepo({ developer: {} }, "decl-attr-a");
  const b = makeRepo({ developer: {} }, "decl-attr-b");
  const W = "ffffffff-1111-2222-3333-444444444444";
  idFile(a, "developer", W);
  idFile(b, "developer", W);
  touchStatus(a, "developer", Date.now() - 60_000);          // a's mailbox is fresher…
  touchStatus(b, "developer", Date.now() - 86400_000);
  const text = `working in Containers/${b}/src loom/${b}/x `.repeat(8);   // …but the frame is b's
  const tb = await tick(b, [frame(W, text)]);
  eq(tb.view().map((x) => x.role), ["developer"], `${b} claims the frame its paths name`);
  const ta = await tick(a, [frame(W, text)]);
  eq(ta.view().length, 0, `${a} does not, despite the fresher mailbox`);
});
