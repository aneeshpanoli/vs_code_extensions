const { suite, ok, eq, load, makeRepo, busPath, readJson } = require("./harness");
const fs = require("fs");
const { getOrchestrator, setOrchestrator, ORCHESTRATOR_CANDIDATES } = load("orchestrator.js");

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
