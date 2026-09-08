const { suite, ok, eq, match, load, makeRepo, busPath, writeJson, readJson, home } = require("./harness");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { execFileSync } = require("child_process");
const { buildDigest, renderDigest, unbankedIn } = load("digest.js");
const { setOrchestrator } = load("orchestrator.js");

const T0 = Date.now();          // ages are relative to real file mtimes, so anchor on real now
const HOUR = 3_600_000;
const base = (over = {}) => ({ liveRoles: new Set(), limited: {}, premiumPending: {},
                               repoRoot: null, now: T0, checkUnbanked: false, ...over });
/** Write a bus file with an explicit mtime so age comparisons are deterministic. */
function put(file, body, ageHours) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, body);
  const t = (T0 - ageHours * HOUR) / 1000;
  fs.utimesSync(file, t, t);
}

suite("digest: a quiet project asks for nothing", () => {
  const repo = makeRepo({ roles: { w1: {} } });
  setOrchestrator(repo, "product-owner");
  const d = buildDigest(repo, base());
  eq(d.actionable, 0, "nothing actionable");
  for (const section of [d.awaitingPickup, d.blocked, d.limited, d.premium, d.unbanked, d.missingSessions]) {
    eq(section, [], "every attention list is empty");
  }
  // Hygiene (stale/duplicate buses elsewhere) is reported but never counted as work for the user,
  // so the "nothing to do" render is asserted on a digest with no hygiene findings.
  eq(renderDigest({ ...d, staleBuses: [], duplicateRoles: [] }), "Nothing needs your attention.",
    "says so plainly");
});

suite("digest: an outbox newer than its inbox is a response nobody picked up", () => {
  const repo = makeRepo({ roles: { w1: {}, w2: {} } });
  setOrchestrator(repo, "po");
  put(busPath(repo, "w1", "inbox.md"), "handoff", 5);
  put(busPath(repo, "w1", "outbox.md"), "my response", 2);      // answered after the handoff
  put(busPath(repo, "w2", "inbox.md"), "handoff", 2);
  put(busPath(repo, "w2", "outbox.md"), "old reply", 5);        // answered before -> already handled
  const d = buildDigest(repo, base());
  eq(d.awaitingPickup.map((x) => x.role), ["w1"], "only the unread one");
  eq(Math.round(d.awaitingPickup[0].hoursAgo), 2, "reports how long it has been sitting");
});

suite("digest: an EMPTY outbox is not a response", () => {
  const repo = makeRepo({ roles: { w1: {} } });
  setOrchestrator(repo, "po");
  put(busPath(repo, "w1", "inbox.md"), "handoff", 5);
  put(busPath(repo, "w1", "outbox.md"), "", 2);                 // touched but empty
  eq(buildDigest(repo, base()).awaitingPickup, [], "empty outbox ignored");
});

suite("digest: roles blocked on a decision are surfaced", () => {
  const repo = makeRepo({ roles: { w1: {}, w2: {} } });
  setOrchestrator(repo, "po");
  writeJson(busPath(repo, "w1", "status.json"), { status: "blocked", current: "H-12", last_line: "need a ruling" });
  writeJson(busPath(repo, "w2", "status.json"), { status: "working", current: "H-13" });
  const d = buildDigest(repo, base());
  eq(d.blocked.map((x) => x.role), ["w1"], "only the blocked role");
  match(d.blocked[0].detail, /H-12/, "names what it is blocked on");
});

suite("digest: usage-limited and premium-model roles come from the watchers", () => {
  const repo = makeRepo({ roles: { w1: {}, w2: {} } });
  setOrchestrator(repo, "po");
  const d = buildDigest(repo, base({
    limited: { w1: { kind: "session limit", etaText: "in 26m" } },
    premiumPending: { w2: { model: "Fable 5.1", attempts: 2 } },
  }));
  match(d.limited[0].detail, /session limit · resets in 26m/, "limit with eta");
  match(d.premium[0].detail, /Fable 5\.1 \(attempt 2\)/, "premium model with attempt count");
});

suite("digest: a role the board knows but has no live tab is offered for reopening", () => {
  const repo = makeRepo({ roles: { w1: { session_id: "abc-123" }, w2: { session_id: "def-456" } } });
  setOrchestrator(repo, "po");
  const d = buildDigest(repo, base({ liveRoles: new Set(["w2"]) }));
  eq(d.missingSessions, [{ role: "w1", sessionId: "abc-123" }], "only the one that is not open");
});

suite("digest: a role with no recorded session id is not offered", () => {
  const repo = makeRepo({ roles: { w1: {} } });      // never bound, no session_id
  setOrchestrator(repo, "po");
  eq(buildDigest(repo, base()).missingSessions, [], "nothing to reopen");
});

suite("digest: an untagged orchestrator is itself actionable", () => {
  const repo = makeRepo({ roles: { w1: {} } });      // deliberately untagged
  const d = buildDigest(repo, base());
  eq(d.orchestratorTagged, false, "detected");
  eq(d.actionable, 1, "counts as something needing the user");
  match(renderDigest(d), /No orchestrator tagged/, "and the render explains what is inactive because of it");
  match(renderDigest(d), /auto-resume/, "naming the dormant features");
});

