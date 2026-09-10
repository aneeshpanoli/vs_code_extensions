# VSCodium Extensions

Custom extensions for the satori-AI VSCodium + Claude Code setup.

## claude-auto-accept

Keeps Claude Code permission prompts off by enforcing all four knobs of the
permission chain on every startup:

1. `permissions.defaultMode: "bypassPermissions"` in `~/.claude/settings.json`
2. `bypassPermissionsModeAccepted: true` in `~/.claude.json` (without it, bypass
   mode is silently ignored)
3. `claudeCode.initialPermissionMode: "bypassPermissions"` (the IDE extension
   ignores the CLI defaultMode for panel conversations)
4. `claudeCode.allowDangerouslySkipPermissions: true`

Status-bar toggle: `✓ Claude: Auto-Accept` ⇄ `🛡 Claude: Ask`. Plain JS, no build.

## claude-chat-reader

Speaks Claude Code replies aloud (never automatic — you trigger it). Two modes:

- **Follow toggle** (status-bar button): once on, each *new* reply is spoken as
  it lands — queued so they never overlap, and history is never re-read (it
  baselines at the current end of the transcript and tails only new lines).
  Click again to stop.
- **One-shot**: `Claude Chat: Read Latest Reply Aloud (once)` and
  `… Read Reply From Session…`.

Prose only: code blocks, file paths, and tool-call noise are stripped. Speech
uses a natural neural voice via **Piper** (streamed piper → aplay), falling
back to `spd-say` if Piper isn't installed. `… Stop Speaking` clears the queue.
Plain JS, no build.

Piper setup (one-time): `pipx install piper-tts`, then
`python3 -m piper.download_voices en_US-lessac-medium` into
`~/.local/share/piper-voices/`. Other voices from the same command; point
`claudeChatReader.piperModel` at the `.onnx`.

## loom-session-tracker

Loom-orchestration specific: keeps a live per-project map of Loom session
agents (role ↔ webviewId) fresh over CDP, with spawn / retire / lock / delete
commands in a dedicated activity-bar view. Read-only polling; destructive
actions are manual-only. Tag one role as orchestrator and it is auto-notified
(via `loom_cdp inject`) whenever a worker finishes; that state lives on the bus,
so it survives IDE restarts.

It also monitors **simultaneous** Claude sessions editor-wide (all windows, not
just this project): the status bar shows `Loom: n/3 · N open`, highlighting past
`sessionWarnThreshold` (default 5). Anthropic sets no cap on concurrent sessions
but they share one usage pool, and its own guidance suggests 3-5 in parallel.
The count is published to `~/.claude/loom/active-sessions.json` so the Loom
sessions and scripts can read it.

