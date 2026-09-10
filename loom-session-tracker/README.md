# Loom Session Tracker

A VSCodium/VS Code extension for running **many Claude Code sessions as a team** on one machine.

If you use the Loom pattern — several Claude conversations open at once, each bound to a named
*role* (`developer`, `qa`, `curriculum`…), handing work to each other through a file bus at
`~/.claude/loom/<project>/` — this extension is the instrument panel for it. It watches every
session over the editor's own debug protocol and answers the questions you would otherwise be
answering by hand, or not at all:

- which tab is which role, right now, and is it still alive?
- did anything finish while I was looking elsewhere?
- is something stuck pretending to work?
- how many sessions am I actually running, across every window?
- is my orchestrator about to run out of context?

Everything it watches is read-only. The handful of things that change something — closing a
session, deleting one, clearing a context — are either an explicit click or a cycle with a written,
verified safety rule for each way it could destroy work.

---

## Requirements

| | |
|---|---|
| Editor | VSCodium or VS Code 1.85+, launched with `--remote-debugging-port=<port>` |
| Claude | The Claude Code extension (`anthropic.claude-code`), signed in |
| Bus | `~/.claude/loom/<project>/board.json` — the Loom file bus, one directory per project |
| Injector | `~/.claude/loom/loom_cdp.py` + `python3` — used to type into a session's composer |
| Runtime | `ws` (bundled); TypeScript to build |

The debug port is what makes any of this possible: it is how the extension reads the text of every
Claude panel in every window. It discovers the live port from the editor's own
`DevToolsActivePort` file, so you do not configure it — but the editor must have been started with
the flag. On this machine that is port **9333** (9222 is deliberately left to browser automation).

> **Never kill processes by matching that port.** `pkill -f "remote-debugging-port=9333"` matches
> the editor's own main process and takes down every window. Kill by PID or by a unique
> `--user-data-dir` instead.

---

## Installing

From the repo root:

```bash
cd loom-session-tracker && npm install && npx tsc -p .   # build out/
cd .. && ./deploy.sh loom-session-tracker                # copy + register + tell you to reload
```

Then reload the window (`Developer: Reload Window`). `deploy.sh` copies the built extension to
`~/.vscode-oss/extensions/local.loom-session-tracker-<version>/` and adds the matching entry to
`extensions.json`; there is no marketplace involved.

No npm on this machine? The suite and the live check run under the editor's bundled node
(`./test.sh`, `./live.sh`), and `out/` can be copied from a previous install.

---

## First five minutes

1. **Open a project window.** The project id is `basename(dirname(git rev-parse --git-common-dir))`
   — the same id the Loom skill uses, so a *worktree* window still resolves to the parent project.
   It must match a directory under `~/.claude/loom/`.
2. **Open the Loom Sessions view** (broadcast icon in the activity bar). Within one tick (15s) you
   should see your project with its live roles beneath it, each showing `● live` and a short frame
   id. The status bar shows `Loom: 2/3 · 11 open`.
3. **Tag the orchestrator.** The session you drive the others from appears as a candidate —
   `● possible orchestrator — click ★ to tag`. Click the star. Nothing else in the extension is
   *required*, but almost everything interesting is gated on it: finish notifications, stall
   alerts and the context-memory cycle all need to know where to talk.
4. **Run the startup digest** (checklist icon, or `Loom Sessions: What Needs Me?`) to see what has
   been sitting unattended.

If a role's session does not appear, it is usually because its tab has not said anything
identifiable yet — bind it with `/loom <role>` in that session and it will be picked up on the
next tick.

---

## What it does

### The live map

Every 15 seconds it reads the text of every Claude panel in every editor window and works out which
session is which role, from two independent signals: the `LOOMROLE=<role>` sign-off a role writes,
and the worktree paths its output is full of. A role's binding survives a tab that has scrolled its
marker out of view, and a failed read never wipes the map — sessions go `○ stale` rather than
vanishing. The result is published to `~/.claude/loom/<project>/targetmap.json`, which is what
`loom_cdp.py` uses to aim an injection at the right tab.

### Simultaneous session count

The per-project counter cannot see other windows. This one counts every Claude conversation open
across the whole editor and publishes it to `~/.claude/loom/active-sessions.json`, highlighting the
status bar past `sessionWarnThreshold`. Anthropic caps no session count, but they all draw on one
usage pool.

### Finish notifications

When a worker's `status.json` goes from working to `idle`/`blocked`, the tagged orchestrator gets a
`[loom-notify] …` prompt telling it whose outbox to read. State lives on the bus, so a finish that
happened while the editor was closed is still announced, and two windows watching one project
cannot both announce it.

