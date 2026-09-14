const { suite, ok, eq, match, load, makeRepo, busPath, writeJson, readJson, LOOM } = require("./harness");
const fs = require("fs");
const path = require("path");
const { detectModel, isPremium, ModelPolicy, DEFAULT_PREMIUM, FOOTER_CHARS, BACKOFF_MS, backoffFor } = load("models.js");
const { setOrchestrator } = load("orchestrator.js");

// Footer text exactly as the live panels render it (measured 2026-09-08).
const footer = (model, effort = "Medium", chip = "Bypass permissions") =>
  `\nRemote Control\n${model}\n${effort}\n${chip}\n`;
const panel = (model, body = "some conversation") => body + footer(model);

suite("models: reads the model off a live panel footer", () => {
  eq(detectModel(panel("Opus 5")), { model: "Opus 5", effort: "Medium" }, "Opus 5 + effort");
  eq(detectModel(panel("Fable 5")).model, "Fable 5", "Fable 5");
  eq(detectModel(panel("Fable 5.1")).model, "Fable 5.1", "Fable 5.1 (not truncated to Fable 5)");
  eq(detectModel(panel("Sonnet 5")).model, "Sonnet 5", "Sonnet 5");
  eq(detectModel(panel("Haiku 4.5")).model, "Haiku 4.5", "Haiku 4.5");
});

suite("models: works in every permission mode and without an effort chip", () => {
  for (const chip of ["Bypass permissions", "Accept edits", "Plan mode", "Ask each time"]) {
    eq(detectModel(panel("Opus 5", "x") .replace("Bypass permissions", chip)).model, "Opus 5", "chip: " + chip);
  }
  eq(detectModel("chat\nOpus 5\nBypass permissions\n").model, "Opus 5", "no effort chip");
});

suite("models: a conversation that MENTIONS a model is not mistaken for the footer", () => {
  // This conversation discusses Fable 5 at length; only the footer decides.
  const chatty = "we compared Fable 5.1 against Opus 5 pricing at length. " + "x".repeat(FOOTER_CHARS) +
    footer("Opus 5");
  eq(detectModel(chatty).model, "Opus 5", "footer wins over chatter");
  // Two footer-shaped runs inside the window (a quoted one, then the real one, as happens when a
  // session is shown its own UI text): the LAST is the live footer.
  const twoFooters = "as I showed you:" + footer("Fable 5") + " ...anyway, carrying on." + footer("Opus 5");
  eq(detectModel(twoFooters).model, "Opus 5", "the trailing footer wins over a quoted one");
});

suite("models: a QUOTED footer without a real one yields null, not a phantom model", () => {
  // This conversation quotes a whole footer verbatim. A panel whose own footer is not rendered
  // must report nothing rather than inheriting the quoted model.
  const quoted = "I explained the footer renders as: " + footer("Fable 5.1") +
    " ...and then we talked about other things for a long while. " + "x".repeat(FOOTER_CHARS);
  eq(detectModel(quoted), null, "quoted footer outside the footer window is ignored");
});

suite("models: no footer yields null, and garbage never throws", () => {
  eq(detectModel("just a conversation with no footer"), null, "no footer");
  for (const t of [null, undefined, "", "   "]) eq(detectModel(t), null, "safe on " + JSON.stringify(t));
});

suite("models: the premium tier is the $10/$50 models", () => {
  for (const m of ["Fable 5", "Fable 5.1", "Mythos 5", "Mythos 5.1"]) ok(isPremium(m), m + " is premium");
  for (const m of ["Opus 5", "Opus 4.8", "Sonnet 5", "Haiku 4.5"]) eq(isPremium(m), false, m + " is not premium");
  eq(isPremium(null), false, "null is not premium");
  ok(isPremium("fable 5"), "case-insensitive");
  eq(isPremium("Opus 5", ["Opus 5"]), true, "the premium list is configurable");
});

