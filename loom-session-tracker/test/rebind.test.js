// rebind.test.js — RB-001: the CLAUDE SESSION ID is the address, the webviewId is a cache.
//
// The failure these pin: an IDE restart mints a new webviewId for every panel, so `bindings.json`,
// `board.json`, `<role>.id` and `orchestrator.json` all hold DEAD ids until a human re-binds by hand.
// Session ids survive restarts, so a frame carrying a role's session id IS that role, and the bus
// records are rewritten to point at it. The counterweight, tested just as hard: a tracker that
// cannot read a session id must change NOTHING, and content must never rewrite anything.

const { suite, ok, eq, load, makeRepo, busPath, writeJson, readJson, home } = require("./harness");
const fs = require("fs");
const path = require("path");

const { sessionIdFromUrl, parseRead, readFrames } = load("cdp.js");
const { sessionOwners, rebindFrame, busWebviewFor, roleWorktree } = load("rebind.js");
const { frameWatcher } = load("newframe.js");
const { Tracker } = load("tracker.js");
const cdp = load("cdp.js");

const SID_A = "aaaaaaaa-1111-2222-3333-444444444444";
const SID_B = "bbbbbbbb-1111-2222-3333-444444444444";
const SID_C = "cccccccc-1111-2222-3333-444444444444";

function withFrames(frames, fn) {
  const real = cdp.readFrames;
  cdp.readFrames = async () => frames;
  return Promise.resolve(fn()).finally(() => { cdp.readFrames = real; });
}
/** A frame as cdp.readFrames now yields one. */
const frame = (webviewId, text, claudeSessionId = null) =>
  ({ webviewId, text, claudeSessionId, contextPct: null, windowRoot: null, windowKnown: false,
     url: `vscode-webview://host/index.html?id=${webviewId}` });
const marker = (r) => "\nLOOMROLE=" + r + "\n";

// ── R1: reading the id ──────────────────────────────────────────────────────

suite("R1: the session id is read off the frame URL, and only a real one counts", () => {
  const live = "vscode-webview://h/index.html?id=789cb69a-78c0-434b-b13e-17bcb2f105d5&parentId=3" +
               "&session=644021d8-99ee-40a6-94f1-ec3213d8e86c&swVersion=5";
  eq(sessionIdFromUrl(live), "644021d8-99ee-40a6-94f1-ec3213d8e86c", "the real shape, measured live");
  // The SIDEBAR: same host, same `id=`, no conversation and so no session. Measured 2026-09-13 as
  // frame 1a5824c4, and it must not be made to answer something.
  eq(sessionIdFromUrl("vscode-webview://h/index.html?id=1a5824c4-5bd7-48c8-b270-316981782839" +
                      "&purpose=webviewView"), null, "the sidebar view has none");
  eq(sessionIdFromUrl(`?id=${SID_A}`), null, "the webviewId is NOT mistaken for the session id");
  eq(sessionIdFromUrl("?session=644021d8"), null, "a truncated id is not an id");
  eq(sessionIdFromUrl("?session=zzzzzzzz-99ee-40a6-94f1-ec3213d8e86c"), null, "non-hex is not an id");
  eq(sessionIdFromUrl("?xsession=644021d8-99ee-40a6-94f1-ec3213d8e86c"), null,
     "`session=` must be a whole parameter, not a suffix of one");
  eq(sessionIdFromUrl("?session=644021D8-99EE-40A6-94F1-EC3213D8E86C"), "644021d8-99ee-40a6-94f1-ec3213d8e86c",
     "normalised to lower case, so it compares equal to a board entry");
  eq(sessionIdFromUrl(null), null, "no url");
  eq(sessionIdFromUrl(""), null, "empty url");
});

suite("R1: the read envelope carries the session id, and refuses a malformed one", () => {
  eq(parseRead(`{"t":"hi","c":42,"s":"${SID_A}"}`).sessionId, SID_A, "a well-formed id");
  eq(parseRead('{"t":"hi","c":42,"s":"nonsense"}').sessionId, null, "junk is not an id");
  eq(parseRead('{"t":"hi","c":42,"s":null}').sessionId, null, "explicitly absent");
  eq(parseRead('{"t":"hi","c":42}').sessionId, null, "an envelope from an older read");
  eq(parseRead("bare text").sessionId, null, "a bare string answer");
});

