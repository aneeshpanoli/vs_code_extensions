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
import importlib.util, json, os, sys, tempfile, pathlib

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

print()
if FAILS:
    print(f"\033[31m{len(FAILS)} failed\033[0m"); sys.exit(1)
print("\033[32mall passed\033[0m")
