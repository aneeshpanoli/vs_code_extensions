// extension.test.js — the wiring layer: what activate() composes, in what order, and how the
// startup digest is gated and acted on. Everything the components do individually is covered
// elsewhere; this file exists because the composition was the last untested surface, and both real
// bugs found in this extension so far lived in untested paths.
const { suite, ok, eq, match, load, vscode, makeRepo, busPath, writeJson, readJson, settle, LOOM } =
  require("./harness");
const fs = require("fs");
const os = require("os");
const path = require("path");

const ext = load("extension.js");
const cdp = load("cdp.js");
const { setOrchestrator } = load("orchestrator.js");

const marker = (r) => "\nLOOMROLE=" + r + "\n";
const footer = (m = "Opus 5") => `\nRemote Control\n${m}\nMedium\nBypass permissions\n`;
const frame = (webviewId, text) => ({ webviewId, text, type: "iframe", targetUrl: "vscode-webview://x" });

/** Open a folder whose basename IS the bus id (non-git, so currentRepo falls back to the name). */
function openProject(repo) {
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), "loom-ws-"));
  const dir = path.join(parent, repo);
  fs.mkdirSync(dir);
  vscode.workspace.workspaceFolders = [{ uri: { fsPath: dir } }];
  return dir;
}

/** Boot the extension with a scripted CDP read. Returns a disposer. */
async function activate(frames = []) {
  cdp.readFrames = async () => frames;
  // never shell out to the real injector from a test
  fs.writeFileSync(path.join(LOOM, "loom_cdp.py"), "import sys\nprint(' '.join(sys.argv[1:]))\n");
  const context = { subscriptions: [] };
  ext.activate(context);
  await settle();
  return () => { ext.deactivate(); for (const d of context.subscriptions) { try { d.dispose && d.dispose(); } catch {} } };
}

suite("activate: registers every command and shows the status bar", async () => {
  const repo = makeRepo({ roles: { alpha: {} } }, "wireA");
  openProject(repo);
  const off = await activate([frame("wid-a", "work" + marker("alpha") + footer())]);
  try {
    for (const id of ["refresh", "status", "spawn", "retire", "delete", "lock", "unlock",
                      "tagOrchestrator", "untagOrchestrator", "sessionCount", "digest"]) {
      ok(vscode._commands["loomSessionTracker." + id], "registered: " + id);
    }
    ok(vscode._trees.loomSessions, "tree provider registered");
    ok(vscode._statusItems[0] && vscode._statusItems[0].shown, "status bar shown");
  } finally { off(); }
});

suite("activate: the first tick detects roles and publishes both bus files", async () => {
  const repo = makeRepo({ roles: { alpha: {} } }, "wireB");
  openProject(repo);
  setOrchestrator(repo, "product-owner");            // keep the digest quiet
  const off = await activate([frame("wid-a", "work" + marker("alpha") + footer())]);
  try {
    eq(readJson(busPath(repo, "targetmap.json")), { "wid-a": "alpha" }, "targetmap written by the tick");
    const count = readJson(path.join(LOOM, "active-sessions.json"));
    ok(count && count.sessions >= 1, "session count published");
    match(vscode._statusItems[0].text, /Loom: \d+\/\d+/, "status bar shows the active count");
    match(vscode._statusItems[0].tooltip, /alpha/, "tooltip names the live agent");
  } finally { off(); }
});

suite("activate: a failing CDP read is contained and reported, not thrown", async () => {
  const repo = makeRepo({ roles: { alpha: {} } }, "wireC");
  openProject(repo);
  cdp.readFrames = async () => { throw new Error("socket wedged"); };
  const context = { subscriptions: [] };
  ext.activate(context);                                  // must not throw
  await settle();
  try {
    match(vscode._statusItems[0].text, /CDP\?|err/, "status bar shows the failure: " + vscode._statusItems[0].text);
    eq(vscode._messages.error.length, 0, "and it is not surfaced as an error popup");
  } finally { ext.deactivate(); }
});

