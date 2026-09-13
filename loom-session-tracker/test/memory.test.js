// memory.test.js — the orchestrator context-memory cycle.
//
// decide() is pure, so every rule is asserted directly. The rules that matter most are the ones that
// REFUSE: /clear is irreversible from inside the session, so a save that did not happen, a stale memory
// file, or a session mid-turn must all mean "not yet" rather than "close enough".
const { suite, ok, eq, match, load, makeRepo, busPath, readJson, home } = require("./harness");
const fs = require("fs");
const path = require("path");
const {
  decide, loadState, saveState, defaultMemoryFile, statMemory, readOrchestratorContext,
  saveMessage, restoreMessage, CLEAR_MESSAGE, MIN_MEMORY_BYTES, DEFAULT_CONFIG,
} = load("memory.js");
const { transcriptFor } = load("context.js");

const MIN = 60_000;
const NOW = 1_800_000_000_000;

/** A reading as context.js would produce it. */
const reading = (tokens, sessionId = "s-old", file = "/tmp/x/s-old.jsonl") =>
  ({ tokens, fraction: tokens / 1_000_000, model: "claude-opus-5", at: null, sessionId, file });

/** Everything decide() needs, with a healthy default: 60% full, idle, memory doc absent. */
function input(over = {}) {
  return {
    repo: "demo", role: "po", webviewId: "wid-po",
    // a panel past 50% renders its compact button — the figure the cycle trusts (a panel without
    // one is under 50%, see "VETOES the transcript estimate")
    reading: reading(600_000), busy: false, frameSeen: true, panelPct: 60, panelChars: 150000,
    windowId: "win-A",
    memoryFile: "/tmp/demo/po/memory.md", memoryMtime: null, memorySize: 0,
    now: NOW, cfg: { ...DEFAULT_CONFIG }, state: { phase: "watch" },
    ...over,
  };
}

// ── watch ───────────────────────────────────────────────────────────────────
suite("memory: under the threshold nothing happens", () => {
  const s = decide(input({ panelPct: 40, reading: reading(400_000) }));
  eq(s.kind, "none", "no step");
  match(s.note, /40%/, "reports what it saw");
});

suite("memory: at the threshold the orchestrator is asked to bank its memory", () => {
  const s = decide(input());
  eq(s.kind, "save", "save step");
  eq(s.next.phase, "saving", "phase advances");
  eq(s.next.triggerTokens, 600_000, "records what triggered it");
  eq(s.next.memoryBaseline, 0, "baseline for an absent file is 0");
  eq(s.next.transcriptDir, "/tmp/x", "remembers where the fresh session will appear");
  match(s.message, /write your working memory to \/tmp\/demo\/po\/memory\.md/, "names the file");
  match(s.message, /this session is cleared/, "warns that the file is all that survives");
});

suite("memory: the panel's own percentage outranks the transcript estimate", () => {
  // The compact button's title is the app's own arithmetic over its own window (it divides by
  // contextWindow - maxOutputTokens - 13000). Where it has an opinion, it wins.
  const low = decide(input({ panelPct: 31, reading: reading(900_000) }));
  eq(low.kind, "none", "the panel says 31%, so nothing fires despite a big transcript");
  match(low.note, /context 31%/, "and reports the panel's figure");
  ok(!/estimated/.test(low.note), "not flagged as an estimate");
  const high = decide(input({ panelPct: 73, reading: reading(100_000) }));
  eq(high.kind, "save", "and the panel can trigger where the estimate would not");
  eq(high.next.triggerPct, 73, "recorded from the panel");
  eq(high.next.triggerFromPanel, true, "and marked as the panel's own number");
});

