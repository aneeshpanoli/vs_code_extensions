// safeguards.test.js — SECOND, INDEPENDENT tests for the safeguards that only ONE test was holding.
//
// WHY THIS FILE EXISTS. GC-003 replaced the mutation gate's exit-code grading with baseline grading,
// which for the first time reported WHICH tests kill each mutant. That exposed a distribution nobody
// could see before: at 0.33.0, **46 of the 72 mutants are killed by exactly one test**. A safeguard
// held by a single assertion is one careless edit — a rename, a "flaky test" deletion, a refactor
// that quietly stops exercising the path — away from silently surviving, and the thing it guards
// against is in every case something that already went wrong live.
//
// Each suite below covers a safeguard that had exactly ONE killer, and each deliberately reaches it
// by a DIFFERENT PATH than the existing test, so the two do not fail for the same reason:
//
//   safeguard            existing test                                   this file's second test
//   ------------------   ---------------------------------------------   ---------------------------
//   return address       static regex over the COMPILED out/*.js         behavioural: run injectTo
//                        (return-address.test.js)                        and read the real argv
//   closeWebview refusal behavioural, override unset vs "1"              behavioural, every OTHER
//                        (cdp.test.js)                                   value of the env var
//   blank-shell rule     unit, two hand-written text constants           the REAL captured panels in
//                        (blanks.test.js)                                test/fixtures/live
//   stranded spawn       one example, asserts the in-memory plan         cross-module: planOpen must
//                        (requests.test.js)                              agree with strandedRoles
//   30% threshold        two unit tests of the code constant             code constant vs the SETTING
//                        (memory/edge tests)                             default in package.json
//
// These are not the only thin spots — they are the five named in the GC-005 handoff. See the outbox
// for the full list of single-killer safeguards.

const { suite, ok, eq, match, load, makeRepo, busPath, writeJson, readJson, LOOM, home } = require("./harness");
const fs = require("fs");
const path = require("path");

// ── 1. every inject carries a return address ─────────────────────────────────────────────────────
// Existing killer: `return-address: every inject the extension performs carries --from`, which greps
// the COMPILED out/*.js for a `...senderArgs(...)` spread. That is a source-shape test: it passes as
// long as the call SITE looks right, and it would keep passing if senderArgs itself returned [].
// This one runs the real injectTo and reads the argv that actually reached the injector.
//
// The measured defect (2026-09-09): messages arrived in a tab with no way to tell who sent them or
// where to reply, so roles answered into the void. Playbook §16.
const { injectTo } = load("inject.js");
const CDP = path.join(LOOM, "loom_cdp.py");

suite("safeguards: the return address is in the ARGV that reaches the injector, not just the source", async () => {
  fs.mkdirSync(LOOM, { recursive: true });
  // Stub loom_cdp.py so it reports the argv it was called with, exactly as inject.test.js does.
  fs.writeFileSync(CDP, "import sys\nprint(' '.join(sys.argv[1:]))\nprint(\"{'ok': True}\")\n");
  const argvOf = (target) => new Promise((resolve) => {
    injectTo(target, "hello", "t-safeguard-inject.json", () => {
      resolve(String((readJson(path.join(LOOM, "t-safeguard-inject.json")) || {}).out || ""));
    });
  });

  const out = await argvOf({ role: "developer1", repo: "safeguard-repo", webviewId: "wid-1" });
  // The two flags a reply depends on. A stripped senderArgs spread removes BOTH.
  match(out, /--from /, "the sender is named on the command line");
  match(out, /--reply /, "and so is the channel to reply on");
  match(out, /loom-session-tracker/, "the sender identifies the tool");
  match(out, /safeguard-repo/, "and the project it is speaking for");

  // A repo-less inject must STILL carry a return address — the branch where `repo` is null is
  // exactly where a naive implementation drops the flags.
  const bare = await argvOf({ role: "developer1", repo: null, webviewId: "wid-2" });
  match(bare, /--from /, "a repo-less inject is still addressed");
  match(bare, /--reply /, "and still says how to reply");
});

// ── 2. closeWebview refuses by default ───────────────────────────────────────────────────────────
// Existing killer: `cdp: closeWebview refuses by default, and only a terminal override reaches the
// target`, which tests exactly two states — the variable UNSET, and set to "1".
// This one tests every OTHER value. The guard is `!== "1"`; a mutant (or a well-meaning refactor to
// something truthiness-based) that loosens it turns "0"/"false"/"" into permission to close.
//
// The measured defect (2026-09-12): `/json/close` on a webview target closes the target's WHOLE
// EDITOR WINDOW. Three windows were lost. Nothing about that is recoverable.
const { closeWebview } = load("cdp.js");
const { startFakeDevTools } = require("./fake-devtools");
const wv = (id) => `vscode-webview://host/index.html?id=${id}`;

