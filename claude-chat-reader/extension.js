// Claude Chat Reader — speak Claude Code replies aloud.
// Two ways to trigger (nothing is ever spoken until you do):
//   • FOLLOW toggle (status-bar button): once on, each NEW reply is spoken as it
//     arrives — queued so they never overlap, and history is never re-read.
//   • Read-latest-once / Read-from-session commands: one-shot.
// Prose only: code blocks, file paths, and tool-call noise are stripped. Speech
// uses Piper (natural neural voice) when available, else spd-say.
const vscode = require('vscode');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawn, execFile } = require('child_process');

const PROJECTS_DIR = path.join(os.homedir(), '.claude', 'projects');
const DEBOUNCE_MS = 1500;   // quiet window after a transcript write before reading the new chunk

// CLI cwd -> transcript dir name (/home/a/x_y/.claude -> -home-a-x-y--claude).
function flatten(p) {
  return p.replace(/[^A-Za-z0-9]/g, '-');
}

function workspaceRoot() {
  const ws = vscode.workspace.workspaceFolders;
  return ws && ws.length ? ws[0].uri.fsPath : null;
}

function projectDir(cwd) {
  return path.join(PROJECTS_DIR, flatten(cwd));
}

// List transcripts for a workspace, newest first: {id, file, mtime}.
function listSessions(cwd) {
  let files;
  try { files = fs.readdirSync(projectDir(cwd)).filter((f) => f.endsWith('.jsonl')); }
  catch { return []; }
  const out = [];
  for (const f of files) {
    const full = path.join(projectDir(cwd), f);
    try {
      const st = fs.statSync(full);
      out.push({ id: f.slice(0, -6), file: full, mtime: st.mtimeMs });
    } catch { /* skip */ }
  }
  out.sort((a, b) => b.mtime - a.mtime);
  return out;
}

// Assistant `text` blocks from one transcript line (ignores thinking + tool_use).
function assistantTextFromLine(line) {
  if (!line.trim()) return '';
  let obj;
  try { obj = JSON.parse(line); } catch { return ''; }
  if (obj.type !== 'assistant') return '';
  const c = obj.message && obj.message.content;
  if (typeof c === 'string') return c;
  if (Array.isArray(c)) return c.filter((b) => b && b.type === 'text' && b.text).map((b) => b.text).join('\n');
  return '';
}

