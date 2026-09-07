'use strict';
const assert = require('assert/strict');
const fs = require('fs');
const path = require('path');
const os = require('os');
const Module = require('module');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'monitor-updates-test-'));
let mode = 'window', failOpen = false, panels = [], notifications = [], executed = [];
const commands = new Map();
const uri = p => ({ fsPath: p, toString: () => p });
const mock = {
  Uri: { joinPath: (base, ...parts) => uri(path.join(base.fsPath, ...parts)) },
  ViewColumn: { One: 1 }, ConfigurationTarget: { Global: 1 },
  workspace: { getConfiguration: () => ({ get: () => mode, update: async (_key, value) => { mode = value; } }) },
  commands: { registerCommand: (id, fn) => { commands.set(id, fn); return { dispose() {} }; }, executeCommand: async id => { executed.push(id); } },
  window: {
    showInformationMessage: async text => { notifications.push(text); },
    createWebviewPanel: (_id, _title, _column, options) => {
      if (failOpen) throw new Error('Window unavailable');
      let disposed = false;
      const panel = { options, reveal() { this.revealed = true; },
        onDidDispose(fn) { this.close = fn; }, dispose() { if (!disposed) { disposed = true; this.close?.(); } },
        webview: { cspSource: 'vscode-webview:', asWebviewUri: p => p.toString(),
          onDidReceiveMessage(fn) { panel.message = fn; return { dispose() {} }; }, postMessage() {} } };
      panels.push(panel); return panel;
    }
  }
};
const original = Module._load;
Module._load = function (name) { return name === 'vscode' ? mock : original.apply(this, arguments); };
const updates = require('../companion/updates'); Module._load = original;
const contexts = [];
function context(name, seen) {
  const state = new Map(seen ? [[updates.SEEN, seen]] : []);
  const c = { extensionUri: uri(path.resolve(__dirname, '..')), globalStorageUri: uri(path.join(root, name)), subscriptions: [],
    globalState: { get: k => state.get(k), update: async (k, v) => state.set(k, v) } };
  contexts.push(c); return c;
}
(async () => {
  const first = context('first', '1.0.0'); const service = updates.activate(first);
  await service.announce(); assert.equal(panels.length, 1);
  assert.equal(first.globalState.get(updates.SEEN), require('../package.json').version);
  assert.ok(panels[0].webview.html.includes('logo-companion.svg'));
  assert.ok(panels[0].webview.html.includes("default-src 'none'"));
  assert.ok(!panels[0].webview.html.includes('unsafe-inline'));
  console.log('PASS new version opens a themed page with the logo and strict CSP');
  await service.announce(); assert.equal(panels.length, 1);
  await updates.activate(context('first')).announce(); assert.equal(panels.length, 1);
  console.log('PASS repeat activation and another project window do not duplicate notices');
  commands.get('agentBridge.whatsNew')(); assert.equal(panels.length, 2);
  await panels[1].message({ action: 'switch' });
  await panels[1].message({ action: 'constructor' });
  await panels[1].message({ action: 'workbench.action.closeWindow' });
  assert.deepEqual(executed, ['agentBridge.switch']);
  console.log('PASS manual reopening works and actions are allowlisted');
  await panels[1].message({ action: 'disable' }); assert.equal(mode, 'off');
  await updates.activate(context('disabled')).announce(); assert.equal(panels.length, 2);
  console.log('PASS users can disable automatic update notices');
  mode = 'notification'; await updates.activate(context('notification')).announce();
  assert.equal(notifications.length, 1); assert.equal(panels.length, 2);
  console.log('PASS notification mode explains the update without opening a tab');
  mode = 'window'; failOpen = true;
  const fallback = updates.activate(context('fallback')); await fallback.announce(); await fallback.announce();
  assert.equal(notifications.length, 2);
  console.log('PASS an unavailable webview falls back to one notification');
})().catch(e => { console.error(e); process.exitCode = 1; }).finally(() => {
  for (const c of contexts) for (const d of c.subscriptions) d.dispose();
  fs.rmSync(root, { recursive: true, force: true });
});
