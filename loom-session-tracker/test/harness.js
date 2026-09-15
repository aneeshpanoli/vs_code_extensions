// harness.js — zero-dependency test harness for the Loom Session Tracker.
// There is no npm on this machine, so tests run under VSCodium's bundled node
// (ELECTRON_RUN_AS_NODE=1 codium test/run-tests.js) with no framework.
//
// SAFETY: every test writes to ~/.claude/loom, so the runner forces HOME to a
// throwaway directory and this module REFUSES to load if that didn't happen.
const fs = require("fs");
const os = require("os");
const path = require("path");
const Module = require("module");

const home = os.homedir();
if (!/^(\/tmp\/|\/var\/tmp\/)/.test(home) || !process.env.LOOM_TEST_SANDBOX) {
  console.error(`REFUSING TO RUN: HOME is ${home}, not a sandbox. Run via test/run-tests.js.`);
  process.exit(2);
}

// ── the vscode stub ─────────────────────────────────────────────────────────
// Mutable so a test can set workspace folders or read what the UI was told.
const vscode = {
  _messages: { info: [], warn: [], error: [] },
  _executed: [],
  _quickPick: undefined,            // set to a value (or fn) to answer showQuickPick
  _answer: undefined,               // set to a value (or fn) to answer showInformationMessage actions
  _warnAnswer: undefined,           // same, for showWarningMessage (destructive confirmations)
  _commands: {},                    // id -> handler, so a test can invoke what activate() registered
  _statusItems: [],
  _statusMessages: [],
  _trees: {},
  _config: {},                      // "section.key" -> value, overriding the caller's default
  _docs: [],                        // documents opened via openTextDocument
  _shownDocs: [],                   // …and the ones actually shown
  _reset() {
    this._messages = { info: [], warn: [], error: [] };
    this._executed = [];
    this._quickPick = undefined;
    this._answer = undefined;
    this._warnAnswer = undefined;
    this._commands = {};
    this._statusItems = [];
    this._statusMessages = [];
    this._trees = {};
    this._config = {};
    this._docs = [];
    this._shownDocs = [];
    this.workspace.workspaceFolders = undefined;
  },
  EventEmitter: class { constructor() { this.event = () => ({ dispose() {} }); } fire() {} },
  TreeItem: class { constructor(label, state) { this.label = label; this.collapsibleState = state; } },
  TreeItemCollapsibleState: { None: 0, Collapsed: 1, Expanded: 2 },
  ThemeIcon: class { constructor(id, color) { this.id = id; this.color = color; } },
  ThemeColor: class { constructor(id) { this.id = id; } },
  StatusBarAlignment: { Left: 1, Right: 2 },
  ConfigurationTarget: { Global: 1 },
  window: {
    showInformationMessage(m, ...rest) {
      vscode._messages.info.push(String(m));
      // Modal options come through as an object; actions are trailing strings.
      const actions = rest.filter((r) => typeof r === "string");
      const a = vscode._answer;
      return Promise.resolve(typeof a === "function" ? a(String(m), actions) : a);
    },
    showWarningMessage(m, ...rest) {
      vscode._messages.warn.push(String(m));
      const actions = rest.filter((r) => typeof r === "string");
      const a = vscode._warnAnswer;
      return Promise.resolve(typeof a === "function" ? a(String(m), actions) : a);
    },
    showErrorMessage(m) { vscode._messages.error.push(String(m)); return Promise.resolve(undefined); },
    showQuickPick(items) {
      const a = vscode._quickPick;
      return Promise.resolve(typeof a === "function" ? a(items) : a);
    },
    showInputBox() { return Promise.resolve(undefined); },
    createStatusBarItem() {
      const item = { text: "", tooltip: "", command: undefined, backgroundColor: undefined,
                     shown: false, show() { this.shown = true; }, hide() { this.shown = false; }, dispose() {} };
      vscode._statusItems.push(item);
      return item;
    },
    createOutputChannel: () => ({ appendLine() {}, dispose() {} }),
    registerTreeDataProvider(id, provider) { vscode._trees[id] = provider; return { dispose() {} }; },
    setStatusBarMessage(m) { vscode._statusMessages.push(String(m)); },
    tabGroups: { all: [], close: () => Promise.resolve(true) },
    // WL-001 R3 opens its report as a markdown DOCUMENT; record what was shown so a test can read it.
    showTextDocument(doc) { vscode._shownDocs.push(doc); return Promise.resolve({ document: doc }); },
  },
  workspace: {
    workspaceFolders: undefined,
    openTextDocument(opts) {
      const doc = { languageId: (opts && opts.language) || "plaintext",
                    content: (opts && opts.content) || "",
                    getText() { return this.content; } };
      vscode._docs.push(doc);
      return Promise.resolve(doc);
    },
    getConfiguration(section) {
      return {
        get(k, d) {
          const key = section ? section + "." + k : k;
          return Object.prototype.hasOwnProperty.call(vscode._config, key) ? vscode._config[key] : d;
        },
        update: () => Promise.resolve(),
      };
    },
    onDidChangeConfiguration: () => ({ dispose() {} }),
  },
  commands: {
    registerCommand(id, fn) { vscode._commands[id] = fn; return { dispose() {} }; },
    executeCommand(id, ...args) {
      vscode._executed.push({ id, args });
      // let a test drive the extension's own commands through executeCommand too
      const own = vscode._commands[id];
      return Promise.resolve(own ? own(...args) : undefined);
    },
  },
};
const origLoad = Module._load;
Module._load = function (request, ...rest) {
  if (request === "vscode") return vscode;
  return origLoad.call(this, request, ...rest);
};