### Stall watchdog

The finish notifier only ever sees a *transition*. A role that goes `working` and never comes back
is invisible to it — one had been "working" for 1,681 hours. The watchdog flags any role working
with no status update for `stallMinutes` (45 by default), warns you, and tells the orchestrator
once per stall. It also reports statuses outside the protocol (`idle|working|blocked`) and
`updated_at` fields that have stopped being maintained.

### Usage-limit auto-resume

When a session is blocked by a usage limit, the tree shows it paused with the limit and ETA. The
resume fires when the limit banner *clears* — an exact signal — not on the UI's coarse "resets in
2h" estimate, and only after it stays clear for consecutive ticks. Pending resumes survive a
restart.

### Model policy

The top pricing tier is reserved for the orchestrator. A worker found on a premium model is
switched back with `/model <workerModel>`, and stays pending until it is actually *seen* on a
cheaper model — a switch that silently fails is retried on a growing backoff rather than forgotten.

### Orchestrator context memory

The orchestrator is the session that actually fills up: it runs for days across every role. Left
alone it hits auto-compaction — a summary it did not choose, did not review and cannot re-read.

Past `contextThresholdPct` (50%) this extension makes that deliberate instead:

1. **Bank** — the orchestrator is asked to write its working memory to
   `~/.claude/loom/<project>/<role>/memory.md`: what it is doing, what each role owes it, decisions
   already made, open questions.
2. **Clear** — `/clear`, but only once that file is verifiably on disk.
3. **Restore** — a prompt into the fresh context: read the memory file, then the board, then the
   project docs, and reconcile them so the memory stays true.

The percentage comes from the panel's own compact button (`73% context used — click to compact`),
which the app renders only past 50% used; below that, or when the board records a `session_id`, the
session's transcript is used instead. Either source alone is enough.

`/clear` is irreversible from inside a session, so it is sent **only** when: the memory file exists,
is newer than the moment it was asked for, and is more than a stub; the session is not mid-turn; and
the frame was actually seen this tick. If the file never appears, the cycle aborts and clears
nothing. One window drives a cycle at a time (a lease on the bus), and a cycle is pinned to the role
and file it began with. `Loom Sessions: Bank Orchestrator Memory & Clear Context` runs one on
demand.

### Startup digest

On activation: responses sitting unpicked-up, roles blocked on a decision or by a usage limit,
workers on the premium model, unbanked worktree changes, roles whose session is not open, stalled
roles, and whether an orchestrator is tagged at all — with one-click **Tag orchestrator** and
**Reopen sessions**.

### Session lifecycle

Spawn a session for a role, retire (close) one, lock one against deletion, or delete a role's
artifacts entirely. Every destructive path refuses first: the orchestrator can never be closed or
deleted, a locked role cannot be touched, a role must be a *confirmed live agent of this project*
to be retired, and a delete refuses if the worktree has unbanked work — with a two-step
confirmation and a typed name.

### Worktree cleanup

Lists every worktree under `<project>/.claude/worktrees/` with its branch, orphaned/dirty/live
flags and unmerged-commit count. Removal deletes only the checked-out directory — branches and
commits are kept — and each removal is logged with its exact restore command to
`~/.claude/loom/worktree-removals.json`. It refuses anything dirty, still on the board, backing a
live session, on a detached HEAD, or holding gitignored files git cannot give back (`.env`, keys,
`*.sqlite`).

---

## Commands

| Command | What it does |
|---|---|
| `Refresh Now` | Force a tick |
| `Show Status` | The tracked agents and their liveness |
| `Spawn Session…` | Open a session for a role (refuses past the active cap) |
| `Retire (Close) Session` | Close a confirmed live agent's tab |
| `Delete Session` | Archive a role's worktree + transcript (recoverable) |
| `Lock` / `Unlock` | Protect a role from deletion |
| `Tag as Orchestrator` / `Untag` | Choose the session that receives notifications |
| `Show Simultaneous Session Count` | Editor-wide conversation count |
| `What Needs Me? (startup digest)` | The attention summary |
| `Toggle All-Projects View` | This project only, or every project |
| `Worktree Cleanup Report` | Report first, remove second |
| `Bank Orchestrator Memory & Clear Context` | Run a context-memory cycle now |

## Settings

All under `loomSessionTracker.`.

