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
  _reset() {
    this._messages = { info: [], warn: [], error: [] };
    this._executed = [];
    this._quickPick = undefined;
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
    showInformationMessage(m) { vscode._messages.info.push(String(m)); return Promise.resolve(undefined); },
    showWarningMessage(m) { vscode._messages.warn.push(String(m)); return Promise.resolve(undefined); },
    showErrorMessage(m) { vscode._messages.error.push(String(m)); return Promise.resolve(undefined); },
    showQuickPick(items) {
      const a = vscode._quickPick;
      return Promise.resolve(typeof a === "function" ? a(items) : a);
    },
    showInputBox() { return Promise.resolve(undefined); },
    createStatusBarItem: () => ({ show() {}, hide() {}, dispose() {} }),
    createOutputChannel: () => ({ appendLine() {}, dispose() {} }),
    registerTreeDataProvider: () => ({ dispose() {} }),
    setStatusBarMessage() {},
    tabGroups: { all: [], close: () => Promise.resolve(true) },
  },
  workspace: {
    workspaceFolders: undefined,
    getConfiguration: () => ({ get: (_k, d) => d, update: () => Promise.resolve() }),
    onDidChangeConfiguration: () => ({ dispose() {} }),
  },
  commands: {
    registerCommand: () => ({ dispose() {} }),
    executeCommand(id, ...args) { vscode._executed.push({ id, args }); return Promise.resolve(); },
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

module.exports = {
  vscode, suite, suites, ok, eq, match, rejects, AssertionError,
  LOOM, makeRepo, busPath, writeJson, readJson, setStatus, load, home,
};
