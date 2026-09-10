#!/usr/bin/env python3
"""mutation.py — REINTRODUCE each defect this suite exists to catch, and require the suite to FAIL.

A green suite proves nothing on its own. On 2026-09-09 this project's suite went 349 -> 388 passing
across a night in which the LIVE system misrouted six different ways: it typed /model 38 times into a
diagnostic session, sent one project's resume into another project's tab, tagged a developer as the
orchestrator, let three usage limits sit expired for hours, and classified the Gita PO as a developer.
Every one of those passed the suite of the moment.

What separates a test that describes REALITY from one that merely describes the code is whether it
breaks when reality does. Each mutation below restores a defect that was actually live that night; a
mutation that SURVIVES means that defect could return unnoticed, and this script fails.

    ELECTRON_RUN_AS_NODE=1 codium ... -- run via: python3 test/mutation.py
"""
import subprocess, sys, os, pathlib

ROOT = pathlib.Path(__file__).resolve().parent.parent
CODIUM = os.environ.get("CODIUM", "/usr/share/codium/codium")
TSC = f'ELECTRON_RUN_AS_NODE=1 {CODIUM} node_modules/typescript/bin/tsc -p ./'

# (name, file, find, replace) — `find` must be unique in the file, or the mutation is reported stale.
MUTATIONS = [
 ("`po` is not an owner role — the Gita PO could not be found at all",
  "src/naming.ts",
  'OWNER_CANONICAL, "productowner", "product_owner", "po", "owner", "orchestrator", "pm",',
  'OWNER_CANONICAL, "productowner",'),

 ("a clean owner sign-off falls through to worktree paths — the PO read as its own developer",
  "src/roles.ts",
  "    return { role: null, purity: 1, source: null };\n  }",
  "  }"),

 ("path evidence needs no corroboration — a stranger printing paths took the developer role",
  "src/tracker.ts",
  'const uncorroborated = c.source === "path" && owned !== this.repoFilter;',
  "const uncorroborated = false;"),

 ("a marker names the project too — one frame claimed by two windows at once",
  "src/tracker.ts",
  "const conflicts = owned !== null && owned !== this.repoFilter;",
  "const conflicts = false;"),

 ("path evidence ties with a sign-off — the longest frame wins the role",
  "src/tracker.ts",
  'let priority = c.source === "marker" ? 1.2 : c.purity;',
  "let priority = c.purity;"),

 ("the board no longer identifies the orchestrator's frame",
  "src/tracker.ts",
  "if (ownerFrames.has(f.webviewId)) {",
  'if (ownerFrames.has("no-such-frame")) {'),

 ("commands are typed into busy composers — /model reported success and never executed",
  "src/dispatch.ts",
  '.filter((a) => purpose === "message" || !busyRoles.has(a.role))',
  ".filter((a) => Boolean(a))"),

 ("a worker-named tag may be addressed as the orchestrator",
  "src/dispatch.ts",
  "if (!isOwnerRole(tag.role)) {",
  "if (!isOwnerRole(tag.role) && Boolean(0)) {"),

 ("the context cycle accepts a worker-named tag — one tick from /clear-ing a developer mid-task",
  "src/memory.ts",
  "if (!isOwnerRole(input.role)) {",
  "if (!isOwnerRole(input.role) && Boolean(0)) {"),

 ("a limit banner never expires — three sessions sat blocked for hours after their reset",
  "src/limits.ts",
  "const expired = !!(rec.notBefore && nowMs > rec.notBefore + RESET_GRACE_MS);",
  "const expired = false;"),

 ("the reset deadline slides forward on every tick",
  "src/limits.ts",
  "notBefore: (prev && prev.notBefore && info.notBefore) ? Math.min(prev.notBefore, info.notBefore)",
  "notBefore: (prev && prev.notBefore && info.notBefore) ? Math.max(prev.notBefore, info.notBefore)"),

 ("the clock form of the banner is unparseable — `resets 9:50pm` yielded no deadline",
  "src/limits.ts",
  "const c = RESETS_AT_RE.exec(tail);",
  'const c = RESETS_AT_RE.exec("");'),
]

def sh(cmd):
    return subprocess.run(cmd, shell=True, cwd=ROOT, capture_output=True, text=True)

def restore():
    sh("git checkout -- src/")
    sh(TSC)

survived, stale = [], []
print(f"reintroducing {len(MUTATIONS)} defects that were live on 2026-09-09:\n")
try:
    for name, rel, find, repl in MUTATIONS:
        p = ROOT / rel
        src = p.read_text()
        n = src.count(find)
        if n != 1:
            print(f"  STALE     {name}\n            ({rel}: pattern occurs {n} times, expected 1)")
            stale.append(name); continue
        p.write_text(src.replace(find, repl))
        if sh(TSC).returncode != 0:
            print(f"  STALE     {name}\n            (mutant does not compile)")
            stale.append(name); restore(); continue
        r = sh("./test.sh")
        if r.returncode == 0:
            print(f"  SURVIVED  {name}")
            survived.append(name)
        else:
            fails = r.stdout.count("✗")
            print(f"  caught    {name}\n            ({fails} test(s) fail)")
        restore()
finally:
    restore()

print()
if survived or stale:
    for s in survived: print(f"SURVIVED: {s}")
    for s in stale:    print(f"STALE:    {s}")
    print(f"\n{len(survived)} survived, {len(stale)} stale — those defects could return unnoticed")
    sys.exit(1)
print(f"all {len(MUTATIONS)} mutations caught — every defect of that night now breaks the suite")