**Usage-limit auto-resume:** when a role is blocked ("You've hit your session
limit · resets in 2h") the tree shows it paused with the limit and ETA, and the
role is remembered on the bus (`<repo>/limit-state.json`). The resume fires when
the banner *clears* — an exact signal — not on the UI's coarse ETA, and only
after it stays clear for consecutive ticks. Pending resumes survive an IDE
restart. Toggle with `autoResumeAfterLimit`; customise `resumeMessage`.

**Startup digest** ("what needs me?"): on activation, and via the checklist
icon / `Loom Sessions: What Needs Me?`, it summarises responses sitting
unpicked-up (outbox newer than inbox), roles blocked on a decision, roles
blocked by a usage limit, workers on the premium model, unbanked worktree
changes, roles whose session isn't open, and whether an orchestrator is tagged
at all. Offers one-click **Tag orchestrator** and **Reopen sessions** (a
multi-select; never automatic). Also reports hygiene across every bus — long-dead
buses and role names claimed by more than one project. Settings:
`showStartupDigest`, `staleBusDays`, `digestUnbankedCheck`.

**Status health:** the finish notifier only fires on a working -> idle/blocked
transition, so a role that goes `working` and never returns is invisible to it. A
stall watchdog flags roles working with no `status.json` update for
`stallMinutes` (default 45) and tells the orchestrator once per stall. It also
flags statuses outside the protocol (`idle|working|blocked`) and `updated_at`
fields that have stopped being maintained. The notifier itself baselines on any
*working-like* status (`working|active|running|busy`), so a role writing e.g.
`active` still announces its finishes — but the non-conforming status is still
reported, because nothing else in the system recognises it.

**Roster derivation:** a project's roles are its board entries *union* every bus
directory holding a mailbox (`status.json` / `inbox.md` / `outbox.md`). A flat
`board.json` mixes roles with metadata, and a name denylist could not tell them
apart — funisland's board carries `standing_order`, `lanes`, `free_now` and so
on, and listed only 3 of its 11 roles. Board entries are now recognised by
*shape* (a role entry carries `session_id`/`branch`/`status`/`bound_at`), and a
role with a mailbox counts whether or not the board remembers it. A dropped role
was never harmless: it was undetectable in the sidebar, invisible to the stall
watchdog, and its worktree read as orphaned and removable.

**Orchestrator context memory:** the orchestrator is the session that actually
fills up — it runs for days across every role, and one live bus showed four
auto-compactions at ~999k tokens. Past `contextThresholdPct` (default 50% of
`contextWindowTokens`, default 1,000,000 — the measured auto-compaction ceiling
on this machine) it is asked to write its working memory to a file (default
`~/.claude/loom/<repo>/<role>/memory.md`), then `/clear`, then a restore prompt
that reads that file, the board, and the project docs — reconciling the memory
against them so it stays true.

Tag candidates come in two strengths, because the strong signal misses the
sessions that need this most. `detectOwner` wants a `LOOMROLE=product-owner`
sign-off or three distinct roles quoted — measured, exactly one frame editor-wide
passed it, while funisland's orchestrator (sitting at 71% context, the very
session the cycle exists for) passed neither that nor role classification and so
could not be tagged at all. A session that is attributed to a project and is
**not one of its roles** is therefore offered as a candidate too, labelled
"possible orchestrator" with its context percentage. A weak candidate can be
tagged with a click; only a strong one is ever adopted silently. A tag whose
frame this project cannot see is shown as `frame not identified` and the real
candidates are offered beneath it, so it is re-pointable in one click.

The orchestrator's frame is identified by **attribution**, not by being the only
candidate: the CDP read is editor-wide, so every window sees every window's
panels. A frame is adopted for this project only when its own text names this
project's paths (`loom/<repo>/`, `Containers/<repo>/`) and no other's — measured,
the live PO frames scored Gaming:76, livegita:115, funisland:36,
shwab_docker:24, so the signal is not close. An unattributable frame is adopted
by nobody and the cycle holds instead of typing into a stranger.

