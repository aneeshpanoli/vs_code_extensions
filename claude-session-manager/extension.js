const vscode = require('vscode');
const fs = require('fs');
const path = require('path');
const os = require('os');

const PROJECTS_DIR = path.join(os.homedir(), '.claude', 'projects');

let channel;
function log(msg) {
  if (channel) channel.appendLine(`[${new Date().toISOString()}] ${msg}`);
}
// How the CLI flattens a cwd into a transcript directory name
// (/home/a/x_y/.claude -> -home-a-x-y--claude).
function flatten(p) {
  return p.replace(/[^A-Za-z0-9]/g, '-');
}

// Pull a human title out of a transcript: prefer the summary line, else the
// first real user message. Only the head of the file is read — transcripts can
// be hundreds of KB and the title is always near the top.
function sessionTitle(file) {
  let head = '';
  try {
    const fd = fs.openSync(file, 'r');
    const buf = Buffer.alloc(65536);
    const n = fs.readSync(fd, buf, 0, buf.length, 0);
    fs.closeSync(fd);
    head = buf.toString('utf8', 0, n);
  } catch {
    return null;
  }
  let firstUser = null;
  let hasUser = false;
  for (const line of head.split('\n')) {
    let obj;
    try { obj = JSON.parse(line); } catch { continue; }
    if (obj.type === 'summary' && typeof obj.summary === 'string') {
      return { title: obj.summary, hasUser: true };
    }
    if (obj.type === 'user' && !firstUser) {
      hasUser = true;
      const c = obj.message && obj.message.content;
      if (typeof c === 'string') firstUser = c;
      else if (Array.isArray(c)) {
        const t = c.find((p) => p && p.type === 'text' && p.text);
        if (t) firstUser = t.text;
      }
    }
  }
  if (!hasUser) return null; // empty shell session (e.g. created by the restore bug)
  return { title: firstUser || '(no title)', hasUser: true };
}

function listSessions(cwd) {
  const dir = path.join(PROJECTS_DIR, flatten(cwd));
  let files;
  try {
    files = fs.readdirSync(dir).filter((f) => f.endsWith('.jsonl'));
  } catch {
    return [];
  }
  const out = [];
  for (const f of files) {
    const full = path.join(dir, f);
    let st;
    try { st = fs.statSync(full); } catch { continue; }
    const meta = sessionTitle(full);
    if (!meta) continue; // skip unreadable/empty sessions
    out.push({
      id: f.slice(0, -6),
      mtime: st.mtimeMs,
      title: meta.title.replace(/\s+/g, ' ').trim().slice(0, 80),
    });
  }
  out.sort((a, b) => b.mtime - a.mtime);
  return out;
}

function workspaceRoot() {
  const ws = vscode.workspace.workspaceFolders;
  return ws && ws.length ? ws[0].uri.fsPath : null;
}

function claudeTabs() {
  const tabs = [];
  for (const group of vscode.window.tabGroups.all) {
    for (const tab of group.tabs) {
      const input = tab.input;
      if (input && input.viewType && /claudeVSCodePanel/.test(String(input.viewType))) {
        tabs.push(tab);
      }
    }
  }
  return tabs;
}

function ago(ms) {
  const s = Math.round((Date.now() - ms) / 1000);
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.round(s / 60)}m ago`;
  if (s < 86400) return `${Math.round(s / 3600)}h ago`;
  return `${Math.round(s / 86400)}d ago`;
}

async function openSession(id) {
  // The Claude extension's own open command: first arg is the sessionId, which
  // its window-restore path drops — this is the reattach the serializer forgot.
  await vscode.commands.executeCommand('claude-vscode.editor.open', id, undefined, undefined);
}

async function pickAndOpen() {
  const root = workspaceRoot();
  if (!root) {
    vscode.window.showWarningMessage('Claude Sessions: open a folder first.');
    return;
  }
  const sessions = listSessions(root);
  if (!sessions.length) {
    vscode.window.showInformationMessage('Claude Sessions: no sessions on disk for this workspace.');
    return;
  }
  const pick = await vscode.window.showQuickPick(
    sessions.map((s) => ({
      label: s.title,
      description: `${ago(s.mtime)} · ${s.id.slice(0, 8)}`,
      id: s.id,
    })),
    { placeHolder: 'Reopen a Claude session (all on-disk sessions, including hidden ones)' }
  );
  if (pick) await openSession(pick.id);
}

async function restoreRecent(announce) {
  const root = workspaceRoot();
  if (!root) return;
  const blank = claudeTabs();
  const max = vscode.workspace.getConfiguration('claudeSessions').get('autoReopenMax') || 3;
  // Reattach one session per restored blank tab (capped), most recent first.
  // Manual invocations with no blank tabs still reopen the single latest session.
  const want = blank.length ? Math.min(blank.length, max) : announce ? 1 : 0;
  if (!want) return;
  const sessions = listSessions(root).slice(0, want);
  if (!sessions.length) {
    if (announce) vscode.window.showInformationMessage('Claude Sessions: nothing to restore for this workspace.');
    return;
  }
  log(`restore: ${blank.length} blank Claude tab(s), reattaching ${sessions.length} session(s)`);
  if (blank.length) {
    try { await vscode.window.tabGroups.close(blank); } catch { /* tabs may already be gone */ }
  }
  for (const s of sessions.reverse()) { // oldest first so the newest ends up focused
    log(`  reopen ${s.id.slice(0, 8)} "${s.title.slice(0, 50)}"`);
    try { await openSession(s.id); } catch (e) {
      vscode.window.showErrorMessage(`Claude Sessions: could not reopen ${s.id.slice(0, 8)}: ${e.message}`);
      return;
    }
  }
  vscode.window.setStatusBarMessage(
    `Claude Sessions: reattached ${sessions.length} session${sessions.length > 1 ? 's' : ''}`, 8000
  );
}

function activate(context) {
  channel = vscode.window.createOutputChannel('Claude Sessions');
  context.subscriptions.push(channel);
  const root = workspaceRoot();
  log(`activated — workspace: ${root || '(none)'}; ${root ? listSessions(root).length : 0} sessions on disk`);

  const statusItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 99);
  statusItem.command = 'claudeSessions.open';
  statusItem.text = '$(history) Claude Sessions';
  statusItem.tooltip = 'Open a Claude Code session from disk (includes sessions hidden from the built-in picker)';
  statusItem.show();
  context.subscriptions.push(statusItem);

  context.subscriptions.push(
    vscode.commands.registerCommand('claudeSessions.open', pickAndOpen),
    vscode.commands.registerCommand('claudeSessions.restoreRecent', () => restoreRecent(true))
  );

  if (vscode.workspace.getConfiguration('claudeSessions').get('autoReopen')) {
    // Let the workbench finish restoring tabs and the Claude extension activate
    // before swapping blank shells for real sessions.
    const timer = setTimeout(() => {
      restoreRecent(false).catch((e) => log(`auto-restore failed: ${e.message}`));
    }, 5000);
    context.subscriptions.push({ dispose: () => clearTimeout(timer) });
  }
}

function deactivate() {}

module.exports = { activate, deactivate, _internals: { flatten, listSessions, sessionTitle } };
