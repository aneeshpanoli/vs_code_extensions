const { suite, ok, eq, match, load, makeRepo, busPath, vscode, LOOM } = require("./harness");
const { SessionTreeProvider } = load("statusView.js");
const { setOrchestrator } = load("orchestrator.js");
const { setLock } = load("locks.js");

const agent = (role, repo, extra = {}) =>
  ({ role, repo, webviewId: "wid-" + role + "-0123456789", lastSeen: Date.now(), liveness: "live", ...extra });
// A stand-in Tracker: the view is pure presentation over these two methods.
const trackerOf = (agents, owners = []) => ({ view: () => agents, ownerView: () => owners });

suite("view: groups agents under their project", () => {
  const repo = makeRepo({ roles: { alpha: {} } });
  const p = new SessionTreeProvider(trackerOf([agent("alpha", repo)]), repo);
  const top = p.getChildren();
  eq(top.map((n) => n.repo), [repo], "one project node");
  const kids = p.getChildren(top[0]);
  eq(kids.filter((n) => n.kind === "agent").map((n) => n.agent.role), ["alpha"], "agent beneath it");
});

suite("view: an UNTAGGED orchestrator is visible and one click taggable", () => {
  // The 0.3.0 fix: before this, the PO was invisible so there was nothing to tag.
  const repo = makeRepo({ roles: { alpha: {} } });
  const p = new SessionTreeProvider(trackerOf([agent("alpha", repo)], [{ webviewId: "wid-po-x", lastSeen: Date.now(), liveness: "live", repo, strong: true, contextPct: null, busy: false, chars: 5000 }]), repo);
  const kids = p.getChildren(p.getChildren()[0]);
  const cand = kids.find((n) => n.kind === "ownerCandidate");
  ok(cand, "candidate node present");
  eq(cand.role, "product-owner", "carries the role the notifier injects to");
  const item = p.getTreeItem(cand);
  eq(item.contextValue, "loomOwnerCandidate", "contextValue drives the star menu");
  eq(item.command.command, "loomSessionTracker.tagOrchestrator", "clicking tags it");
  eq(item.command.arguments[0].role, "product-owner", "click passes the role");
  match(item.description, /untagged/, "labelled untagged");
});

suite("view: once tagged the candidate becomes the star node, not a duplicate", () => {
  const repo = makeRepo({ roles: { alpha: {} } });
  const owner = { webviewId: "wid-po-x", lastSeen: Date.now(), liveness: "live", repo,
                  strong: true, contextPct: null, busy: false, chars: 5000 };
  const p = new SessionTreeProvider(trackerOf([agent("alpha", repo)], [owner]), repo);
  setOrchestrator(repo, "product-owner", "wid-po-x");        // tagged AT that frame
  const kids = p.getChildren(p.getChildren()[0]);
  eq(kids.filter((n) => n.kind === "orchestrator").length, 1, "star node shown");
  eq(kids.filter((n) => n.kind === "ownerCandidate").length, 0, "candidate withdrawn");
  const item = p.getTreeItem(kids.find((n) => n.kind === "orchestrator"));
  eq(item.contextValue, "loomOrchestrator", "untag menu applies");
  match(item.description, /★ orchestrator$/, "labelled orchestrator, with no warning");
});

suite("view: a tag pointing at a frame this project cannot see says so, and stays fixable", () => {
  // Exactly the live state on 2026-09-09: three projects tagged at one foreign frame. Without this
  // the tree shows a healthy star while nothing can be delivered, and there is nothing to click.
  const repo = makeRepo({ roles: { alpha: {} } });
  const owner = { webviewId: "wid-real", lastSeen: Date.now(), liveness: "live", repo,
                  strong: true, contextPct: 62, busy: false, chars: 40000 };
  const p = new SessionTreeProvider(trackerOf([], [owner]), repo);
  setOrchestrator(repo, "product-owner", "wid-somewhere-else");
  const kids = p.getChildren(p.getChildren()[0]);
  const star = p.getTreeItem(kids.find((n) => n.kind === "orchestrator"));
  match(star.description, /frame not identified/, "the star node admits it is inert");
  match(star.tooltip, /cannot reach it/, "and says what that costs");
  eq(kids.filter((n) => n.kind === "ownerCandidate").length, 1, "the real session is offered");
});

