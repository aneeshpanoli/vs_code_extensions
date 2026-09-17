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

const { declaredFiles, handoffFiles, normalizeDeclaredPath } = load("models.js");
const { pathsCollide, firstShared, sharedFile, isMechanicalMerge, exemptedShare,
        overlapFor, overlapReason, exemptionFor, exemptionReason } = load("overlap.js");

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

// The suite below asserts the manifest and the registry only; the third file (`HANDOVER.md`) and the
// one that was removed again (`README.md`) are the OV-001-R1/R2 suites further down. The name used to
// say "exactly two" while the list held four — a name broader than its body is how a green test stops
// anyone asking the question.
suite("OV-001: isMechanicalMerge exempts the manifest and the registry, from either root", () => {
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
  eq(isMechanicalMerge("*"), false, "a claim on everything is not a claim on three mergeable files");
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
  // THE OTHER CALL, MADE DELIBERATELY AND IN THE OPPOSITE DIRECTION (OV-001-R1). What is not a FILE
  // does come out of the count: a standby block declaring `files: none` touches nothing and must
  // ledger 0, and an annotated block ledgers its paths and not its annotations. The two rules are
  // consistent — "is this a file at all" belongs in the size measurement, "is this file's merge
  // mechanical" does not — and the difference is why one lives in models.ts and the other does not.
  const repo2 = makeRepo({ dev: {} }, "r1-ledger");
  inbox(repo2, "dev", "---\nid: O-66\nfiles: none\n---\n# standby\n");
  eq(handoffFiles(repo2, "dev").length, 0, "a standby block declares no files and ledgers none");
  inbox(repo2, "dev", "---\nid: O-67\nfiles: src/a.ts, (NEW), src/b.ts\n---\n# annotated\n");
  eq(handoffFiles(repo2, "dev").length, 2, "and an annotation is not a third file in the size ledger");
});

suite("OV-001-R1: the two LIVE tfg_ua declarations that were refusing on a non-path — now fixed", () => {
  // Both were live on tfg_ua when OV-001 found them, and both were the expensive failure (§3): a
  // REFUSAL on a word. OV-001 pinned them unfixed because decision (a) forbids changing what a valid
  // path list MEANS; R1 granted the fix because neither of these changes the reading of a path — they
  // narrow what counts as a path at all, which can only ever remove refusals. These are the same two
  // declarations, verbatim, asserted at their new behaviour.
  eq(declaredFiles("---\nid: T-1\nfiles: none\n---\n"), [],
     "`files: none` is a standby role saying it touches nothing, and now declares nothing");
  eq(pathsCollide("none", "none"), false, "so two standby roles are no longer refused over a word");
  eq(declaredFiles("---\nid: T-2\nfiles: tools/cardmaker/** (NEW), docs/social/card-design.md (NEW)\n---\n"),
     ["tools/cardmaker/**", "docs/social/card-design.md"],
     "and an annotated list declares its two paths and not its annotation");
  eq(firstShared(["a.ts", "(NEW)"], ["b.ts", "(NEW)"]), null,
     "so two annotated handoffs are no longer refused on a parenthetical");
  // The REAL paths in that declaration keep every bit of their meaning. Narrowing what is a path must
  // not narrow what a path does.
  ok(pathsCollide("tools/cardmaker/**", "tools/cardmaker/main.py"), "the glob still claims its tree");
  ok(pathsCollide("docs/social/card-design.md", "docs/social/card-design.md"), "and the doc still collides");
});

