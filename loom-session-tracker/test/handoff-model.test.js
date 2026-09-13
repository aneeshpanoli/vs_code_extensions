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
        handoffId, rewriteHandoffModel, DEFAULT_WORKER_MODELS } = load("models.js");

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

// ── FX-001 R1 · an ack is not a handoff ─────────────────────────────────────────────────────────
// The orchestrator's reply to a handoff is written into the SAME inbox.md, with `id: <handoff>-ack`
// — a new id, so `handoffId()` (unfixed) opened a ledger line and an escalation record for a block
// nobody works. See models.ts `isAckId`.

suite("FX-001 R1: an inbox with `id: X-ack` opens nothing — handoffId is null", () => {
  const repo = makeRepo({ dev: {} }, "ack-id");
  inbox(repo, "dev", handoff("CH-001-ack", "claude-sonnet-5"));
  eq(handoffId(repo, "dev"), null, "an ack id is not a handoff id");
});

suite("FX-001 R1: `id: X` (no -ack) still opens, same as always", () => {
  const repo = makeRepo({ dev: {} }, "ack-id-real");
  inbox(repo, "dev", handoff("CH-001", "claude-sonnet-5"));
  eq(handoffId(repo, "dev"), "CH-001", "a real id is untouched by the ack check");
});

suite("FX-001 R1: the -ack check is case-insensitive and tolerant of trailing whitespace", () => {
  const repo = makeRepo({ dev: {} }, "ack-id-ws");
  inbox(repo, "dev", "---\nid: CH-002-ACK  \nfrom: productowner\nto: dev\n---\nbody\n");
  eq(handoffId(repo, "dev"), null, "upper-case ACK with trailing padding is still an ack");
});

suite("FX-001 R1: an ack carrying a `model:` line is never enforced", () => {
  const repo = makeRepo({ dev: {} }, "ack-model");
  inbox(repo, "dev", handoff("CH-003-ack", "claude-sonnet-5"));
  const d = desiredModel(repo, "dev", "claude-opus-5");
  eq(d.model, "claude-opus-5", "the ack's model: line is not a worker's own request");
  eq(d.chosenBy, "default");
  eq(d.note, null, "an ack is not a refused request either — no note");
});

