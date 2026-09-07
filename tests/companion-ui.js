'use strict';
const assert = require('assert/strict');
const fs = require('fs');
const path = require('path');
const os = require('os');
const Module = require('module');
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'companion-ui-'));
const root = path.join(temp, 'project'); fs.mkdirSync(root);
const commands = new Map(), state = new Map(), terminals = [], errors = [], views = [];
const shown = [];
let choices = [], accept = true, diffs = 0;
const disposable = () => ({ dispose() {} });
const config = { codexAutoSetup: false, codexMonitor: false, syncOnSwitch: true, claudeExecutable: process.execPath, codexExecutable: process.execPath };
state.set('agentBridge:' + root, {provider:'claude',model:''});
const uri = value => ({ fsPath: value, scheme: value.startsWith('agent-bridge-preview:') ? 'agent-bridge-preview' : 'file', toString: () => value });
const mock = {
  EventEmitter: class { constructor() { this.event = () => disposable(); } fire() {} dispose() {} },
  TreeItem: class { constructor(label) { this.label = label; } }, ThemeIcon: class {},
  Uri: { file: uri, parse: uri }, ConfigurationTarget: { Global: 1 }, ProgressLocation: { Notification: 1 },
  commands: { registerCommand: (name, fn) => { commands.set(name, fn); return disposable(); }, executeCommand: async name => { if (name === 'vscode.diff') diffs++; } },
  workspace: {
    isTrusted: true, workspaceFolders: [{ name: 'project', uri: uri(root) }], textDocuments: [],
    getConfiguration: () => ({ get: (key, fallback) => config[key] ?? fallback, update: async (key, value) => { config[key] = value; } }),
    registerTextDocumentContentProvider: disposable, onDidChangeConfiguration: disposable,
    onDidGrantWorkspaceTrust: disposable, onDidChangeWorkspaceFolders: disposable,
    openTextDocument: async value => value
  },
  window: {
    state: { focused: true }, createTreeView: (id, options) => { views.push(options.treeDataProvider); return disposable(); },
    showQuickPick: async items => { const choice = choices.shift(); return items.find(i => i.value === choice); },
    showInformationMessage: async (_text, _options, action) => accept ? action : undefined,
    showErrorMessage: text => errors.push(text), showWarningMessage: () => {},
    showTextDocument: async doc => { shown.push(doc); }, withProgress: async (_options, fn) => fn(),
    createTerminal: options => { terminals.push(options); return { show() {} }; }
  }
};
let quotaReads = 0;
class FakeCodex { async usage() { quotaReads++; return {}; } async models() { return [{ model: 'available-model', displayName: 'Available model' }]; } dispose() {} }
const original = Module._load;
Module._load = function (name) {
  if (name === 'vscode') return mock;
  if (name === './codex') return { CodexClient: FakeCodex, quotaRows: () => [] };
  return original.apply(this, arguments);
};
const ui = require('../companion/ui'); Module._load = original;
const context = { subscriptions: [], extensionPath: path.resolve(__dirname, '..'),
  globalStorageUri: uri(path.join(temp, 'storage')), workspaceState: {
    get: (key, fallback) => state.has(key) ? state.get(key) : fallback,
    update: async (key, value) => { if (value === undefined) state.delete(key); else state.set(key, value); }
  } };
