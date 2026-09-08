const { suite, ok, eq, match, load, home } = require("./harness");
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

// ── the protocol half, driven against a fake DevTools server ────────────────
const { startFakeDevTools } = require("./fake-devtools");
const FAST = { settleMs: 80, hardCapMs: 4000 };
const wv = (id) => `vscode-webview://host/index.html?id=${id}`;

/** Run a body against a fake browser, always shutting it down. */
async function withFake(opts, body) {
  const fake = await startFakeDevTools(opts);
  try { return await body(fake); } finally { await fake.close(); }
}

suite("cdp: reads every attached frame, with its webviewId and text", async () => {
  await withFake({ targets: [
    { sessionId: "s1", url: wv("aaaaaaaa-1111"), text: "first conversation" },
    { sessionId: "s2", url: wv("bbbbbbbb-2222"), text: "second conversation" },
  ] }, async (fake) => {
    const frames = await readFrames("127.0.0.1", fake.port, FAST);
    eq(frames.length, 2, "both targets became frames");
    const byId = Object.fromEntries(frames.map((f) => [f.webviewId, f.text]));
    eq(byId["aaaaaaaa-1111"], "first conversation", "webviewId parsed from the url, text from evaluate");
    eq(byId["bbbbbbbb-2222"], "second conversation", "and the second");
  });
});

suite("cdp: re-arms each child so grandchild OOPIFs attach (the reason this reader exists)", async () => {
  // The grandchild only attaches after ITS PARENT session is armed — exactly the nesting that
  // /json/list cannot see and a single-target reader would miss.
  await withFake({
    targets: [{ sessionId: "parent", url: wv("cccccccc-3333"), text: "shell" }],
    grandchildren: { parent: [{ sessionId: "child", url: wv("dddddddd-4444"), text: "the real conversation" }] },
  }, async (fake) => {
    const frames = await readFrames("127.0.0.1", fake.port, FAST);
    eq(frames.length, 2, "parent AND grandchild were reached");
    ok(frames.some((f) => f.webviewId === "dddddddd-4444" && /real conversation/.test(f.text)),
      "the nested OOPIF's text was read");
  });
});

suite("cdp: the two-pass read keeps the longer text (late-painting frames)", async () => {
  await withFake({ targets: [
    { sessionId: "s1", url: wv("eeeeeeee-5555"), texts: ["short", "a much longer second answer"] },
  ] }, async (fake) => {
    const frames = await readFrames("127.0.0.1", fake.port, FAST);
    eq(frames[0].text, "a much longer second answer", "second pass wins when it has more content");
  });
});

suite("cdp: a target with no id in its url yields a null webviewId", async () => {
  await withFake({ targets: [{ sessionId: "s1", url: "vscode-file://vscode-app/workbench.html", text: "shell" }] },
    async (fake) => {
      const frames = await readFrames("127.0.0.1", fake.port, FAST);
      eq(frames.length, 1, "still reported");
      eq(frames[0].webviewId, null, "but with no webviewId (a window shell, not a session)");
    });
});

suite("cdp: a detached target is dropped", async () => {
  await withFake({
    targets: [{ sessionId: "s1", url: wv("ffffffff-6666"), text: "gone" },
              { sessionId: "s2", url: wv("99999999-7777"), text: "stays" }],
    detachAfterAttach: ["s1"],
  }, async (fake) => {
    const frames = await readFrames("127.0.0.1", fake.port, FAST);
    eq(frames.map((f) => f.webviewId), ["99999999-7777"], "only the still-attached target");
  });
});

suite("cdp: evaluates that never answer still return frames, with empty text", async () => {
  await withFake({ targets: [{ sessionId: "s1", url: wv("aaaa1111-8888"), text: "never delivered" }],
                   dropEvaluate: true }, async (fake) => {
    const frames = await readFrames("127.0.0.1", fake.port, FAST);
    eq(frames.length, 1, "the target is still known from the attach event");
    eq(frames[0].text, "", "text is empty rather than the read hanging or throwing");
  });
});

suite("cdp: a chattering browser cannot outrun the hard cap", async () => {
  // Constant events mean the settle window never elapses; only the wall clock can stop it.
  await withFake({ targets: [{ sessionId: "s1", url: wv("bbbb2222-9999"), text: "noisy" }], chatter: true },
    async (fake) => {
      const started = Date.now();
      const frames = await readFrames("127.0.0.1", fake.port, { settleMs: 80, hardCapMs: 1200 });
      const took = Date.now() - started;
      ok(took < 4000, `bounded by the hard cap, took ${took}ms`);
      ok(Array.isArray(frames), "and still returned a result");
    });
});

suite("cdp: a browser with no debugger url yields no frames", async () => {
  await withFake({ badVersion: true, targets: [{ sessionId: "s1", url: wv("cccc3333-0000") }] }, async (fake) => {
    eq(await readFrames("127.0.0.1", fake.port, FAST), [], "nothing to connect to -> []");
  });
});

suite("cdp: closeWebview finds the target by webviewId and closes it", async () => {
  await withFake({ listTargets: [
    { id: "T-1", url: wv("dddd4444-1111") },
    { id: "T-2", url: wv("eeee5555-2222") },
  ] }, async (fake) => {
    const r = await closeWebview("eeee5555-2222", "127.0.0.1", fake.port);
    ok(r.ok, "reported closed: " + r.note);
    eq(fake.closed, ["T-2"], "closed the right target id, not the other one");
    const miss = await closeWebview("no-such-webview", "127.0.0.1", fake.port);
    eq(miss.ok, false, "an unknown webviewId is refused");
    match(miss.note, /no live target/, "explaining why");
    eq(fake.closed, ["T-2"], "and nothing further was closed");
  });
});
