const { suite, ok, eq, load, makeRepo, busPath } = require("./harness");
const fs = require("fs");
const { listLocks, isLocked, setLock } = load("locks.js");

suite("locks: default is unlocked", () => {
  const repo = makeRepo({ roles: { a: {} } });
  eq(isLocked(repo, "a"), false, "no lock file -> unlocked");
  eq(listLocks(repo).size, 0, "empty set");
});

suite("locks: lock/unlock round-trips and persists", () => {
  const repo = makeRepo({ roles: { a: {}, b: {} } });
  ok(setLock(repo, "a", true), "setLock returns true");
  ok(isLocked(repo, "a"), "a locked");
  eq(isLocked(repo, "b"), false, "b untouched");
  ok(fs.existsSync(busPath(repo, "session-locks.json")), "persisted to bus");
  setLock(repo, "b", true);
  eq(Array.from(listLocks(repo)).sort(), ["a", "b"], "both locked");
  setLock(repo, "a", false);
  eq(Array.from(listLocks(repo)), ["b"], "a unlocked, b kept");
});

suite("locks: corrupt lock file degrades to unlocked, never throws", () => {
  const repo = makeRepo({ roles: { a: {} } });
  fs.writeFileSync(busPath(repo, "session-locks.json"), "not json at all");
  eq(isLocked(repo, "a"), false, "corrupt -> unlocked");
  ok(setLock(repo, "a", true), "and can be rewritten");
  ok(isLocked(repo, "a"), "recovered");
});
