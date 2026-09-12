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