// ── policy ──────────────────────────────────────────────────────────────────
const info = (model) => ({ model, effort: "Medium" });

suite("policy: a worker on the premium model is flagged", () => {
  const repo = makeRepo({ w1: {} });
  const p = new ModelPolicy(repo);
  const v = p.check(new Map([["w1", info("Fable 5")]]), "product-owner", new Set(["w1"]));
  eq(v.length, 1, "one violation");
  eq(v[0].role, "w1", "names the worker");
  eq(v[0].model, "Fable 5", "and the model it must leave");
});

suite("policy: the ORCHESTRATOR keeps the expensive model", () => {
  const repo = makeRepo({ po: {}, w1: {} });
  const p = new ModelPolicy(repo);
  const v = p.check(new Map([["po", info("Fable 5.1")], ["w1", info("Opus 5")]]), "po", new Set(["po", "w1"]));
  eq(v, [], "the orchestrator is exempt and the worker is compliant");
});

// Superseded by MP-001 (2026-09-13): the policy no longer merely forbids the premium tier, it
// enforces the tier the HANDOFF asked for, in both directions. A worker on Sonnet with no
// frontmatter is owed the configured default and is switched UP — which this suite used to assert
// was left alone. What survives is the part that was never about the premium floor: a worker
// already ON its desired tier is not typed into.
suite("policy: a worker already on its desired tier is left alone, whichever tier that is", () => {
  const repo = makeRepo({ w1: {}, w2: {} });
  const p = new ModelPolicy(repo);
  const want = (role) => ({ model: role === "w2" ? "claude-sonnet-5" : "claude-opus-5", chosenBy: "frontmatter", note: null });
  eq(p.check(new Map([["w1", info("Opus 5")], ["w2", info("Sonnet 5")]]), "po", new Set(["w1", "w2"]),
             DEFAULT_PREMIUM, Date.now(), new Map(), null, want), [],
    "each is on the model its own handoff asked for");
});

suite("policy: the desired tier is enforced in BOTH directions (MP-001 R2)", () => {
  const repo = makeRepo({ w1: {}, w2: {} });
  const p = new ModelPolicy(repo);
  // w1 is on Opus and its handoff says Sonnet -> down; w2 is on Sonnet and is owed Opus -> up.
  const want = (role) => ({ model: role === "w1" ? "claude-sonnet-5" : "claude-opus-5",
                            chosenBy: role === "w1" ? "frontmatter" : "default", note: null });
  const v = p.check(new Map([["w1", info("Opus 5")], ["w2", info("Sonnet 5")]]), "po", new Set(["w1", "w2"]),
                    DEFAULT_PREMIUM, Date.now(), new Map(), null, want);
  eq(v.map((x) => [x.role, x.model, x.target]),
     [["w1", "Opus 5", "claude-sonnet-5"], ["w2", "Sonnet 5", "claude-opus-5"]],
     "switched down AND up, each to its own target");
});

suite("policy: a target CHANGE restarts the backoff (MP-001 R2)", () => {
  const repo = makeRepo({ w1: {} });
  const p = new ModelPolicy(repo);
  const models = new Map([["w1", info("Sonnet 5")]]);
  const opus = () => ({ model: "claude-opus-5", chosenBy: "default", note: null });
  const t0 = 1_000_000;
  eq(p.check(models, "po", new Set(["w1"]), DEFAULT_PREMIUM, t0, new Map(), null, opus).length, 1, "first attempt");
  eq(p.check(models, "po", new Set(["w1"]), DEFAULT_PREMIUM, t0 + 1000, new Map(), null, opus).length, 0, "backing off");
  // the handoff is rewritten to ask for something else: that is a NEW correction, not a retry
  const sonnet46 = () => ({ model: "claude-sonnet-4-6", chosenBy: "frontmatter", note: null });
  const again = p.check(models, "po", new Set(["w1"]), DEFAULT_PREMIUM, t0 + 1001, new Map(), null, sonnet46);
  eq(again.length, 1, "a changed target is attempted at once, not after the old backoff");
  eq(again[0].attempt, 1, "and its attempt count restarts");
});

