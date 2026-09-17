// overlap.test.js — OV-001: the overlap guard, the exemption that makes it usable, and the three
// laws that keep it from stalling a bus.
//
// WHY THIS FILE EXISTS AT ALL. CH-001's overlap tests live in handoff-model.test.js beside
// `declaredFiles`, and they all passed while the guard was refusing NOTHING on the real bus: they
// exercised the one-line `files:` spelling, and this bus writes the list spelling. That is the shape
// of the failure worth a file of its own — every unit green, the behaviour absent — so the suites
// here drive the decision the way the bus actually writes it, and the last one asserts the end-to-end
// fact CH-001's units could not: a multi-line declaration now genuinely refuses.
//
// THE DIRECTION OF FAILURE IS INVERTED HERE (OV-001 §3). Every other detector on this bus REMINDS,
// so a false positive costs a glance. This one REFUSES: a false positive blocks a dispatch and stalls
// the bus, and the orchestrator may not understand why. So the assertions below are weighted toward
// the NEGATIVE — what must NOT refuse — and any doubt (an unparseable list, an absent line, a file
// that is not there) must resolve to "no collision declared".
const { suite, ok, eq, load, makeRepo, busPath, writeJson } = require("./harness");
const fs = require("fs");
const path = require("path");

const { declaredFiles, handoffFiles } = load("models.js");
const { pathsCollide, firstShared, sharedFile, isMechanicalMerge, overlapFor, overlapReason } = load("overlap.js");

function inbox(repo, role, text) {
  const f = busPath(repo, role, "inbox.md");
  fs.mkdirSync(path.dirname(f), { recursive: true });
  fs.writeFileSync(f, text);
  return f;
}
/** A handoff declaring `files:` the way THIS bus writes it — an indented list. */
const listHandoff = (id, files) =>
  `---\nid: ${id}\nfrom: productowner\nto: dev\nmodel: claude-opus-5\n` +
  `files:\n${files.map((f) => `  - ${f}\n`).join("")}---\n# ${id}\n\nthe brief\n`;
const working = (repo, role, id) => writeJson(busPath(repo, role, "status.json"), { status: "working", current: id });

// ── the exemption, as a predicate ───────────────────────────────────────────────────────────────

suite("OV-001: isMechanicalMerge names exactly two files, from either root", () => {
  ok(isMechanicalMerge("package.json"), "the manifest, whose churn here is a one-line version bump");
  ok(isMechanicalMerge("test/mutation.py"), "the registry, whose churn here is an APPEND to MUTATIONS");
  // The same two-roots problem the collision test has: a handoff writes `package.json` relative to the
  // extension dir, a status.json writes `loom-session-tracker/package.json` relative to the repo root.
  ok(isMechanicalMerge("loom-session-tracker/package.json"), "repo-root spelling of the same file");
  ok(isMechanicalMerge("loom-session-tracker/test/mutation.py"), "and of the registry");
  ok(isMechanicalMerge("./package.json"), "normalised before it is judged");
});

suite("OV-001: the exemption is LITERAL and segment-anchored — it never over-reaches", () => {
  eq(isMechanicalMerge("src/models.ts"), false, "a source file is not mechanically mergeable");
  eq(isMechanicalMerge("mutation.py"), false, "the registry is `test/mutation.py`; a bare name is a different file");
  eq(isMechanicalMerge("test/mutation.py.bak"), false, "a longer name is not the same file");
  eq(isMechanicalMerge("other/package.json.tmpl"), false, "nor a longer name on the manifest");
  eq(isMechanicalMerge("xpackage.json"), false, "anchored on a path SEGMENT, not on characters");
  eq(isMechanicalMerge("packages/package.jsonx"), false, "and the extension is part of the name");
  eq(isMechanicalMerge(""), false, "an empty declaration is not an exemption");
  eq(isMechanicalMerge(null), false, "and neither is no declaration at all");
});

