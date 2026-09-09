const { suite, ok, eq, load, makeRepo, busPath, readJson } = require("./harness");
const fs = require("fs");
const { getOrchestrator, setOrchestrator, setOrchestratorFrame, ORCHESTRATOR_CANDIDATES } =
  load("orchestrator.js");

suite("orchestrator: candidates always include the PO names", () => {
  // These must be offered independently of any board roster — that was the bug that
  // made tagging unreachable (a board never lists product-owner).
  ok(ORCHESTRATOR_CANDIDATES.includes("product-owner"), "product-owner offered");
  ok(ORCHESTRATOR_CANDIDATES.includes("productowner"), "productowner offered");
});

suite("orchestrator: tag persists to the bus and reads back", () => {
  const repo = makeRepo({ roles: { w: {} } });
  eq(getOrchestrator(repo), null, "untagged initially");
  setOrchestrator(repo, "product-owner");
  eq(getOrchestrator(repo).role, "product-owner", "reads back");
  ok(readJson(busPath(repo, "orchestrator.json")).taggedAt, "records taggedAt");
});

suite("orchestrator: tag lives on the BUS so it survives a restart", () => {
  const repo = makeRepo({ roles: { w: {} } });
  setOrchestrator(repo, "product-owner");
  // A restart = fresh module state; the file is the only carrier.
  delete require.cache[require.resolve("../out/orchestrator.js")];
  const fresh = require("../out/orchestrator.js");
  eq(fresh.getOrchestrator(repo).role, "product-owner", "survives module reload");
});

suite("orchestrator: untag removes the file", () => {
  const repo = makeRepo({ roles: { w: {} } });
  setOrchestrator(repo, "product-owner");
  setOrchestrator(repo, null);
  eq(getOrchestrator(repo), null, "untagged");
  eq(fs.existsSync(busPath(repo, "orchestrator.json")), false, "file removed");
  setOrchestrator(repo, null);   // idempotent, must not throw
});

suite("orchestrator: bad input never throws", () => {
  eq(getOrchestrator(null), null, "null repo");
  eq(getOrchestrator("no-such-repo-anywhere"), null, "missing bus");
  const repo = makeRepo({ roles: {} });
  fs.writeFileSync(busPath(repo, "orchestrator.json"), "{{{ not json");
  eq(getOrchestrator(repo), null, "corrupt file treated as untagged");
});

suite("orchestrator: the tag carries the FRAME, which is the only way to inject into it", () => {
  // loom_cdp.py's find_role drops owner-detected frames, so a role name cannot reach the
  // orchestrator; the webviewId recorded here is what every injection to it addresses.
  const repo = makeRepo({ roles: { w: {} } });
  setOrchestrator(repo, "product-owner", "wid-abc");
  eq(getOrchestrator(repo).webviewId, "wid-abc", "frame recorded at tag time");
  setOrchestrator(repo, "product-owner");
  eq(getOrchestrator(repo).webviewId, null, "tagging without one records null, not undefined");
});

suite("orchestrator: the frame is refreshed when it moves, and the tag is otherwise untouched", () => {
  // Frame ids change when a window reloads; the tag must follow without being re-made.
  const repo = makeRepo({ roles: { w: {} } });
  setOrchestrator(repo, "product-owner", "wid-old");
  const taggedAt = getOrchestrator(repo).taggedAt;
  setOrchestratorFrame(repo, "wid-new");
  eq(getOrchestrator(repo).webviewId, "wid-new", "followed the frame");
  eq(getOrchestrator(repo).role, "product-owner", "role unchanged");
  eq(getOrchestrator(repo).taggedAt, taggedAt, "and the tag time is not rewritten");
});

suite("orchestrator: a frame refresh with nothing to say writes nothing", () => {
  const repo = makeRepo({ roles: { w: {} } });
  setOrchestratorFrame(repo, "wid-x");                       // untagged: no file to create
  eq(getOrchestrator(repo), null, "still untagged");
  setOrchestrator(repo, "product-owner", "wid-same");
  const before = fs.statSync(busPath(repo, "orchestrator.json")).mtimeMs;
  setOrchestratorFrame(repo, "wid-same");                    // identical: no churn
  setOrchestratorFrame(repo, null);                          // nothing to record
  eq(fs.statSync(busPath(repo, "orchestrator.json")).mtimeMs, before, "file untouched");
});