suite("policy: a worker is nudged once, then held off — not every tick", () => {
  const repo = makeRepo({ w1: {} });
  const p = new ModelPolicy(repo);
  const models = new Map([["w1", info("Fable 5")]]);
  const t0 = 1_000_000_000_000;
  eq(p.check(models, "po", new Set(["w1"]), DEFAULT_PREMIUM, t0).length, 1, "flagged the first time");
  eq(p.check(models, "po", new Set(["w1"]), DEFAULT_PREMIUM, t0 + 1000).length, 0, "held off on the next tick");
  const rec = readJson(busPath(repo, "model-policy.json")).pending.w1;
  ok(rec, "remembered on the bus");
  eq(rec.attempts, 1, "one attempt so far");
});

suite("policy: a switch that did NOT take effect is retried after the backoff", () => {
  // The bug this replaced: the role was marked corrected before the injection reported back, so a
  // failed switch was never retried — across restarts too — and the worker silently stayed premium.
  const repo = makeRepo({ w1: {} });
  const p = new ModelPolicy(repo);
  const models = new Map([["w1", info("Fable 5")]]);
  const t0 = 1_000_000_000_000;
  const first = p.check(models, "po", new Set(["w1"]), DEFAULT_PREMIUM, t0);
  eq(first[0].attempt, 1, "attempt 1");
  p.recordResult(first[0], false, "inject failed");             // the switch did not work
  eq(p.check(models, "po", new Set(["w1"]), DEFAULT_PREMIUM, t0 + BACKOFF_MS[0] - 1).length, 0, "still backing off");
  const second = p.check(models, "po", new Set(["w1"]), DEFAULT_PREMIUM, t0 + BACKOFF_MS[0] + 1);
  eq(second.length, 1, "retried once the backoff elapsed");
  eq(second[0].attempt, 2, "and counts as attempt 2");
});

suite("policy: a reported SUCCESS still does not clear the role — only seeing it compliant does", () => {
  const repo = makeRepo({ w1: {} });
  const p = new ModelPolicy(repo);
  const t0 = 1_000_000_000_000;
  const v = p.check(new Map([["w1", info("Fable 5")]]), "po", new Set(["w1"]), DEFAULT_PREMIUM, t0)[0];
  p.recordResult(v, true, "switched");
  ok(p.pending().w1, "still tracked: the footer has not changed yet");
  // now it is actually seen on a cheaper model
  p.check(new Map([["w1", info("Opus 5")]]), "po", new Set(["w1"]), DEFAULT_PREMIUM, t0 + 1);
  eq(p.pending().w1, undefined, "cleared only once verified");
});

suite("policy: the retry backoff grows with each attempt", () => {
  eq(BACKOFF_MS.length > 1, true, "there is a schedule");
  eq(backoffFor(1), BACKOFF_MS[0], "first retry is the shortest");
  eq(backoffFor(2), BACKOFF_MS[1], "then longer");
  eq(backoffFor(99), BACKOFF_MS[BACKOFF_MS.length - 1], "capped, so it never stops retrying nor spams");
  ok(backoffFor(2) > backoffFor(1), "strictly growing");
});

suite("policy: the failure reason is recorded, and cleared on success", () => {
  const repo = makeRepo({ w1: {} });
  const p = new ModelPolicy(repo);
  const v = p.check(new Map([["w1", info("Fable 5")]]), "po", new Set(["w1"]))[0];
  p.recordResult(v, false, "no live target for role");
  match(p.pending().w1.lastError, /no live target/, "reason kept for diagnosis");
  p.recordResult(v, true, "switched");
  eq(p.pending().w1.lastError, undefined, "cleared once it works");
});