suite("safeguards: only the exact override '1' may close a webview — every other value refuses", async () => {
  const fake = await startFakeDevTools({ listTargets: [{ id: "T-1", url: wv("ffff6666-3333") }] });
  const saved = process.env.LOOM_ALLOW_WINDOW_CLOSE;
  try {
    // Values a loosened guard would wave through. "" and "0" are the dangerous ones: a person who
    // set the variable to turn the override OFF must not thereby turn it ON.
    for (const v of ["0", "", "false", "no", "true", "yes", "2", " 1"]) {
      process.env.LOOM_ALLOW_WINDOW_CLOSE = v;
      const r = await closeWebview("ffff6666-3333", "127.0.0.1", fake.port);
      eq(r.ok, false, `LOOM_ALLOW_WINDOW_CLOSE=${JSON.stringify(v)} must NOT permit a close`);
      match(r.note, /whole editor window/, `and it must say why (${JSON.stringify(v)})`);
    }
    eq(fake.closed, [], "after every one of those attempts, NOTHING was closed");
  } finally {
    if (saved === undefined) delete process.env.LOOM_ALLOW_WINDOW_CLOSE;
    else process.env.LOOM_ALLOW_WINDOW_CLOSE = saved;
    await fake.close();
  }
});

// ── 3. a reused shell is not a blank shell ───────────────────────────────────────────────────────
// Existing killer: `blanks: only shells that were blank BEFORE and are still blank are closable`,
// which uses two hand-written strings. Hand-written fixtures agree with the code's model of the
// world wherever that model is wrong — the exact failure live-fixtures.test.js was built to answer.
// This one drives the same rule with the REAL captured panels in test/fixtures/live.
//
// The measured defect: a restart reopen REUSES a blank shell for the real session. Closing it on the
// strength of "it was blank when we started" closes a live conversation.
const { isBlankShell, closableShells } = load("blanks.js");
const FIXTURES = path.join(__dirname, "fixtures", "live");

suite("safeguards: no REAL captured panel is ever closable, however it was classified", () => {
  const files = fs.readdirSync(FIXTURES).filter((f) => f.endsWith(".txt"));
  ok(files.length >= 5, `the captured corpus is present (${files.length} panels)`);

  const real = files
    .map((f) => ({ id: f.replace(/\.txt$/, ""), text: fs.readFileSync(path.join(FIXTURES, f), "utf8") }))
    .filter((p) => !isBlankShell(p.text));
  ok(real.length >= 5, `most captured panels are real conversations, not shells (${real.length})`);

  // THE REUSE CASE, with real text: every one of these ids was blank when we looked before, and now
  // holds a real captured conversation. Not one of them may come back as closable.
  const before = real.map((p) => p.id);
  const after = real.map((p) => ({ webviewId: p.id, text: p.text }));
  eq(closableShells(before, after, before.length), [],
    "a shell that was reused for a real session is NOT closable — this is the direction that loses work");

  // The control, so this is not a blanket "never close anything": a shell that stayed blank still is.
  const stillBlank = "Claude: Remote Control is active · Continue here, on your phone, or at " +
    "claude.ai/code Untitled // TODO: Everything. Let's start.";
  ok(isBlankShell(stillBlank), "the measured shell text still reads as blank");
  eq(closableShells([...before, "w-blank"], [...after, { webviewId: "w-blank", text: stillBlank }], 9),
    ["w-blank"], "only the one that was blank then and is blank now");
});

// ── 4. a stranded spawn is reported back ─────────────────────────────────────────────────────────
// Existing killer: `requests: a role stranded in another cwd is SPAWNED and bound, never reopened
// blank` — one example, asserting the in-memory plan. This one asserts the CONTRACT BETWEEN TWO
// MODULES: whatever reopen.strandedRoles() says is stranded, requests.planOpen() must carry into its
// plan for every role it decided to spawn. A drop on either side breaks the agreement.
//
// The measured defect (2026-09-13 05:50): four roles came up as blank `Untitled` tabs and the
// orchestrator was never told why, so it asked again — and got four more blank tabs.
const { planOpen, strandedNote } = load("requests.js");
const { projectDirFor, strandedRoles } = load("reopen.js");

function transcript(dir, sid) {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, sid + ".jsonl"), '{"type":"user"}\n');
}