suite("OV-001-R1: the OTHER direction — a real path that merely CONTAINS one of these still refuses", () => {
  // The whole narrowing rests on the test being on the WHOLE token. If it were a substring or a
  // prefix test, this suite is the bus it would silently stop guarding.
  eq(declaredFiles("---\nid: T-3\nfiles: src/none-handler.ts\n---\n"), ["src/none-handler.ts"],
     "a file whose NAME contains `none` is a file");
  ok(pathsCollide("src/none-handler.ts", "src/none-handler.ts"), "and two roles editing it are refused");
  ok(pathsCollide("none-handler.ts", "src/none-handler.ts"), "at either root, as always");
  eq(declaredFiles("---\nid: T-4\nfiles: docs/(draft)-spec.md\n---\n"), ["docs/(draft)-spec.md"],
     "a path with a bracket INSIDE it is a path — only a wholly-bracketed WORD is an annotation");
  ok(pathsCollide("docs/(draft)-spec.md", "docs/(draft)-spec.md"), "and it refuses correctly");
  // THE CASE THIS SUITE'S NAME ALWAYS CLAIMED AND ITS BODY DID NOT PROVE, found by the refutation
  // pass. A REAL path someone bracketed is wholly bracketed, and `^\(.*\)$` deleted it — the one
  // narrowing that loses a guard in SILENCE: the declaration becomes an absence, so nothing refuses
  // and nothing is waived, so the exemption note does not fire either. The inner text must be a
  // plain word before a token is thrown away.
  eq(declaredFiles("---\nid: T-8\nfiles: src/a.ts, (src/shared.ts)\n---\n"), ["src/a.ts", "(src/shared.ts)"],
     "a bracketed real PATH is a path — it has a slash and a dot in it, and no annotation does");
  ok(pathsCollide("(src/shared.ts)", "(src/shared.ts)"), "so two roles bracketing the same file still refuse");
  eq(firstShared(["src/a.ts", "(src/shared.ts)"], ["src/b.ts", "(src/shared.ts)"]), "(src/shared.ts)",
     "and the pair the refutation pass built is refused, where it was silently dispatched before");
  eq(declaredFiles("---\nid: T-9\nfiles: (draft.md), (a)(b)\n---\n"), ["(draft.md)", "(a)(b)"],
     "a dot or a nested bracket is enough to keep a token — dropping is the direction that loses a guard");
  eq(declaredFiles("---\nid: T-9b\nfiles: (NEW), (rewrite), ()\n---\n"), [],
     "and a plain word in brackets is still an annotation");
  eq(declaredFiles("---\nid: T-5\nfiles: src/n/a.ts, nonetheless.md, (draft)-spec.md\n---\n"),
     ["src/n/a.ts", "nonetheless.md", "(draft)-spec.md"],
     "`n/a` as a directory, `none` as a prefix, and a bracket that does not close the token: all paths");
  // And the sentinel list is exactly three words, case-insensitively. Every word added to it is a
  // filename nobody can declare, so the list must not grow by accident.
  eq(declaredFiles("---\nid: T-6\nfiles: NONE, N/A, -\n---\n"), [], "all three, upper");
  eq(declaredFiles("---\nid: T-6b\nfiles: None, n/A\n---\n"), [], "and mixed — the name says any case, so prove any case");
  eq(declaredFiles("---\nid: T-6c\nfiles: ./none, none/\n---\n"), [],
     "normalisation runs FIRST, so `./none` and `none/` are the same sentinel — pinned because it is surprising");
  eq(declaredFiles("---\nid: T-7\nfiles: nil, null, tbd, todo\n---\n"), ["nil", "null", "tbd", "todo"],
     "and NOT the words nobody writes — a sentinel we invented would be a path we stole");
});

suite("OV-001-R2: a SPACED annotation is dropped — the limit R1 pinned, now fixed", () => {
  // R1 could only pin this: the splitting loop runs before the normaliser, so `(new file)` arrived as
  // `(new` and `file)`, and two handoffs annotating that way REFUSED EACH OTHER on `(new` — the
  // expensive direction. R2 authorised changing the loop; the fix is a pre-pass that strips
  // whole-token annotation runs using the same inner predicate the space-free case uses.
  eq(declaredFiles("---\nid: T-20\nfiles: src/a.ts (new file)\n---\n"), ["src/a.ts"],
     "the annotation is gone and the path is all that is declared");
  eq(declaredFiles("---\nid: T-21\nfiles: src/a.ts (new file), src/b.ts (rewrite in place)\n---\n"),
     ["src/a.ts", "src/b.ts"], "two annotated paths in one line, each annotation several words long");
  eq(firstShared(declaredFiles("---\nid: T-22\nfiles: a.ts (new file)\n---\n"),
                 declaredFiles("---\nid: T-23\nfiles: b.ts (new file)\n---\n")), null,
     "so two handoffs annotating that way are no longer refused on a fragment");
  eq(declaredFiles("---\nid: T-24\nfiles:\n  - src/a.ts (new file)\n  - src/b.ts\n---\n"),
     ["src/a.ts", "src/b.ts"], "and the list form goes through the same one loop, so it is fixed too");
  // The §19 size ledger moves with it, which is R1's call applied consistently: a file is a file, an
  // annotation never was one.
  eq(declaredFiles("---\nid: T-25\nfiles: src/a.ts (new file)\n---\n").length, 1,
     "an annotated path ledgers ONE file, not three");
});