suite("view: the project appears even with zero live agents when there is a PO to show", () => {
  const repo = makeRepo({ roles: { alpha: {} } });
  const p = new SessionTreeProvider(trackerOf([], [{ webviewId: "wid-po-x", lastSeen: Date.now(), liveness: "live", repo, strong: true, contextPct: null, busy: false, chars: 5000 }]), repo);
  eq(p.getChildren().map((n) => n.repo), [repo], "project node still rendered");
});

suite("view: an unfiltered window lists PO candidates at top level", () => {
  // No folder open => no project group to nest under, and no project to filter candidates by.
  const p = new SessionTreeProvider(trackerOf([], [{ webviewId: "wid-po-x", lastSeen: Date.now(),
    liveness: "live", repo: "somewhere", strong: true, contextPct: null, busy: false, chars: 5000 }]), null);
  eq(p.getChildren().filter((n) => n.kind === "ownerCandidate").length, 1, "candidate at top level");
});

suite("view: a locked agent renders as locked and offers unlock only", () => {
  const repo = makeRepo({ roles: { alpha: {} } });
  setLock(repo, "alpha", true);
  const p = new SessionTreeProvider(trackerOf([agent("alpha", repo)]), repo);
  const kids = p.getChildren(p.getChildren()[0]);
  const item = p.getTreeItem(kids.find((n) => n.kind === "agent"));
  eq(item.contextValue, "loomAgentLocked", "locked contextValue hides retire/delete");
  match(item.description, /🔒/, "lock shown in the label");
});

suite("view: stale agents are visibly distinguished from live ones", () => {
  const repo = makeRepo({ roles: { alpha: {} } });
  const p = new SessionTreeProvider(trackerOf([agent("alpha", repo, { liveness: "stale" })]), repo);
  const kids = p.getChildren(p.getChildren()[0]);
  match(p.getTreeItem(kids[0]).description, /stale/, "marked stale");
});

suite("view: an empty tracker renders nothing and never throws", () => {
  const p = new SessionTreeProvider(trackerOf([]), null);
  eq(p.getChildren(), [], "no nodes");
});

suite("view: a candidate the tracker is unsure about is still offered, and labelled", () => {
  // The one that matters: funisland's orchestrator (71% context, measured 2026-09-09) identifies
  // itself as nothing — it is only recognisable as "works on this project, is not one of its roles".
  const repo = makeRepo({ roles: { alpha: {} } });
  const weak = { webviewId: "wid-weak-1", lastSeen: Date.now(), liveness: "live", repo,
                 strong: false, contextPct: 71, busy: false, chars: 110570 };
  const p = new SessionTreeProvider(trackerOf([], [weak]), repo);
  const cand = p.getChildren(p.getChildren()[0]).find((n) => n.kind === "ownerCandidate");
  ok(cand, "offered for tagging");
  const item = p.getTreeItem(cand);
  match(item.description, /71% context/, "shows how full it is — the reason to tag it");
  match(item.description, /possible orchestrator/, "and is honest that this is a guess");
  match(item.tooltip, /not one of its roles/, "the tooltip explains the basis");
});

suite("view: another project's orchestrator is not offered in this window", () => {
  // The CDP read is editor-wide; without this filter every window offers every window's sessions.
  const repo = makeRepo({ roles: { alpha: {} } });
  const foreign = { webviewId: "wid-foreign", lastSeen: Date.now(), liveness: "live",
                    repo: "some-other-project", strong: true, contextPct: null, busy: false, chars: 9000 };
  const p = new SessionTreeProvider(trackerOf([], [foreign]), repo);
  eq(p.getChildren(), [], "nothing to show — not even a project node");
});