suite("policy: a pre-0.7.2 state file does not suppress the check", () => {
  // Old files recorded {corrected}; honouring that shape would re-introduce the never-retry bug.
  const repo = makeRepo({ w1: {} });
  writeJson(busPath(repo, "model-policy.json"), { corrected: { w1: { model: "Fable 5", at: "old" } } });
  const p = new ModelPolicy(repo);
  eq(p.check(new Map([["w1", info("Fable 5")]]), "po", new Set(["w1"])).length, 1,
    "the role is re-checked rather than assumed handled");
});

suite("policy: a worker that drifts back to premium is flagged again", () => {
  const repo = makeRepo({ w1: {} });
  const p = new ModelPolicy(repo);
  p.check(new Map([["w1", info("Fable 5")]]), "po", new Set(["w1"]));       // flagged + corrected
  eq(p.check(new Map([["w1", info("Opus 5")]]), "po", new Set(["w1"])), [], "now compliant");
  eq(p.check(new Map([["w1", info("Fable 5")]]), "po", new Set(["w1"])).length, 1, "drifted again -> flagged again");
});

suite("policy: switching to a DIFFERENT premium model is flagged", () => {
  const repo = makeRepo({ w1: {} });
  const p = new ModelPolicy(repo);
  p.check(new Map([["w1", info("Fable 5")]]), "po", new Set(["w1"]));
  eq(p.check(new Map([["w1", info("Fable 5.1")]]), "po", new Set(["w1"])).length, 1,
    "a different premium model is a new violation, not a dedupe hit");
});

suite("policy: roles that are not live are not touched", () => {
  const repo = makeRepo({ w1: {} });
  const p = new ModelPolicy(repo);
  eq(p.check(new Map([["w1", info("Fable 5")]]), "po", new Set()), [], "stale role skipped");
});

suite("policy: an untagged orchestrator does not exempt anyone", () => {
  // With no orchestrator tagged, every worker is held to the policy.
  const repo = makeRepo({ w1: {} });
  const p = new ModelPolicy(repo);
  eq(p.check(new Map([["w1", info("Fable 5")]]), null, new Set(["w1"])).length, 1, "still enforced");
});

suite("policy: an unfiltered window enforces nothing", () => {
  const p = new ModelPolicy(null);
  eq(p.check(new Map([["w1", info("Fable 5")]]), "po", new Set(["w1"])), [], "no repo -> no policy");
});

suite("policy: enforcement injects /model into the offending session", () => {
  const repo = makeRepo({ w1: {} });
  fs.writeFileSync(path.join(LOOM, "loom_cdp.py"), "import sys\nprint(' '.join(sys.argv[1:]))\n");
  return new Promise((resolve, reject) => {
    new ModelPolicy(repo).enforce({ repo, role: "w1", model: "Fable 5" }, "claude-opus-5", (okFlag) => {
      try {
        ok(okFlag, "inject reported ok");
        const dbg = readJson(path.join(LOOM, "model-policy-debug.json"));
        match(dbg.out, /inject/, "used inject");
        match(dbg.out, /--role w1/, "targeted the offending worker");
        match(dbg.out, /\/model claude-opus-5/, "sent the /model switch");
        match(dbg.out, /--submit/, "submitted it");
        resolve();
      } catch (e) { reject(e); }
    });
  });
});

// ── the chip lags the switch ────────────────────────────────────────────────────────────────────
// Measured 2026-09-13 05:49–05:53 on ReciEats/developer2: "Set model to Opus 5 for this session
// only" printed at once; the footer chip still read "Fable 5.1" a minute later and the policy typed
// the command again; the chip flipped when the next turn began.
const { acknowledgedSwitch } = load("models.js");
const switched = (id, name) => `\nYou: /model ${id}\n/model ${id}\n\nSet model to ${name} for this session only\n`;

