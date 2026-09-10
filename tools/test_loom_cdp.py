#!/usr/bin/env python3
"""test_loom_cdp.py — tests for the guards in loom_cdp.py. No editor, no CDP; pure functions over a
fake bus built in a temp HOME.

WHY THESE EXIST. loom_cdp.py is the ONE component every editor window shares, whatever build of the
session-tracker extension that window loaded, and those builds drift for hours. A guard here is the
only kind that protects a session from a window running stale code — so it is the kind most worth
testing, and it had no tests at all.

    python3 ~/.claude/loom/test_loom_cdp.py
"""
import importlib.util, json, os, sys, tempfile, pathlib

SRC = os.path.expanduser("~/.claude/loom/loom_cdp.py")

def load(home):
    os.environ["HOME"] = home
    spec = importlib.util.spec_from_file_location("loom_cdp_t", SRC)
    m = importlib.util.module_from_spec(spec)
    try: spec.loader.exec_module(m)
    except SystemExit: pass
    return m

def bus(home, repo):
    d = pathlib.Path(home, ".claude", "loom", repo); d.mkdir(parents=True, exist_ok=True); return d

FAILS = []
def check(name, got, want):
    if got == want: print(f"  \033[32m✓\033[0m {name}")
    else:
        print(f"  \033[31m✗\033[0m {name}\n      got:  {got!r}\n      want: {want!r}"); FAILS.append(name)

with tempfile.TemporaryDirectory() as home:
    # tfg_ua declares its orchestrator three different ways; funisland has a plain worker.
    b = bus(home, "tfg_ua")
    (b / "board.json").write_text(json.dumps({"productowner": {"webviewId": "PO-BOARD"},
                                              "developer1": {"webviewId": "DEV1"}}))
    (b / "orchestrator.json").write_text(json.dumps({"role": "productowner", "webviewId": "PO-TAG"}))
    (b / "productowner.id").write_text("PO-IDFILE\nLOOMROLE=productowner\n")
    (b / "developer1.id").write_text("DEV1\nLOOMROLE=developer1\n")
    f = bus(home, "funisland")
    (f / "board.json").write_text(json.dumps({"scriptwriter": {"session_id": "s"}}))
    # the poisoned cache, exactly as measured 2026-09-10
    (f / "targetmap.json").write_text(json.dumps({"PO-TAG": "scriptwriter"}))

    m = load(home)
    d = m.declared_orchestrator_frames()
    check("board owner entry is a declared orchestrator frame", d.get("PO-BOARD"), "tfg_ua/productowner")
    check("orchestrator.json is one", d.get("PO-TAG"), "tfg_ua/productowner")
    check("an owner .id file is one", d.get("PO-IDFILE"), "tfg_ua/productowner")
    check("a WORKER's frame is not", "DEV1" in d, False)
    check("a worker's .id file is not", d.get("DEV1"), None)

    check("owner aliases are all recognised",
          all(m.is_owner_role(r) for r in ("product-owner", "productowner", "po", "PO")), True)
    check("a worker name never is",
          any(m.is_owner_role(r) for r in ("developer1", "scriptwriter", "socialworker1")), False)

    # role resolution stays project-scoped, and refuses to guess when a bare name is ambiguous
    for repo in ("tfg_ua", "funisland"):
        (bus(home, repo) / "board.json").write_text(json.dumps(
            {"developer1": {}, ("productowner" if repo == "tfg_ua" else "scriptwriter"): {}}))
    check("a role is resolved inside the project that was named",
          (m._role_repo("developer1", "tfg_ua"), m._role_repo("developer1", "funisland")),
          ("tfg_ua", "funisland"))
    check("an ambiguous bare name refuses rather than guessing", m._role_repo("developer1"), None)
    check("an unambiguous bare name still resolves", m._role_repo("scriptwriter"), "funisland")

    # the scoped targetmap is the project's own, never a merge of every bus
    (bus(home, "tfg_ua") / "targetmap.json").write_text(json.dumps({"DEV1": "developer1"}))
    check("targetmap scoped to a repo holds only that repo's entries",
          m._load_targetmap("tfg_ua"), {"DEV1": "developer1"})
    check("unscoped, it merges every bus (the ambiguity --repo exists to remove)",
          m._load_targetmap().get("PO-TAG"), "scriptwriter")

print()
if FAILS: print(f"\033[31m{len(FAILS)} failed\033[0m"); sys.exit(1)
print("\033[32mall passed\033[0m")

# ── the busy guard (added 2026-09-10) ───────────────────────────────────────────────────────────
with tempfile.TemporaryDirectory() as home:
    m = load(home)
    print()
    check("a working tab reads busy", m.frame_is_busy("running the suite\nClaude is working"), True)
    check("the interrupt hint reads busy", m.frame_is_busy("x" * 3000 + "esc to interrupt"), True)
    check("an idle tab does not", m.frame_is_busy("Ready for your input."), False)
    # Only the TAIL is examined: a conversation that DISCUSSES the words is not mid-turn. This is the
    # same rule as the extension's sessions.isBusy(), and the reason it is a tail check at all.
    check("the words far above the composer do not",
          m.frame_is_busy('we discussed "Claude is working" earlier ' + "x" * 2500), False)
    check("empty text is not busy", m.frame_is_busy(""), False)
    check("None is not busy", m.frame_is_busy(None), False)