suite("FX-001 R1: a state file carrying -ack records loses them on save", () => {
  const repo = makeRepo({ dev: {} }, "ack-purge");
  const stateFile = busPath(repo, "model-policy.json");
  writeJson(stateFile, {
    pending: {},
    escalations: { "CH-004-ack": { role: "dev", blocked: 2, escalated: true },
                   "CH-004": { role: "dev", blocked: 1 } },
    ledger: { dev: { id: "CH-004-ack", role: "dev", model: "claude-sonnet-5", chosenBy: "frontmatter",
                     started: "T1", loopBacks: 0, testsBefore: null } },
  });
  // a real handoff for a DIFFERENT role, just to give ModelPolicy something to save through
  inbox(repo, "other", handoff("CH-005", "claude-sonnet-5"));
  writeJson(busPath(repo, "other", "status.json"), { status: "blocked", updated_at: "T1" });
  const p = new ModelPolicy(repo);
  p.escalate("other", "claude-opus-5");                      // any call that reaches saveState
  const st = readJson(stateFile);
  eq(Object.keys(st.escalations).filter((k) => /-ack$/i.test(k)), [], "the ack escalation entry is gone");
  ok("CH-004" in st.escalations, "…but the real one for the same role survives");
  eq(st.ledger.dev, undefined, "the ledger line whose id is an ack is gone too (keyed by role, not id)");
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

// The id re-check is pinned DIRECTLY, not through escalate(). Driving escalate() cannot reach it:
// the escalation count is keyed by handoff id, so an inbox replaced before the decision is already
// refused by the keying, and the record for the new id simply has no loop-backs yet. A mutant that
// removed this line survived a test that drove escalate() — the test passed for the wrong reason.
// What only this guard can refuse is an inbox replaced BETWEEN the decision and the write, which is
// the window playbook §12 step 2 opens every single cycle. (Principle 17.)
suite("R4: the rewrite REFUSES a handoff whose id has changed under it, and never half-writes", () => {
  const repo = makeRepo({ dev: {} }, "esc-race");
  const f = inbox(repo, "dev", handoff("MP-031", "claude-sonnet-5"));
  const before = fs.readFileSync(f, "utf8");

  eq(rewriteHandoffModel(repo, "dev", "MP-030", "claude-opus-5"), false,
     "the decision was made about MP-030; the inbox now holds MP-031");
  eq(fs.readFileSync(f, "utf8"), before, "and not one byte of the new brief was touched");

  eq(rewriteHandoffModel(repo, "dev", "MP-031", "claude-opus-5"), true, "the matching id does rewrite");
  const after = fs.readFileSync(f, "utf8");
  ok(/^model: claude-opus-5$/m.test(after), "that line, changed");
  eq(after.replace(/^model: claude-opus-5$/m, "model: claude-sonnet-5"), before, "and ONLY that line");

  // a handoff with no `model:` line has nothing to rewrite, and is left alone rather than grown one
  const repo2 = makeRepo({ dev: {} }, "esc-race2");
  const g = inbox(repo2, "dev", handoff("MP-032", null));
  const untouched = fs.readFileSync(g, "utf8");
  eq(rewriteHandoffModel(repo2, "dev", "MP-032", "claude-opus-5"), false, "no line to rewrite");
  eq(fs.readFileSync(g, "utf8"), untouched, "and none is invented");

  // no inbox at all: refuses, never throws
  eq(rewriteHandoffModel(makeRepo({ dev: {} }, "esc-race3"), "dev", "MP-033", "claude-opus-5"), false,
     "a missing inbox is a refusal, not a crash");
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
  // The FULL shape, deep-equal, so a field added without a decision about its null case cannot slip
  // in unnoticed. The four CH-001 size fields are here at their unreadable values on purpose: these
  // fixtures use "T1"/"T9" as stamps (no duration), declare no `files:`, and call ledgerTick with no
  // contextPct — which is the ordinary case for a role below ~50 % context, not an exotic one.
  eq(l[0], { id: "MP-020", role: "dev", model: "claude-sonnet-5", chosenBy: "frontmatter",
             started: "T1", finished: "T9", loopBacks: 0, testsBefore: 563, testsAfter: 590,
             contextPctAtFinish: null, wallMinutes: null, filesDeclared: 0, statusUpdates: 2 },
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

// ════════════════════════════════════════════════════════════════════════════════════════════════
// CH-001 — chunking guards. §19 sets two rules: SIZE (one handoff is one merge) and PARALLELISM (one
// developer per file-disjoint package). The parallelism rule is the one a machine can enforce, from
// the `files:` line; the size rule is one it can only MEASURE, in the ledger. These are the pure and
// fs-only halves; the spawn refusal and the warning are driven through activate() in extension.test.js.
// ════════════════════════════════════════════════════════════════════════════════════════════════

const { declaredFiles, handoffFiles } = load("models.js");
const { pathsCollide, firstShared, overlapFor, workingRoles, overlapReason } = load("overlap.js");

/** A handoff with a `files:` line. `files === null` omits the line entirely. */
const withFiles = (id, files, model) =>
  `---\nid: ${id}\nfrom: productowner\nto: dev\n` + (model ? `model: ${model}\n` : "") +
  (files === null ? "" : `files: ${files}\n`) + `---\n# ${id}\n\nthe brief\n`;

// ── R1 · the `files:` line ──────────────────────────────────────────────────────────────────────

suite("CH-001 R1: `files:` is read comma- OR space-separated, and normalised", () => {
  eq(declaredFiles(withFiles("C-1", "src/models.ts, src/requests.ts")), ["src/models.ts", "src/requests.ts"],
     "§19's own example spelling: commas");
  eq(declaredFiles(withFiles("C-2", "src/models.ts src/requests.ts")), ["src/models.ts", "src/requests.ts"],
     "and spaces, which is how a human writes it");
  eq(declaredFiles(withFiles("C-3", "  src/a.ts ,,  src/b.ts ,")), ["src/a.ts", "src/b.ts"],
     "stray whitespace and empty entries dropped");
  eq(declaredFiles(withFiles("C-4", '"src/a.ts", \'src/b.ts\'')), ["src/a.ts", "src/b.ts"],
     "per-path quotes dropped");
  eq(declaredFiles(withFiles("C-5", "./src/a.ts, src//b/, src/a.ts")), ["src/a.ts", "src/b"],
     "`./`, doubled and trailing slashes normalised, and the duplicate collapsed");
  eq(declaredFiles(withFiles("C-6", "src/*.ts, test/*")), ["src/*.ts", "test/*"],
     "a glob is kept verbatim — it is a pattern, not a path to normalise away");
});

suite("CH-001 R1: an ABSENT `files:` line is an empty list, never a claim (principle 16)", () => {
  eq(declaredFiles(withFiles("C-7", null)), [], "a frontmatter with no `files:` declares nothing");
  eq(declaredFiles("# a brief with no frontmatter at all\n\nfiles: src/a.ts\n"), [],
     "a `files:` line in the BODY is not a declaration");
  eq(declaredFiles("---\nid: C-8\nfiles: src/a.ts\n\n# never closed\n"), [],
     "a malformed block declares nothing");
  eq(declaredFiles(null), [], "no text at all");
  eq(declaredFiles(withFiles("C-9", "")), [], "an EMPTY `files:` line is an absence too");
  // The one bound worth stating: a multi-line YAML list parses as an empty value, so it declares
  // nothing — the SAFE direction (no refusals), not a silently wrong answer.
  eq(declaredFiles("---\nid: C-10\nfiles:\n  - src/a.ts\n  - src/b.ts\n---\n# brief\n"), [],
     "a multi-line list is not read, and declares nothing rather than something wrong");
});

suite("CH-001 R1: handoffFiles reads it off a role's real inbox, and never throws", () => {
  const repo = makeRepo({ dev: {} }, "cf-read");
  inbox(repo, "dev", withFiles("C-11", "src/models.ts, test/*.js"));
  eq(handoffFiles(repo, "dev"), ["src/models.ts", "test/*.js"]);
  eq(handoffFiles(repo, "nobody"), [], "a role with no inbox declares nothing, and does not crash");
  eq(handoffFiles(null, "dev"), [], "no repo either");
});

// ── R2 · what counts as the same file ───────────────────────────────────────────────────────────

suite("CH-001 R2: the same file written from two different roots IS a collision", () => {
  ok(pathsCollide("src/models.ts", "src/models.ts"), "the easy case");
  // Not hypothetical: CH-001's own frontmatter says `src/models.ts` (relative to the extension dir)
  // while RB-001's status.json listed `loom-session-tracker/src/models.ts` (relative to the repo
  // root). A string comparison would call this bus's own collision "disjoint".
  ok(pathsCollide("src/models.ts", "loom-session-tracker/src/models.ts"), "extension-dir vs repo-root");
  ok(pathsCollide("loom-session-tracker/src/models.ts", "src/models.ts"), "symmetric");
  ok(pathsCollide("./src/models.ts", "src/models.ts"), "after normalisation");
});

suite("CH-001 R2: the suffix match is anchored on a path SEGMENT, not on characters", () => {
  eq(pathsCollide("src/models.ts", "other/src/mymodels.ts"), false, "`mymodels.ts` is a different file");
  eq(pathsCollide("src/models.ts", "xsrc/models.ts"), false, "and `xsrc/` is a different directory");
  eq(pathsCollide("src/models.ts", "src/models.ts.bak"), false, "a longer name is not the same file");
  eq(pathsCollide("src/a.ts", "src/b.ts"), false, "two files of one directory are disjoint");
  eq(pathsCollide("", "src/a.ts"), false, "an empty declaration collides with nothing");
});

suite("CH-001 R2: a `*` is a wildcard, in either declaration", () => {
  ok(pathsCollide("src/*.ts", "src/models.ts"), "mine is the glob");
  ok(pathsCollide("src/models.ts", "src/*.ts"), "theirs is the glob");
  ok(pathsCollide("test/*", "test/handoff-model.test.js"), "a directory glob");
  eq(pathsCollide("src/*.ts", "test/models.test.js"), false, "and it does not reach another directory");
});

suite("CH-001 R2: firstShared reports MY spelling of the first file we both claim", () => {
  eq(firstShared(["src/a.ts", "src/models.ts"], ["loom-session-tracker/src/models.ts"]), "src/models.ts",
     "the declaration being refused is the one worth printing");
  eq(firstShared(["src/a.ts"], ["src/b.ts"]), null);
  eq(firstShared([], ["src/a.ts"]), null, "declaring nothing shares nothing");
  eq(firstShared(["src/a.ts"], []), null, "and neither does the other side");
});

// ── R2 · the overlap decision, over a real bus ──────────────────────────────────────────────────

suite("CH-001 R2: a handoff that collides with a WORKING role's is refused, naming both", () => {
  const repo = makeRepo({ alpha: {}, beta: {} }, "ov-hit");
  inbox(repo, "alpha", withFiles("C-20", "src/models.ts, src/requests.ts"));
  inbox(repo, "beta", withFiles("C-21", "README.md, loom-session-tracker/src/models.ts"));
  writeJson(busPath(repo, "alpha", "status.json"), { status: "working", current: "C-20" });
  const ov = overlapFor(repo, "beta");
  eq(ov && ov.other, "alpha", "the working role it collides with");
  eq(ov && ov.file, "loom-session-tracker/src/models.ts", "in beta's own spelling");
  eq(overlapReason(ov), "overlaps alpha on loom-session-tracker/src/models.ts", "the reason, verbatim");
  eq(overlapFor(repo, "alpha"), null, "and alpha is not refused by itself — a role never overlaps itself");
});

suite("CH-001 R2: NEVER refuse on absence — a missing `files:` line on EITHER side is no opinion", () => {
  const repo = makeRepo({ alpha: {}, beta: {} }, "ov-absent");
  inbox(repo, "alpha", withFiles("C-22", null));                   // the working role declares nothing
  inbox(repo, "beta", withFiles("C-23", "src/models.ts"));
  writeJson(busPath(repo, "alpha", "status.json"), { status: "working", current: "C-22" });
  eq(overlapFor(repo, "beta"), null, "an undeclared handoff is not one that touches nothing");
  const repo2 = makeRepo({ alpha: {}, beta: {} }, "ov-absent2");   // and the other way round
  inbox(repo2, "alpha", withFiles("C-24", "src/models.ts"));
  inbox(repo2, "beta", withFiles("C-25", null));
  writeJson(busPath(repo2, "alpha", "status.json"), { status: "working", current: "C-24" });
  eq(overlapFor(repo2, "beta"), null, "the role being judged declared nothing either");
  eq(overlapFor(makeRepo({ alpha: {} }, "ov-absent3"), "alpha"), null, "an empty bus refuses nothing");
});

suite("CH-001 R2: only a role that is actually WORKING blocks another", () => {
  const repo = makeRepo({ alpha: {}, beta: {} }, "ov-idle");
  inbox(repo, "alpha", withFiles("C-26", "src/models.ts"));
  inbox(repo, "beta", withFiles("C-27", "src/models.ts"));
  for (const s of ["idle", "blocked", "done", ""]) {
    writeJson(busPath(repo, "alpha", "status.json"), { status: s, current: "C-26" });
    eq(overlapFor(repo, "beta"), null, `a role that is "${s}" holds no files`);
  }
  writeJson(busPath(repo, "alpha", "status.json"), { status: "WORKING", current: "C-26" });
  ok(overlapFor(repo, "beta"), "and the check is case-insensitive on the status");
  eq(workingRoles(repo), ["alpha"], "the working roster is just that one");
});

suite("CH-001 R2: a role being opened in the SAME breath counts as live", () => {
  const repo = makeRepo({ alpha: {}, beta: {} }, "ov-also");
  inbox(repo, "alpha", withFiles("C-28", "src/models.ts"));
  inbox(repo, "beta", withFiles("C-29", "src/*.ts"));
  eq(overlapFor(repo, "beta"), null, "nobody is working yet, so on the bus alone these are disjoint");
  const ov = overlapFor(repo, "beta", ["alpha"]);
  eq(ov && ov.other, "alpha", "but one request naming both must still refuse the second");
  eq(overlapFor(repo, "beta", ["beta"]), null, "and passing ITSELF in changes nothing");
});

// ── R3 · the ledger measures the size rule ──────────────────────────────────────────────────────

suite("CH-001 R3: filesDeclared, statusUpdates, wallMinutes and contextPctAtFinish are recorded", () => {
  const repo = makeRepo({ dev: {} }, "sz-all");
  inbox(repo, "dev", withFiles("C-30", "src/models.ts, src/requests.ts, test/*.js", "claude-sonnet-5"));
  const p = new ModelPolicy(repo);
  // a real pair of stamps, so wallMinutes is a number rather than the null the older fixtures give
  writeJson(busPath(repo, "dev", "status.json"),
            { status: "working", current: "C-30", updated_at: "2026-09-13T10:00:00Z", tests_before: 623 });
  p.ledgerTick("dev", "claude-opus-5", DEFAULT_WORKER_MODELS, new Date(), 41);
  writeJson(busPath(repo, "dev", "status.json"),
            { status: "idle", last_handled: "C-30", updated_at: "2026-09-13T11:12:00Z",
              tests_before: 623, tests_after: 660 });
  p.ledgerTick("dev", "claude-opus-5", DEFAULT_WORKER_MODELS, new Date(), 67);
  const l = ledgerLines(repo);
  eq(l.length, 1);
  eq(l[0].filesDeclared, 3, "three paths declared");
  eq(l[0].wallMinutes, 72, "10:00 -> 11:12 is 72 MINUTES, not 72 of anything else");
  eq(l[0].contextPctAtFinish, 67, "the pct the CLOSING tick measured, not the opening one");
  eq(l[0].statusUpdates, 2, "two distinct `updated_at` values were seen");
  eq(l[0].testsBefore, 623);
  eq(l[0].testsAfter, 660);
});

suite("CH-001 R3: every new field is NULL rather than guessed when it cannot be read", () => {
  const repo = makeRepo({ dev: {} }, "sz-null");
  inbox(repo, "dev", withFiles("C-31", null));                   // declares no files
  const p = new ModelPolicy(repo);
  writeJson(busPath(repo, "dev", "status.json"), { status: "working", current: "C-31" });  // no updated_at
  p.ledgerTick("dev", "claude-opus-5");                                                    // no contextPct
  writeJson(busPath(repo, "dev", "status.json"), { status: "idle", last_handled: "C-31" });
  p.ledgerTick("dev", "claude-opus-5");
  const l = ledgerLines(repo);
  eq(l.length, 1, "written, not skipped");
  eq(l[0].contextPctAtFinish, null, "NOT 0 — the panel renders no percentage below ~50%, and 0% is a lie");
  eq(l[0].statusUpdates, null, "NOT 0 — a count of zero would read as 'it never moved'");
  eq(l[0].filesDeclared, 0, "but an ABSENT `files:` line really is zero paths declared, not unknown");
  // `started`/`finished` fall back to now(), which parses, so wallMinutes is a real (tiny) number
  ok(typeof l[0].wallMinutes === "number", "and a wall time it could compute: " + l[0].wallMinutes);
});

suite("CH-001 R3: wallMinutes is null when a stamp will not parse, never zero", () => {
  const repo = makeRepo({ dev: {} }, "sz-wall");
  inbox(repo, "dev", withFiles("C-32", "src/a.ts"));
  const p = new ModelPolicy(repo);
  writeJson(busPath(repo, "dev", "status.json"), { status: "working", current: "C-32", updated_at: "T1" });
  p.ledgerTick("dev", "claude-opus-5");
  writeJson(busPath(repo, "dev", "status.json"), { status: "idle", last_handled: "C-32", updated_at: "T9" });
  p.ledgerTick("dev", "claude-opus-5");
  eq(ledgerLines(repo)[0].wallMinutes, null, "'T1' to 'T9' is not a duration");
});

suite("CH-001 R3: statusUpdates counts REPORTS, not the ticks that re-read them", () => {
  const repo = makeRepo({ dev: {} }, "sz-reports");
  inbox(repo, "dev", withFiles("C-33", "src/a.ts"));
  const p = new ModelPolicy(repo);
  writeJson(busPath(repo, "dev", "status.json"), { status: "working", current: "C-33", updated_at: "T1" });
  for (let i = 0; i < 5; i++) p.ledgerTick("dev", "claude-opus-5");     // five ticks, ONE report
  writeJson(busPath(repo, "dev", "status.json"), { status: "working", current: "C-33", updated_at: "T2" });
  for (let i = 0; i < 5; i++) p.ledgerTick("dev", "claude-opus-5");     // five more, one more report
  writeJson(busPath(repo, "dev", "status.json"), { status: "idle", last_handled: "C-33", updated_at: "T3" });
  p.ledgerTick("dev", "claude-opus-5");
  eq(ledgerLines(repo)[0].statusUpdates, 3,
     "3 distinct stamps across 11 ticks — otherwise this measures how long the window was open");
});

suite("CH-001 R3: filesDeclared follows the inbox if the PO widens the SAME handoff mid-block", () => {
  const repo = makeRepo({ dev: {} }, "sz-widen");
  inbox(repo, "dev", withFiles("C-34", "src/a.ts"));
  const p = new ModelPolicy(repo);
  writeJson(busPath(repo, "dev", "status.json"), { status: "working", current: "C-34", updated_at: "T1" });
  p.ledgerTick("dev", "claude-opus-5");
  inbox(repo, "dev", withFiles("C-34", "src/a.ts, src/b.ts, src/c.ts"));   // same id, more files
  writeJson(busPath(repo, "dev", "status.json"), { status: "idle", last_handled: "C-34", updated_at: "T2" });
  p.ledgerTick("dev", "claude-opus-5");
  eq(ledgerLines(repo)[0].filesDeclared, 3, "the ledger records what the block actually claimed");
});

// ── R4 · the escalation record is pruned once the LEDGER holds it ───────────────────────────────

suite("CH-001 R4: an escalation record is dropped once its ledger line is appended", () => {
  const repo = makeRepo({ dev: {} }, "pr-gone");
  inbox(repo, "dev", withFiles("C-40", "src/a.ts", "claude-sonnet-5"));
  const p = new ModelPolicy(repo);
  writeJson(busPath(repo, "dev", "status.json"), { status: "working", current: "C-40", updated_at: "T0" });
  p.ledgerTick("dev", "claude-opus-5");
  for (const t of ["T1", "T2"]) {
    writeJson(busPath(repo, "dev", "status.json"), { status: "blocked", current: "C-40", updated_at: t });
    p.escalate("dev", "claude-opus-5");
    p.ledgerTick("dev", "claude-opus-5");
  }
  ok(readJson(busPath(repo, "model-policy.json")).escalations["C-40"], "the record exists while it is needed");
  writeJson(busPath(repo, "dev", "status.json"), { status: "idle", last_handled: "C-40", updated_at: "T3" });
  p.ledgerTick("dev", "claude-opus-5");
  const st = readJson(busPath(repo, "model-policy.json"));
  eq(st.escalations["C-40"], undefined, "and is gone once the durable record exists");
  const l = ledgerLines(repo);
  eq(l.length, 1);
  eq(l[0].chosenBy, "escalated", "the ledger line IS that durable record…");
  eq(l[0].loopBacks, 2, "…and it kept the count the pruned record held");
  p.ledgerTick("dev", "claude-opus-5");
  eq(ledgerLines(repo).length, 1, "pruning the record does not reopen the block");
});

suite("CH-001 R4: a record whose ledger line could NOT be written SURVIVES", () => {
  const repo = makeRepo({ dev: {} }, "pr-stay");
  inbox(repo, "dev", withFiles("C-41", "src/a.ts", "claude-sonnet-5"));
  // The ledger path is a DIRECTORY, so appendFileSync fails (EISDIR) — which the ledger swallows, so
  // that a write cannot break a tick. Pruning anyway would destroy the ONLY record of the escalation.
  fs.mkdirSync(busPath(repo, "model-ledger.jsonl"), { recursive: true });
  const p = new ModelPolicy(repo);
  writeJson(busPath(repo, "dev", "status.json"), { status: "working", current: "C-41", updated_at: "T0" });
  p.ledgerTick("dev", "claude-opus-5");
  for (const t of ["T1", "T2"]) {
    writeJson(busPath(repo, "dev", "status.json"), { status: "blocked", current: "C-41", updated_at: t });
    p.escalate("dev", "claude-opus-5");
    p.ledgerTick("dev", "claude-opus-5");
  }
  writeJson(busPath(repo, "dev", "status.json"), { status: "idle", last_handled: "C-41", updated_at: "T3" });
  p.ledgerTick("dev", "claude-opus-5");
  const st = readJson(busPath(repo, "model-policy.json"));
  ok(st.escalations && st.escalations["C-41"], "the escalation record is still there");
  eq(st.escalations["C-41"].escalated, true, "with the decision it recorded");
  eq(st.escalations["C-41"].blocked, 2, "and the count behind it");
});

// A block ABANDONED after exactly one tick is the ONLY path that uses the value `filesDeclared` was
// given when the line OPENED — every longer block has it refreshed by a later tick, which is how a
// mutant setting the open-site value to 0 survived a suite that asserted the field everywhere else.
// This is playbook §12 step 2's own window: the orchestrator's first move after banking is to write
// the next brief over the inbox, and a tick can land immediately after it.
suite("CH-001 R3: a block ABANDONED after one tick still records what IT declared", () => {
  const repo = makeRepo({ dev: {} }, "sz-abandon");
  inbox(repo, "dev", withFiles("C-35", "src/models.ts, src/requests.ts"));
  const p = new ModelPolicy(repo);
  writeJson(busPath(repo, "dev", "status.json"), { status: "working", current: "C-35", updated_at: "T1" });
  p.ledgerTick("dev", "claude-opus-5");                  // opens, and is never ticked again
  inbox(repo, "dev", withFiles("C-36", "docs/README.md"));   // the PO wrote the NEXT brief over it
  writeJson(busPath(repo, "dev", "status.json"), { status: "working", current: "C-36", updated_at: "T2" });
  p.ledgerTick("dev", "claude-opus-5");                  // closes C-35 through the id-changed path
  const l = ledgerLines(repo);
  eq(l.length, 1);
  eq(l[0].id, "C-35");
  eq(l[0].filesDeclared, 2, "the TWO files C-35 declared, not the one its replacement declares");
  eq(l[0].statusUpdates, 1, "and the single report it was seen with");
});
