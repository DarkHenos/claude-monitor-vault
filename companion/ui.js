'use strict';
const vscode = require('vscode');
const fs = require('fs');
const path = require('path');
const { CodexClient, quotaRows } = require('./codex');
const { resolveCli } = require('./cli');
const memory = require('./memory');
const mcp = require('./mcp-config');
const detection = require('./detection');
const setup = require('./setup');
const colors = require('./colors');
const { t } = require('../i18n');

function activate(context) {
  const emitter = new vscode.EventEmitter();
  let client = null, quotas = [], error = '', updated = 0, busy = false, disposed = false;
  const alerts = new Set();
  const backups = path.join(context.globalStorageUri.fsPath, 'project-backups');
  if (vscode.workspace.isTrusted && fs.existsSync(path.join(context.globalStorageUri.fsPath, 'codex-vault-bridge'))) {
    try { mcp.installBridge(context.extensionPath, context.globalStorageUri.fsPath); }
    catch (_) { error = t('Connection needs attention'); }
  }
  const config = () => vscode.workspace.getConfiguration('agentBridge');
  const running = new Map();
  const saved = root => context.workspaceState.get('agentBridge:' + root);
  const selected = root => saved(root) || { provider: detection.detect(vscode, root, undefined, undefined, running)[0], model: '' };
  const firstRoot = () => vscode.workspace.workspaceFolders?.find(f => f.uri.scheme === 'file')?.uri.fsPath;
  function providers() {
    const mode = config().get('quotaDisplay', 'auto');
    if (mode === 'both') return ['claude', 'codex'];
    if (mode === 'claude' || mode === 'codex') return [mode];
    if (config().get('codexMonitor', false)) return ['claude', 'codex'];
    return detection.detect(vscode, firstRoot(), saved(firstRoot()), undefined, running);
  }
  function snapshot() {
    return { mode: config().get('quotaDisplay', 'auto'), providers: providers(), quotas: quotas.map(q=>({...q,...colors.paint(q.pct,config())})), error, updated, busy, setupError, setupReady };
  }
  let setupError = '', preparing = false, setupReady = false;
  async function prepare(root = firstRoot(), force = false) {
    if (!root || !vscode.workspace.isTrusted || preparing || disposed) return;
    if (!force && (!config().get('codexAutoSetup', true) || context.workspaceState.get('agentBridge.disconnected:' + root))) return;
    preparing = true;
    try {
      const server = mcp.installBridge(context.extensionPath, context.globalStorageUri.fsPath);
      const node = require('../vault/install').nodeExec();
      const plan = setup.plan(root, node, server, config().get('codexVaultAccess', 'claude'));
      if (vscode.workspace.textDocuments.some(d => d.isDirty && plan.changes.some(c => vscode.Uri.file(path.join(root,c.file)).toString() === d.uri.toString()))) throw new Error(t('Save your open memory files before synchronizing.'));
      if (plan.changes.length) {
        const backup = memory.applyPlan(plan, backups);
        if (backup) await context.workspaceState.update('agentBridge.backup:' + root, backup);
      }
      setupError = ''; setupReady = true;
    } catch (e) { setupError = e.message; setupReady = false; }
    finally { preparing = false; emitter.fire(); }
    if (force && setupError) throw new Error(setupError);
  }
  function needTrust() {
    if (!vscode.workspace.isTrusted) throw new Error(t('Trust this workspace before connecting an assistant or using project memory.'));
  }
  async function project() {
    needTrust();
    const folders = (vscode.workspace.workspaceFolders || []).filter(f => f.uri.scheme === 'file');
    if (!folders.length) throw new Error(t('Open a local project folder first.'));
    if (folders.length === 1) return folders[0].uri.fsPath;
    const pick = await vscode.window.showQuickPick(folders.map(f => ({ label: f.name, description: f.uri.fsPath, root: f.uri.fsPath })), { title: t('Choose a project') });
    return pick?.root;
  }
  function codex() {
    needTrust();
    if (!client) {
      client = new CodexClient(config().get('codexExecutable', ''));
      const current = client;
      client.onUpdate = data => { if (!disposed && client === current) {
        const incoming = quotaRows(data);
        const byId = new Map(quotas.map(q => [q.id, q]));
        for (const q of incoming) byId.set(q.id, q);
        quotas = Array.from(byId.values()); updated = Date.now(); error = ''; emitter.fire();
      } };
    }
    return client;
  }
  async function refresh() {
    if (busy || disposed || !vscode.workspace.isTrusted || !providers().includes('codex')) return;
    busy = true; emitter.fire();
    let current;
    try {
      current = codex();
      const data = await current.usage();
      if (disposed || client !== current) return;
      quotas = quotaRows(data); updated = Date.now(); error = '';
      for (const row of quotas) {
        for (const threshold of config().get('alertThresholds', [80, 95])) {
          const key = row.id + ':' + row.resetAt + ':' + threshold;
          if (row.pct >= threshold && !alerts.has(key)) {
            alerts.add(key);
            vscode.window.showWarningMessage(t('Codex quota: {0}% used ({1}).', Math.round(row.pct), row.label));
          }
        }
      }
      if (alerts.size > 200) alerts.clear();
    } catch (e) { if (!disposed && (!current || client === current)) error = e.message; }
    finally { busy = false; emitter.fire(); }
  }
  const documents = new Map();
  context.subscriptions.push(vscode.workspace.registerTextDocumentContentProvider('agent-bridge-preview', {
    provideTextDocumentContent: uri => documents.get(uri.toString()) || ''
  }));
  async function previewAndApply(plan) {
    const inventory = plan.inventory;
    const inventorySummary = inventory ? t('Memory files: {0} ({1} linked), {2} missing, {3} skipped.',
      inventory.files.length, Math.max(0, inventory.files.length - 1), inventory.missing.length, inventory.skipped.length) : '';
    const rememberInventory = async () => {
      if (inventory) await context.workspaceState.update('agentBridge.inventory:' + plan.root,
        { count: inventory.files.length, missing: inventory.missing.length, skipped: inventory.skipped.length });
      emitter.fire();
    };
    if (inventory) {
      const lines = [t('Linked memory inventory'), '', inventorySummary, '', t('Main memory file'), inventory.entry,
        '', t('Files included'), ...inventory.files.map(f => '- ' + f.relative)];
      for (const [title, entries] of [[t('Missing references'), inventory.missing], [t('Skipped references'), inventory.skipped]]) {
        if (entries.length) lines.push('', title, ...entries.map(e => '- ' + e.reference + ' (' + e.reason + ') ← ' + path.relative(inventory.scope, e.from || inventory.entry)));
      }
      await vscode.window.showTextDocument(await vscode.workspace.openTextDocument({ content: lines.join('\n'), language: 'plaintext' }), { preview: false });
    }
    if (!plan.changes.length) { await rememberInventory(); return true; }
    for (let i = 0; i < plan.changes.length; i++) {
      const change = plan.changes[i];
      const base = Date.now() + '-' + i;
      const left = vscode.Uri.parse('agent-bridge-preview:/' + base + '/before/' + change.file);
      const right = vscode.Uri.parse('agent-bridge-preview:/' + base + '/after/' + change.file);
      documents.set(left.toString(), change.before || ''); documents.set(right.toString(), change.after);
      await vscode.commands.executeCommand('vscode.diff', left, right, change.file + ' · ' + t('Memory preview'), { preview: false });
    }
    const apply = t('Apply changes');
    if (await vscode.window.showInformationMessage(t('Review the opened differences. Existing files will be backed up locally before applying.'),
      { modal: true, ...(inventory ? { detail: inventorySummary } : {}) }, apply) !== apply) return false;
    for (const doc of vscode.workspace.textDocuments) {
      if (doc.isDirty && (plan.changes.some(c => vscode.Uri.file(path.join(plan.root, c.file)).toString() === doc.uri.toString())
        || inventory?.files.some(f => vscode.Uri.file(f.file).toString() === doc.uri.toString()))) {
        throw new Error(t('Save your open memory files before synchronizing.'));
      }
    }
    needTrust();
    const backup = memory.applyPlan(plan, backups);
    if (backup) await context.workspaceState.update('agentBridge.backup:' + plan.root, backup);
    await rememberInventory();
    return true;
  }
  async function sync(root) {
    root = root || await project(); if (!root) return false;
    const source = await vscode.window.showQuickPick([
      { label: t('Use shared memory'), value: 'shared', description: '.agent-bridge/MEMORY.md' },
      { label: t('Import Claude project instructions'), value: 'claude', description: 'CLAUDE.md' },
      { label: t('Import Codex project instructions'), value: 'codex', description: 'AGENTS.md' },
      { label: t('Import a memory file'), value: 'import', description: 'MEMORY.md, .claude/rules/*.md' }
    ], { title: t('Import / synchronize memory'), placeHolder: t('Imports preserve existing shared notes and assistant-specific files.') });
    if (!source) return false;
    let imported;
    if (source.value === 'import') {
      const files = await vscode.window.showOpenDialog({ canSelectMany: false, filters: { Markdown: ['md'] }, title: t('Import a memory file') });
      if (!files?.length) return false;
      if (files[0].scheme !== 'file') throw new Error(t('Choose a local Markdown memory file.'));
      imported = { entry: files[0].fsPath };
    }
    return previewAndApply(memory.buildPlan(root, source.value, imported));
  }
  async function openMemory() {
    const root = await project(); if (!root) return;
    if (memory.read(root, memory.SHARED) === null && !await sync(root)) return;
    await vscode.window.showTextDocument(vscode.Uri.file(memory.safePath(root, memory.SHARED)));
  }
  async function launch(root, choice) {
    root = root || await project(); if (!root) return;
    choice = choice || selected(root);
    const name = choice.provider === 'claude' ? 'claude' : 'codex';
    const cli = resolveCli(name, config().get(name + 'Executable', ''));
    if (name === 'codex' && config().get('codexAutoSetup', true) && !context.workspaceState.get('agentBridge.disconnected:' + root)) await prepare(root, true);
    else if (!await previewAndApply(memory.buildPlan(root))) return;
    const args = [...cli.args];
    if (choice.model) args.push('--model', choice.model);
    // shellPath/shellArgs starts the CLI directly; no sendText quoting or shell expansion.
    const terminal = vscode.window.createTerminal({ name: 'Claude Monitor · ' + (name === 'claude' ? 'Claude' : 'Codex'),
      cwd: root, shellPath: cli.command, shellArgs: args });
    terminal.show();
  }
  async function switchAssistant() {
    const root = await project(); if (!root) return;
    const assistant = await vscode.window.showQuickPick([
      { label: 'Claude Code', value: 'claude' }, { label: 'ChatGPT / Codex', value: 'codex' }
    ], { title: t('Switch assistant / model') });
    if (!assistant) return;
    let options = [{ label: t('Use assistant default model'), value: '' }];
    if (assistant.value === 'codex') {
      const models = await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: t('Loading available models') }, () => codex().models());
      options.push(...models.map(m => ({ label: m.displayName || m.model || m.id, value: m.model || m.id })));
    } else options.push(...['sonnet', 'opus', 'haiku'].map(value => ({ label: value, value })));
    options.push({ label: t('Enter a model identifier'), value: '__custom' });
    const model = await vscode.window.showQuickPick(options, { title: t('Choose a model for the next session') });
    if (!model) return;
    let value = model.value;
    if (value === '__custom') {
      value = await vscode.window.showInputBox({ title: t('Enter a model identifier'), validateInput: v => /^[a-zA-Z0-9][a-zA-Z0-9._:/-]{0,150}$/.test(v) ? null : t('Invalid model identifier') });
      if (!value) return;
    }
    if (config().get('syncOnSwitch', true) && !await sync(root)) return;
    const choice = { provider: assistant.value, model: value };
    await context.workspaceState.update('agentBridge:' + root, choice); emitter.fire();
    refresh();
    await launch(root, choice);
  }
  async function connectVault(disconnect = false) {
    const root = await project(); if (!root) return;
    const node = require('../vault/install').nodeExec();
    const server = disconnect ? '' : mcp.installBridge(context.extensionPath, context.globalStorageUri.fsPath);
    if (await previewAndApply(setup.plan(root, node, server, config().get('codexVaultAccess', 'claude'), disconnect))) {
      await context.workspaceState.update('agentBridge.disconnected:' + root, disconnect);
      setupReady = !disconnect; emitter.fire();
      vscode.window.showInformationMessage(disconnect ? t('Codex vault disconnected. Restart the assistant session.')
        : t('Codex vault connected. Allow selected keys for MCP server claude-monitor-vault, then restart the assistant session.'));
    }
  }
  async function diagnostics() {
    const lines = ['Claude Monitor & Vault + ChatGPT', ''];
    for (const name of ['claude', 'codex']) {
      try { const cli = resolveCli(name, config().get(name + 'Executable', '')); lines.push(name + ': ' + cli.command); }
      catch (e) { lines.push(name + ': ' + e.message); }
    }
    lines.push('', 'Codex: ' + (error || (updated ? new Date(updated).toISOString() : t('Not connected'))),
      'Workspace trust: ' + vscode.workspace.isTrusted,
      '', t('Model selection applies to new CLI sessions launched here. Existing chat sessions keep their own model.'),
      t('Project memory is shared through files. ChatGPT web memory and conversation history are not imported.'));
    await vscode.window.showTextDocument(await vscode.workspace.openTextDocument({ content: lines.join('\n'), language: 'plaintext' }));
  }
  const commands = {
    connectionStatus: () => {
      let configured=false;
      const root=firstRoot();
      if(root && vscode.workspace.isTrusted)try{configured=(memory.read(root,'.codex/config.toml')||'').includes('[mcp_servers.claude-monitor-vault]');}catch(_){}
      return {configured,providers:providers(),error:setupError};
    },
    settings: () => vscode.commands.executeCommand('workbench.action.openSettings', '@ext:alexossart.claude-monitor-vault agentBridge'),
    actions: async () => {
      const items = [['Switch assistant / model', 'switch'], ['Start selected assistant', 'launch'],
        ['Shared project memory', 'memory'], ['Import / synchronize memory', 'sync'],
        ['Connect Codex to the vault', 'connectVault'], ['Assistant settings', 'settings'], ['Connection needs attention', 'diagnostics'], ['What is new', 'whatsNew']];
      const pick = await vscode.window.showQuickPick(items.map(([label, value]) => ({ label: t(label), value })), { title: t('Assistant actions') });
      if (pick) await vscode.commands.executeCommand('agentBridge.' + pick.value);
    },
    switch: switchAssistant, launch: () => launch(), memory: openMemory, sync: () => sync(), refresh,
    enableCodex: async () => { needTrust(); await config().update('quotaDisplay', 'both', vscode.ConfigurationTarget.Global); await refresh(); },
    connectVault: () => connectVault(), disconnectVault: () => connectVault(true), diagnostics,
    restoreMemory: async () => {
      const root = await project(); if (!root) return;
      const backup = context.workspaceState.get('agentBridge.backup:' + root);
      if (!backup) throw new Error(t('No project backup available.'));
      memory.restore(backup); await context.workspaceState.update('agentBridge.backup:' + root, undefined); emitter.fire();
      await context.workspaceState.update('agentBridge.inventory:' + root, undefined); emitter.fire();
      vscode.window.showInformationMessage(t('Project files restored.'));
    }
  };
  for (const [name, fn] of Object.entries(commands)) context.subscriptions.push(vscode.commands.registerCommand('agentBridge.' + name, async () => {
    try { return await fn(); } catch (e) { vscode.window.showErrorMessage(e.message); }
  }));
  function changed() { emitter.fire(); if(providers().includes('codex')) prepare(); refresh(); }
  if (vscode.window.onDidStartTerminalShellExecution) context.subscriptions.push(vscode.window.onDidStartTerminalShellExecution(e => {
    const p=detection.commandProvider(e.execution.commandLine.value); if(p) {running.set(e.terminal,p);changed();}
  }));
  if (vscode.window.onDidEndTerminalShellExecution) context.subscriptions.push(vscode.window.onDidEndTerminalShellExecution(e => {running.delete(e.terminal);changed();}));
  for (const [owner, name] of [[vscode.window,'onDidChangeActiveTerminal'], [vscode.window,'onDidOpenTerminal'], [vscode.window,'onDidCloseTerminal'], [vscode.window.tabGroups,'onDidChangeTabs'], [vscode.window.tabGroups,'onDidChangeTabGroups'], [vscode.extensions,'onDidChange']]) {
    if(owner && typeof owner[name] === 'function') context.subscriptions.push(owner[name](changed));
  }
  const timer = setInterval(() => { if (vscode.window.state.focused) changed(); }, 210000);
  context.subscriptions.push(emitter, { dispose() { disposed = true; clearInterval(timer); if (client) client.dispose(); documents.clear(); running.clear(); } },
    vscode.workspace.onDidChangeConfiguration(e => {
      if (e.affectsConfiguration('agentBridge')) {
        if (client) client.dispose(); client = null; quotas = []; error = ''; updated = 0; alerts.clear(); changed();
      }
    }), vscode.workspace.onDidGrantWorkspaceTrust(changed),
    vscode.workspace.onDidChangeWorkspaceFolders(changed));
  // Delay writes until activation has finished registering the vault and views.
  const initial = setTimeout(changed, 0);
  context.subscriptions.push({dispose(){clearTimeout(initial);}});
  return { snapshot, onDidChange: emitter.event, refresh, setDisplay: async mode => {
    if (!['auto', 'claude', 'codex', 'both'].includes(mode)) return;
    await config().update('quotaDisplay', mode, vscode.ConfigurationTarget.Global);
    changed(); await refresh();
  } };
}
module.exports = { activate };