suite("view: a DEAD declared frame does not hide a live orchestrator candidate", () => {
  // 2026-09-12: shwab_docker's declared frame AND its tagged frame had both died at the restart; the
  // real running PO was a strong candidate, and the sidebar showed nothing, because a declaration —
  // any declaration — suppressed every other candidate for that project.
  const { SessionTreeProvider } = load("statusView.js");
  const repo = makeRepo({ productowner: {} }, "view-deaddecl");
  const owners = [
    { webviewId: "w-ghost", lastSeen: 0, busy: false, contextPct: null, repo, chars: 0, strong: true, declared: true, liveness: "stale" },
    { webviewId: "w-real", lastSeen: Date.now(), busy: false, contextPct: null, repo, chars: 90000, strong: true, declared: false, liveness: "live" },
  ];
  const tracker = { view: () => [], ownerView: () => owners, sessionCount: () => null, liveRoles: () => [] };
  const tree = new SessionTreeProvider(tracker, repo);
  const kids = tree.getChildren(tree.getChildren()[0]);
  const cands = kids.filter((n) => n.kind === "ownerCandidate").map((n) => n.webviewId);
  ok(cands.includes("w-real"), `the live candidate is offered; got ${JSON.stringify(cands)}`);
});

// ── WL-001 R2 · the work-ledger node ──────────────────────────────────────────────────────────
// Everything else in this panel is the agents' account of themselves. This node is the one thing
// in it they did not write, so it sits ABOVE them and carries the verdict on one line.
const wl = load("workledger.js");
const fsx = require("fs");
const pathx = require("path");

/** Put a computed ledger in the cache the view reads. The view never runs git. */
function seedLedger(repo, over = {}) {
  const ledger = { ...wl.computeWorkLedger(null, {}), repo, empty: false, emptyReason: null,
                   commits: 221, ...over };
  fsx.mkdirSync(pathx.join(LOOM, repo), { recursive: true });
  fsx.writeFileSync(pathx.join(LOOM, repo, "work-ledger.json"),
    JSON.stringify({ ledger }, null, 2));
  return ledger;
}

suite("WL-001 R2: the ledger node sits ABOVE the agents and carries the verdict on one line", () => {
  const repo = makeRepo({ roles: { alpha: {} } });
  seedLedger(repo, { shipsToUser: 10.7, loopBackRate: 30, narrationShare: 28, tag: null,
                     tokensSpent: 9339968335, costEquivalent: 8945.09, costPerProductLine: 0.37,
                     netProductLines: 24075 });
  const p = new SessionTreeProvider(trackerOf([agent("alpha", repo)]), repo);
  const kids = p.getChildren(p.getChildren()[0]);
  eq(kids[0].kind, "ledger", "FIRST child — above every agent, which are all self-report");
  const it = p.getTreeItem(kids[0]);
  match(it.description, /9\.3B/, "tokens on the collapsed row");
  match(it.description, /\$8,945/, "list-price equivalent");
  match(it.description, /\$0\.37\/line/, "and the ratio the owner actually asked for");
  match(it.description, /ships 10\.7%/, "beside the shipping share");
  match(it.description, /release unmeasured/, "and the release state (WL-007: the tag proxy said 'no release in 221 blocks' for ever on an untagged repo that ships daily; this fixture seeds no release signal, so the honest reading is unmeasured)");
  eq(it.collapsibleState, 1, "collapsed — the one line has to work on its own");
  eq(it.command.command, "loomSessionTracker.workLedgerReport", "clicking opens the full report");
  match(it.tooltip, /NOTHING here comes from what an agent wrote about itself/,
        "the tooltip states the provenance rule this node exists to enforce");
});

suite("WL-001 R2: expanding lists each figure, and a RED row states its number", () => {
  const repo = makeRepo({ roles: {} });
  seedLedger(repo, { shipsToUser: 10.7, loopBackRate: 30, narrationShare: 28, tag: null });
  const p = new SessionTreeProvider(trackerOf([]), repo);
  const node = p.getChildren(p.getChildren()[0]).find((n) => n.kind === "ledger");
  const rows = p.getChildren(node);
  const keys = rows.map((r) => r.figure.key);
  for (const k of ["shipsToUser", "loopBackRate", "narrationShare", "rigRatio", "release",
                   "tokensSpent", "costEquivalent", "netProductLines", "costPerProductLine"]) {
    ok(keys.includes(k), `${k} has a row of its own`);
  }
  const ships = p.getTreeItem(rows.find((r) => r.figure.key === "shipsToUser"));
  eq(ships.iconPath.id, "error", "10.7% shipping is RED");
  eq(ships.iconPath.color.id, "charts.red", "in the red colour");
  eq(ships.description, "10.7%", "and the row STATES the number — not a bare warning icon");
  match(ships.tooltip, /computed \d{4}-/, "with computedAt in the tooltip, so a stale cache is obvious");
});