// The last assistant turn's spoken text (for the one-shot command).
function latestReplyText(file) {
  let lines;
  try { lines = fs.readFileSync(file, 'utf8').split('\n'); }
  catch { return null; }
  for (let i = lines.length - 1; i >= 0; i--) {
    const t = assistantTextFromLine(lines[i]);
    if (t.trim()) return t;
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

function expand(p) {
  return p && p.startsWith('~') ? path.join(os.homedir(), p.slice(1)) : p;
}

// Resolve Piper binary + voice model (with sample rate), or null if unavailable.
function resolvePiper(cfg) {
  const bin = expand((cfg.get('piperPath') || '~/.local/bin/piper').trim());
  const model = expand((cfg.get('piperModel') || '~/.local/share/piper-voices/en_US-lessac-medium.onnx').trim());
  if (!fs.existsSync(bin) || !fs.existsSync(model)) return null;
  let rate = 22050;
  try { rate = JSON.parse(fs.readFileSync(model + '.json', 'utf8')).audio.sample_rate || 22050; } catch { /* default */ }
  return { bin, model, rate };
}

// ── Speech engine: a single queue drives all playback so replies never overlap ──
const player = {
  procs: [],          // live child processes for the current utterance
  queue: [],          // pending prose strings
  onIdle: () => {},   // called when the queue drains

  enqueue(text) { if (text) { this.queue.push(text); this.pump(); } },

  pump() {
    if (this.procs.length) return;            // already speaking
    const text = this.queue.shift();
    if (text === undefined) { this.onIdle(); return; }
    this.start(text, () => this.pump());
  },

  start(text, done) {
    const cfg = vscode.workspace.getConfiguration('claudeChatReader');
    const engine = cfg.get('engine') || 'auto';
    const piper = engine === 'spd-say' ? null : resolvePiper(cfg);
    if (piper) return this.startPiper(text, piper, done);
    if (engine === 'piper') {
      vscode.window.showErrorMessage('Claude Chat Reader: Piper binary/model not found (check piperPath/piperModel or set engine to "auto").');
      done(); return;
    }
    this.startSpd(text, cfg, done);
  },

  startPiper(text, piper, done) {
    let aplay, synth;
    try {
      aplay = spawn('aplay', ['-q', '-r', String(piper.rate), '-f', 'S16_LE', '-t', 'raw', '-c', '1', '-']);
      synth = spawn(piper.bin, ['-m', piper.model, '--output-raw']);
    } catch (e) {
      vscode.window.showErrorMessage(`Claude Chat Reader: could not start Piper (${e.message}).`);
      done(); return;
    }
    this.procs = [synth, aplay];
    synth.stdout.pipe(aplay.stdin);
    synth.stdin.on('error', () => {});
    synth.stdin.write(text); synth.stdin.end();
    const finish = () => { if (this.procs.length) { this.killProcs(); done(); } };
    synth.on('error', finish);
    aplay.on('error', finish);
    aplay.on('close', finish);
  },

  startSpd(text, cfg, done) {
    const args = ['-w', '-r', String(cfg.get('rate') ?? 10)];
    const voice = (cfg.get('voice') || '').trim();
    if (voice) args.push('-t', voice);
    args.push('--', text);
    let child;
    try { child = spawn('spd-say', args); }
    catch (e) { vscode.window.showErrorMessage(`Claude Chat Reader: spd-say failed (${e.message}).`); done(); return; }
    this.procs = [child];
    const finish = () => { if (this.procs.length) { this.procs = []; done(); } };
    child.on('error', finish);
    child.on('close', finish);
  },

  killProcs() {
    for (const p of this.procs) { try { p.kill('SIGTERM'); } catch { /* gone */ } }
    this.procs = [];
  },

  // Stop the current utterance AND clear anything queued.
  stopAll() {
    this.queue = [];
    this.killProcs();
    try { execFile('spd-say', ['-C']); } catch { /* ignore */ }
  },

  busy() { return this.procs.length > 0 || this.queue.length > 0; },
};

// ── Follow mode: tail the followed transcript and enqueue each new reply ──
const follow = {
  on: false,
  file: null,
  offset: 0,           // byte position already consumed
  dir: null,
  watcher: null,
  timer: null,

  startFor(session) {
    this.file = session.file;
    this.dir = path.dirname(session.file);
    try { this.offset = fs.statSync(this.file).size; } catch { this.offset = 0; }  // skip history
    try {
      this.watcher = fs.watch(this.dir, (_e, name) => {
        if (name && name !== path.basename(this.file)) return;
        clearTimeout(this.timer);
        this.timer = setTimeout(() => this.readNew(), DEBOUNCE_MS);
      });
    } catch { this.watcher = null; }
    this.on = true;
  },

  stop() {
    this.on = false;
    clearTimeout(this.timer); this.timer = null;
    if (this.watcher) { try { this.watcher.close(); } catch { /* ignore */ } this.watcher = null; }
    this.file = null; this.offset = 0;
  },

  // Read complete lines appended since last offset; enqueue their prose.
  readNew() {
    if (!this.on || !this.file) return;
    let size;
    try { size = fs.statSync(this.file).size; } catch { return; }
    if (size < this.offset) this.offset = 0;   // truncated/rotated
    if (size === this.offset) return;
    let chunk;
    try {
      const fd = fs.openSync(this.file, 'r');
      const buf = Buffer.alloc(size - this.offset);
      fs.readSync(fd, buf, 0, buf.length, this.offset);
      fs.closeSync(fd);
      chunk = buf.toString('utf8');
    } catch { return; }
    const lastNl = chunk.lastIndexOf('\n');
    if (lastNl < 0) return;                    // no complete line yet
    const complete = chunk.slice(0, lastNl);
    this.offset += Buffer.byteLength(complete, 'utf8') + 1;   // +1 for the newline
    const texts = [];
    for (const line of complete.split('\n')) {
      const t = assistantTextFromLine(line);
      if (t.trim()) texts.push(t);
    }
    if (texts.length) {
      const prose = toProse(texts.join('\n'));
      if (prose) player.enqueue(prose);
    }
  },
};

let statusItem;
function updateStatus() {
  if (follow.on) {
    statusItem.text = player.busy() ? '$(broadcast) Reading live…' : '$(broadcast) Reading live';
    statusItem.tooltip = 'Following this session — each new reply is read aloud. Click to stop.';
    statusItem.command = 'claudeChatReader.stopFollow';
    statusItem.backgroundColor = new vscode.ThemeColor('statusBarItem.warningBackground');
  } else {
    statusItem.text = '$(unmute) Read: off';
    statusItem.tooltip = 'Click to follow this session and read each new reply aloud.';
    statusItem.command = 'claudeChatReader.follow';
    statusItem.backgroundColor = undefined;
  }
}

function readSessionOnce(session) {
  const raw = session && latestReplyText(session.file);
  if (!raw) { vscode.window.showInformationMessage('Claude Chat Reader: no assistant reply found in that session.'); return; }
  const prose = toProse(raw);
  if (!prose) { vscode.window.showInformationMessage('Claude Chat Reader: that reply was all code/tool output — nothing to read.'); return; }
  player.enqueue(prose);
}

function activate(context) {
  statusItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 98);
  player.onIdle = updateStatus;
  updateStatus();
  statusItem.show();
  context.subscriptions.push(statusItem, { dispose: () => { follow.stop(); player.stopAll(); } });

  const sessionsOrWarn = () => {
    const root = workspaceRoot();
    if (!root) { vscode.window.showWarningMessage('Claude Chat Reader: open a folder first.'); return null; }
    const s = listSessions(root);
    if (!s.length) { vscode.window.showInformationMessage('Claude Chat Reader: no sessions on disk for this workspace.'); return null; }
    return s;
  };

  context.subscriptions.push(
    // FOLLOW: start reading new replies of the most-recent session (or toggle off if already on).
    vscode.commands.registerCommand('claudeChatReader.follow', () => {
      if (follow.on) { follow.stop(); player.stopAll(); updateStatus(); return; }
      const s = sessionsOrWarn(); if (!s) return;
      follow.startFor(s[0]);
      updateStatus();
      vscode.window.setStatusBarMessage(`Claude Chat Reader: following ${s[0].id.slice(0, 8)} — new replies will be read aloud.`, 5000);
    }),
    vscode.commands.registerCommand('claudeChatReader.stopFollow', () => {
      follow.stop(); player.stopAll(); updateStatus();
    }),
    // ONE-SHOT: read the latest reply once.
    vscode.commands.registerCommand('claudeChatReader.readLatest', () => {
      const s = sessionsOrWarn(); if (!s) return;
      readSessionOnce(s[0]); updateStatus();
    }),
    vscode.commands.registerCommand('claudeChatReader.readFrom', async () => {
      const s = sessionsOrWarn(); if (!s) return;
      const pick = await vscode.window.showQuickPick(
        s.map((x) => ({ label: x.id.slice(0, 8), description: new Date(x.mtime).toLocaleString(), s: x })),
        { placeHolder: 'Read the latest reply from which session?' });
      if (pick) { readSessionOnce(pick.s); updateStatus(); }
    }),
    // STOP: stop speaking (and clear the queue). Leaves follow mode as-is.
    vscode.commands.registerCommand('claudeChatReader.stop', () => { player.stopAll(); updateStatus(); }),
  );

  // Reflect speaking/idle transitions in the status bar even mid-queue.
  const tick = setInterval(updateStatus, 1000);
  context.subscriptions.push({ dispose: () => clearInterval(tick) });
}

function deactivate() { follow.stop(); player.stopAll(); }

module.exports = { activate, deactivate, _internals: { flatten, latestReplyText, toProse, listSessions, assistantTextFromLine, follow, player } };
