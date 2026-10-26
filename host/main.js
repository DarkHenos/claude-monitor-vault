// Runs this VS Code extension, unchanged, inside another IDE.
//
// The IDE (the IntelliJ plugin in ../intellij) starts `node host/main.js` and
// talks to it over stdin/stdout. require('vscode') is redirected to
// vscode-shim.js, which turns every call that needs a screen into a request to
// the IDE. extension.js, companion/ and vault/ are the very files VS Code runs:
// a fix made there reaches both IDEs, and nothing here duplicates their logic.
//
// stdout belongs to the protocol. Anything else printing there would corrupt
// it, so console output and stray writes are sent to stderr, which the IDE
// keeps in its log.

'use strict';

const Module = require('module');
const path = require('path');
const util = require('util');

const protocolWrite = process.stdout.write.bind(process.stdout);
const toStderr = (...a) => { process.stderr.write(util.format(...a) + '\n'); };
console.log = console.info = console.debug = console.warn = console.error = toStderr;
process.stdout.write = (chunk, enc, cb) => process.stderr.write(chunk, enc, cb);

const SHIM = path.join(__dirname, 'vscode-shim.js');
const resolve = Module._resolveFilename;
Module._resolveFilename = function (request, ...rest) {
  if (request === 'vscode') return SHIM;
  return resolve.call(this, request, ...rest);
};

process.on('uncaughtException', e => toStderr('[host] uncaught:', e));
process.on('unhandledRejection', e => toStderr('[host] unhandled rejection:', e));

const ROOT = path.join(__dirname, '..');
const rpc = require('./rpc.js').create(process.stdin, s => protocolWrite(s));
const vscode = require(SHIM);
const host = vscode.__host;
const pkg = require(path.join(ROOT, 'package.json'));

let extension = null;
let context = null;
let stopping = false;

function buildContext(params) {
  const fs = require('fs');
  const crypto = require('crypto');
  const storage = params.storagePath;
  const globalStorage = path.join(storage, 'globalStorage');
  const project = (params.workspaceFolders || [])[0] || '';
  const workspaceStorage = path.join(storage, 'workspaceStorage',
    crypto.createHash('sha1').update(project.toLowerCase()).digest('hex').slice(0, 16));
  fs.mkdirSync(globalStorage, { recursive: true });
  fs.mkdirSync(workspaceStorage, { recursive: true });
  const id = pkg.publisher + '.' + pkg.name;
  return {
    subscriptions: [],
    extensionPath: ROOT,
    extensionUri: vscode.Uri.file(ROOT),
    globalStorageUri: vscode.Uri.file(globalStorage),
    globalStoragePath: globalStorage,
    storageUri: vscode.Uri.file(workspaceStorage),
    storagePath: workspaceStorage,
    logUri: vscode.Uri.file(path.join(storage, 'logs')),
    logPath: path.join(storage, 'logs'),
    globalState: new host.Memento(path.join(storage, 'globalState.json')),
    workspaceState: new host.Memento(path.join(workspaceStorage, 'workspaceState.json')),
    secrets: {
      get: () => Promise.resolve(undefined),
      store: () => Promise.resolve(),
      delete: () => Promise.resolve(),
      onDidChange: new vscode.EventEmitter().event
    },
    environmentVariableCollection: {
      persistent: false, replace() {}, append() {}, prepend() {}, get() {}, forEach() {}, delete() {}, clear() {}
    },
    extensionMode: vscode.ExtensionMode.Production,
    extension: { id, packageJSON: pkg, extensionPath: ROOT, extensionUri: vscode.Uri.file(ROOT), isActive: true },
    asAbsolutePath: p => path.join(ROOT, p)
  };
}

// Results travel back as JSON: a command returning an object with methods
// would otherwise fail the response.
function plain(value) {
  if (value === undefined) return null;
  try { return JSON.parse(JSON.stringify(value)); } catch (e) { return null; }
}

rpc.onRequest('initialize', async params => {
  if (extension) throw new Error('already initialized');
  host.init(rpc, params || {}, ROOT);
  context = buildContext(params || {});
  extension = require(path.join(ROOT, 'extension.js'));
  extension.activate(context);
  return { version: pkg.version, id: pkg.publisher + '.' + pkg.name, node: process.version };
});

rpc.onRequest('command.execute', async p => {
  const args = Array.isArray(p && p.args) ? p.args : [];
  return plain(await vscode.commands.executeCommand(p.command, ...args));
});

// Same order as VS Code: the extension's subscriptions are disposed last
// registered first, then deactivate(). The vault removes its session keys in
// one of those disposals, so a clean shutdown matters.
function stop() {
  if (stopping) return;
  stopping = true;
  if (context) {
    for (const d of context.subscriptions.slice().reverse()) {
      try { if (d && typeof d.dispose === 'function') d.dispose(); } catch (e) { toStderr('[host] dispose failed:', e); }
    }
  }
  try { if (extension && extension.deactivate) extension.deactivate(); } catch (e) { toStderr('[host] deactivate failed:', e); }
  host.dispose();
}

rpc.onRequest('shutdown', async () => {
  stop();
  setTimeout(() => process.exit(0), 20);
  return true;
});

// The IDE closed the pipe without a shutdown (crash, killed): clean up anyway.
rpc.onClose(() => { stop(); process.exit(0); });