// ── assertions ──────────────────────────────────────────────────────────────
class AssertionError extends Error {}
function ok(cond, msg) { if (!cond) throw new AssertionError(msg || "expected truthy"); }
function eq(actual, expected, msg) {
  const a = JSON.stringify(actual), e = JSON.stringify(expected);
  if (a !== e) throw new AssertionError(`${msg || "not equal"}\n      actual:   ${a}\n      expected: ${e}`);
}
function match(str, re, msg) {
  if (!re.test(String(str))) throw new AssertionError(`${msg || "no match"}: ${JSON.stringify(String(str))} !~ ${re}`);
}
async function rejects(fn, re, msg) {
  try { await fn(); } catch (e) { if (re && !re.test(String(e.message || e))) throw new AssertionError(`${msg || "wrong rejection"}: ${e.message}`); return; }
  throw new AssertionError(msg || "expected a rejection, got none");
}

// ── suite registry ──────────────────────────────────────────────────────────
const suites = [];
function suite(name, fn) { suites.push({ name, fn }); }

// ── bus fixtures (all under the sandbox HOME) ───────────────────────────────
const LOOM = path.join(home, ".claude", "loom");
let seq = 0;
/** A fresh, uniquely-named project bus. Returns its repo id. */
function makeRepo(board, name) {   // name: fixed repo id when a test needs one
  const repo = name || `t${++seq}_${Date.now().toString(36)}`;
  fs.mkdirSync(path.join(LOOM, repo), { recursive: true });
  if (board) fs.writeFileSync(path.join(LOOM, repo, "board.json"), JSON.stringify(board, null, 2));
  return repo;
}
function busPath(repo, ...rest) { return path.join(LOOM, repo, ...rest); }
function writeJson(file, obj) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(obj, null, 2));
}
function readJson(file) { try { return JSON.parse(fs.readFileSync(file, "utf8")); } catch { return null; } }
/** Set a role's status.json on the bus. */
function setStatus(repo, role, status) { writeJson(busPath(repo, role, "status.json"), status); }

/** Require a compiled module from out/. */
function load(name) { return require(path.join(__dirname, "..", "out", name)); }

/** Let queued promises and immediates settle (activation kicks off an async first tick). */
const settle = (ms = 30) => new Promise((r) => setTimeout(r, ms));

// ── FX-002 · every fixture directory has an owner that deletes it ─────────────────────────────
//
// MEASURED 2026-09-15: 15 helpers called `fs.mkdtempSync(os.tmpdir(), "loom-…")` and nothing ever
// removed the result. Six days of runs left 892,449 directories in /tmp holding 12,201,926 inodes —
// 97.6% of the whole filesystem — and the host hit 100% of its inode table with 74 GB of disk free,
// so no space check on this box could see it. It killed a mutation gate mid-run.
//
// `fixtureDir()` replaces the bare mkdtemp: same call, same place, but the directory is REGISTERED,
// and the runner sweeps the registry after every suite — passing or throwing. The owner is the
// runner, not the test, which is what makes it exception-safe: a suite that throws halfway still
// gives its fixture back. Nothing about the helpers themselves changes.
const fixtures = [];

/** A throwaway directory that WILL be removed after the suite that made it. */
function fixtureDir(prefix) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  fixtures.push(dir);
  return dir;
}

/** Remove every fixture registered since the last sweep. BEST EFFORT BY DESIGN: a removal that
 *  fails must never turn a green test red — the leak is a hygiene problem, not a correctness one,
 *  and a teardown that can fail a suite would be a worse bug than the one it fixes. */
function sweepFixtures() {
  while (fixtures.length) {
    const dir = fixtures.pop();
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* best effort, never fatal */ }
  }
}

/** For the leak test: how many `loom-*` entries the temp root holds right now. */
function tmpFixtureCount() {
  try { return fs.readdirSync(os.tmpdir()).filter((n) => n.startsWith("loom-")).length; }
  catch { return 0; }
}

module.exports = {
  vscode, suite, suites, ok, eq, match, rejects, AssertionError,
  LOOM, makeRepo, busPath, writeJson, readJson, setStatus, load, home, settle,
  fixtureDir, sweepFixtures, tmpFixtureCount,
};
