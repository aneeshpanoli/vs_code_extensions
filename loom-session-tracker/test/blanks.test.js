// blanks.test.js — recognising a restored-but-empty Claude panel, well enough to close one.
// Fixtures are the REAL shells measured after the 2026-09-12 restart (359–428 chars, "Untitled",
// no identity of any kind) and the real sessions they sat beside.
const { suite, ok, eq, load } = require("./harness");
const { isBlankShell, blankShells, closableShells, BLANK_MAX_CHARS } = load("blanks.js");

// Captured verbatim from the live editor, trimmed of the marketing copy in the middle.
const SHELL = "Claude: Remote Control is active · Continue here, on your phone, or at claude.ai/code " +
  "Untitled // TODO: Everything. Let's start. Introducing Fable 5.1 Fable 5.1 writes better code " +
  "and reports progress on long tasks. Switch anytime with /model.";
const REAL = "Claude: banked DEV-054\nYou: ring\nworktrees/developer1/src/a.ts\nLOOMROLE=developer1\n" + "x".repeat(40000);

suite("blanks: a restored shell is recognised; a real session never is", () => {
  ok(isBlankShell(SHELL), "the measured shell");
  ok(!isBlankShell(REAL), "a real session");
  ok(!isBlankShell(""), "an empty read proves nothing and is never closable");
  ok(!isBlankShell(null), "nor a missing one");
});

suite("blanks: all three conditions are required, not any one of them", () => {
  // tiny + placeholder, but it names a role -> NOT blank (this is the dangerous direction)
  ok(!isBlankShell("Untitled\nLOOMROLE=developer1"), "identity beats size");
  ok(!isBlankShell("Untitled worktrees/developer1/a"), "a worktree path is identity");
  ok(!isBlankShell("Untitled\nYou: hello"), "a user turn is identity");
  // tiny + no identity, but NOT a fresh panel -> not a shell we understand, so not closable
  ok(!isBlankShell("some half-rendered thing"), "no placeholder -> we do not close what we cannot name");
  // placeholder + no identity, but too big -> something is in it
  ok(!isBlankShell("Untitled " + "x".repeat(BLANK_MAX_CHARS)), "size still bounds it");
});

suite("blanks: only shells that were blank BEFORE and are still blank are closable", () => {
  const before = ["w-a", "w-b", "w-c"];
  const after = [
    { webviewId: "w-a", text: SHELL },        // still blank -> closable
    { webviewId: "w-b", text: REAL },         // the reopen REUSED it: it is now the session
    { webviewId: "w-new", text: SHELL },      // went blank AFTER we started: someone's new tab
  ];                                          // w-c has vanished entirely
  eq(closableShells(before, after, 5), ["w-a"], "only the one that was blank then and is blank now");
  eq(closableShells(before, after, 0), [], "nothing opened means nothing closed");
  eq(closableShells([], after, 5), [], "a shell we never saw before is never closed");
});

suite("blanks: never close more than were reopened", () => {
  const many = Array.from({ length: 8 }, (_, i) => `w${i}`);
  const after = many.map((w) => ({ webviewId: w, text: SHELL }));
  eq(closableShells(many, after, 2).length, 2, "the cap is the number of sessions reopened");
  eq(blankShells(after).length, 8, "even though all eight read blank");
});