suite("OV-001: a WILDCARD is never exempted away — `*` would otherwise exempt ITSELF", () => {
  // This is the dangerous reading, and the reason the test is literal rather than run through
  // pathsCollide: `*` matches `package.json`, so expanding the declaration here would let a sloppy
  // `files: *` — a claim on EVERY file — exempt itself and refuse nothing at all.
  eq(isMechanicalMerge("*"), false, "a claim on everything is not a claim on two mergeable files");
  eq(isMechanicalMerge("test/*"), false, "a claim on the whole test directory keeps its whole claim");
  eq(isMechanicalMerge("package.*"), false, "and a glob over the manifest's name is not the manifest");
  eq(sharedFile(["test/*"], ["test/handoff-model.test.js"]), "test/*",
     "so a directory glob still collides with a real file in it");
  eq(sharedFile(["*"], ["src/models.ts"]), "*", "and `*` still collides with everything non-exempt");
  // The exemption is applied to BOTH declarations. If it were applied only to the one being judged,
  // a glob on this side would still be refused by an exempt file on the other.
  eq(sharedFile(["test/*"], ["test/mutation.py"]), null,
     "a glob against a registry-only block is not a refusal — the OTHER side is exempted too");
  eq(sharedFile(["test/mutation.py"], ["test/*"]), null, "and symmetrically");
});

// ── the decision ────────────────────────────────────────────────────────────────────────────────

suite("OV-001: the exemption REMOVES refusals and can never create one", () => {
  eq(sharedFile(["package.json"], ["loom-session-tracker/package.json"]), null,
     "a version bump on both sides is not a collision — it is the cheapest merge in this repo");
  eq(sharedFile(["test/mutation.py"], ["test/mutation.py"]), null, "nor is an append to the registry");
  eq(sharedFile(["package.json", "test/mutation.py"], ["test/mutation.py", "package.json"]), null, "nor both");
  // It shrinks both declarations before they are compared, so every refusal it leaves is one the
  // unexempted decision would also have made. That is what makes it safe in §3's direction.
  eq(sharedFile(["package.json", "src/models.ts"], ["package.json", "src/models.ts"]), "src/models.ts",
     "a REAL shared file still refuses, and is the one named — not the manifest it was hiding behind");
  eq(sharedFile(["src/a.ts"], ["src/b.ts"]), null, "and disjoint work is still disjoint");
});

suite("OV-001: firstShared keeps its own meaning — the exemption is policy layered on identity", () => {
  // pathsCollide/firstShared answer "do these name the same file", which is a fact and does not
  // change. sharedFile answers "should this refuse", which is a judgement. Keeping them apart is why
  // the exemption could be argued with without re-opening the collision rule.
  eq(firstShared(["package.json"], ["package.json"]), "package.json", "identity is unchanged");
  ok(pathsCollide("package.json", "loom-session-tracker/package.json"), "and so is the two-roots rule");
});

// ── the three laws, at the real call site ───────────────────────────────────────────────────────

suite("OV-001: THE GUARD NOW ACTUALLY REFUSES on the spelling this bus writes", () => {
  // The regression that matters. Every CH-001 unit passed while this was false, because they were
  // written in the one-line spelling and the bus writes lists.
  const repo = makeRepo({ alpha: {}, beta: {} }, "ov1-live");
  inbox(repo, "alpha", listHandoff("O-40", ["loom-session-tracker/src/models.ts", "loom-session-tracker/package.json"]));
  inbox(repo, "beta", listHandoff("O-41", ["src/models.ts", "package.json"]));
  eq(handoffFiles(repo, "alpha").length, 2, "a list declaration is read off a real inbox at all");
  working(repo, "alpha", "O-40");
  const ov = overlapFor(repo, "beta");
  ok(ov, "and two roles editing models.ts from two roots are refused — which never happened before");
  eq(ov.other, "alpha");
  eq(ov.file, "src/models.ts", "named in BETA's own spelling, so the orchestrator can act not guess");
  eq(overlapReason(ov), "overlaps alpha on src/models.ts", "the reason names the file, verbatim");
});

