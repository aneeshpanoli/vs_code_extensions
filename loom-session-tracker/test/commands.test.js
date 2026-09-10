// commands.test.js — the command surface: what each registered command asks, what it refuses, and
// what it reports. extension.test.js covers activation and the digest; this file covers the handlers
// themselves, which were the largest untested region left (66% of extension.js).
//
// Everything runs through activate(), so the commands are exercised exactly as VS Code invokes them.
// Nothing here reaches CDP or git: readFrames and closeWebview are stubbed, and the injector is a
// python stub that just echoes its arguments.
const { suite, ok, eq, match, load, vscode, makeRepo, busPath, writeJson, readJson, settle, LOOM } =
  require("./harness");
const fs = require("fs");
const os = require("os");
const path = require("path");

const ext = load("extension.js");
const cdp = load("cdp.js");
const { setOrchestrator } = load("orchestrator.js");
const { setLock, isLocked } = load("locks.js");

const marker = (r) => "\nLOOMROLE=" + r + "\n";
const footer = (m = "Opus 5") => `\nRemote Control\n${m}\nMedium\nBypass permissions\n`;
const frame = (webviewId, text) => ({ webviewId, text, contextPct: null, type: "iframe", targetUrl: "x" });
const run = (id, ...args) => vscode.commands.executeCommand("loomSessionTracker." + id, ...args);

function openProject(repo) {
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), "loom-cmd-"));
  const dir = path.join(parent, repo);
  fs.mkdirSync(dir);
  vscode.workspace.workspaceFolders = [{ uri: { fsPath: dir } }];
  return dir;
}

/** Boot with a scripted CDP read; closeWebview is stubbed so no tab is ever really touched.
 *  `injector: "fail"` makes the loom_cdp.py stub exit non-zero, so the delivery-failure warnings
 *  (the only sign the user gets that a notification never landed) are exercised for real. */
async function activate(frames = [], closeResult = { ok: true, note: "closed" }, injector = "ok") {
  cdp.readFrames = async () => frames;
  cdp.closeWebview = async () => closeResult;
  fs.writeFileSync(path.join(LOOM, "loom_cdp.py"), injector === "fail"
    ? "import sys\nsys.exit(4)\n"
    : "import sys\nprint(' '.join(sys.argv[1:]))\n");
  const context = { subscriptions: [] };
  ext.activate(context);
  await settle();
  return () => { ext.deactivate(); for (const d of context.subscriptions) { try { d.dispose && d.dispose(); } catch {} } };
}
/** A project with the named roles on its board, an orchestrator tagged, and only `live` of them
 *  actually running (the rest stay spawnable). */
async function projectWithAgent(name, roles = { alpha: {} }, live = ["alpha"]) {
  const repo = makeRepo({ roles }, name);
  openProject(repo);
  setOrchestrator(repo, "product-owner", "wid-po");
  const off = await activate(live.map((r, i) => frame(`wid-${r}-${i}`, "working" + marker(r) + footer())));
  return { repo, off };
}
const infos = () => vscode._messages.info.join("\n");
const warns = () => vscode._messages.warn.join("\n");
const errors = () => vscode._messages.error.join("\n");

// ── status / counts ─────────────────────────────────────────────────────────
suite("command status: lists the tracked agents with their liveness", async () => {
  const { repo, off } = await projectWithAgent("cmdA");
  try {
    await run("status");
    match(infos(), new RegExp(`● ${repo}/alpha`), "live agent listed");
  } finally { off(); }
});

suite("command sessionCount: reports the editor-wide count and the threshold", async () => {
  const { off } = await projectWithAgent("cmdB");
  try {
    await run("sessionCount");
    match(infos(), /Simultaneous Claude sessions: 1/, "the measured count");
    match(infos(), /Within your threshold of 5/, "and how it compares to the threshold");
  } finally { off(); }
});

