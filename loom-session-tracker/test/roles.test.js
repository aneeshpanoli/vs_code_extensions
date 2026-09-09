const { suite, ok, eq, load } = require("./harness");
const { classify, detectOwner, attributeRepo, OWNER_ROLE_NAME } = load("roles.js");

const ROLES = new Set(["gamification", "curriculum", "art", "product-owner"]);
const marker = (r) => "\nLOOMROLE=" + r + "\n";

suite("roles: a clean single sign-off identifies the session", () => {
  const c = classify("did some work" + marker("gamification"), ROLES);
  eq(c.role, "gamification", "role from marker");
  eq(c.purity, 1, "purity 1 for a clean marker");
});

suite("roles: markers not in the roster are ignored", () => {
  eq(classify("x" + marker("notarole"), ROLES).role, null, "unknown role rejected");
});

suite("roles: the ORCHESTRATOR is never a tracked agent", () => {
  // Even signing itself, the PO must not become an agent (retire/delete safety).
  eq(classify("orchestrating" + marker("product-owner"), ROLES).role, null, "owner marker -> null");
  eq(classify("see worktrees/product-owner/x worktrees/product-owner/y", ROLES).role, null,
    "dominant owner worktree -> null");
});

suite("roles: a single dominant worktree path identifies a working session", () => {
  const t = "edited worktrees/curriculum/a.py and worktrees/curriculum/b.py";
  eq(classify(t, ROLES).role, "curriculum", "sole worktree wins");
});

suite("roles: QUOTED foreign markers do not blind a working session (2026-07-11 fix)", () => {
  // A session that quoted two other roles' sign-offs still resolves via its own worktree.
  const t = "handoff quote:" + marker("art") + "and" + marker("gamification") +
            "worktrees/curriculum/x worktrees/curriculum/y worktrees/curriculum/z";
  eq(classify(t, ROLES).role, "curriculum", "resolves by dominant worktree despite mixed markers");
});

suite("roles: ambiguous on BOTH signals is excluded (viewer/orchestrator)", () => {
  const t = "worktrees/art/a worktrees/curriculum/b worktrees/gamification/c";
  eq(classify(t, ROLES).role, null, "no dominant path, no clean marker -> null");
});

suite("roles: purity threshold governs a mixed worktree frame", () => {
  const dominant = "worktrees/art/a ".repeat(8) + "worktrees/curriculum/b ".repeat(2);   // 0.8
  eq(classify(dominant, ROLES).role, "art", "0.8 purity passes");
  const muddy = "worktrees/art/a ".repeat(6) + "worktrees/curriculum/b ".repeat(4);      // 0.6
  eq(classify(muddy, ROLES).role, null, "0.6 purity fails");
});

suite("roles: empty/garbage input never throws", () => {
  for (const t of ["", null, undefined, "  ", "LOOMROLE="]) {
    eq(classify(t, ROLES).role, null, "safe on " + JSON.stringify(t));
    eq(detectOwner(t), false, "detectOwner safe on " + JSON.stringify(t));
  }
});

suite("roles: detectOwner finds the PO so it can be tagged", () => {
  ok(detectOwner("orchestrating" + marker("product-owner")), "self-signed PO");
  ok(detectOwner(marker("art") + marker("curriculum") + marker("gamification")),
    "quoting 3 distinct roles = orchestrator/viewer");
  eq(detectOwner("working" + marker("art")), false, "a worker signing only itself is NOT an owner");
  eq(detectOwner(marker("art") + marker("curriculum")), false, "2 distinct roles is not enough");
  eq(OWNER_ROLE_NAME, "product-owner", "canonical name the notifier injects to");
});

suite("roles: detectOwner ignores markers that are not standalone lines", () => {
  // A doc that mentions the marker mid-sentence must not create a phantom orchestrator.
  eq(detectOwner("the line LOOMROLE=art appears inline, as does LOOMROLE=curriculum and LOOMROLE=music here"),
    false, "inline mentions ignored");
});

suite("roles: role names are matched lowercase (boards must use lowercase ids)", () => {
  // Markers are lowercased before the roster lookup, so a board role with capitals
  // could never be detected. Every real board uses lowercase; this pins the constraint.
  eq(classify("x\nLOOMROLE=Gamification\n", ROLES).role, "gamification", "marker case is normalised");
  eq(classify("x\nLOOMROLE=alpha\n", new Set(["Alpha"])).role, null, "a capitalised ROSTER id never matches");
});

// ── which project an orchestrator frame belongs to ──────────────────────────
const REPOS = ["Gaming", "livegita", "funisland", "shwab_docker"];

suite("repo: an orchestrator frame is attributed by its own bus paths", () => {
  // Measured live 2026-09-09: the PO frames scored Gaming:76, livegita:115, funisland:36,
  // shwab_docker:24 — a session cannot work on a project without naming its paths.
  const t = "read ~/.claude/loom/Gaming/developer/outbox.md then Containers/Gaming/src and " +
            "~/.claude/loom/Gaming/board.json";
  eq(attributeRepo(t, REPOS).repo, "Gaming", "dominant project wins");
});

suite("repo: a frame that names no project is attributed to none", () => {
  // This is the safe direction: an unattributable frame is never adopted as anyone's orchestrator.
  eq(attributeRepo("just a chat about keto and lifting", REPOS).repo, null, "no paths, no claim");
  eq(attributeRepo("", REPOS).repo, null, "empty text");
  eq(attributeRepo("loom/not-a-project/x", REPOS).repo, null, "unknown project name");
});

suite("repo: a frame torn between two projects is attributed to neither", () => {
  const t = "loom/Gaming/a loom/Gaming/b loom/funisland/c loom/funisland/d loom/funisland/e";
  const r = attributeRepo(t, REPOS);
  eq(r.repo, null, "no clear owner -> no adoption");
  ok(r.purity < 0.8, "and the purity says why: " + r.purity.toFixed(2));
});

suite("repo: this is what stops one PO frame being every project's orchestrator", () => {
  // The live bug: a8faad83 was tagged as orchestrator of BOTH Gaming and livegita while mentioning
  // only shwab_docker. Attribution gives each window a way to refuse it.
  const shwab = "TR-027 ruling; see ~/.claude/loom/shwab_docker/trader/inbox.md and " +
                "~/.claude/loom/shwab_docker/board.json";
  eq(attributeRepo(shwab, REPOS).repo, "shwab_docker", "belongs to shwab_docker");
  ok(attributeRepo(shwab, REPOS).repo !== "Gaming", "and therefore not to Gaming");
});
