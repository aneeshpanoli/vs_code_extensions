// handoff-model.test.js — MP-001: the ORCHESTRATOR chooses a worker's tier per handoff, in that
// handoff's frontmatter; the tracker enforces it; the ledger judges the rubric later.
//
// These are the pure/fs-only halves (R1 desiredModel, R4 escalation, R5 ledger). The halves that
// TYPE into a tab are tested through activate() in extension.test.js, per the owner's rule that no
// injection is proved by a planner alone.
const { suite, ok, eq, load, makeRepo, busPath, writeJson, readJson } = require("./harness");
const fs = require("fs");
const path = require("path");
const { desiredModel, frontmatter, chipFor, idIsPremium, normalizeId, ModelPolicy,
        handoffId, DEFAULT_WORKER_MODELS } = load("models.js");

/** Write a role's inbox.md verbatim — fixtures are the whole point of this file. */
function inbox(repo, role, text) {
  const f = busPath(repo, role, "inbox.md");
  fs.mkdirSync(path.dirname(f), { recursive: true });
  fs.writeFileSync(f, text);
  return f;
}
const handoff = (id, model) =>
  `---\nid: ${id}\nfrom: productowner\nto: developer2\n` + (model ? `model: ${model}\n` : "") +
  `---\n# ${id} — a brief\n\nbody text, and a --- rule further down\n\n---\n\nmore body\n`;

// ── R1 · the table ──────────────────────────────────────────────────────────────────────────────

suite("R1: the chip <-> id table maps both ways, and no rule could have done it", () => {
  eq(chipFor("claude-sonnet-5"), "Sonnet 5", "id -> chip");
  eq(chipFor("claude-fable-5-1"), "Fable 5.1", "a dotted chip from a hyphenated id");
  eq(chipFor("claude-fable-5-1[1m]"), "Fable 5.1", "the [1m] context suffix is not part of the model");
  eq(chipFor("CLAUDE-OPUS-5"), "Opus 5", "case-insensitive");
  eq(chipFor("claude-nonesuch-9"), null, "an unknown id names no chip");
  eq(normalizeId("  Claude-Opus-5[1m] "), "claude-opus-5", "normalisation: trim, lower, drop suffix");
  ok(idIsPremium("claude-fable-5-1[1m]"), "fable is the orchestrator tier");
  eq(idIsPremium("claude-sonnet-5"), false, "sonnet is not");
  eq(idIsPremium("claude-nonesuch-9"), false, "an unknown id is not premium — the allowlist refuses it, with a reason");
});

// ── R1 · frontmatter parsing, one fixture per way it can go wrong ───────────────────────────────

suite("R1: a handoff that names an allowed model is honoured", () => {
  const repo = makeRepo({ dev: {} }, "dm-ok");
  inbox(repo, "dev", handoff("MP-001", "claude-sonnet-5"));
  const d = desiredModel(repo, "dev", "claude-opus-5");
  eq(d.model, "claude-sonnet-5", "the handoff's choice");
  eq(d.chosenBy, "frontmatter");
  eq(d.note, null, "an honoured request needs no note");
  eq(handoffId(repo, "dev"), "MP-001", "and its id is readable");
});

suite("R1: NO frontmatter at all falls back to the configured default, silently", () => {
  const repo = makeRepo({ dev: {} }, "dm-none");
  inbox(repo, "dev", "# MP-002 — a brief with no front matter\n\nmodel: claude-sonnet-5\n");
  const d = desiredModel(repo, "dev", "claude-opus-5");
  eq(d.model, "claude-opus-5", "the default");
  eq(d.chosenBy, "default");
  eq(d.note, null, "an ABSENT choice is not a refused one — no note");
  eq(handoffId(repo, "dev"), null, "and no id");
});