suite("memory: a visible panel with no compact button VETOES the transcript estimate", () => {
  // The button is only rendered past 50% used, so a panel we can see, holding a conversation, with
  // no button is under 50% — whatever a transcript says. Measured 2026-09-13: fourteen cycles in four
  // hours on Lumen's orchestrator, all on a 57% estimate off a dead transcript, all under a fresh
  // panel with no button.
  const s = decide(input({ panelPct: null, reading: reading(570_000) }));
  eq(s.kind, "none", "no save");
  match(s.note, /no compact button.*under 50%.*57% transcript estimate is not trusted/, "and says why");
  // The estimate is still what the token count and the session identity come from…
  const unseen = decide(input({ panelPct: null, frameSeen: false, panelChars: null }));
  eq(unseen.kind, "none", "…but an unseen frame is never typed into anyway");
  // …and below a 50% threshold the panel has no opinion, so the estimate decides.
  const low = decide(input({ panelPct: null, reading: reading(400_000), cfg: { ...DEFAULT_CONFIG, thresholdPct: 30 } }));
  eq(low.kind, "save", "threshold 30: the panel cannot rule on that, the estimate can");
  eq(low.next.triggerFromPanel, false, "marked as an estimate");
  match(low.note, /estimated/, "and said out loud");
  // a panel that is nearly empty (just cleared, or not rendered yet) is not a witness either way
  const empty = decide(input({ panelPct: null, panelChars: 200, reading: reading(600_000) }));
  eq(empty.kind, "save", "a 200-char panel says nothing about occupancy");
});

suite("memory: a session mid-turn is never typed into", () => {
  const s = decide(input({ busy: true }));
  eq(s.kind, "none", "waits");
  match(s.note, /waiting for the current turn/, "and says so");
});

suite("memory: the cooldown stops a second cycle from stacking up", () => {
  const s = decide(input({ state: { phase: "watch", lastCycleAt: NOW - 5 * MIN } }));
  eq(s.kind, "none", "held off");
  match(s.note, /cooldown/, "explains why");
  const later = decide(input({ state: { phase: "watch", lastCycleAt: NOW - 20 * MIN } }));
  eq(later.kind, "save", "past the cooldown it fires");
});

suite("memory: with neither a panel figure nor a transcript, nothing is done", () => {
  const s = decide(input({ reading: null, panelPct: null }));
  eq(s.kind, "none", "no action on an unknown context");
  match(s.note, /context unknown/, "says what is missing");
});

suite("memory: the panel alone is enough to run a cycle", () => {
  // The normal case for an orchestrator: measured 2026-09-09, both live tags name `product-owner`,
  // which no board lists — so there is no session_id, no transcript, and the panel is all there is.
  const s = decide(input({ reading: null, panelPct: 68 }));
  eq(s.kind, "save", "the cycle starts");
  eq(s.next.triggerPct, 68, "on the panel's number");
  eq(s.next.sessionId, undefined, "with no session identity to record");
  eq(s.next.transcriptDir, undefined, "and nowhere to watch for a new transcript");
  match(s.message, /68% full\./, "and the prompt states the percentage without inventing a token count");
});

suite("memory: an unidentified frame blocks the whole cycle", () => {
  // Injection into the orchestrator is by frame id; without one there is nothing safe to type into.
  const s = decide(input({ webviewId: null }));
  eq(s.kind, "none", "refused");
  match(s.note, /frame is not identified/, "explains it");
});

suite("memory: a frame we cannot see this tick is not typed into", () => {
  // Without the frame in the read, "not busy" is an assumption — and a /clear typed into a running
  // turn interrupts it. The save and clear steps wait; only the restore step is exempt.
  const s = decide(input({ frameSeen: false }));
  eq(s.kind, "none", "no save");
  match(s.note, /not seen this tick/, "says why");
  const clearing = decide(input({
    frameSeen: false, state: { phase: "saving", idleTicks: 9, phaseAt: NOW - MIN, memoryBaseline: 1000 },
    memoryMtime: 5000, memorySize: 4096,
  }));
  eq(clearing.kind, "none", "and no clear either");
});

suite("memory: the restore step still works on a panel too empty to recognise", () => {
  // A cleared panel holds ~170 characters, so it no longer detects as the orchestrator at all.
  const s = decide(input({
    frameSeen: false,
    state: { phase: "clearing", phaseAt: NOW - MIN, sessionId: "s-old", transcriptDir: "/tmp/x" },
    reading: reading(900, "s-new", "/tmp/x/s-new.jsonl"),
  }));
  eq(s.kind, "restore", "the cycle can finish");
});