suite("models: a fresh 'Set model to' acknowledgement is read off the panel", () => {
  const t = "work…" + switched("claude-opus-5", "Opus 5") + footer("Fable 5.1");
  eq(acknowledgedSwitch(t), "Opus 5", "the switch the session acknowledged");
  eq(detectModel(t), { model: "Fable 5.1", effort: "Medium", acknowledged: "Opus 5" }, "chip still says Fable; acknowledgement carried");
  eq(acknowledgedSwitch("work…" + footer("Fable 5.1")), null, "no /model, no acknowledgement");
  eq(acknowledgedSwitch("You: /model claude-opus-5\n/model claude-opus-5\n\nUnknown model\n" + footer("Fable 5.1")), null, "a refused switch is not one");
});

suite("models: an acknowledgement is only fresh while nothing has happened since", () => {
  const stale = "x" + switched("claude-opus-5", "Opus 5") + "\nYou: carry on\nClaude: ok\n" + footer("Fable 5.1");
  eq(acknowledgedSwitch(stale), null, "a later turn means the chip has had its chance — the chip is the truth");
  const latest = "x" + switched("claude-opus-5", "Opus 5") + switched("claude-fable-5-1[1m]", "Fable 5.1") + footer("Opus 5");
  eq(acknowledgedSwitch(latest), "Fable 5.1", "the LAST switch is the one that counts");
  const welcome = "Untitled\nType /model to pick the right tool for the job.\nIntroducing Fable 5.1\n" + footer("Fable 5.1");
  eq(acknowledgedSwitch(welcome), null, "the welcome tip mentions /model without a switch");
});

suite("policy: a worker whose switch was acknowledged is NOT nudged again while the chip lags", () => {
  const repo = makeRepo({ roles: { alpha: {} } }, "pol-ack");
  const pol = new ModelPolicy(repo);
  const live = new Set(["alpha"]);
  let v = pol.check(new Map([["alpha", detectModel("w" + footer("Fable 5.1"))]]), null, live, DEFAULT_PREMIUM, 1000);
  eq(v.map((x) => x.role), ["alpha"], "first sighting: nudged");
  const lagging = detectModel("w" + switched("claude-opus-5", "Opus 5") + footer("Fable 5.1"));
  v = pol.check(new Map([["alpha", lagging]]), null, live, DEFAULT_PREMIUM, 1000 + 10 * 60_000);
  eq(v, [], "backoff long expired, chip still premium, but the panel says it switched: left alone");
  ok(pol.pending().alpha, "still pending — cleared only when the chip agrees");
  v = pol.check(new Map([["alpha", detectModel("w" + footer("Opus 5"))]]), null, live, DEFAULT_PREMIUM, 1000 + 11 * 60_000);
  eq(v, []); ok(!pol.pending().alpha, "chip caught up: cleared");
  // an acknowledged switch to ANOTHER premium model does not count as compliance
  const wrong = detectModel("w" + switched("claude-fable-5", "Fable 5") + footer("Fable 5.1"));
  v = pol.check(new Map([["alpha", wrong]]), null, live, DEFAULT_PREMIUM, 1000 + 30 * 60_000);
  eq(v.map((x) => x.role), ["alpha"], "still premium after the switch: nudged");
});

