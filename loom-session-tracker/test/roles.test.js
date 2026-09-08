const { suite, ok, eq, load } = require("./harness");
const { classify, detectOwner, OWNER_ROLE_NAME } = load("roles.js");

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