suite("command sessionCount: says so plainly before the first read", async () => {
  const repo = makeRepo({ roles: { alpha: {} } }, "cmdC");
  openProject(repo);
  const off = await activate([]);                 // a failed read: nothing counted yet
  try {
    fs.rmSync(path.join(LOOM, "active-sessions.json"), { force: true });
    await run("sessionCount");
    match(infos(), /no session count yet/, "explains the absence rather than showing zeros");
  } finally { off(); }
});

// ── spawn ───────────────────────────────────────────────────────────────────
suite("command spawn: offers only roles that are not already live", async () => {
  const { off } = await projectWithAgent("cmdD", { alpha: {}, beta: {} });
  try {
    let offered = null;
    vscode._quickPick = (items) => { offered = items; return undefined; };   // then cancel
    await run("spawn");
    eq(offered, ["beta"], "alpha is live, so only beta is spawnable");
    eq(vscode._executed.filter((e) => e.id === "claude-vscode.editor.open").length, 0, "cancelling opens nothing");
  } finally { off(); }
});

suite("command spawn: opens a session and tells you how to bind it", async () => {
  const { off } = await projectWithAgent("cmdE", { alpha: {}, beta: {} });
  try {
    vscode._quickPick = "beta";
    await run("spawn");
    ok(vscode._executed.some((e) => e.id === "claude-vscode.editor.open"), "a session was opened");
    match(infos(), /\/loom beta/, "tells you the binding command");
  } finally { off(); }
});

suite("command spawn: refuses past the active-session cap, and opens nothing", async () => {
  // Built FROM the cap, so raising it does not require editing this test — it needed editing when
  // the cap went 3 -> 5 on 2026-09-10, and a test that must be hand-adjusted to stay green is a test
  // that will one day be adjusted into agreeing with a bug.
  const { MAX_ACTIVE_TOTAL } = load("coordinator.js");
  const nAgents = MAX_ACTIVE_TOTAL - 1;                       // the orchestrator is the +1
  const roles = {};
  for (let i = 1; i <= nAgents + 1; i++) roles["a" + i] = {};   // one more role than fits
  const repo = makeRepo({ roles }, "cmdF");
  openProject(repo);
  setOrchestrator(repo, "product-owner", "wid-po");
  const off = await activate(Array.from({ length: nAgents }, (_, i) =>
    frame(`wid-a${i + 1}-${i + 1}`, "w" + marker("a" + (i + 1)) + footer())));
  try {
    vscode._quickPick = "a" + (nAgents + 1);
    await run("spawn");
    match(errors(), /REFUSED: cap reached/, "refused with the reason");
    eq(vscode._executed.filter((e) => e.id === "claude-vscode.editor.open").length, 0, "nothing opened");
  } finally { off(); }
});

// ── retire ──────────────────────────────────────────────────────────────────
suite("command retire: closes a confirmed live agent after confirmation", async () => {
  const { off } = await projectWithAgent("cmdG");
  try {
    vscode._quickPick = "alpha";
    vscode._warnAnswer = "Retire";
    await run("retire");
    match(infos(), /retired 'alpha'/, "closed and reported");
  } finally { off(); }
});

suite("command retire: an unconfirmed retire closes nothing", async () => {
  const { off } = await projectWithAgent("cmdH");
  try {
    vscode._quickPick = "alpha";
    vscode._warnAnswer = undefined;               // dismissed
    await run("retire");
    ok(!/retired/.test(infos()), "nothing retired");
  } finally { off(); }
});

suite("command retire: a LOCKED agent is refused", async () => {
  const { repo, off } = await projectWithAgent("cmdI");
  try {
    setLock(repo, "alpha", true);
    vscode._quickPick = "alpha";
    vscode._warnAnswer = "Retire";
    await run("retire");
    match(errors(), /LOCKED/, "refused because it is locked");
  } finally { off(); }
});

suite("command retire: a close that does not confirm is surfaced as an error", async () => {
  const repo = makeRepo({ roles: { alpha: {} } }, "cmdJ");
  openProject(repo);
  setOrchestrator(repo, "product-owner", "wid-po");
  const off = await activate([frame("wid-alpha-0", "w" + marker("alpha") + footer())],
                             { ok: false, note: "no live target" });
  try {
    vscode._quickPick = "alpha";
    vscode._warnAnswer = "Retire";
    await run("retire");
    match(errors(), /close did not confirm/, "the failure is reported, not swallowed");
  } finally { off(); }
});

