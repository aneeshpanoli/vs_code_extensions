// extension.test.js — the wiring layer: what activate() composes, in what order, and how the
// startup digest is gated and acted on. Everything the components do individually is covered
// elsewhere; this file exists because the composition was the last untested surface, and both real
// bugs found in this extension so far lived in untested paths.
const { suite, ok, eq, match, load, vscode, makeRepo, busPath, writeJson, readJson, setStatus, settle, LOOM, fixtureDir} =
  require("./harness");
const fs = require("fs");
const os = require("os");
const { execFileSync } = require("child_process");
const path = require("path");

const ext = load("extension.js");
const cdp = load("cdp.js");
const { setOrchestrator } = load("orchestrator.js");
const { REPLY_FOR } = load("inject.js");
const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

const marker = (r) => "\nLOOMROLE=" + r + "\n";
const footer = (m = "Opus 5") => `\nRemote Control\n${m}\nMedium\nBypass permissions\n`;
const frame = (webviewId, text) => ({ webviewId, text, type: "iframe", targetUrl: "vscode-webview://x" });

/** Open a folder whose basename IS the bus id (non-git, so currentRepo falls back to the name). */
function openProject(repo) {
  const parent = fixtureDir("loom-ws-");
  const dir = path.join(parent, repo);
  fs.mkdirSync(dir);
  vscode.workspace.workspaceFolders = [{ uri: { fsPath: dir } }];
  return dir;
}

/** A fake loom_cdp.py that APPENDS every injection's argv to LOOM/inject-log.txt, so a test can
 *  assert what was typed, into which frame, and IN WHAT ORDER. The plain fake overwrites nothing,
 *  and injectTo's own debug file keeps only the last call — which cannot answer "before or after". */
const LOGGING_CDP =
  "import sys, os\n" +
  "p = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'inject-log.txt')\n" +
  "open(p, 'a').write(' '.join(sys.argv[1:]) + '\\n')\n" +
  "print(' '.join(sys.argv[1:]))\n";

/** Every injection so far, in order, as argv strings. */
function injectLog() {
  try { return fs.readFileSync(path.join(LOOM, "inject-log.txt"), "utf8").split("\n").filter(Boolean); }
  catch { return []; }
}
function clearInjectLog() { try { fs.unlinkSync(path.join(LOOM, "inject-log.txt")); } catch {} }

/** Boot the extension with a scripted CDP read. Returns a disposer.
 *  `frames` may be a function, so a test can make a tab APPEAR once editor.open has run. */