suite("memory: disabled means disabled", () => {
  eq(decide(input({ cfg: { ...DEFAULT_CONFIG, enabled: false } })).kind, "none", "off");
});

// ── saving -> clearing: the dangerous transition ────────────────────────────
const saving = (over = {}) => input({
  state: { phase: "saving", idleTicks: 9, phaseAt: NOW - MIN, memoryBaseline: 1000, sessionId: "s-old",
           transcriptDir: "/tmp/x" },
  ...over,
});

suite("memory: /clear is sent only after the memory file is verifiably written", () => {
  const s = decide(saving({ memoryMtime: 2000, memorySize: 4096 }));
  eq(s.kind, "clear", "clears");
  eq(s.message, CLEAR_MESSAGE, "with /clear");
  eq(s.next.phase, "clearing", "phase advances");
  eq(s.next.sessionId, "s-old", "remembers the session id being replaced");
});

suite("memory: an OLD memory file is not a save", () => {
  // The file existing is not evidence; it has to be newer than the moment we asked.
  const s = decide(saving({ memoryMtime: 900, memorySize: 4096 }));
  eq(s.kind, "none", "not cleared");
  match(s.note, /waiting for the memory doc/, "still waiting");
});

suite("memory: a stub of a memory file is not a save either", () => {
  const s = decide(saving({ memoryMtime: 5000, memorySize: MIN_MEMORY_BYTES - 1 }));
  eq(s.kind, "none", "too small to be a handoff");
});

suite("memory: a banked memory still waits for the turn to end before clearing", () => {
  const s = decide(saving({ memoryMtime: 5000, memorySize: 4096, busy: true }));
  eq(s.kind, "none", "not while it is working");
  match(s.note, /banked; waiting/, "says what it is waiting for");
});

suite("memory: if the memory is never written the cycle ABORTS and clears nothing", () => {
  const s = decide(saving({ state: { phase: "saving", idleTicks: 9, phaseAt: NOW - 11 * MIN, memoryBaseline: 1000 } }));
  eq(s.kind, "abort", "aborts");
  eq(s.next.phase, "watch", "back to watching");
  eq(s.next.aborts, 1, "counted");
  match(s.note, /NOT clearing/, "and is explicit that nothing was destroyed");
  ok(s.next.lastCycleAt, "cooldown starts, so it does not immediately re-ask");
});

// ── clearing -> restore ─────────────────────────────────────────────────────
const clearing = (over = {}) => input({
  state: { phase: "clearing", phaseAt: NOW - MIN, sessionId: "s-old", transcriptDir: "/tmp/x",
           cycles: 2 },
  ...over,
});

suite("memory: a fresh session id is what proves the clear landed", () => {
  const s = decide(clearing({ reading: reading(1200, "s-new", "/tmp/x/s-new.jsonl") }));
  eq(s.kind, "restore", "restores");
  eq(s.next.phase, "watch", "cycle over");
  eq(s.next.sessionId, "s-new", "now watching the new session");
  eq(s.next.cycles, 3, "cycle counted");
  match(s.message, /1\. \/tmp\/demo\/po\/memory\.md/, "reads the memory doc first");
  match(s.message, /board\.json/, "then the board");
  match(s.message, /docs and the board win/, "and reconciles it against the docs");
});

suite("memory: the same session id means the clear has not happened yet", () => {
  const s = decide(clearing({ reading: reading(600_000, "s-old") }));
  eq(s.kind, "none", "no restore");
  match(s.note, /waiting for the cleared session/, "keeps waiting");
});

suite("memory: a clear that never lands aborts, and says the memory is safe", () => {
  const s = decide(clearing({ state: { phase: "clearing", phaseAt: NOW - 6 * MIN, sessionId: "s-old" },
                              reading: reading(600_000, "s-old") }));
  eq(s.kind, "abort", "gives up on the cycle");
  match(s.note, /memory doc is written and safe/, "reassures about the file");
});

