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

suite("policy: workers on cheaper models are left alone", () => {
  const repo = makeRepo({ w1: {}, w2: {} });
  const p = new ModelPolicy(repo);
  eq(p.check(new Map([["w1", info("Opus 5")], ["w2", info("Sonnet 5")]]), "po", new Set(["w1", "w2"])), [],
    "policy only forbids the premium tier, it does not force one model");
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