// ── the mirror: the orchestrator is promoted ────────────────────────────────────────────────────
suite("policy: the tagged orchestrator found on a cheaper model is promoted — only its frame, only idle", () => {
  const repo = makeRepo({ roles: {} }, "pol-promote");
  const pol = new ModelPolicy(repo);
  const onOpus = detectModel("w" + footer("Opus 5"));
  eq(pol.checkOrchestrator("productowner", "wid-po", onOpus, false, DEFAULT_PREMIUM, 1000),
     { repo, role: "productowner", model: "Opus 5", attempt: 1, target: "claude-fable-5-1[1m]",
       chosenBy: "default", webviewId: "wid-po" }, "promoted, addressed to its frame");
  eq(pol.checkOrchestrator("productowner", "wid-po", onOpus, false, DEFAULT_PREMIUM, 1000 + 1000), null, "held off by the backoff");
  eq(pol.checkOrchestrator("productowner", "wid-po", onOpus, false, DEFAULT_PREMIUM, 1000 + 61_000).attempt, 2, "retried after it");
  eq(pol.checkOrchestrator("productowner", "wid-po", onOpus, true, DEFAULT_PREMIUM, 1000 + 200_000), null, "never while mid-turn");
  eq(pol.checkOrchestrator("productowner", null, onOpus, false, DEFAULT_PREMIUM, 1000 + 200_000), null, "never without a frame");
  eq(pol.checkOrchestrator(null, "wid-po", onOpus, false, DEFAULT_PREMIUM, 1000 + 200_000), null, "never without a tag");
  eq(pol.checkOrchestrator("productowner", "wid-po", null, false, DEFAULT_PREMIUM, 1000 + 200_000), null, "never blind");
  const lagging = detectModel("w" + switched("claude-fable-5-1[1m]", "Fable 5.1") + footer("Opus 5"));
  eq(pol.checkOrchestrator("productowner", "wid-po", lagging, false, DEFAULT_PREMIUM, 1000 + 200_000), null, "acknowledged: chip lagging");
  ok(pol.pending().productowner, "pending until seen");
  eq(pol.checkOrchestrator("productowner", "wid-po", detectModel("w" + footer("Fable 5.1")), false, DEFAULT_PREMIUM, 1000 + 300_000), null);
  ok(!pol.pending().productowner, "cleared once the chip shows the premium model");
});

// ── MS-001 R2 · a refused injection is not "switched" ──────────────────────────────────────────
// Measured against the orchestrator's own frame 2026-09-14T00:04:57Z: loom_cdp.py inject exited 0
// and printed {'ok': False, ..., 'note': 'typed text not confirmed in composer; NOT submitted'};
// enforce() set ok = !err and recorded the refusal as "switched".
const REFUSING_CDP =
  "import sys\n" +
  "print(\"loom_cdp] inject x: {'ok': False, 'role': 'w1', 'composer': 'OK DIV', 'note': 'typed text not confirmed in composer; NOT submitted'}\")\n";

suite("MS-001 R2: exit 0 with a printed 'ok': False is NOT a switch — the injector's note is kept as lastError", () => {
  const repo = makeRepo({ w1: {} }, "ms2-refused");
  fs.writeFileSync(path.join(LOOM, "loom_cdp.py"), REFUSING_CDP);
  const pol = new ModelPolicy(repo);
  const [v] = pol.check(new Map([["w1", info("Fable 5")]]), null, new Set(["w1"]), DEFAULT_PREMIUM, 1000);
  ok(v && v.role === "w1", "a violation to enforce");
  return new Promise((resolve, reject) => {
    pol.enforce(v, "claude-opus-5", (okFlag, note) => {
      try {
        eq(okFlag, false, "exit 0 is not evidence: the printed dict says it was not submitted");
        eq(note, "typed text not confirmed in composer; NOT submitted", "the failure note is the dict's own");
        pol.recordResult(v, okFlag, note);
        eq(pol.pending().w1.lastError, "typed text not confirmed in composer; NOT submitted", "recordResult keeps lastError honest");
        const dbg = readJson(path.join(LOOM, "model-policy-debug.json"));
        eq(dbg.ok, false, "and the debug file says so too");
        resolve();
      } catch (e) { reject(e); }
    });
  });
});

// ── MS-001 R3 · the orchestrator shifts itself ─────────────────────────────────────────────────
const { orchestratorRequest, orchestratorModelFile, DEFAULT_ORCHESTRATOR_MODELS, chipFor } = load("models.js");
const FABLE = "claude-fable-5-1[1m]";
const askFor = (repo, model, reason = "doc banking", at = "2026-09-14T04:00:00Z") =>
  fs.writeFileSync(orchestratorModelFile(repo), JSON.stringify({ model, reason, at }));