// ── state on the bus ────────────────────────────────────────────────────────
suite("memory: the cycle survives an IDE restart", () => {
  const repo = makeRepo({ po: {} });
  eq(loadState(repo).phase, "watch", "fresh bus starts watching");
  saveState(repo, { phase: "saving", idleTicks: 9, phaseAt: 123, memoryBaseline: 5 });
  eq(loadState(repo).phase, "saving", "read back after a 'restart'");
  eq(loadState(repo).memoryBaseline, 5, "with its baseline");
  ok(readJson(busPath(repo, "context-state.json")).updatedAt, "stamped");
});

suite("memory: a corrupt state file degrades to watching, never throws", () => {
  const repo = makeRepo({ po: {} });
  fs.writeFileSync(busPath(repo, "context-state.json"), "}{");
  eq(loadState(repo).phase, "watch", "safe default");
});

suite("memory: the default memory doc lives on the role's own bus", () => {
  const repo = makeRepo({ po: {} });
  eq(defaultMemoryFile(repo, "po"), busPath(repo, "po", "memory.md"), "bus path");
  eq(statMemory(busPath(repo, "po", "memory.md")).mtime, null, "absent file reads as null");
  fs.mkdirSync(busPath(repo, "po"), { recursive: true });
  fs.writeFileSync(busPath(repo, "po", "memory.md"), "x".repeat(300));
  eq(statMemory(busPath(repo, "po", "memory.md")).size, 300, "size read back");
});

// ── which transcript is being read ──────────────────────────────────────────
function projectTranscript(dirName, sessionId, tokens, mtime) {
  const dir = path.join(home, ".claude", "projects", dirName);
  fs.mkdirSync(dir, { recursive: true });
  const f = path.join(dir, `${sessionId}.jsonl`);
  fs.writeFileSync(f, JSON.stringify({
    type: "assistant", sessionId, message: { model: "claude-opus-5", usage: { input_tokens: tokens } },
  }) + "\n");
  if (mtime) fs.utimesSync(f, new Date(mtime), new Date(mtime));
  return { dir, file: f };
}

suite("memory: while watching, the board's session id is what gets read", () => {
  const repo = makeRepo({ po: { session_id: "sid-watch" } });
  projectTranscript("-mem-watch", "sid-watch", 700000);
  const r = readOrchestratorContext(repo, "po", { phase: "watch" }, 1000000);
  eq(r.tokens, 700000, "read from the board's session");
});

suite("memory: while clearing, the FRESH transcript in the same directory is what counts", () => {
  const repo = makeRepo({ po: { session_id: "sid-old" } });
  const { dir } = projectTranscript("-mem-clear", "sid-old", 800000, 1000);
  projectTranscript("-mem-clear", "sid-new", 900);
  const r = readOrchestratorContext(repo, "po",
    { phase: "clearing", sessionId: "sid-old", transcriptDir: dir, phaseAt: 0 }, 1000000);
  eq(r.sessionId, "sid-new", "the new session is found");
  eq(r.tokens, 900, "and it is nearly empty");
});

suite("memory: with no fresh transcript, clearing keeps reading the old one", () => {
  // Which is what makes decide() say 'not yet' instead of mistaking silence for a successful clear.
  const repo = makeRepo({ po: { session_id: "sid-only" } });
  const { dir } = projectTranscript("-mem-noclear", "sid-only", 800000);
  const r = readOrchestratorContext(repo, "po",
    { phase: "clearing", sessionId: "sid-only", transcriptDir: dir, phaseAt: Date.now() + 60000 },
    1000000);
  eq(r.sessionId, "sid-only", "still the old session");
});

suite("memory: no session id anywhere means no reading at all", () => {
  const repo = makeRepo({ po: {} });
  eq(readOrchestratorContext(repo, "po", { phase: "watch" }), null, "nothing to read");
});

