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
// WL-005 changed the arity: `deployed` (what is on disk) is now its own argument, because the source
// manifest standing in for it is exactly the defect. These FX-001 suites are about STAMP FRESHNESS,
// so they pass DEPLOYED === PKG_V — the case where the two agree — and the three cases where they do
// not are asserted in the WL-005 suites below.
const DEPLOYED = PKG_V;
const iso = (msAgo, now) => new Date(now - msAgo).toISOString();

suite("FX-001 R2: an old-build stamp 5 minutes old is IGNORED, not reported behind", () => {
  const now = Date.now();
  const stamp = { "1:repoA": { repo: "repoA", version: "0.33.0", at: iso(5 * 60_000, now) } };
  const j = judgeRunningVersions(stamp, DEPLOYED, PKG_V, now);
  eq(j.level, "WARN", "a dead stamp is not evidence of a running old build: " + j.detail);
  ok(!/behind|OLD build/i.test(j.detail), "must not say 'behind' for a stale entry: " + j.detail);
});

suite("FX-001 R2: an old-build stamp 20 seconds old IS reported behind", () => {
  const now = Date.now();
  const stamp = { "1:repoA": { repo: "repoA", version: "0.33.0", at: iso(20_000, now) } };
  const j = judgeRunningVersions(stamp, DEPLOYED, PKG_V, now);
  eq(j.level, "FAIL", "a genuinely live old build must still fail: " + j.detail);
  ok(/repoA is on 0\.33\.0/.test(j.detail), "names the window and its version: " + j.detail);
});

suite("FX-001 R2: a stamp exactly on the fresh boundary is stale (< , not <=)", () => {
  const now = Date.now();
  const stamp = { "1:repoA": { repo: "repoA", version: "0.33.0", at: iso(STAMP_FRESH_MS, now) } };
  const j = judgeRunningVersions(stamp, DEPLOYED, PKG_V, now);
  eq(j.level, "WARN", "exactly the window's age is stale: " + j.detail);
});

suite("FX-001 R2: a mix of a dead old-build stamp and a fresh matching one PASSES, saying how many were ignored", () => {
  const now = Date.now();
  const stamp = {
    "1:repoA": { repo: "repoA", version: "0.33.0", at: iso(5 * 60_000, now) },  // dead OLD build
    "2:repoA": { repo: "repoA", version: PKG_V, at: iso(1_000, now) },          // live, current
  };
  const j = judgeRunningVersions(stamp, DEPLOYED, PKG_V, now);
  eq(j.level, "PASS", j.detail);
  ok(/1 stale stamp\(s\) ignored/.test(j.detail), "says how many stale stamps were dropped: " + j.detail);
});

suite("FX-001 R2: a mix of a dead old-build stamp and a fresh BEHIND one still fails, and still says so", () => {
  const now = Date.now();
  const stamp = {
    "1:repoA": { repo: "repoA", version: "0.30.0", at: iso(20 * 60_000, now) }, // dead, irrelevant
    "2:repoA": { repo: "repoA", version: "0.33.0", at: iso(20_000, now) },      // live and behind
  };
  const j = judgeRunningVersions(stamp, DEPLOYED, PKG_V, now);
  eq(j.level, "FAIL", j.detail);
  ok(/repoA is on 0\.33\.0/.test(j.detail));
  ok(/1 stale stamp\(s\) ignored/.test(j.detail), "the dead entry is named as ignored, not silently dropped: " + j.detail);
});

suite("FX-001 R2: no parseable stamp at all is the honest 'cannot tell' warning, not a silent pass", () => {
  const now = Date.now();
  eq(judgeRunningVersions({}, DEPLOYED, PKG_V, now).level, "WARN");
  eq(judgeRunningVersions({ "1:repoA": { repo: "repoA", version: "0.33.0", at: "not-a-date" } }, PKG_V, now).level,
     "WARN", "an unparseable timestamp is neither fresh nor a stale-and-counted entry");
});

suite("FX-001 R2: every window on the current version, all fresh, passes with no stale note", () => {
  const now = Date.now();
  const stamp = { "1:repoA": { repo: "repoA", version: PKG_V, at: iso(1_000, now) } };
  const j = judgeRunningVersions(stamp, DEPLOYED, PKG_V, now);
  eq(j.level, "PASS");
  ok(!/stale/.test(j.detail), "nothing to ignore, nothing to say: " + j.detail);
});

