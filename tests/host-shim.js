// The non-VS Code host (host/): starts host/main.js the way the IntelliJ
// plugin does, plays the IDE's part over JSON-RPC, and checks that the
// unchanged extension activates, draws its panel and status bar, routes a
// webview panel, and runs an input box through its own validateInput.
//
// Also a static check: every vscode.<namespace>.<member> the extension calls
// must exist in host/vscode-shim.js, or the other IDE would throw where VS
// Code works.
//
// Nothing real is touched: the host runs with a temporary home folder, so its
// vault, its ~/.claude and its ~/.codex are empty throwaway copies; storage
// and workspace are temporary too, and the automatic Claude Code connection is
// switched off on top of that.

'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const ROOT = path.join(__dirname, '..');
const pkg = require(path.join(ROOT, 'package.json'));
let failures = 0;
function check(name, fn) {
  try { fn(); console.log('ok   ' + name); }
  catch (e) { failures++; console.log('FAIL ' + name + ': ' + e.message); }
}

// ------------------------------------------------------------ static check

const shim = require(path.join(ROOT, 'host', 'vscode-shim.js'));
const sources = ['extension.js', 'companion/ui.js', 'companion/updates.js', 'companion/detection.js', 'vault/ui.js']
  .map(f => fs.readFileSync(path.join(ROOT, f), 'utf8'));