// ── R1, over the protocol ───────────────────────────────────────────────────
const { startFakeDevTools } = require("./fake-devtools");
const FAST = { settleMs: 80, hardCapMs: 4000 };
const wv = (id) => `vscode-webview://host/index.html?id=${id}`;

async function withFake(opts, body) {
  const srv = await startFakeDevTools(opts);
  try { return await body(srv); } finally { await srv.close(); }
}

suite("R1: readFrames reports each panel's session id, or null when it cannot answer", async () => {
  await withFake({ targets: [
    { sessionId: "s1", url: wv("a1d00001-0000-4000-8000-000000000000"), text: "alpha", session: SID_A },
    { sessionId: "s2", url: wv("a1d00002-0000-4000-8000-000000000000"), text: "sidebar", session: null },
    { sessionId: "s3", url: wv("a1d00003-0000-4000-8000-000000000000"), text: "no envelope at all" },
  ] }, async (srv) => {
    const frames = await readFrames("127.0.0.1", srv.port, FAST);
    const by = (w) => frames.find((f) => f.webviewId === w);
    eq(by("a1d00001-0000-4000-8000-000000000000").claudeSessionId, SID_A, "read from the inner frame");
    eq(by("a1d00002-0000-4000-8000-000000000000").claudeSessionId, null, "a frame with no session says so");
    eq(by("a1d00003-0000-4000-8000-000000000000").claudeSessionId, null, "a bare-string answer yields null, never a guess");
  });
});

suite("R1: a session id seen on EITHER pass survives, like the percentage", async () => {
  await withFake({ targets: [
    // first pass mid-navigation (no id), second pass settled
    { sessionId: "s1", url: wv("a1d00001-0000-4000-8000-000000000000"), texts: ["short", "much longer text"], sessions: [null, SID_A] },
    // and the other way round: the longer text arrives second but carries no id
    { sessionId: "s2", url: wv("a1d00002-0000-4000-8000-000000000000"), texts: ["short", "much longer text"], sessions: [SID_B, null] },
  ] }, async (srv) => {
    const frames = await readFrames("127.0.0.1", srv.port, FAST);
    eq(frames.find((f) => f.webviewId === "a1d00001-0000-4000-8000-000000000000").claudeSessionId, SID_A, "late id kept");
    eq(frames.find((f) => f.webviewId === "a1d00002-0000-4000-8000-000000000000").claudeSessionId, SID_B, "early id not lost");
  });
});

suite("R1: an id that arrives on the SHORTER pass is kept too", async () => {
  // The case the two above do NOT reach, and the one the merge's second branch exists for: the
  // longest text arrives FIRST, so the later read never replaces the entry wholesale — and the
  // session id it carries has to be folded into the entry that is already there. A mutation run
  // found this line untested (2026-09-13): both earlier fixtures happen to take the first branch,
  // where the id rides along with the longer text.
  await withFake({ targets: [
    { sessionId: "s1", url: wv("a1d00001-0000-4000-8000-000000000000"),
      texts: ["the full transcript, rendered", "short"], sessions: [null, SID_C] },
  ] }, async (srv) => {
    const frames = await readFrames("127.0.0.1", srv.port, FAST);
    eq(frames[0].text, "the full transcript, rendered", "the longest text still wins");
    eq(frames[0].claudeSessionId, SID_C, "and the id from the shorter pass is not thrown away");
  });
});

suite("R1: a frame attached as its own inner document is read from its target URL", async () => {
  await withFake({ targets: [
    { sessionId: "s1", url: wv("a1d00001-0000-4000-8000-000000000000") + `&session=${SID_C}`, text: "no envelope" },
  ] }, async (srv) => {
    const frames = await readFrames("127.0.0.1", srv.port, FAST);
    eq(frames[0].claudeSessionId, SID_C, "the target's own URL is the fallback");
  });
});

// ── R2/R3: the acceptance case ──────────────────────────────────────────────