// ── delete (the most destructive path: two confirmations) ───────────────────
suite("command delete: the typed name must match before anything is deleted", async () => {
  const { off } = await projectWithAgent("cmdK");
  try {
    vscode._quickPick = "alpha";
    vscode._warnAnswer = "Delete";
    vscode.window.showInputBox = () => Promise.resolve("not-alpha");
    await run("delete");
    match(infos(), /Delete cancelled \(name did not match\)/, "cancelled on a mismatch");
  } finally { off(); }
});

suite("command delete: dismissing the first warning stops it before the name prompt", async () => {
  const { off } = await projectWithAgent("cmdL");
  try {
    let asked = false;
    vscode._quickPick = "alpha";
    vscode._warnAnswer = undefined;
    vscode.window.showInputBox = () => { asked = true; return Promise.resolve("alpha"); };
    await run("delete");
    eq(asked, false, "never even asked for the name");
  } finally { off(); }
});

suite("command delete: a confirmed delete archives the role's artifacts", async () => {
  const { repo, off } = await projectWithAgent("cmdM");
  try {
    fs.mkdirSync(busPath(repo, "alpha"), { recursive: true });
    fs.writeFileSync(busPath(repo, "alpha", "outbox.md"), "done");
    vscode._quickPick = "alpha";
    vscode._warnAnswer = "Delete";
    vscode.window.showInputBox = () => Promise.resolve("alpha");
    await run("delete");
    ok(/deleted 'alpha'/.test(infos()) || /REFUSED|could not/.test(errors()),
      "either deleted or refused with a reason, never silent: " + infos() + errors());
  } finally { off(); }
});

// ── lock / unlock ───────────────────────────────────────────────────────────
suite("command lock/unlock: toggles protection for the node's agent", async () => {
  const { repo, off } = await projectWithAgent("cmdN");
  try {
    const node = { agent: { repo, role: "alpha" } };
    await run("lock", node);
    eq(isLocked(repo, "alpha"), true, "locked");
    await run("unlock", node);
    eq(isLocked(repo, "alpha"), false, "unlocked");
    await run("lock", undefined);                 // no node: must be a no-op, not a crash
    eq(isLocked(repo, "alpha"), false, "a command with no target does nothing");
  } finally { off(); }
});

// ── tagging ─────────────────────────────────────────────────────────────────
suite("command tagOrchestrator: offers the PO names first, then the project's roles", async () => {
  const repo = makeRepo({ roles: { alpha: {} } }, "cmdO");
  openProject(repo);
  const off = await activate([frame("wid-alpha-0", "w" + marker("alpha") + footer())]);
  try {
    let offered = null;
    vscode._quickPick = (items) => { offered = items; return undefined; };
    await run("tagOrchestrator");
    eq(offered.slice(0, 2), ["product-owner", "productowner"], "orchestrator names first");
    ok(offered.includes("alpha"), "then the roster");
  } finally { off(); }
});

suite("command untagOrchestrator: removes the tag and says notifications are off", async () => {
  const { repo, off } = await projectWithAgent("cmdP");
  try {
    await run("untagOrchestrator");
    eq(readJson(busPath(repo, "orchestrator.json")), null, "tag file gone");
    match(infos(), /untagged.*finish notifications off/, "and says what that means");
  } finally { off(); }
});

suite("command untagOrchestrator: with nothing tagged it says so instead of failing", async () => {
  const repo = makeRepo({ roles: { alpha: {} } }, "cmdQ");
  openProject(repo);
  const off = await activate([frame("wid-alpha-0", "w" + marker("alpha") + footer())]);
  try {
    await run("untagOrchestrator");
    match(infos(), /no orchestrator tagged/, "plain explanation");
  } finally { off(); }
});