const used = new Set();
for (const src of sources) {
  // Not after a quote: 'vscode.diff' is a command id, not an API member.
  for (const m of src.matchAll(/(?<!['"])\bvscode\.([A-Za-z]+)(?:\.([A-Za-z]+))?/g)) used.add(m[2] ? m[1] + '.' + m[2] : m[1]);
}
// Looked up before use by the extension, absent on purpose: the code checks
// for them and falls back.
const OPTIONAL = new Set(['window.tabGroups', 'window.onDidStartTerminalShellExecution',
  'window.onDidEndTerminalShellExecution', 'l']);
check('every vscode API the extension calls exists in the shim', () => {
  const missing = [...used].filter(u => !OPTIONAL.has(u)).filter(u => {
    const [a, b] = u.split('.');
    if (!(a in shim)) return true;
    return b !== undefined && !(b in shim[a]) && typeof shim[a] === 'object';
  });
  assert.deepStrictEqual(missing, []);
});

check('shim helpers turn VS Code display text into IDE text', () => {
  const h = shim.__host;
  assert.strictEqual(h.stripIcons('$(dashboard) 42% $(warning)'), '42% ⚠');
  assert.strictEqual(h.markdownToHtml('**Week**: 3%\n\n_updated 10:00_'), '<b>Week</b>: 3%<br><i>updated 10:00</i>');
  assert.strictEqual(shim.Uri.parse('agent-bridge-preview:/1/before/AGENTS.md').path, '/1/before/AGENTS.md');
  assert.strictEqual(shim.Uri.file('C:\\a\\b.txt').toString(), 'file:///C:/a/b.txt');
});

// --------------------------------------------------- the host, end to end

const storage = fs.mkdtempSync(path.join(os.tmpdir(), 'cmv-host-'));
const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'cmv-ws-'));
const home = fs.mkdtempSync(path.join(os.tmpdir(), 'cmv-home-'));
fs.writeFileSync(path.join(storage, 'settings.json'), JSON.stringify({
  'claudeLimits.autoConnect': false,       // never touch the real Claude Code configuration
  'agentBridge.updateNotice': 'off',
  'agentBridge.quotaDisplay': 'claude',    // no Codex process
  'agentBridge.codexAutoSetup': false
}));

const env = Object.assign({}, process.env, {
  HOME: home, USERPROFILE: home,
  CLAUDE_CONFIG_DIR: path.join(home, '.claude'), CODEX_HOME: path.join(home, '.codex')
});
const child = spawn(process.execPath, [path.join(ROOT, 'host', 'main.js')], { stdio: ['pipe', 'pipe', 'pipe'], env });
let stderr = '';
child.stderr.on('data', d => { stderr += d; });

const noise = [];
const realError = console.error;
console.error = (...a) => { noise.push(a.join(' ')); };
const rpc = require(path.join(ROOT, 'host', 'rpc.js')).create(child.stdout, s => child.stdin.write(s));

const notes = [];
const waiters = [];
function record(method, params) {
  notes.push({ method, params });
  for (const w of waiters.slice()) if (w.test(method, params)) { waiters.splice(waiters.indexOf(w), 1); w.resolve(params); }
}
function waitFor(method, test, ms) {
  const hit = notes.find(n => n.method === method && (!test || test(n.params)));
  if (hit) return Promise.resolve(hit.params);
  return new Promise((resolve, reject) => {
    const w = { test: (m, p) => m === method && (!test || test(p)), resolve };
    waiters.push(w);
    setTimeout(() => { const i = waiters.indexOf(w); if (i !== -1) { waiters.splice(i, 1); reject(new Error('timed out waiting for ' + method)); } }, ms || 8000);
  });
}

for (const m of ['webview.setHtml', 'webview.post', 'view.update', 'view.focus', 'panel.create', 'panel.update',
  'panel.reveal', 'panel.dispose', 'statusBar.update', 'statusBar.dispose', 'statusBar.message', 'terminal.create',
  'terminal.show', 'editor.openText', 'editor.openFile', 'editor.diff', 'settings.open', 'progress.start', 'progress.end']) {
  rpc.onNotification(m, p => record(m, p));
}

// The IDE's answers, scripted per method; anything unscripted is "dismissed".
const answers = {};
const asked = [];
function answer(method, fn) { (answers[method] = answers[method] || []).push(fn); }
for (const m of ['window.showMessage', 'window.showQuickPick', 'window.showInputBox', 'window.showOpenDialog',
  'window.showSaveDialog', 'env.clipboard.write', 'env.clipboard.read', 'env.openExternal']) {
  rpc.onRequest(m, async p => {
    asked.push({ method: m, params: p });
    record(m, p);
    const q = answers[m];
    return q && q.length ? q.shift()(p) : null;
  });
}

async function main() {
  const init = await rpc.request('initialize', {
    storagePath: storage, workspaceFolders: [workspace], language: 'en',
    shell: process.env.COMSPEC || '/bin/sh', trusted: true, focused: false, appName: 'Test IDE'
  });
  check('initialize activates the extension', () => assert.strictEqual(init.version, pkg.version));

  const status = await waitFor('statusBar.update', p => p.visible);
  check('the status bar item is drawn without codicons', () => {
    assert.ok(status.text.length > 0);
    assert.ok(!/\$\(/.test(status.text), status.text);
    assert.strictEqual(status.command, 'claudeLimits.open');
  });

  await rpc.request('view.resolve', { id: 'claudeMonitorVault.panel' });
  const html = await waitFor('webview.setHtml', p => p.id === 'claudeMonitorVault.panel');
  const post = await waitFor('webview.post', p => p.id === 'claudeMonitorVault.panel');
  check('the side panel receives its page and its data', () => {
    assert.ok(html.html.includes('acquireVsCodeApi'));
    assert.ok(post.message && 'vault' in post.message && 'rows' in post.message);
  });

  await rpc.request('command.execute', { command: 'claudeVault.audit', args: [] });
  const panel = await waitFor('panel.create', p => p.viewType === 'claudeVault.audit');
  const panelHtml = await waitFor('webview.setHtml', p => p.id === panel.id);
  check('a webview panel opens as its own page', () => assert.ok(panelHtml.html.includes('<html')));
  rpc.notify('webview.message', { id: panel.id, message: { type: 'refresh' } });
  await waitFor('webview.setHtml', p => p.id === panel.id && p !== panelHtml);
  check('a message from the page reaches the extension', () => assert.ok(true));
  rpc.notify('webview.disposed', { id: panel.id });

  // The pill colour flow: a quick pick, then an input box validated by the
  // extension's own validateInput, live and once more on accept.
  let liveError = null;
  answer('window.showQuickPick', p => {
    check('quick pick items arrive as plain labels', () => assert.ok(p.items.length >= 2 && typeof p.items[0].label === 'string'));
    return 0;
  });
  answer('window.showInputBox', async p => {
    liveError = await rpc.request('input.validate', { token: p.token, value: 'not a colour' });
    return 'not a colour';
  });
  answer('window.showInputBox', p => { check('an invalid value is asked again, with its error', () => assert.ok(p.error && p.value === 'not a colour')); return null; });
  await rpc.request('command.execute', { command: 'claudeLimits.pillColor', args: [] });
  check('validateInput answers the IDE while the user types', () => assert.ok(liveError && /hexadecimal/i.test(liveError), String(liveError)));

  rpc.notify('window.state', { focused: true });
  await rpc.request('command.execute', { command: 'claudeLimits.refresh', args: [] });
  check('a palette command runs and returns', () => assert.ok(true));

  check('stdout carries nothing but protocol', () => assert.deepStrictEqual(noise, []));

  const exited = new Promise(r => child.on('exit', code => r(code)));
  await rpc.request('shutdown');
  const code = await exited;
  check('shutdown disposes and exits cleanly', () => assert.strictEqual(code, 0));
}

main().catch(e => { failures++; console.log('FAIL ' + e.message); })
  .finally(() => {
    console.error = realError;
    try { child.kill(); } catch (e) { /* already gone */ }
    for (const d of [storage, workspace, home]) { try { fs.rmSync(d, { recursive: true, force: true }); } catch (e) { /* busy on Windows */ } }
    if (failures) { console.log('\nhost stderr:\n' + stderr.slice(-4000)); process.exit(1); }
    console.log('\nall host checks passed');
  });