async function activate(frames = [], cdpScript = null) {
  cdp.readFrames = async () => (typeof frames === "function" ? frames() : frames);
  // never shell out to the real injector from a test
  fs.writeFileSync(path.join(LOOM, "loom_cdp.py"), cdpScript ||
    "import sys\nprint(' '.join(sys.argv[1:]))\n");
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
    eq(pending.alpha.target, "claude-opus-5", "and the tier it is owed");
    ok(vscode._messages.info.some((m) => /alpha is on Fable 5\.1 — it is owed claude-opus-5/.test(m)),
       "and the user was told: " + JSON.stringify(vscode._messages.info));
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
    // MC-001: the SAVE step's reply hint, and only the save one.
    match(dbg.out, new RegExp(esc(REPLY_FOR["context-save"])), "save carries the save reply hint");
    ok(!new RegExp(esc(REPLY_FOR["context-restore"])).test(dbg.out), "not the restore hint");
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

suite("context memory: a verified save banks, and NOTHING is ever typed at the orchestrator", async () => {
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
    // CX-001 · THE ASSERTION THE OWNER ASKED FOR, DRIVEN THROUGH THE REAL PATH rather than through
    // decide() alone: the banked file was the last precondition the old code needed, so this is the
    // tick on which a /clear used to be typed. It runs the extension's actual tick and then reads
    // the injector's own debug log, which is the record of everything this extension typed anywhere.
    await vscode.commands.executeCommand("loomSessionTracker.refresh");
    await settle(60);
    eq(readJson(busPath(repo, "context-state.json")).phase, "banked", "the memory is banked");
    const dbg = readJson(path.join(LOOM, "context-debug.json"));
    ok(!/^\s*\/clear\b/.test(String(dbg.message || "")), "no /clear was typed — it is the save prompt that stands");
    match(dbg.message, /\[loom-context\] Your context is/, "the last thing typed is still the SAVE prompt");
    // …and it stays that way however long it sits there.
    for (let i = 0; i < 3; i++) {
      await vscode.commands.executeCommand("loomSessionTracker.refresh");
      await settle(60);
    }
    eq(readJson(busPath(repo, "context-state.json")).phase, "banked", "still banked, still waiting on a person");
    const after = readJson(path.join(LOOM, "context-debug.json"));
    ok(!/^\s*\/clear\b/.test(String(after.message || "")), "and three more ticks typed no clear either");
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
    phase: "banked", sessionId: "sid-ctx4", transcriptDir: dir, phaseAt: Date.now() - 1000,
  });
  transcript("-ctx-d", "sid-ctx5", 900);                 // the session a PERSON's /clear started
  const off = await activate([poFrame("wid-po", repo)]);
  try {
    await settle(60);
    const st = readJson(busPath(repo, "context-state.json"));
    eq(st.phase, "watch", "cycle complete");
    eq(st.sessionId, "sid-ctx5", "now following the new session");
    eq(st.cycles, 1, "counted");
    const dbg = readJson(path.join(LOOM, "context-debug.json"));
    match(dbg.message, /Fresh context/, "restore prompt sent");
    // MC-001 — the exact defect: a just-restored session was told "write the memory file named
    // here", backwards, since it has nothing to bank and its whole job is to READ it.
    match(dbg.out, new RegExp(esc(REPLY_FOR["context-restore"])), "restore carries the restore reply hint");
    ok(!new RegExp(esc(REPLY_FOR["context-save"])).test(dbg.out), "NOT the save hint — that was the bug");
    eq(readJson(busPath(repo, "board.json")).po.session_id, "sid-ctx5", "the board now names the fresh session (rebound)");
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
    // CX-001: no longer a destructive confirmation — it is an information modal, because banking a
    // file destroys nothing. `_answer` is the fake's showInformationMessage channel, `_warnAnswer`
    // the showWarningMessage one, and the switch between them is itself the claim.
    vscode._answer = "Bank memory";
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

// ── a transcript resumes only from the window it was written under (2026-09-13) ─────────────────
const { projectDirFor } = load("reopen.js");
const tx = (dir, sid) => { fs.mkdirSync(dir, { recursive: true }); fs.writeFileSync(path.join(dir, sid + ".jsonl"), "{}\n"); };

suite("open request: a role stranded in a worktree's cwd is spawned fresh, its transcript never opened blank", async () => {
  const repo = makeRepo({ designer: { session_id: "sid-des-wt" }, productowner: { session_id: "sid-po" } }, "wireS");
  const dir = openProject(repo);
  const wtc = path.join(dir, ".claude", "worktrees", "designer");
  writeJson(busPath(repo, "board.json"), { designer: { session_id: "sid-des-wt", worktree: wtc }, productowner: { session_id: "sid-po" } });
  tx(projectDirFor(wtc), "sid-des-wt");                       // lives ONLY under the worktree's cwd
  setOrchestrator(repo, "productowner", "wid-po");
  writeJson(busPath(repo, "open-requests.json"), { roles: ["designer"], requestedAt: new Date().toISOString() });
  const off = await activate([poFrame("wid-po", repo)]);
  try {
    await settle(3200);                                       // the spawn path waits 2.5s to tell the new frame apart
    const opens = vscode._executed.filter((e) => e.id === "claude-vscode.editor.open");
    ok(opens.length >= 1, "a tab was opened");
    ok(opens.every((e) => e.args[0] === undefined), "…as a NEW conversation, never editor.open(sid-des-wt)");
    const res = readJson(busPath(repo, "open-requests.json"));
    ok(res && res.servedAt, "the request was served");
    ok(!res.opened.some((o) => o.sessionId === "sid-des-wt"), "the stranded transcript was not reopened");
  } finally { off(); }
});

suite("digest: 'Reopen sessions' refuses a session written under another folder instead of opening it blank", async () => {
  const repo = makeRepo({ roles: { alpha: { session_id: "sid-alpha-wt" } } }, "wireT");
  const dir = openProject(repo);
  tx(projectDirFor(path.join(dir, ".claude", "worktrees", "alpha")), "sid-alpha-wt");
  setOrchestrator(repo, "product-owner");
  vscode._answer = (_m, actions) => (actions.includes("Reopen sessions") ? "Reopen sessions" : undefined);
  vscode._quickPick = (items) => items;
  const off = await activate([]);
  try {
    await settle();
    eq(vscode._executed.filter((e) => e.id === "claude-vscode.editor.open"), [], "nothing opened");
    ok(vscode._messages.warn.some((m) => /alpha.*sid-alph.*cannot be reopened from this window/.test(m)), "and the user was told why");
  } finally { off(); }
});

// ── the orchestrator is kept on the premium tier (user direction 2026-09-13) ────────────────────


// ── the loop of 2026-09-13 00:13–04:21: fourteen bank/clear/restore cycles on a dead transcript ──
suite("context memory: a visible orchestrator panel with no compact button is NOT cycled on a transcript estimate", async () => {
  const repo = makeRepo({ po: { session_id: "sid-loop" } }, "ctxL");
  openProject(repo);
  setOrchestrator(repo, "po", "wid-po");
  transcript("-ctx-loop", "sid-loop", 572412);           // the 57% "estimate" that fired all night
  // a real, rendered conversation (well over CLEARED_PANEL_CHARS) with no compact button on it
  const big = poFrame("wid-po", repo, "\n" + "conversation ".repeat(1500));
  try { fs.unlinkSync(path.join(LOOM, "context-debug.json")); } catch { /* an earlier suite's */ }
  vscode._config["loomSessionTracker.contextThresholdPct"] = 50;   // the veto is the panel's opinion at 50
  const off = await activate([big]);
  try {
    await settle(60);
    const st = readJson(busPath(repo, "context-state.json"));
    ok(!st || st.phase === "watch", "no cycle started: " + JSON.stringify(st));
    ok(!fs.existsSync(path.join(LOOM, "context-debug.json")), "nothing injected");
    match(vscode._statusItems[0].tooltip, /no compact button/, "and the tooltip says why");
  } finally { off(); }
  // the same panel WITH its button at 70% fires — the panel is the source that counts
  vscode._reset();
  openProject(repo);
  setOrchestrator(repo, "po", "wid-po");
  vscode._config["loomSessionTracker.contextThresholdPct"] = 50;
  const off2 = await activate([{ ...big, contextPct: 70 }]);
  try {
    await settle(60);
    eq(readJson(busPath(repo, "context-state.json")).phase, "saving", "the panel's own 70% starts the cycle");
    eq(readJson(busPath(repo, "context-state.json")).triggerFromPanel, true);
  } finally { off2(); }
});

// ── garbage collection, through activate() ───────────────────────────────────────────────────
// The planner and applier are asserted directly in gc.test.js; what is tested here is the WIRING:
// that the digest offers the action with the real counts, that "No" changes nothing on disk, that
// "Yes" actually moves the fixture files, and that the automatic tier-1 pass is rate-limited and
// leased so seven open windows do not all collect at once.
//
// TWO THINGS EVERY SUITE HERE MUST CONTROL, both learned by getting them wrong:
//   * the AUTOMATIC pass runs on activation, so a suite about the manual path must first say the
//     machine is not due (`notDue()`), or activation quietly collects the fixture out from under it;
//   * suites share one sandbox HOME and one dated archive, so two suites archiving
//     `local.loom-session-tracker-0.10.0` collide and the second is skipped as "already exists".
//     Every suite below therefore uses version numbers of its own.

/** Boot with an extensionPath, so VERSION is a real version instead of "unknown". */
async function activateAsVersion(frames, version) {
  const extDir = fixtureDir("loom-extpath-");
  fs.writeFileSync(path.join(extDir, "package.json"), JSON.stringify({ version }));
  cdp.readFrames = async () => frames;
  fs.writeFileSync(path.join(LOOM, "loom_cdp.py"), "import sys\nprint(' '.join(sys.argv[1:]))\n");
  const context = { subscriptions: [], extensionPath: extDir };
  ext.activate(context);
  await settle();
  return () => { ext.deactivate(); for (const d of context.subscriptions) { try { d.dispose && d.dispose(); } catch {} } };
}

const EXTS = path.join(os.homedir(), ".vscode-oss", "extensions");
const PROJ = path.join(os.homedir(), ".claude", "projects");
const GC_STATE = path.join(LOOM, "gc-state.json");

/** The machine has just collected, so activation's automatic pass stands down. */
const notDue = () => writeJson(GC_STATE, { lastRunAt: Date.now(), lastNote: "test: not due" });
/** The machine has never collected. */
const due = () => { try { fs.rmSync(GC_STATE); } catch { /* already absent */ } };

/** Deployed build directories, plus the extensions.json entry saying which one the editor loads. */
function deployed(versions, registered) {
  fs.mkdirSync(EXTS, { recursive: true });
  for (const v of versions) fs.mkdirSync(path.join(EXTS, `local.loom-session-tracker-${v}`), { recursive: true });
  const loc = path.join(EXTS, `local.loom-session-tracker-${registered}`);
  fs.writeFileSync(path.join(EXTS, "extensions.json"), JSON.stringify(
    [{ identifier: { id: "local.loom-session-tracker" }, version: registered, location: { fsPath: loc, path: loc } }]));
}
/** An old, unreferenced transcript in a directory that also holds a newer one (so it is collectable). */
function collectableTranscript(dir, sid, ageDays = 40) {
  const f = path.join(PROJ, dir, sid + ".jsonl");
  fs.mkdirSync(path.dirname(f), { recursive: true });
  fs.writeFileSync(f, "old\n");
  const t = (Date.now() - ageDays * 86400000) / 1000;
  fs.utimesSync(f, t, t);
  fs.writeFileSync(path.join(PROJ, dir, "keepnewe-" + sid.slice(-4) + ".jsonl"), "{}\n");
  return f;
}
const archived = (...rest) => path.join(LOOM, "_archive", new Date().toISOString().slice(0, 10), ...rest);

suite("gc wiring: the digest offers Collect garbage with the real counts", async () => {
  const repo = makeRepo({ roles: { blockedone: {} } }, "gcW1");
  openProject(repo);
  setOrchestrator(repo, "product-owner", "wid-po");
  writeJson(busPath(repo, "blockedone", "status.json"), { status: "blocked", current: "a decision" });
  vscode._config["loomSessionTracker.gcEnabled"] = true;      // 0.33.0 ships it off; see D1
  notDue();
  deployed(["1.10.0", "1.11.0", "0.33.0"], "0.33.0");
  collectableTranscript("-gcw1-proj", "gcw1sess-0001");
  const off = await activateAsVersion([poFrame("wid-po", repo)], "0.33.0");
  try {
    let offered = null;
    vscode._answer = (m, actions) => { offered = { m, actions }; return undefined; };
    await vscode.commands.executeCommand("loomSessionTracker.digest");
    await settle(40);
    ok(offered, "the digest came up (there is a blocked role)");
    ok(offered.actions.includes("Collect garbage"), "and it offers the action: " + offered.actions);
    // The count must be the REAL one, and this sandbox is shared with every suite above, so the
    // expected number is the planner's own answer rather than a literal that drifts with fixtures.
    const gc = load("gc.js");
    // The same roster the extension feeds the planner: machine-wide from the bus (R4). With an empty
    // set the expectation drifts by whatever roles other suites left writing status in this sandbox.
    const expect = gc.planGc({ now: Date.now(), cfg: gc.DEFAULT_GC_CONFIG, currentVersion: "0.33.0",
                               liveRoles: gc.busLiveRoles(Date.now()).roles, repoRoots: {} });
    const n = expect.tier1.length + expect.tier2.length;
    ok(n >= 3, `the fixture really is collectable (${n}: two builds and a transcript at least)`);
    match(offered.m, new RegExp(`${n} collectable`), "with the real count: " + offered.m);
  } finally { off(); }
});

suite("gc wiring: the plan can be read without collecting anything", async () => {
  const repo = makeRepo({ roles: {} }, "gcW1b");
  openProject(repo);
  setOrchestrator(repo, "product-owner", "wid-po");
  vscode._config["loomSessionTracker.gcEnabled"] = true;      // 0.33.0 ships it off; see D1
  notDue();
  deployed(["1.20.0", "0.33.0"], "0.33.0");
  const kept = path.join(EXTS, "local.loom-session-tracker-1.20.0");
  const off = await activateAsVersion([poFrame("wid-po", repo)], "0.33.0");
  try {
    vscode._quickPick = (items) => items.find((i) => i.label === "Show plan");
    await vscode.commands.executeCommand("loomSessionTracker.collectGarbage");
    await settle(40);
    match(vscode._messages.info.join("\n"), /Garbage, tier 1/, "the plan is shown");
    ok(fs.existsSync(kept), "and reading it collects nothing");
  } finally { off(); }
});

suite("gc wiring: answering No to the confirmation changes nothing on disk", async () => {
  const repo = makeRepo({ roles: {} }, "gcW2");
  openProject(repo);
  setOrchestrator(repo, "product-owner", "wid-po");
  vscode._config["loomSessionTracker.gcEnabled"] = true;      // 0.33.0 ships it off; see D1
  notDue();
  deployed(["1.30.0", "0.33.0"], "0.33.0");
  const tr = collectableTranscript("-gcw2-proj", "gcw2sess-0002");
  const doomed = path.join(EXTS, "local.loom-session-tracker-1.30.0");
  const off = await activateAsVersion([poFrame("wid-po", repo)], "0.33.0");
  try {
    vscode._quickPick = (items) => items.find((i) => i.label === "Run tiers 1+2");
    vscode._warnAnswer = "Cancel";
    await vscode.commands.executeCommand("loomSessionTracker.collectGarbage");
    await settle(40);
    // the exact tier-1 count is whatever this shared sandbox has accumulated by now; what matters
    // here is that the confirmation states counts before anything is touched (gcW1 pins the numbers)
    match(vscode._messages.warn.join("\n"),
          /collect \d+ tier-1 item\(s\) \(archived\) and \d+ tier-2 item\(s\)/,
          "the confirmation names the counts before anything is touched");
    match(vscode._messages.warn.join("\n"), /Nothing is deleted/, "and promises what it will not do");
    ok(fs.existsSync(tr), "the transcript is still where it was");
    ok(fs.existsSync(doomed), "and so is the superseded build");
    match(vscode._statusMessages.join("\n"), /nothing collected/, "and it says so");
  } finally { off(); }
});

suite("gc wiring: answering Collect actually moves the files into the dated archive", async () => {
  const repo = makeRepo({ roles: {} }, "gcW3");
  openProject(repo);
  setOrchestrator(repo, "product-owner", "wid-po");
  vscode._config["loomSessionTracker.gcEnabled"] = true;      // 0.33.0 ships it off; see D1
  notDue();
  deployed(["1.40.0", "0.33.0"], "0.33.0");
  const tr = collectableTranscript("-gcw3-proj", "gcw3sess-0003");
  const doomed = path.join(EXTS, "local.loom-session-tracker-1.40.0");
  const off = await activateAsVersion([poFrame("wid-po", repo)], "0.33.0");
  try {
    vscode._quickPick = (items) => items.find((i) => i.label === "Run tiers 1+2");
    vscode._warnAnswer = "Collect";
    await vscode.commands.executeCommand("loomSessionTracker.collectGarbage");
    await settle(60);
    ok(!fs.existsSync(tr), "the transcript moved");
    ok(!fs.existsSync(doomed), "and so did the superseded build");
    ok(fs.existsSync(archived("extensions", "local.loom-session-tracker-1.40.0")),
       "the build is in the archive — recoverable, never deleted");
    ok(fs.existsSync(archived("transcripts", "-gcw3-proj", "gcw3sess-0003.jsonl")),
       "and so is the transcript");
    ok(fs.existsSync(path.join(EXTS, "local.loom-session-tracker-0.33.0")), "the running build is untouched");
  } finally { off(); }
});

suite("gc wiring: the automatic tier-1 pass runs once, and not again inside the interval", async () => {
  const repo = makeRepo({ roles: {} }, "gcW4");
  openProject(repo);
  setOrchestrator(repo, "product-owner", "wid-po");
  vscode._config["loomSessionTracker.gcEnabled"] = true;      // 0.33.0 ships it off; see D1
  due();
  deployed(["1.50.0", "0.33.0"], "0.33.0");
  const doomed = path.join(EXTS, "local.loom-session-tracker-1.50.0");
  const off = await activateAsVersion([poFrame("wid-po", repo)], "0.33.0");
  try {
    await settle(80);
    ok(!fs.existsSync(doomed), "activation collected tier 1 without asking — every action is a move");
    ok(fs.existsSync(archived("extensions", "local.loom-session-tracker-1.50.0")), "into the archive");
    const st = readJson(GC_STATE);
    ok(st.lastRunAt, "the pass is recorded");
    eq(st.owner, undefined, "and its lease is released, so a crash cannot deadlock the next one");
  } finally { off(); }
  // a second window activating immediately must not run it again
  const before = readJson(GC_STATE).lastRunAt;
  deployed(["1.51.0", "0.33.0"], "0.33.0");
  const doomed2 = path.join(EXTS, "local.loom-session-tracker-1.51.0");
  vscode._reset();
  openProject(repo);
  const off2 = await activateAsVersion([poFrame("wid-po", repo)], "0.33.0");
  try {
    await settle(80);
    ok(fs.existsSync(doomed2), "the next window inside the 24h interval collects nothing");
    eq(readJson(GC_STATE).lastRunAt, before, "and the interval is not restarted");
  } finally { off2(); }
});

suite("gc wiring: a window does NOT collect while another window holds the lease", async () => {
  const repo = makeRepo({ roles: {} }, "gcW5");
  openProject(repo);
  setOrchestrator(repo, "product-owner", "wid-po");
  vscode._config["loomSessionTracker.gcEnabled"] = true;      // 0.33.0 ships it off; see D1
  deployed(["1.60.0", "0.33.0"], "0.33.0");
  const doomed = path.join(EXTS, "local.loom-session-tracker-1.60.0");
  // due (the last pass is long past) but claimed seconds ago by a window that is still working
  writeJson(GC_STATE, { lastRunAt: Date.now() - 100 * 3600000, owner: "other-window", ownerAt: Date.now() - 1000 });
  const off = await activateAsVersion([poFrame("wid-po", repo)], "0.33.0");
  try {
    await settle(80);
    ok(fs.existsSync(doomed), "one collector per machine — the second window stands down");
    eq(readJson(GC_STATE).owner, "other-window", "and leaves the claim alone");
  } finally { off(); }
});

suite("gc wiring: a STALE lease does not block collection forever", async () => {
  const repo = makeRepo({ roles: {} }, "gcW5b");
  openProject(repo);
  setOrchestrator(repo, "product-owner", "wid-po");
  vscode._config["loomSessionTracker.gcEnabled"] = true;      // 0.33.0 ships it off; see D1
  deployed(["1.70.0", "0.33.0"], "0.33.0");
  const doomed = path.join(EXTS, "local.loom-session-tracker-1.70.0");
  // claimed by a window that has since been closed — its lease expired
  writeJson(GC_STATE, { lastRunAt: Date.now() - 100 * 3600000, owner: "dead-window",
                        ownerAt: Date.now() - 60 * 60000 });
  const off = await activateAsVersion([poFrame("wid-po", repo)], "0.33.0");
  try {
    await settle(80);
    ok(!fs.existsSync(doomed), "the abandoned claim is taken over and the pass runs");
    eq(readJson(GC_STATE).owner, undefined, "and released again afterwards");
  } finally { off(); }
});

suite("gc wiring: gcEnabled=false collects nothing and says so", async () => {
  const repo = makeRepo({ roles: {} }, "gcW6");
  openProject(repo);
  setOrchestrator(repo, "product-owner", "wid-po");
  deployed(["1.80.0", "0.33.0"], "0.33.0");
  const doomed = path.join(EXTS, "local.loom-session-tracker-1.80.0");
  due();
  vscode._config["loomSessionTracker.gcEnabled"] = false;
  const off = await activateAsVersion([poFrame("wid-po", repo)], "0.33.0");
  try {
    await settle(80);
    ok(fs.existsSync(doomed), "nothing was collected automatically");
    await vscode.commands.executeCommand("loomSessionTracker.collectGarbage");
    await settle(40);
    match(vscode._messages.info.join("\n"), /garbage collection is disabled/, "and the command explains why");
    ok(fs.existsSync(doomed), "still there");
  } finally { off(); }
});

// ── GC-004 · what the extension FEEDS the collector ─────────────────────────────────────────
// gc.ts is only as good as its inputs, and both of these were wrong in a way no gc.ts test could
// see: the version stamp was keyed so two windows shared a slot, and the live roster handed to a
// machine-wide pass was filtered to one project.

suite("gc R2 wiring: the version stamp is keyed by WINDOW and carries the repo as a field", async () => {
  const repo = makeRepo({ roles: {} }, "gcR2w");
  openProject(repo);
  setOrchestrator(repo, "product-owner", "wid-po");
  notDue();
  try { fs.rmSync(GC_STATE); } catch { /* fine */ }
  const stampFile = path.join(LOOM, "running-versions.json");
  try { fs.rmSync(stampFile); } catch { /* fine */ }
  const off = await activateAsVersion([poFrame("wid-po", repo)], "0.33.0");
  try {
    await settle(60);
    const stamp = readJson(stampFile);
    ok(stamp, "the stamp was written");
    const keys = Object.keys(stamp);
    eq(keys.length, 1, "one window, one entry");
    ok(!keys.includes(repo), `keyed by window, not by project (${keys[0]})`);
    match(keys[0], /^\d+:/, "and a windowId looks like <pid>:<nonce>");
    eq(stamp[keys[0]].repo, repo, "the project is carried as a field, so live.sh can still name it");
    eq(stamp[keys[0]].version, "0.33.0", "with the build this window is running");
  } finally { off(); }
});

suite("gc R2 wiring: the version stamp is written atomically (tmp + rename)", async () => {
  // Not a style point. Ten windows rewrite this file every 15 seconds, and since R1 a torn read
  // makes garbage collection refuse the whole extension tier — so a plain writeFileSync would
  // routinely disable collection AND, before R1, would have archived a build live windows were on.
  // The observable fact is that the destination is reached by rename, never written in place.
  const repo = makeRepo({ roles: {} }, "gcR2atomic");
  openProject(repo);
  setOrchestrator(repo, "product-owner", "wid-po");
  notDue();
  const stampFile = path.join(LOOM, "running-versions.json");
  try { fs.rmSync(stampFile); } catch { /* fine */ }
  const realWrite = fs.writeFileSync, realRename = fs.renameSync;
  const writes = [], renames = [];
  fs.writeFileSync = function (f, ...rest) { writes.push(String(f)); return realWrite.call(fs, f, ...rest); };
  fs.renameSync = function (a, b, ...rest) { renames.push([String(a), String(b)]); return realRename.call(fs, a, b, ...rest); };
  let off;
  try {
    off = await activateAsVersion([poFrame("wid-po", repo)], "0.33.0");
    await settle(60);
  } finally {
    fs.writeFileSync = realWrite;
    fs.renameSync = realRename;
    if (off) off();
  }
  ok(!writes.includes(stampFile), "the destination itself is never written in place");
  ok(writes.some((w) => w.startsWith(stampFile + ".tmp.")), "a temp file beside it is: " + writes.filter((w) => w.includes("running-versions")));
  ok(renames.some(([, b]) => b === stampFile), "and it is renamed over the destination in one step");
  eq(readJson(stampFile).__proto__ === Object.prototype, true, "leaving a complete, parseable file");
});

suite("gc R2 wiring: a second window does not overwrite the first window's entry", async () => {
  const repo = makeRepo({ roles: {} }, "gcR2w2");
  const stampFile = path.join(LOOM, "running-versions.json");
  try { fs.rmSync(stampFile); } catch { /* fine */ }
  openProject(repo);
  setOrchestrator(repo, "product-owner", "wid-po");
  notDue();
  const off = await activateAsVersion([poFrame("wid-po", repo)], "0.33.0");
  await settle(60);
  off();
  const first = Object.keys(readJson(stampFile))[0];
  // a second window, same project, still on the old build it loaded
  vscode._reset();
  openProject(repo);
  setOrchestrator(repo, "product-owner", "wid-po");
  notDue();
  const off2 = await activateAsVersion([poFrame("wid-po", repo)], "0.29.0");
  try {
    await settle(60);
    const stamp = readJson(stampFile);
    eq(Object.keys(stamp).length, 2, "two windows, two entries — a repo key would have held only one");
    eq(stamp[first].version, "0.33.0", "the first window's build is still recorded");
    const other = Object.keys(stamp).find((k) => k !== first);
    eq(stamp[other].version, "0.29.0",
       "and so is the build the second window is actually running — which is what stops gc archiving it");
  } finally { off2(); }
});

// RENAMED in GC-006 to what the body proves. It proved that `busLiveRoles` — the source the
// extension builds its roster FROM — is machine-wide, not that the extension hands that roster to
// the collector; the extension's own supply is what `gc wiring: the digest offers Collect garbage
// with the real counts` pins, by computing its expectation from the same call.
suite("gc R4 wiring: the BUS roster the collector is built from covers EVERY project", async () => {
  const mine = makeRepo({ roles: { local: {} } }, "gcR4mine");
  // another project entirely, with a role that is writing status right now
  const other = makeRepo({ roles: { remote: {} } }, "gcR4other");
  writeJson(busPath(other, "remote", "status.json"), { status: "working", session_id: "remotese-0300" });
  const root = fixtureDir("loom-r4-");
  // that other project's worktree, orphaned + clean + merged
  execFileSync("git", ["-C", root, "init", "-q", "-b", "main"]);
  execFileSync("git", ["-C", root, "config", "user.email", "t@example.com"]);
  execFileSync("git", ["-C", root, "config", "user.name", "t"]);
  fs.writeFileSync(path.join(root, "README"), "x\n");
  execFileSync("git", ["-C", root, "add", "-A"]);
  execFileSync("git", ["-C", root, "commit", "-qm", "base"]);
  const wt = path.join(root, ".claude", "worktrees", "remote");
  fs.mkdirSync(path.dirname(wt), { recursive: true });
  execFileSync("git", ["-C", root, "worktree", "add", "-q", "-b", "worktree-remote", wt, "main"]);

  openProject(mine);
  setOrchestrator(mine, "product-owner", "wid-po");
  vscode._config["loomSessionTracker.gcEnabled"] = true;
  notDue();
  const off = await activateAsVersion([poFrame("wid-po", mine)], "0.33.0");
  try {
    // The extension's own supply of the roster is what is being tested, so ask gc for the same
    // answer the extension would compute and require the other project's live role to be in it.
    const gcmod = load("gc.js");
    const bus = gcmod.busLiveRoles(Date.now());
    ok(bus.roles.has(`${other}/remote`),
       "tracker.view() is scoped to this window's project; the bus is not, and the automatic pass " +
       "is machine-wide — without this every other project's worktrees lose their live protection");
    ok(bus.sessionIds.has("remotese-0300"), "and its session id travels with it");
    // and the plan built from that roster leaves the other project's live worktree alone
    const plan = gcmod.planGc({ now: Date.now(), cfg: { ...gcmod.DEFAULT_GC_CONFIG, enabled: true },
                                currentVersion: "0.33.0", liveRoles: bus.roles, repoRoots: { [other]: root } });
    eq(plan.tier2.filter((i) => i.label === `${other}/remote`).length, 0,
       "so it is never offered for removal — though note the ROSTER would also have kept it: a " +
       "status.json is a mailbox, and a mailbox role is not orphaned (see planWorktrees)");
  } finally { off(); }
});

// ── GC-006 R1 · the WRITER side of "a read that cannot answer is a refusal" ───────────────────
// GC-004 R1 made gc's READER of running-versions.json fail closed. The writer still failed open:
// `catch { /* first */ }` left `all = {}` on every kind of read failure, and the tick then pruned
// nothing and ATOMICALLY published `{ thisWindow: <version> }` — erasing every other window's entry.
// gc reads that as a perfectly readable file naming ONE version, and moves every other running
// build's directory in tier 1, the unattended tier.

const STAMP = path.join(LOOM, "running-versions.json");
const debugJson = () => readJson(path.join(LOOM, "tracker-debug.json"));
/** Another window's entry, stamped just now. */
const otherWindow = (version) => ({ version, at: new Date().toISOString(), repo: "SomeOtherRepo" });

suite("gc R1 writer: an UNPARSEABLE stamp file is not rewritten, and the entries in it survive", async () => {
  const repo = makeRepo({ roles: {} }, "gcR1torn");
  openProject(repo);
  setOrchestrator(repo, "product-owner", "wid-po");
  notDue();
  // A file being rewritten non-atomically by a pre-0.33.0 window, caught mid-write: one complete
  // entry and a truncated one. Every 0.29.0 window on this machine does exactly this every 15 s.
  const torn = '{\n "1:aaa": {"version": "0.29.0", "at": "' + new Date().toISOString() + '"},\n "2:bbb": {"vers';
  fs.writeFileSync(STAMP, torn);
  const off = await activateAsVersion([poFrame("wid-po", repo)], "0.33.0");
  try {
    await settle(60);
    eq(fs.readFileSync(STAMP, "utf8"), torn,
       "the file is byte-for-byte what it was: a read that could not answer is not permission to " +
       "replace it, and replacing it would have erased 0.29.0 while nine windows were running it");
    match(String(debugJson().stamp), /unparseable/, "and the tick says why, every 15 seconds");
  } finally { off(); }
});

suite("gc R1 writer: a stamp file that cannot be READ is not rewritten either", async () => {
  const repo = makeRepo({ roles: {} }, "gcR1eacces");
  openProject(repo);
  setOrchestrator(repo, "product-owner", "wid-po");
  notDue();
  // A perfectly good file — the failure is in the reading. EMFILE and a transient EACCES are the
  // real ones; both arrive here as an exception that is not ENOENT.
  writeJson(STAMP, { "1:aaa": otherWindow("0.29.0") });
  const good = fs.readFileSync(STAMP, "utf8");
  const realRead = fs.readFileSync;
  fs.readFileSync = function (f, ...rest) {
    if (String(f) === STAMP) { const e = new Error("EMFILE"); e.code = "EMFILE"; throw e; }
    return realRead.call(fs, f, ...rest);
  };
  let off;
  try {
    off = await activateAsVersion([poFrame("wid-po", repo)], "0.33.0");
    await settle(60);
  } finally { fs.readFileSync = realRead; if (off) off(); }
  eq(fs.readFileSync(STAMP, "utf8"), good, "untouched — the other window's build is still recorded");
  eq(readJson(STAMP)["1:aaa"].version, "0.29.0", "which is the whole point: gc keeps 0.29.0");
  match(String(debugJson().stamp), /read failed \(EMFILE\)/, "and the reason is on the bus");
});

suite("gc R1 writer: a stamp file that is not an OBJECT is not rewritten", async () => {
  const repo = makeRepo({ roles: {} }, "gcR1array");
  openProject(repo);
  setOrchestrator(repo, "product-owner", "wid-po");
  notDue();
  fs.writeFileSync(STAMP, "[1,2,3]");            // parses, but nothing we can prune or add to
  const off = await activateAsVersion([poFrame("wid-po", repo)], "0.33.0");
  try {
    await settle(60);
    eq(fs.readFileSync(STAMP, "utf8"), "[1,2,3]", "a shape we do not understand is not ours to replace");
    match(String(debugJson().stamp), /not an object/, "and it says so");
  } finally { off(); }
});

suite("gc R1 writer: an ABSENT stamp file IS written — ENOENT is the one 'first' case", async () => {
  const repo = makeRepo({ roles: {} }, "gcR1first");
  openProject(repo);
  setOrchestrator(repo, "product-owner", "wid-po");
  notDue();
  try { fs.rmSync(STAMP); } catch { /* already gone */ }
  const off = await activateAsVersion([poFrame("wid-po", repo)], "0.33.0");
  try {
    await settle(60);
    const stamp = readJson(STAMP);
    ok(stamp, "the file was created");
    eq(Object.keys(stamp).length, 1, "with this window in it");
    eq(Object.values(stamp)[0].version, "0.33.0", "running the build it is running");
    eq(debugJson().stamp, undefined, "and nothing to report — refusing here would wedge a fresh machine");
  } finally { off(); }
});

suite("gc R1 writer: another window's entry survives an ordinary tick", async () => {
  // The regression the refusals exist to prevent, stated positively: the normal path MERGES.
  const repo = makeRepo({ roles: {} }, "gcR1merge");
  openProject(repo);
  setOrchestrator(repo, "product-owner", "wid-po");
  notDue();
  writeJson(STAMP, { "1:aaa": otherWindow("0.29.0") });
  const off = await activateAsVersion([poFrame("wid-po", repo)], "0.33.0");
  try {
    await settle(60);
    const stamp = readJson(STAMP);
    eq(Object.keys(stamp).length, 2, "two entries: the other window's and ours");
    eq(stamp["1:aaa"].version, "0.29.0", "and 0.29.0 is still claimed by the window that is running it");
  } finally { off(); }
});

suite("gc R1 writer: an entry whose timestamp will not parse is pruned on write", async () => {
  // R3's other half. The reader stopped honouring such an entry; if the writer kept it, the file
  // would carry it for ever — one damaged entry per reload, and the prune could never reach them.
  const repo = makeRepo({ roles: {} }, "gcR1undated");
  openProject(repo);
  setOrchestrator(repo, "product-owner", "wid-po");
  notDue();
  writeJson(STAMP, {
    "1:undated": { version: "0.28.0", at: "not a date" },
    "2:fresh": otherWindow("0.29.0"),
  });
  const off = await activateAsVersion([poFrame("wid-po", repo)], "0.33.0");
  try {
    await settle(60);
    const stamp = readJson(STAMP);
    ok(!("1:undated" in stamp), "an entry that cannot say when it was written cannot age out, so it goes");
    eq(stamp["2:fresh"].version, "0.29.0", "and the one that can is untouched");
  } finally { off(); }
});

// ── MP-001: the handoff chooses the tier, the tracker enforces it ───────────────────────────────
// Every one of these drives activate() -> tick -> the injected command and asserts the EXACT text
// and the EXACT frame, through the append-only inject log. A planner assertion would not have
// caught the two bugs this project has actually had, both of which were in the typing path.

/** Write a handoff into a role's inbox, with or without a `model:` line. */
function putHandoff(repo, role, id, model) {
  const f = busPath(repo, role, "inbox.md");
  fs.mkdirSync(path.dirname(f), { recursive: true });
  fs.writeFileSync(f, `---\nid: ${id}\nfrom: productowner\n` + (model ? `model: ${model}\n` : "") +
                      `---\n# ${id}\n\nthe brief\n`);
}
const modelInjections = () => injectLog().filter((l) => /--message \/model /.test(l));

suite("MP-001 R2: a worker on Opus whose handoff asks for Sonnet is switched DOWN — that frame only", async () => {
  const repo = makeRepo({ roles: { alpha: {}, beta: {} } }, "mp-down");
  openProject(repo);
  setOrchestrator(repo, "product-owner", "wid-po");
  putHandoff(repo, "alpha", "MP-100", "claude-sonnet-5");
  putHandoff(repo, "beta", "MP-101", null);                 // beta is owed the default, and is on it
  clearInjectLog();
  const off = await activate([frame("wid-a", "w" + marker("alpha") + footer("Opus 5")),
                              frame("wid-b", "w" + marker("beta") + footer("Opus 5"))], LOGGING_CDP);
  try {
    await settle(300);
    const inj = modelInjections();
    eq(inj.length, 1, "exactly one /model was typed: " + JSON.stringify(injectLog()));
    ok(/--message \/model claude-sonnet-5\b/.test(inj[0]), "…the id the handoff asked for: " + inj[0]);
    ok(/--role alpha\b/.test(inj[0]) && /--webview-id wid-a\b/.test(inj[0]), "…into alpha's own frame: " + inj[0]);
    ok(!/wid-b/.test(inj[0]), "and nowhere near beta, which is already on its tier");
    const pending = readJson(busPath(repo, "model-policy.json")).pending;
    eq(pending.alpha.target, "claude-sonnet-5", "recorded with its target");
    ok(!pending.beta, "beta is not pending at all");
  } finally { off(); }
});

suite("MP-001 R2: a worker on Sonnet owed Opus is switched UP — the same mechanism, the other way", async () => {
  const repo = makeRepo({ roles: { alpha: {} } }, "mp-up");
  openProject(repo);
  setOrchestrator(repo, "product-owner", "wid-po");
  putHandoff(repo, "alpha", "MP-102", null);                // no `model:` -> the configured default
  clearInjectLog();
  const off = await activate([frame("wid-a", "w" + marker("alpha") + footer("Sonnet 5"))], LOGGING_CDP);
  try {
    await settle(300);
    const inj = modelInjections();
    eq(inj.length, 1, "one /model typed: " + JSON.stringify(injectLog()));
    ok(/--message \/model claude-opus-5\b/.test(inj[0]) && /--webview-id wid-a\b/.test(inj[0]),
       "switched UP, into alpha's frame: " + inj[0]);
  } finally { off(); }
});

suite("MP-001 R2: a PREMIUM id in a handoff types nothing, and the refusal is logged", async () => {
  const repo = makeRepo({ roles: { alpha: {} } }, "mp-prem");
  openProject(repo);
  setOrchestrator(repo, "product-owner", "wid-po");
  putHandoff(repo, "alpha", "MP-103", "claude-fable-5-1[1m]");
  clearInjectLog();
  // alpha is ALREADY on the default tier, so honouring the frontmatter would be the only reason to type
  const off = await activate([frame("wid-a", "w" + marker("alpha") + footer("Opus 5"))], LOGGING_CDP);
  try {
    await settle(300);
    eq(modelInjections(), [], "nothing was typed: " + JSON.stringify(injectLog()));
    const dbg = readJson(path.join(LOOM, "tracker-debug.json"));
    // window state, not one log line: it must SURVIVE the later debugLog calls of the same tick
    ok(dbg && JSON.stringify((dbg.model || {}).frontmatterIgnored || []).includes("premium tier is orchestrator-only"),
       "and the refusal is still in tracker-debug.json at the end of the tick: " + JSON.stringify(dbg && dbg.model));
  } finally { off(); }
});

suite("MP-001 R2: a BUSY composer is withheld — nothing typed, and no attempt counted", async () => {
  const repo = makeRepo({ roles: { alpha: {} } }, "mp-busy");
  openProject(repo);
  setOrchestrator(repo, "product-owner", "wid-po");
  putHandoff(repo, "alpha", "MP-104", "claude-sonnet-5");
  clearInjectLog();
  const busy = "\nClaude is working\n";
  const off = await activate([frame("wid-a", "w" + marker("alpha") + busy + footer("Opus 5"))], LOGGING_CDP);
  try {
    await settle(300);
    eq(modelInjections(), [], "a /model into a busy composer would queue as a message and never run");
    const st = readJson(busPath(repo, "model-policy.json"));
    ok(!st || !st.pending || !st.pending.alpha,
       "and it is not a violation either — no attempt, no backoff growth: " + JSON.stringify(st && st.pending));
  } finally { off(); }
});

suite("MP-001 R3: the spawn path types /model BEFORE /loom, into the frame it watched appear", async () => {
  const repo = makeRepo({ roles: { alpha: {} } }, "mp-spawn");
  openProject(repo);
  setOrchestrator(repo, "product-owner", "wid-po");
  putHandoff(repo, "alpha", "MP-105", "claude-sonnet-5");
  writeJson(busPath(repo, "open-requests.json"), { roles: ["alpha"], requestedAt: new Date().toISOString() });
  clearInjectLog();
  const po = poFrame("wid-po", repo);
  // the new tab exists only once editor.open has run, and it acknowledges the switch at once
  const newTab = frame("wid-new", "You: /model claude-sonnet-5\nSet model to Sonnet 5 for this session only\n" + footer("Opus 5"));
  const off = await activate(() =>
    vscode._executed.some((e) => e.id === "claude-vscode.editor.open") ? [po, newTab] : [po], LOGGING_CDP);
  try {
    await settle(6000);                     // the spawn path waits 2.5s for the frame, then the ack
    const mine = injectLog().filter((l) => /--webview-id wid-new\b/.test(l));
    ok(mine.length >= 2, "both commands went to the new frame: " + JSON.stringify(injectLog()));
    ok(/--message \/model claude-sonnet-5\b/.test(mine[0]), "FIRST the tier: " + mine[0]);
    ok(/--message \/loom alpha\b/.test(mine[1]), "THEN the bind: " + mine[1]);
    ok(!/--message \/model/.test(mine[1]) && !/--message \/loom/.test(mine[0]), "and not the other way round");
  } finally { off(); }
});

suite("MP-001 R3: a handoff on the DEFAULT tier types no /model — a fresh tab is already there", async () => {
  const repo = makeRepo({ roles: { alpha: {} } }, "mp-spawn-def");
  openProject(repo);
  setOrchestrator(repo, "product-owner", "wid-po");
  putHandoff(repo, "alpha", "MP-106", "claude-opus-5");     // == the configured workerModel
  writeJson(busPath(repo, "open-requests.json"), { roles: ["alpha"], requestedAt: new Date().toISOString() });
  clearInjectLog();
  const po = poFrame("wid-po", repo);
  const newTab = frame("wid-new", "fresh tab\n" + footer("Opus 5"));
  const off = await activate(() =>
    vscode._executed.some((e) => e.id === "claude-vscode.editor.open") ? [po, newTab] : [po], LOGGING_CDP);
  try {
    await settle(5000);
    const mine = injectLog().filter((l) => /--webview-id wid-new\b/.test(l));
    eq(mine.filter((l) => /--message \/model/.test(l)).length, 0, "no /model: " + JSON.stringify(mine));
    ok(mine.some((l) => /--message \/loom alpha\b/.test(l)), "but it was still bound: " + JSON.stringify(mine));
  } finally { off(); }
});

suite("MP-001 R3: no acknowledgement within the bound still BINDS — an unbound tab is the worse loss", async () => {
  const repo = makeRepo({ roles: { alpha: {} } }, "mp-spawn-noack");
  openProject(repo);
  setOrchestrator(repo, "product-owner", "wid-po");
  vscode._config["loomSessionTracker.modelAckMs"] = 200;
  putHandoff(repo, "alpha", "MP-107", "claude-sonnet-5");
  writeJson(busPath(repo, "open-requests.json"), { roles: ["alpha"], requestedAt: new Date().toISOString() });
  clearInjectLog();
  const po = poFrame("wid-po", repo);
  const newTab = frame("wid-new", "a tab that never answers\n" + footer("Opus 5"));   // no "Set model to"
  const off = await activate(() =>
    vscode._executed.some((e) => e.id === "claude-vscode.editor.open") ? [po, newTab] : [po], LOGGING_CDP);
  try {
    await settle(5000);
    const mine = injectLog().filter((l) => /--webview-id wid-new\b/.test(l));
    ok(mine.some((l) => /--message \/model claude-sonnet-5\b/.test(l)), "it did try: " + JSON.stringify(mine));
    ok(mine.some((l) => /--message \/loom alpha\b/.test(l)), "and bound anyway: " + JSON.stringify(mine));
    const dbg = readJson(path.join(LOOM, "tracker-debug.json"));
    ok(/no acknowledgement/.test(String(((dbg || {}).model || {}).spawn?.note || "")),
       "the unacknowledged switch is on the record: " + JSON.stringify((dbg || {}).model));
    ok(/no acknowledgement/.test(String((readJson(path.join(LOOM, "spawn-debug.json")) || {}).model?.note || "")),
       "…and in spawn-debug.json, which the /loom injection would otherwise have clobbered (MS-001 R2b)");
  } finally { off(); }
});

suite("MP-001 R4/R5 wiring: the tick escalates a twice-blocked role and closes its ledger line", async () => {
  const repo = makeRepo({ roles: { alpha: {} } }, "mp-esc");
  openProject(repo);
  setOrchestrator(repo, "product-owner", "wid-po");
  putHandoff(repo, "alpha", "MP-108", "claude-sonnet-5");
  setStatus(repo, "alpha", { status: "blocked", current: "MP-108", updated_at: "T1" });
  const inboxOf = () => fs.readFileSync(busPath(repo, "alpha", "inbox.md"), "utf8");
  const off = await activate([frame("wid-a", "w" + marker("alpha") + footer("Sonnet 5"))]);
  try {
    await settle(200);
    ok(/model: claude-sonnet-5/.test(inboxOf()), "one loop-back changes nothing");
    // a SECOND loop-back, then a tick
    setStatus(repo, "alpha", { status: "blocked", current: "MP-108", updated_at: "T2" });
    await vscode._commands["loomSessionTracker.refresh"]();
    await settle(200);
    ok(/model: claude-opus-5/.test(inboxOf()), "the second escalates the handoff itself: " + inboxOf());
    ok(vscode._messages.info.some((m) => /looped back twice on MP-108/.test(m)), "and the human is told");
    // finish it: the ledger line closes, and says it was escalated
    setStatus(repo, "alpha", { status: "idle", last_handled: "MP-108", updated_at: "T3", tests_after: 601 });
    await vscode._commands["loomSessionTracker.refresh"]();
    await settle(200);
    const lines = fs.readFileSync(busPath(repo, "model-ledger.jsonl"), "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
    eq(lines.length, 1, "one line: " + JSON.stringify(lines));
    eq(lines[0].id, "MP-108");
    eq(lines[0].role, "alpha");
    eq(lines[0].chosenBy, "escalated");
    eq(lines[0].model, "claude-opus-5");
    eq(lines[0].loopBacks, 2);
    eq(lines[0].testsAfter, 601);
  } finally { off(); }
});

// ── CH-001 R2: §19's disjointness rule, enforced on the path that OPENS tabs ─────────────────────
// Driven through activate() -> tick -> serveOpenRequests, per the owner's rule that a planner
// assertion proves nothing about a path whose whole job is to open a tab. The counter-test matters
// as much as the refusal: a guard that refuses everything would pass a one-sided test.

/** A handoff with a `files:` line, for the overlap guard. */
function putFilesHandoff(repo, role, id, files) {
  const f = busPath(repo, role, "inbox.md");
  fs.mkdirSync(path.dirname(f), { recursive: true });
  fs.writeFileSync(f, `---\nid: ${id}\nfrom: productowner\nfiles: ${files}\n---\n# ${id}\n\nthe brief\n`);
}
/** How many tabs the extension actually opened. */
const opensSoFar = () => vscode._executed.filter((e) => e.id === "claude-vscode.editor.open").length;
/** The result the orchestrator reads back out of open-requests.json. */
const served = (repo) => readJson(busPath(repo, "open-requests.json")) || {};

suite("CH-001 R2: a handoff overlapping a WORKING role's is refused, and no tab is opened", async () => {
  const repo = makeRepo({ roles: { alpha: {}, beta: {} } }, "ch-ov-refuse");
  openProject(repo);
  setOrchestrator(repo, "product-owner", "wid-po");
  putFilesHandoff(repo, "alpha", "CH-200", "src/models.ts, src/requests.ts");
  putFilesHandoff(repo, "beta", "CH-201", "README.md, loom-session-tracker/src/models.ts");
  setStatus(repo, "alpha", { status: "working", current: "CH-200", updated_at: "T1" });
  writeJson(busPath(repo, "open-requests.json"), { roles: ["beta"], requestedAt: new Date().toISOString() });
  clearInjectLog();
  const off = await activate([poFrame("wid-po", repo)], LOGGING_CDP);
  try {
    await settle(600);
    eq(opensSoFar(), 0, "not one tab: " + JSON.stringify(vscode._executed.map((e) => e.id)));
    // nothing was typed into a WORKER's frame. The orchestrator's own promotion to the premium tier
    // is a different mechanism and fires here as it does on every tick; it is not this guard's doing.
    eq(injectLog().filter((l) => !/--webview-id wid-po\b/.test(l)), [],
       "and nothing was typed into a worker: " + JSON.stringify(injectLog()));
    const r = served(repo);
    eq((r.opened || []).length, 0, "nothing opened: " + JSON.stringify(r));
    eq((r.refused || []).map((x) => x.reason),
       ["overlaps alpha on loom-session-tracker/src/models.ts"],
       "and the orchestrator can read WHY, and against whom: " + JSON.stringify(r.refused));
  } finally { off(); }
});

suite("CH-001 R2: ONE request naming two colliding briefs opens the first and refuses the second", async () => {
  const repo = makeRepo({ roles: { alpha: {}, beta: {} } }, "ch-ov-pair");
  openProject(repo);
  setOrchestrator(repo, "product-owner", "wid-po");
  putFilesHandoff(repo, "alpha", "CH-202", "src/models.ts");
  putFilesHandoff(repo, "beta", "CH-203", "src/*.ts");            // a glob over the same directory
  // NEITHER is working: only the in-flight half of the guard can catch this pair.
  writeJson(busPath(repo, "open-requests.json"), { roles: ["alpha", "beta"], requestedAt: new Date().toISOString() });
  clearInjectLog();
  const po = poFrame("wid-po", repo);
  const tabs = [frame("wid-n1", "fresh tab\n" + footer("Opus 5")), frame("wid-n2", "fresh tab\n" + footer("Opus 5"))];
  const off = await activate(() => [po, ...tabs.slice(0, opensSoFar())], LOGGING_CDP);
  try {
    await settle(6000);
    eq(opensSoFar(), 1, "exactly one tab: " + JSON.stringify(vscode._executed.map((e) => e.id)));
    const r = served(repo);
    eq((r.opened || []).map((o) => o.role), ["alpha"], "the first one opened: " + JSON.stringify(r.opened));
    eq((r.refused || []).map((x) => x.reason), ["overlaps alpha on src/*.ts"],
       "the second refused against it: " + JSON.stringify(r.refused));
    ok(injectLog().some((l) => /--message \/loom alpha\b/.test(l)), "alpha was bound");
    ok(!injectLog().some((l) => /--message \/loom beta\b/.test(l)), "beta was never bound: " + JSON.stringify(injectLog()));
  } finally { off(); }
});

suite("CH-001 R2: file-DISJOINT handoffs both open — the guard refuses collisions, not work", async () => {
  const repo = makeRepo({ roles: { alpha: {}, beta: {} } }, "ch-ov-ok");
  openProject(repo);
  setOrchestrator(repo, "product-owner", "wid-po");
  putFilesHandoff(repo, "alpha", "CH-204", "src/models.ts, src/requests.ts");
  putFilesHandoff(repo, "beta", "CH-205", "tools/coverage.py, docs/README.md");   // CH-002's real package
  writeJson(busPath(repo, "open-requests.json"), { roles: ["alpha", "beta"], requestedAt: new Date().toISOString() });
  clearInjectLog();
  const po = poFrame("wid-po", repo);
  const tabs = [frame("wid-n1", "fresh tab\n" + footer("Opus 5")), frame("wid-n2", "fresh tab\n" + footer("Opus 5"))];
  const off = await activate(() => [po, ...tabs.slice(0, opensSoFar())], LOGGING_CDP);
  try {
    await settle(8000);
    eq(opensSoFar(), 2, "both tabs opened: " + JSON.stringify(vscode._executed.map((e) => e.id)));
    const r = served(repo);
    eq((r.opened || []).map((o) => o.role).sort(), ["alpha", "beta"], "both served: " + JSON.stringify(r.opened));
    eq((r.refused || []).filter((x) => /overlaps/.test(x.reason)), [],
       "and neither was refused for overlap: " + JSON.stringify(r.refused));
  } finally { off(); }
});

suite("CH-001 R2: an ALREADY-BOUND role that overlaps a working one is warned about, not stopped", async () => {
  // A bound role is rung through reach_po.py, which is off-git and outside this extension: there is
  // nothing to intercept, so the honest surface is a warning. It must not type, open or write.
  const repo = makeRepo({ roles: { alpha: {}, beta: {} } }, "ch-ov-warn");
  openProject(repo);
  setOrchestrator(repo, "product-owner", "wid-po");
  putFilesHandoff(repo, "alpha", "CH-206", "src/models.ts");
  putFilesHandoff(repo, "beta", "CH-207", "src/models.ts, src/other.ts");
  setStatus(repo, "alpha", { status: "working", current: "CH-206", updated_at: "T1" });
  clearInjectLog();
  const off = await activate([poFrame("wid-po", repo),
                             frame("wid-b", "w" + marker("beta") + footer("Opus 5"))], LOGGING_CDP);
  try {
    await settle(400);
    ok(vscode._statusMessages.some((m) => /beta's handoff overlaps alpha on src\/models\.ts/.test(m)),
       "the collision is on the status bar: " + JSON.stringify(vscode._statusMessages));
    ok(vscode._statusMessages.some((m) => /one handoff is one merge/.test(m)), "with the rule it comes from");
    const dbg = readJson(path.join(LOOM, "tracker-debug.json"));
    ok(JSON.stringify((dbg || {}).handoffOverlap || []).includes("beta overlaps alpha"),
       "and on the record: " + JSON.stringify((dbg || {}).handoffOverlap));
    eq(opensSoFar(), 0, "warn ONLY — nothing was opened");
    // a second tick must not warn again about the same pair; a 15s tick would be a spam machine
    const before = vscode._statusMessages.filter((m) => /overlaps alpha/.test(m)).length;
    await vscode._commands["loomSessionTracker.refresh"]();
    await settle(300);
    eq(vscode._statusMessages.filter((m) => /overlaps alpha/.test(m)).length, before,
       "once per colliding pair, not once per tick");
  } finally { off(); }
});

suite("CH-001 R2: a role whose handoff declares NOTHING is opened as before — no refusal on absence", async () => {
  const repo = makeRepo({ roles: { alpha: {}, beta: {} } }, "ch-ov-silent");
  openProject(repo);
  setOrchestrator(repo, "product-owner", "wid-po");
  putFilesHandoff(repo, "alpha", "CH-208", "src/models.ts");
  // beta's brief predates the `files:` convention entirely
  fs.mkdirSync(busPath(repo, "beta"), { recursive: true });
  fs.writeFileSync(busPath(repo, "beta", "inbox.md"), "---\nid: CH-209\nfrom: productowner\n---\n# CH-209\n");
  setStatus(repo, "alpha", { status: "working", current: "CH-208", updated_at: "T1" });
  writeJson(busPath(repo, "open-requests.json"), { roles: ["beta"], requestedAt: new Date().toISOString() });
  clearInjectLog();
  const po = poFrame("wid-po", repo);
  const off = await activate(() =>
    opensSoFar() ? [po, frame("wid-n1", "fresh tab\n" + footer("Opus 5"))] : [po], LOGGING_CDP);
  try {
    await settle(6000);
    eq(opensSoFar(), 1, "it was opened: " + JSON.stringify(vscode._executed.map((e) => e.id)));
    const r = served(repo);
    eq((r.refused || []).filter((x) => /overlaps/.test(x.reason)), [],
       "making the `files:` line compulsory by stealth would break every bus that has not adopted it");
    eq(vscode._statusMessages.filter((m) => /overlaps/.test(m)), [], "and nothing was warned about either");
  } finally { off(); }
});

// ── MS-001: absent tiers are loud, a failed switch is not "switched", the orchestrator shifts itself ──
// Driven through activate() -> tick, per the owner's rule that no injection is proved by a planner alone.

suite("MS-001 R1: a handoff with no model: line is named in the status bar and tracker-debug.json — once", async () => {
  const repo = makeRepo({ roles: { alpha: {} } }, "ms-r1");
  openProject(repo);
  setOrchestrator(repo, "product-owner", "wid-po");
  putHandoff(repo, "alpha", "DEV-179", null);
  clearInjectLog();
  const off = await activate([frame("wid-a", "w" + marker("alpha") + footer("Opus 5"))], LOGGING_CDP);   // already on the default
  try {
    await settle(300);
    const want = "Loom: alpha's DEV-179 has no model: line — running the default claude-opus-5 (§18)";
    eq(vscode._statusMessages.filter((m) => m === want).length, 1, "said exactly once: " + JSON.stringify(vscode._statusMessages));
    const dbg = readJson(path.join(LOOM, "tracker-debug.json"));
    ok(dbg && JSON.stringify((dbg.model || {}).defaulted || []).includes("DEV-179 has no model: line"),
       "and survives to the end of the tick in tracker-debug.json: " + JSON.stringify(dbg && dbg.model));
    eq(modelInjections(), [], "nothing typed — alpha is on the default already");
    ok((readJson(busPath(repo, "model-policy.json")).defaulted || []).includes("alpha|DEV-179"), "persisted");
  } finally { off(); }
});

const askOrchestrator = (repo, model, reason = "doc banking", at = "2026-09-14T04:00:00Z") =>
  fs.writeFileSync(busPath(repo, "orchestrator-model.json"), JSON.stringify({ model, reason, at }));
const poOn = (repo, chip) => frame("wid-po", poFrame("wid-po", repo).text.replace("Opus 5", chip));


suite("MS-001 R2: the tick records a refused injection (exit 0, 'ok': False) as NOT switched, note kept", async () => {
  const repo = makeRepo({ roles: { alpha: {} } }, "ms-r2");
  openProject(repo);
  setOrchestrator(repo, "product-owner", "wid-po");
  putHandoff(repo, "alpha", "MS-201", "claude-sonnet-5");
  const REFUSING = "import sys\nprint(\"loom_cdp] inject alpha: {'ok': False, 'role': 'alpha', 'note': 'typed text not confirmed in composer; NOT submitted'}\")\n";
  const off = await activate([frame("wid-a", "w" + marker("alpha") + footer("Opus 5"))], REFUSING);
  try {
    await settle(400);
    const rec = readJson(busPath(repo, "model-policy.json")).pending.alpha;
    eq(rec.lastError, "typed text not confirmed in composer; NOT submitted", "lastError is the injector's own note");
    ok(vscode._messages.warn.some((m) => /could not switch alpha off Opus 5 \(typed text not confirmed in composer; NOT submitted\)/.test(m)),
       "and the human is warned: " + JSON.stringify(vscode._messages.warn));
  } finally { off(); }
});

// ── MS-001 R2b: a worker must never BEGIN a handoff on the premium tier ─────────────────────────
// Measured on pleodo 2026-09-14T03:46:53Z: developer1/2/3 were spawned through open-requests.json,
// all three came up on Fable 5.1, all three were bound, and all three ran their whole handoff there
// (71/55/70 turns by 03:55Z). Their handoffs DID carry `model: claude-opus-5` — which IS the
// configured default, so the spawn's early return typed nothing at all, and the idle tick can never
// switch a composer that is busy from the moment `/loom` runs.

const spawnRequest = (repo, role) =>
  writeJson(busPath(repo, "open-requests.json"), { roles: [role], requestedAt: new Date().toISOString() });
/** The PO frame plus a new tab that only exists once editor.open has run. */
const spawnFrames = (repo, tab) => {
  const po = poFrame("wid-po", repo);
  return () => (vscode._executed.some((e) => e.id === "claude-vscode.editor.open") ? [po, tab] : [po]);
};

suite("MS-001 R2b: a fresh tab that comes up PREMIUM is typed into even though its handoff wants the default tier", async () => {
  const repo = makeRepo({ roles: { alpha: {} } }, "ms-r2b-typed");
  openProject(repo);
  setOrchestrator(repo, "product-owner", "wid-po");
  vscode._config["loomSessionTracker.modelAckMs"] = 300;
  putHandoff(repo, "alpha", "MS-210", "claude-opus-5");        // == the configured workerModel
  spawnRequest(repo, "alpha");
  clearInjectLog();
  // the pleodo case: the tab comes up on Fable and acknowledges the switch when typed into
  const tab = frame("wid-new", "You: /model claude-opus-5\nSet model to Opus 5 for this session only\n" + footer("Fable 5.1"));
  const off = await activate(spawnFrames(repo, tab), LOGGING_CDP);
  try {
    await settle(6000);
    const mine = injectLog().filter((l) => /--webview-id wid-new\b/.test(l));
    ok(/--message \/model claude-opus-5\b/.test(mine[0]), "FIRST /model, even though the handoff wants the default: " + JSON.stringify(mine));
    ok(/--message \/loom alpha\b/.test(mine[1]), "THEN the bind, the switch acknowledged: " + JSON.stringify(mine));
    const dbg = readJson(path.join(LOOM, "spawn-debug.json"));
    eq(dbg.model.acknowledged, "Opus 5", "the ack outcome is in spawn-debug.json: " + JSON.stringify(dbg.model));
    eq(dbg.model.ok, true);
  } finally { off(); }
});

suite("MS-001 R2b: a refused /model is RETRIED, and a tab still on premium is NOT bound — the frame and reason go back to the orchestrator", async () => {
  const repo = makeRepo({ roles: { alpha: {} } }, "ms-r2b-refused");
  openProject(repo);
  setOrchestrator(repo, "product-owner", "wid-po");
  vscode._config["loomSessionTracker.modelAckMs"] = 200;
  putHandoff(repo, "alpha", "MS-211", "claude-opus-5");
  spawnRequest(repo, "alpha");
  clearInjectLog();
  // the injector exits 0 and reports it did not submit (R2), and the tab stays on Fable
  const REFUSING =
    "import sys, os\n" +
    "p = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'inject-log.txt')\n" +
    "open(p, 'a').write(' '.join(sys.argv[1:]) + '\\n')\n" +
    "print(\"loom_cdp] inject alpha: {'ok': False, 'note': 'typed text not confirmed in composer; NOT submitted'}\")\n";
  const off = await activate(spawnFrames(repo, frame("wid-new", "a tab on the wrong tier\n" + footer("Fable 5.1"))), REFUSING);
  try {
    await settle(6000);
    const mine = injectLog().filter((l) => /--webview-id wid-new\b/.test(l));
    eq(mine.filter((l) => /--message \/model claude-opus-5\b/.test(l)).length, 2, "typed twice — retried, because a session-less composer is idle: " + JSON.stringify(mine));
    eq(mine.filter((l) => /--message \/loom/.test(l)).length, 0, "and NEVER bound: a worker must not begin a handoff on Fable");
    const res = readJson(busPath(repo, "open-requests.json"));
    const o = res.opened.find((x) => x.role === "alpha");
    eq(o.webviewId, "wid-new", "the frame is handed back so the orchestrator can reach the tab");
    eq(o.bound, false);
    match(o.note, /on premium — \/model refused/, "…with the reason on it: " + o.note);
    ok(res.refused.some((r) => r.role === "alpha" && /opened but NOT bound/.test(r.reason)), "refused, naming why: " + JSON.stringify(res.refused));
    ok(vscode._messages.warn.some((m) => /alpha's new tab is on a premium model, not Opus 5 .* NOT bound/.test(m)),
       "and the human is toasted: " + JSON.stringify(vscode._messages.warn));
    eq(readJson(path.join(LOOM, "spawn-debug.json")).model.onPremium, true, "recorded in spawn-debug.json");
  } finally { off(); }
});

suite("MS-001 R2b: no acknowledgement on a NON-premium tab still binds — an unbound tab is the worse loss", async () => {
  const repo = makeRepo({ roles: { alpha: {} } }, "ms-r2b-cheap");
  openProject(repo);
  setOrchestrator(repo, "product-owner", "wid-po");
  vscode._config["loomSessionTracker.modelAckMs"] = 150;
  putHandoff(repo, "alpha", "MS-212", "claude-sonnet-5");
  spawnRequest(repo, "alpha");
  clearInjectLog();
  const off = await activate(spawnFrames(repo, frame("wid-new", "a tab that never answers\n" + footer("Opus 5"))), LOGGING_CDP);
  try {
    await settle(6000);
    const mine = injectLog().filter((l) => /--webview-id wid-new\b/.test(l));
    ok(mine.some((l) => /--message \/loom alpha\b/.test(l)), "bound anyway — Opus is the wrong tier, not the premium one: " + JSON.stringify(mine));
    const res = readJson(busPath(repo, "open-requests.json"));
    ok(res.opened.some((x) => x.role === "alpha" && x.bound), "and reported bound");
  } finally { off(); }
});

// ── MP-002: the tick never types /model into an orchestrator, by any path ────────────────────────
// Owner, 2026-09-16: "The extension changing orchestrators model version. Must stop. It only applies
// to non-orchestrators." Driven through activate() -> tick -> the append-only inject log, because
// the two paths this removed both lived in the tick and a planner assertion would not have seen them.
// `enforceOrchestratorModel` is deliberately NOT set in any of these: the setting was the stopgap and
// is gone, so the behaviour must hold with it absent.

suite("MP-002: an orchestrator on the WORKER tier is left alone — the promotion is gone", async () => {
  const repo = makeRepo({ roles: {} }, "mp2-promote");
  openProject(repo);
  setOrchestrator(repo, "product-owner", "wid-po");
  clearInjectLog();
  const off = await activate([poFrame("wid-po", repo)], LOGGING_CDP);      // poFrame footer = Opus 5
  try {
    await settle(400);
    eq(modelInjections(), [], "nothing typed into the orchestrator: " + JSON.stringify(injectLog()));
    const st = readJson(busPath(repo, "model-policy.json"));
    ok(!st || !st.pending || !st.pending["product-owner"], "and it is not even pending");
  } finally { off(); }
});

suite("MP-002: an orchestrator-model.json asking for another tier is inert — nothing is typed, no ledger line", async () => {
  const repo = makeRepo({ roles: {} }, "mp2-selfshift");
  openProject(repo);
  setOrchestrator(repo, "product-owner", "wid-po");
  // exactly the file MS-001 R3 honoured, on a bus that still carries one
  fs.writeFileSync(busPath(repo, "orchestrator-model.json"),
    JSON.stringify({ model: "claude-sonnet-5", reason: "banking the memory doc", at: "2026-09-16T04:00:00Z" }));
  clearInjectLog();
  const off = await activate([frame("wid-po", poFrame("wid-po", repo).text.replace("Opus 5", "Fable 5.1"))], LOGGING_CDP);
  try {
    await settle(400);
    eq(modelInjections(), [], "the file is read by nothing: " + JSON.stringify(injectLog()));
    ok(!fs.existsSync(busPath(repo, "model-ledger.jsonl")), "and no self-shift line was written");
    ok(fs.existsSync(busPath(repo, "orchestrator-model.json")), "the file is left where it is — other buses' copies are not ours to delete");
  } finally { off(); }
});

suite("MP-002: with an orchestrator present, WORKERS are still switched — the policy did not stop applying", async () => {
  const repo = makeRepo({ roles: { alpha: {} } }, "mp2-workers-live");
  openProject(repo);
  setOrchestrator(repo, "product-owner", "wid-po");
  putHandoff(repo, "alpha", "MP-300", "claude-sonnet-5");
  fs.writeFileSync(busPath(repo, "orchestrator-model.json"), JSON.stringify({ model: "claude-sonnet-5", at: "2026-09-16T04:00:00Z" }));
  clearInjectLog();
  const off = await activate([poFrame("wid-po", repo),
                              frame("wid-a", "w" + marker("alpha") + footer("Opus 5"))], LOGGING_CDP);
  try {
    await settle(400);
    const inj = modelInjections();
    eq(inj.length, 1, "exactly one /model, and it is the worker's: " + JSON.stringify(injectLog()));
    ok(/--role alpha\b/.test(inj[0]) && /--webview-id wid-a\b/.test(inj[0]), "…into alpha's own frame: " + inj[0]);
    ok(!/wid-po/.test(inj[0]), "and never the orchestrator's");
  } finally { off(); }
});

suite("MP-002: the premium FLOOR still holds — a worker sitting on the orchestrator's tier is switched down", async () => {
  const repo = makeRepo({ roles: { alpha: {} } }, "mp2-floor");
  openProject(repo);
  setOrchestrator(repo, "product-owner", "wid-po");
  putHandoff(repo, "alpha", "MP-301", null);                   // no model: line -> the default
  clearInjectLog();
  const off = await activate([poFrame("wid-po", repo),
                              frame("wid-a", "w" + marker("alpha") + footer("Fable 5.1"))], LOGGING_CDP);
  try {
    await settle(400);
    const inj = modelInjections();
    eq(inj.length, 1, "the worker on the premium tier is switched down: " + JSON.stringify(injectLog()));
    ok(/--message \/model claude-opus-5\b/.test(inj[0]) && /--role alpha\b/.test(inj[0]), inj[0]);
  } finally { off(); }
});

suite("MP-002: a role whose frame resolves to the orchestrator's is not typed into, even under a worker's name", async () => {
  // The 2026-09-10 misroute: four buses carry a `developer1`, and a by-name injection content-resolved
  // into tfg_ua's orchestrator. Here the tracker resolves `alpha` to the PO's own frame.
  const repo = makeRepo({ roles: { alpha: {} } }, "mp2-misroute");
  openProject(repo);
  setOrchestrator(repo, "product-owner", "wid-po");
  putHandoff(repo, "alpha", "MP-302", "claude-sonnet-5");
  clearInjectLog();
  // one frame, carrying BOTH the PO's own identity and alpha's sign-off
  const off = await activate([frame("wid-po", poFrame("wid-po", repo).text + marker("alpha") + footer("Opus 5"))], LOGGING_CDP);
  try {
    await settle(400);
    eq(modelInjections(), [], "nothing typed into the orchestrator's frame: " + JSON.stringify(injectLog()));
  } finally { off(); }
});


// ── NT-001-R1 · THE STOP NOTIFIER OBEYS THE OPEN-WINDOW CONVENTION, END TO END ────────────────
//
// The DECISION is pure and pinned in quiet.test.js. THIS file exists because a pure decision nobody
// calls is worth nothing: the requirement lives in `runQuiet`, and a mutant that deletes the gate
// from the wiring would leave every unit test green. So these drive `activate()` itself and assert
// on what reached the sender.
//
// NOTHING REACHES HIS PHONE. `push.sendPush` and `push.preflight` are replaced on the module object
// for the duration; the real runner is never constructed and no container is contacted. That is
// structural, not careful — there is no code path from here to a notification.
const push = load("push.js");

/** Drive one activation with the notifier ARMED, and report what it tried to send. */
async function withQuiet(windowRead, body) {
  const realPre = push.preflight, realSend = push.sendPush, realWins = cdp.openWindowRoots;
  const sent = [];
  push.preflight = async () => ({ delivered: true, note: "fake door open" });
  push.sendPush = async (_cfg, title, bodyText, key) => { sent.push({ title, body: bodyText, key }); return { delivered: true, note: "fake sent" }; };
  cdp.openWindowRoots = async () => (typeof windowRead === "function" ? windowRead() : windowRead);
  vscode._config["loomSessionTracker.quietPushEnabled"] = true;
  vscode._config["loomSessionTracker.quietMinutes"] = 15;
  try { return await body(sent); }
  finally {
    push.preflight = realPre; push.sendPush = realSend; cdp.openWindowRoots = realWins;
    delete vscode._config["loomSessionTracker.quietPushEnabled"];
    delete vscode._config["loomSessionTracker.quietMinutes"];
    try { fs.unlinkSync(path.join(LOOM, "quiet-state.json")); } catch {}
  }
}

/** A bus whose only role stopped `minsAgo` minutes ago: the status file's MTIME is the watermark. */
function stoppedProject(minsAgo = 25) {
  const repo = makeRepo({ developer1: { session_id: "s", branch: "b", status: "idle" } });
  setStatus(repo, "developer1", { status: "idle", last_handled: "NT-001", last_line: "shipped 0.47.0" });
  const then = (Date.now() - minsAgo * 60_000) / 1000;
  fs.utimesSync(busPath(repo, "developer1", "status.json"), then, then);
  return repo;
}

suite("quiet wiring: a stopped project WITH ITS WINDOW OPEN is reported", async () => {
  const repo = stoppedProject();
  await withQuiet({ pages: 1, roots: [repo] }, async (sent) => {
    const off = await activate([]);
    try {
      await settle(80);
      const mine = sent.filter((s) => s.title.startsWith(repo));
      eq(mine.length, 1, "exactly one notification for the project whose window is open");
      match(mine[0].body, /Quiet since \d\d:\d\d/, "and it leads with WHEN it stopped");
    } finally { off(); }
  });
});

suite("quiet wiring: A STOPPED PROJECT WHOSE WINDOW IS CLOSED IS NEVER SENT, AND IS DROPPED", async () => {
  // His convention: he closes a window when he walks away on purpose. This is the whole block — if
  // this assertion can be removed without failing anything, the feature is an unfalsifiable claim.
  const repo = stoppedProject();
  await withQuiet({ pages: 2, roots: ["SomeOtherProject", "AndAnother"] }, async (sent) => {
    const off = await activate([]);
    try {
      await settle(80);
      eq(sent.filter((s) => s.title.startsWith(repo)).length, 0, "nothing was sent about it");
      const st = readJson(path.join(LOOM, "quiet-state.json"));
      const mine = st && st.projects && st.projects[repo];
      ok(mine, "the project's state was still written — the watermark advances regardless");
      eq(mine.notifiedFor, mine.lastActivityAt,
         "and the stop is LATCHED: dropped, not deferred, so a reopened window cannot backfill it");
    } finally { off(); }
  });
});

suite("quiet wiring: AN UNREADABLE WINDOW LIST WITHHOLDS AND LATCHES NOTHING", async () => {
  // The failure nobody complains about. If doubt latched, one bad `/json/list` would permanently
  // erase a notification he was owed.
  const repo = stoppedProject();
  await withQuiet(null, async (sent) => {
    const off = await activate([]);
    try {
      await settle(80);
      eq(sent.filter((s) => s.title.startsWith(repo)).length, 0, "nothing sent while we cannot tell");
      const st = readJson(path.join(LOOM, "quiet-state.json"));
      const mine = st && st.projects && st.projects[repo];
      ok(mine, "state written");
      eq(mine.notifiedFor, null, "NOT latched — the next readable tick still owes him this stop");
    } finally { off(); }
  });
});

suite("quiet wiring: openness is read AT SEND TIME — a window closed during preflight drops the stop", async () => {
  // He walks away, the threshold elapses, and he closes the window while the notifier is still
  // opening its door. By his convention that means do not tell him, so the read must happen AFTER
  // preflight, not when the stop was detected.
  const repo = stoppedProject();
  const realPre = push.preflight, realSend = push.sendPush, realWins = cdp.openWindowRoots;
  const sent = [];
  let closedYet = false;
  push.preflight = async () => { closedYet = true; return { delivered: true, note: "slow door" }; };
  push.sendPush = async (_c, title) => { sent.push(title); return { delivered: true, note: "x" }; };
  cdp.openWindowRoots = async () => (closedYet ? { pages: 1, roots: ["Elsewhere"] } : { pages: 1, roots: [repo] });
  vscode._config["loomSessionTracker.quietPushEnabled"] = true;
  try {
    const off = await activate([]);
    try {
      await settle(80);
      eq(sent.filter((t) => t.startsWith(repo)).length, 0,
         "the window that was open at DETECTION time was shut by SEND time — nothing sent");
    } finally { off(); }
  } finally {
    push.preflight = realPre; push.sendPush = realSend; cdp.openWindowRoots = realWins;
    delete vscode._config["loomSessionTracker.quietPushEnabled"];
    try { fs.unlinkSync(path.join(LOOM, "quiet-state.json")); } catch {}
  }
});

suite("quiet wiring: the notifier stays OFF BY DEFAULT — the setting alone arms it", async () => {
  const repo = stoppedProject();
  const realPre = push.preflight, realSend = push.sendPush;
  const sent = [];
  push.preflight = async () => ({ delivered: true, note: "would be open" });
  push.sendPush = async (_c, title) => { sent.push(title); return { delivered: true, note: "x" }; };
  try {
    const off = await activate([]);                   // quietPushEnabled untouched -> false
    try { await settle(80); eq(sent.length, 0, "nothing is sent, and preflight is never even reached"); }
    finally { off(); }
  } finally { push.preflight = realPre; push.sendPush = realSend; }
});


// ── NT-001-R2 · THE ORCHESTRATOR'S SUMMARY ACTUALLY REACHES THE SENDER ────────────────────────
//
// The DECISION is pure and pinned in quiet.test.js. THIS exists for the reason the R1 wiring tests
// exist, and the handoff named it outright: "a summary the sender never attaches would leave every
// unit test green." `orchestratorSaid` can be perfect and `quietMessage` can compose perfectly, and
// if `runQuiet` drops the second argument he still gets the old two lines and nobody finds out. So
// these drive `activate()` and assert on THE BODY THAT REACHED `sendPush`.
//
// NOTHING REACHES HIS PHONE: `withQuiet` replaces `push.sendPush` and `push.preflight` for the
// duration, so the real runner is never constructed and no container is contacted.

/** A stopped project whose ONE role is the tagged orchestrator, with a transcript it can be read
 *  from. One role, because a second role's fresh status.json would make the project look active. */
function stoppedWithOrchestrator(said, opts = {}) {
  const sid = opts.sid || "r2-sid-" + Math.random().toString(36).slice(2, 8);
  const repo = makeRepo({ po: { session_id: sid, branch: "main", status: "idle" } });
  setStatus(repo, "po", { status: "idle", session_id: opts.statusSid || sid,
                          last_handled: "NT-001-R2", last_line: "shipped 0.51.0" });
  setOrchestrator(repo, "po");
  if (said !== null) {
    const dir = path.join(PROJ, "-r2-" + repo);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, sid + ".jsonl"),
      JSON.stringify({ type: "assistant", isSidechain: false, timestamp: "2026-09-17T12:00:00.000Z",
                       message: { content: [{ type: "text", text: said }] } }) + "\n" +
      // A trailing tool call, because that is the real shape: the orchestrator speaks and then runs
      // a few more tools before the turn ends.
      JSON.stringify({ type: "assistant", isSidechain: false,
                       message: { content: [{ type: "tool_use", name: "Bash", input: { command: "git push" } }] } }) + "\n");
  }
  const then = (Date.now() - 25 * 60_000) / 1000;
  fs.utimesSync(busPath(repo, "po", "status.json"), then, then);
  return repo;
}

suite("R2 wiring: THE ORCHESTRATOR'S OWN WORDS REACH THE NOTIFICATION BODY", async () => {
  // This is the block. His words: "I want that summary to come along with the notification." If this
  // assertion can be deleted without failing anything, the feature is an unfalsifiable claim.
  const repo = stoppedWithOrchestrator("All three lanes are green. 981/981 both modes, committed as 46ef86b.");
  await withQuiet({ pages: 1, roots: [repo] }, async (sent) => {
    const off = await activate([]);
    try {
      await settle(80);
      const mine = sent.filter((s) => s.title.startsWith(repo));
      eq(mine.length, 1, "one notification");
      match(mine[0].body, /Quiet since \d\d:\d\d/, "it still says WHEN it stopped");
      match(mine[0].body, /981\/981 both modes, committed as 46ef86b\./,
            "AND it carries what the orchestrator actually said: " + JSON.stringify(mine[0].body));
      match(mine[0].body, /What po last said/, "attributed to the role, as its own account");
    } finally { off(); }
  });
});

suite("R2 wiring: a project with NO readable summary still gets EXACTLY today's notification", async () => {
  // "Fall back to exactly what NT-001 sends today and never send nothing." The existing job does not
  // depend on this feature working, and this is where that is proven end to end rather than in a
  // unit test of the composer.
  const repo = stoppedWithOrchestrator(null);           // tagged, but no transcript on disk
  await withQuiet({ pages: 1, roots: [repo] }, async (sent) => {
    const off = await activate([]);
    try {
      await settle(80);
      const mine = sent.filter((s) => s.title.startsWith(repo));
      eq(mine.length, 1, "the notification is still sent — never nothing");
      match(mine[0].body, /Quiet since \d\d:\d\d.*Last: po/, "with its original body intact");
      eq(/last said/.test(mine[0].body), false, "and no empty summary section stapled on");
    } finally { off(); }
  });
});

suite("R2 wiring: A STALE SESSION ID SENDS NO SUMMARY — it would quote a DEAD session at him", async () => {
  // PB-001's identity rule, end to end. The board and the role's own status.json name DIFFERENT
  // sessions, which means a transition is in flight. A transcript is addressed by session id, so
  // trusting the board here would read a session that ended hours ago and present its last words as
  // the thing that just finished — worse than sending no summary at all.
  const repo = stoppedWithOrchestrator("words from a session that has since been cleared",
                                       { sid: "r2-board-sid", statusSid: "r2-different-sid" });
  await withQuiet({ pages: 1, roots: [repo] }, async (sent) => {
    const off = await activate([]);
    try {
      await settle(80);
      const mine = sent.filter((s) => s.title.startsWith(repo));
      eq(mine.length, 1, "the notification still goes — the fallback, not silence");
      eq(/since been cleared/.test(mine[0].body), false, "but the dead session's words are NOT in it");
      eq(/last said/.test(mine[0].body), false, "no summary section at all");
    } finally { off(); }
  });
});

suite("R2 wiring: the body that reaches the sender is inside the transport's bound", async () => {
  // An over-long body is not truncated by FCM, it is a REJECTED send — a notification he never
  // learns was missed. So the bound is asserted on the real composed body, not on the helper.
  const repo = stoppedWithOrchestrator("The migration is complete and every lane is green. ".repeat(300));
  await withQuiet({ pages: 1, roots: [repo] }, async (sent) => {
    const off = await activate([]);
    try {
      await settle(80);
      const mine = sent.filter((s) => s.title.startsWith(repo));
      eq(mine.length, 1);
      const bytes = Buffer.byteLength(mine[0].body, "utf8");
      ok(bytes < 4096, "the composed body is " + bytes + " bytes, inside the ~4 KB payload bound");
      match(mine[0].body, /\[cut - \d+ of \d+ characters\]/,
            "and the cut is MARKED — a body ending mid-sentence reads as a crashed agent");
    } finally { off(); }
  });
});
