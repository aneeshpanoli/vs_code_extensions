// reachback.test.js — PB-001 §2b: playbook §11 supplied rather than reminded.
//
// The claim this file pins is the one the owner cares about: nobody has to remember the reach-back
// block, and supplying it produces NO message to anybody. The interesting assertions are the
// refusals — the cases where writing would be worse than not writing.

const { suite, ok, eq, load, makeRepo, busPath, writeJson } = require("./harness");
const fs = require("fs");
const path = require("path");
const { hasReachBack, reachBackBlock, supplyReachBack, REACHBACK_MARK } = load("reachback.js");
const { setOrchestrator } = load("orchestrator.js");

function inbox(repo, role, text) {
  const f = busPath(repo, role, "inbox.md");
  fs.mkdirSync(path.dirname(f), { recursive: true });
  fs.writeFileSync(f, text);
  return f;
}
const read = (repo, role) => fs.readFileSync(busPath(repo, role, "inbox.md"), "utf8");
const brief = (id, body = "# Do the thing\n\nSome brief.\n") =>
  `---\nid: ${id}\nrole: dev1\nmodel: claude-opus-5\n---\n\n${body}`;

function bus() {
  const repo = makeRepo({ po: {}, dev1: {} });
  setOrchestrator(repo, "po", "frame-1");
  return repo;
}

suite("reachback: a handoff with no reach-back gets one, and it addresses the orchestrator", () => {
  const repo = bus();
  inbox(repo, "dev1", brief("AB-001"));
  const r = supplyReachBack(repo, "dev1", "AB-001");
  ok(r.supplied, `supplied: ${r.note}`);
  const text = read(repo, "dev1");
  ok(text.includes("# RESPONSE AB-001"),
     "names the literal first line a watcher greps for (DEV-031's stall)");
  ok(text.includes(`@${repo}/po.id`), "rings the orchestrator through its id FILE (DEV-047)");
  ok(/reach_po\.py/.test(text), "by the tool that cannot fall through to a fingerprint (§13)");
  ok(/REFUSED/.test(text) && /last_line/.test(text), "and gives the stale-id fallback");
  ok(text.includes("Some brief."), "the original brief is untouched");
  ok(text.indexOf("Some brief.") < text.indexOf("HOW TO REACH ME BACK"), "the block is appended");
});

suite("reachback: THE RING IS MANDATORY, NEVER 'the outbox reached them'", () => {
  // DEV-041: a worker wrote a perfect outbox and stopped, because the instruction let the outbox
  // count as leg 1. The orchestrator's watcher had died with a context clear, which the worker
  // cannot observe. It sat finished and green from 22:38 until a human noticed.
  const repo = bus();
  inbox(repo, "dev1", brief("AB-002"));
  supplyReachBack(repo, "dev1", "AB-002");
  const text = read(repo, "dev1");
  ok(/mandatory, not a fallback/.test(text), "the ring is stated as mandatory");
  ok(/outbox alone only reaches/.test(text), "and why the outbox alone is not reaching anyone");
});

suite("reachback: an orchestrator that wrote its OWN block is not argued with", () => {
  // False negatives here cost one redundant block in a file; false positives cost a stalled
  // round-trip. So anything that names the tool, an id file, or the §11 heading counts as present.
  const repo = bus();
  for (const own of [
    "## HOW TO REACH ME BACK\nring me somehow\n",
    "Reply by running reach_po.py when done.\n",
    "Ring @proj/productowner.id with a one-line gist.\n",
    "Here is how to reach me back: shout.\n",
  ]) {
    inbox(repo, "dev1", brief("AB-003") + own);
    const r = supplyReachBack(repo, "dev1", "AB-003");
    ok(!r.supplied, `left alone: ${own.slice(0, 28)}…`);
    ok(!read(repo, "dev1").includes(REACHBACK_MARK), "nothing appended");
  }
});

suite("reachback: it never appends twice, on any number of ticks", () => {
  const repo = bus();
  inbox(repo, "dev1", brief("AB-004"));
  ok(supplyReachBack(repo, "dev1", "AB-004").supplied, "first tick supplies");
  for (let i = 0; i < 20; i++) {
    eq(supplyReachBack(repo, "dev1", "AB-004").supplied, false, `tick ${i + 2} is a no-op`);
  }
  eq(read(repo, "dev1").split(REACHBACK_MARK).length - 1, 1, "exactly one block in the file");
});

