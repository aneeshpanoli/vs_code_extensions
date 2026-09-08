const { suite, ok, eq, match, rejects, load, makeRepo, vscode } = require("./harness");
const { Coordinator, MAX_ACTIVE_TOTAL } = load("coordinator.js");
const { setLock } = load("locks.js");
const cdp = load("cdp.js");

const agent = (role, repo, liveness = "live") =>
  ({ role, repo, webviewId: "wid-" + role, lastSeen: Date.now(), liveness });
const trackerOf = (agents) => ({ view: () => agents, ownerView: () => [] });

suite("coordinator: the orchestrator can NEVER be spawned, retired or deleted", async () => {
  const repo = makeRepo({ roles: { alpha: {} } });
  // Even if an owner role were somehow presented as a live agent, every path must refuse.
  const c = new Coordinator(trackerOf([agent("product-owner", repo)]), repo);
  await rejects(() => c.spawn("product-owner"), /orchestrator role/, "spawn refuses");
  await rejects(() => c.retire("product-owner"), /orchestrator role/, "retire refuses");
  await rejects(() => c.delete("product-owner", "/tmp", "stamp"), /orchestrator role/, "delete refuses");
  eq(c.retirableAgents().map((a) => a.role), [], "never offered as a retire target");
  eq(c.deletableRoles().includes("product-owner"), false, "never offered as a delete target");
});

suite("coordinator: spawnable roles exclude owners and already-live agents", () => {
  const repo = makeRepo({ roles: { alpha: {}, beta: {} } });
  const c = new Coordinator(trackerOf([agent("alpha", repo)]), repo);
  eq(c.spawnableRoles(["alpha", "beta", "product-owner"]), ["beta"], "only the idle worker role");
});

suite("coordinator: spawn enforces the active-session cap", async () => {
  const repo = makeRepo({ roles: { a: {}, b: {}, c: {} } });
  // activeTotal counts live agents + 1 for the orchestrator.
  const atCap = new Coordinator(trackerOf([agent("a", repo), agent("b", repo)]), repo);
  eq(atCap.activeTotal(), MAX_ACTIVE_TOTAL, "at the cap");
  await rejects(() => atCap.spawn("c"), /cap reached/, "refuses past the cap");
  const room = new Coordinator(trackerOf([agent("a", repo)]), repo);
  const msg = await room.spawn("c");
  match(msg, /\/loom c/, "tells the user how to bind the new session");
  eq(vscode._executed.map((e) => e.id), ["claude-vscode.editor.open"], "opened exactly one session");
});

suite("coordinator: stale agents do not count toward the cap", () => {
  const repo = makeRepo({ roles: { a: {}, b: {} } });
  const c = new Coordinator(trackerOf([agent("a", repo), agent("b", repo, "stale")]), repo);
  eq(c.activeTotal(), 2, "1 live agent + orchestrator");
});

suite("coordinator: retire only touches a CONFIRMED live agent of this project", async () => {
  const repo = makeRepo({ roles: { alpha: {} } });
  const other = makeRepo({ roles: { foreign: {} } });
  const c = new Coordinator(trackerOf([agent("alpha", repo), agent("foreign", other)]), repo);
  await rejects(() => c.retire("ghost"), /not a confirmed live agent/i, "unknown role refused");
  await rejects(() => c.retire("foreign"), /not a confirmed live agent/i, "another project's agent refused");
  eq(c.retirableAgents().map((a) => a.role), ["alpha"], "only this project's live agent");
});

suite("coordinator: a stale agent cannot be retired", async () => {
  const repo = makeRepo({ roles: { alpha: {} } });
  const c = new Coordinator(trackerOf([agent("alpha", repo, "stale")]), repo);
  await rejects(() => c.retire("alpha"), /not a confirmed live agent/i, "stale is not retirable");
});

suite("coordinator: a LOCKED role is protected from retire and delete", async () => {
  const repo = makeRepo({ roles: { alpha: {} } });
  setLock(repo, "alpha", true);
  const c = new Coordinator(trackerOf([agent("alpha", repo)]), repo);
  await rejects(() => c.retire("alpha"), /LOCKED/, "retire refuses");
  await rejects(() => c.delete("alpha", "/tmp", "stamp"), /LOCKED/, "delete refuses");
  eq(c.deletableRoles(), [], "not offered for deletion");
  setLock(repo, "alpha", false);
  eq(c.deletableRoles(), ["alpha"], "offered again once unlocked");
});

suite("coordinator: retire closes the agent's webview and reports it", async () => {
  const repo = makeRepo({ roles: { alpha: {} } });
  const real = cdp.closeWebview;
  const seen = [];
  cdp.closeWebview = async (wid) => { seen.push(wid); return { ok: true, note: "closed" }; };
  try {
    const c = new Coordinator(trackerOf([agent("alpha", repo)]), repo);
    const msg = await c.retire("alpha");
    eq(seen, ["wid-alpha"], "closed the right webview");
    match(msg, /retired 'alpha'/, "reports what it did");
  } finally { cdp.closeWebview = real; }
});

suite("coordinator: a close that does not confirm is reported as a failure", async () => {
  const repo = makeRepo({ roles: { alpha: {} } });
  const real = cdp.closeWebview;
  cdp.closeWebview = async () => ({ ok: false, note: "no live target" });
  try {
    const c = new Coordinator(trackerOf([agent("alpha", repo)]), repo);
    await rejects(() => c.retire("alpha"), /did not confirm/, "surfaces the failure");
  } finally { cdp.closeWebview = real; }
});