/** Seed a bus that records role `r` at a webviewId that no longer exists. */
function staleBus(role, sid, deadWid, extra = {}) {
  const repo = makeRepo({ roles: { [role]: { session_id: sid, webviewId: deadWid, ...extra } } });
  writeJson(busPath(repo, "bindings.json"), { [deadWid]: role });
  fs.writeFileSync(busPath(repo, `${role}.id`), deadWid + "\n");
  return repo;
}

suite("R2/R3 ACCEPTANCE: the bus says X, the session says Y, X is gone — one tick and the bus says Y", async () => {
  const repo = staleBus("alpha", SID_A, "dead0000-0000-4000-8000-000000000000");
  const t = new Tracker(repo);
  // The only live frame is a DIFFERENT webviewId, and its text says nothing about any role.
  await withFrames([frame("11ee9999-0000-4000-8000-000000000000", "a panel with no identifying text at all", SID_A)], async () => {
    const r = await t.tick();
    ok(r.ok, "tick ok");
    eq(r.liveRoles, ["alpha"], "the role is found by its session id alone");
    eq(t.view()[0].webviewId, "11ee9999-0000-4000-8000-000000000000", "and points at the live frame");
    eq(r.rebinds.length, 1, "one rewrite, reported for the debug log");
    eq(r.rebinds[0].from.idfile, "dead0000-0000-4000-8000-000000000000", "old id recorded");
    eq(r.rebinds[0].to, "11ee9999-0000-4000-8000-000000000000", "new id recorded");
  });
  eq(readJson(busPath(repo, "bindings.json")), { "11ee9999-0000-4000-8000-000000000000": "alpha" },
     "bindings.json now points at the live frame, and the dead entry is GONE");
  eq(readJson(busPath(repo, "board.json")).roles.alpha.webviewId, "11ee9999-0000-4000-8000-000000000000", "board.json too");
  eq(fs.readFileSync(busPath(repo, "alpha.id"), "utf8").split("\n")[0], "11ee9999-0000-4000-8000-000000000000", "and the id file");
});

suite("R2: a session id that CANNOT be read rewrites nothing", async () => {
  const repo = staleBus("alpha", SID_A, "dead0000-0000-4000-8000-000000000000");
  const t = new Tracker(repo);
  await withFrames([frame("11ee9999-0000-4000-8000-000000000000", "a panel with no identifying text at all", null)], async () => {
    const r = await t.tick();
    eq(r.rebinds, [], "no rewrite");
  });
  eq(readJson(busPath(repo, "bindings.json")), { "dead0000-0000-4000-8000-000000000000": "alpha" }, "bindings.json untouched");
  eq(readJson(busPath(repo, "board.json")).roles.alpha.webviewId, "dead0000-0000-4000-8000-000000000000", "board untouched");
  eq(fs.readFileSync(busPath(repo, "alpha.id"), "utf8"), "dead0000-0000-4000-8000-000000000000\n", "id file untouched");
});

suite("R2: CONTENT never rewrites a binding, however loudly a frame signs itself", async () => {
  const repo = staleBus("alpha", SID_A, "dead0000-0000-4000-8000-000000000000");
  const t = new Tracker(repo);
  // The frame signs LOOMROLE=alpha — the strongest content signal there is — but carries no session id.
  await withFrames([frame("11ee9999-0000-4000-8000-000000000000", "working" + marker("alpha"), null)], async () => {
    const r = await t.tick();
    eq(r.liveRoles, ["alpha"], "content still IDENTIFIES it (that is unchanged)");
    eq(r.rebinds, [], "but it does not get to rewrite the bus");
  });
  eq(readJson(busPath(repo, "bindings.json")), { "dead0000-0000-4000-8000-000000000000": "alpha" },
     "the /loom binding is still the durable one — the tracker's licence is session ids only");
});

suite("R3: nothing changed means nothing is written (a 15-second tick must not churn)", async () => {
  const repo = staleBus("alpha", SID_A, "dead0000-0000-4000-8000-000000000000");
  const t = new Tracker(repo);
  const f = [frame("11ee9999-0000-4000-8000-000000000000", "quiet", SID_A)];
  await withFrames(f, () => t.tick());                       // first tick: heals
  const stamp = fs.statSync(busPath(repo, "bindings.json")).mtimeMs;
  const second = await withFrames(f, () => t.tick());        // second tick: nothing to do
  eq(second.rebinds, [], "no rewrite reported");
  eq(fs.statSync(busPath(repo, "bindings.json")).mtimeMs, stamp, "and the file was not touched");
});