suite("R1: a `model:` line in the BODY is not frontmatter", () => {
  const repo = makeRepo({ dev: {} }, "dm-body");
  // the block must OPEN the file; the `---` here is a horizontal rule further down
  inbox(repo, "dev", "# a brief\n\n---\nmodel: claude-sonnet-5\n---\n");
  eq(desiredModel(repo, "dev", "claude-opus-5").model, "claude-opus-5",
     "a rule mid-document cannot set a worker's tier");
});

suite("R1: a MALFORMED block (never closed) changes nothing", () => {
  const repo = makeRepo({ dev: {} }, "dm-bad");
  inbox(repo, "dev", "---\nid: MP-003\nmodel: claude-sonnet-5\n\n# the closing fence is missing\n");
  const d = desiredModel(repo, "dev", "claude-opus-5");
  eq(d.model, "claude-opus-5", "unreadable frontmatter is not a request");
  eq(d.note, null);
});

suite("R1: a frontmatter block with no `model:` line falls back", () => {
  const repo = makeRepo({ dev: {} }, "dm-nomodel");
  inbox(repo, "dev", handoff("MP-004", null));
  const d = desiredModel(repo, "dev", "claude-opus-5");
  eq(d.model, "claude-opus-5");
  eq(d.chosenBy, "default");
  eq(d.note, null);
});

suite("R1: a PREMIUM id is ignored and SAYS SO — and stays ignored if workerModels is widened", () => {
  const repo = makeRepo({ dev: {} }, "dm-prem");
  inbox(repo, "dev", handoff("MP-005", "claude-fable-5-1[1m]"));
  const d = desiredModel(repo, "dev", "claude-opus-5");
  eq(d.model, "claude-opus-5", "never enforced");
  eq(d.chosenBy, "default");
  ok(/premium tier is orchestrator-only/.test(d.note || ""), "with a note: " + d.note);
  // the floor is the TABLE, not the allowlist: widening the setting must not open the tier
  const wide = desiredModel(repo, "dev", "claude-opus-5", ["claude-opus-5", "claude-fable-5-1[1m]"]);
  eq(wide.model, "claude-opus-5", "a premium id in workerModels is still refused");
  ok(/premium tier is orchestrator-only/.test(wide.note || ""), "and still says why");
});

suite("R1: an UNKNOWN id is ignored and names the allowlist", () => {
  const repo = makeRepo({ dev: {} }, "dm-unk");
  inbox(repo, "dev", handoff("MP-006", "claude-haiku-4-5"));
  const d = desiredModel(repo, "dev", "claude-opus-5");
  eq(d.model, "claude-opus-5", "haiku is out for workers");
  ok(/not in workerModels/.test(d.note || ""), "with a note: " + d.note);
  eq(desiredModel(repo, "dev", "claude-opus-5", ["claude-opus-5", "claude-haiku-4-5"]).model,
     "claude-haiku-4-5", "…but the allowlist is what decides it, and it is a setting");
});

suite("R1: extra whitespace, quotes, a comment and CRLF are all survivable", () => {
  const repo = makeRepo({ dev: {} }, "dm-ws");
  inbox(repo, "dev", "---\r\n  id :  MP-007  \r\n   model :   \"claude-sonnet-5\"   # chosen by the rubric\r\n---\r\nbody\r\n");
  const d = desiredModel(repo, "dev", "claude-opus-5");
  eq(d.model, "claude-sonnet-5", "quotes, padding, comment and CRLF all stripped");
  eq(handoffId(repo, "dev"), "MP-007", "and the id too");
  eq(frontmatter("---\nk: 'v'\n---\n").k, "v", "single quotes as well");
});

suite("R1: no inbox file at all is the default, and never throws", () => {
  const repo = makeRepo({ dev: {} }, "dm-missing");
  eq(desiredModel(repo, "dev", "claude-opus-5").model, "claude-opus-5");
  eq(desiredModel(null, "dev", "claude-opus-5").model, "claude-opus-5", "no repo either");
  eq(frontmatter(null), {}, "and a null document parses to nothing");
});

