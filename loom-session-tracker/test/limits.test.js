const { suite, ok, eq, match, load, makeRepo, busPath, readJson, LOOM } = require("./harness");
const fs = require("fs");
const path = require("path");
const { detectLimit, parseEta, LimitWatcher, loadLimitState, CLEAR_TICKS_REQUIRED, TAIL_CHARS } = load("limits.js");

// Banner strings exactly as the shipped webview builds them (2.1.263).
const blocked = (label, resets) => `chat...\nYou've hit your ${label}${resets ? ` · resets ${resets}` : ""}\nBypass permissions\n`;
const warning = (pct, label) => `chat...\nYou've used ${pct}% of your ${label} · resets in 1h\nBypass permissions\n`;
const grace = (phrase) => `chat...\nUsage limit reached · ${phrase}\nBypass permissions\n`;

suite("limits: a blocked session is detected for every limit type", () => {
  for (const label of ["session limit", "weekly limit", "weekly Opus limit", "weekly Sonnet limit",
                       "Fable limit", "usage credit limit"]) {
    const info = detectLimit(blocked(label, "in 2h"));
    ok(info && info.limited, "blocked on: " + label);
    eq(info.kind, label, "reports which limit");
  }
});

suite("limits: the coarse reset text is parsed into a lower bound", () => {
  const now = 1_000_000_000_000;
  eq(parseEta("resets in 45m", now), { etaText: "in 45m", notBefore: now + 45 * 60000 }, "minutes");
  eq(parseEta("resets in 2h", now), { etaText: "in 2h", notBefore: now + 2 * 3600000 }, "hours");
  eq(parseEta("resets in 3d", now), { etaText: "in 3d", notBefore: now + 3 * 86400000 }, "days");
  eq(parseEta("resets soon", now).etaText, "soon", "soon");
  eq(parseEta("no reset text here", now), { etaText: null, notBefore: null }, "absent");
});

suite("limits: warnings are NOT treated as blocks", () => {
  // The session still works at 85% — resuming it would be wrong.
  eq(detectLimit(warning(85, "session limit")), null, "percentage warning ignored");
  eq(detectLimit("chat\nApproaching weekly limit · resets in 2d\nBypass permissions\n"), null, "approaching ignored");
});

suite("limits: grace states are distinguished", () => {
  const finishing = detectLimit(grace("finishing up"));
  ok(finishing.limited, "'finishing up' means it is about to stop -> limited");
  const covered = detectLimit(grace("a little extra on us, then your credits"));
  eq(covered.limited, false, "'covered' keeps working -> not limited");
});

suite("limits: a conversation that merely DISCUSSES limits is not flagged", () => {
  // This very conversation quotes the banner text; only the tail (by the composer) counts.
  const chatty = "We discussed how You've hit your session limit appears when blocked. " +
    "x".repeat(TAIL_CHARS) + "\nReady for your input.\nBypass permissions\n";
  eq(detectLimit(chatty), null, "quoted banner far from the composer is ignored");
  ok(detectLimit("x".repeat(TAIL_CHARS) + blocked("session limit", "in 1h")).limited,
    "a REAL banner in the tail is still caught");
});

suite("limits: empty/garbage input never throws", () => {
  for (const t of [null, undefined, "", "   "]) eq(detectLimit(t), null, "safe on " + JSON.stringify(t));
});

// ── the watcher ─────────────────────────────────────────────────────────────
const info = (kind = "session limit") => ({ limited: true, kind, etaText: "in 2h", notBefore: Date.now() + 7.2e6 });
const live = (...roles) => new Set(roles);

suite("watcher: a limited role is recorded and does not resume while still blocked", () => {
  const repo = makeRepo({ w1: {} });
  const w = new LimitWatcher(repo);
  eq(w.scan(new Map([["w1", info()]]), live("w1")), [], "no event while blocked");
  ok(loadLimitState(repo).roles.w1, "recorded on the bus");
  eq(w.scan(new Map([["w1", info()]]), live("w1")), [], "still nothing on the next tick");
});

