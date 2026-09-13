#!/usr/bin/env python3
"""test_coverage.py — tests for tools/coverage.py's merge across parallel V8 dumps.

WHY THIS EXISTS (CH-002, 2026-09-13). run-tests.js forks one process per test file, and each
writes its own V8 dump. coverage.py used to UNION every process's zero-count ranges, so a line was
reported uncovered if ANY process missed it — and since a process only ever exercises the modules
its own test file touches, the measured coverage fell as LOOM_TEST_JOBS rose. Every number ever
quoted from it was partly a statement about how many cores ran the suite. The bug was flagged in
GC-005, MP-001 and RB-001 and survived all three, because nothing tested the merge.

    python3 tools/test_coverage.py
"""
import importlib.util, json, os, sys, tempfile, pathlib, urllib.parse

SRC = os.path.join(os.path.dirname(os.path.abspath(__file__)), "coverage.py")
spec = importlib.util.spec_from_file_location("coverage_t", SRC)
cov = importlib.util.module_from_spec(spec)
spec.loader.exec_module(cov)

FAILS = []
def check(name, got, want):
    if got == want: print(f"  \033[32m✓\033[0m {name}")
    else:
        print(f"  \033[31m✗\033[0m {name}\n      got:  {got!r}\n      want: {want!r}"); FAILS.append(name)


# ── merge_dead: the intersection itself ─────────────────────────────────────────────────────────
# Ten bytes. Process A ran the first half, process B the second — between them the file is fully
# covered, and neither one alone knows that.
A = [(5, 10)]
B = [(0, 5)]
check("one process's dead range stands alone",
      list(cov.merge_dead([A], 10)), [0, 0, 0, 0, 0, 1, 1, 1, 1, 1])
check("two processes that between them cover everything leave nothing dead",
      list(cov.merge_dead([A, B], 10)), [0] * 10)
check("a byte no process covered stays dead",
      list(cov.merge_dead([[(0, 4)], [(2, 6)]], 8)), [0, 0, 1, 1, 0, 0, 0, 0])
check("a process that ran NOTHING cannot erase another's coverage",
      list(cov.merge_dead([[(0, 6)], [(0, 6)]], 6)), [1] * 6)
check("a fully-covering process wins over one that covered nothing",
      list(cov.merge_dead([[(0, 6)], []], 6)), [0] * 6)
check("no observations at all is not 'covered'... but the caller never sees such a file",
      list(cov.merge_dead([], 4)), [0, 0, 0, 0])
check("ranges are clamped to the source, not indexed past it",
      list(cov.merge_dead([[(-3, 99)]], 4)), [1, 1, 1, 1])

# ── end to end, over two fixture PROCESSES ──────────────────────────────────────────────────────
# Exactly the shape run-tests.js produces: two dumps in one directory, each covering the half of
# the module its own test file exercised. The union answer is 2/4 lines; the truth is 4/4.
SRC_JS = "const a = 1;\nconst b = 2;\nconst c = 3;\nconst d = 4;\n"
#          0..11        12..24        25..37        38..50

def dump(path, src_path, dead_ranges):
    json.dump({"result": [{"url": "file://" + src_path, "functions": [
        {"functionName": "", "isBlockCoverage": True,
         "ranges": [{"startOffset": 0, "endOffset": len(SRC_JS), "count": 1}]
                   + [{"startOffset": a, "endOffset": b, "count": 0} for a, b in dead_ranges]}]}]},
        open(path, "w"))

with tempfile.TemporaryDirectory() as tmp:
    out = pathlib.Path(tmp, "out"); out.mkdir()
    covdir = pathlib.Path(tmp, "cov"); covdir.mkdir()
    mod = out / "thing.js"; mod.write_text(SRC_JS)
    # process 1 ran the first two lines, process 2 the last two
    dump(covdir / "cov-1.json", str(mod), [(25, len(SRC_JS))])
    dump(covdir / "cov-2.json", str(mod), [(0, 25)])

    obs = cov.read_dumps(str(covdir), str(out))
    check("both processes' dumps are read as SEPARATE observations", len(obs[str(mod)]), 2)
    rows = cov.line_rows(obs)
    check("one row per module", [r[0] for r in rows], ["thing.js"])
    check("every line is covered by SOME process, so every line is covered", rows[0][1:3], (4, 4))
    check("…and nothing is reported missing", rows[0][3], [])

    # the same two dumps under the old union rule would have called half the file dead — pin that
    # the difference is real and not an artefact of the fixture
    union = [(a, b) for o in obs[str(mod)] for (a, b) in o]
    check("the union of the same two dumps would have marked the whole file dead",
          list(cov.merge_dead([union], len(SRC_JS))), [1] * len(SRC_JS))

    # a third process that never loaded the module contributes no entry at all
    json.dump({"result": [{"url": "file:///elsewhere/other.js", "functions": []}]},
              open(covdir / "cov-3.json", "w"))
    check("a process that never loaded the module adds no observation for it",
          len(cov.read_dumps(str(covdir), str(out))[str(mod)]), 2)

    # an entry with NO functions is no evidence either way, and must not vote 'all covered'
    json.dump({"result": [{"url": "file://" + str(mod), "functions": []}]},
              open(covdir / "cov-4.json", "w"))
    obs2 = cov.read_dumps(str(covdir), str(out))
    check("an empty-functions entry is not counted as an observation", len(obs2[str(mod)]), 2)
    check("…so it cannot silently turn a half-covered file into a covered one",
          cov.line_rows(obs2)[0][1:3], (4, 4))