// ── the prompts ─────────────────────────────────────────────────────────────
suite("memory: the save prompt asks for the things a fresh context actually needs", () => {
  const m = saveMessage("/bus/memory.md", 612345, 61);
  match(m, /61% full/, "states the pressure");
  match(m, /612,345 tokens/, "with the number");
  match(m, /exact next step/, "the next step");
  match(m, /what it owes you/, "per-role state");
  match(m, /decisions already made/, "decisions, so they are not re-litigated");
  match(m, /do not summarise in chat/i, "the file, not the chat");
});

suite("memory: the restore prompt re-establishes who it is and what to trust", () => {
  const m = restoreMessage("/bus/memory.md", "demo", "po");
  match(m, /you are po, the orchestrator of demo/, "identity");
  match(m, /~\/\.claude\/loom\/demo\/board\.json/, "the board");
  match(m, /correct \/bus\/memory\.md on the spot/, "keeps the memory doc true");
  match(m, /REBIND: the clear gave you a NEW session id.*board\.json entry has been updated.*\$CLAUDE_SESSION_ID/, "and tells it to confirm the rebind");
});

suite("orchestrator: rebindSession records the post-/clear session id on the board and nothing else changes", () => {
  const { rebindSession } = load("orchestrator.js");
  const nested = makeRepo({ roles: { po: { session_id: "sid-old", branch: "main", webview_id: "wid-po" }, dev: { session_id: "sid-dev" } } });
  ok(rebindSession(nested, "po", "sid-new"), "written");
  const b = readJson(busPath(nested, "board.json"));
  eq(b.roles.po.session_id, "sid-new"); eq(b.roles.po.webview_id, "wid-po", "webview id kept"); eq(b.roles.po.branch, "main");
  eq(b.roles.dev.session_id, "sid-dev", "other roles untouched");
  ok(b.roles.po.rebound_by, "says who wrote it");
  ok(!rebindSession(nested, "po", "sid-new"), "same id: no write");
  const flat = makeRepo({ productowner: { session_id: "sid-old" }, developer1: { session_id: "d1" } });
  ok(rebindSession(flat, "productowner", "sid-new2"));
  eq(readJson(busPath(flat, "board.json")).productowner.session_id, "sid-new2", "flat boards too");
  eq(readJson(busPath(flat, "board.json")).developer1.session_id, "d1");
  ok(!rebindSession("no-such-repo-xyz", "po", "s"), "missing board: false, never throws");
  // the tag's spelling differs from the board's (Gaming: tag product-owner, board productowner)
  const spelt = makeRepo({ productowner: { session_id: "sid-old", webview_id: "w" }, developer: { session_id: "d" } });
  ok(rebindSession(spelt, "product-owner", "sid-new3"));
  const sb = readJson(busPath(spelt, "board.json"));
  eq(sb.productowner.session_id, "sid-new3", "the existing owner row is corrected");
  ok(!sb["product-owner"], "no second owner row is invented");
  // a board with no owner entry at all (funisland) is left alone
  const none = makeRepo({ gamification: { session_id: "g" }, curriculum: { session_id: "c" } });
  ok(!rebindSession(none, "product-owner", "sid-new4"), "nothing to correct");
  eq(Object.keys(readJson(busPath(none, "board.json"))).sort(), ["curriculum", "gamification"], "no row added");
});

// ── confirming a clear with no transcript to check ──────────────────────────
suite("memory: an emptied panel is proof enough that /clear landed", () => {
  // A cleared tab renders ~170 characters and loses its compact button; the live orchestrator
  // conversation it replaces was 145,680.
  const s = decide(input({
    state: { phase: "clearing", phaseAt: NOW - MIN, sessionId: undefined },
    reading: null, panelPct: null, panelChars: 170,
  }));
  eq(s.kind, "restore", "restored");
  match(s.note, /panel emptied/, "and says which witness it used");
  eq(s.next.cycles, 1, "cycle counted");
});