suite("OV-001: the live case — two handoffs sharing ONLY a version bump are dispatched", () => {
  // Measured on the real bus: developer1's OV-001 and developer2's block collided on
  // `loom-session-tracker/package.json` and on nothing else. Refusing that buys nothing.
  const repo = makeRepo({ alpha: {}, beta: {} }, "ov1-pkg");
  inbox(repo, "alpha", listHandoff("O-42", ["loom-session-tracker/src/delegation.ts", "loom-session-tracker/package.json"]));
  inbox(repo, "beta", listHandoff("O-43", ["loom-session-tracker/src/overlap.ts", "loom-session-tracker/package.json",
                                           "loom-session-tracker/test/mutation.py"]));
  working(repo, "alpha", "O-42");
  eq(overlapFor(repo, "beta"), null, "disjoint work plus a shared manifest is disjoint work");
  eq(firstShared(handoffFiles(repo, "beta"), handoffFiles(repo, "alpha")), "loom-session-tracker/package.json",
     "and without the exemption it WOULD have refused, on the manifest alone");
});

suite("OV-001 §3: ABSENCE never refuses, on either side, at the list spelling too", () => {
  const repo = makeRepo({ alpha: {}, beta: {} }, "ov1-absent");
  inbox(repo, "alpha", "---\nid: O-44\nfrom: productowner\n---\n# no files line\n");
  inbox(repo, "beta", listHandoff("O-45", ["src/models.ts"]));
  working(repo, "alpha", "O-44");
  eq(overlapFor(repo, "beta"), null, "an undeclared handoff is one we cannot judge, not one that touches nothing");
  // Most buses on this machine declare no `files:` at all. Refusing on silence would make the line
  // compulsory by stealth and break every one of them.
  const repo2 = makeRepo({ alpha: {}, beta: {} }, "ov1-absent2");
  inbox(repo2, "alpha", listHandoff("O-46", ["src/models.ts"]));
  inbox(repo2, "beta", "---\nid: O-47\n---\n# no files line either\n");
  working(repo2, "alpha", "O-46");
  eq(overlapFor(repo2, "beta"), null, "and the same when it is the role being JUDGED that is silent");
});

suite("OV-001 §3: DOUBT never refuses — an unreadable declaration is not a collision", () => {
  const repo = makeRepo({ alpha: {}, beta: {} }, "ov1-doubt");
  inbox(repo, "beta", listHandoff("O-48", ["src/models.ts"]));
  working(repo, "alpha", "O-49");
  // alpha is WORKING and has no inbox at all: the file is missing, not empty.
  eq(overlapFor(repo, "beta"), null, "a missing inbox declares nothing rather than everything");
  // A half-written list — the orchestrator was interrupted mid-write — reads the entries it can and
  // guesses about no others. Here the block never closes, so there is no frontmatter and no claim.
  inbox(repo, "alpha", "---\nid: O-49\nfiles:\n  - src/models.ts\n");
  eq(overlapFor(repo, "beta"), null, "an unclosed block is a doubt, and a doubt is not a refusal");
  eq(declaredFiles("---\nid: O-50\nfiles:\n  - \n---\n"), [], "an empty item is not a path");
  // And a role whose declaration is ONLY exempt files holds nothing anyone can collide with.
  inbox(repo, "alpha", listHandoff("O-51", ["package.json"]));
  eq(overlapFor(repo, "beta"), null, "a role that only bumps the version blocks nobody");
  eq(overlapFor(repo, "alpha"), null, "and is itself blocked by nobody");
});