suite("OV-001-R2: the shapes the pre-pass must NOT fire on — each keeps R1's behaviour bit for bit", () => {
  // THIS SUITE'S NAME USED TO CLAIM THE UNIVERSAL PROPERTY ("can only REMOVE tokens — a real path is
  // never re-spelled") and its body was a list of non-firing cases, every one of which passes against
  // a build with the pre-pass REVERTED. The refutation pass demonstrated exactly that and it was
  // right: a name broader than its body is how a green test stops anyone asking the question. The
  // universal claim is proved by the differential suite below; this one pins the shapes.
  eq(declaredFiles("---\nid: T-26\nfiles: src/a (b).ts\n---\n"), ["src/a", "(b).ts"],
     "a REAL path with a space-separated bracketed fragment is not swallowed beyond the annotation — "
     + "`(b)` is followed by `.`, so nothing is stripped and both fragments still refuse");
  eq(firstShared(declaredFiles("---\nid: T-26b\nfiles: src/a (b).ts\n---\n"),
                 declaredFiles("---\nid: T-26c\nfiles: src/a (b).ts\n---\n")), "src/a",
     "and two roles declaring it ARE refused — which is the guard surviving, not just a string kept");
  eq(declaredFiles("---\nid: T-27\nfiles: src/a.ts(NEW)\n---\n"), ["src/a.ts(NEW)"],
     "a bracket that does not OPEN a token is untouched — still one path, still refusing");
  eq(declaredFiles("---\nid: T-28\nfiles: src/a.ts, (src/shared.ts)\n---\n"), ["src/a.ts", "(src/shared.ts)"],
     "a bracketed real PATH is still a path: the pre-pass uses the same no-slash-no-dot predicate");
  eq(declaredFiles("---\nid: T-29\nfiles: (a)(b), (draft.md)\n---\n"), ["(a)(b)", "(draft.md)"],
     "a nested bracket and an inner dot still keep their tokens, spaced or not");
  // THE SHAPE LEFT REFUSING, named rather than papered over (the handoff's §3). An annotation with a
  // `/` or a `.` in it cannot be told from a bracketed real path once the line is split, and dropping
  // a bracketed real path is the one narrowing that loses a guard in SILENCE. So this REFUSES, on
  // purpose, and the writer's remedy is a comma or an annotation without a dot.
  eq(declaredFiles("---\nid: T-30\nfiles: src/a.ts (see docs/spec.md)\n---\n"),
     ["src/a.ts", "(see", "docs/spec.md)"],
     "an annotation containing a slash or a dot is LEFT REFUSING — the expensive direction, chosen");
  eq(declaredFiles("---\nid: T-31\nfiles: src/a.ts (rewrite v2.0)\n---\n"), ["src/a.ts", "(rewrite", "v2.0)"],
     "including a version number in the annotation, for the same reason");
  // AND THE REST OF THE LIST, which the first draft of this block did not enumerate: the refutation
  // pass found four more shapes still refusing while the comment named only one. Each is here so the
  // comment cannot drift from the code again.
  eq(declaredFiles("---\nid: T-32\nfiles: src/a.ts ((new))\n---\n"), ["src/a.ts", "((new))"],
     "a NESTED bracket run is not an annotation");
  eq(declaredFiles("---\nid: T-33\nfiles: src/a.ts (new (file))\n---\n"), ["src/a.ts", "(new", "(file))"],
     "nor a run with a bracket inside it");
  eq(declaredFiles("---\nid: T-34\nfiles: src/a.ts (new\n---\n"), ["src/a.ts", "(new"],
     "nor an UNBALANCED one — there is no closing bracket to bound the run");
  eq(declaredFiles("---\nid: T-35\nfiles: src/a.ts [NEW], src/b.ts {NEW}\n---\n"),
     ["src/a.ts", "[NEW]", "src/b.ts", "{NEW}"],
     "and square or curly brackets are STILL not annotations — R1 left them out as unattested, and "
     + "every spelling admitted here is a filename someone can no longer declare");
});

