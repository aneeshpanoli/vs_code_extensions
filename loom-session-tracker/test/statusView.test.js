const { suite, ok, eq, match, load, makeRepo } = require("./harness");
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
  const p = new SessionTreeProvider(trackerOf([agent("alpha", repo)], [{ webviewId: "wid-po-x", lastSeen: Date.now(), liveness: "live" }]), repo);
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
  const p = new SessionTreeProvider(trackerOf([agent("alpha", repo)], [{ webviewId: "wid-po-x", lastSeen: Date.now(), liveness: "live" }]), repo);
  setOrchestrator(repo, "product-owner");
  const kids = p.getChildren(p.getChildren()[0]);
  eq(kids.filter((n) => n.kind === "orchestrator").length, 1, "star node shown");
  eq(kids.filter((n) => n.kind === "ownerCandidate").length, 0, "candidate withdrawn");
  const item = p.getTreeItem(kids.find((n) => n.kind === "orchestrator"));
  eq(item.contextValue, "loomOrchestrator", "untag menu applies");
  match(item.description, /orchestrator/, "labelled orchestrator");
});

suite("view: the project appears even with zero live agents when there is a PO to show", () => {
  const repo = makeRepo({ roles: { alpha: {} } });
  const p = new SessionTreeProvider(trackerOf([], [{ webviewId: "wid-po-x", lastSeen: Date.now(), liveness: "live" }]), repo);
  eq(p.getChildren().map((n) => n.repo), [repo], "project node still rendered");
});

suite("view: an unfiltered window lists PO candidates at top level", () => {
  // No folder open => no project group to nest under.
  const p = new SessionTreeProvider(trackerOf([], [{ webviewId: "wid-po-x", lastSeen: Date.now(), liveness: "live" }]), null);
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