// ── R4 · escalation ─────────────────────────────────────────────────────────────────────────────

suite("R4: two loop-backs on ONE handoff raise it to Opus; the third does not rewrite again", () => {
  const repo = makeRepo({ dev: {} }, "esc-two");
  const f = inbox(repo, "dev", handoff("MP-010", "claude-sonnet-5"));
  const p = new ModelPolicy(repo);

  writeJson(busPath(repo, "dev", "status.json"), { status: "blocked", current: "MP-010", updated_at: "T1" });
  eq(p.escalate("dev", "claude-opus-5"), null, "one loop-back is not enough");
  eq(desiredModel(repo, "dev", "claude-opus-5").model, "claude-sonnet-5", "still Sonnet after one");

  // the same status re-read on a later tick is the SAME report, not a second one
  eq(p.escalate("dev", "claude-opus-5"), null, "re-reading an unchanged status.json counts nothing");
  eq(desiredModel(repo, "dev", "claude-opus-5").model, "claude-sonnet-5", "still Sonnet");

  writeJson(busPath(repo, "dev", "status.json"), { status: "blocked", current: "MP-010", updated_at: "T2" });
  const e = p.escalate("dev", "claude-opus-5");
  ok(e && e.to === "claude-opus-5" && e.id === "MP-010", "the second loop-back escalates: " + JSON.stringify(e));
  eq(desiredModel(repo, "dev", "claude-opus-5").model, "claude-opus-5", "the frontmatter now asks for Opus");
  ok(p.wasEscalated("MP-010"), "and it is recorded as escalated, not chosen");

  // ONLY that line changed
  const text = fs.readFileSync(f, "utf8");
  ok(/^id: MP-010$/m.test(text), "the id line is untouched");
  ok(/^from: productowner$/m.test(text), "and every other frontmatter line");
  ok(/body text, and a --- rule further down/.test(text), "and the body, rule and all");
  eq((text.match(/^model:/gm) || []).length, 1, "exactly one model line");

  writeJson(busPath(repo, "dev", "status.json"), { status: "blocked", current: "MP-010", updated_at: "T3" });
  eq(p.escalate("dev", "claude-opus-5"), null, "a THIRD loop-back does not rewrite again");
});

suite("R4: escalation refuses once the inbox holds a DIFFERENT handoff", () => {
  const repo = makeRepo({ dev: {} }, "esc-moved");
  inbox(repo, "dev", handoff("MP-011", "claude-sonnet-5"));
  const p = new ModelPolicy(repo);
  for (const t of ["T1", "T2"]) {
    writeJson(busPath(repo, "dev", "status.json"), { status: "blocked", current: "MP-011", updated_at: t });
    if (t === "T2") inbox(repo, "dev", handoff("MP-012", "claude-sonnet-5"));   // the PO wrote the next brief
    p.escalate("dev", "claude-opus-5");
  }
  eq(desiredModel(repo, "dev", "claude-opus-5").model, "claude-sonnet-5",
     "the NEXT handoff's deliberate Sonnet is not raised by the last one's loop-backs");
});

suite("R4: a handoff already on Opus, or a role that is not blocked, escalates nothing", () => {
  const repo = makeRepo({ dev: {} }, "esc-noop");
  inbox(repo, "dev", handoff("MP-013", "claude-opus-5"));
  const p = new ModelPolicy(repo);
  for (const t of ["T1", "T2"]) {
    writeJson(busPath(repo, "dev", "status.json"), { status: "blocked", current: "MP-013", updated_at: t });
    eq(p.escalate("dev", "claude-opus-5"), null, "nowhere to escalate to");
  }
  const repo2 = makeRepo({ dev: {} }, "esc-working");
  inbox(repo2, "dev", handoff("MP-014", "claude-sonnet-5"));
  const p2 = new ModelPolicy(repo2);
  for (const t of ["T1", "T2", "T3"]) {
    writeJson(busPath(repo2, "dev", "status.json"), { status: "working", current: "MP-014", updated_at: t });
    eq(p2.escalate("dev", "claude-opus-5"), null, "'working' is not a loop-back");
  }
  eq(desiredModel(repo2, "dev", "claude-opus-5").model, "claude-sonnet-5", "untouched");
});