suite("memory: a still-full panel is not a clear", () => {
  const s = decide(input({
    state: { phase: "clearing", phaseAt: NOW - MIN, sessionId: undefined },
    reading: null, panelPct: null, panelChars: 145680,
  }));
  eq(s.kind, "none", "no restore");
  match(s.note, /waiting for the cleared session/, "keeps waiting");
});

suite("memory: a small panel that still shows a context button has NOT been cleared", () => {
  // Belt and braces: the button only exists past 50% used, so its presence contradicts a clear.
  const s = decide(input({
    state: { phase: "clearing", phaseAt: NOW - MIN, sessionId: undefined },
    reading: null, panelPct: 62, panelChars: 500,
  }));
  eq(s.kind, "none", "not treated as cleared");
});

suite("memory: an unseen panel during clearing is not mistaken for an empty one", () => {
  const s = decide(input({
    state: { phase: "clearing", phaseAt: NOW - MIN, sessionId: undefined },
    reading: null, panelPct: null, panelChars: null, frameSeen: false,
  }));
  eq(s.kind, "none", "unknown is not proof");
});

// ── two windows, one project ────────────────────────────────────────────────
// Measured 2026-09-09: nine windows open, the CDP read is editor-wide, and a worktree window
// resolves to its PARENT repo id — so two windows are routinely scoped to the same project. Before
// the lease, both decided every step off the same state: both sent the save prompt, and both sent
// `/clear`, the second landing in the session the first had just restored.
const { LEASE_MS } = load("memory.js");

suite("memory: only one window may start a cycle", () => {
  const first = decide(input({ windowId: "win-A", panelPct: 80 }));
  eq(first.kind, "save", "the first window claims it");
  eq(first.next.owner, "win-A", "and is recorded as the driver");
  const second = decide(input({ windowId: "win-B", panelPct: 80, state: first.next }));
  eq(second.kind, "none", "the second window stands down");
  match(second.note, /another window is running this cycle/, "and says why");
});

suite("memory: the second window does NOT also send /clear", () => {
  // The one that actually destroys something: a duplicate /clear lands in the freshly restored session.
  const saving = { phase: "saving", idleTicks: 9, phaseAt: NOW - MIN, memoryBaseline: 0,
                   owner: "win-A", ownerAt: NOW - MIN };
  const mine = decide(input({ windowId: "win-A", state: saving, memoryMtime: NOW, memorySize: 5000 }));
  eq(mine.kind, "clear", "the owner clears");
  const theirs = decide(input({ windowId: "win-B", state: saving, memoryMtime: NOW, memorySize: 5000 }));
  eq(theirs.kind, "none", "the other window does not");
});

suite("memory: a window that goes away does not strand the project", () => {
  const stale = { phase: "saving", idleTicks: 9, phaseAt: NOW - MIN, memoryBaseline: 0,
                  owner: "win-gone", ownerAt: NOW - LEASE_MS - 1 };
  const s = decide(input({ windowId: "win-B", state: stale, memoryMtime: NOW, memorySize: 5000 }));
  eq(s.kind, "clear", "the lease has expired, so another window may take over");
  eq(s.next.owner, "win-B", "and it takes ownership as it acts");
});

suite("memory: the owner keeps its claim alive while it waits", () => {
  const held = { phase: "saving", idleTicks: 9, phaseAt: NOW - MIN, memoryBaseline: 1000,
                 owner: "win-A", ownerAt: NOW - LEASE_MS + 1000 };   // past half-life
  const s = decide(input({ windowId: "win-A", state: held }));       // still waiting for the file
  eq(s.kind, "none", "nothing to do yet");
  eq(s.next.ownerAt, NOW, "but the lease is refreshed so it is not overtaken mid-wait");
});

suite("memory: a finished cycle releases the claim", () => {
  const clearing = { phase: "clearing", phaseAt: NOW - MIN, owner: "win-A", ownerAt: NOW - 1000 };
  const s = decide(input({ windowId: "win-A", state: clearing, reading: null,
                           panelPct: null, panelChars: 170 }));
  eq(s.kind, "restore", "cycle completes");
  eq(s.next.owner, undefined, "and the next cycle is anyone's to claim");
});

