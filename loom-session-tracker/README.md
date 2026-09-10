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

## Naming roles

One canonical orchestrator id: **`product-owner`**. Nothing in the code compares a role name against a
literal — everything asks `isOwnerRole()` in [`src/naming.ts`](src/naming.ts), which accepts every
spelling in `OWNER_ALIASES`: `product-owner`, `productowner`, `product_owner`, `po`, `owner`,
`orchestrator`, `pm`.

This matters more than it looks. Before 2026-09-09 the owner set was hardcoded in four places
(`roles.ts`, `coordinator.ts`, `orchestrator.ts`, and twice in `loom_cdp.py`) and `po` — livegita's
actual board key and mailbox — was in none of them. Its orchestrator was therefore classified as an
ordinary **worker**, which meant it was never offered as a tag candidate *and* was a legal
spawn/retire/delete target: the boundary that exists to make the orchestrator undeletable had a hole
in it for one project. `loom_cdp.py` now reads the same table from `~/.claude/loom/naming.json`, which
this extension publishes on activation, so the two cannot drift.

**Adding a spelling** is a one-line edit to `OWNER_ALIASES`. Do that rather than letting a bus invent
a name nothing recognises — `./live.sh` fails loudly on an owner-looking role the contract rejects.

### Per-project naming lives on the bus

`~/.claude/loom/<repo>/naming.json` — no rebuild, no redeploy:

```json
{
  "owner": "po",
  "aliases": { "gitadeveloper": "developer" }
}
```

- **`owner`** — which mailbox is this project's real orchestrator, when the bus has more than one.
  livegita has both `po/` (42 KB inbox, queued tickets, tools) and an empty `productowner/` the PO
  session created for itself; only the project can say which is real.
- **`aliases`** — two names for one agent, collapsed. An alias must point at a role that already
  exists on the bus, and resolution is one step only, so it can never loop.

Alias direction is deliberate: **collapse into the name that has a worktree.** `gitadeveloper` folds
into `developer` because `worktrees/developer` is a real path, so the surviving name resolves from
*either* signal. The other direction would leave a role identifiable only by a `LOOMROLE=` marker that
scrolls out of the panel — which is exactly why livegita's one developer read as two different agents
depending on what was on screen.

Mailbox directories are never renamed by any of this. Every `loom/<repo>/<role>/status.json` path
keeps working, and `ownerRoleFor()` follows a bus that later renames itself to the canonical id.

### Role names are project-scoped, and there are four of them

The bus directory namespaces role names, so every project uses the **same** vocabulary and nothing
needs a project prefix:

| role | job |
|---|---|
| `product-owner` | orchestrates; banks, never edits |
| `developer` | builds |
| `designer` | design |
| `monetization` | revenue |

That is only safe because resolution is scoped. `loom_cdp.py`'s `_role_repo()` used to resolve a bare
name by scanning every board and taking the first hit — `sorted()` puts `Gaming` before `livegita`, so
`/loom developer` in livegita wrote its binding onto **Gaming's** bus. That was the 2026-09-08 LG-001
misroute, and the only reason livegita's developer was ever renamed `gitadeveloper`. Two such
collisions were live on 2026-09-09: `developer` (Gaming + livegita) and `productowner` (Gaming +
shwab_docker).

Now every role operation takes `--repo`. The extension passes it on every path that targets a role
(finish notifier, stall alert, context cycle, model policy, limit resume) — one project per editor
window, so the window always knows. Without `--repo`, an ambiguous bare name is **refused** with the
list of buses that carry it, instead of guessed. The targetmap is scoped the same way, so a `/model`
nudge aimed at livegita's developer cannot land in Gaming's.

The vocabulary is a **target, not a gate**: nothing renames a mailbox or refuses an off-list role.
`./live.sh` reports each bus's distance from it (`INFO`), so a migration is a visible decision.
funisland runs 13 genuinely distinct agents; collapsing that is not a cleanup.

### The board outranks the tag

The sidebar once offered a *diagnostic* session as livegita's only orchestrator candidate — twice in
one evening it got starred, and the finish notifier typed a developer's loop-back into it. When a
board declares the PO's frame, that frame is the only candidate shown, and it is the frame the cycle
uses even if the tag points elsewhere; a misclick cannot override the board.

### Finding the orchestrator's tab

The orchestrator quotes its workers' `LOOMROLE=` sign-offs, so content detection calls it a worker
unless it quotes **three distinct** roles. A project with one or two workers can never reach three —
livegita's PO quoted a single `LOOMROLE=gitadeveloper` and was read as the developer, then beat the
real developer's frame for that role on text length (159 KB vs 57 KB). The sidebar was showing the
orchestrator's tab *as* the developer, which is how a hand-tag came to write `{"role":"gitadeveloper"}`.

So the **board is authoritative**: a board entry whose key is an owner name carries the PO's own
`webviewId`, and `boardOwnerFrames()` treats that frame as the orchestrator regardless of what its
text looks like. The `≥3 distinct roles` heuristic is a fallback for buses that declare nothing.

The context cycle refuses outright to run against a tag that does not name an orchestrator — its
endpoint is a `/clear`, and a worker-named tag is one tick away from wiping a working session.

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

## Testing

Three layers, because the first two were not enough. On 2026-09-09 this suite went from 349 to 388
passing across a night in which the live system misrouted six different ways — every fixture had been
written from the code's own model of the world, so where that model was wrong the tests agreed with it.

```bash
./test.sh                 # unit + fixture suites
python3 test/mutation.py  # reintroduce each known defect; the suite MUST fail on every one
./live.sh                 # invariants against the running editor and the real bus
```

**Captured fixtures** (`test/fixtures/live/`) are real panels from the running editor, snapshotted by
`test/fixtures/capture.js`. It redacts the user's prose but preserves every token classification reads —
sign-off lines, worktree and project paths, the model footer, limit banners, the busy chip — at their
real positions and repetition counts, so purity ratios and frame lengths (which decide ties) survive
exactly. Capture **refuses to write a fixture whose behaviour differs from the frame it came from**, and
snapshots the buses too, since a roster and its aliases are half the input. Re-run it when the world
changes; state the ground truth in the test by hand, from evidence outside the code.

**Mutation testing** is what keeps the suite honest. `test/mutation.py` restores each defect that was
actually live that night — `po` missing from the owner set, a clean owner sign-off falling through to
worktree paths, path evidence needing no corroboration, commands typed into busy composers, a limit
banner that never expires — and fails if the suite still passes. A green suite means nothing; a suite
that breaks when reality does means something.

**Dispatch** (`src/dispatch.ts`) exists so the decision that caused the harm — *who gets typed into* —
can be asserted directly. It used to live in a closure inside `activate()`, reachable only by driving
the whole extension, and had no test of its own.

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