suite("OV-001-R2: a bracket run cannot cross a LIST ITEM — the swallowed `Makefile`, found by refutation", () => {
  // THE DEFECT THE REFUTATION PASS FOUND IN THE FIRST DRAFT, and the dangerous kind: `listUnderKey`
  // joined its items with a SPACE, so one item's `(` could reach another item's `)` and every item in
  // between vanished. A dot-free REAL filename is exactly annotation-shaped, so this was not a corner
  // case — `Makefile`, `LICENSE` and `Dockerfile` are all dot-free — and the result was an ABSENCE:
  // nothing refused, and no waiver note either, because nothing was exempted. Fixed two ways at once:
  // the join is a comma, and a comma cannot appear inside a run.
  eq(declaredFiles("---\nid: T-40\nfiles:\n  - (new\n  - Makefile\n  - file)\n---\n"),
     ["(new", "Makefile", "file)"],
     "the real `Makefile` item SURVIVES a bracket run opened and closed by its neighbours");
  ok(pathsCollide("Makefile", "Makefile"), "so two roles declaring it are still refused");
  eq(declaredFiles("---\nid: T-41\nfiles:\n  - src/a.ts (rewrite\n  - Makefile\n  - LICENSE)\n---\n"),
     ["src/a.ts", "(rewrite", "Makefile", "LICENSE)"],
     "and a run opened mid-item cannot eat the two items after it");
  eq(declaredFiles("---\nid: T-42\nfiles: src/a.ts (new, big)\n---\n"), ["src/a.ts", "(new", "big)"],
     "a comma inside the brackets leaves the run alone — the expensive direction, and the price of "
     + "confining a run to one item");
  // The item-by-item case still works, which is the whole point of the fix being the JOIN and not a
  // narrower bracket rule: an annotation inside ONE item is still an annotation.
  eq(declaredFiles("---\nid: T-43\nfiles:\n  - src/a.ts (new file)\n  - src/b.ts (rewrite in place)\n---\n"),
     ["src/a.ts", "src/b.ts"], "while an annotation WITHIN an item is still dropped, both of them");
});

suite("OV-001-R2: a `*` is never deleted by the pre-pass — overlap.ts's wildcard promise holds HERE too", () => {
  // `overlap.ts` states that a wildcard is never exempted away. The first draft broke that promise one
  // level UP, where nothing downstream can recover it: a `*` erased before the guard sees it is a claim
  // on every file that simply is not there any more. Found by the refutation pass.
  eq(declaredFiles("---\nid: T-50\nfiles:\n  - (new\n  - *\n  - file)\n---\n"), ["(new", "*", "file)"],
     "the `*` item survives a bracket run around it");
  eq(declaredFiles("---\nid: T-51\nfiles: (rewrite everything *)\n---\n"), ["(rewrite", "everything", "*)"],
     "and a `*` inside a run keeps the whole run — a claim on everything is never quietly dropped");
  eq(sharedFile(declaredFiles("---\nid: T-52\nfiles:\n  - (new\n  - *\n  - file)\n---\n"), ["src/models.ts"]),
     "*", "so a block claiming everything still collides with a real source file");
});

suite("OV-001-R2: the pre-pass can only REMOVE tokens — proved differentially, not by example", () => {
  // The universal claim, tested as a universal claim: for every generated declaration, the new
  // `declaredFiles` must return a SUBSET of what the pre-R2 algorithm returned. A refutation pass
  // fuzzed 300,000 inputs and found no counter-example; this is the deterministic residue of that,
  // small enough to run on every suite and wide enough to fail if the regex is widened. It is what the
  // suite above used to claim in its name and did not test.
  const ATOMS = ["src/a.ts", "Makefile", "*", "test/*", "(NEW)", "(new", "file)", "(a)(b)", "((new))",
                 "(src/shared.ts)", "(new, big)", "v2.0)", "[NEW]", "{NEW}", "none", "-", "./a", "()"];
  // The pre-R2 algorithm, verbatim: split first, normalise second, nothing in between.
  const before = (raw) => {
    const out = [];
    for (const piece of raw.split(/[,\s]+/)) {
      const p = normalizeDeclaredPath(piece);
      if (p && !out.includes(p)) out.push(p);
    }
    return out;
  };
  let checked = 0, shrank = 0;
  for (const j of [" ", ",", ", "]) {
    for (const a of ATOMS) for (const b of ATOMS) for (const c of ATOMS) {
      const raw = [a, b, c].join(j);
      const now = declaredFiles(`---\nid: F\nfiles: ${raw}\n---\n`);
      const was = before(raw);
      checked++;
      if (now.length < was.length) shrank++;
      const extra = now.filter((p) => !was.includes(p));
      if (extra.length) throw new Error(`NEW TOKEN from ${JSON.stringify(raw)}: ${JSON.stringify(extra)}`);
    }
  }
  eq(checked, 3 * ATOMS.length ** 3, "every triple over every join was actually compared");
  ok(shrank > 0, `and the pre-pass really does fire — ${shrank} of ${checked} declarations shrank`);
  ok(checked > 15000, "a differential claim on a handful of cases would not be one");
});