suite("memory: an aborted cycle releases the claim too", () => {
  const s = decide(input({ windowId: "win-A", state: {
    phase: "saving", idleTicks: 9, phaseAt: NOW - 11 * MIN, memoryBaseline: 0, owner: "win-A", ownerAt: NOW - 1000 } }));
  eq(s.kind, "abort", "gives up");
  eq(s.next.owner, undefined, "claim released, so a retry is not blocked by a dead lease");
});

suite("memory: state written before leases existed is adoptable", () => {
  // 0.13.x wrote no owner at all; an in-flight cycle must not deadlock on upgrade.
  const legacy = { phase: "saving", idleTicks: 9, phaseAt: NOW - MIN, memoryBaseline: 0 };
  const s = decide(input({ windowId: "win-B", state: legacy, memoryMtime: NOW, memorySize: 5000 }));
  eq(s.kind, "clear", "an unowned cycle is claimable");
  eq(s.next.owner, "win-B", "and gets an owner from here on");
});

suite("memory: re-tagging mid-cycle abandons it rather than clearing on the wrong file", () => {
  // The baseline was taken from po/memory.md. If the tag moves to another role, its memory.md may
  // already exist and be newer — which would read as "banked" and send /clear to the new session.
  const saving = { phase: "saving", idleTicks: 9, phaseAt: NOW - MIN, memoryBaseline: 1000,
                   role: "po", memoryFile: "/m/po/memory.md", owner: "win-A", ownerAt: NOW };
  const s = decide(input({ windowId: "win-A", state: saving, role: "other",
                           memoryFile: "/m/other/memory.md", memoryMtime: NOW, memorySize: 9000 }));
  eq(s.kind, "abort", "abandoned");
  match(s.note, /Nothing cleared/, "and explicit that nothing was destroyed");
  eq(s.next.phase, "watch", "back to watching");
  eq(s.next.owner, undefined, "claim released so the new target can start cleanly");
});

suite("memory: pointing contextMemoryFile somewhere else mid-cycle does the same", () => {
  const saving = { phase: "saving", idleTicks: 9, phaseAt: NOW - MIN, memoryBaseline: 1000,
                   role: "po", memoryFile: "/m/po/memory.md" };
  const s = decide(input({ state: saving, memoryFile: "/elsewhere/memory.md",
                           memoryMtime: NOW, memorySize: 9000 }));
  eq(s.kind, "abort", "the file it is judging must be the file it asked for");
});

suite("memory: an unchanged target proceeds normally", () => {
  const saving = { phase: "saving", idleTicks: 9, phaseAt: NOW - MIN, memoryBaseline: 1000,
                   role: "po", memoryFile: "/tmp/demo/po/memory.md" };   // == the input's file
  eq(decide(input({ state: saving, memoryMtime: 2000, memorySize: 4096 })).kind, "clear",
    "same role, same file -> the cycle continues");
});

// ── the orchestrator must be IDLE, and stay idle, before /clear ──────────────────────────────────

suite("memory: /clear waits for consecutive idle readings, not one", async () => {
  // User request 2026-09-10: "when sending clear to free context from the orchestrator, make sure it
  // is idle in order to not disrupt the ongoing process." One idle reading is a single sample of a
  // panel that updates several times a second — a turn pausing between tool calls reads idle.
  const { IDLE_TICKS_REQUIRED } = load("memory.js");
  const banked = { phase: "saving", memoryBaseline: NOW - MIN, role: "po",
                   memoryFile: "/tmp/demo/po/memory.md", owner: "win-A", ownerAt: NOW };
  const saved = { memoryMtime: NOW, memorySize: MIN_MEMORY_BYTES + 10 };

  // busy -> never clears, and the idle run resets
  let st = { ...banked, idleTicks: IDLE_TICKS_REQUIRED - 1 };
  const busy = decide(input({ state: st, busy: true, ...saved }));
  eq(busy.kind, "none", "a busy orchestrator is never cleared");
  match(busy.note, /waiting for the turn to end/, "and says why");
  eq(busy.next.idleTicks, 0, "one busy reading resets the run — it must be UNBROKEN");

  // idle, but not yet long enough
  st = { ...banked, idleTicks: 0 };
  const first = decide(input({ state: st, busy: false, ...saved }));
  eq(first.kind, "none", `one idle reading is not enough (need ${IDLE_TICKS_REQUIRED})`);
  match(first.note, /idle for 1 of 2 checks/, "reports progress toward the confirmation");
  eq(first.next.idleTicks, 1);

  // idle again -> now it clears
  const second = decide(input({ state: first.next, busy: false, ...saved }));
  eq(second.kind, "clear", "consecutive idle readings allow the clear");
  eq(second.message, CLEAR_MESSAGE);
  eq(second.next.idleTicks, 0, "the counter resets once the clear is sent");
});