suite("digest: stale buses and duplicated role names are reported as hygiene", () => {
  const fresh = makeRepo({ roles: { shared: {}, onlyfresh: {} } }, "FreshBus");
  const dead = makeRepo({ roles: { shared: {} } }, "deadbus");
  // age every file in the dead bus well past the threshold
  for (const f of fs.readdirSync(busPath(dead))) {
    const t = (T0 - 90 * 24 * HOUR) / 1000;
    fs.utimesSync(busPath(dead, f), t, t);
  }
  setOrchestrator(fresh, "po");
  const d = buildDigest(fresh, base({ staleDays: 30 }));
  ok(d.staleBuses.some((s) => s.repo === dead && s.days >= 30), "the dead bus is flagged with its age");
  ok(!d.staleBuses.some((s) => s.repo === fresh), "the live bus is not");
  const dup = d.duplicateRoles.find((x) => x.role === "shared");
  ok(dup, "a role claimed by two buses is reported (the Gaming/gaming case)");
  eq(dup.repos.sort(), [dead, fresh].sort(), "naming both buses");
  eq(d.actionable, 0, "hygiene does not nag as actionable work");
});

suite("digest: unbanked worktree changes are detected", () => {
  try { execFileSync("git", ["--version"], { timeout: 5000 }); } catch { return; }
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "loom-dig-"));
  const repoRoot = path.join(root, "proj");
  fs.mkdirSync(repoRoot);
  const git = (cwd, ...a) => execFileSync("git", ["-C", cwd, ...a], { encoding: "utf8", timeout: 15000 });
  git(repoRoot, "init", "-q", "-b", "main");
  git(repoRoot, "config", "user.email", "t@e.com"); git(repoRoot, "config", "user.name", "T");
  fs.writeFileSync(path.join(repoRoot, "f.txt"), "x"); git(repoRoot, "add", "-A"); git(repoRoot, "commit", "-qm", "i");
  const wt = path.join(repoRoot, ".claude", "worktrees", "w1");
  fs.mkdirSync(path.dirname(wt), { recursive: true });
  git(repoRoot, "worktree", "add", "-q", "-b", "worktree-w1", wt);

  eq(unbankedIn(repoRoot, "w1"), null, "a clean worktree is not unbanked");
  eq(unbankedIn(repoRoot, "nosuchrole"), null, "a missing worktree is not unbanked");
  eq(unbankedIn(null, "w1"), null, "no repo root -> nothing to check");
  fs.writeFileSync(path.join(wt, "wip.txt"), "unbanked");
  ok(unbankedIn(repoRoot, "w1"), "uncommitted work is detected");

  const repo = makeRepo({ roles: { w1: {} } });
  setOrchestrator(repo, "po");
  const d = buildDigest(repo, base({ repoRoot, checkUnbanked: true }));
  eq(d.unbanked.map((x) => x.role), ["w1"], "and surfaced in the digest");
  match(d.unbanked[0].detail, /uncommitted change/, "with a count");
  eq(buildDigest(repo, base({ repoRoot, checkUnbanked: false })).unbanked, [], "skippable via config");
});

suite("digest: an unfiltered window produces nothing", () => {
  eq(buildDigest(null, base()), null, "no repo -> no digest");
});

suite("digest: the render lists every category it found", () => {
  const repo = makeRepo({ roles: { w1: { session_id: "sid-1" } } });
  put(busPath(repo, "w1", "inbox.md"), "h", 5);
  put(busPath(repo, "w1", "outbox.md"), "r", 1);
  writeJson(busPath(repo, "w1", "status.json"), { status: "blocked", current: "H-9" });
  const text = renderDigest(buildDigest(repo, base({
    limited: { w1: { kind: "weekly limit", etaText: "in 2d" } },
    premiumPending: { w1: { model: "Fable 5", attempts: 1 } },
  })));
  for (const expect of [/Responses waiting/, /Blocked on a decision/, /usage limit/, /orchestrator-only model/,
                        /no live session/i, /No orchestrator tagged/]) {
    match(text, expect, "render includes " + expect);
  }
});

suite("digest: stalled roles and protocol problems are actionable", () => {
  const repo = makeRepo({ roles: { stuck: {}, odd: {} } });
  setOrchestrator(repo, "po");
  const old = (T0 - 5 * HOUR) / 1000;
  writeJson(busPath(repo, "stuck", "status.json"), { status: "working", current: "H-1" });
  fs.utimesSync(busPath(repo, "stuck", "status.json"), old, old);
  writeJson(busPath(repo, "odd", "status.json"), { status: "active" });
  const d = buildDigest(repo, base({ stallMinutes: 45 }));
  eq(d.stalled.map((s) => s.role), ["stuck"], "the silent worker");
  eq(d.nonConforming.map((c) => c.role), ["odd"], "the off-protocol status");
  ok(d.actionable >= 2, "both count as work for the user");
  const text = renderDigest(d);
  match(text, /Stalled — working but silent/, "rendered");
  match(text, /Protocol problems/, "and the conformance section");
});

suite("digest: too many roles working at once is called out", () => {
  const repo = makeRepo({ roles: { w: {} } });
  setOrchestrator(repo, "po");
  const { countWorking, publishWorking } = load("health.js");
  // make several roles working across projects, then publish the shared count
  const other = makeRepo({ roles: { a: {}, b: {}, c: {}, d: {}, e: {}, f: {} } }, "busyBus");
  for (const r of ["a", "b", "c", "d", "e", "f"]) writeJson(busPath(other, r, "status.json"), { status: "working" });
  publishWorking(countWorking());
  const d = buildDigest(repo, base({ workingWarnAt: 5 }));
  ok(d.workingNow >= 6, "counted globally: " + d.workingNow);
  match(renderDigest(d), /working simultaneously across all projects/, "warned");
  match(renderDigest(d), /ONE usage pool/, "explaining why it matters");
  const under = buildDigest(repo, base({ workingWarnAt: 99 }));
  ok(!/working simultaneously/.test(renderDigest(under)), "silent under the threshold");
});