// ── all-projects toggle ─────────────────────────────────────────────────────
suite("command toggleAllProjects: flips the setting and re-ticks", async () => {
  const { off } = await projectWithAgent("cmdR");
  try {
    await run("toggleAllProjects");
    match(vscode._statusMessages.join("\n"), /showing ALL projects/, "switched to every project");
  } finally { off(); }
});

// ── worktree report ─────────────────────────────────────────────────────────
suite("command worktreeReport: says there are none rather than showing an empty modal", async () => {
  const { off } = await projectWithAgent("cmdS");
  try {
    await run("worktreeReport");
    match(infos(), /no worktrees found/, "explicit about finding nothing");
  } finally { off(); }
});

suite("command worktreeReport: reports what it found and removes nothing unless confirmed", async () => {
  // Report first, act second: dismissing the modal must leave every directory exactly where it is.
  const repo = makeRepo({ roles: { alpha: {} } }, "cmdT");
  const dir = openProject(repo);
  setOrchestrator(repo, "product-owner", "wid-po");
  require("child_process").execFileSync("git", ["init", "-q", dir]);   // repoRoot() needs a real repo
  fs.mkdirSync(path.join(dir, ".claude", "worktrees", "ghost"), { recursive: true });
  const off = await activate([frame("wid-alpha-0", "w" + marker("alpha") + footer())]);
  try {
    vscode._answer = undefined;                   // dismiss the report modal
    await run("worktreeReport");
    match(infos(), /1 worktree\(s\); 1 orphaned/, "reports what it found");
    match(infos(), /orphan  clean .* ghost/, "with its per-worktree state");
    ok(fs.existsSync(path.join(dir, ".claude", "worktrees", "ghost")), "and nothing was removed");
  } finally { off(); }
});

// ── digest actions ──────────────────────────────────────────────────────────
suite("digest: 'Reopen sessions' opens exactly the roles you pick", async () => {
  const repo = makeRepo({ alpha: { session_id: "sid-alpha" } }, "cmdU");
  openProject(repo);
  setOrchestrator(repo, "product-owner", "wid-po");
  const off = await activate([]);                 // no live frames -> alpha's session is "missing"
  try {
    vscode._answer = "Reopen sessions";
    vscode._quickPick = (items) => items.filter((i) => i.label === "alpha");
    await run("digest");
    await settle(30);
    const opened = vscode._executed.filter((e) => e.id === "claude-vscode.editor.open");
    eq(opened.length, 1, "one session reopened");
    eq(opened[0].args[0], "sid-alpha", "by its recorded session id");
  } finally { off(); }
});

suite("digest: 'Details' shows the full rendered digest", async () => {
  const repo = makeRepo({ alpha: {} }, "cmdV");
  openProject(repo);
  const off = await activate([]);
  try {
    vscode._answer = "Details";
    await run("digest");
    await settle(30);
    match(infos(), /No orchestrator tagged/, "the detail text, not just the headline");
  } finally { off(); }
});

// ── what the user is told when something fails or needs attention ───────────
const transcript = (dirName, sessionId, tokens) => {
  const dir = path.join(os.homedir(), ".claude", "projects", dirName);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, sessionId + ".jsonl"), JSON.stringify({
    type: "assistant", sessionId, message: { model: "claude-opus-5", usage: { input_tokens: tokens } },
  }) + "\n");
  return dir;
};
const poFrame = (wid, repo, extra = {}) =>
  ({ ...frame(wid, `orchestrating ~/.claude/loom/${repo}/board.json ~/.claude/loom/${repo}/po/inbox.md `
      + marker("product-owner") + footer()), ...extra });

suite("tick: a stalled role is warned about, and the orchestrator is told", async () => {
  const repo = makeRepo({ roles: { alpha: {} } }, "rptA");
  openProject(repo);
  setOrchestrator(repo, "product-owner", "wid-po");
  // working, but its status file has not moved for hours -> the notifier can never see this.
  writeJson(busPath(repo, "alpha", "status.json"), { status: "working", current: "H-1" });
  const old = Date.now() - 5 * 3600_000;
  fs.utimesSync(busPath(repo, "alpha", "status.json"), new Date(old), new Date(old));
  const off = await activate([poFrame("wid-po", repo)]);
  try {
    await settle(60);
    match(warns(), /alpha has been "working" for 5\.0h with no status update/, "warned with the duration");
    ok(readJson(path.join(LOOM, "stall-debug.json")), "and the orchestrator was told");
  } finally { off(); }
});

