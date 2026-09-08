const { suite, ok, eq, match, load, LOOM } = require("./harness");
const fs = require("fs");
const path = require("path");
const { isSessionFrame, countSessions, publishCount, readCount } = load("sessions.js");

const COUNT_FILE = path.join(LOOM, "active-sessions.json");
// Shapes taken from a real 32-frame CDP read (2026-09-08).
const panel = (id, extra = "") => ({ webviewId: id, text: "\nClaude: did the thing.\n" + extra + "\nBypass permissions\n" });
const windowShell = () => ({ webviewId: null, text: "funisland\n1\nEXPLORER\n Loom: 2/3 active\n" });
const sessionsList = (id) => ({ webviewId: id, text: "\nACCOUNT & USAGE\nView details\nEmail\nNew session\nLocal\nWeb\n" });

suite("sessions: a conversation panel is recognised in every permission mode", () => {
  for (const chip of ["Bypass permissions", "Accept edits", "Plan mode", "Ask each time"]) {
    ok(isSessionFrame({ webviewId: "w", text: "chat\n" + chip + "\n" }), "recognised with: " + chip);
  }
  ok(isSessionFrame({ webviewId: "w", text: "\nReady for your input.\n" }), "idle panel counts");
  ok(isSessionFrame({ webviewId: "w", text: "ctrl esc to focus or unfocus Claude" }), "composer hint counts");
});

suite("sessions: window shells and non-Claude webviews are not sessions", () => {
  eq(isSessionFrame(windowShell()), false, "a window shell has no webviewId");
  eq(isSessionFrame({ webviewId: "w", text: "some other extension's webview" }), false, "no Claude markers");
  eq(isSessionFrame({ webviewId: "w", text: "" }), false, "empty text");
  eq(isSessionFrame({}), false, "empty frame");
  eq(isSessionFrame(null), false, "null frame never throws");
});

suite("sessions: Claude's own sessions-list sidebar is not a conversation", () => {
  eq(isSessionFrame(sessionsList("s1")), false, "sidebar excluded");
});

suite("sessions: a chat that QUOTES the sidebar text still counts", () => {
  // The sidebar test is anchored to the start on purpose: an unanchored test
  // mis-filed 2 real conversations that merely mentioned the phrase.
  const quoting = panel("w1", "we looked at the ACCOUNT & USAGE panel together");
  ok(isSessionFrame(quoting), "long chat quoting the phrase is still a session");
});

suite("sessions: counts panels, windows, and what is bound here", () => {
  const frames = [
    windowShell(), windowShell(),
    panel("a"), panel("b"), panel("c"),
    sessionsList("s1"),
  ];
  const c = countSessions(frames, new Set(["a", "b"]), ["beta", "alpha"], "funisland");
  eq(c.sessions, 3, "three conversations");
  eq(c.windows, 2, "two editor windows");
  eq(c.boundHere, 2, "two bound to a Loom role");
  eq(c.rolesHere, ["alpha", "beta"], "roles reported sorted");
  eq(c.updatedBy, "funisland", "records the publishing window");
  ok(c.at, "timestamped");
});

suite("sessions: an unscoped window still reports the global count", () => {
  const c = countSessions([panel("a"), panel("b")], new Set(), [], null);
  eq(c.sessions, 2, "counts every window's sessions, not just one project's");
  eq(c.boundHere, 0, "nothing bound here");
  eq(c.updatedBy, "(unscoped)", "labelled unscoped");
});

suite("sessions: reproduces the live 2026-09-08 measurement", () => {
  // 32 frames = 9 window shells + 18 conversations + 5 sessions-lists.
  const frames = [
    ...Array.from({ length: 9 }, windowShell),
    ...Array.from({ length: 18 }, (_, i) => panel("p" + i)),
    ...Array.from({ length: 5 }, (_, i) => sessionsList("s" + i)),
  ];
  eq(frames.length, 32, "same frame total as the live read");
  const c = countSessions(frames, new Set(["p0", "p1"]), ["developer"], "Gaming");
  eq(c.sessions, 18, "18 simultaneous conversations");
  eq(c.windows, 9, "9 windows");
  // The per-project counter would have said 2/3 here — that is the gap being closed.
  ok(c.sessions > c.boundHere, "editor-wide count exceeds what one project sees");
});

suite("sessions: the count is published on the bus for scripts and sessions to read", () => {
  const c = countSessions([panel("a"), panel("b"), windowShell()], new Set(["a"]), ["alpha"], "funisland");
  publishCount(c);
  ok(fs.existsSync(COUNT_FILE), "written to ~/.claude/loom/active-sessions.json");
  const back = readCount();
  eq(back.sessions, 2, "count round-trips");
  eq(back.windows, 1, "windows round-trip");
  eq(back.updatedBy, "funisland", "publisher round-trips");
});

suite("sessions: publishing is change-only so it does not churn every tick", () => {
  const c = countSessions([panel("a")], new Set(), [], "r");
  publishCount(c);
  const firstAt = readCount().at;
  publishCount(countSessions([panel("a")], new Set(), [], "r"));   // same numbers, later timestamp
  eq(readCount().at, firstAt, "identical snapshot does not rewrite the file");
  publishCount(countSessions([panel("a"), panel("b")], new Set(), [], "r"));
  eq(readCount().sessions, 2, "a real change does rewrite");
});

suite("sessions: a corrupt count file never throws", () => {
  fs.writeFileSync(COUNT_FILE, "not json");
  eq(readCount(), null, "unreadable -> null");
  publishCount(countSessions([panel("a")], new Set(), [], "r"));
  eq(readCount().sessions, 1, "and it is rewritten valid");
});