suite("safeguards: every role planOpen spawns as stranded is the one strandedRoles named", () => {
  const win = "/home/x/Containers/Multi";
  const wtOf = (role) => `${win}/.claude/worktrees/${role}`;
  const roles = ["designer", "developer1", "monetization"];
  const board = { developer2: { session_id: "s-d2" } };
  for (const r of roles) board[r] = { session_id: "s-" + r, worktree: wtOf(r) };
  const repo = makeRepo(board, "safeguard-stranded");

  // Three roles whose ONLY transcript lives under their own worktree cwd -> stranded from this
  // window. One role resumable here -> not stranded, and must not be reported as such.
  for (const r of roles) transcript(projectDirFor(wtOf(r)), "s-" + r);
  transcript(projectDirFor(win), "s-d2");

  writeJson(busPath(repo, "open-requests.json"),
    { roles: [...roles, "developer2"], requestedAt: new Date().toISOString() });

  const plan = planOpen(repo, new Set(), 5, Date.now(), win);
  eq(plan.open.map((c) => c.role), ["developer2"], "the resumable role is reopened");
  eq(plan.spawn.sort(), [...roles].sort(), "all three stranded roles are spawned fresh");

  // The agreement itself. strandedRoles() is the upstream authority; the plan must not lose any of
  // it, and must not invent a role it never named.
  const upstream = strandedRoles(repo, new Set(), win).map((s) => s.role).filter((r) => plan.spawn.includes(r));
  eq(plan.stranded.map((s) => s.role).sort(), upstream.sort(),
    "planOpen reports exactly the spawned roles strandedRoles called stranded — none dropped, none invented");
  ok(upstream.length >= 3, "and there really were stranded roles to lose (guards against a vacuous pass)");

  // What the orchestrator actually reads has to identify the role, its transcript and where it lives,
  // or the report cannot be acted on.
  for (const s of plan.stranded) {
    const note = strandedNote(s);
    match(note, new RegExp(s.role), `the note names ${s.role}`);
    match(note, /cannot be resumed from this window/, "and says why it was spawned instead");
    match(note, /worktrees/, "and where the transcript actually lives");
  }
  eq(plan.stranded.some((s) => s.role === "developer2"), false, "the resumable role is never called stranded");
});

// ── 5. the 30% context threshold ─────────────────────────────────────────────────────────────────
// This one had TWO killers already (`memory: the default threshold is 30%` and `edge: the threshold
// is inclusive`) — the GC-005 handoff listed it as single-killer on my own GC-003 miscount, which is
// corrected in the outbox. Both existing tests read the CODE constant, so they agree with each other
// by construction and neither would notice the package.json setting default drifting away from it.
// That gap is worth a test on its own: the number a user sees in Settings and the number the code
// falls back to are two separate literals in two separate files, and only one of them is tested.
//
// Why 30 and not 50 (0.32.0, measured across all projects 2026-09-13): the context is re-read every
// turn, so its LENGTH is the cost — 2.93 billion cache-read tokens in one day. A restore costs
// ~30-60k tokens ONCE; a fat context costs its whole length on every remaining turn.
const { DEFAULT_CONFIG } = load("memory.js");

suite("safeguards: the context threshold in the code and in the SETTING default are the same number", () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "package.json"), "utf8"));
  const props = pkg.contributes.configuration.properties;
  const setting = props["loomSessionTracker.contextThresholdPct"];
  ok(setting, "the setting is declared");

  eq(DEFAULT_CONFIG.thresholdPct, setting.default,
    "DEFAULT_CONFIG.thresholdPct and the package.json default must not drift apart");
  eq(DEFAULT_CONFIG.thresholdPct, 30,
    "and the agreed number is 30 — the context is re-read every turn, so its length is the cost");

  // The same drift is possible for every other context default that exists in both places.
  const pairs = [
    ["contextSaveTimeoutMinutes", "saveTimeoutMinutes"],
    ["contextCooldownMinutes", "cooldownMinutes"],
  ];
  for (const [settingName, field] of pairs) {
    const s = props["loomSessionTracker." + settingName];
    ok(s, `${settingName} is declared`);
    eq(DEFAULT_CONFIG[field], s.default, `${settingName} agrees with DEFAULT_CONFIG.${field}`);
  }

  // CX-001 · THE SETTING THAT NO LONGER DOES ANYTHING MUST NOT STAY IN THE MANIFEST.
  // `contextClearTimeoutMinutes` timed the wait for a fresh session after a `/clear` this extension
  // sent, and it sends none. A setting left behind in package.json advertises a behaviour to anyone
  // reading the settings UI, and the only thing worse than a removed feature is one the manifest
  // still offers to configure. Asserted as an ABSENCE so it cannot quietly come back with the
  // behaviour still gone.
  ok(!props["loomSessionTracker.contextClearTimeoutMinutes"],
     "the dead clear-timeout setting is gone from package.json");
  ok(!("clearTimeoutMinutes" in DEFAULT_CONFIG),
     "and MemoryConfig does not carry a field nothing reads");
  match(props["loomSessionTracker.contextMemory"].description, /NEVER clears/,
     "and the master setting's description says plainly that nothing is cleared");
});