(async () => {
  const service = ui.activate(context);
  assert.equal(views.length, 0); assert.ok(commands.has('agentBridge.switch'));
  assert.deepEqual(service.snapshot().providers, ['claude']);
  console.log('PASS compact panel service and commands register without extra views');
  await service.setDisplay('both');
  assert.deepEqual(service.snapshot().providers, ['claude', 'codex']);
  assert.equal(quotaReads, 1);
  await service.setDisplay('claude');
  assert.equal(quotaReads, 1);
  await service.setDisplay('codex');
  assert.deepEqual(service.snapshot().providers, ['codex']);
  assert.equal(quotaReads, 2);
  await service.setDisplay('invalid');
  assert.equal(service.snapshot().mode, 'codex');
  await service.setDisplay('auto');
  assert.deepEqual(service.snapshot().providers, ['claude']);
  console.log('PASS selection activates quota reads automatically, supports both and rejects invalid modes');
  fs.writeFileSync(path.join(root, 'CLAUDE.md'), 'Run the project tests before delivery.\n');
  choices = ['codex', 'available-model', 'claude'];
  await commands.get('agentBridge.switch')();
  assert.equal(errors.length, 0, errors.join('\n'));
  assert.equal(terminals.length, 1); assert.equal(terminals[0].cwd, root);
  assert.deepEqual(terminals[0].shellArgs, ['--model', 'available-model']);
  assert.ok(fs.readFileSync(path.join(root, '.agent-bridge/MEMORY.md'), 'utf8').includes('Run the project tests'));
  assert.equal(diffs, 3);
  console.log('PASS switch imports Claude memory, previews files and launches selected Codex model');
  const previous = fs.readFileSync(path.join(root, '.agent-bridge/MEMORY.md'), 'utf8');
  fs.appendFileSync(path.join(root, 'CLAUDE.md'), '\nA new native instruction.');
  choices = ['claude']; accept = false;
  await commands.get('agentBridge.sync')();
  assert.equal(fs.readFileSync(path.join(root, '.agent-bridge/MEMORY.md'), 'utf8'), previous);
  console.log('PASS cancelling preview preserves shared memory');
  accept = true; mock.workspace.isTrusted = false;
  await commands.get('agentBridge.launch')();
  assert.equal(terminals.length, 1); assert.ok(errors.pop().includes('Trust'));
  console.log('PASS restricted workspace blocks assistant launch');
  mock.workspace.isTrusted = true;
  mock.workspace.textDocuments = [{ isDirty: true, uri: uri(path.join(root, '.agent-bridge/MEMORY.md')) }];
  choices = ['claude']; await commands.get('agentBridge.sync')();
  assert.ok(errors.pop().includes('Save'));
  assert.equal(fs.readFileSync(path.join(root, '.agent-bridge/MEMORY.md'), 'utf8'), previous);
  console.log('PASS unsaved memory prevents overwrites');
  mock.workspace.textDocuments = [];
  fs.appendFileSync(path.join(root, 'CLAUDE.md'), '\n[Feedback](feedback_style.md)');
  fs.writeFileSync(path.join(root, 'feedback_style.md'), 'Use French responses.');
  choices = ['claude']; await commands.get('agentBridge.sync')();
  assert.equal(errors.length, 0, errors.join('\n'));
  assert.ok(shown.some(doc => doc.content?.includes('Memory files: 2 (1 linked)') && doc.content.includes('feedback_style.md')));
  assert.equal(state.get('agentBridge.inventory:' + root).count, 2);
  assert.deepEqual(service.snapshot().providers, ['codex']);
  console.log('PASS linked-file inventory and unique count remain available after simplifying the panel');
  mock.workspace.textDocuments = [{ isDirty: true, uri: uri(path.join(root, 'feedback_style.md')) }];
  fs.appendFileSync(path.join(root, 'CLAUDE.md'), '\nAnother pending import.');
  choices = ['claude']; await commands.get('agentBridge.sync')();
  assert.ok(errors.pop().includes('Save'));
  console.log('PASS unsaved linked source files prevent stale imports');
  mock.workspace.textDocuments = [];
  config.codexAutoSetup = true;
  const beforeDiffs = diffs;
  await service.setDisplay('codex');
  assert.ok(fs.readFileSync(path.join(root,'AGENTS.md'),'utf8').includes('vault_run'));
  assert.ok(fs.readFileSync(path.join(root,'.codex/config.toml'),'utf8').includes('"--access","claude"'));
  assert.equal(diffs,beforeDiffs);
  assert.equal(service.snapshot().setupReady,true);
  const previousConfig=fs.readFileSync(path.join(root,'.codex/config.toml'),'utf8');
  mock.workspace.textDocuments=[{isDirty:true,uri:uri(path.join(root,'.codex/config.toml'))}];
  config.codexVaultAccess='mcp';await service.setDisplay('codex');
  assert.ok(service.snapshot().setupError.includes('Save'));
  assert.equal(fs.readFileSync(path.join(root,'.codex/config.toml'),'utf8'),previousConfig);
  mock.workspace.textDocuments=[];
  await commands.get('agentBridge.disconnectVault')();
  await service.setDisplay('codex');
  assert.ok(!fs.readFileSync(path.join(root,'.codex/config.toml'),'utf8').includes('mcp_servers.claude-monitor-vault'));
  console.log('PASS automatic preparation needs no modal, protects dirty files and respects disconnection');
})().catch(e => { console.error(e); process.exitCode = 1; }).finally(() => {
  for (const sub of context.subscriptions) sub.dispose();
  fs.rmSync(temp, { recursive: true, force: true });
});
