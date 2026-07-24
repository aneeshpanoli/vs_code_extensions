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

Speaks Claude Code's latest reply aloud, ON DEMAND ONLY (never automatic). A
status-bar speaker button (and `Claude Chat: Read Latest Reply Aloud` /
`… Read Reply From Session…` / `… Stop Speaking` commands) reads the newest
assistant message from the workspace's session transcript, strips code blocks,
file paths, and tool-call noise, and speaks the prose with a natural neural
voice via **Piper** (streamed piper → aplay), falling back to `spd-say` if
Piper isn't installed. A second click (or Stop command) cancels. Plain JS, no
build.

Piper setup (one-time): `pipx install piper-tts`, then
`python3 -m piper.download_voices en_US-lessac-medium` into
`~/.local/share/piper-voices/`. Other voices from the same command; point
`claudeChatReader.piperModel` at the `.onnx`.

## loom-session-tracker

Loom-orchestration specific: keeps a live per-project map of Loom session
agents (role ↔ webviewId) fresh over CDP, with spawn / retire / lock / delete
commands in a dedicated activity-bar view. Read-only polling; destructive
actions are manual-only. TypeScript — build with `npm install && npx tsc -p .`.

## Installing (no marketplace)

No Node.js needed for the two plain-JS extensions: copy the folder to
`~/.vscode-oss/extensions/<publisher>.<name>-<version>/` and add a matching
entry to `~/.vscode-oss/extensions/extensions.json`, then reload VSCodium.
For loom-session-tracker, compile `out/` first (or copy an existing `out/`).

Note: VSCodium launches with `--remote-debugging-port=9333` on this machine.
9222 is reserved for browser-automation Chrome sessions — do not reuse it.