| Setting | Default | |
|---|---|---|
| `intervalMs` | `15000` | Tick interval (5s floor) |
| `showAllProjects` | `false` | Show every project's roles in this window |
| `sessionWarnThreshold` | `5` | Highlight past this many simultaneous conversations |
| `notifyOrchestrator` | `true` | Tell the orchestrator when a worker finishes |
| `stallWatchdog` / `stallMinutes` | `true` / `45` | Flag roles working but silent |
| `workingWarnThreshold` | `5` | Digest warning for roles working across all projects |
| `autoResumeAfterLimit` / `resumeMessage` | `true` / built-in | Resume a session when its usage limit lifts |
| `enforceWorkerModel` / `workerModel` / `premiumModels` | `true` / `claude-opus-5` / Fable, Mythos | Reserve the expensive tier for the orchestrator |
| `showStartupDigest` / `staleBusDays` / `digestUnbankedCheck` | `true` / `30` / `true` | The attention summary |
| `contextMemory` | `true` | Run the bank → clear → restore cycle |
| `contextThresholdPct` | `50` | When to run it |
| `contextWindowTokens` | `1000000` | Window size for the transcript estimate |
| `contextMemoryFile` | `""` | Empty = `~/.claude/loom/<project>/<role>/memory.md` |
| `contextSaveTimeoutMinutes` | `10` | Give up (clearing nothing) if the memory never appears |
| `contextClearTimeoutMinutes` | `5` | Give up on confirming a `/clear` |
| `contextCooldownMinutes` | `15` | Minimum gap between cycles |

## Files it touches

**Reads, never writes:** `<project>/board.json` (the roster), `<project>/bindings.json` (written by
`loom_cdp.py` at `/loom` time), each role's `status.json`/`inbox.md`/`outbox.md`, and
`~/.claude/projects/*/<sessionId>.jsonl`.

**Writes** (all atomic, change-only, and never fatal if they fail):
`<project>/targetmap.json`, `orchestrator.json`, `session-locks.json`, `notify-state.json`,
`limit-state.json`, `model-policy.json`, `stall-state.json`, `context-state.json`; globally
`active-sessions.json`, `working-sessions.json`, `worktree-removals.json`; plus `*-debug.json`
files recording the last injection attempt of each kind, which is where to look when something did
not arrive.

---

## Troubleshooting

**`★ orchestrator · frame not identified`** — the tag names a frame this project cannot see (its
window reloaded, or it was tagged from the wrong window). The real candidates are listed directly
beneath it; click the ★ on one.

**No candidate offered** — a session is only offered if it is *attributed to this project* (its
text names this project's paths) and is not one of its roles. A session whose output is dominated
by `worktrees/<role>` paths is treated as that worker, not as the orchestrator.

**`Loom: CDP?` in the status bar** — the debug read failed. The map is kept and aged rather than
wiped. Check the editor really was launched with `--remote-debugging-port`.

**Nothing is being injected** — read the relevant `~/.claude/loom/*-debug.json`. Note that
injections aimed at the orchestrator address its **webviewId**, not its role: `loom_cdp.py`
deliberately refuses to resolve `product-owner` by content, so a tag without a frame cannot deliver.

**Check everything at once:**

```bash
./live.sh
```

This asserts, against the *running* editor and the real bus, the things a unit test cannot: one
frame is at most one project's orchestrator, every tag resolves to an attributable frame of its own
project, a tagged orchestrator has some way to read its context, no rostered role's worktree reads
as orphaned, every board `session_id` resolves to a transcript — and it prints what the memory cycle
would do right now, per project. It is read-only: it never injects, writes or closes anything.

---

## Development

```bash
npx tsc -p .                                   # build to out/
./test.sh                                      # 349 checks, 22 files, zero dependencies
./test.sh notifier                             # filter by name
rm -rf /tmp/cov && NODE_V8_COVERAGE=/tmp/cov ./test.sh && python3 ../tools/coverage.py /tmp/cov out
./live.sh                                      # invariants against the live editor
```

Tests run under the editor's bundled node (no npm needed) and force `HOME` to a throwaway
directory, so they can never touch the real bus. The CDP layer is driven against a fake DevTools
server, so the reader's nesting, two-pass and timeout behaviour is tested without a browser.

A note on what the suite is *for*. It sits around 95% of lines, and it caught none of the four
defects found on 2026-09-08/09 — every fixture in it was written from the same model of the world as
the code, so where the model was wrong, the tests agreed. Coverage tells you which lines ran, never
which realities you considered. `live.sh` and measuring the real system are the other half;
when you change something here, check both.

Each module states its one job and the measurement behind its decisions at the top of the file —
start there. The parent [README](../README.md) carries the cross-extension notes, and
`~/.claude/loom/ORCHESTRATION-PLAYBOOK.md` describes the Loom pattern this serves.