// ── R5 · the ledger ─────────────────────────────────────────────────────────────────────────────

const ledgerLines = (repo) => {
  try {
    return fs.readFileSync(busPath(repo, "model-ledger.jsonl"), "utf8")
      .split("\n").filter(Boolean).map((l) => JSON.parse(l));
  } catch { return []; }
};

suite("R5: a line is appended when the role reports idle having handled that id, with its shape", () => {
  const repo = makeRepo({ dev: {} }, "led-idle");
  inbox(repo, "dev", handoff("MP-020", "claude-sonnet-5"));
  const p = new ModelPolicy(repo);

  writeJson(busPath(repo, "dev", "status.json"),
            { status: "working", current: "MP-020", updated_at: "T1", tests_before: 563 });
  p.ledgerTick("dev", "claude-opus-5");
  eq(ledgerLines(repo).length, 0, "nothing is written while the block is in flight");

  writeJson(busPath(repo, "dev", "status.json"),
            { status: "idle", last_handled: "MP-020", updated_at: "T9", tests_before: 563, tests_after: 590 });
  p.ledgerTick("dev", "claude-opus-5");
  const l = ledgerLines(repo);
  eq(l.length, 1, "one line per (role, handoff)");
  eq(l[0], { id: "MP-020", role: "dev", model: "claude-sonnet-5", chosenBy: "frontmatter",
             started: "T1", finished: "T9", loopBacks: 0, testsBefore: 563, testsAfter: 590 },
     "the full shape");

  p.ledgerTick("dev", "claude-opus-5");
  p.ledgerTick("dev", "claude-opus-5");
  eq(ledgerLines(repo).length, 1, "and it is not appended again on every later tick");
});

suite("R5: a line is also closed when the NEXT handoff lands over the old one", () => {
  const repo = makeRepo({ dev: {} }, "led-next");
  inbox(repo, "dev", handoff("MP-021", "claude-sonnet-5"));
  const p = new ModelPolicy(repo);
  writeJson(busPath(repo, "dev", "status.json"), { status: "working", current: "MP-021", updated_at: "T1" });
  p.ledgerTick("dev", "claude-opus-5");
  inbox(repo, "dev", handoff("MP-022", null));                       // the PO overwrote the brief
  writeJson(busPath(repo, "dev", "status.json"), { status: "working", current: "MP-022", updated_at: "T2" });
  p.ledgerTick("dev", "claude-opus-5");
  const l = ledgerLines(repo);
  eq(l.length, 1, "the abandoned block is still recorded");
  eq(l[0].id, "MP-021");
  eq(l[0].model, "claude-sonnet-5");
  // …and the new one is now open, on the default tier
  writeJson(busPath(repo, "dev", "status.json"), { status: "idle", last_handled: "MP-022", updated_at: "T3" });
  p.ledgerTick("dev", "claude-opus-5");
  const l2 = ledgerLines(repo);
  eq(l2.length, 2);
  eq(l2[1].id, "MP-022");
  eq(l2[1].model, "claude-opus-5");
  eq(l2[1].chosenBy, "default", "no frontmatter -> the configured default, and the ledger says so");
});