suite("OV-001: a role opened in the SAME breath is judged too, and still gets the exemption", () => {
  const repo = makeRepo({ alpha: {}, beta: {} }, "ov1-also");
  inbox(repo, "alpha", listHandoff("O-52", ["src/models.ts", "package.json"]));
  inbox(repo, "beta", listHandoff("O-53", ["src/*.ts", "package.json"]));
  eq(overlapFor(repo, "beta"), null, "nobody is working yet");
  const ov = overlapFor(repo, "beta", ["alpha"]);
  eq(ov && ov.file, "src/*.ts", "one request naming both still refuses the second, on the REAL overlap");
  const repo2 = makeRepo({ alpha: {}, beta: {} }, "ov1-also2");
  inbox(repo2, "alpha", listHandoff("O-54", ["src/a.ts", "package.json"]));
  inbox(repo2, "beta", listHandoff("O-55", ["src/b.ts", "test/mutation.py", "package.json"]));
  eq(overlapFor(repo2, "beta", ["alpha"]), null,
     "and two disjoint briefs opened together are no longer refused over their version bumps");
});

// ── what the adversarial pass found, pinned ─────────────────────────────────────────────────────
//
// A refutation subagent was asked to break the three claims above. It could not construct a case
// where the exemption CREATES a refusal — filtering both lists is monotone, so every refusal that
// survives is one the unexempted decision would also have made — but it found something better: the
// live pair goes disjoint for a reason that is only PARTLY the exemption. These suites pin that, so
// the exemption is never credited for a gap it did not close.

suite("OV-001: a bare DIRECTORY declaration matches nothing inside it — pre-existing, pinned here", () => {
  // `normalizeDeclaredPath` strips the trailing slash and `patternRe` anchors on `$`, so a declared
  // `test/` is a claim on a path literally named `test` and on no file under it. This is CH-001's
  // rule, not OV-001's, and the writer's own remedy is a glob (`test/*`). It is pinned because the
  // exemption is about to make the live pair disjoint and this is the OTHER half of the reason.
  eq(pathsCollide("loom-session-tracker/test", "loom-session-tracker/test/mutation.py"), false,
     "a directory does not collide with a file in it");
  eq(pathsCollide("test/", "test/handoff-model.test.js"), false, "the trailing slash changes nothing");
  ok(pathsCollide("test/*", "test/handoff-model.test.js"), "a GLOB is how a writer claims a directory");
});

suite("OV-001: THE LIVE PAIR — and the exemption must not be credited for the directory gap", () => {
  // Verbatim from the two real inboxes on this bus while OV-001 was being worked: developer1's
  // OV-001 and developer2's DU-001. They share the manifest, and they BOTH touch test/ — but DU-001
  // spells its claim `loom-session-tracker/test/`, which by the suite above claims no file at all.
  const repo = makeRepo({ alpha: {}, beta: {} }, "ov1-realpair");
  inbox(repo, "alpha", listHandoff("DU-001", ["loom-session-tracker/src/delegation.ts", "loom-session-tracker/src/health.ts",
                                              "loom-session-tracker/src/workledger.ts", "loom-session-tracker/test/",
                                              "loom-session-tracker/package.json"]));
  inbox(repo, "beta", listHandoff("OV-001", ["loom-session-tracker/src/models.ts", "loom-session-tracker/src/overlap.ts",
                                             "loom-session-tracker/test/handoff-model.test.js",
                                             "loom-session-tracker/test/overlap.test.js",
                                             "loom-session-tracker/test/mutation.py",
                                             "loom-session-tracker/package.json"]));
  working(repo, "alpha", "DU-001");
  eq(firstShared(handoffFiles(repo, "beta"), handoffFiles(repo, "alpha")), "loom-session-tracker/package.json",
     "without the exemption these refuse — on the manifest, which is not why they overlap");
  eq(overlapFor(repo, "beta"), null, "with it they are dispatched, as OV-001 §4 requires");
  // THE HONEST PART. `null` here is not proof they are disjoint. DU-001's `test/` claim is inert, so
  // the guard cannot see that both blocks edit that directory. Had DU-001 written `test/*`:
  const repo2 = makeRepo({ alpha: {}, beta: {} }, "ov1-realpair-glob");
  inbox(repo2, "alpha", listHandoff("DU-001b", ["loom-session-tracker/src/delegation.ts", "loom-session-tracker/test/*",
                                                "loom-session-tracker/package.json"]));
  inbox(repo2, "beta", listHandoff("OV-001b", ["loom-session-tracker/src/overlap.ts",
                                               "loom-session-tracker/test/handoff-model.test.js",
                                               "loom-session-tracker/package.json"]));
  working(repo2, "alpha", "DU-001b");
  const ov = overlapFor(repo2, "beta");
  ok(ov, "the SAME pair, spelled with a glob, is correctly refused even with the exemption on");
  eq(ov.file, "loom-session-tracker/test/handoff-model.test.js", "and named on the real shared file");
});

