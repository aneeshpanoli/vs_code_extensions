// _leak-fixture.js — FX-002. NOT a `.test.js`, so the runner never auto-discovers it; it is run
// explicitly via `run-tests.js --file _leak-fixture.js` by the leak test in fixtures.test.js.
//
// Its whole job is to FAIL while holding a fixture directory. The leak that mattered was on the
// failing path, and a mutant that made the runner's sweep conditional on success survived a suite
// whose own "throwing" test only called sweepFixtures() by hand — testing the helper, not the wiring.
// This file makes the real runner take the real failing path.
const { suite, fixtureDir } = require("./harness");

suite("leak fixture: registers a fixture directory and then throws", () => {
  fixtureDir("loom-leakprobe-");
  throw new Error("deliberate failure — the runner must sweep anyway");
});