suite("R2: two roles claiming ONE session id is an ambiguity, and ambiguity refuses", async () => {
  const repo = makeRepo({ roles: { alpha: { session_id: SID_A }, beta: { session_id: SID_A } } });
  eq(sessionOwners(repo).get(SID_A), undefined, "nobody owns a contested id");
  const t = new Tracker(repo);
  await withFrames([frame("11ee9999-0000-4000-8000-000000000000", "no identifying text", SID_A)], async () => {
    const r = await t.tick();
    eq(r.liveRoles, [], "neither role is adopted");
    eq(r.rebinds, [], "and nothing is written");
  });
});

suite("R2: another project's session id is not this project's role", async () => {
  const mine = makeRepo({ roles: { alpha: { session_id: SID_A } } });
  makeRepo({ roles: { alpha: { session_id: SID_B } } });     // a different bus entirely
  const t = new Tracker(mine);
  await withFrames([frame("11ee9999-0000-4000-8000-000000000000", "no identifying text", SID_B)], async () => {
    const r = await t.tick();
    eq(r.liveRoles, [], "not adopted: sessionOwners only ever reads THIS project's board");
    eq(r.rebinds, [], "and nothing written");
  });
});

suite("R2: a session id BEATS a bus declaration that names a different, still-live frame", async () => {
  const repo = staleBus("alpha", SID_A, "07e11111-0000-4000-8000-000000000000");
  const t = new Tracker(repo);
  // Both frames are live. The declared one is a bystander; the session id names the real worker.
  await withFrames([frame("07e11111-0000-4000-8000-000000000000", "a bystander that the bus still names"),
                    frame("4ea12222-0000-4000-8000-000000000000", "the actual worker", SID_A)], async () => {
    const r = await t.tick();
    eq(t.view()[0].webviewId, "4ea12222-0000-4000-8000-000000000000", "the session id wins — the declaration is a cache");
  });
  eq(readJson(busPath(repo, "bindings.json")), { "4ea12222-0000-4000-8000-000000000000": "alpha" }, "and the cache is corrected");
});

// ── R2: the transcript fallback, for a board session_id that has gone stale ──

/** Write `sid.jsonl` into the transcript directory Claude Code would use for `cwd`. */
function seedTranscript(cwd, sid) {
  const dir = path.join(home, ".claude", "projects", cwd.replace(/[\/.]/g, "-"));
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, sid + ".jsonl"), "{}\n");
}

suite("R2: when the board's session_id is stale, the role's own worktree transcripts answer", async () => {
  const wt = path.join(home, "proj", ".claude", "worktrees", "alpha");
  const repo = staleBus("alpha", SID_A, "dead0000-0000-4000-8000-000000000000", { worktree: wt });
  seedTranscript(wt, SID_B);                                  // the role was /cleared into SID_B
  eq(sessionOwners(repo).get(SID_B), { role: "alpha", source: "transcript" }, "claimed from the worktree");
  const t = new Tracker(repo);
  await withFrames([frame("11ee9999-0000-4000-8000-000000000000", "no identifying text", SID_B)], async () => {
    const r = await t.tick();
    eq(r.liveRoles, ["alpha"], "found even though the board still names the old session");
  });
  eq(fs.readFileSync(busPath(repo, "alpha.id"), "utf8").split("\n")[0], "11ee9999-0000-4000-8000-000000000000", "and the bus is healed");
});

suite("R2: a transcript belonging to ANOTHER role's worktree is not this role's", () => {
  const wtA = path.join(home, "proj2", ".claude", "worktrees", "alpha");
  const wtB = path.join(home, "proj2", ".claude", "worktrees", "beta");
  const repo = makeRepo({ roles: { alpha: { worktree: wtA }, beta: { worktree: wtB } } });
  seedTranscript(wtB, SID_C);
  eq(sessionOwners(repo).get(SID_C), { role: "beta", source: "transcript" }, "beta's worktree, beta's session");
});