suite("OV-001: the exemption is invisible to the SIZE ledger — filesDeclared is not overlap's to shrink", () => {
  // models.ts records `handoffFiles(...).length` as §19's SIZE measurement, which is a different
  // question from "should this refuse". Applying the exemption inside declaredFiles/handoffFiles
  // would have silently under-counted every block that bumps a version. It lives in overlap.ts.
  const repo = makeRepo({ dev: {} }, "ov1-ledger");
  inbox(repo, "dev", listHandoff("O-60", ["package.json", "test/mutation.py", "src/models.ts"]));
  eq(handoffFiles(repo, "dev").length, 3, "all three paths are still DECLARED — the block really touches them");
  eq(declaredFiles(listHandoff("O-61", ["package.json"])), ["package.json"],
     "and the parser never drops an exempt path; only the refusal decision ignores it");
});

suite("OV-001: two other buses write a `files:` that is not a path list — found, not fixed", () => {
  // Both are LIVE on tfg_ua today and both are the expensive failure (§3): a refusal on a
  // non-path. Neither is caused by this change — the one-line parser has always read them this way —
  // and decision (a) forbids changing single-line behaviour, so they are pinned as-is and raised in
  // the outbox rather than quietly "fixed" under a block that was not asked for them.
  eq(declaredFiles("---\nid: T-1\nfiles: none\n---\n"), ["none"],
     "tfg_ua/developer2 writes `files: none` as a SENTINEL, and it parses as a path named `none`");
  ok(pathsCollide("none", "none"), "so two standby roles would be refused over a word");
  eq(declaredFiles("---\nid: T-2\nfiles: tools/cardmaker/** (NEW), docs/social/card-design.md (NEW)\n---\n"),
     ["tools/cardmaker/**", "(NEW)", "docs/social/card-design.md"],
     "tfg_ua/developer1 annotates paths, and the annotation becomes a declared path");
  eq(firstShared(["a.ts", "(NEW)"], ["b.ts", "(NEW)"]), "(NEW)",
     "two annotated handoffs on that bus refuse each other on a parenthetical");
});

suite("OV-001: an indented CONTINUATION under another key is not a list, and is not annexed", () => {
  // funisland/character/inbox.md carries a multi-line `grounding:` value as indented prose. A parser
  // that ate any indented line after a key would have turned that into declared paths. Only
  // `- item` lines are collected, and only directly under `files:`.
  eq(declaredFiles("---\nid: O-62\ngrounding:\n  some prose about the world\n  and a second line\n---\n"), [],
     "no `files:` key at all, whatever else is indented");
  eq(declaredFiles("---\nid: O-63\nfiles:\n  src/a.ts\n---\n"), [],
     "an indented line that is not an `- item` is not a list entry");
  eq(declaredFiles("---\nid: O-64\ngrounding:\n  prose\nfiles:\n  - src/a.ts\n---\n"), ["src/a.ts"],
     "and the list is still found when another key's continuation precedes it");
  // The block is searched, not the document. A `files:` list BELOW a closed frontmatter is prose —
  // ReciEats writes exactly that shape in a brief's body — and must never become a declaration.
  eq(declaredFiles("---\nid: O-65\nmodel: claude-opus-5\n---\n\n# brief\n\nfiles:\n  - src/a.ts\n"), [],
     "a list in the BODY of a handoff that HAS frontmatter is still not a declaration");
});