suite("OV-001-R1: a declaration that is ONLY sentinels is an ABSENCE, and absence never refuses", () => {
  // The failure mode this was found in: two tfg_ua standby roles, both declaring `none`, refusing
  // each other. `files: none` must land in the same place as no `files:` line at all — §3's law.
  const repo = makeRepo({ alpha: {}, beta: {} }, "r1-sentinel");
  inbox(repo, "alpha", "---\nid: T-10\nfiles: none\n---\n# standby\n");
  inbox(repo, "beta", "---\nid: T-11\nfiles: none\n---\n# standby too\n");
  working(repo, "alpha", "T-10");
  eq(handoffFiles(repo, "alpha"), [], "a sentinel declaration holds no files");
  eq(overlapFor(repo, "beta"), null, "so two standby roles are dispatched, not refused over a word");
  eq(exemptionFor(repo, "beta"), null, "and nothing was WAIVED either — there was no collision to waive");
});

// ── the list of three (OV-001-R1 §2, narrowed by OV-001-R2 §1) ──────────────────────────────────

suite("OV-001-R1: the exemption names THREE files — the handover churns by appending, like the registry", () => {
  ok(isMechanicalMerge("HANDOVER.md"), "the handover, which grows a dated section at its end");
  ok(isMechanicalMerge("loom-session-tracker/HANDOVER.md"), "from the repo root as well");
  ok(isMechanicalMerge("./HANDOVER.md"), "normalised before it is judged, like the manifest");
  ok(isMechanicalMerge("package.json") && isMechanicalMerge("test/mutation.py"), "and the first two are untouched");
  // Literal and segment-anchored, exactly as the first two are. A glob over a doc is a claim on more
  // than the doc and keeps its whole claim.
  eq(isMechanicalMerge("HANDOVER.md.bak"), false, "a longer name is a different file");
  eq(isMechanicalMerge("xHANDOVER.md"), false, "anchored on a segment, not on characters");
  eq(isMechanicalMerge("*.md"), false, "a glob over the docs is not the docs");
  eq(isMechanicalMerge("docs/*"), false, "nor is a directory glob that contains one");
  eq(sharedFile(["*.md"], ["docs/spec.md"]), "*.md", "so a glob over the docs still collides with a real doc");
  // ...but NOT with an exempt one, because the exemption shrinks the OTHER side too — the same shape
  // the registry already had (`test/*` against `test/mutation.py`), now with a doc able to make a glob
  // block go quiet. That is the honest cost of having a third file on the list at all.
  eq(sharedFile(["*.md"], ["HANDOVER.md"]), null, "a glob against a handover-only block is not a refusal");
  eq(exemptedShare(["*.md"], ["HANDOVER.md"]), "HANDOVER.md", "and the guard SAYS so — that is §1(3)'s whole point");
  // The handover stops the list. The next candidate is a judgement about a bus's habits, not about a
  // kind of change, and it belongs to a per-bus list that does not exist yet.
  eq(isMechanicalMerge("CHANGELOG.md"), false, "and the list stops at three — the next one is a per-bus judgement");
  eq(isMechanicalMerge("tsconfig.json"), false, "a second manifest is not the manifest");
});

