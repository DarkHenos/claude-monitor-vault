'use strict';
const vscode = require('vscode');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { t } = require('../i18n');
const VERSION = require('../package.json').version;
const SEEN = 'agentBridge.lastUpdateShown';
const esc = value => String(value).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
function html(webview, context) {
  const nonce = crypto.randomBytes(18).toString('hex');
  const logo = webview.asWebviewUri(vscode.Uri.joinPath(context.extensionUri, 'media', 'logo-companion.svg'));
  const features = [
    ['Claude + ChatGPT / Codex', 'Choose your assistant and model for a new project session.'],
    ['Connected project memories', 'Linked memory files are discovered, counted and imported with their references preserved.'],
    ['Usage and vault', 'Optional Codex quotas and local vault tools join the existing Claude features.'],
    ['A familiar extension', 'Your Marketplace identity, settings and encrypted vault stay in place.']
  ];
  const button = (action, label, primary = false) => '<button data-action="' + action + '"' + (primary ? ' class="primary"' : '') + '>' + esc(t(label)) + '</button>';
  return `<!DOCTYPE html><html lang="${esc(require('../i18n').current())}"><head><meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src ${webview.cspSource}; style-src 'nonce-${nonce}'; script-src 'nonce-${nonce}';">
<title>${esc(t('What is new'))}</title><style nonce="${nonce}">
body{font-family:var(--vscode-font-family);color:var(--vscode-foreground);background:var(--vscode-editor-background);margin:0;padding:40px 24px;line-height:1.65}
main{max-width:720px;margin:auto}header{display:flex;align-items:center;gap:22px}header img{width:84px;height:84px;flex-shrink:0}
.version{color:var(--vscode-descriptionForeground);font-size:12px;margin:0}h1{font-size:28px;line-height:1.25;font-weight:600;margin:8px 0}
.intro{font-size:15px;margin:28px 0 32px}.feature{border-top:1px solid var(--vscode-panel-border);padding:20px 0}h2{font-size:16px;margin:0 0 5px;font-weight:600}.feature p{margin:0;color:var(--vscode-descriptionForeground)}
nav{display:flex;flex-wrap:wrap;gap:10px;margin-top:28px}button{font:inherit;padding:9px 14px;border:1px solid var(--vscode-button-border,transparent);border-radius:3px;color:var(--vscode-button-secondaryForeground);background:var(--vscode-button-secondaryBackground);cursor:pointer}button:hover{background:var(--vscode-button-secondaryHoverBackground)}button.primary{color:var(--vscode-button-foreground);background:var(--vscode-button-background)}button.primary:hover{background:var(--vscode-button-hoverBackground)}button:focus-visible{outline:2px solid var(--vscode-focusBorder);outline-offset:3px}
footer{margin-top:28px;font-size:12px;color:var(--vscode-descriptionForeground)}footer button{padding:0;border:0;background:none;color:var(--vscode-textLink-foreground);font-size:12px;margin-right:18px}#status{color:var(--vscode-errorForeground)}@media(max-width:480px){body{padding:24px 16px}header{gap:12px}header img{width:56px;height:56px}h1{font-size:22px}}
</style></head><body><main><header><img src="${esc(logo)}" alt=""><div><p class="version">Claude Monitor &amp; Vault + ChatGPT · ${esc(VERSION)}</p><h1>${esc(t('What is new'))}</h1></div></header>
<p class="intro">${esc(t('The extension you know, now connecting Claude and ChatGPT / Codex.'))}</p>
${features.map(([title, body]) => '<section class="feature"><h2>' + esc(t(title)) + '</h2><p>' + esc(t(body)) + '</p></section>').join('')}
<nav aria-label="${esc(t('Explore the new features'))}">${button('switch', 'Switch assistant / model', true)}${button('sync', 'Import / synchronize memory')}${button('quotas', 'Enable ChatGPT / Codex quotas')}</nav>
<p id="status" role="status"></p><footer><p>${esc(t('This page appears once per version. You can reopen it from the command palette.'))}</p>${button('disable', 'Do not show update notices')}${button('close', 'Close')}</footer></main>
<script nonce="${nonce}">const api=acquireVsCodeApi();document.addEventListener('click',e=>{const b=e.target.closest('button[data-action]');if(b)api.postMessage({action:b.dataset.action});});window.addEventListener('message',e=>{if(e.data&&e.data.error)document.getElementById('status').textContent=e.data.error;});</script></body></html>`;
}
function activate(context) {
  let panel = null, stopped = false;
  const config = () => vscode.workspace.getConfiguration('agentBridge');
  async function disable() { await config().update('updateNotice', 'off', vscode.ConfigurationTarget.Global); }
  function open() {
    if (panel) { panel.reveal(vscode.ViewColumn.One); return; }
    const current = vscode.window.createWebviewPanel('claudeMonitorVault.updates', t('What is new'), vscode.ViewColumn.One,
      { enableScripts: true, localResourceRoots: [vscode.Uri.joinPath(context.extensionUri, 'media')] });
    panel = current;
    try { current.webview.html = html(current.webview, context); }
    catch (e) { panel = null; current.dispose(); throw e; }
    const listener = current.webview.onDidReceiveMessage(async message => {
      if (!message || typeof message.action !== 'string') return;
      const commands = { switch: 'agentBridge.switch', sync: 'agentBridge.sync', quotas: 'agentBridge.enableCodex' };
      try {
        if (Object.hasOwn(commands, message.action)) await vscode.commands.executeCommand(commands[message.action]);
        else if (message.action === 'close') current.dispose();
        else if (message.action === 'disable') { await disable(); current.dispose(); }
      } catch (e) { current.webview.postMessage({ error: e.message }); }
    });
    current.onDidDispose(() => { listener.dispose(); if (panel === current) panel = null; });
    context.subscriptions.push(current);
  }
  function notification() {
    const details = t('What is new'), stop = t('Do not show update notices');
    vscode.window.showInformationMessage(t('Updated to {0}: assistant switching, linked memories, Codex quotas and vault access.', VERSION), details, stop)
      .then(choice => { if (stopped) return; if (choice === details) { try { open(); } catch (_) {} } else if (choice === stop) return disable(); })
      .catch(() => {});
  }
  async function announce() {
    if (stopped || config().get('updateNotice', 'window') === 'off' || context.globalState.get(SEEN) === VERSION) return;
    const dir = path.join(context.globalStorageUri.fsPath, 'update-notices');
    const claim = path.join(dir, VERSION + '.shown');
    try {
      fs.mkdirSync(dir, { recursive: true });
      const descriptor = fs.openSync(claim, 'wx'); fs.closeSync(descriptor);
    } catch (e) {
      if (e.code === 'EEXIST') return;
      notification(); await context.globalState.update(SEEN, VERSION); return;
    }
    try {
      if (config().get('updateNotice', 'window') === 'notification') notification();
      else { try { open(); } catch (_) { notification(); } }
      await context.globalState.update(SEEN, VERSION);
    } catch (_) { /* The persisted claim prevents repeated notices. */ }
  }
  context.subscriptions.push(vscode.commands.registerCommand('agentBridge.whatsNew', () => {
    try { open(); } catch (_) { notification(); }
  }));
  const timer = setTimeout(() => { announce().catch(() => {}); }, 1500);
  context.subscriptions.push({ dispose() { stopped = true; clearTimeout(timer); if (panel) panel.dispose(); } });
  return { announce, open };
}
module.exports = { activate, html, SEEN };