suite("R2: a board statement outranks a directory listing for the same id", () => {
  const wt = path.join(home, "proj3", ".claude", "worktrees", "beta");
  const repo = makeRepo({ roles: { alpha: { session_id: SID_A }, beta: { worktree: wt } } });
  seedTranscript(wt, SID_A);   // alpha's board session also happens to sit in beta's worktree
  eq(sessionOwners(repo).get(SID_A), { role: "alpha", source: "board" },
     "the board is a statement; a directory listing is an inference");
});

suite("R2: roleWorktree falls back to the Loom's own convention when the board records none", () => {
  const repo = makeRepo({ roles: { alpha: {} } });
  eq(roleWorktree(repo, "alpha", "/home/x/myrepo"), "/home/x/myrepo/.claude/worktrees/alpha",
     "a repo-root window");
  eq(roleWorktree(repo, "alpha", "/home/x/myrepo/.claude/worktrees/beta"),
     "/home/x/myrepo/.claude/worktrees/alpha",
     "and a WORKTREE window resolves back to the repo root first — otherwise a worktree window " +
     "would look for worktrees inside a worktree and find nothing");
  eq(roleWorktree(repo, "alpha", null), null, "no window, no convention to apply");
});

// ── R3: the writer's details ────────────────────────────────────────────────

suite("R3: an id file's guard survives when it still holds, and goes when it cannot", () => {
  const repo = makeRepo({ roles: { alpha: {} } });
  const idf = busPath(repo, "alpha.id");

  fs.writeFileSync(idf, "01d00000-0000-4000-8000-000000000000\nLOOMROLE=alpha\n");
  rebindFrame(repo, "alpha", "9e001111-0000-4000-8000-000000000000", "…transcript containing LOOMROLE=alpha…", false);
  eq(fs.readFileSync(idf, "utf8"), "9e001111-0000-4000-8000-000000000000\nLOOMROLE=alpha\n", "guard present on an idle frame: kept");

  fs.writeFileSync(idf, "01d00000-0000-4000-8000-000000000000\nLOOMROLE=alpha\n");
  rebindFrame(repo, "alpha", "9e002222-0000-4000-8000-000000000000", "a frame that says nothing of the sort", false);
  eq(fs.readFileSync(idf, "utf8"), "9e002222-0000-4000-8000-000000000000\n", "absent from an IDLE frame: the guard is wrong, dropped");

  fs.writeFileSync(idf, "01d00000-0000-4000-8000-000000000000\nLOOMROLE=alpha\n");
  rebindFrame(repo, "alpha", "9e003333-0000-4000-8000-000000000000", "a frame that says nothing of the sort", true);
  eq(fs.readFileSync(idf, "utf8"), "9e003333-0000-4000-8000-000000000000\nLOOMROLE=alpha\n",
     "absent from a BUSY frame is inconclusive — the scrollback is virtualized — so it is kept");

  fs.writeFileSync(idf, "01d00000-0000-4000-8000-000000000000\nLOOMROLE=alpha\n");
  rebindFrame(repo, "alpha", "9e004444-0000-4000-8000-000000000000", null, false);
  eq(fs.readFileSync(idf, "utf8"), "9e004444-0000-4000-8000-000000000000\nLOOMROLE=alpha\n",
     "and NOT READING the frame is not evidence against the guard either");
});

suite("R3: a board with no entry for the role is left alone, and said so", () => {
  const repo = makeRepo({ roles: { alpha: {} } });
  const log = rebindFrame(repo, "ghost", "9e000000-0000-4000-8000-000000000000", "", false);
  eq(readJson(busPath(repo, "board.json")).roles.ghost, undefined, "no roster row invented");
  ok(log && log.notes.some((n) => /no ghost entry/.test(n)), "and it says why: " + JSON.stringify(log && log.notes));
  eq(readJson(busPath(repo, "bindings.json")), { "9e000000-0000-4000-8000-000000000000": "ghost" }, "the binding itself is still recorded");
});