// ── WL-005 · "deployed" means what is on disk ──────────────────────────────────────────────────
//
// MEASURED 2026-09-15, while deploying 0.38.1: run after the merge and before `deploy.sh`, this check
// reported "deployed is 0.38.1" — read off the SOURCE manifest — while the newest artifact under
// ~/.vscode-oss/extensions was 0.38.0. It named a build that existed nowhere and told the reader to
// RELOAD to reach it. Reloading cannot reach a build nobody has written; the true instruction was
// `deploy.sh`. `./live.sh` is the file a cleared context is told to believe over anything written by
// hand, so a wrong line here discredits the correct ones beside it.

suite("WL-005: the source manifest AHEAD of the newest artifact says DEPLOY, not reload", () => {
  const now = Date.now();
  // Every window is on the newest deployed build. Nothing is behind; the build is simply not out.
  const stamp = { "1:repoA": { repo: "repoA", version: "0.38.0", at: iso(1_000, now) } };
  const j = judgeRunningVersions(stamp, "0.38.0", "0.38.1", now);
  eq(j.level, "FAIL", "an undeployed build is a real failure: " + j.detail);
  ok(/NOT DEPLOYED YET/.test(j.detail), "says the build is not out: " + j.detail);
  ok(/deploy\.sh/.test(j.detail), "and names the action that fixes it: " + j.detail);
  ok(!/Reload those windows/.test(j.detail),
     "and must NOT tell anyone to reload — the windows are on the newest build there is: " + j.detail);
  ok(!/deployed is 0\.38\.1/.test(j.detail),
     "never names the manifest version as deployed — the exact wrong line: " + j.detail);
});

suite("WL-005: a window behind the newest ARTIFACT says reload, and names the artifact", () => {
  const now = Date.now();
  const stamp = { "1:repoA": { repo: "repoA", version: "0.37.1", at: iso(1_000, now) } };
  const j = judgeRunningVersions(stamp, "0.38.0", "0.38.0", now);
  eq(j.level, "FAIL", j.detail);
  ok(/repoA is on 0\.37\.1/.test(j.detail), "names the window: " + j.detail);
  ok(/newest DEPLOYED artifact is 0\.38\.0/.test(j.detail),
     "compares against what is on disk, not the manifest: " + j.detail);
  ok(/Reload those windows/.test(j.detail), "reload is the right instruction here: " + j.detail);
});

suite("WL-005: behind AND undeployed says BOTH — they are different actions", () => {
  const now = Date.now();
  const stamp = { "1:repoA": { repo: "repoA", version: "0.37.1", at: iso(1_000, now) } };
  const j = judgeRunningVersions(stamp, "0.38.0", "0.38.1", now);
  eq(j.level, "FAIL", j.detail);
  ok(/Reload those windows/.test(j.detail), "the window is behind the artifact: " + j.detail);
  ok(/NOT DEPLOYED YET/.test(j.detail), "and the manifest is ahead of the artifact: " + j.detail);
  ok(/deploy\.sh/.test(j.detail), "both actions named: " + j.detail);
});

suite("WL-005: NO artifact anywhere is unmeasured — never the manifest wearing the word 'deployed'", () => {
  const now = Date.now();
  const stamp = { "1:repoA": { repo: "repoA", version: "0.38.0", at: iso(1_000, now) } };
  const j = judgeRunningVersions(stamp, null, "0.38.1", now);
  eq(j.level, "WARN", "nothing on disk to compare against: " + j.detail);
  ok(/unmeasured/.test(j.detail), "says so in the one word: " + j.detail);
  ok(!/deployed is 0\.38\.1/.test(j.detail), "and does not name the manifest as deployed: " + j.detail);
  ok(!/Reload those windows/.test(j.detail), "nor order a reload it cannot justify: " + j.detail);
  ok(/repoA on 0\.38\.0/.test(j.detail),
     "the windows' own versions ARE measured and are still reported: " + j.detail);
});

suite("WL-005: everything agreeing passes, and says the artifact is what it compared", () => {
  const now = Date.now();
  const stamp = { "1:repoA": { repo: "repoA", version: "0.38.1", at: iso(1_000, now) } };
  const j = judgeRunningVersions(stamp, "0.38.1", "0.38.1", now);
  eq(j.level, "PASS", j.detail);
  ok(/newest deployed artifact/.test(j.detail), "names its basis: " + j.detail);
});

suite("WL-005: version compare is NUMERIC per segment — 0.38.10 is newer than 0.38.9", () => {
  const now = Date.now();
  const stamp = { "1:repoA": { repo: "repoA", version: "0.38.10", at: iso(1_000, now) } };
  // A string compare would call "0.38.10" < "0.38.9" and report the manifest as ahead.
  const j = judgeRunningVersions(stamp, "0.38.10", "0.38.9", now);
  ok(!/NOT DEPLOYED YET/.test(j.detail),
     "0.38.9 is not ahead of 0.38.10: " + j.detail);
  eq(j.level, "PASS", j.detail);
});
