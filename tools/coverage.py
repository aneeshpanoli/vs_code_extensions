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
it — so the masks INTERSECT. Intersected, the same two dump sets read 93.3% (5652/6060) and 93.1%
(5640/6060), and LOOM_TEST_JOBS=4 and =32 agree to the line.

The 12 lines still between them are NOT a merge artefact — they are a different execution. Each
parallel child gets its own throwaway HOME; the single-process path gives all 39 test files ONE.
Sharing it lets state from one file leak into another and reach gc.js's `busFrameMismatch` branch,
which needs two buses declaring one webviewId — a collision no isolated process can produce and,
tellingly, no test sets up on purpose. The parallel number is the honest one.
"""
import json, os, sys, glob, collections, bisect, urllib.parse


def u16_starts(src):
    """The UTF-16 code-unit offset at which each codepoint of `src` begins, plus the total.

    V8 REPORTS SOURCE POSITIONS IN UTF-16 CODE UNITS; PYTHON INDEXES CODEPOINTS. Every astral
    character — an emoji — shifts every later offset by one, and this codebase puts 🔒 in
    user-facing strings. Measured 2026-09-13 on the real dumps: coordinator.js and statusView.js
    carry two each, and for all 29 modules the largest endOffset equals the UTF-16 length exactly,
    never len(src). Left unmapped the skew slides each range two characters right, which is how
    coordinator.js:173 — a `throw` inside a zero-count range in EVERY observation — was scored
    covered: the first two characters fell outside the shifted range, so the line no longer looked
    wholly dead. Reporting a line covered that nothing ran is the one direction this tool must
    never fail in. None means the file is pure BMP and the offsets already are codepoint indices."""
    if all(ord(c) <= 0xFFFF for c in src):
        return None
    starts, u = [], 0
    for ch in src:
        starts.append(u)
        u += 2 if ord(ch) > 0xFFFF else 1
    starts.append(u)
    return starts


def to_cp(offset, starts):
    """A UTF-16 offset as a codepoint index. Exact for any real range bound; an offset landing
    inside a surrogate pair (which V8 does not emit) rounds to the next whole character."""
    return offset if starts is None else bisect.bisect_left(starts, offset)


def merge_dead(observations, length):
    """The dead-byte mask for one source file, given one zero-count range list PER OBSERVATION.

    An observation is a single script entry in a single process's dump. Bytes are dead only where
    EVERY observation agrees they are dead. A process that never LOADED a module omits it from its
    dump entirely (measured: per-dump module counts run from 1 to 29 of 29), so it casts no vote at
    all; what collapsed the old union was the process that loaded a module and barely exercised
    it, contributing one enormous dead range that outvoted every process that ran the thing.

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
            # Node percent-encodes these URLs. Without unquote, a checkout under a path containing
            # a space or a non-ASCII character never matches `outdir` and the module vanishes from
            # the report entirely — no error, just a smaller denominator.
            p = urllib.parse.unquote(url[7:])
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
        starts = u16_starts(src)
        # THE DUMPS MUST DESCRIBE THIS EXACT FILE. If out/ was rebuilt after the run, every offset
        # is measured against a source that no longer exists and min(length, b) would quietly clamp
        # the mismatch away, reporting a confident wrong number. Fail loudly instead (principle 10:
        # a result you cannot compare against anything is not evidence).
        u16_len = starts[-1] if starts is not None else len(src)
        biggest = max((b for ranges in observations[p] for _, b in ranges), default=0)
        if biggest > u16_len:
            raise SystemExit(
                f"{os.path.basename(p)}: coverage dump ends at offset {biggest} but the file is "
                f"{u16_len} UTF-16 units long — out/ was rebuilt after the run. Re-run the suite "
                f"under NODE_V8_COVERAGE against THIS build.")
        dead = merge_dead([[(to_cp(a, starts), to_cp(b, starts)) for a, b in ranges]
                           for ranges in observations[p]], len(src))
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
