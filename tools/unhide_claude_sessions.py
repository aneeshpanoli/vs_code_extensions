#!/usr/bin/env python3
"""Un-hide Claude Code sessions that were 'deleted' from the session picker.

The Claude Code extension's delete-session action doesn't delete the transcript
— it adds the id to `hiddenSessionIds` in VSCodium's globalStorage. Hidden
sessions are filtered out of list_sessions, and the webview resolves resumes
through that list, so a hidden session can never be reopened: it silently
falls back to a blank new conversation.

RUN ONLY WHILE VSCODIUM IS FULLY CLOSED — the state DB is cached in memory and
flushed on exit, which would overwrite this edit.

Usage: unhide_claude_sessions.py [session-id ...]   (no args = un-hide ALL)
"""
import json
import os
import shutil
import sqlite3
import subprocess
import sys
import time

DB = os.path.expanduser("~/.config/VSCodium/User/globalStorage/state.vscdb")
KEY = "Anthropic.claude-code"

if subprocess.run(["pgrep", "-f", "codium --remote-debugging-port"],
                  capture_output=True).returncode == 0:
    sys.exit("REFUSED: VSCodium is running — quit it fully first (File > Exit).")

backup = f"{DB}.bak-{int(time.time())}"
shutil.copy2(DB, backup)

con = sqlite3.connect(DB)
state = json.loads(con.execute(
    "SELECT value FROM ItemTable WHERE key=?", (KEY,)).fetchone()[0])
hidden = state.get("hiddenSessionIds", [])
targets = set(sys.argv[1:])
keep = [h for h in hidden if targets and h not in targets] if targets else []
state["hiddenSessionIds"] = keep
con.execute("UPDATE ItemTable SET value=? WHERE key=?",
            (json.dumps(state), KEY))
con.commit()
con.close()
print(f"un-hid {len(hidden) - len(keep)} session(s); {len(keep)} still hidden")
print(f"backup: {backup}")