suite("MS-001 R3: orchestrator-model.json is honoured when it names an allowed id; absent, the setting stands", () => {
  const repo = makeRepo({ roles: {} }, "ms3-file");
  const pol = new ModelPolicy(repo);
  eq(pol.orchestratorTarget(FABLE), { target: FABLE, self: false, reason: null, requestedAt: null, note: null }, "no file: the configured target, not a self request");
  askFor(repo, "claude-sonnet-5");
  eq(orchestratorRequest(repo), { model: "claude-sonnet-5", reason: "doc banking", at: "2026-09-14T04:00:00Z" }, "the request as written");
  eq(pol.orchestratorTarget(FABLE), { target: "claude-sonnet-5", self: true, reason: "doc banking", requestedAt: "2026-09-14T04:00:00Z", note: null }, "honoured");
  askFor(repo, "CLAUDE-FABLE-5-1");
  eq(pol.orchestratorTarget(FABLE).target, FABLE, "matched on the normalised id, returned in the allowlist's own spelling (with [1m])");
  eq(DEFAULT_ORCHESTRATOR_MODELS, ["claude-fable-5-1[1m]", "claude-opus-5", "claude-sonnet-5"], "the default allowlist");
  fs.writeFileSync(orchestratorModelFile(repo), "{ not json");
  eq(pol.orchestratorTarget(FABLE).target, FABLE, "unreadable: the setting");
  fs.writeFileSync(orchestratorModelFile(repo), JSON.stringify({ reason: "no model key" }));
  eq(orchestratorRequest(repo), null, "no model string: no request");
});

suite("MS-001 R3: an id outside orchestratorModels is refused with a note — once per request — and never enforced", () => {
  const repo = makeRepo({ roles: {} }, "ms3-refuse");
  const pol = new ModelPolicy(repo);
  askFor(repo, "claude-haiku-4-5", "cheap", "2026-09-14T04:01:00Z");
  const r = pol.orchestratorTarget(FABLE);
  eq(r.target, FABLE, "the configured target stands"); eq(r.self, false, "not a self request");
  match(r.note, /orchestrator-model\.json asks for 'claude-haiku-4-5', which is not in orchestratorModels \[claude-fable-5-1\[1m\], claude-opus-5, claude-sonnet-5\]; ignored/, "the refusal, in words");
  eq(pol.orchestratorTarget(FABLE).note, null, "said once, not once per tick");
  eq(new ModelPolicy(repo).orchestratorTarget(FABLE).note, null, "persisted across a reload");
  askFor(repo, "claude-haiku-4-5", "cheap", "2026-09-14T04:02:00Z");
  ok(pol.orchestratorTarget(FABLE).note, "a NEW request (new `at`) is a new refusal");
  // the allowlist is a setting: a project may widen it
  eq(pol.orchestratorTarget(FABLE, ["claude-haiku-4-5"]).target, "claude-haiku-4-5", "widened allowlist honours it");
});