suite("WL-001 R2: each band gets its own colour, at the boundary", () => {
  const repo = makeRepo({ roles: {} });
  const p = new SessionTreeProvider(trackerOf([]), repo);
  for (const [ships, icon] of [[40, "pass"], [30, "warning"], [19, "error"]]) {
    seedLedger(repo, { shipsToUser: ships, tag: "v1", blocksSinceRelease: 0 });
    const node = p.getChildren(p.getChildren()[0]).find((n) => n.kind === "ledger");
    const row = p.getChildren(node).find((r) => r.figure.key === "shipsToUser");
    eq(p.getTreeItem(row).iconPath.id, icon, `${ships}% shipping renders ${icon}`);
  }
});

suite("WL-001 R2/R4: thresholds come from settings, and a partial object still works", () => {
  const repo = makeRepo({ roles: {} });
  seedLedger(repo, { shipsToUser: 45, tag: "v1", blocksSinceRelease: 0 });
  const p = new SessionTreeProvider(trackerOf([]), repo);
  const shipsIcon = () => {
    const node = p.getChildren(p.getChildren()[0]).find((n) => n.kind === "ledger");
    return p.getTreeItem(p.getChildren(node).find((r) => r.figure.key === "shipsToUser")).iconPath.id;
  };
  eq(shipsIcon(), "pass", "45% is green by default");
  vscode._config["loomSessionTracker.workLedgerThresholds"] = { shipsGood: 60 };   // ONE field
  eq(shipsIcon(), "warning", "a raised bar applies, and the untouched fields keep their defaults");
  delete vscode._config["loomSessionTracker.workLedgerThresholds"];
});

suite("WL-001 R2/R4: workLedgerEnabled=false removes the node entirely", () => {
  const repo = makeRepo({ roles: { alpha: {} } });
  seedLedger(repo, { shipsToUser: 10 });
  const p = new SessionTreeProvider(trackerOf([agent("alpha", repo)]), repo);
  vscode._config["loomSessionTracker.workLedgerEnabled"] = false;
  eq(p.getChildren(p.getChildren()[0]).filter((n) => n.kind === "ledger").length, 0, "switched off");
  delete vscode._config["loomSessionTracker.workLedgerEnabled"];
  eq(p.getChildren(p.getChildren()[0]).filter((n) => n.kind === "ledger").length, 1, "and back on");
});

suite("WL-001 R2: a project with no cache yet shows no ledger node, and the panel still renders", () => {
  const repo = makeRepo({ roles: { alpha: {} } });
  const p = new SessionTreeProvider(trackerOf([agent("alpha", repo)]), repo);
  const kids = p.getChildren(p.getChildren()[0]);
  eq(kids.filter((n) => n.kind === "ledger").length, 0, "nothing measured yet, nothing claimed");
  eq(kids.filter((n) => n.kind === "agent").length, 1, "the agents still render");
});

suite("WL-001 R2: a HEURISTIC ledger says so on the row and in the tooltip", () => {
  const repo = makeRepo({ roles: {} });
  seedLedger(repo, { shipsToUser: 50, heuristic: true, tag: "v1", blocksSinceRelease: 0 });
  const p = new SessionTreeProvider(trackerOf([]), repo);
  const node = p.getChildren(p.getChildren()[0]).find((n) => n.kind === "ledger");
  match(p.getTreeItem(node).description, /\(est\)/, "an estimate is marked as one on the row");
  match(p.getTreeItem(node).tooltip, /HEURISTIC/, "and explained in the tooltip");
});
