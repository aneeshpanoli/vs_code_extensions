// limits-reset.test.js — a limit must actually EXPIRE. Written from the 2026-09-09 22:18 measurement:
// three funisland roles limited at 19:49 ("in 2h"), still "limited" at 22:18, no resume ever sent.
const { suite, ok, eq, load, makeRepo } = require("./harness");
const { parseEta, detectLimit, LimitWatcher, CLEAR_TICKS_REQUIRED, RESET_GRACE_MS } = load("limits.js");

suite("limits: the clock form of the banner parses to a deadline", () => {
  const now = new Date("2026-09-09T21:00:00").getTime();   // local
  const e = parseEta("session limit · resets 9:50pm (America/Los_Angeles)", now);
  eq(e.etaText, "at 9:50pm", "eta text");
  eq(new Date(e.notBefore).getHours(), 21, "21h"); eq(new Date(e.notBefore).getMinutes(), 50, "50m");
  ok(e.notBefore > now, "later today");
  const past = parseEta("resets 8:00am", now);   // 13h behind 21:00
  ok(past.notBefore > now, "a clock already >12h behind rolls to tomorrow");
});

suite("limits: notBefore does not slide, and a passed deadline clears a stale banner", () => {
  const repo = makeRepo({ curriculum: {} }, "limits-expire");
  const w = new LimitWatcher(repo);
  const banner = "You've hit your session limit · resets in 2h";
  const t0 = Date.now();
  const info = detectLimit(banner, t0);
  eq(w.scan(new Map([["curriculum", info]]), new Set(["curriculum"])).length, 0, "limited: no event");
  const first = w.limitedRoles().curriculum.notBefore;
  // a later tick re-parses the SAME "in 2h" banner — the deadline must stay put
  eq(w.scan(new Map([["curriculum", detectLimit(banner, t0 + 60_000)]]), new Set(["curriculum"])).length, 0);
  eq(w.limitedRoles().curriculum.notBefore, first, "notBefore kept from the first sighting");
  // fast-forward: deadline + grace passed, banner text UNCHANGED (blocked sessions render nothing new)
  const rec = w.limitedRoles().curriculum; rec.notBefore = Date.now() - RESET_GRACE_MS - 1000;
  const fs = require("fs"), path = require("path");
  const f = path.join(process.env.HOME, ".claude", "loom", repo, "limit-state.json");
  fs.writeFileSync(f, JSON.stringify({ roles: { curriculum: rec } }));
  let events = [];
  for (let i = 0; i < CLEAR_TICKS_REQUIRED; i++) events = w.scan(new Map([["curriculum", info]]), new Set(["curriculum"]));
  eq(events.map((e) => e.role), ["curriculum"], "resume fires despite the stale banner");
});