suite("R3: the orchestrator's frame is recorded in orchestrator.json too", async () => {
  const repo = makeRepo({ roles: { alpha: {}, productowner: { session_id: SID_A } } });
  writeJson(busPath(repo, "orchestrator.json"), { role: "productowner", taggedAt: "x", webviewId: "dead0000-0000-4000-8000-000000000000" });
  const t = new Tracker(repo);
  await withFrames([frame("90de1ffe-0000-4000-8000-000000000000", "orchestrating, quietly", SID_A)], async () => {
    const r = await t.tick();
    eq(r.liveRoles, [], "the orchestrator is never a tracked AGENT");
    eq(t.ownerView().map((o) => o.webviewId), ["90de1ffe-0000-4000-8000-000000000000"], "but it is a known owner frame");
    ok(r.rebinds.some((b) => b.role === "productowner"), "and its records were rewritten");
  });
  eq(readJson(busPath(repo, "orchestrator.json")).webviewId, "90de1ffe-0000-4000-8000-000000000000", "orchestrator.json healed");
  eq(fs.readFileSync(busPath(repo, "productowner.id"), "utf8"), "90de1ffe-0000-4000-8000-000000000000\n", "and its id FILE healed");
});

suite("R3: the board's OWN spelling is refreshed, not shadowed by a second field", () => {
  // The extension reads `webviewId`; the boards the Loom skill writes use `webview_id`.
  // vs_code_extensions' own productowner entry carries `webview_id` and nothing else (2026-09-13).
  // Healing only the camel spelling would leave a correct new field beside a stale old one.
  const repo = makeRepo({ roles: { alpha: { webview_id: "01d00000-0000-4000-8000-000000000000" } } });
  eq(busWebviewFor(repo, "alpha").board, "01d00000-0000-4000-8000-000000000000",
     "the snake spelling is READ, so the bus is not reported as silent");
  rebindFrame(repo, "alpha", "9e000000-0000-4000-8000-000000000000", null, false);
  const e = readJson(busPath(repo, "board.json")).roles.alpha;
  eq(e.webview_id, "9e000000-0000-4000-8000-000000000000", "the entry's own spelling is refreshed");
  eq(e.webviewId, "9e000000-0000-4000-8000-000000000000", "and the one the extension reads is set");
});

suite("R3: an entry with no snake field does not GROW one", () => {
  const repo = makeRepo({ roles: { alpha: { webviewId: "01d00000-0000-4000-8000-000000000000" } } });
  rebindFrame(repo, "alpha", "9e000000-0000-4000-8000-000000000000", null, false);
  const e = readJson(busPath(repo, "board.json")).roles.alpha;
  eq(e.webviewId, "9e000000-0000-4000-8000-000000000000", "refreshed");
  eq(e.webview_id, undefined, "and no second spelling invented");
});

suite("R3: busWebviewFor reports each of the three places an id is recorded", () => {
  const repo = makeRepo({ roles: { alpha: { webviewId: "b0a2d000-0000-4000-8000-000000000000" } } });
  writeJson(busPath(repo, "bindings.json"), { "b17d0000-0000-4000-8000-000000000000": "alpha" });
  fs.writeFileSync(busPath(repo, "alpha.id"), "1df11e00-0000-4000-8000-000000000000\nguard\n");
  eq(busWebviewFor(repo, "alpha"), { bindings: "b17d0000-0000-4000-8000-000000000000", board: "b0a2d000-0000-4000-8000-000000000000", idfile: "1df11e00-0000-4000-8000-000000000000" },
     "all three, so a rewrite can be logged old→new");
});

// ── R4: naming the tab you just opened ──────────────────────────────────────

const noSleep = { sleep: async () => {} };

suite("R4: the frame watcher names a new tab only when there is exactly one", async () => {
  let now = [{ webviewId: "a" }, { webviewId: "b" }];
  const w = frameWatcher(async () => now, noSleep);
  await w.seed();
  now = [{ webviewId: "a" }, { webviewId: "b" }, { webviewId: "c" }];
  eq(await w.next(), "c", "exactly one new frame: that is the tab");
  now = [{ webviewId: "a" }, { webviewId: "b" }, { webviewId: "c" }];
  eq(await w.next(), null, "no new frame: nothing to report");
  now = [{ webviewId: "a" }, { webviewId: "b" }, { webviewId: "c" }, { webviewId: "d" }, { webviewId: "e" }];
  eq(await w.next(), null, "two at once is ambiguous: report nothing rather than a guess");
  now = now.concat([{ webviewId: "f" }]);
  eq(await w.next(), "f", "and the ambiguous pair was absorbed, so the NEXT open is still readable");
});