suite("tick: a context-memory step that cannot be delivered is surfaced, not swallowed", async () => {
  const repo = makeRepo({ po: { session_id: "sid-rptB" } }, "rptB");
  openProject(repo);
  setOrchestrator(repo, "po", "wid-po");
  transcript("-rpt-b", "sid-rptB", 800000);
  const off = await activate([poFrame("wid-po", repo)], undefined, "fail");
  try {
    await settle(120);
    match(warns(), /could not deliver the context-memory save to po/, "says which step failed");
  } finally { off(); }
});

suite("tick: a cycle whose memory never arrives warns and clears nothing", async () => {
  const repo = makeRepo({ po: { session_id: "sid-rptC" } }, "rptC");
  openProject(repo);
  setOrchestrator(repo, "po", "wid-po");
  transcript("-rpt-c", "sid-rptC", 800000);
  // A save asked for long enough ago that the timeout has passed, and no memory.md was written.
  writeJson(busPath(repo, "context-state.json"),
    { phase: "saving", phaseAt: Date.now() - 30 * 60_000, memoryBaseline: 0, sessionId: "sid-rptC" });
  fs.rmSync(path.join(LOOM, "context-debug.json"), { force: true });   // this file is shared
  const off = await activate([poFrame("wid-po", repo)]);
  try {
    await settle(60);
    match(warns(), /did not write .*memory\.md within 10m — NOT clearing/, "explicit that nothing was destroyed");
    eq(readJson(busPath(repo, "context-state.json")).phase, "watch", "and the cycle is back to watching");
    eq(readJson(path.join(LOOM, "context-debug.json")), null, "nothing was injected at all — no /clear");
  } finally { off(); }
});

suite("tick: the orchestrator's frame is adopted when the tag has a stale one", async () => {
  // Frame ids change on a window reload; without this the injector would address a dead frame.
  const repo = makeRepo({ roles: { alpha: {} } }, "rptD");
  openProject(repo);
  setOrchestrator(repo, "product-owner", "wid-old");
  const off = await activate([poFrame("wid-new", repo)]);
  try {
    await settle(60);
    eq(readJson(busPath(repo, "orchestrator.json")).webviewId, "wid-new", "followed the live frame");
  } finally { off(); }
});

suite("tick: the panel's own context figure is what the tooltip shows when it is there", async () => {
  const repo = makeRepo({ po: { session_id: "sid-rptE" } }, "rptE");
  openProject(repo);
  setOrchestrator(repo, "po", "wid-po");
  transcript("-rpt-e", "sid-rptE", 100000);            // the estimate would say 10%
  const off = await activate([poFrame("wid-po", repo, { contextPct: 64 })]);
  try {
    await settle(60);
    match(vscode._statusItems[0].tooltip, /Orchestrator: 64% context used \(its own figure\)/,
      "the panel's number, not the estimate");
    eq(readJson(busPath(repo, "context-state.json")).triggerFromPanel, true, "and it is what triggered");
  } finally { off(); }
});

suite("tick: a usage-limited role is named in the status bar tooltip", async () => {
  const repo = makeRepo({ roles: { alpha: {} } }, "rptF");
  openProject(repo);
  setOrchestrator(repo, "product-owner", "wid-po");
  const limited = "work" + marker("alpha") +
    "\nYou've hit your session limit · resets in 2h\n" + footer();
  const off = await activate([frame("wid-alpha-0", limited)]);
  try {
    await settle(60);
    match(vscode._statusItems[0].tooltip, /LIMITED: alpha \(session limit, resets in 2h\)/, "named with its ETA");
    match(vscode._statusItems[0].tooltip, /resumed automatically when the limit lifts/, "and what happens next");
  } finally { off(); }
});

