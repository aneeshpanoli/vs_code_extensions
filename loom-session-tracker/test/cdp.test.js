const { suite, ok, eq, load, home } = require("./harness");
const fs = require("fs");
const path = require("path");
const { readFrames, closeWebview, cdpPort } = load("cdp.js");

// Point the port discovery at a closed port INSIDE the sandbox, so these tests can
// never attach to the real IDE (9333) or a browser-automation Chrome (9222).
const DEAD_PORT = 9;
function pointAtDeadPort() {
  const p = path.join(home, ".config", "VSCodium");
  fs.mkdirSync(p, { recursive: true });
  fs.writeFileSync(path.join(p, "DevToolsActivePort"), DEAD_PORT + "\n/devtools/browser/x\n");
}

suite("cdp: the live port is read from DevToolsActivePort", () => {
  pointAtDeadPort();
  eq(cdpPort(), DEAD_PORT, "reads the IDE's actual debug port, not a hardcoded default");
});

suite("cdp: a dead endpoint yields [] instead of throwing or hanging", async () => {
  pointAtDeadPort();
  const started = Date.now();
  const frames = await readFrames();
  eq(frames, [], "empty result, no exception");
  ok(Date.now() - started < 20000, "returned well inside the hard cap");
});

suite("cdp: closeWebview reports failure rather than throwing when nothing is reachable", async () => {
  pointAtDeadPort();
  const r = await closeWebview("some-webview-id");
  eq(r.ok, false, "not ok");
  ok(typeof r.note === "string" && r.note.length > 0, "explains why: " + r.note);
});
