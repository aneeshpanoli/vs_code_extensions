// Claude Chat Reader — speak Claude's latest reply aloud, ON DEMAND ONLY.
// Never speaks on its own: a status-bar button and commands are the only triggers.
// Reads the assistant message from the session transcript, strips code/paths/tool
// noise, and pipes the prose to spd-say (speech-dispatcher).
const vscode = require('vscode');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawn, execFile } = require('child_process');

const PROJECTS_DIR = path.join(os.homedir(), '.claude', 'projects');

// CLI cwd -> transcript dir name (/home/a/x_y/.claude -> -home-a-x-y--claude).
function flatten(p) {
  return p.replace(/[^A-Za-z0-9]/g, '-');
}

function workspaceRoot() {
  const ws = vscode.workspace.workspaceFolders;
  return ws && ws.length ? ws[0].uri.fsPath : null;
}

// List transcripts for a workspace, newest first: {id, file, mtime, title}.
function listSessions(cwd) {
  const dir = path.join(PROJECTS_DIR, flatten(cwd));
  let files;
  try { files = fs.readdirSync(dir).filter((f) => f.endsWith('.jsonl')); }
  catch { return []; }
  const out = [];
  for (const f of files) {
    const full = path.join(dir, f);
    try {
      const st = fs.statSync(full);
      out.push({ id: f.slice(0, -6), file: full, mtime: st.mtimeMs });
    } catch { /* skip */ }
  }
  out.sort((a, b) => b.mtime - a.mtime);
  return out;
}

// The last assistant turn's spoken text from a transcript. Concatenates the
// `text` blocks of the final assistant message (ignores thinking + tool_use).
function latestReplyText(file) {
  let lines;
  try { lines = fs.readFileSync(file, 'utf8').split('\n'); }
  catch { return null; }
  for (let i = lines.length - 1; i >= 0; i--) {
    if (!lines[i].trim()) continue;
    let obj;
    try { obj = JSON.parse(lines[i]); } catch { continue; }
    if (obj.type !== 'assistant') continue;
    const c = obj.message && obj.message.content;
    let text = '';
    if (typeof c === 'string') text = c;
    else if (Array.isArray(c)) {
      text = c.filter((b) => b && b.type === 'text' && b.text).map((b) => b.text).join('\n');
    }
    if (text.trim()) return text;
  }
  return null;
}

// Reduce markdown/agent output to speakable prose. Drops code, paths, tool noise.
function toProse(md) {
  let t = md;
  t = t.replace(/```[\s\S]*?```/g, ' . ');          // fenced code blocks
  t = t.replace(/`[^`]*`/g, ' ');                    // inline code
  t = t.replace(/^\s{0,3}#{1,6}\s+/gm, '');          // heading markers
  t = t.replace(/!\[[^\]]*\]\([^)]*\)/g, ' ');       // images
  t = t.replace(/\[([^\]]+)\]\([^)]*\)/g, '$1');     // links -> link text
  t = t.replace(/https?:\/\/\S+/g, ' ');             // bare URLs
  t = t.replace(/~?\/?[\w.-]+\/[\w./-]+/g, ' ');     // file paths (a/b/c)
  t = t.replace(/^\s*[-*+]\s+/gm, '');               // bullet markers
  t = t.replace(/^\s*\d+\.\s+/gm, '');               // numbered list markers
  t = t.replace(/[*_~>#|]+/g, ' ');                  // stray md punctuation
  t = t.replace(/[ \t]+/g, ' ');
  t = t.replace(/\n{2,}/g, '. ').replace(/\n/g, ' ');
  t = t.replace(/\s+([.,;:!?])/g, '$1').replace(/\.\s*\.(\s*\.)*/g, '.');
  return t.trim();
}

let current = null; // the active spd-say child, if any

function stopSpeaking() {
  if (current) { try { current.kill(); } catch { /* gone */ } current = null; }
  // also cancel anything queued in speech-dispatcher
  try { execFile('spd-say', ['-C']); } catch { /* ignore */ }
}

function speak(text, statusItem) {
  stopSpeaking();
  const cfg = vscode.workspace.getConfiguration('claudeChatReader');
  const args = ['-w', '-r', String(cfg.get('rate') ?? 10)];
  const voice = (cfg.get('voice') || '').trim();
  if (voice) args.push('-t', voice);
  args.push('--', text);
  let child;
  try { child = spawn('spd-say', args); }
  catch (e) { vscode.window.showErrorMessage(`Claude Chat Reader: spd-say failed to start (${e.message}).`); return; }
  current = child;
  setSpeaking(statusItem, true);
  child.on('error', (e) => {
    vscode.window.showErrorMessage(`Claude Chat Reader: spd-say error (${e.message}). Is speech-dispatcher installed?`);
    if (current === child) { current = null; setSpeaking(statusItem, false); }
  });
  child.on('close', () => { if (current === child) { current = null; setSpeaking(statusItem, false); } });
}

function setSpeaking(statusItem, on) {
  statusItem.text = on ? '$(mute) Reading…' : '$(unmute) Read reply';
  statusItem.tooltip = on
    ? 'Claude Chat Reader is speaking — click to stop.'
    : "Read Claude's latest reply aloud (prose only).";
  statusItem.command = on ? 'claudeChatReader.stop' : 'claudeChatReader.readLatest';
}

function readSession(session, statusItem) {
  const raw = session && latestReplyText(session.file);
  if (!raw) { vscode.window.showInformationMessage('Claude Chat Reader: no assistant reply found in that session.'); return; }
  const prose = toProse(raw);
  if (!prose) { vscode.window.showInformationMessage('Claude Chat Reader: that reply was all code/tool output — nothing to read.'); return; }
  speak(prose, statusItem);
}

function activate(context) {
  const statusItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 98);
  setSpeaking(statusItem, false);
  statusItem.show();
  context.subscriptions.push(statusItem);

  context.subscriptions.push(
    vscode.commands.registerCommand('claudeChatReader.readLatest', () => {
      const root = workspaceRoot();
      if (!root) { vscode.window.showWarningMessage('Claude Chat Reader: open a folder first.'); return; }
      const sessions = listSessions(root);
      if (!sessions.length) { vscode.window.showInformationMessage('Claude Chat Reader: no sessions on disk for this workspace.'); return; }
      readSession(sessions[0], statusItem);
    }),
    vscode.commands.registerCommand('claudeChatReader.readFrom', async () => {
      const root = workspaceRoot();
      if (!root) { vscode.window.showWarningMessage('Claude Chat Reader: open a folder first.'); return; }
      const sessions = listSessions(root);
      if (!sessions.length) { vscode.window.showInformationMessage('Claude Chat Reader: no sessions on disk for this workspace.'); return; }
      const pick = await vscode.window.showQuickPick(
        sessions.map((s) => ({ label: s.id.slice(0, 8), description: new Date(s.mtime).toLocaleString(), s })),
        { placeHolder: 'Read the latest reply from which session?' });
      if (pick) readSession(pick.s, statusItem);
    }),
    vscode.commands.registerCommand('claudeChatReader.stop', () => { stopSpeaking(); setSpeaking(statusItem, false); })
  );
}

function deactivate() { stopSpeaking(); }

module.exports = { activate, deactivate, _internals: { flatten, latestReplyText, toProse, listSessions } };
