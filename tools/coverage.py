#!/usr/bin/env python3
"""Summarise V8 coverage as LINE coverage over a compiled out/ directory.

  cd loom-session-tracker
  rm -rf /tmp/cov && NODE_V8_COVERAGE=/tmp/cov ./test.sh
  python3 ../tools/coverage.py /tmp/cov out

A line counts as covered unless every non-whitespace byte on it sits inside a zero-count V8 range.
Bare delimiters are not counted, and tsc's __importStar/__createBinding prologue is excluded from
the denominator — it is compiler output, not code anyone wrote or can test.

THE RUN IS PARALLEL, SO THE DUMPS MUST BE INTERSECTED, NOT UNIONED (CH-002, 2026-09-13).
run-tests.js forks one process PER TEST FILE (up to LOOM_TEST_JOBS), and each writes its own V8
dump. Any one process exercises only the modules its own file touches, so its dump marks almost
everything else dead. This script used to pour every process's zero-count ranges into one list per
file — a UNION of the dead — which means a line was called uncovered if ANY process missed it.
The arithmetic of that is that coverage FALLS as you add cores: measured on this tree 2026-09-13,
the same 623-test run read 73.4% at LOOM_TEST_JOBS=1 and 38.4% at the default 32, so the figure
quoted in any doc was really a statement about how many cores the machine had. It was flagged in
GC-005, MP-001 and RB-001 before it was fixed here. A line is uncovered only if NO process covered
it — so the masks INTERSECT. Intersected, the same two dump sets read 93.3% and 93.1%, and
LOOM_TEST_JOBS=4 and =32 agree to the line (5641/6060).

The 12 lines still between them are NOT a merge artefact — they are a different execution. Each
parallel child gets its own throwaway HOME; the single-process path gives all 39 test files ONE.
Sharing it lets state from one file leak into another and reach gc.js's `busFrameMismatch` branch,
which needs two buses declaring one webviewId — a collision no isolated process can produce and,
tellingly, no test sets up on purpose. The parallel number is the honest one.
"""
import json, os, sys, glob, collections


def merge_dead(observations, length):
    """The dead-byte mask for one source file, given one zero-count range list PER OBSERVATION.

    An observation is a single script entry in a single process's dump. Bytes are dead only where
    EVERY observation agrees they are dead: a process that never ran a module reports all of it
    dead, and that is not evidence of anything except which test file that process was given.

    No observations at all means no evidence, which is not the same as covered — the caller only
    reaches here for files some dump mentioned, and a file nothing mentions stays out of `seen`.
    """
    dead = None
    for ranges in observations:
        mask = bytearray(length)
        for a, b in ranges:
            for i in range(max(0, a), min(length, b)):
                mask[i] = 1
        dead = mask if dead is None else bytearray(x & y for x, y in zip(dead, mask))
    return dead if dead is not None else bytearray(length)


def read_dumps(covdir, outdir):
    """{source path: [zero-count ranges per observation]} for the modules compiled into `outdir`."""
    observations = collections.defaultdict(list)
    for f in sorted(glob.glob(os.path.join(covdir, "*.json"))):
        try:
            d = json.load(open(f))
        except Exception:
            continue
        for s in d.get("result", []):
            url = s.get("url", "")
            if not url.startswith("file://"):
                continue
            p = url[7:]
            if os.path.realpath(os.path.dirname(p)) != os.path.realpath(outdir):
                continue
            fns = s.get("functions", [])
            if not fns:
                # A dump entry with no functions reports nothing either way. Counted as an
                # observation it would be an all-covered vote, which would erase every other
                # process's evidence for that file.
                continue
            observations[p].append([(r["startOffset"], r["endOffset"])
                                    for fn in fns for r in fn.get("ranges", [])
                                    if r.get("count", 0) == 0])
    return observations


def line_rows(observations):
    """(basename, covered, total, missing-line-numbers) per file."""
    rows = []
    for p in sorted(observations):
        src = open(p, encoding="utf8", errors="replace").read()
        dead = merge_dead(observations[p], len(src))
        # a line counts as covered unless ALL its non-blank content is inside a zero-count range
        # tsc emits an __importStar/__createBinding prologue in every module; it is compiler output,
        # not code anyone wrote or can test, so it is excluded from the denominator.
        lines_all = src.split("\n")
        prologue_end = 0
        for i, l in enumerate(lines_all):
            if '__esModule' in l and 'defineProperty(exports' in l:
                prologue_end = i + 1
                break
        line_start = 0; covered = 0; total = 0; missing = []
        for ln, line in enumerate(lines_all, 1):
            end = line_start + len(line)
            stripped = line.strip()
            if ln <= prologue_end:
                line_start = end + 1; continue
            if stripped and stripped not in ("}", "{", "});", "};", "]", ")", "],"):
                total += 1
                body = [dead[i] for i in range(line_start, end) if not src[i].isspace()]
                if body and all(body): missing.append(ln)
                else: covered += 1
            line_start = end + 1
        rows.append((os.path.basename(p), covered, total, missing))
    return rows


def main(covdir, outdir):
    rows = line_rows(read_dumps(covdir, outdir))
    tot_c = sum(r[1] for r in rows)
    tot_l = sum(r[2] for r in rows)
    rows.sort(key=lambda r: (r[1] / r[2] if r[2] else 1))
    print(f"{'module':22s} {'lines':>12s}  {'%':>6s}   uncovered")
    for name, c, t, miss in rows:
        pct = 100.0 * c / t if t else 100.0
        show = ",".join(str(m) for m in miss[:14]) + ("…" if len(miss) > 14 else "")
        print(f"{name:22s} {c:5d}/{t:<6d} {pct:6.1f}%   {show}")
    print(f"\nTOTAL {tot_c}/{tot_l} = {100.0*tot_c/tot_l:.1f}% of lines")


if __name__ == "__main__":
    main(sys.argv[1], sys.argv[2])