suite("reachback: THE ID IS RE-CHECKED AGAINST THE BYTES ABOUT TO BE REWRITTEN", () => {
  // §12 step 2 has the orchestrator overwrite inbox.md with the NEXT brief as its first move after
  // banking, and a tick can land inside that window. A block appended to a replaced brief would name
  // the PREVIOUS block's `# RESPONSE` heading — a reply nobody's watcher greps for, which is DEV-031
  // with this tool's fingerprints on it. Worse than supplying nothing.
  const repo = bus();
  inbox(repo, "dev1", brief("AB-005"));
  const r = supplyReachBack(repo, "dev1", "AB-004");          // the id we decided on is now stale
  ok(!r.supplied, "refused");
  ok(/different handoff/.test(r.note), `and says why: ${r.note}`);
  ok(!read(repo, "dev1").includes("RESPONSE AB-004"), "the wrong heading was never written");
});

suite("reachback: an untagged bus gets nothing — an invented return address is worse than none", () => {
  const repo = makeRepo({ po: {}, dev1: {} });                // deliberately NOT tagged
  inbox(repo, "dev1", brief("AB-006"));
  const r = supplyReachBack(repo, "dev1", "AB-006");
  ok(!r.supplied, "refused");
  ok(/no tagged orchestrator/.test(r.note), `named: ${r.note}`);
  ok(!read(repo, "dev1").includes(REACHBACK_MARK), "file untouched");
  // The alternative would be to guess at a frame by content, which §13 bans outright: two funisland
  // rings landed in another project's PO tab that merely QUOTES the word "product-owner".
});

suite("reachback: the orchestrator's own inbox is not a handoff", () => {
  const repo = bus();
  inbox(repo, "po", brief("AB-007"));
  const r = supplyReachBack(repo, "po", "AB-007");
  ok(!r.supplied, "a role does not write handoffs to itself");
});

suite("reachback: an inbox with no id, or no file, is left alone", () => {
  const repo = bus();
  eq(supplyReachBack(repo, "dev1", null).supplied, false, "no id — nothing to address");
  eq(supplyReachBack(repo, "ghost", "AB-008").supplied, false, "no inbox file");
  eq(supplyReachBack(null, "dev1", "AB-008").supplied, false, "no repo");
});

suite("reachback: hasReachBack is honest about an empty file", () => {
  eq(hasReachBack(""), false, "empty");
  eq(hasReachBack(null), false, "null");
  eq(hasReachBack("a brief with no address in it at all"), false, "plain prose");
  eq(hasReachBack(REACHBACK_MARK), true, "our own mark");
});

suite("reachback: the block says it was supplied by the tool, not by the orchestrator", () => {
  // The orchestrator did not write these words and must not appear to have. An orchestrator reading
  // its own worker's inbox should be able to tell what it wrote from what was filled in for it.
  const b = reachBackBlock({ repo: "proj", role: "dev1", sender: "po", id: "ZZ-001" });
  ok(/Supplied by loom-session-tracker/.test(b), "attributed to the tool");
  ok(/not by po/.test(b), "and explicitly not to the sender");
});

suite("reachback: SUPPLYING SENDS NO MESSAGE TO ANYBODY", () => {
  // Ranks 1 and 2 of the owner's ranking are the two that add nothing to anyone's transcript, and
  // that is the whole reason this is rank 2 rather than a well-worded reminder. The only artefact a
  // supply may leave is the inbox file itself.
  const repo = bus();
  inbox(repo, "dev1", brief("AB-009"));
  supplyReachBack(repo, "dev1", "AB-009");
  for (const f of ["clear-debug.json", "stall-debug.json", "delegate-debug.json",
                   "gate-debug.json", "notify-debug.json", "brief-debug.json"]) {
    ok(!fs.existsSync(busPath(repo, f)), `no ${f} was written`);
  }
});

suite("reachback: the write is atomic and leaves no temp file behind", () => {
  const repo = bus();
  inbox(repo, "dev1", brief("AB-010"));
  supplyReachBack(repo, "dev1", "AB-010");
  const left = fs.readdirSync(busPath(repo, "dev1")).filter((f) => f.includes(".tmp."));
  eq(left.length, 0, "no .tmp. files survive the rename");
});

suite("reachback: an explicit sender overrides the tag, and is used verbatim", () => {
  // The tick passes the tag it already resolved, so the file is not re-read once per role per tick.
  const repo = bus();
  inbox(repo, "dev1", brief("AB-011"));
  ok(supplyReachBack(repo, "dev1", "AB-011", "chief").supplied, "supplied");
  ok(read(repo, "dev1").includes(`@${repo}/chief.id`), "addressed to the sender given");
});
