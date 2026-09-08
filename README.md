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

**Status health:** the finish notifier only fires on `working -> idle/blocked`,
so a role that goes `working` and never returns is invisible to it. A stall
watchdog flags roles working with no `status.json` update for `stallMinutes`
(default 45) and tells the orchestrator once per stall. It also flags statuses
outside the protocol (`idle|working|blocked`) — a role sitting in e.g. `active`
can never trigger a finish notification — and `updated_at` fields that have
stopped being maintained.

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
(optionally with a name-substring filter, e.g. `./test.sh notifier`) — 195 checks across 17 files, zero dependencies, run under VSCodium's bundled node since this
machine has no npm. Measured coverage (V8, `NODE_V8_COVERAGE=dir ./test.sh`):
**89.7% of lines**, every module included. The CDP protocol is driven against a
fake DevTools server (`test/fake-devtools.js`) — HTTP discovery plus a websocket
that answers auto-attach and `Runtime.evaluate` — so the reader's nesting,
two-pass and timeout behaviour is tested without a browser. Suite takes ~10s
(one test deliberately waits out a polling interval). The runner forces `HOME` to a throwaway directory, so tests can
never touch the real `~/.claude/loom` bus.

## Installing (no marketplace)

No Node.js needed for the two plain-JS extensions: copy the folder to
`~/.vscode-oss/extensions/<publisher>.<name>-<version>/` and add a matching
entry to `~/.vscode-oss/extensions/extensions.json`, then reload VSCodium.
For loom-session-tracker, compile `out/` first (or copy an existing `out/`).

Note: VSCodium launches with `--remote-debugging-port=9333` on this machine.
9222 is reserved for browser-automation Chrome sessions — do not reuse it.
