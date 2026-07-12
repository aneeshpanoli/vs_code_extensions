// Claude Session Manager — SIDEBAR ONLY.
// Lists every Claude Code session transcript on disk for the current workspace
// (including sessions hidden from the built-in picker). Clicking an entry
// reopens it via the Claude extension's own open command.
// This extension NEVER opens or closes anything on its own.
const vscode = require('vscode');
const fs = require('fs');
const path = require('path');
const os = require('os');

const PROJECTS_DIR = path.join(os.homedir(), '.claude', 'projects');

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
      return { title: obj.summary };
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
  if (!hasUser) return null; // empty shell session — not worth listing
  return { title: firstUser || '(no title)' };
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
    if (!meta) continue;
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

function ago(ms) {
  const s = Math.round((Date.now() - ms) / 1000);
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.round(s / 60)}m ago`;
  if (s < 86400) return `${Math.round(s / 3600)}h ago`;
  return `${Math.round(s / 86400)}d ago`;
}

class SessionsProvider {
  constructor() {
    this._emitter = new vscode.EventEmitter();
    this.onDidChangeTreeData = this._emitter.event;
  }
  refresh() { this._emitter.fire(undefined); }
  getTreeItem(el) { return el; }
  getChildren() {
    const root = workspaceRoot();
    if (!root) return [];
    return listSessions(root).map((s) => {
      const item = new vscode.TreeItem(s.title, vscode.TreeItemCollapsibleState.None);
      item.description = ago(s.mtime);
      item.tooltip = `${s.title}\n${s.id}\nClick to open this session`;
      item.iconPath = new vscode.ThemeIcon('comment-discussion');
      item.command = { command: 'claudeSessions.openById', title: 'Open', arguments: [s.id] };
      return item;
    });
  }
}

function activate(context) {
  const provider = new SessionsProvider();
  context.subscriptions.push(
    vscode.window.registerTreeDataProvider('claudeSessionsList', provider),
    vscode.commands.registerCommand('claudeSessions.refresh', () => provider.refresh()),
    vscode.commands.registerCommand('claudeSessions.openById', (id) =>
      // The Claude extension's own open command; first arg is the sessionId.
      vscode.commands.executeCommand('claude-vscode.editor.open', id, undefined, undefined)
    )
  );

  // Keep the sidebar current as transcripts change.
  const root = workspaceRoot();
  if (root) {
    try {
      const watcher = fs.watch(path.join(PROJECTS_DIR, flatten(root)), () => provider.refresh());
      context.subscriptions.push({ dispose: () => watcher.close() });
    } catch { /* transcript dir may not exist yet; the refresh button still works */ }
  }
}

function deactivate() {}

module.exports = { activate, deactivate, _internals: { flatten, listSessions, sessionTitle } };
