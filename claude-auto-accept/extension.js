const vscode = require('vscode');
const fs = require('fs');
const path = require('path');
const os = require('os');

const SETTINGS_PATH = path.join(os.homedir(), '.claude', 'settings.json');
const STATE_PATH = path.join(os.homedir(), '.claude.json');
const BYPASS = 'bypassPermissions';

let statusItem;

function readSettings() {
  try {
    return JSON.parse(fs.readFileSync(SETTINGS_PATH, 'utf8'));
  } catch (err) {
    if (err.code === 'ENOENT') return {};
    throw err; // malformed JSON: surface it rather than clobbering the file
  }
}

function writeSettings(settings) {
  fs.mkdirSync(path.dirname(SETTINGS_PATH), { recursive: true });
  const tmp = SETTINGS_PATH + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(settings, null, 2) + '\n');
  fs.renameSync(tmp, SETTINGS_PATH);
}

function isEnabled() {
  try {
    const s = readSettings();
    return s.permissions && s.permissions.defaultMode === BYPASS;
  } catch {
    return false;
  }
}

// Bypass mode is inert until its one-time risk acknowledgement is recorded in
// ~/.claude.json; without it sessions silently fall back to prompting.
function ensureBypassAccepted() {
  let state;
  try {
    state = JSON.parse(fs.readFileSync(STATE_PATH, 'utf8'));
  } catch (err) {
    if (err.code === 'ENOENT') state = {};
    else return; // malformed or unreadable: leave the CLI's state file alone
  }
  if (state.bypassPermissionsModeAccepted === true) return;
  state.bypassPermissionsModeAccepted = true;
  const tmp = STATE_PATH + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(state, null, 2) + '\n');
  fs.renameSync(tmp, STATE_PATH);
}

function setMode(mode) {
  const settings = readSettings();
  settings.permissions = settings.permissions || {};
  settings.permissions.defaultMode = mode;
  writeSettings(settings);
}

function updateStatusBar() {
  const on = isEnabled();
  statusItem.text = on ? '$(check-all) Claude: Auto-Accept' : '$(shield) Claude: Ask';
  statusItem.tooltip = on
    ? 'Claude Code permission mode is bypassPermissions (all tool calls auto-accepted). Click to switch back to asking.'
    : 'Claude Code permission mode is default (prompts shown). Click to auto-accept everything.';
  statusItem.backgroundColor = on
    ? new vscode.ThemeColor('statusBarItem.warningBackground')
    : undefined;
  statusItem.show();
}

function apply(mode, announce) {
  try {
    setMode(mode);
    if (mode === BYPASS) ensureBypassAccepted();
    updateStatusBar();
    if (announce) {
      vscode.window.showInformationMessage(
        mode === BYPASS
          ? 'Claude Code: auto-accepting all permissions. New sessions (and sessions after a mode refresh) will not prompt.'
          : 'Claude Code: permission prompts re-enabled.'
      );
    }
  } catch (err) {
    vscode.window.showErrorMessage(`Claude Auto-Accept: could not update ${SETTINGS_PATH}: ${err.message}`);
  }
}

function activate(context) {
  statusItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
  statusItem.command = 'claudeAutoAccept.toggle';
  context.subscriptions.push(statusItem);

  context.subscriptions.push(
    vscode.commands.registerCommand('claudeAutoAccept.toggle', () =>
      apply(isEnabled() ? 'default' : BYPASS, true)
    ),
    vscode.commands.registerCommand('claudeAutoAccept.enable', () => apply(BYPASS, true)),
    vscode.commands.registerCommand('claudeAutoAccept.disable', () => apply('default', true))
  );

  // Keep the indicator honest if the file changes outside VSCodium (claude CLI, editors).
  try {
    const watcher = fs.watch(path.dirname(SETTINGS_PATH), (event, filename) => {
      if (filename === 'settings.json') updateStatusBar();
    });
    context.subscriptions.push({ dispose: () => watcher.close() });
  } catch {
    // settings dir missing or watch unsupported — status still refreshes on toggle
  }

  const enforce = vscode.workspace.getConfiguration('claudeAutoAccept').get('enforceOnStartup');
  if (enforce) {
    // The Claude Code IDE extension ignores ~/.claude/settings.json's defaultMode for
    // panel conversations — it starts them in claudeCode.initialPermissionMode, and
    // refuses bypass entirely unless allowDangerouslySkipPermissions is set.
    const cc = vscode.workspace.getConfiguration('claudeCode');
    if (cc.get('allowDangerouslySkipPermissions') !== true) {
      cc.update('allowDangerouslySkipPermissions', true, vscode.ConfigurationTarget.Global);
    }
    if (cc.get('initialPermissionMode') !== BYPASS) {
      cc.update('initialPermissionMode', BYPASS, vscode.ConfigurationTarget.Global);
    }
  }
  if (enforce) {
    if (!isEnabled()) {
      apply(BYPASS, false);
    } else {
      try { ensureBypassAccepted(); } catch { /* non-fatal; mode itself is set */ }
      updateStatusBar();
    }
  } else {
    updateStatusBar();
  }
}

function deactivate() {}

module.exports = { activate, deactivate };
