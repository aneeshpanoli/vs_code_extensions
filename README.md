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

## claude-session-manager

Works around a Claude Code extension bug (verified in v2.1.204): its
`deserializeWebviewPanel` drops the sessionId, so every Claude tab restored on
window reopen is a blank new conversation. This extension closes those blank
shells after startup and reattaches the most recent real sessions via
`claude-vscode.editor.open <sessionId>`. Also provides
`Claude Sessions: Open Session…` — a quick-pick over every on-disk transcript
in `~/.claude/projects/`, including sessions hidden from the built-in picker.
Plain JS, no build.

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

TypeScript — build with `npm install && npx tsc -p .`. **Tests:** `./test.sh`
(optionally with a name filter, e.g. `./test.sh notifier`) — 103 checks across 12
files, zero dependencies, run under VSCodium's bundled node since this machine
has no npm. The runner forces `HOME` to a throwaway directory, so tests can
never touch the real `~/.claude/loom` bus.

## Installing (no marketplace)

No Node.js needed for the two plain-JS extensions: copy the folder to
`~/.vscode-oss/extensions/<publisher>.<name>-<version>/` and add a matching
entry to `~/.vscode-oss/extensions/extensions.json`, then reload VSCodium.
For loom-session-tracker, compile `out/` first (or copy an existing `out/`).

Note: VSCodium launches with `--remote-debugging-port=9333` on this machine.
9222 is reserved for browser-automation Chrome sessions — do not reuse it.
