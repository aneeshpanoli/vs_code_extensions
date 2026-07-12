# Claude Auto-Accept

VSCodium extension that auto-accepts Claude Code permission prompts by keeping
`permissions.defaultMode` set to `bypassPermissions` in `~/.claude/settings.json`
(the supported knob the Claude Code extension and CLI both read).

## What it does

- **Status bar toggle** (right side): `✓ Claude: Auto-Accept` ⇄ `🛡 Claude: Ask`.
  Click to flip. Shows a warning-colored background while auto-accept is on,
  as a reminder that Claude runs tools without asking.
- **Commands** (Ctrl+Shift+P): `Claude Auto-Accept: Toggle / Enable / Disable`.
- **Startup enforcement** (`claudeAutoAccept.enforceOnStartup`, default on):
  if something reset the mode, it is forced back to `bypassPermissions` when
  VSCodium starts.
- Watches `~/.claude/settings.json` so the indicator stays accurate if you
  change the mode from the CLI.

## Why not click the popups?

VS Code's extension API cannot reach into another extension's webview or
dialogs, so literally auto-clicking Claude Code's prompt buttons is not
possible. Setting the permission mode is the equivalent — and official — way
to make the prompts never appear.

## Notes

- Already-running Claude sessions keep their current mode; new sessions pick
  up the change. In an open session you can also cycle modes with Shift+Tab.
- Prompts that are not tool permissions (e.g. MCP OAuth sign-in) still appear;
  those cannot be bypassed.
- Install location: `~/.vscode-oss/extensions/aneesh.claude-auto-accept-1.0.0`
  plus an entry in `~/.vscode-oss/extensions/extensions.json`.