suite("R4: a watcher that could not take a baseline never claims a frame", async () => {
  let fail = true;
  const w = frameWatcher(async () => { if (fail) throw new Error("cdp down"); return [{ webviewId: "a" }]; },
                         noSleep);
  await w.seed();          // throws internally, absorbed
  fail = false;
  eq(await w.next(), "a", "one frame, no baseline: it IS the only candidate");
  eq(await w.next(), null, "and it is not claimed twice");
});

suite("R4: a read that throws mid-flight reports nothing rather than throwing", async () => {
  const w = frameWatcher(async () => { throw new Error("socket wedged"); }, noSleep);
  await w.seed();
  eq(await w.next(), null, "contained");
});

suite("R4: seedFrom adopts a snapshot already read for another purpose", async () => {
  const w = frameWatcher(async () => [{ webviewId: "a" }, { webviewId: "b" }], noSleep);
  w.seedFrom([{ webviewId: "a" }]);
  eq(await w.next(), "b", "only `b` is new, and no second CDP read was needed to know it");
});

// ── R4: the reopen loop itself ──────────────────────────────────────────────

const { openAndIdentify } = load("newframe.js");

/** A sink that just records what it was told. The logs are kept under different names from the
 *  callbacks, or the callbacks would overwrite them. */
function sink() {
  const log = { got: [], failures: [], unclear: [] };
  return {
    log,
    identified: (r, w) => log.got.push(`${r}<-${w}`),
    failed: (r, e) => log.failures.push(`${r}:${e}`),
    ambiguous: (r) => log.unclear.push(r),
  };
}

suite("R4: the restart path opens ONE tab at a time and names each frame it gets", async () => {
  let frames = [{ webviewId: "already-there" }];
  const w = frameWatcher(async () => frames, noSleep);
  await w.seed();
  const opened = [];
  const s = sink();
  const n = await openAndIdentify(
    [{ role: "alpha", sessionId: "sid-a" }, { role: "beta", sessionId: "sid-b" }],
    async (sid) => { opened.push(sid); frames = frames.concat([{ webviewId: "frame-for-" + sid }]); },
    w, s);
  eq(n, 2, "both opened");
  eq(opened, ["sid-a", "sid-b"], "serially, in order");
  eq(s.log.got, ["alpha<-frame-for-sid-a", "beta<-frame-for-sid-b"],
     "and each role is matched to the frame that appeared for IT — not to the other's");
  eq(s.log.unclear, [], "nothing ambiguous");
});

suite("R4: a tab that cannot be told apart is reported, and NOT attributed", async () => {
  let frames = [];
  const w = frameWatcher(async () => frames, noSleep);
  await w.seed();
  const s = sink();
  // two frames appear while one role is opened — something else opened a tab at the same moment
  await openAndIdentify([{ role: "alpha", sessionId: "sid-a" }],
    async () => { frames = [{ webviewId: "x" }, { webviewId: "y" }]; }, w, s);
  eq(s.log.got, [], "nothing attributed — a wrong answer here is written to the bus and injected into");
  eq(s.log.unclear, ["alpha"], "and the ambiguity is named");
});

suite("R4: an open that throws is reported and does not stop the rest", async () => {
  let frames = [];
  const w = frameWatcher(async () => frames, noSleep);
  await w.seed();
  const s = sink();
  const n = await openAndIdentify(
    [{ role: "alpha", sessionId: "sid-a" }, { role: "beta", sessionId: "sid-b" }],
    async (sid) => {
      if (sid === "sid-a") throw new Error("no such session");
      frames = [{ webviewId: "beta-frame" }];
    }, w, s);
  eq(n, 1, "only the one that worked is counted");
  eq(s.log.failures, ["alpha:no such session"], "the failure is named");
  eq(s.log.got, ["beta<-beta-frame"], "and beta still came back");
});