suite("command sessionCount: says plainly when you are over the threshold", async () => {
  const repo = makeRepo({ roles: { alpha: {} } }, "rptG");
  openProject(repo);
  setOrchestrator(repo, "product-owner", "wid-po");
  vscode._config["loomSessionTracker.sessionWarnThreshold"] = 1;
  const off = await activate([
    frame("wid-alpha-0", "w" + marker("alpha") + footer()),
    frame("wid-other-1", "another conversation" + footer()),
  ]);
  try {
    await run("sessionCount");
    match(infos(), /Above your threshold of 1/, "over the line");
    match(infos(), /ONE usage pool/, "and why that matters");
  } finally { off(); }
});

suite("command digest: says nothing needs you when nothing does", async () => {
  const repo = makeRepo({ roles: {} }, "rptH");
  openProject(repo);
  setOrchestrator(repo, "product-owner", "wid-po");
  const off = await activate([poFrame("wid-po", repo)]);
  try {
    await run("digest");
    await settle(30);
    match(infos(), /nothing needs your attention/, "plain all-clear");
  } finally { off(); }
});

suite("command bankContext: refuses with a reason when there is no orchestrator", async () => {
  const repo = makeRepo({ roles: { alpha: {} } }, "rptI");
  openProject(repo);
  const off = await activate([frame("wid-alpha-0", "w" + marker("alpha") + footer())]);
  try {
    await run("bankContext");
    match(warns(), /no orchestrator tagged — nothing to bank/, "explains why nothing happened");
  } finally { off(); }
});

suite("command worktreeReport: a confirmed removal keeps the branch and logs the way back", async () => {
  const repo = makeRepo({ roles: { alpha: {} } }, "rptJ");
  const dir = openProject(repo);
  setOrchestrator(repo, "product-owner", "wid-po");
  const git = (...a) => require("child_process").execFileSync("git", ["-C", dir, ...a], { stdio: "ignore" });
  require("child_process").execFileSync("git", ["init", "-q", dir]);
  git("config", "user.email", "t@t"); git("config", "user.name", "t");
  fs.writeFileSync(path.join(dir, "f.txt"), "x"); git("add", "."); git("commit", "-qm", "init");
  git("worktree", "add", "-q", "-b", "worktree-ghost", path.join(dir, ".claude", "worktrees", "ghost"));
  const off = await activate([frame("wid-alpha-0", "w" + marker("alpha") + footer())]);
  try {
    vscode._answer = (m, actions) => actions.find((a) => /^Remove/.test(a));   // the report's offer
    vscode._warnAnswer = "Remove";                                             // the confirmation
    await run("worktreeReport");
    await settle(60);
    ok(!fs.existsSync(path.join(dir, ".claude", "worktrees", "ghost")), "directory removed");
    match(infos(), /ghost: removed — branch worktree-ghost kept/, "branch kept, and said so");
    const log = readJson(path.join(LOOM, "worktree-removals.json"));
    ok(log.some((e) => e.role === "ghost" && e.branch === "worktree-ghost"), "removal logged with its branch");
  } finally { off(); }
});

suite("tick: a foreign orchestrator frame is never adopted as this project's", async () => {
  // The live bug this prevents (2026-09-09): the CDP read is editor-wide, so shwab_docker's PO frame
  // was the only candidate in every window and got tagged as the orchestrator of Gaming AND livegita.
  // A cycle there would have banked one project's memory into a session that had never seen it.
  const other = makeRepo({ roles: { x: {} } }, "cmdForeign");
  const repo = makeRepo({ po: { session_id: "sid-foreign" } }, "cmdW");
  openProject(repo);
  setOrchestrator(repo, "po", null);
  transcript("-cmd-w", "sid-foreign", 900000);          // 90% full: it would fire if it could
  const off = await activate([poFrame("wid-other", other)]);   // a PO frame belonging elsewhere
  try {
    await settle(60);
    eq(readJson(busPath(repo, "orchestrator.json")).webviewId, null, "not adopted");
    const st = readJson(busPath(repo, "context-state.json"));
    eq(st.phase, "watch", "and no cycle started");
  } finally { off(); }
});