suite("memory: a frame that was not seen this tick can never be cleared", () => {
  // busy is a GUESS when the frame was not in the read, and a /clear typed into a running turn
  // interrupts it. The save step and the clear step both require a frame we can actually see.
  const banked = { phase: "saving", memoryBaseline: NOW - MIN, role: "po",
                   memoryFile: "/tmp/demo/po/memory.md", idleTicks: 99 };
  const s = decide(input({ state: banked, frameSeen: false, busy: false,
                           memoryMtime: NOW, memorySize: MIN_MEMORY_BYTES + 10 }));
  eq(s.kind, "none", "no frame, no clear — however idle it looks");
  match(s.note, /not seen this tick/, "and the reason names the real uncertainty");
});

suite("memory: a known transcript that stopped before the last clear is dead — the cycle does not loop on it", () => {
  // The panel-emptied witness keeps the OLD session id; its file then reads as full forever.
  const repo = makeRepo({ po: { session_id: "sid-dead" } });
  const { dir } = projectTranscript("-mem-dead", "sid-dead", 572_000, Date.now() - 60 * 60_000);   // written an hour ago
  const cleared = Date.now() - 30 * 60_000;                                                          // cleared half an hour ago
  eq(readOrchestratorContext(repo, "po", { phase: "watch", sessionId: "sid-dead", transcriptDir: dir, lastCycleAt: cleared }, 1000000),
     null, "nothing written since the clear: no reading, not a stale one");
  projectTranscript("-mem-dead", "sid-fresh", 90_000, Date.now());                                  // the session that /clear started
  const r = readOrchestratorContext(repo, "po", { phase: "watch", sessionId: "sid-dead", transcriptDir: dir, lastCycleAt: cleared }, 1000000);
  eq(r.sessionId, "sid-fresh", "the transcript written since the clear is the session");
  eq(r.tokens, 90_000);
  // …and the board's id alone, with no cycle yet, is still read as before
  eq(readOrchestratorContext(repo, "po", { phase: "watch" }, 1000000).sessionId, "sid-dead", "no clear yet: the board's session");
});

suite("memory: a session id that exists in two project directories is read from the copy still being written", () => {
  // Measured 2026-09-13: Lumen's orchestrator had a copy under Gaming's dir (last written 09-10, 57%)
  // and the live one under Lumen's (77%); the cycle read the stale one.
  // The stale copy sorts FIRST in the projects directory (as Gaming's did before Lumen's), so a
  // first-found lookup returns it; only mtime picks the right one.
  projectTranscript("-mem-copy-a-stale", "sid-twice", 570_000, Date.now() - 3 * 24 * 3600_000);
  const { file } = projectTranscript("-mem-copy-z-live", "sid-twice", 766_000, Date.now());
  eq(transcriptFor("sid-twice"), file, "the newest copy, not the first found");
  // and the other order too
  const { file: live2 } = projectTranscript("-mem-copy2-a-live", "sid-twice2", 766_000, Date.now());
  projectTranscript("-mem-copy2-z-stale", "sid-twice2", 570_000, Date.now() - 3 * 24 * 3600_000);
  eq(transcriptFor("sid-twice2"), live2, "newest wins in either order");
});