Context is read from **two** sources, and either alone is enough. The panel's own compact button carries it
in a title attribute — `73% context used — click to compact` — and the shipped
webview renders that button only once usage passes ~50% (`100 - used >= 50`
returns nothing), dividing by the app's own `contextWindow - maxOutputTokens -
13000`. That is the best number available, so it wins when it is there; the CDP
read pulls it alongside the panel text, since `innerText` cannot see an
attribute. Below the button's threshold, and for the token count, the session's own
transcript is used when the board records a `session_id` for the tagged role
(`~/.claude/projects/<slug>/<sessionId>.jsonl`: `input + cache_read +
cache_creation` of the last main-thread turn; subagent turns skipped, tail-only
— one live transcript is 63 MB). The percentages in Claude's sessions sidebar
are usage-limit percentages, unrelated to context.

A completed `/clear` is confirmed by either of two witnesses, because only one is
always available: a **new session id** in the same project directory, or the
**panel emptying out** (a cleared tab renders ~170 characters and loses its
compact button; the live orchestrator conversation it replaces was 145,680). The
second is what makes the cycle work for an orchestrator tagged as
`product-owner`, which no board lists and which therefore has no transcript at
all.

`/clear` is irreversible from inside the session, so it is sent only when the
memory file exists, is newer than the moment it was asked for, and is more than a
stub — and never while the session is mid-turn. If the file never appears the
cycle aborts and clears **nothing**. State lives on the bus
(`<repo>/context-state.json`), so an IDE restart resumes mid-cycle rather than
re-clearing. `Loom Sessions: Bank Orchestrator Memory & Clear Context` runs a
cycle on demand (skipping only the threshold and cooldown). Settings:
`contextMemory`, `contextThresholdPct`, `contextWindowTokens`,
`contextMemoryFile`, `contextSaveTimeoutMinutes`, `contextClearTimeoutMinutes`,
`contextCooldownMinutes`.

**Reaching the orchestrator:** injections aimed at the orchestrator address its
**webviewId**, recorded on the tag, not its role. `loom_cdp.py`'s `find_role()`
drops any frame that content-detects as product-owner (the self-woke guard), so
`inject --role product-owner` could never land — the finish notifier and stall
alert had a delivery path that would always have failed. `loom_cdp.py` now takes
`--webview-id` to address one named frame exactly: content detection is not
consulted, so there is nothing left to misidentify.

**Global concurrency:** roles working simultaneously across *all* projects are
counted and published to `~/.claude/loom/working-sessions.json`; the digest warns
past `workingWarnThreshold` (default 5). The per-project cap is 3, but no single
window can see the others, and every session draws on one usage pool.

**Worktree cleanup:** `Loom Sessions: Worktree Cleanup Report` lists every
worktree under `<repo>/.claude/worktrees/` with its branch, orphaned/dirty/live
flags and unmerged-commit count. Removal deletes only the checked-out directory
— branches and commits are kept, and each removal is logged with its exact
restore command in `~/.claude/loom/worktree-removals.json`.

Refused automatically (each one a way git could not give the work back):
dirty; still on the board; backing a live session; **detached HEAD** (its
commits are on no branch); **holding gitignored files git cannot restore**
(`.env`, keys, `*.sqlite`, `*.db`, credentials — `git status --porcelain` does
not list ignored files, so these read as "clean"); or unverifiable. Never uses
`--force`, and report-first with a separate confirmation.

**All-projects view:** `Loom Sessions: Toggle All-Projects View` (globe icon)
switches the window between its own project and every project.

**Model policy:** the top pricing tier ($10/$50 per MTok — Fable/Mythos) is
reserved for the orchestrator. Each role's model is read from its composer
footer; a worker found on a premium model is switched back with
`/model <workerModel>` (default `claude-opus-5`). A role stays pending until it
is actually *seen* on a cheaper model — a switch that fails or silently doesn't
take effect is retried on a growing backoff (1m/2m/5m/15m), never forgotten. The
orchestrator is exempt twice over: explicitly, and structurally — it is never a
tracked agent, so it cannot be a target. Settings: `enforceWorkerModel`,
`workerModel`, `premiumModels`.

TypeScript — build with `npm install && npx tsc -p .`. **Tests:** `./test.sh`
(optionally with a name-substring filter, e.g. `./test.sh notifier`) — 308 checks across 21 files, zero dependencies, run under VSCodium's bundled node since this
machine has no npm. Measured coverage: **95.2% of lines**, every module included
— `rm -rf /tmp/cov && NODE_V8_COVERAGE=/tmp/cov ./test.sh && python3
../tools/coverage.py /tmp/cov out` prints the per-module table (a line counts as
covered unless every non-whitespace byte on it is inside a zero-count V8 range;
tsc's import prologue is excluded from the denominator). The CDP protocol is driven against a
fake DevTools server (`test/fake-devtools.js`) — HTTP discovery plus a websocket
that answers auto-attach and `Runtime.evaluate` — so the reader's nesting,
two-pass and timeout behaviour is tested without a browser.

**`./live-check.js`** (or `npm run live`) is the other half, and exists because the
suite caught none of the four defects found on 2026-09-08/09: every fixture in it
was written from the same model of the world as the code, so where the model was
wrong the tests agreed with it. Board fixtures always listed the role the test
then tagged; every test supplied one window's frames; every test's orchestrator
frame carried a `LOOMROLE=` sign-off. Coverage says which lines ran, not which
realities were considered. So live-check asserts invariants against the RUNNING
editor and the real bus: one frame is at most one project's orchestrator, every
tag resolves to an attributable frame of its own project, a tagged orchestrator
has some way to read its context, no rostered role's worktree reads as orphaned,
every board `session_id` resolves to a transcript — and it prints what the memory
cycle would do right now, per project. Read-only: it never injects, writes or
closes anything, so it is safe against a working editor. Suite takes ~10s
(one test deliberately waits out a polling interval). The runner forces `HOME` to a throwaway directory, so tests can
never touch the real `~/.claude/loom` bus.

## Installing (no marketplace)

No Node.js needed for the two plain-JS extensions: copy the folder to
`~/.vscode-oss/extensions/<publisher>.<name>-<version>/` and add a matching
entry to `~/.vscode-oss/extensions/extensions.json`, then reload VSCodium.
For loom-session-tracker, compile `out/` first (or copy an existing `out/`).

Note: VSCodium launches with `--remote-debugging-port=9333` on this machine.
9222 is reserved for browser-automation Chrome sessions — do not reuse it.
