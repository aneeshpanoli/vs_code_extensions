const { suite, ok, eq, load, makeRepo, busPath, writeJson, readJson } = require("./harness");
const { Tracker } = load("tracker.js");
const cdp = load("cdp.js");

// The tracker calls cdp.readFrames() at tick time, so swapping the export is
// enough to feed it synthetic frames — no browser, no sockets.
function withFrames(frames, fn) {
  const real = cdp.readFrames;
  cdp.readFrames = async () => frames;
  return Promise.resolve(fn()).finally(() => { cdp.readFrames = real; });
}
const frame = (webviewId, text) => ({ webviewId, text, type: "iframe", targetUrl: "vscode-webview://x" });
const marker = (r) => "\nLOOMROLE=" + r + "\n";

suite("tracker: detects agents from frames and persists the targetmap", async () => {
  const repo = makeRepo({ roles: { alpha: {}, beta: {} } });
  const t = new Tracker(repo);
  await withFrames([frame("wid-a", "work" + marker("alpha")), frame("wid-b", "work" + marker("beta"))],
    async () => {
      const r = await t.tick();
      ok(r.ok, "tick ok");
      eq(r.liveRoles.sort(), ["alpha", "beta"], "both roles live");
      eq(t.view().map((a) => a.role).sort(), ["alpha", "beta"], "both in the model");
      eq(readJson(busPath(repo, "targetmap.json")), { "wid-a": "alpha", "wid-b": "beta" }, "map persisted");
    });
});

suite("tracker: a FAILED read never wipes the model (agents go stale)", async () => {
  const repo = makeRepo({ roles: { alpha: {} } });
  const t = new Tracker(repo);
  await withFrames([frame("wid-a", "work" + marker("alpha"))], () => t.tick());
  await withFrames([], async () => {
    const r = await t.tick();
    eq(r.ok, false, "read reported as failed");
    eq(t.view().map((a) => a.role), ["alpha"], "agent RETAINED");
    eq(t.view()[0].liveness, "stale", "but marked stale");
    eq(readJson(busPath(repo, "targetmap.json")), { "wid-a": "alpha" }, "good map not clobbered");
  });
});

suite("tracker: a throwing CDP read is contained", async () => {
  const repo = makeRepo({ roles: { alpha: {} } });
  const t = new Tracker(repo);
  const real = cdp.readFrames;
  cdp.readFrames = async () => { throw new Error("socket wedged"); };
  try {
    const r = await t.tick();
    eq(r.ok, false, "reports failure instead of throwing");
    ok(/socket wedged/.test(r.error || ""), "surfaces the reason: " + r.error);
  } finally { cdp.readFrames = real; }
});

suite("tracker: the orchestrator is excluded from agents but exposed as a candidate", async () => {
  const repo = makeRepo({ roles: { alpha: {} } });
  const t = new Tracker(repo);
  // A PO frame: signs itself product-owner (never a roster role).
  await withFrames([frame("wid-po", "orchestrating" + marker("product-owner")),
                    frame("wid-a", "work" + marker("alpha"))], async () => {
    await t.tick();
    eq(t.view().map((a) => a.role), ["alpha"], "PO is NOT a tracked agent");
    eq(t.ownerView().map((o) => o.webviewId), ["wid-po"], "PO surfaced for tagging");
    eq(t.ownerView()[0].liveness, "live", "and marked live");
  });
});

suite("tracker: a project-scoped window ignores another project's roles", async () => {
  const mine = makeRepo({ roles: { minerole: {} } });
  makeRepo({ roles: { theirrole: {} } });
  const t = new Tracker(mine);
  await withFrames([frame("wid-1", "x" + marker("minerole")), frame("wid-2", "y" + marker("theirrole"))],
    async () => {
      await t.tick();
      eq(t.view().map((a) => a.role), ["minerole"], "only this project's role tracked");
    });
});

suite("tracker: a /loom binding fills in when the marker has scrolled away", async () => {
  const repo = makeRepo({ roles: { alpha: {} } });
  writeJson(busPath(repo, "bindings.json"), { "wid-a": "alpha" });
  const t = new Tracker(repo);
  // Frame text carries NO marker and no worktree path — only the binding can save it.
  await withFrames([frame("wid-a", "a long document with no identity signal at all")], async () => {
    await t.tick();
    eq(t.view().map((a) => a.role), ["alpha"], "resolved via bindings.json");
  });
});

suite("tracker: live content OVERRIDES a stale binding", async () => {
  const repo = makeRepo({ roles: { alpha: {}, beta: {} } });
  writeJson(busPath(repo, "bindings.json"), { "wid-a": "alpha" });   // stale: says alpha
  const t = new Tracker(repo);
  await withFrames([frame("wid-a", "work" + marker("beta"))], async () => {
    await t.tick();
    eq(t.view().map((a) => a.role), ["beta"], "content wins over the binding");
  });
});