suite("OV-001-R2: `README.md` is NOT exempt — the reversal, asserted on the hackomics declaration", () => {
  // R1 added `README.md` on the append-shaped argument and recorded the counter-example that made it
  // wrong; R2 took the instruction back. THE COUNTER-EXAMPLE IS THE TEST: this is the hackomics
  // declaration verbatim, and the file in it is that bus's product, not a feature list.
  eq(isMechanicalMerge("README.md"), false, "the README is the PRODUCT on another bus this one build also serves");
  eq(isMechanicalMerge("loom-session-tracker/README.md"), false, "at the repo root too");
  eq(isMechanicalMerge("./README.md"), false, "and normalisation does not sneak it back in");
  const hack = ["public/index.html", "public/styles.css", "README.md"];
  eq(sharedFile(hack, ["public/hero.html", "README.md"]), "README.md",
     "two hackomics roles rewriting that README in parallel are REFUSED again, which is the point");
  eq(exemptedShare(hack, ["public/hero.html", "README.md"]), null,
     "and there is no waiver note, because nothing was waived — the refusal is the report");
  // The reversal is exactly one file wide. Everything R1 built around it still stands.
  ok(isMechanicalMerge("HANDOVER.md"), "the handover stays — no bus declares it as product");
  eq(sharedFile(["src/a.ts", "README.md", "package.json"], ["src/b.ts", "README.md", "package.json"]), "README.md",
     "a block sharing only a README and a version bump refuses on the README, not on the manifest");
  eq(sharedFile(["src/a.ts", "HANDOVER.md", "package.json"], ["src/b.ts", "HANDOVER.md", "package.json"]), null,
     "and the same block with a handover instead is still dispatched");
});

suite("OV-001-R1: two blocks that share only a HANDOVER append are dispatched", () => {
  const repo = makeRepo({ alpha: {}, beta: {} }, "r1-docs");
  // The README came OUT of these two fixtures with the R2 reversal, and that is the whole cost of the
  // reversal in one place: a pair declaring it is now refused, so a pair that must be DISPATCHED
  // cannot declare it.
  inbox(repo, "alpha", listHandoff("D-1", ["loom-session-tracker/src/health.ts", "loom-session-tracker/HANDOVER.md",
                                           "loom-session-tracker/package.json"]));
  inbox(repo, "beta", listHandoff("D-2", ["loom-session-tracker/src/overlap.ts", "loom-session-tracker/HANDOVER.md",
                                          "loom-session-tracker/package.json"]));
  working(repo, "alpha", "D-1");
  eq(firstShared(handoffFiles(repo, "beta"), handoffFiles(repo, "alpha")), "loom-session-tracker/HANDOVER.md",
     "without the exemption these refuse on a doc append");
  eq(overlapFor(repo, "beta"), null, "with it they are dispatched");
  // And the docs did not make the guard blind: a real shared source file still refuses, and is named.
  inbox(repo, "beta", listHandoff("D-3", ["loom-session-tracker/src/health.ts", "loom-session-tracker/HANDOVER.md"]));
  const ov = overlapFor(repo, "beta");
  eq(ov && ov.file, "loom-session-tracker/src/health.ts", "the real file is what refuses, not the doc it hid behind");
});

// ── the silence, closed (OV-001-R1 §1(3)) ───────────────────────────────────────────────────────

suite("OV-001-R1: exemptedShare names the file the guard let through — and nothing else", () => {
  // The defect: a refusal printed `overlaps X on Y`, a non-refusal CAUSED by the exemption printed
  // nothing. This is the value that was being computed and never rendered.
  eq(exemptedShare(["package.json"], ["package.json"]), "package.json", "the manifest it waved through");
  eq(exemptedShare(["src/a.ts", "HANDOVER.md"], ["src/b.ts", "HANDOVER.md"]), "HANDOVER.md", "or the doc");
  eq(exemptedShare(["loom-session-tracker/package.json"], ["package.json"]), "loom-session-tracker/package.json",
     "reported at the ROOT the exempt side declared, so it points at a real file and not a bare name");
  eq(exemptedShare(["./package.json"], ["package.json"]), "package.json",
     "normalised, though — the note is the guard's spelling, not a verbatim quote of the declaration");
  // A pair that refuses on its own merits suppressed NOTHING, so there is nothing to say: the refusal
  // is the report. Saying both would be two answers to one question.
  eq(exemptedShare(["src/a.ts", "package.json"], ["src/a.ts", "package.json"]), null,
     "a pair that refuses anyway has had nothing waived");
  eq(exemptedShare(["src/a.ts"], ["src/b.ts"]), null, "and genuinely disjoint work involved no judgement at all");
  eq(exemptedShare([], ["package.json"]), null, "an empty declaration is not a judgement either");
  // THE WILDCARD CASE, which is the one worth having the function for: `*` is not exempt, so the
  // suppression comes from the OTHER side, and the file that is now unguarded is the other side's.
  eq(exemptedShare(["*"], ["package.json"]), "package.json",
     "a `files: *` block runs beside a version bump, and the manifest is the file nobody is guarding");
  eq(exemptedShare(["test/*"], ["test/mutation.py"]), "test/mutation.py", "and the same for the registry");
});

