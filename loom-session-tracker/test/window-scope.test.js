// window-scope.test.js — a panel is in exactly one WINDOW, and one project per window is the rule.
//
// 2026-09-12, reported by ReciEats' orchestrator itself: its window's targetmap mapped 9e4e718c to
// developer1, but that frame was Lumen's developer1 tab (parentId = the Lumen window). Both rosters
// carry `developer1`; the frame's text said nothing decisive; its WINDOW did. So the open-requests
// channel refused the PO's own request as "already live" three times, and lane A stayed unopened.
const { suite, ok, eq, load, makeRepo } = require("./harness");
const { windowRootFromTitle } = load("cdp.js");
const { Tracker } = load("tracker.js");
const cdp = load("cdp.js");
const marker = (r) => "\nLOOMROLE=" + r + "\n";

suite("window-scope: the folder is the second-to-last title segment", () => {
  eq(windowRootFromTitle("Claude Code - ReciEats - VSCodium"), "ReciEats");
  eq(windowRootFromTitle("Lumen - Lumen - VSCodium"), "Lumen", "active tab happens to share the folder's name");
  eq(windowRootFromTitle("Lumen developer binding - funisland - VSCodium"), "funisland", "tab title with words in it");
  eq(windowRootFromTitle("Memory refresh from docu… - VSCodium"), null, "no folder open -> null");
  eq(windowRootFromTitle(""), null); eq(windowRootFromTitle(null), null);
});

async function tick(repo, root, frames) {
  const t = new Tracker(repo); t.setWindowRoot(root);
  const real = cdp.readFrames; cdp.readFrames = async () => frames;
  try { await t.tick(); } finally { cdp.readFrames = real; }
  return t;
}
const fr = (webviewId, text, windowRoot, windowKnown = true) =>
  ({ webviewId, type: "iframe", targetUrl: "u", text, windowRoot, windowKnown });

suite("window-scope: another window's developer1 is never this project's developer1", async () => {
  const reci = makeRepo({ developer1: {}, productowner: {} }, "ReciEats-ws");
  const lumen = makeRepo({ developer1: {}, productowner: {} }, "Lumen-ws");
  // Lumen's developer1 signs its role and its window is Lumen's — exactly the measured frame.
  const frames = [fr("9e4e718c", "working LUM-009" + marker("developer1"), lumen)];
  const t = await tick(reci, reci, frames);
  eq(t.view().length, 0, "ReciEats' window claims nothing from Lumen's window");
  const tl = await tick(lumen, lumen, frames);
  eq(tl.view().map((a) => a.role), ["developer1"], "Lumen's window claims it");
});

suite("window-scope: a worktree window named after one of my roles is still mine", async () => {
  const repo = makeRepo({ developer1: {}, productowner: {} }, "wt-ws");
  // the developer works in a window whose folder is the worktree `developer1`
  const t = await tick(repo, repo, [fr("w-dev", "working" + marker("developer1"), "developer1")]);
  eq(t.view().map((a) => a.role), ["developer1"], "counted, because `developer1` is on this roster");
});

suite("window-scope: a window with NO folder belongs to nobody; a legacy read filters nothing", async () => {
  const repo = makeRepo({ developer1: {} }, "nofolder-ws");
  // the diagnostic session lives in a folderless window and prints roles all day
  const t = await tick(repo, repo, [fr("w-diag", "worktrees/developer1/a" + marker("developer1"), null, true)]);
  eq(t.view().length, 0, "a folderless window's panel is never a worker");
  // no parentId from CDP at all -> we cannot tell, so we must not filter
  const t2 = await tick(repo, repo, [fr("w-old", "working" + marker("developer1"), null, false)]);
  eq(t2.view().map((a) => a.role), ["developer1"], "legacy read passes through");
});
