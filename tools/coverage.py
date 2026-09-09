#!/usr/bin/env python3
"""Summarise V8 coverage as LINE coverage over a compiled out/ directory.

  cd loom-session-tracker
  rm -rf /tmp/cov && NODE_V8_COVERAGE=/tmp/cov ./test.sh
  python3 ../tools/coverage.py /tmp/cov out

A line counts as covered unless every non-whitespace byte on it sits inside a zero-count V8 range.
Bare delimiters are not counted, and tsc's __importStar/__createBinding prologue is excluded from
the denominator — it is compiler output, not code anyone wrote or can test.
"""
import json, os, sys, glob, collections
covdir, outdir = sys.argv[1], sys.argv[2]
# byte-range -> uncovered offsets per file
uncovered = collections.defaultdict(list)   # path -> list of (start,end) with count 0
seen = set()
for f in glob.glob(os.path.join(covdir, "*.json")):
    try: d = json.load(open(f))
    except Exception: continue
    for s in d.get("result", []):
        url = s.get("url", "")
        if not url.startswith("file://"): continue
        p = url[7:]
        if os.path.realpath(os.path.dirname(p)) != os.path.realpath(outdir): continue
        seen.add(p)
        for fn in s.get("functions", []):
            for r in fn.get("ranges", []):
                if r.get("count", 0) == 0:
                    uncovered[p].append((r["startOffset"], r["endOffset"]))
rows = []
tot_c = tot_l = 0
for p in sorted(seen):
    src = open(p, encoding="utf8", errors="replace").read()
    dead = bytearray(len(src))
    for a, b in uncovered[p]:
        for i in range(max(0,a), min(len(src), b)): dead[i] = 1
    # a line counts as covered unless ALL its non-blank content is inside a zero-count range
    # tsc emits an __importStar/__createBinding prologue in every module; it is compiler output,
    # not code anyone wrote or can test, so it is excluded from the denominator.
    lines_all = src.split("\n")
    prologue_end = 0
    for i, l in enumerate(lines_all):
        if '__esModule' in l and 'defineProperty(exports' in l: prologue_end = i + 1; break
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
    tot_c += covered; tot_l += total
rows.sort(key=lambda r: (r[1]/r[2] if r[2] else 1))
print(f"{'module':22s} {'lines':>12s}  {'%':>6s}   uncovered")
for name, c, t, miss in rows:
    pct = 100.0*c/t if t else 100.0
    show = ",".join(str(m) for m in miss[:14]) + ("…" if len(miss) > 14 else "")
    print(f"{name:22s} {c:5d}/{t:<6d} {pct:6.1f}%   {show}")
print(f"\nTOTAL {tot_c}/{tot_l} = {100.0*tot_c/tot_l:.1f}% of lines")
