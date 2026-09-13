// live-check.test.js — FX-001 R2: a stamp nobody refreshes is a DEAD window, not a window behind.
//
// `live-check.js`'s "running version" check reads `running-versions.json`, which every open window
// rewrites every 15s (extension.ts). After a restart the OLD windows' entries stop dead at the
// restart instant while the NEW windows' entries start seconds later, so a stale OLD-build entry
// must be ignored rather than reported "behind" — the old 10-minute freshness window read every
// dead entry as a live old build for up to ten minutes. See `judgeRunningVersions` in live-check.js.
const { suite, ok, eq } = require("./harness");
const path = require("path");
const { judgeRunningVersions, STAMP_FRESH_MS } = require(path.join(__dirname, "..", "live-check.js"));

const PKG_V = "0.35.0";
const iso = (msAgo, now) => new Date(now - msAgo).toISOString();

suite("FX-001 R2: an old-build stamp 5 minutes old is IGNORED, not reported behind", () => {
  const now = Date.now();
  const stamp = { "1:repoA": { repo: "repoA", version: "0.33.0", at: iso(5 * 60_000, now) } };
  const j = judgeRunningVersions(stamp, PKG_V, now);
  eq(j.level, "WARN", "a dead stamp is not evidence of a running old build: " + j.detail);
  ok(!/behind|OLD build/i.test(j.detail), "must not say 'behind' for a stale entry: " + j.detail);
});

suite("FX-001 R2: an old-build stamp 20 seconds old IS reported behind", () => {
  const now = Date.now();
  const stamp = { "1:repoA": { repo: "repoA", version: "0.33.0", at: iso(20_000, now) } };
  const j = judgeRunningVersions(stamp, PKG_V, now);
  eq(j.level, "FAIL", "a genuinely live old build must still fail: " + j.detail);
  ok(/repoA is on 0\.33\.0/.test(j.detail), "names the window and its version: " + j.detail);
});

suite("FX-001 R2: a stamp exactly on the fresh boundary is stale (< , not <=)", () => {
  const now = Date.now();
  const stamp = { "1:repoA": { repo: "repoA", version: "0.33.0", at: iso(STAMP_FRESH_MS, now) } };
  const j = judgeRunningVersions(stamp, PKG_V, now);
  eq(j.level, "WARN", "exactly the window's age is stale: " + j.detail);
});

suite("FX-001 R2: a mix of a dead old-build stamp and a fresh matching one PASSES, saying how many were ignored", () => {
  const now = Date.now();
  const stamp = {
    "1:repoA": { repo: "repoA", version: "0.33.0", at: iso(5 * 60_000, now) },  // dead OLD build
    "2:repoA": { repo: "repoA", version: PKG_V, at: iso(1_000, now) },          // live, current
  };
  const j = judgeRunningVersions(stamp, PKG_V, now);
  eq(j.level, "PASS", j.detail);
  ok(/1 stale stamp\(s\) ignored/.test(j.detail), "says how many stale stamps were dropped: " + j.detail);
});

suite("FX-001 R2: a mix of a dead old-build stamp and a fresh BEHIND one still fails, and still says so", () => {
  const now = Date.now();
  const stamp = {
    "1:repoA": { repo: "repoA", version: "0.30.0", at: iso(20 * 60_000, now) }, // dead, irrelevant
    "2:repoA": { repo: "repoA", version: "0.33.0", at: iso(20_000, now) },      // live and behind
  };
  const j = judgeRunningVersions(stamp, PKG_V, now);
  eq(j.level, "FAIL", j.detail);
  ok(/repoA is on 0\.33\.0/.test(j.detail));
  ok(/1 stale stamp\(s\) ignored/.test(j.detail), "the dead entry is named as ignored, not silently dropped: " + j.detail);
});

suite("FX-001 R2: no parseable stamp at all is the honest 'cannot tell' warning, not a silent pass", () => {
  const now = Date.now();
  eq(judgeRunningVersions({}, PKG_V, now).level, "WARN");
  eq(judgeRunningVersions({ "1:repoA": { repo: "repoA", version: "0.33.0", at: "not-a-date" } }, PKG_V, now).level,
     "WARN", "an unparseable timestamp is neither fresh nor a stale-and-counted entry");
});

suite("FX-001 R2: every window on the current version, all fresh, passes with no stale note", () => {
  const now = Date.now();
  const stamp = { "1:repoA": { repo: "repoA", version: PKG_V, at: iso(1_000, now) } };
  const j = judgeRunningVersions(stamp, PKG_V, now);
  eq(j.level, "PASS");
  ok(!/stale/.test(j.detail), "nothing to ignore, nothing to say: " + j.detail);
});