suite("OV-001-R1: exemptionFor is overlapFor's other half, and a REFUSAL always wins", () => {
  const repo = makeRepo({ alpha: {}, beta: {} }, "r1-voice");
  inbox(repo, "alpha", listHandoff("V-1", ["loom-session-tracker/src/delegation.ts", "loom-session-tracker/package.json"]));
  inbox(repo, "beta", listHandoff("V-2", ["loom-session-tracker/src/overlap.ts", "loom-session-tracker/package.json"]));
  working(repo, "alpha", "V-1");
  eq(overlapFor(repo, "beta"), null, "the pair is dispatched...");
  const ex = exemptionFor(repo, "beta");
  ok(ex, "...and the guard now SAYS it made that call");
  eq(ex.other, "alpha");
  eq(ex.file, "loom-session-tracker/package.json", "naming the file it let through");
  eq(exemptionReason(ex), "shares loom-session-tracker/package.json with alpha, allowed as a mechanical merge",
     "one clause, verbatim, sitting beside `overlaps X on Y`");
  // A refusal wins: the dispatch is not happening, so a note about a waived file is noise on top of
  // a blocked spawn — and two reports disagreeing about one pair would be worse than one silence.
  inbox(repo, "beta", listHandoff("V-3", ["loom-session-tracker/src/delegation.ts", "loom-session-tracker/package.json"]));
  ok(overlapFor(repo, "beta"), "the same pair, now sharing a source file, is refused");
  eq(exemptionFor(repo, "beta"), null, "and reports no exemption — the refusal is the whole report");
  // Absence and doubt say nothing here either, for the same reason they refuse nothing.
  const repo2 = makeRepo({ alpha: {}, beta: {} }, "r1-voice2");
  inbox(repo2, "alpha", listHandoff("V-4", ["package.json"]));
  inbox(repo2, "beta", "---\nid: V-5\n---\n# no files line\n");
  working(repo2, "alpha", "V-4");
  eq(exemptionFor(repo2, "beta"), null, "a role that declared nothing had nothing waived on its behalf");
  eq(exemptionFor(repo2, "nobody"), null, "and an unknown role is not a judgement");
  eq(exemptionFor(null, "beta"), null, "nor is an absent repo");
});

suite("OV-001-R1: a role opened in the SAME breath is reported too — the §19 case that matters most", () => {
  // The exemption's whole purpose is to let one `open-requests.json` spawn two colliding-on-a-version
  // briefs. That is exactly the dispatch whose judgement was invisible.
  const repo = makeRepo({ alpha: {}, beta: {} }, "r1-also");
  inbox(repo, "alpha", listHandoff("A-1", ["src/a.ts", "test/mutation.py"]));
  inbox(repo, "beta", listHandoff("A-2", ["src/b.ts", "test/mutation.py"]));
  eq(exemptionFor(repo, "beta"), null, "nobody is working, so nothing has been judged yet");
  const ex = exemptionFor(repo, "beta", ["alpha"]);
  eq(ex && ex.file, "test/mutation.py", "and opening both in one breath reports what was waived");
  // A role never waives anything against ITSELF. Spelled with a declaration that is ENTIRELY exempt,
  // because the obvious fixture proves nothing: with a real file in it, `sharedFile(mine, mine)` is a
  // refusal and the refusal-wins branch returns null before the self-check is ever consulted — so the
  // test would pass with `others.delete(role)` deleted. The refutation pass caught that.
  eq(exemptionFor(repo, "beta", ["beta"]), null, "with a real file, it is the refusal branch that answers");
  const repo2 = makeRepo({ solo: {} }, "r1-also-self");
  inbox(repo2, "solo", listHandoff("A-3", ["package.json", "HANDOVER.md"]));
  eq(exemptionFor(repo2, "solo", ["solo"]), null,
     "and with an entirely exempt one, where only `others.delete(role)` can answer, it is still silent");
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