suite("tracker: frames without a webviewId are skipped", async () => {
  const repo = makeRepo({ roles: { alpha: {} } });
  const t = new Tracker(repo);
  await withFrames([{ webviewId: null, text: "x" + marker("alpha"), type: "page" }], async () => {
    const r = await t.tick();
    ok(r.ok, "still a successful read");
    eq(t.view(), [], "nothing tracked from a page frame");
  });
});

suite("tracker: a tick measures editor-wide session concurrency", async () => {
  const repo = makeRepo({ roles: { alpha: {} } });
  const t = new Tracker(repo);
  // One bound role, one unbound conversation in another window, plus two window shells.
  const chat = (id, body) => ({ webviewId: id, text: body + "\nBypass permissions\n" });
  await withFrames([
    { webviewId: null, text: "window shell" },
    { webviewId: null, text: "another window shell" },
    chat("wid-a", "work" + marker("alpha")),
    chat("wid-other", "somebody else's conversation"),
  ], async () => {
    await t.tick();
    const sc = t.sessionCount();
    ok(sc, "a count was produced");
    eq(sc.sessions, 2, "both conversations counted, not just this project's agent");
    eq(sc.windows, 2, "window shells counted separately");
    eq(sc.boundHere, 1, "one bound to a role here");
    eq(sc.rolesHere, ["alpha"], "names the bound role");
  });
});

suite("tracker: sessionCount is null until the first successful read", async () => {
  const repo = makeRepo({ roles: { alpha: {} } });
  const t = new Tracker(repo);
  await withFrames([], () => t.tick());
  eq(t.sessionCount(), null, "no count claimed from a failed read");
});

suite("tracker: a role blocked by a usage limit is flagged on its agent", async () => {
  const repo = makeRepo({ roles: { alpha: {} } });
  const t = new Tracker(repo);
  const blocked = "work" + marker("alpha") + "\nYou've hit your session limit · resets in 2h\nBypass permissions\n";
  await withFrames([frame("wid-a", blocked)], async () => {
    await t.tick();
    const a = t.view()[0];
    ok(a.limit && a.limit.limited, "agent carries the limit state");
    eq(a.limit.kind, "session limit", "which limit");
    eq(a.limit.etaText, "in 2h", "and the UI's eta");
    ok(t.limitState().get("alpha").limited, "exposed for the resume watcher");
  });
});

suite("tracker: an unblocked role reports no limit", async () => {
  const repo = makeRepo({ roles: { alpha: {} } });
  const t = new Tracker(repo);
  await withFrames([frame("wid-a", "work" + marker("alpha") + "\nBypass permissions\n")], async () => {
    await t.tick();
    eq(t.view()[0].limit, null, "no banner -> no limit");
  });
});

suite("tracker: each role's model is read from its footer", async () => {
  const repo = makeRepo({ roles: { alpha: {}, beta: {} } });
  const t = new Tracker(repo);
  const withFooter = (m, role) => "work" + marker(role) + `\nRemote Control\n${m}\nMedium\nBypass permissions\n`;
  await withFrames([frame("wid-a", withFooter("Fable 5", "alpha")),
                    frame("wid-b", withFooter("Opus 5", "beta"))], async () => {
    await t.tick();
    const byRole = Object.fromEntries(t.view().map((a) => [a.role, a.model && a.model.model]));
    eq(byRole, { alpha: "Fable 5", beta: "Opus 5" }, "model reported per role");
    eq(t.modelState().get("alpha").model, "Fable 5", "exposed for the policy check");
  });
});

suite("tracker: the filter can switch between one project and all of them", async () => {
  const mine = makeRepo({ roles: { minerole: {} } });
  const theirs = makeRepo({ roles: { theirrole: {} } });
  const t = new Tracker(mine);
  const frames = [frame("wid-1", "x" + marker("minerole")), frame("wid-2", "y" + marker("theirrole"))];
  await withFrames(frames, async () => {
    await t.tick();
    eq(t.view().map((a) => a.role), ["minerole"], "scoped to this project");
    t.setFilter(null);
    eq(t.view(), [], "switching clears the model so nothing leaks across");
    await t.tick();
    eq(t.view().map((a) => a.role).sort(), ["minerole", "theirrole"], "now every project's roles");
    eq(t.filter(), null, "and it reports the current filter");
    t.setFilter(mine);
    await t.tick();
    eq(t.view().map((a) => a.role), ["minerole"], "and back again");
  });
});