suite("MS-001 R3: checkOrchestrator enforces the resolved target in BOTH directions, on its own frame, idle only", () => {
  const repo = makeRepo({ roles: {} }, "ms3-both");
  const pol = new ModelPolicy(repo);
  const onFable = detectModel("w" + footer("Fable 5.1")), onOpus = detectModel("w" + footer("Opus 5")), onSonnet = detectModel("w" + footer("Sonnet 5"));
  const self = { self: true, reason: "doc banking", requestedAt: "2026-09-14T04:00:00Z" };
  // DOWN: on the premium tier, asked for Sonnet — "chip is premium → fine" is no longer the rule
  let v = pol.checkOrchestrator("productowner", "wid-po", onFable, false, DEFAULT_PREMIUM, 1000, "claude-sonnet-5", self);
  eq(v, { repo, role: "productowner", model: "Fable 5.1", attempt: 1, target: "claude-sonnet-5", chosenBy: "self",
          webviewId: "wid-po", reason: "doc banking", requestedAt: "2026-09-14T04:00:00Z" }, "shifted DOWN on its own request, reason carried");
  eq(pol.checkOrchestrator("productowner", "wid-po", onFable, true, DEFAULT_PREMIUM, 2000, "claude-sonnet-5", self), null, "never mid-turn");
  eq(pol.checkOrchestrator("productowner", "wid-po", onFable, false, DEFAULT_PREMIUM, 2000, "claude-sonnet-5", self), null, "backing off");
  eq(pol.checkOrchestrator("productowner", "wid-po", onSonnet, false, DEFAULT_PREMIUM, 3000, "claude-sonnet-5", self), null, "on the desired model: fine");
  ok(!pol.pending().productowner, "and cleared");
  // a changed target restarts the backoff rather than inheriting the old one
  v = pol.checkOrchestrator("productowner", "wid-po", onSonnet, false, DEFAULT_PREMIUM, 4000, "claude-opus-5", self);
  eq(v.target, "claude-opus-5"); eq(v.attempt, 1, "a fresh correction");
  v = pol.checkOrchestrator("productowner", "wid-po", onSonnet, false, DEFAULT_PREMIUM, 5000, FABLE, null);
  eq(v && v.attempt, 1, "target changed again (file removed → the setting): attempt restarts");
  eq(v.chosenBy, "default", "not a self request");
  // UP, the old default path, unchanged
  const lagging = detectModel("w" + switched(FABLE, "Fable 5.1") + footer("Opus 5"));
  eq(pol.checkOrchestrator("productowner", "wid-po", lagging, false, DEFAULT_PREMIUM, 10 * 60_000, FABLE), null, "acknowledged: chip lagging");
  eq(pol.checkOrchestrator("productowner", "wid-po", onOpus, false, DEFAULT_PREMIUM, 20 * 60_000, "claude-nonesuch-9"), null, "an unknown target is unenforceable");
  ok(!pol.pending().productowner, "and clears the record rather than typing for ever");
  // "chip is the desired model → fine": another premium chip is NOT fine any more
  eq(pol.checkOrchestrator("productowner", "wid-po", detectModel("w" + footer("Fable 5")), false, DEFAULT_PREMIUM, 30 * 60_000, FABLE).target, FABLE,
     "Fable 5 is premium but is not the desired Fable 5.1");
  eq(chipFor(FABLE), "Fable 5.1");
});

suite("MS-001 R3: a performed self-shift appends ONE ledger line — {role, self, from, to, reason, at}; a retry of the same request adds none", () => {
  const repo = makeRepo({ roles: {} }, "ms3-ledger");
  const pol = new ModelPolicy(repo);
  const v = { repo, role: "productowner", model: "Fable 5.1", attempt: 1, target: "claude-sonnet-5", chosenBy: "self",
              webviewId: "wid-po", reason: "doc banking", requestedAt: "2026-09-14T04:00:00Z" };
  ok(pol.recordSelfShift(v, new Date("2026-09-14T04:00:30Z")), "written");
  const lines = () => fs.readFileSync(busPath(repo, "model-ledger.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l));
  eq(lines(), [{ role: "productowner", self: true, from: "Fable 5.1", to: "claude-sonnet-5", reason: "doc banking", at: "2026-09-14T04:00:30.000Z" }], "the line");
  eq(pol.recordSelfShift({ ...v, attempt: 2 }), false, "a retry of the same request: no second line");
  eq(lines().length, 1);
  ok(pol.recordSelfShift({ ...v, requestedAt: "2026-09-14T05:00:00Z", model: "Sonnet 5", target: FABLE }), "a new request: a new line");
  eq(lines()[1].to, FABLE); eq(lines()[1].from, "Sonnet 5");
  eq(pol.recordSelfShift({ ...v, chosenBy: "default" }), false, "the configured promotion is not a self-shift and writes nothing");
  eq(lines().length, 2);
});
