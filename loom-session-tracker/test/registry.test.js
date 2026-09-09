const { suite, ok, eq, load, makeRepo, busPath, writeJson, readJson, setStatus } = require("./harness");
const fs = require("fs");
const { boardRoles, roleToRepo, writeTargetmaps, loadBindings, loadTargetmap, busRepos } = load("registry.js");

suite("registry: reads a NESTED board roster", () => {
  const repo = makeRepo({ roles: { alpha: {}, beta: {} }, note: "ignored" });
  eq(boardRoles(repo).sort(), ["alpha", "beta"], "roles from the roles{} wrapper");
});

suite("registry: reads a FLAT board and filters metadata keys", () => {
  // A flat board mixes roles with metadata; only the metadata must be dropped.
  const repo = makeRepo({ repo: "x", bus: "y", orchestrator: "po", decisions: [], alpha: {}, beta: {} });
  eq(boardRoles(repo).sort(), ["alpha", "beta"], "metadata keys excluded");
});

suite("registry: flat-board metadata is excluded by SHAPE, not by a name denylist", () => {
  // funisland's real board, reduced: prose keys plus `lanes`, an object that is not a role entry.
  // The old name-denylist let all of these through as roles.
  const repo = makeRepo({
    _comment: "PO dispatch queue", updated: "2026-08-31", standing_order: "Do not idle",
    priority_rule: "TRIAGE FIRST", standing_laws_for_every_item: ["measure the kid"],
    free_now: "gamification — stood down",
    lanes: { curriculum: [], gamification: [], UNOWNED: [] },
    gamification: { session_id: "s1", branch: "b", status: "working", bound_at: "t" },
  });
  eq(boardRoles(repo), ["gamification"], "only the role-shaped entry survives");
});

suite("registry: a role with a mailbox is on the roster even if the board forgot it", () => {
  // Measured 2026-09-08: funisland's board listed 3 of its 11 roles, gaming's omitted `gameplay`
  // and livegita's omitted `developer` — all of them with full mailboxes on the bus. A dropped role
  // is invisible to the tracker AND makes its worktree look orphaned, so the bus wins.
  const repo = makeRepo({ declared: { session_id: "s1" } });
  setStatus(repo, "forgotten", { status: "working" });
  fs.mkdirSync(busPath(repo, "hasinbox"), { recursive: true });
  fs.writeFileSync(busPath(repo, "hasinbox", "inbox.md"), "hi");
  eq(boardRoles(repo), ["declared", "forgotten", "hasinbox"], "board roster UNION mailbox roles");
});

suite("registry: a bus directory with no mailbox is not a role", () => {
  // funisland/.pytest_cache and funisland/audit both live on the bus and are not roles.
  const repo = makeRepo({ declared: { session_id: "s1" } });
  fs.mkdirSync(busPath(repo, "audit"), { recursive: true });
  fs.writeFileSync(busPath(repo, "audit", "notes.md"), "not a mailbox");
  fs.mkdirSync(busPath(repo, ".pytest_cache"), { recursive: true });
  fs.writeFileSync(busPath(repo, ".pytest_cache", "status.json"), "{}");
  eq(boardRoles(repo), ["declared"], "no mailbox (or a dotted name) -> not a role");
});

suite("registry: a nested roster is NOT metadata-filtered", () => {
  // Inside roles{} every key is a role by construction, even one named like metadata.
  const repo = makeRepo({ roles: { decisions: {}, alpha: {} } });
  eq(boardRoles(repo).sort(), ["alpha", "decisions"], "no filtering inside roles{}");
});

suite("registry: missing/corrupt board yields no roles, never throws", () => {
  eq(boardRoles("does-not-exist"), [], "missing bus");
  const repo = makeRepo(null);
  fs.writeFileSync(busPath(repo, "board.json"), "}{ broken");
  eq(boardRoles(repo), [], "corrupt board");
});

suite("registry: roleToRepo maps every role to its owning project", () => {
  const r1 = makeRepo({ roles: { solo1: {} } });
  const r2 = makeRepo({ roles: { solo2: {} } });
  const map = roleToRepo();
  eq(map.get("solo1"), r1, "role -> its repo");
  eq(map.get("solo2"), r2, "second repo too");
});

suite("registry: busRepos lists only project buses with a board", () => {
  const withBoard = makeRepo({ roles: { a: {} } });
  const noBoard = makeRepo(null);
  const repos = busRepos();
  ok(repos.includes(withBoard), "bus with board listed");
  ok(!repos.includes(noBoard), "bus without board excluded");
});

suite("registry: writeTargetmaps persists the role<->webviewId map", () => {
  const repo = makeRepo({ roles: { a: {} } });
  const changed = writeTargetmaps([{ role: "a", repo, webviewId: "wid-1", lastSeen: Date.now() }]);
  eq(changed, [repo], "reports the repo it wrote");
  eq(readJson(busPath(repo, "targetmap.json")), { "wid-1": "a" }, "map written");
  eq(loadTargetmap(repo).get("wid-1"), "a", "and reads back");
});

suite("registry: writeTargetmaps is change-only (no churn every tick)", () => {
  const repo = makeRepo({ roles: { a: {} } });
  const agents = [{ role: "a", repo, webviewId: "wid-1", lastSeen: Date.now() }];
  eq(writeTargetmaps(agents), [repo], "first write happens");
  eq(writeTargetmaps(agents), [], "identical second write is skipped");
});

suite("registry: a bad read can never blank a good targetmap", () => {
  // The fail-proof rule: an empty agent list must leave the last-known-good map alone.
  const repo = makeRepo({ roles: { a: {} } });
  writeTargetmaps([{ role: "a", repo, webviewId: "wid-1", lastSeen: Date.now() }]);
  eq(writeTargetmaps([]), [], "empty input writes nothing");
  eq(readJson(busPath(repo, "targetmap.json")), { "wid-1": "a" }, "previous map intact");
});

suite("registry: loadBindings reads the /loom self-bindings the extension never writes", () => {
  const repo = makeRepo({ roles: { a: {} } });
  writeJson(busPath(repo, "bindings.json"), { "wid-9": "a" });
  eq(loadBindings(repo).get("wid-9"), "a", "binding read");
  eq(loadBindings("missing-repo").size, 0, "missing file -> empty, no throw");
});
