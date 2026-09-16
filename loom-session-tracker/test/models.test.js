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

// ── MP-002 · the model policy applies to NON-ORCHESTRATORS ONLY ────────────────────────────────
// Owner, 2026-09-16: "The extension changing orchestrators model version. Must stop. It only applies
// to non-orchestrators." This reversed the 2026-09-13 promotion and MS-001 R3's self-shift, and both
// are gone. `enforce()` is the single chokepoint every `/model` injection passes through, so the
// rule is asserted THERE — a fourth caller written next month inherits the refusal for free.
const LOGGING_CDP = "import sys, os\n" +
  "open(os.path.join(os.path.dirname(os.path.abspath(__file__)), 'inject-log.txt'), 'a').write(' '.join(sys.argv[1:]) + '\\n')\n" +
  "print(' '.join(sys.argv[1:]))\n";
const injectLog = () => {
  try { return fs.readFileSync(path.join(LOOM, "inject-log.txt"), "utf8").split("\n").filter(Boolean); }
  catch { return []; }
};
const clearInjectLog = () => { try { fs.unlinkSync(path.join(LOOM, "inject-log.txt")); } catch {} };
const enforced = (pol, v) => new Promise((res) => pol.enforce(v, v.target, (ok, note) => res({ ok, note })));

suite("MP-002: enforce() REFUSES the tagged orchestrator's own frame — nothing is typed, and the caller is told why", async () => {
  const repo = makeRepo({ productowner: {}, developer1: {} }, "mp2-frame");
  fs.writeFileSync(path.join(LOOM, "loom_cdp.py"), LOGGING_CDP);
  setOrchestrator(repo, "productowner", "wid-po");
  const pol = new ModelPolicy(repo);
  clearInjectLog();
  // the violation names a WORKER role, but the frame resolved for it is the orchestrator's own —
  // the 2026-09-10 misroute, where 16 `/model` messages landed in tfg_ua's orchestrator
  const r = await enforced(pol, { repo, role: "developer1", model: "Fable 5.1", target: "claude-opus-5", webviewId: "wid-po" });
  eq(r.ok, false, "refused");
  match(r.note, /refused: developer1 is the tagged orchestrator's own frame/, "and says which rule: " + r.note);
  eq(injectLog(), [], "NOTHING was typed: " + JSON.stringify(injectLog()));
  // the same worker in its own frame is still switched — the floor is untouched
  const good = await enforced(pol, { repo, role: "developer1", model: "Fable 5.1", target: "claude-opus-5", webviewId: "wid-dev" });
  eq(good.ok, true, "an ordinary worker is still enforced: " + good.note);
  eq(injectLog().length, 1, "exactly one injection, the worker's");
  ok(/--webview-id wid-dev/.test(injectLog()[0]), "into its own frame: " + injectLog()[0]);
});

suite("MP-002: enforce() refuses an OWNER-NAMED role and the TAGGED role by name, tagged or not", async () => {
  const repo = makeRepo({ productowner: {}, po: {}, developer1: {} }, "mp2-name");
  fs.writeFileSync(path.join(LOOM, "loom_cdp.py"), LOGGING_CDP);
  const pol = new ModelPolicy(repo);
  clearInjectLog();
  for (const role of ["productowner", "po", "product-owner", "orchestrator"]) {
    const r = await enforced(pol, { repo, role, model: "Fable 5.1", target: "claude-opus-5", webviewId: "wid-x" });
    eq(r.ok, false, role + " refused");
    match(r.note, /refused: .* is an owner-named role/, role + ": " + r.note);
  }
  eq(injectLog(), [], "nothing typed for any owner spelling — and no tag was needed: " + JSON.stringify(injectLog()));
  // a role that is NOT owner-named but IS the tagged orchestrator (a project may tag any name)
  setOrchestrator(repo, "developer1", "wid-somewhere-else");
  const r = await enforced(pol, { repo, role: "developer1", model: "Fable 5.1", target: "claude-opus-5", webviewId: "wid-dev" });
  eq(r.ok, false, "the tagged role is refused even under a worker's name, and even in another frame");
  match(r.note, /refused: developer1 is the tagged orchestrator\b/, r.note);
  eq(injectLog(), [], "still nothing typed");
});

suite("MP-002: the tag is re-read per injection — a tag set between ticks is honoured at once", async () => {
  const repo = makeRepo({ developer1: {} }, "mp2-fresh");
  fs.writeFileSync(path.join(LOOM, "loom_cdp.py"), LOGGING_CDP);
  const pol = new ModelPolicy(repo);          // constructed BEFORE the project is tagged
  clearInjectLog();
  const before = await enforced(pol, { repo, role: "developer1", model: "Fable 5.1", target: "claude-opus-5", webviewId: "wid-dev" });
  eq(before.ok, true, "untagged: an ordinary worker switch");
  setOrchestrator(repo, "developer1", "wid-dev");           // the human tags that very tab
  const after = await enforced(pol, { repo, role: "developer1", model: "Fable 5.1", target: "claude-opus-5", webviewId: "wid-dev" });
  eq(after.ok, false, "the SAME policy object refuses now — the bus is read fresh, not cached at construction");
  eq(injectLog().length, 1, "only the first, pre-tag injection ever happened");
});

suite("MP-002: the self-shift mechanism is gone from the module's surface — orchestrator-model.json is inert by code", () => {
  const m = load("models.js");
  for (const gone of ["checkOrchestrator", "orchestratorTarget", "recordSelfShift", "orchestratorRequest",
                      "orchestratorModelFile", "DEFAULT_ORCHESTRATOR_MODELS"]) {
    eq(m[gone], undefined, gone + " is no longer exported");
  }
  eq(typeof new ModelPolicy("x").checkOrchestrator, "undefined", "and the method is gone from the class");
  // the three worker rules the owner explicitly kept
  eq(typeof m.desiredModel, "function", "the handoff still chooses a worker's tier");
  eq(typeof new ModelPolicy("x").check, "function", "the premium floor still runs");
  eq(m.DEFAULT_PREMIUM.includes("Fable 5.1"), true, "and the premium tier is still named");
});