suite("R5: a line that cannot be completed is written with NULLS, not skipped", () => {
  const repo = makeRepo({ dev: {} }, "led-null");
  inbox(repo, "dev", handoff("MP-023", "claude-sonnet-5"));
  const p = new ModelPolicy(repo);
  writeJson(busPath(repo, "dev", "status.json"), { status: "working", current: "MP-023", updated_at: "T1" });
  p.ledgerTick("dev", "claude-opus-5");
  writeJson(busPath(repo, "dev", "status.json"), { status: "idle", last_handled: "MP-023", updated_at: "T2" });
  p.ledgerTick("dev", "claude-opus-5");
  const l = ledgerLines(repo);
  eq(l.length, 1, "written, not skipped, though it knows no test counts");
  eq(l[0].testsBefore, null);
  eq(l[0].testsAfter, null);
  eq(l[0].id, "MP-023", "and everything it DOES know is there");
});

suite("R5: an escalated block is recorded as escalated, with its loop-backs counted", () => {
  const repo = makeRepo({ dev: {} }, "led-esc");
  inbox(repo, "dev", handoff("MP-024", "claude-sonnet-5"));
  const p = new ModelPolicy(repo);
  writeJson(busPath(repo, "dev", "status.json"), { status: "working", current: "MP-024", updated_at: "T0" });
  p.ledgerTick("dev", "claude-opus-5");
  for (const t of ["T1", "T2"]) {
    writeJson(busPath(repo, "dev", "status.json"), { status: "blocked", current: "MP-024", updated_at: t });
    p.escalate("dev", "claude-opus-5");
    p.ledgerTick("dev", "claude-opus-5");
  }
  writeJson(busPath(repo, "dev", "status.json"), { status: "idle", last_handled: "MP-024", updated_at: "T3" });
  p.ledgerTick("dev", "claude-opus-5");
  const l = ledgerLines(repo);
  eq(l.length, 1);
  eq(l[0].chosenBy, "escalated", "not 'frontmatter' — the tracker wrote that line, not the orchestrator");
  eq(l[0].model, "claude-opus-5", "and the tier it ended on");
  eq(l[0].loopBacks, 2, "with the loop-backs that caused it");
});

suite("R5: the ledger is APPEND-only — an existing file is never rewritten", () => {
  const repo = makeRepo({ dev: {} }, "led-append");
  const f = busPath(repo, "model-ledger.jsonl");
  fs.mkdirSync(path.dirname(f), { recursive: true });
  fs.writeFileSync(f, JSON.stringify({ id: "OLD-1", role: "dev" }) + "\n");
  inbox(repo, "dev", handoff("MP-025", null));
  const p = new ModelPolicy(repo);
  writeJson(busPath(repo, "dev", "status.json"), { status: "working", current: "MP-025", updated_at: "T1" });
  p.ledgerTick("dev", "claude-opus-5");
  writeJson(busPath(repo, "dev", "status.json"), { status: "idle", last_handled: "MP-025", updated_at: "T2" });
  p.ledgerTick("dev", "claude-opus-5");
  const l = ledgerLines(repo);
  eq(l.length, 2, "the older line survived");
  eq(l[0].id, "OLD-1", "verbatim, and still first");
});

suite("R5/R4: state survives alongside pending — no section clobbers another", () => {
  const repo = makeRepo({ dev: {} }, "led-coexist");
  inbox(repo, "dev", handoff("MP-026", "claude-sonnet-5"));
  const p = new ModelPolicy(repo);
  writeJson(busPath(repo, "dev", "status.json"), { status: "blocked", current: "MP-026", updated_at: "T1" });
  p.escalate("dev", "claude-opus-5");
  p.ledgerTick("dev", "claude-opus-5");
  // a model check writes `pending` into the same file
  p.check(new Map([["dev", { model: "Fable 5", effort: null }]]), "po", new Set(["dev"]));
  const st = readJson(busPath(repo, "model-policy.json"));
  ok(st.pending && st.pending.dev, "pending written");
  ok(st.escalations && st.escalations["MP-026"], "escalation count survived the pending write");
  ok(st.ledger && st.ledger.dev, "and the open ledger line survived it too");
  eq(st.escalations["MP-026"].blocked, 1);
});