suite("tick: the cycle runs on the panel alone when the role has no transcript", async () => {
  // `product-owner` is what the tag command offers first, and no board lists it — so there is no
  // session_id and no transcript. The compact button is the whole signal.
  const repo = makeRepo({ roles: { alpha: {} } }, "cmdX");
  openProject(repo);
  setOrchestrator(repo, "product-owner", "wid-po");
  const off = await activate([poFrame("wid-po", repo, { contextPct: 71 })]);
  try {
    await settle(80);
    const st = readJson(busPath(repo, "context-state.json"));
    eq(st.phase, "saving", "the cycle started with no transcript at all");
    eq(st.triggerPct, 71, "on the panel's own figure");
    eq(st.triggerFromPanel, true, "recorded as the panel's number");
    match(readJson(path.join(LOOM, "context-debug.json")).message, /71% full/, "and the prompt says so");
  } finally { off(); }
});

suite("tick: a weak candidate is offered but never silently adopted", async () => {
  // "Works on this project and is not one of its roles" is enough to OFFER a session for tagging;
  // it is not enough to start typing /clear into one without a click.
  const repo = makeRepo({ roles: { alpha: {} } }, "cmdY");
  openProject(repo);
  setOrchestrator(repo, "product-owner", null);
  // attributed to this repo, but it never signs itself as the orchestrator
  const weak = frame("wid-weak", `working in ~/.claude/loom/${repo}/ and Containers/${repo}/src` + footer());
  const off = await activate([{ ...weak, contextPct: 88 }]);
  try {
    await settle(60);
    eq(readJson(busPath(repo, "orchestrator.json")).webviewId, null, "not adopted despite being alone");
    const st = readJson(busPath(repo, "context-state.json"));
    ok(!st || st.phase === "watch", "and no cycle started");
    const tree = vscode._trees.loomSessions;
    const cands = tree.getChildren(tree.getChildren()[0]).filter((n) => n.kind === "ownerCandidate");
    eq(cands.length, 1, "but it IS offered in the tree");
    eq(cands[0].webviewId, "wid-weak", "as the candidate to tag");
  } finally { off(); }
});

suite("command tagOrchestrator: a click on a candidate records that exact frame", async () => {
  const repo = makeRepo({ roles: { alpha: {} } }, "cmdZ");
  openProject(repo);
  const weak = frame("wid-weak", `~/.claude/loom/${repo}/board.json Containers/${repo}/x` + footer());
  const off = await activate([weak]);
  try {
    const tree = vscode._trees.loomSessions;
    const cand = tree.getChildren(tree.getChildren()[0]).find((n) => n.kind === "ownerCandidate");
    await run("tagOrchestrator", cand);
    const tag = readJson(busPath(repo, "orchestrator.json"));
    eq(tag.webviewId, "wid-weak", "the clicked frame, not a guess");
    eq(tag.role, "product-owner", "tagged under the canonical name");
  } finally { off(); }
});

suite("tick: a second window on the same project does not double-inject", async () => {
  // Two windows, one repo (routine: a worktree window resolves to its parent repo id). The first
  // claims the cycle on the bus; the second must find it claimed and stand down.
  const repo = makeRepo({ roles: { alpha: {} } }, "cmdRace");
  openProject(repo);
  setOrchestrator(repo, "product-owner", "wid-po");
  const frames = [poFrame("wid-po", repo, { contextPct: 82 })];
  const offA = await activate(frames);
  await settle(80);
  const st = readJson(busPath(repo, "context-state.json"));
  eq(st.phase, "saving", "window A started the cycle");
  ok(st.owner, "and claimed it: " + st.owner);
  fs.rmSync(path.join(LOOM, "context-debug.json"), { force: true });
  offA();
  // A SECOND extension host over the same bus, same project, same frames.
  const offB = await activate(frames);
  try {
    await settle(80);
    eq(readJson(busPath(repo, "context-state.json")).owner, st.owner, "the claim did not change hands");
    eq(readJson(path.join(LOOM, "context-debug.json")), null, "and window B injected nothing");
  } finally { offB(); }
});
