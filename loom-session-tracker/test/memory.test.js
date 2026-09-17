// memory.test.js — the orchestrator context-memory cycle.
//
// decide() is pure, so every rule is asserted directly.
//
// CX-001 REWROTE THE HALF OF THIS FILE THAT ASSERTED A CLEAR. The owner's instruction was "do not ever
// clear the orchestrator's context", so the suites that used to require `kind === "clear"` now require
// that no clear is EVER produced, from any state. What stayed: a save that did not happen and a stale
// memory file still mean "not yet", because the banked file is the whole point of the subsystem.
const { suite, ok, eq, match, load, makeRepo, busPath, readJson, home } = require("./harness");
const fs = require("fs");
const os = require("os");
const path = require("path");
const {
  decide, loadState, saveState, defaultMemoryFile, statMemory, readOrchestratorContext,
  saveMessage, restoreMessage, MIN_MEMORY_BYTES, DEFAULT_CONFIG,
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
suite("memory: the default threshold is 30% (2026-09-13: context length is the cost)", () => {
  eq(DEFAULT_CONFIG.thresholdPct, 30);
  eq(decide(input({ panelPct: null, reading: reading(310_000) })).kind, "save", "31% estimate fires (the panel cannot rule below 50)");
  eq(decide(input({ panelPct: null, reading: reading(290_000) })).kind, "none", "29% does not");
});

// WL-004 REVERSED TWO OF THIS SUITE'S ASSERTIONS ON PURPOSE. It used to require that the save prompt
// "names the cap" and that the clear note "says to trim it"; both are now exactly what must NOT
// appear, because that sentence made an orchestrator destroy the record of the owner's stated product
// goal to fit inside it. The rest of the contract is unchanged and still asserted here; the two
// reversed halves are asserted in the WL-004 suites, as absences.
suite("memory: the prompts carry the memory contract — concision, UNSURE section, notes split, no watchers", () => {
  const { MAX_MEMORY_BYTES } = load("memory.js");
  const save = saveMessage("/bus/po/memory.md", 400000, 40);
  match(save, /section "UNSURE"/, "asks for what is believed but unverified");
  match(save, /every line has to earn its place/, "asks for concision as FORM, with no threshold");
  match(save, /notes\.md, appended, never rewritten/, "durable lessons go to notes.md");
  const restore = restoreMessage("/bus/po/memory.md", "demo", "po");
  match(restore, /2\. \/bus\/po\/notes\.md — your durable notes, if the file exists/, "notes read once");
  match(restore, /each role's status\.json/, "status files, not just the board");
  match(restore, /ONLY the project docs the memory names — not CLAUDE\.md and docs\/ wholesale/, "docs narrowed");
  match(restore, /Do NOT arm watchers, Monitors or \/loop/, "no watchers (playbook §17)");
  // an oversize memory is still a banked memory — with a note
  const fat = decide(input({ state: { phase: "saving", phaseAt: NOW - 60_000, memoryBaseline: 0 },
                             memoryMtime: NOW - 1000, memorySize: MAX_MEMORY_BYTES + 1 }));
  eq(fat.next.phase, "banked", "a fat memory is still a banked memory");
  match(fat.note, /large; every fresh context re-reads it in full/,
        "and the note OBSERVES the cost instead of ordering a trim against a number");
});

suite("memory: under the threshold nothing happens", () => {
  const s = decide(input({ panelPct: 20, reading: reading(200_000) }));
  eq(s.kind, "none", "no step");
  match(s.note, /20%/, "reports what it saw");
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
  const low = decide(input({ panelPct: 21, reading: reading(900_000) }));
  eq(low.kind, "none", "the panel says 21%, so nothing fires despite a big transcript");
  match(low.note, /context 21%/, "and reports the panel's figure");
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
  const at50 = { ...DEFAULT_CONFIG, thresholdPct: 50 };   // the veto is the panel's opinion at 50; below that it has none
  const s = decide(input({ panelPct: null, reading: reading(570_000), cfg: at50 }));
  eq(s.kind, "none", "no save");
  match(s.note, /no compact button.*under 50%.*57% transcript estimate is not trusted/, "and says why");
  // The estimate is still what the token count and the session identity come from…
  const unseen = decide(input({ panelPct: null, frameSeen: false, panelChars: null, cfg: at50 }));
  eq(unseen.kind, "none", "…but an unseen frame is never typed into anyway");
  // …and below a 50% threshold the panel has no opinion, so the estimate decides.
  const low = decide(input({ panelPct: null, reading: reading(400_000), cfg: { ...DEFAULT_CONFIG, thresholdPct: 30 } }));
  eq(low.kind, "save", "threshold 30: the panel cannot rule on that, the estimate can");
  eq(low.next.triggerFromPanel, false, "marked as an estimate");
  match(low.note, /estimated/, "and said out loud");
  // a panel that is nearly empty (just cleared, or not rendered yet) is not a witness either way
  const empty = decide(input({ panelPct: null, panelChars: 200, reading: reading(600_000), cfg: at50 }));
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
  // Without the frame in the read there is no evidence about the session at all, and the save prompt
  // should not go out on a guess. Only the `banked` phase is exempt, because a cleared panel is
  // exactly the thing that stops being recognisable.
  const s = decide(input({ frameSeen: false }));
  eq(s.kind, "none", "no save");
  match(s.note, /not seen this tick/, "says why");
});

suite("memory: the restore step still works on a panel too empty to recognise", () => {
  // A cleared panel holds ~170 characters, so it no longer detects as the orchestrator at all.
  const s = decide(input({
    frameSeen: false,
    state: { phase: "banked", phaseAt: NOW - MIN, sessionId: "s-old", transcriptDir: "/tmp/x" },
    reading: reading(900, "s-new", "/tmp/x/s-new.jsonl"),
  }));
  eq(s.kind, "restore", "the cycle can finish");
});

suite("memory: disabled means disabled", () => {
  eq(decide(input({ cfg: { ...DEFAULT_CONFIG, enabled: false } })).kind, "none", "off");
});

// ── saving -> banked ────────────────────────────────────────────────────────
const saving = (over = {}) => input({
  state: { phase: "saving", phaseAt: NOW - MIN, memoryBaseline: 1000, sessionId: "s-old",
           transcriptDir: "/tmp/x" },
  ...over,
});

suite("memory: a verified save banks the memory and types NOTHING", () => {
  const s = decide(saving({ memoryMtime: 2000, memorySize: 4096 }));
  eq(s.kind, "none", "nothing is injected — this is the whole of CX-001");
  eq(s.message, undefined, "and there is no message to inject");
  eq(s.next.phase, "banked", "phase advances");
  eq(s.next.sessionId, "s-old", "remembers the session id it is watching");
  match(s.note, /will not clear po/, "and the panel says so, so nobody expects a reset");
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

suite("memory: a busy orchestrator no longer holds the cycle — there is nothing to interrupt", () => {
  // CX-001 REVERSED THIS ASSERTION DELIBERATELY. It used to require that a banked memory WAIT for the
  // turn to end, and the only reason was that a /clear typed into a working composer interrupts it.
  // No clear is sent now, and nothing else this cycle types is a command, so a busy session simply
  // banks and moves on. Left as an explicit assertion rather than a deleted suite: a re-added wait
  // would mean someone re-added something to protect it from.
  const s = decide(saving({ memoryMtime: 5000, memorySize: 4096, busy: true }));
  eq(s.kind, "none", "still injects nothing");
  eq(s.next.phase, "banked", "and does not stall mid-turn");
});

suite("memory: if the memory is never written the cycle ABORTS", () => {
  const s = decide(saving({ state: { phase: "saving", phaseAt: NOW - 11 * MIN, memoryBaseline: 1000 } }));
  eq(s.kind, "abort", "aborts");
  eq(s.next.phase, "watch", "back to watching");
  eq(s.next.aborts, 1, "counted");
  match(s.note, /nothing is banked/, "and is explicit that there is no saved file");
  ok(s.next.lastCycleAt, "cooldown starts, so it does not immediately re-ask");
});

// ── banked -> restore (on a clear the EXTENSION did not cause) ──────────────
const clearing = (over = {}) => input({
  state: { phase: "banked", phaseAt: NOW - MIN, sessionId: "s-old", transcriptDir: "/tmp/x",
           cycles: 2 },
  ...over,
});

suite("memory: a fresh session id is what proves a clear happened", () => {
  const s = decide(clearing({ reading: reading(1200, "s-new", "/tmp/x/s-new.jsonl") }));
  eq(s.kind, "restore", "restores");
  eq(s.next.phase, "watch", "cycle over");
  eq(s.next.sessionId, "s-new", "now watching the new session");
  eq(s.next.cycles, 3, "cycle counted");
  match(s.message, /1\. \/tmp\/demo\/po\/memory\.md/, "reads the memory doc first");
  match(s.message, /board\.json/, "then the board");
  match(s.message, /the board and the docs win/, "and reconciles it against the docs");
});

suite("memory: the same session id means nobody has cleared it", () => {
  const s = decide(clearing({ reading: reading(600_000, "s-old") }));
  eq(s.kind, "none", "no restore");
  match(s.note, /nothing will be typed/, "and says plainly that it is only watching");
});

suite("memory: nobody clearing is NOT a failure — it goes back to watching, no abort", () => {
  // CX-001: this used to abort with "no fresh session appeared after /clear", which under this block
  // would be a warning about a clear that was never sent. A person clears when they choose, or never.
  const s = decide(clearing({ state: { phase: "banked", phaseAt: NOW - 16 * MIN, sessionId: "s-old",
                                       aborts: 4 },
                              reading: reading(600_000, "s-old") }));
  eq(s.kind, "none", "not an abort — nothing went wrong");
  eq(s.next.phase, "watch", "back to watching the context");
  eq(s.next.aborts, 4, "and nothing is counted against anyone");
  ok(s.next.lastCycleAt, "cooldown starts, so the re-bank is not immediate");
  match(s.note, /banked and safe/, "reassures about the file");
});

// ── state on the bus ────────────────────────────────────────────────────────
suite("memory: the cycle survives an IDE restart", () => {
  const repo = makeRepo({ po: {} });
  eq(loadState(repo).phase, "watch", "fresh bus starts watching");
  saveState(repo, { phase: "saving", phaseAt: 123, memoryBaseline: 5 });
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

suite("memory: while banked, the FRESH transcript in the same directory is what counts", () => {
  const repo = makeRepo({ po: { session_id: "sid-old" } });
  const { dir } = projectTranscript("-mem-clear", "sid-old", 800000, 1000);
  projectTranscript("-mem-clear", "sid-new", 900);
  const r = readOrchestratorContext(repo, "po",
    { phase: "banked", sessionId: "sid-old", transcriptDir: dir, phaseAt: 0 }, 1000000);
  eq(r.sessionId, "sid-new", "the new session is found");
  eq(r.tokens, 900, "and it is nearly empty");
});

suite("memory: with no fresh transcript, a banked cycle keeps reading the old one", () => {
  // Which is what makes decide() say 'not yet' instead of mistaking silence for a successful clear.
  const repo = makeRepo({ po: { session_id: "sid-only" } });
  const { dir } = projectTranscript("-mem-noclear", "sid-only", 800000);
  const r = readOrchestratorContext(repo, "po",
    { phase: "banked", sessionId: "sid-only", transcriptDir: dir, phaseAt: Date.now() + 60000 },
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
suite("memory: an emptied panel is proof enough that a clear happened", () => {
  // A cleared tab renders ~170 characters and loses its compact button; the live orchestrator
  // conversation it replaces was 145,680.
  const s = decide(input({
    state: { phase: "banked", phaseAt: NOW - MIN, sessionId: undefined },
    reading: null, panelPct: null, panelChars: 170,
  }));
  eq(s.kind, "restore", "restored");
  match(s.note, /panel emptied/, "and says which witness it used");
  eq(s.next.cycles, 1, "cycle counted");
});

suite("memory: a still-full panel is not a clear", () => {
  const s = decide(input({
    state: { phase: "banked", phaseAt: NOW - MIN, sessionId: undefined },
    reading: null, panelPct: null, panelChars: 145680,
  }));
  eq(s.kind, "none", "no restore");
  match(s.note, /watching in case/, "keeps watching");
});

suite("memory: a small panel that still shows a context button has NOT been cleared", () => {
  // Belt and braces: the button only exists past 50% used, so its presence contradicts a clear.
  const s = decide(input({
    state: { phase: "banked", phaseAt: NOW - MIN, sessionId: undefined },
    reading: null, panelPct: 62, panelChars: 500,
  }));
  eq(s.kind, "none", "not treated as cleared");
});

suite("memory: an unseen panel while banked is not mistaken for an empty one", () => {
  const s = decide(input({
    state: { phase: "banked", phaseAt: NOW - MIN, sessionId: undefined },
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

suite("memory: the second window does NOT also drive the cycle", () => {
  const saving = { phase: "saving", phaseAt: NOW - MIN, memoryBaseline: 0,
                   owner: "win-A", ownerAt: NOW - MIN };
  const mine = decide(input({ windowId: "win-A", state: saving, memoryMtime: NOW, memorySize: 5000 }));
  eq(mine.next.phase, "banked", "the owner advances it");
  const theirs = decide(input({ windowId: "win-B", state: saving, memoryMtime: NOW, memorySize: 5000 }));
  eq(theirs.next.phase, "saving", "the other window leaves the phase alone");
  match(theirs.note, /another window is running this cycle/, "and says why");
});

suite("memory: a window that goes away does not strand the project", () => {
  const stale = { phase: "saving", phaseAt: NOW - MIN, memoryBaseline: 0,
                  owner: "win-gone", ownerAt: NOW - LEASE_MS - 1 };
  const s = decide(input({ windowId: "win-B", state: stale, memoryMtime: NOW, memorySize: 5000 }));
  eq(s.next.phase, "banked", "the lease has expired, so another window may take over");
  eq(s.next.owner, "win-B", "and it takes ownership as it acts");
});

suite("memory: the owner keeps its claim alive while it waits", () => {
  const held = { phase: "saving", phaseAt: NOW - MIN, memoryBaseline: 1000,
                 owner: "win-A", ownerAt: NOW - LEASE_MS + 1000 };   // past half-life
  const s = decide(input({ windowId: "win-A", state: held }));       // still waiting for the file
  eq(s.kind, "none", "nothing to do yet");
  eq(s.next.ownerAt, NOW, "but the lease is refreshed so it is not overtaken mid-wait");
});

suite("memory: a finished cycle releases the claim", () => {
  const clearing = { phase: "banked", phaseAt: NOW - MIN, owner: "win-A", ownerAt: NOW - 1000 };
  const s = decide(input({ windowId: "win-A", state: clearing, reading: null,
                           panelPct: null, panelChars: 170 }));
  eq(s.kind, "restore", "cycle completes");
  eq(s.next.owner, undefined, "and the next cycle is anyone's to claim");
});

suite("memory: an aborted cycle releases the claim too", () => {
  const s = decide(input({ windowId: "win-A", state: {
    phase: "saving", phaseAt: NOW - 11 * MIN, memoryBaseline: 0, owner: "win-A", ownerAt: NOW - 1000 } }));
  eq(s.kind, "abort", "gives up");
  eq(s.next.owner, undefined, "claim released, so a retry is not blocked by a dead lease");
});

suite("memory: state written before leases existed is adoptable", () => {
  // 0.13.x wrote no owner at all; an in-flight cycle must not deadlock on upgrade.
  const legacy = { phase: "saving", phaseAt: NOW - MIN, memoryBaseline: 0 };
  const s = decide(input({ windowId: "win-B", state: legacy, memoryMtime: NOW, memorySize: 5000 }));
  eq(s.next.phase, "banked", "an unowned cycle is claimable");
  eq(s.next.owner, "win-B", "and gets an owner from here on");
});

suite("memory: re-tagging mid-cycle abandons it rather than judging the wrong file", () => {
  // The baseline was taken from po/memory.md. If the tag moves to another role, its memory.md may
  // already exist and be newer — which would read as "banked" when nothing was written for us.
  const saving = { phase: "saving", phaseAt: NOW - MIN, memoryBaseline: 1000,
                   role: "po", memoryFile: "/m/po/memory.md", owner: "win-A", ownerAt: NOW };
  const s = decide(input({ windowId: "win-A", state: saving, role: "other",
                           memoryFile: "/m/other/memory.md", memoryMtime: NOW, memorySize: 9000 }));
  eq(s.kind, "abort", "abandoned");
  match(s.note, /Nothing cleared/, "and explicit that nothing was destroyed");
  eq(s.next.phase, "watch", "back to watching");
  eq(s.next.owner, undefined, "claim released so the new target can start cleanly");
});

suite("memory: pointing contextMemoryFile somewhere else mid-cycle does the same", () => {
  const saving = { phase: "saving", phaseAt: NOW - MIN, memoryBaseline: 1000,
                   role: "po", memoryFile: "/m/po/memory.md" };
  const s = decide(input({ state: saving, memoryFile: "/elsewhere/memory.md",
                           memoryMtime: NOW, memorySize: 9000 }));
  eq(s.kind, "abort", "the file it is judging must be the file it asked for");
});

suite("memory: an unchanged target proceeds normally", () => {
  const saving = { phase: "saving", phaseAt: NOW - MIN, memoryBaseline: 1000,
                   role: "po", memoryFile: "/tmp/demo/po/memory.md" };   // == the input's file
  eq(decide(input({ state: saving, memoryMtime: 2000, memorySize: 4096 })).next.phase, "banked",
    "same role, same file -> the cycle continues");
});

// ── CX-001 · THE EXTENSION NEVER CLEARS AN ORCHESTRATOR ──────────────────────────────────────
//
// Owner, 2026-09-16: "Do not ever clear the orchestrator's context. Remove that from the
// loom-session-tracker add-on."
//
// WHAT THIS REPLACED, AND WHY THE REPLACEMENT IS NOT SMALLER. Until this block, the suites here
// asserted that a clear WAITED for two consecutive idle readings and for a frame we could see
// (user request 2026-09-10, "make sure it is idle in order to not disrupt the ongoing process").
// Those were rules about HOW to clear safely. There is no safe clear now, there is no clear, so
// asserting the timing of one would assert that the thing still happens. The rules below assert
// the absence instead — and they are deliberately harder to satisfy by accident than the ones they
// replace, because an absence that is only true of the inputs someone happened to write down is not
// an absence at all.

suite("CX-001: decide() never returns a clear step, from ANY state it can be in", () => {
  // A SWEEP, not a sample. The old cycle reached its clear through a specific corridor — banked
  // memory, idle, frame seen, lease held — so a test that only visited today's happy path could be
  // satisfied by a version that still cleared somewhere else. This enumerates the cross product of
  // every field the decision actually branches on and asserts the absence across all of it.
  const phases = ["watch", "saving", "banked"];
  const saved = [{ memoryMtime: NOW, memorySize: 9000 },            // a verified save
                 { memoryMtime: 900, memorySize: 9000 },            // stale file
                 { memoryMtime: null, memorySize: 0 }];             // nothing written
  const panels = [{ panelPct: 99, panelChars: 145680 },             // full
                  { panelPct: null, panelChars: 170 },              // emptied
                  { panelPct: null, panelChars: null }];            // unseen
  let checked = 0;
  for (const phase of phases)
    for (const mem of saved)
      for (const panel of panels)
        for (const busy of [true, false])
          for (const frameSeen of [true, false])
            for (const age of [0, MIN, 11 * MIN, 60 * MIN]) {
              const s = decide(input({
                ...mem, ...panel, busy, frameSeen,
                state: { phase, phaseAt: NOW - age, memoryBaseline: 1000, sessionId: "s-old",
                         role: "po", memoryFile: "/tmp/demo/po/memory.md", transcriptDir: "/tmp/x" },
              }));
              ok(s.kind !== "clear", `phase=${phase} busy=${busy} seen=${frameSeen} age=${age} -> ${s.kind}`);
              ok(!/^\s*\/clear\b/.test(String(s.message || "")),
                 `no step in ${phase} may carry /clear as its message`);
              checked++;
            }
  ok(checked >= 400, `swept ${checked} states`);
  // …and the phase it could once advance INTO is gone from the type's vocabulary entirely.
  const banked = decide(input({ state: { phase: "saving", phaseAt: NOW - MIN, memoryBaseline: 1000 },
                                memoryMtime: NOW, memorySize: 9000 }));
  eq(banked.next.phase, "banked", "a verified save banks; it does not enter a clearing phase");
});

suite("CX-001: a threshold-triggered clear cannot be re-added without failing this", () => {
  // THE REGRESSION TEST THE BLOCK EXISTS FOR (acceptance §5.3). The removed behaviour had one
  // shape: context over the threshold -> ask for a save -> once the file is on disk, type /clear.
  // This walks exactly that path, in order, and asserts that the end of it types nothing. Someone
  // re-adding the trigger has to make this pass, and the only way to do that is to delete it.
  const over = input({ panelPct: 80, state: { phase: "watch" } });
  const step1 = decide(over);
  eq(step1.kind, "save", "the threshold still asks for a bank — that half is kept on purpose");
  eq(step1.next.phase, "saving");

  // the orchestrator writes the file, and is idle, and its frame is plainly visible: the exact
  // conditions under which the old code cleared.
  const step2 = decide(input({ panelPct: 80, state: step1.next, busy: false, frameSeen: true,
                               memoryMtime: NOW + 1, memorySize: 9000 }));
  eq(step2.kind, "none", "NOTHING IS TYPED — this is the assertion the owner asked for");
  eq(step2.message, undefined, "and there is no message at all, not merely a non-clear one");
  eq(step2.next.phase, "banked");

  // and it stays that way however many ticks pass in the banked phase
  for (const age of [MIN, 5 * MIN, 30 * MIN]) {
    const later = decide(input({ panelPct: 80, busy: false, frameSeen: true,
                                 memoryMtime: NOW + 1, memorySize: 9000,
                                 state: { ...step2.next, phaseAt: NOW - age } }));
    ok(later.kind !== "clear", `still no clear ${age / MIN} minutes later`);
  }
});

suite("CX-001 R1: an empty panel only witnesses a clear if the panel was FULL when we banked", () => {
  // A DEFECT THIS BLOCK INTRODUCED, AND THE TEST THAT CAUGHT IT. While the extension sent the clear
  // itself, "the panel is nearly empty" could only mean the clear it had just typed had landed —
  // the phase lasted seconds. Banking instead means the SAME phase now sits there indefinitely, so
  // any panel that merely reads small — a partial CDP read, a narrow view — would be taken for a
  // clear and a restore prompt would be injected into a session that is mid-work and had never been
  // cleared. That is a worse injection than the one this block removed.
  // `state` is merged, not replaced: spreading `over` wholesale would drop the phase and every case
  // below would silently exercise the `watch` branch instead.
  const banked = ({ state = {}, ...over } = {}) => decide(input({
    reading: null, panelPct: null,
    state: { phase: "banked", phaseAt: NOW - MIN, sessionId: undefined, ...state },
    ...over,
  }));
  // the real path: full when banked (the threshold had just fired), empty now -> a clear happened
  eq(banked({ panelChars: 170, state: { bankedChars: 145680 } }).kind, "restore",
     "a genuine fall from full to empty is still the witness it always was");
  // the defect: it was ALREADY small when we banked, so small now proves nothing
  eq(banked({ panelChars: 170, state: { bankedChars: 300 } }).kind, "none",
     "a panel that was never full cannot have emptied — no restore is injected");
  eq(banked({ panelChars: 170, state: { bankedChars: null } }).kind, "none",
     "and a panel we never saw is unknown, not empty");
  // …but the OTHER witness needs no panel at all, so those cases still finish
  const byId = decide(input({
    panelChars: 170, panelPct: null, reading: reading(1200, "s-new", "/tmp/x/s-new.jsonl"),
    state: { phase: "banked", phaseAt: NOW - MIN, sessionId: "s-old", bankedChars: 300 },
  }));
  eq(byId.kind, "restore", "a fresh session id finishes the cycle whatever the panel looked like");
  // and the value is actually recorded when banking, or none of the above can ever apply
  const bank = decide(input({ panelChars: 145680,
                              state: { phase: "saving", phaseAt: NOW - MIN, memoryBaseline: 1000 },
                              memoryMtime: NOW, memorySize: 9000 }));
  eq(bank.next.bankedChars, 145680, "the 'before' is written into the state at bank time");
});

suite("CX-001: the restore half survives — a clear a PERSON did still brings the memory back", () => {
  // The value that was NOT removed. Deleting the whole subsystem would have taken this with it, and
  // then a hand-cleared orchestrator would come back with no idea who it is (§4 decision).
  const s = decide(input({ state: { phase: "banked", phaseAt: NOW - MIN, sessionId: "s-old",
                                    transcriptDir: "/tmp/x" },
                           reading: reading(1200, "s-new", "/tmp/x/s-new.jsonl") }));
  eq(s.kind, "restore", "the person cleared it; the tool notices and helps");
  match(s.message, /you are po, the orchestrator of demo/, "and it comes back knowing what it is");
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


// ── WL-003 · the audit rides the one message a fresh orchestrator is guaranteed to read ────────
suite("WL-003 R2: the briefing is APPENDED to the restore message, after the bind instructions", () => {
  const brief = "\n\n[loom-ledger] demo, last 7 days:\n  · 4 block(s) since anything reached a user.";
  const m = restoreMessage("/bus/memory.md", "demo", "po", brief);
  ok(m.endsWith(brief), "appended, not prepended — the bind is what the session must act on first");
  match(m, /4 block\(s\) since anything reached a user/, "and the audit is actually in the text");
  const plain = restoreMessage("/bus/memory.md", "demo", "po");
  eq(m.slice(0, plain.length), plain, "the existing bootstrap is unchanged ahead of it");
  eq(restoreMessage("/bus/memory.md", "demo", "po", ""), plain,
     "an empty briefing leaves the bootstrap byte-identical");
});

// ── WL-004 · no byte target in anything an agent reads ─────────────────────────────────────────
//
// MEASURED 2026-09-15: `Keep it under 12,000 bytes` made the orchestrator trim its own memory and
// destroy the section recording the owner's stated product goal — the most important thing in the
// file — twice in one day, then argue the cap was "advisory" to justify the file it had left. An
// imperative with a measurable target, handed to an agent, about the one artifact that survives its
// own erasure: an agent that cannot fit trades facts for bytes, and the facts are the point.
//
// THE RULE HAS TO OUTLIVE THE EDIT, so it is asserted rather than merely removed.

/** Every string the memory cycle puts in front of an agent. */
function agentFacingMemoryTexts() {
  const { saveMessage, restoreMessage, MAX_MEMORY_BYTES } = load("memory.js");
  return {
    save: saveMessage("/bus/memory.md", 120000, 78),
    restore: restoreMessage("/bus/memory.md", "demo", "po"),
    // CX-001 DROPPED THE `clear` ENTRY, and dropping it is more honest than keeping it. It held
    // `String(CLEAR_MESSAGE || "")`; CLEAR_MESSAGE is now deleted, so the expression still evaluates
    // — to the empty string — and every assertion below would keep passing while testing nothing at
    // all under a name that says it covers the clear message. A loop entry that cannot fail is worse
    // than an absent one, because the suite reports it as coverage.
    //
    // AND NOTE WHAT IS DELIBERATELY NOT HERE: `step.note` still contains `(N bytes)`, correctly. It
    // reaches setStatusBarMessage and debugLog only, never a composer, so it is panel telemetry about
    // a file — not an instruction to an agent. `message` is the field that gets typed into a frame,
    // and that is what this loop covers. Do not "fix" the note by removing its byte count.
    max: MAX_MEMORY_BYTES,
  };
}

suite("WL-004 R3: no agent-facing memory prompt names a size, a cap, or the threshold", () => {
  const t = agentFacingMemoryTexts();
  for (const [which, text] of [["save", t.save], ["restore", t.restore]]) {
    // A byte/KB count of the file.
    ok(!/\b[\d][\d,_.]*\s*(?:bytes?|kb|kib|kilobytes?)\b/i.test(text),
       `${which}: no byte or KB count`);
    // Any phrasing of a ceiling.
    ok(!/\b(?:keep it under|stay under|no more than|at most|cap|budget|limit it to|max(?:imum)? (?:of|size))\b/i
         .test(text), `${which}: no ceiling phrasing`);
    // The threshold itself, in every spelling it could reach a string by.
    for (const spelling of [String(t.max), t.max.toLocaleString(), "12_000", "12k", "12 KB"]) {
      ok(!text.includes(spelling), `${which}: does not contain ${spelling}`);
    }
    // A percentage OF THE FILE. Deliberately not "no percentage at all" — see the next suite.
    ok(!/\d+\s*%[^.]{0,40}\b(?:file|memory|memory\.md|notes)\b/i.test(text),
       `${which}: no percentage of file size`);
    // AND THE ORDER ITSELF, WITH OR WITHOUT A DIGIT. A surviving mutant proved the number was never
    // the only way to demand the trade: "If it will not fit, cut the least important section until it
    // does" carries no threshold, passed every assertion above, and is the same instruction that
    // destroyed the record of the owner's product goal. What is banned is telling an agent to REMOVE
    // CONTENT to make the file smaller — the rule, not one spelling of it.
    ok(!/\b(?:until it (?:does|fits)|make it fit|if it (?:will not|won't|does not|doesn't) fit)\b/i
         .test(text), `${which}: no "make it fit" ordering`);
    ok(!/\bcut\b[^.]{0,30}\b(?:section|sections|least important|content|entries|items)\b/i
         .test(text), `${which}: no order to cut content`);
    ok(!/\b(?:drop|delete|remove|trim)\b[^.]{0,25}\b(?:until|to fit|so it fits|to make room)\b/i
         .test(text), `${which}: no removal conditioned on fitting`);
  }
});

suite("WL-004 R3: the CONTEXT percentage is still allowed — the ban is on file-size targets", () => {
  // Scoped on purpose. The context reading is the TRIGGER for the cycle and a fact about the
  // session, not an instruction about how long a file may be. Banning every digit would have
  // removed it, which is the over-reaching-assertion mistake, not the rule.
  const t = agentFacingMemoryTexts();
  match(t.save, /78% full/, "the context reading survives");
  match(t.save, /120,000 tokens/, "and so does its token count");
  // `eq(os.tmpdir(), process.env.TMPDIR || os.tmpdir())` was a TAUTOLOGY whenever TMPDIR was unset —
  // it compared a value with itself and reported a pass. Assert only when there is something to
  // assert, and say plainly when there is not.
  if (process.env.TMPDIR) {
    eq(os.tmpdir(), process.env.TMPDIR, "os.tmpdir() follows TMPDIR when TMPDIR is set");
  } else {
    ok(true, "TMPDIR unset here — the redirect is asserted in fixtures.test.js under the runner");
  }
});

suite("WL-004 R1: the save prompt asks for CONCISION, and says why, with no threshold", () => {
  const t = agentFacingMemoryTexts();
  match(t.save, /TIGHT|tight/, "it asks for tightness");
  match(t.save, /earn its place/, "as a matter of form");
  match(t.save, /re-read|read in full/i, "with the reason attached");
  // The reason concision matters must be the NEXT SESSION'S COST, not a rule being obeyed.
  match(t.save, /next session pays/i, "and the reason is the cost, not a rule");
  match(t.save, /short is not the same as being incomplete/i,
        "and it explicitly refuses the trade that caused the incident");
});

suite("WL-004 R4: both prompts say the split, and notes.md is read even when memory is short", () => {
  const t = agentFacingMemoryTexts();
  match(t.save, /notes\.md/, "the save prompt names the durable file");
  match(t.save, /append/i, "append-only");
  match(t.save, /belongs in \/bus\/notes\.md instead — move it, do not lose it/,
        "and it redirects a deletion into the notes rather than out of existence");
  match(t.restore, /READ THIS EVEN\s+IF \/bus\/memory\.md IS SHORT/,
        "a fresh session reads the notes precisely when the working memory is short");
});

suite("WL-004: MIN_MEMORY_BYTES stays — it is evidence a file was written, not a target", () => {
  const { MIN_MEMORY_BYTES } = load("memory.js");
  eq(MIN_MEMORY_BYTES, 200, "the floor that says a file was really written, not merely touched");
  const t = agentFacingMemoryTexts();
  for (const text of [t.save, t.restore]) {
    ok(!text.includes("200 bytes"), "and it is never quoted at an agent either");
  }
});

suite("MP-002: the fresh-context header keeps the WORKER model rule and no longer tells orchestrators to shift themselves", () => {
  const m = restoreMessage("/bus/memory.md", "demo", "po");
  // what stays: the handoff rule, which is about workers
  match(m, /every handoff you write carries a model: line \(§18/, "the worker rule stays");
  match(m, /tracker warns once per handoff when it is missing/, "…with its warning");
  match(m, /That is a rule about WORKERS/, "…and it is named as a worker rule");
  // what must be GONE — this text is where the behaviour actually flowed from
  ok(!/orchestrator-model\.json/.test(m), "the self-shift file is not named: an instruction left standing keeps the file being written");
  ok(!/§20/.test(m), "nor its playbook section");
  ok(!/both directions/.test(m), "nor the promise that the tracker switches the orchestrator");
  match(m, /Your own tier is not the tracker's business and it will never change it/, "it says plainly that the orchestrator is never switched");
});