suite("watcher: resumes only after the banner stays clear for consecutive ticks", () => {
  const repo = makeRepo({ w1: {} });
  const w = new LimitWatcher(repo);
  w.scan(new Map([["w1", info()]]), live("w1"));                 // blocked
  for (let i = 1; i < CLEAR_TICKS_REQUIRED; i++) {
    eq(w.scan(new Map([["w1", null]]), live("w1")), [], "one clear tick is not enough (flap guard)");
  }
  const ev = w.scan(new Map([["w1", null]]), live("w1"));
  eq(ev.length, 1, "resumes once the banner is reliably gone");
  eq(ev[0].role, "w1", "names the role");
  eq(ev[0].kind, "session limit", "remembers which limit blocked it");
  ok(ev[0].blockedSince, "reports how long it was blocked");
  eq(w.scan(new Map([["w1", null]]), live("w1")), [], "and only once");
  eq(loadLimitState(repo).roles.w1, undefined, "state cleared after resuming");
});

suite("watcher: a role that flaps back to blocked does not resume", () => {
  const repo = makeRepo({ w1: {} });
  const w = new LimitWatcher(repo);
  w.scan(new Map([["w1", info()]]), live("w1"));
  w.scan(new Map([["w1", null]]), live("w1"));        // one clear tick
  w.scan(new Map([["w1", info()]]), live("w1"));      // blocked again -> counter resets
  eq(w.scan(new Map([["w1", null]]), live("w1")), [], "clear-tick counter restarted");
});

suite("watcher: an unseen role keeps waiting rather than being resumed blind", () => {
  const repo = makeRepo({ w1: {} });
  const w = new LimitWatcher(repo);
  w.scan(new Map([["w1", info()]]), live("w1"));
  for (let i = 0; i <= CLEAR_TICKS_REQUIRED; i++) {
    eq(w.scan(new Map(), live()), [], "role not visible -> no resume");
  }
  ok(loadLimitState(repo).roles.w1, "still tracked as limited");
});

suite("watcher: a limit that lifts during an IDE RESTART is still resumed", () => {
  const repo = makeRepo({ w1: {} });
  new LimitWatcher(repo).scan(new Map([["w1", info("weekly limit")]]), live("w1"));   // IDE run #1
  // ... editor closed, limit resets while it is down ...
  const fresh = new LimitWatcher(repo);                                               // IDE run #2
  let ev = [];
  for (let i = 0; i < CLEAR_TICKS_REQUIRED; i++) ev = fresh.scan(new Map([["w1", null]]), live("w1"));
  eq(ev.length, 1, "the pending resume survived the restart");
  eq(ev[0].kind, "weekly limit", "with the original limit kind");
});

suite("watcher: several roles are tracked independently", () => {
  const repo = makeRepo({ a: {}, b: {} });
  const w = new LimitWatcher(repo);
  w.scan(new Map([["a", info()], ["b", info("weekly limit")]]), live("a", "b"));
  let ev = [];
  for (let i = 0; i < CLEAR_TICKS_REQUIRED; i++) {
    ev = w.scan(new Map([["a", null], ["b", info("weekly limit")]]), live("a", "b"));
  }
  eq(ev.map((e) => e.role), ["a"], "only the freed role resumes");
  ok(loadLimitState(repo).roles.b, "the still-blocked role stays tracked");
});

suite("watcher: limitedRoles() exposes what the UI should show", () => {
  const repo = makeRepo({ w1: {} });
  const w = new LimitWatcher(repo);
  w.scan(new Map([["w1", info()]]), live("w1"));
  const shown = w.limitedRoles();
  eq(shown.w1.kind, "session limit", "kind for the badge");
  eq(shown.w1.etaText, "in 2h", "eta for the badge");
});

suite("watcher: an unfiltered window does nothing", () => {
  const w = new LimitWatcher(null);
  eq(w.scan(new Map([["w1", info()]]), live("w1")), [], "no repo -> no tracking");
  eq(w.limitedRoles(), {}, "and nothing to show");
});

suite("watcher: resume injects into the blocked session via loom_cdp", () => {
  const repo = makeRepo({ w1: {} });
  fs.writeFileSync(path.join(LOOM, "loom_cdp.py"), "import sys\nprint(' '.join(sys.argv[1:]))\n");
  return new Promise((resolve, reject) => {
    new LimitWatcher(repo).resume(
      { repo, role: "w1", kind: "session limit", blockedSince: new Date().toISOString() },
      "[loom-resume] carry on",
      (okFlag) => {
        try {
          ok(okFlag, "inject reported ok");
          const dbg = readJson(path.join(LOOM, "resume-debug.json"));
          match(dbg.out, /inject/, "used the inject subcommand");
          match(dbg.out, /--role w1/, "targeted the blocked role");
          match(dbg.out, /--submit/, "submitted the prompt");
          match(dbg.out, /loom-resume/, "sent the resume message");
          resolve();
        } catch (e) { reject(e); }
      });
  });
});
