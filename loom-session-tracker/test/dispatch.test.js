// dispatch.test.js — WHO gets typed into. Asserted directly, and end-to-end over the real panels
// captured in test/fixtures/live, because this is the decision that went wrong all night on
// 2026-09-09 and had no test of its own: it lived in a closure inside activate().

const { suite, ok, eq, load, makeRepo, busPath, writeJson } = require("./harness");
const { eligibleTargets, mayInject, resolveOrchestrator } = load("dispatch.js");
const { Tracker } = load("tracker.js");
const cdp = load("cdp.js");
const fs = require("fs"), path = require("path");

const A = (role, webviewId, repo, liveness = "live") => ({ role, repo, webviewId, liveness });

// ── the rule, stated directly ───────────────────────────────────────────────────────────────────

suite("dispatch: a COMMAND waits for an idle composer; a MESSAGE does not", () => {
  const agents = [A("developer", "w-dev", "p"), A("designer", "w-des", "p")];
  const busy = new Set(["developer"]);
  eq(eligibleTargets(agents, busy, "command", "p").map((t) => t.role), ["designer"],
    "a mid-turn role receives no command — /model typed there is queued as a message and never runs");
  eq(eligibleTargets(agents, busy, "message", "p").map((t) => t.role).sort(), ["designer", "developer"],
    "but a resume or a notification is fine mid-turn: queuing behind the turn is the point");
  eq(mayInject("developer", agents, busy, "command", "p"), false, "the 2026-09-09 /model failure");
  eq(mayInject("developer", agents, busy, "message", "p"), true);
});

suite("dispatch: a stale agent is never typed into", () => {
  // Its frame id came from an earlier read; ids rotate on reload, so it may now be someone else's tab.
  const agents = [A("developer", "w-old", "p", "stale")];
  eq(eligibleTargets(agents, new Set(), "message", "p").length, 0, "stale -> no target");
  eq(eligibleTargets(agents, new Set(), "command", "p").length, 0);
});

suite("dispatch: this window only ever types into its own project", () => {
  const agents = [A("developer", "w-mine", "mine"), A("developer", "w-theirs", "theirs")];
  eq(eligibleTargets(agents, new Set(), "message", "mine").map((t) => t.webviewId), ["w-mine"],
    "`developer` exists on several buses; the window's own project decides");
});

// ── addressing the orchestrator ─────────────────────────────────────────────────────────────────

suite("dispatch: the orchestrator is refused, with a reason, in every state that bit us", () => {
  const live = new Set(["w-po"]);
  eq(resolveOrchestrator(null, { role: "po", webviewId: "w-po" }, live).ok, false, "no project");
  eq(resolveOrchestrator("r", null, live).ok, false, "untagged — livegita ran a full day like this");

  // The near-miss: orchestrator.json read {"role":"gitadeveloper"}. Its endpoint is a /clear.
  const worker = resolveOrchestrator("r", { role: "gitadeveloper", webviewId: "w-po" }, live);
  eq(worker.ok, false, "a tag naming a WORKER must be refused");
  ok(/not an orchestrator role/.test(worker.reason), `reason must say why, got: ${worker.reason}`);

  eq(resolveOrchestrator("r", { role: "po", webviewId: null }, live).ok, false, "no frame identified");
  const gone = resolveOrchestrator("r", { role: "po", webviewId: "w-old" }, live);
  eq(gone.ok, false, "a frame that is not in this read (the ordinary state after a reload)");
  ok(/rotate/.test(gone.reason), "and the reason explains that ids rotate");

  const okRes = resolveOrchestrator("r", { role: "po", webviewId: "w-po" }, live);
  eq(okRes.ok, true); eq(okRes.target.webviewId, "w-po"); eq(okRes.target.role, "po");
});

suite("dispatch: every owner spelling is addressable, no worker name is", () => {
  const live = new Set(["w"]);
  for (const r of ["product-owner", "productowner", "po", "PO"]) {
    eq(resolveOrchestrator("r", { role: r, webviewId: "w" }, live).ok, true, `${r} is an owner`);
  }
  for (const r of ["developer", "gitadeveloper", "curriculum"]) {
    eq(resolveOrchestrator("r", { role: r, webviewId: "w" }, live).ok, false, `${r} is not`);
  }
});

// ── end to end, over the real captured panels ───────────────────────────────────────────────────

const DIR = path.join(__dirname, "fixtures", "live");
const manifest = JSON.parse(fs.readFileSync(path.join(DIR, "manifest.json"), "utf8"));
const frames = manifest.frames.map((f) => ({
  webviewId: f.webviewId, type: "iframe", targetUrl: `vscode-webview://${f.id}`,
  text: fs.readFileSync(path.join(DIR, f.id + ".txt"), "utf8"), contextPct: f.contextPct,
}));
for (const [repo, b] of Object.entries(manifest.bus || {})) {
  const board = {};
  for (const role of b.roles) board[role] = {};
  for (const wid of b.ownerFrames || []) board[b.ownerRole] = { role: "orchestrator", webviewId: wid };
  makeRepo(board, repo);
  writeJson(busPath(repo, "naming.json"), { aliases: b.aliases || {}, owner: b.ownerRole });
}
async function trackerFor(repo) {
  const t = new Tracker(repo);
  const real = cdp.readFrames;
  cdp.readFrames = async () => frames;
  try { await t.tick(); } finally { cdp.readFrames = real; }
  return t;
}

suite("live: the diagnostic session receives nothing, in any window", async () => {
  // It absorbed 38 `/model` injections on 2026-09-09 because it printed worktree paths while debugging.
  const ME = manifest.frames.find((f) => f.id === "3c22c91c").webviewId;
  for (const repo of Object.keys(manifest.bus)) {
    const t = await trackerFor(repo);
    for (const purpose of ["command", "message"]) {
      const hit = eligibleTargets(t.view(), t.busyRoles, purpose, repo).find((x) => x.webviewId === ME);
      ok(!hit, `${repo} would send it a ${purpose} as '${hit && hit.role}'`);
    }
  }
});

suite("live: a mid-turn worker gets messages but never commands", async () => {
  // 849774ff (ReciEats' developer) was mid-turn and took 9 `/model`s that never executed.
  const t = await trackerFor("ReciEats");
  const dev = t.view().find((a) => a.role === "developer");
  ok(dev, "ReciEats' developer is tracked");
  eq(dev.webviewId.slice(0, 8), "849774ff", "and it is the signing worker, not a look-alike");
  if (t.busyRoles.has("developer")) {
    eq(mayInject("developer", t.view(), t.busyRoles, "command", "ReciEats"), false, "no command mid-turn");
    eq(mayInject("developer", t.view(), t.busyRoles, "message", "ReciEats"), true, "a resume still lands");
  }
});

suite("live: livegita addresses its orchestrator at the PO's own frame", async () => {
  const t = await trackerFor("livegita");
  const ids = new Set(t.ownerView().map((o) => o.webviewId));
  const po = manifest.bus.livegita.ownerFrames[0];
  ok(ids.has(po), `the PO frame ${String(po).slice(0, 8)} is offered as the orchestrator`);
  const res = resolveOrchestrator("livegita", { role: "po", webviewId: po }, new Set(frames.map((f) => f.webviewId)));
  eq(res.ok, true, "and it resolves as an injection target");
  ok(!t.view().some((a) => a.webviewId === po), "while never being treated as a worker");
});