# ── V8 offsets are UTF-16 code units, Python indexes codepoints ─────────────────────────────────
# Found by an adversarial pass over the real dumps and reproduced here: coordinator.js:173, a
# `throw` sitting inside a zero-count range in EVERY observation, was scored COVERED because two
# 🔒 earlier in the file slid every offset two characters right. A tool that reports a line covered
# when nothing ran it is worse than one that reports nothing.
EMOJI_SRC = 'const lock = "🔒🔒";\nthrow new Error("x");\n'
check("a pure-BMP file needs no mapping at all", cov.u16_starts("plain ascii"), None)
check("each astral character costs two UTF-16 units",
      cov.u16_starts("a🔒b")[:4], [0, 1, 3, 4])
check("a UTF-16 offset past the emoji maps back to its codepoint",
      cov.to_cp(22, cov.u16_starts(EMOJI_SRC)), 20)
check("offsets in a BMP file pass through untouched", cov.to_cp(7, None), 7)

with tempfile.TemporaryDirectory() as tmp:
    out = pathlib.Path(tmp, "out"); out.mkdir()
    covdir = pathlib.Path(tmp, "cov"); covdir.mkdir()
    mod = out / "emoji.js"; mod.write_text(EMOJI_SRC, encoding="utf8")
    u16 = len(EMOJI_SRC.encode("utf-16-le")) // 2
    # line 2 is dead, expressed the way V8 expresses it: in UTF-16 units
    dead_start = len('const lock = "🔒🔒";\n'.encode("utf-16-le")) // 2
    json.dump({"result": [{"url": "file://" + str(mod), "functions": [
        {"ranges": [{"startOffset": 0, "endOffset": u16, "count": 1},
                    {"startOffset": dead_start, "endOffset": u16, "count": 0}]}]}]},
        open(covdir / "cov-1.json", "w"))
    rows = cov.line_rows(cov.read_dumps(str(covdir), str(out)))
    check("the line after the emoji is scored DEAD, not shifted into looking alive",
          rows[0][3], [2])
    check("…and the emoji line itself is covered", rows[0][1:3], (1, 2))

    # a dump measured against a DIFFERENT build must fail loudly, not clamp
    json.dump({"result": [{"url": "file://" + str(mod), "functions": [
        {"ranges": [{"startOffset": 0, "endOffset": u16 + 500, "count": 0}]}]}]},
        open(covdir / "cov-1.json", "w"))
    try:
        cov.line_rows(cov.read_dumps(str(covdir), str(out)))
        check("a dump that overruns the source is refused", "no error", "SystemExit")
    except SystemExit as e:
        check("a dump that overruns the source is refused, naming the rebuild",
              "out/ was rebuilt after the run" in str(e), True)

# ── percent-encoded paths ───────────────────────────────────────────────────────────────────────
with tempfile.TemporaryDirectory() as tmp:
    out = pathlib.Path(tmp, "has space", "out"); out.mkdir(parents=True)
    covdir = pathlib.Path(tmp, "cov"); covdir.mkdir()
    mod = out / "thing.js"; mod.write_text(SRC_JS)
    json.dump({"result": [{"url": "file://" + urllib.parse.quote(str(mod)), "functions": [
        {"ranges": [{"startOffset": 0, "endOffset": len(SRC_JS), "count": 1}]}]}]},
        open(covdir / "cov-1.json", "w"))
    check("a module under a path with a space is still counted, not silently dropped",
          [r[0] for r in cov.line_rows(cov.read_dumps(str(covdir), str(out)))], ["thing.js"])

print()
if FAILS:
    print(f"\033[31m{len(FAILS)} failed\033[0m"); sys.exit(1)
print("\033[32mall passed\033[0m")