suite("digest: stays silent when nothing needs the user", async () => {
  const repo = makeRepo({ roles: { alpha: {} } }, "wireD");
  openProject(repo);
  setOrchestrator(repo, "product-owner");
  // The working count is GLOBAL, and the shared test sandbox holds other suites' busy buses,
  // so raise the threshold rather than pretend the machine is quiet.
  vscode._config["loomSessionTracker.workingWarnThreshold"] = 999;
  const off = await activate([frame("wid-a", "work" + marker("alpha") + footer())]);
  try {
    eq(vscode._messages.info.filter((m) => /^Loom \(/.test(m)), [], "no startup nag");
  } finally { off(); }
});

suite("digest: reports on startup when something is waiting", async () => {
  const repo = makeRepo({ roles: { alpha: {} } }, "wireE");   // deliberately untagged
  openProject(repo);
  writeJson(busPath(repo, "alpha", "status.json"), { status: "blocked", current: "H-3" });
  const off = await activate([frame("wid-a", "work" + marker("alpha") + footer())]);
  try {
    const line = vscode._messages.info.find((m) => /^Loom \(/.test(m));
    ok(line, "a digest was raised: " + JSON.stringify(vscode._messages.info));
    match(line, /blocked on a decision/, "names the blocked role");
    match(line, /no orchestrator tagged/, "and the dormant orchestrator");
  } finally { off(); }
});

suite("digest: honours showStartupDigest=false", async () => {
  const repo = makeRepo({ roles: { alpha: {} } }, "wireF");
  openProject(repo);
  vscode._config["loomSessionTracker.showStartupDigest"] = false;
  writeJson(busPath(repo, "alpha", "status.json"), { status: "blocked", current: "H-3" });
  const off = await activate([frame("wid-a", "work" + marker("alpha") + footer())]);
  try {
    eq(vscode._messages.info.filter((m) => /^Loom \(/.test(m)), [], "suppressed at startup");
    await vscode._commands["loomSessionTracker.digest"]();   // but still available on demand
    ok(vscode._messages.info.some((m) => /^Loom \(/.test(m)), "the command forces it");
  } finally { off(); }
});

suite("digest: the 'Tag orchestrator' action tags one", async () => {
  const repo = makeRepo({ roles: { alpha: {} } }, "wireG");
  openProject(repo);
  writeJson(busPath(repo, "alpha", "status.json"), { status: "blocked", current: "H-3" });
  vscode._answer = (_msg, actions) => (actions.includes("Tag orchestrator") ? "Tag orchestrator" : undefined);
  vscode._quickPick = "product-owner";                    // the role picked in the tag flow
  const off = await activate([frame("wid-a", "work" + marker("alpha") + footer())]);
  try {
    await settle();
    eq(readJson(busPath(repo, "orchestrator.json")).role, "product-owner", "tagged from the digest action");
  } finally { off(); }
});

suite("digest: the 'Reopen sessions' action opens the chosen sessions, never automatically", async () => {
  const repo = makeRepo({ roles: { alpha: { session_id: "sid-alpha-1" } } }, "wireH");
  openProject(repo);
  setOrchestrator(repo, "product-owner");
  vscode._answer = (_m, actions) => (actions.includes("Reopen sessions") ? "Reopen sessions" : undefined);
  vscode._quickPick = (items) => items;                   // pick every offered role
  // no frames -> alpha has no live session, so it is offered for reopening
  const off = await activate([]);
  try {
    await settle();
    const opened = vscode._executed.filter((e) => e.id === "claude-vscode.editor.open");
    eq(opened.length, 1, "one session opened");
    eq(opened[0].args[0], "sid-alpha-1", "by the session id recorded on the board");
  } finally { off(); }
});

suite("digest: nothing is opened when the user dismisses it", async () => {
  const repo = makeRepo({ roles: { alpha: { session_id: "sid-alpha-2" } } }, "wireI");
  openProject(repo);
  setOrchestrator(repo, "product-owner");
  vscode._answer = undefined;                             // user dismisses the notification
  const off = await activate([]);
  try {
    await settle();
    eq(vscode._executed.filter((e) => e.id === "claude-vscode.editor.open"), [], "no session opened");
  } finally { off(); }
});

suite("activate: an unfiltered window (no folder) still activates safely", async () => {
  vscode.workspace.workspaceFolders = undefined;
  const off = await activate([frame("wid-x", "chat" + footer())]);
  try {
    ok(vscode._commands["loomSessionTracker.refresh"], "commands still registered");
    eq(vscode._messages.error.length, 0, "no errors");
  } finally { off(); }
});

suite("deactivate: the polling timer is cleared (slow: waits out one interval)", async () => {
  const repo = makeRepo({ roles: { alpha: {} } }, "wireJ");
  openProject(repo);
  setOrchestrator(repo, "product-owner");
  vscode._config["loomSessionTracker.intervalMs"] = 5000;   // the floor; anything less is clamped
  let reads = 0;
  const frames = [frame("wid-a", "work" + marker("alpha") + footer())];
  cdp.readFrames = async () => { reads++; return frames; };
  const context = { subscriptions: [] };
  ext.activate(context);
  await settle();
  eq(reads, 1, "the immediate first tick ran");
  ext.deactivate();
  await settle(5400);                                        // past one full interval
  eq(reads, 1, "no further tick ran after deactivate — the interval really was cleared");
});

suite("tick: the model policy runs — a worker on the premium model is switched", async () => {
  const repo = makeRepo({ roles: { alpha: {} } }, "wireK");
  openProject(repo);
  setOrchestrator(repo, "product-owner");
  const off = await activate([frame("wid-a", "work" + marker("alpha") + footer("Fable 5.1"))]);
  try {
    const pending = readJson(busPath(repo, "model-policy.json")).pending;
    ok(pending && pending.alpha, "the violation was recorded by the tick");
    eq(pending.alpha.model, "Fable 5.1", "naming the premium model");
    ok(vscode._messages.info.some((m) => /orchestrator-only tier/.test(m)), "and the user was told");
  } finally { off(); }
});

suite("tick: the notifier runs — a finish is announced to the orchestrator", async () => {
  const repo = makeRepo({ roles: { alpha: {} } }, "wireL");
  openProject(repo);
  setOrchestrator(repo, "po");
  // pre-seed the pre-restart state: alpha was working; it is now idle.
  writeJson(busPath(repo, "notify-state.json"), { prev: { alpha: { status: "working", current: "H-1" } }, announced: [] });
  writeJson(busPath(repo, "alpha", "status.json"), { status: "idle", current: "H-1", last_line: "done" });
  const off = await activate([frame("wid-a", "work" + marker("alpha") + footer())]);
  try {
    ok(vscode._messages.info.some((m) => /alpha finished/.test(m)), "the finish was announced: " +
      JSON.stringify(vscode._messages.info));
  } finally { off(); }
});

suite("tick: the limit watcher runs — a lifted limit resumes the session", async () => {
  const repo = makeRepo({ roles: { alpha: {} } }, "wireM");
  openProject(repo);
  setOrchestrator(repo, "po");
  // alpha was limited and has already had one clear tick; this tick is the second.
  writeJson(busPath(repo, "limit-state.json"), {
    roles: { alpha: { since: new Date().toISOString(), kind: "session limit", etaText: "in 1h",
                      notBefore: null, clearTicks: 1 } } });
  const off = await activate([frame("wid-a", "work" + marker("alpha") + footer())]);   // no limit banner
  try {
    ok(vscode._messages.info.some((m) => /has reset/.test(m)), "the resume fired: " +
      JSON.stringify(vscode._messages.info));
    eq(readJson(busPath(repo, "limit-state.json")).roles.alpha, undefined, "and the role was cleared");
  } finally { off(); }
});

// ── orchestrator context memory (end to end through activate) ─────────────────────────────────
/** A transcript for `sessionId` reporting `tokens` of context, in its own project directory. */
function transcript(dirName, sessionId, tokens) {
  const dir = path.join(os.homedir(), ".claude", "projects", dirName);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, sessionId + ".jsonl"), JSON.stringify({
    type: "assistant", sessionId,
    message: { model: "claude-opus-5", usage: { input_tokens: tokens } },
  }) + "\n");
  return dir;
}
// A real orchestrator frame names its own project's bus constantly; that is how the tracker tells
// WHICH project's orchestrator it is (the CDP read is editor-wide).
const poFrame = (wid, repo, extra = "") =>
  frame(wid, `orchestrating ~/.claude/loom/${repo}/ and ~/.claude/loom/${repo}/board.json ` +
    extra + marker("product-owner") + footer());

suite("context memory: a full orchestrator is asked to bank its memory", async () => {
  const repo = makeRepo({ po: { session_id: "sid-ctx1" } }, "ctxA");
  openProject(repo);
  setOrchestrator(repo, "po", "wid-po");
  transcript("-ctx-a", "sid-ctx1", 700000);              // 70% of the 1M window
  const off = await activate([poFrame("wid-po", repo)]);
  try {
    await settle(60);
    const st = readJson(busPath(repo, "context-state.json"));
    eq(st.phase, "saving", "cycle started");
    eq(st.triggerTokens, 700000, "recorded what triggered it");
    const dbg = readJson(path.join(LOOM, "context-debug.json"));
    match(dbg.out, /--webview-id wid-po/, "injected into the orchestrator's own frame");
    match(dbg.message, /write your working memory/, "asking for the memory doc");
    ok(vscode._messages.info.some((m) => /70% context|bank its memory/.test(m)), "and the user is told");
  } finally { off(); }
});

suite("context memory: a comfortable context is left alone", async () => {
  const repo = makeRepo({ po: { session_id: "sid-ctx2" } }, "ctxB");
  openProject(repo);
  setOrchestrator(repo, "po", "wid-po");
  transcript("-ctx-b", "sid-ctx2", 200000);              // 20%
  const off = await activate([poFrame("wid-po", repo)]);
  try {
    await settle(60);
    const st = readJson(busPath(repo, "context-state.json"));
    ok(!st || st.phase === "watch", "still watching");
    match(vscode._statusItems[0].tooltip, /Orchestrator: ~20% context.*estimated/, "the reading is surfaced");
  } finally { off(); }
});

suite("context memory: /clear follows only once the memory file is on disk", async () => {
  const repo = makeRepo({ po: { session_id: "sid-ctx3" } }, "ctxC");
  openProject(repo);
  setOrchestrator(repo, "po", "wid-po");
  transcript("-ctx-c", "sid-ctx3", 800000);
  const off = await activate([poFrame("wid-po", repo)]);
  try {
    await settle(60);
    eq(readJson(busPath(repo, "context-state.json")).phase, "saving", "asked for the save");
    // Tick again with NO memory file: nothing may be cleared.
    await vscode.commands.executeCommand("loomSessionTracker.refresh");
    await settle(60);
    eq(readJson(busPath(repo, "context-state.json")).phase, "saving", "still waiting, nothing cleared");
    // Now the orchestrator writes it.
    writeJson(busPath(repo, "po", "memory.md"), {});      // just to make the directory
    fs.writeFileSync(busPath(repo, "po", "memory.md"), "# working memory\n" + "x".repeat(500));
    // A banked file is not enough on its own: the orchestrator must also read IDLE on consecutive
    // ticks, so a turn that merely paused between tool calls is not mistaken for a finished one.
    await vscode.commands.executeCommand("loomSessionTracker.refresh");
    await settle(60);
    const mid = readJson(busPath(repo, "context-state.json"));
    eq(mid.phase, "saving", "still saving after ONE idle reading — the run is not confirmed yet");
    eq(mid.idleTicks, 1, "and it counts that reading");
    await vscode.commands.executeCommand("loomSessionTracker.refresh");
    await settle(60);
    eq(readJson(busPath(repo, "context-state.json")).phase, "clearing", "now it clears");
    eq(readJson(path.join(LOOM, "context-debug.json")).message, "/clear", "with /clear");
  } finally { off(); }
});

suite("context memory: the fresh session is restored from the memory doc", async () => {
  const repo = makeRepo({ po: { session_id: "sid-ctx4" } }, "ctxD");
  openProject(repo);
  setOrchestrator(repo, "po", "wid-po");
  const dir = transcript("-ctx-d", "sid-ctx4", 800000);
  fs.mkdirSync(busPath(repo, "po"), { recursive: true });
  fs.writeFileSync(busPath(repo, "po", "memory.md"), "# working memory\n" + "x".repeat(500));
  writeJson(busPath(repo, "context-state.json"), {
    phase: "clearing", sessionId: "sid-ctx4", transcriptDir: dir, phaseAt: Date.now() - 1000,
  });
  transcript("-ctx-d", "sid-ctx5", 900);                 // the post-/clear session
  const off = await activate([poFrame("wid-po", repo)]);
  try {
    await settle(60);
    const st = readJson(busPath(repo, "context-state.json"));
    eq(st.phase, "watch", "cycle complete");
    eq(st.sessionId, "sid-ctx5", "now following the new session");
    eq(st.cycles, 1, "counted");
    match(readJson(path.join(LOOM, "context-debug.json")).message, /Fresh context/, "restore prompt sent");
  } finally { off(); }
});

suite("context memory: nothing happens without a tagged orchestrator", async () => {
  const repo = makeRepo({ po: { session_id: "sid-ctx6" } }, "ctxE");
  openProject(repo);
  transcript("-ctx-e", "sid-ctx6", 900000);              // 90% full, but nobody is tagged
  const off = await activate([poFrame("wid-po", repo)]);
  try {
    await settle(60);
    ok(!readJson(busPath(repo, "context-state.json")), "no cycle without a tag");
  } finally { off(); }
});

suite("context memory: the manual command runs the cycle regardless of the threshold", async () => {
  const repo = makeRepo({ po: { session_id: "sid-ctx7" } }, "ctxF");
  openProject(repo);
  setOrchestrator(repo, "po", "wid-po");
  transcript("-ctx-f", "sid-ctx7", 50000);               // only 5% — far below the threshold
  const off = await activate([poFrame("wid-po", repo)]);
  try {
    await settle(60);
    const before = readJson(busPath(repo, "context-state.json"));
    ok(!before || before.phase === "watch", "the tick left it alone");
    vscode._warnAnswer = "Bank & clear";                 // confirm the modal
    await vscode.commands.executeCommand("loomSessionTracker.bankContext");
    await settle(60);
    eq(readJson(busPath(repo, "context-state.json")).phase, "saving", "manual run started the cycle");
  } finally { off(); }
});

suite("context memory: the manual command does nothing when it is not confirmed", async () => {
  const repo = makeRepo({ po: { session_id: "sid-ctx8" } }, "ctxG");
  openProject(repo);
  setOrchestrator(repo, "po", "wid-po");
  transcript("-ctx-g", "sid-ctx8", 900000);
  const off = await activate([poFrame("wid-po", repo)]);
  try {
    await settle(60);
    writeJson(busPath(repo, "context-state.json"), { phase: "watch", lastCycleAt: Date.now() });
    vscode._warnAnswer = undefined;                      // dismissed
    await vscode.commands.executeCommand("loomSessionTracker.bankContext");
    await settle(60);
    eq(readJson(busPath(repo, "context-state.json")).phase, "watch", "nothing started");
  } finally { off(); }
});

suite("tagging: the orchestrator's frame id is recorded, so it can be injected into", async () => {
  const repo = makeRepo({ roles: { alpha: {} } }, "ctxH");
  openProject(repo);
  const off = await activate([poFrame("wid-owner", repo), frame("wid-a", "work" + marker("alpha") + footer())]);
  try {
    vscode._quickPick = "product-owner";
    await vscode.commands.executeCommand("loomSessionTracker.tagOrchestrator");
    const tag = readJson(busPath(repo, "orchestrator.json"));
    eq(tag.role, "product-owner", "tagged");
    eq(tag.webviewId, "wid-owner", "with the detected frame");
  } finally { off(); }
});
