// Claude Vault, VS Code commands and bridge to the webview.
//
// Non-negotiable rule: this file has NO read path. Nowhere in it is there a
// function able to display or copy the value of a secret. A key is created,
// replaced, or deleted, but it is never read back.
// Input goes through showInputBox({password:true}): native, masked, outside
// the webview's DOM and outside any temporary file.
//
// Display lives in extension.js's webview (the "Secrets" tab); this
// module only supplies the data and the actions.

'use strict';

const fs = require('fs');
const path = require('path');
const vscode = require('vscode');
const vault = require('./core.js');
const installer = require('./install.js');
const i18n = require('../i18n.js');

const t = (m, ...a) => i18n.t(m, ...a);

// core.js runs inside the hooks too, as a plain node process with no vscode
// module to call. It therefore carries the English template and its arguments
// alongside the assembled message, and translation happens here, at the only
// point where a human reads it.
function errText(e) {
  if (e && e.tpl) return i18n.t(e.tpl, ...(e.args || []));
  return e && e.message ? e.message : String(e);
}

function kindText(kind) {
  return i18n.t(vault.kindSource(kind));
}

function issuesText(issues) {
  return (issues || []).map(i => ({
    level: i.level,
    msg: i.tpl ? i18n.t(i.tpl, ...(i.args || [])) : i.msg
  }));
}

// Built lazily: the quick pick is rare enough that rebuilding it costs nothing,
// and a module-level constant would freeze the labels before l10n is ready in
// the corner cases where this module is required early.
function ttlChoices() {
  return [
    { label: t('5 minutes'), detail: t('long enough for one operation'), ms: 300000 },
    { label: t('1 hour'), detail: t('a working session'), ms: 3600000 },
    { label: t('8 hours'), detail: t('a working day'), ms: 28800000 },
    { label: t('24 hours'), ms: 86400000 },
    { label: t('7 days'), ms: 604800000 },
    { label: t('Until this VS Code session ends'), detail: t('deleted when VS Code closes'),
      ms: 43200000, session: true },
    { label: t('Burn after first use'), detail: t('one use only, then erased'),
      ms: null, maxUses: 1 },
    { label: t('No expiry'), detail: t('stays until you delete it'), ms: null }
  ];
}

function activateVault(context, version, onChange) {
  const sessionKeys = new Set();     // keys to purge when VS Code closes
  const notify = () => { try { onChange(); } catch (e) { /* no webview */ } };

  // A command can be invoked in three ways: from the palette (no argument),
  // from the webview (the name as a string), or from the native context menu
  // (VS Code passes the data-vscode-context object). The shape of that last
  // one isn't documented, so we accept anything that looks like a key name.
  function nameOf(arg) {
    if (typeof arg === 'string') return arg;
    if (arg && typeof arg === 'object') {
      return arg.keyName || arg.name || (arg.webviewSection ? null : null);
    }
    return null;
  }

  // Data sent to the webview. No values, only metadata.
  function snapshot() {
    const health = vault.healthCheck();
    const st = installer.status(version);
    return {
      secrets: vault.listFast().map(s => Object.assign({}, s, { kind: kindText(s.kind) })),
      issues: issuesText(health.issues),
      connected: st.installed && st.upToDate,
      needsUpdate: st.installed && !st.upToDate
    };
  }

  // ------------------------------------------------- replacement under approval
  //
  // English only, and untranslated on purpose: this flow was added after the
  // localisation pass and its strings are deliberately not in the l10n bundles.

  const asked = new Set();     // one prompt per request, however often we are called

  async function reviewPending() {
    let waiting;
    try { waiting = vault.pendingReplacements(); } catch (e) { return; }
    const live = new Set(waiting.map(p => p.name));
    for (const n of Array.from(asked)) if (!live.has(n)) asked.delete(n);

    const replace = t('Replace');
    const keep = t('Keep the current value');
    for (const p of waiting) {
      if (asked.has(p.name)) continue;
      asked.add(p.name);
      const yes = await vscode.window.showWarningMessage(
        t('Claude asks to replace {0} in Claude Vault.', p.name),
        {
          modal: true,
          detail: t('New value: {0}, {1} characters.', kindText(p.kind), String(p.length)) +
            (p.note ? '\n\n' + t('Claude says: {0}', p.note) : '') +
            '\n\n' + t('The current value is destroyed and cannot be recovered. Neither you nor Claude has seen either value, only their size and type.')
        },
        replace, keep);
      try {
        if (yes === replace) {
          vault.approveReplace(p.name);
          vscode.window.setStatusBarMessage(t('{0} replaced', p.name), 4000);
        } else {
          vault.rejectReplace(p.name);
        }
        notify();
      } catch (e) {
        vscode.window.showErrorMessage(t('Claude Vault: {0}', errText(e)));
      }
    }
  }

  async function toggleAutoApprove() {
    if (vault.policy().autoApprove) {
      vault.setPolicy({ autoApprove: false });
      vscode.window.showInformationMessage(
        t('Claude Vault: automatic approval is off. Replacing a key will ask you again.'));
      notify();
      return;
    }
    const allow = t('Allow without asking');
    const yes = await vscode.window.showWarningMessage(
      t('Let Claude replace keys without asking?'),
      {
        modal: true,
        detail: t('Claude will be able to overwrite the value of any existing key on its own, and the old value cannot be recovered. It still cannot read a value, and it still cannot delete a key: deletion stays yours.') +
          '\n\n' + t('Useful for a long unattended session. Turn it back off afterwards.')
      },
      allow);
    if (yes !== allow) return;
    vault.setPolicy({ autoApprove: true });
    vscode.window.showWarningMessage(
      t('Claude Vault: automatic approval is ON. Claude can now replace keys without asking.'));
    notify();
  }

  // ------------------------------------------------------------- MCP launcher
  //
  // English only, untranslated on purpose, like the rest of what came after the
  // localisation pass.
  //
  // Substituting a secret into MCP tool arguments works, but it puts the value
  // on the tool call path. Almost no server actually needs that: they read a
  // credential from their environment at startup. So we hand the user the one
  // line of configuration that keeps the value out of every argument, and out
  // of .mcp.json, which is usually committed.

  async function mcpSnippet(arg) {
    const name = nameOf(arg) || await pickKey(t('Use a key in an MCP server'));
    if (!name) return;
    const s = vault.listFast().find(x => x.name === name);
    if (!s) return;
    const dir = installer.BRIDGE_DIR.replace(/\\/g, '/');
    const marker = '{{vault' + (s.isFile ? '-file' : '') + ':' + name + '}}';

    // Two safe shapes, one per need. The launcher puts the value in the
    // server's environment; the proxy lets the value be a tool argument while
    // keeping it out of the transcript. Both hold a marker in .mcp.json, never
    // a key, and neither is on the network path.
    // The same interpreter the installer resolved, not a bare "node": a VS Code
    // or Claude Code started from the Finder inherits the launchd PATH
    // (/usr/bin:/bin:/usr/sbin:/sbin), which holds neither a Homebrew node nor
    // an nvm shim, so the copied snippet would die on ENOENT with no clue why.
    let nodeCmd = 'node';
    try { nodeCmd = installer.nodeExec(); } catch (e) { /* keep the plain name */ }
    const launcherCfg = JSON.stringify({
      command: nodeCmd,
      args: [dir + '/env.js', '--', 'npx', '-y', 'YOUR_MCP_SERVER'],
      env: { [name]: marker }
    }, null, 2);
    const proxyCfg = JSON.stringify({
      command: nodeCmd,
      args: [dir + '/mcp-proxy.js', '--name', 'YOUR_SERVER_ID', '--', 'npx', '-y', 'YOUR_MCP_SERVER']
    }, null, 2);

    const launcher = t('Copy launcher config');
    const proxy = t('Copy proxy config');
    const act = await vscode.window.showInformationMessage(
      t('Use {0} in an MCP server', name),
      {
        modal: true,
        detail:
          t('Most servers read a credential from their ENVIRONMENT. Use the launcher: it resolves the marker into the server\'s environment and steps aside, relaying nothing and calling nothing. The value never becomes a tool argument.') +
          '\n\n' + launcherCfg + '\n\n' +
          t('If the server needs the secret as a tool ARGUMENT, wrap it in the proxy. Claude writes {0} in the argument; the proxy substitutes the value downstream, so the transcript keeps the marker and the value never reaches the model. Set YOUR_SERVER_ID to this server\'s key in .mcp.json.', marker) +
          '\n\n' + proxyCfg
      },
      launcher, proxy);
    if (act === launcher) {
      await vscode.env.clipboard.writeText(launcherCfg);
      vscode.window.setStatusBarMessage(t('Launcher config copied, no value in it'), 4000);
    } else if (act === proxy) {
      await vscode.env.clipboard.writeText(proxyCfg);
      vscode.window.setStatusBarMessage(t('Proxy config copied, no value in it'), 4000);
    }
  }

  // --------------------------------------------------------------- description

  async function showDetails(arg) {
    const name = nameOf(arg) || await pickKey(t('Key details'));
    if (!name) return;
    const s = vault.listFast().find(x => x.name === name);
    if (!s) return;
    const when = ts => (ts ? new Date(ts).toLocaleString() : t('never'));
    const marker = '{{vault' + (s.isFile ? '-file' : '') + ':' + s.name + '}}';
    const lines = [
      t('Type: {0}, {1} characters', kindText(s.kind), String(s.length)),
      t('Marker: {0}', marker),
      t('Created: {0}', when(s.createdAt)),
      t('Created by: {0}', s.createdBy === 'claude' ? 'Claude'
        : s.createdBy === 'user' ? t('you') : t('unknown')),
      t('Last used: {0} ({1} time(s))', when(s.lastUsedAt), String(s.uses)),
      t('Expiry: {0}', s.maxUses ? t('{0} uses left', String(Math.max(0, s.maxUses - s.uses)))
        : s.expiresAt ? when(s.expiresAt) : t('none')),
      t('MCP tools: {0}', s.mcp ? t('allowed') : t('not allowed'))
    ];
    const edit = t('Edit description');
    const act = await vscode.window.showInformationMessage(
      s.name,
      { modal: true, detail: (s.note || t('No description yet.')) + '\n\n' + lines.join('\n') },
      edit);
    if (act === edit) await editNote(name);
  }

  async function editNote(arg) {
    const name = nameOf(arg) || await pickKey(t('Edit description'));
    if (!name) return;
    const s = vault.listFast().find(x => x.name === name);
    if (!s) return;
    const note = await vscode.window.showInputBox({
      title: t('Description of {0}', name),
      prompt: t('What the key is for and where the code reads it. Never the value itself.'),
      value: s.note || '',
      placeHolder: t('Mailjet API key, read by src/mail/client.ts at boot')
    });
    if (note === undefined) return;
    try { vault.setNote(name, note); notify(); }
    catch (e) { vscode.window.showErrorMessage(t('Claude Vault: {0}', errText(e))); }
  }

  // ----------------------------------------------------------------- commands

  async function addKey() {
    const existing = vault.listFast().map(s => s.name);
    const name = await vscode.window.showInputBox({
      title: t('New key: name'),
      prompt: t('You will refer to it as $NAME in Claude'),
      placeHolder: 'VPS_SSH_KEY',
      validateInput: v => {
        if (!v) return null;
        try { vault.validateName(v.toUpperCase()); } catch (e) { return errText(e); }
        return existing.indexOf(v.toUpperCase()) !== -1
          ? t('{0} already exists: creating it will replace the old value for good.', v.toUpperCase())
          : null;
      }
    });
    if (!name) return;
    const n = name.toUpperCase();

    const value = await vscode.window.showInputBox({
      title: t('New key: value of {0}', n),
      prompt: t('Encrypted on submit. It will never be displayed again.'),
      password: true,
      ignoreFocusOut: true,
      validateInput: v => (v && v.length ? null : t('Paste the key value.'))
    });
    if (!value) return;

    // Two steps, not three: expiry is set with a single click on the key,
    // and most keys do not need one. Asking for it at every creation slowed
    // down the most frequent action.
    try {
      const r = vault.put(n, value, { by: 'user' });
      notify();
      const addExpiry = t('Add an expiry');
      const act = await vscode.window.showInformationMessage(
        t('{0}, {1}. Write ${2} in Claude to use it.',
          r.replaced ? t('{0} replaced', n) : t('{0} created', n), kindText(r.kind), n),
        addExpiry);
      if (act === addExpiry) await changeTtl(n);
    } catch (e) {
      vscode.window.showErrorMessage(t('Claude Vault: {0}', errText(e)));
    }
  }

  // ------------------------------------------------------------- default values

  function getDefaults() {
    const d = context.globalState.get('vaultDefauts', null);
    return {
      ttlMs: d && typeof d.ttlMs === 'number' ? d.ttlMs : 0,   // 0 = no expiry
      burn: !!(d && d.burn),
      mcp: !!(d && d.mcp)
    };
  }

  function setDefaults(d) {
    context.globalState.update('vaultDefauts', {
      ttlMs: Number(d.ttlMs) || 0, burn: !!d.burn, mcp: !!d.mcp
    });
    notify();
  }

  // Creation from the panel. The webview is never taken at its word: the
  // name is revalidated here, and this validation is what is authoritative.
  function createFromPanel(m) {
    try {
      const n = vault.validateName(String(m && m.name || '').toUpperCase());
      const value = String(m && m.value || '');
      if (!value) throw new Error(t('Empty value'));
      const r = vault.put(n, value, {
        expiresAt: m.burn ? null : (Number(m.ttlMs) > 0 ? Date.now() + Number(m.ttlMs) : null),
        maxUses: m.burn ? 1 : null,
        mcp: !!m.mcp,
        by: 'user'
      });
      notify();
      vscode.window.setStatusBarMessage(
        t('{0}, {1}. Write ${2} in Claude to use it.',
          r.replaced ? t('{0} replaced', n) : t('{0} created', n), kindText(r.kind), n), 6000);
    } catch (e) {
      vscode.window.showErrorMessage(t('Claude Vault: {0}', errText(e)));
    }
  }

  // All the actions for a key in one place: a single click on the row is
  // enough, no need to remember eight palette commands anymore.
  async function keyActions(arg) {
    const name = nameOf(arg) || await pickKey(t('Key actions'));
    if (!name) return;
    const s = vault.listFast().find(x => x.name === name);
    if (!s) return;
    const marker = '{{vault' + (s.isFile ? '-file' : '') + ':' + s.name + '}}';
    const choice = await vscode.window.showQuickPick([
      { label: '$(copy) ' + t('Copy marker'), description: marker, act: 'copy' },
      { label: '$(info) ' + t('Details'), description: s.note || t('no description'), act: 'info' },
      { label: '$(server) ' + t('Use in an MCP server'), description: t('launcher configuration'), act: 'mcp' },
      { label: '$(clock) ' + t('Change expiry'), description: s.maxUses
          ? t('counted uses') : (s.expiresAt ? t('scheduled') : t('none')), act: 'ttl' },
      { label: (s.mcp ? '$(circle-slash) ' + t('Remove MCP authorisation')
                      : '$(plug) ' + t('Allow for MCP')),
        description: s.mcp ? t('currently allowed') : t('denied by default'), act: 'mcp' },
      { label: '$(eye) ' + t('Reveal'),
        description: t('copies the plain value to the clipboard'), act: 'reveal' },
      { label: '$(trash) ' + t('Delete'), description: t('irreversible'), act: 'del' }
    ], { title: name + '  ·  ' + kindText(s.kind), placeHolder: t('What do you want to do?') });
    if (!choice) return;
    if (choice.act === 'copy') return copyMarker(name);
    if (choice.act === 'info') return showDetails(name);
    if (choice.act === 'mcp') return mcpSnippet(name);
    if (choice.act === 'ttl') return changeTtl(name);
    if (choice.act === 'mcp') return toggleMcp(name);
    if (choice.act === 'reveal') return revealKey(name);
    if (choice.act === 'del') return deleteKey(name);
  }

  async function pickKey(title) {
    const secrets = vault.listFast();
    if (!secrets.length) {
      vscode.window.showInformationMessage(t('The vault is empty.'));
      return null;
    }
    const pick = await vscode.window.showQuickPick(
      secrets.map(s => ({ label: s.name, description: kindText(s.kind), name: s.name })),
      { title, matchOnDescription: true, placeHolder: t('Filter…') });
    return pick ? pick.name : null;
  }

  async function deleteKey(arg) {
    const name = nameOf(arg) || await pickKey(t('Delete a key'));
    if (!name) return;
    const del = t('Delete');
    const yes = await vscode.window.showWarningMessage(
      t('Delete {0}?', name),
      { modal: true, detail: t('The value cannot be recovered. No copy of it is kept.') },
      del);
    if (yes !== del) return;
    try {
      vault.remove(name);
      sessionKeys.delete(name);
      notify();
    } catch (e) { vscode.window.showErrorMessage(t('Claude Vault: {0}', errText(e))); }
  }

  async function changeTtl(arg) {
    const name = nameOf(arg) || await pickKey(t('Change expiry'));
    if (!name) return;
    const ttl = await vscode.window.showQuickPick(ttlChoices(), {
      title: t('New expiry for {0}', name)
    });
    if (!ttl) return;
    try {
      vault.setTtl(name, ttl.ms ? Date.now() + ttl.ms : null, ttl.maxUses || null);
      if (ttl.session) sessionKeys.add(name); else sessionKeys.delete(name);
      notify();
    } catch (e) { vscode.window.showErrorMessage(t('Claude Vault: {0}', errText(e))); }
  }

  // Copies the MARKER, not the value. That is exactly the point: it is inert.
  async function copyMarker(arg) {
    const name = nameOf(arg) || await pickKey(t('Copy marker'));
    if (!name) return;
    const s = vault.listFast().find(x => x.name === name);
    const marker = '{{vault' + (s && s.isFile ? '-file' : '') + ':' + name + '}}';
    await vscode.env.clipboard.writeText(marker);
    vscode.window.setStatusBarMessage(
      t('{0} copied: an inert marker, not the value', marker), 4000);
  }

  // Reveal: deliberately absent from the panel and from the hover actions.
  // It exists only in the command palette, so it stays a deliberate action
  // and never a stray click. The value goes to the clipboard, not to the
  // screen: a secret that is displayed is a secret captured by the first
  // screen share or the first screenshot.
  async function revealKey(arg) {
    const name = nameOf(arg) || await pickKey(t('Reveal a key'));
    if (!name) return;
    const copy = t('Copy to clipboard');
    const yes = await vscode.window.showWarningMessage(
      t('Copy the value of {0} to the clipboard?', name),
      {
        modal: true,
        detail: t('The vault exists so this value never comes back out. Copying it takes it out of that protection: do not paste it into the Claude chat, or into a file tracked by git. The access will be recorded in the log.')
      },
      copy);
    if (yes !== copy) return;
    try {
      const r = vault.reveal(name);
      await vscode.env.clipboard.writeText(r.value);
      notify();
      vscode.window.showInformationMessage(
        t('{0} copied: {1}, {2} characters. Remember to clear your clipboard afterwards.',
          name, kindText(r.entry.kind), String(r.entry.length)));
    } catch (e) {
      vscode.window.showErrorMessage(t('Claude Vault: {0}', errText(e)));
    }
  }

  // MCP authorisation: asked for explicitly because it changes the level of
  // protection. In a shell, the value only ever exists in the memory of the
  // spawned process; in an MCP call, it is placed in the tool's arguments
  // and sent off to the MCP server's provider.
  async function toggleMcp(arg) {
    const name = nameOf(arg) || await pickKey(t('Allow a key for MCP tools'));
    if (!name) return;
    const s = vault.listFast().find(x => x.name === name);
    if (!s) return;
    if (s.mcp) {
      vault.setMcp(name, false);
      notify();
      vscode.window.showInformationMessage(t('{0}: MCP authorisation removed.', name));
      return;
    }
    const allow = t('Allow for MCP');
    const yes = await vscode.window.showWarningMessage(
      t('Allow {0} in MCP tool calls?', name),
      {
        modal: true,
        // Untranslated on purpose, like the rest added after the localisation
        // pass. It states what actually happens now that local servers are
        // auto-wrapped.
        detail: t('In a shell command the value only ever lives in the memory of the spawned process. In an MCP call it is placed in the tool arguments and sent to the MCP server. Only grant this when that server belongs to the service the secret is meant for anyway.') +
          '\n\n' + t('Local MCP servers are wrapped by the extension, so Claude can use this key in a tool call and the value is resolved by the vault proxy, out of the transcript, with nothing to configure. Only a remote HTTP server would still receive the value as a tool argument written to the transcript; grant this only if that server is the secret\'s destination.')
      },
      allow);
    if (yes !== allow) return;
    vault.setMcp(name, true);
    // Make sure the local MCP servers are wrapped, so the grant takes effect
    // with no manual configuration. Idempotent, writes only if something changed.
    try { installer.wrapMcpServers(); } catch (e) { /* the manual snippet remains */ }
    notify();
    vscode.window.showInformationMessage(t('{0}: allowed for MCP tools.', name));
  }

  // Log: a real VS Code tab, filterable, styled to match the theme, not a
  // plain-text output channel that can neither be sorted nor read back.
  const EVENT_LABEL = {
    create: t('Creation'), replace: t('Replacement'), delete: t('Deletion'),
    use: t('Use'), burn: t('Burnt'), expire: t('Expired'), mcp: t('MCP authorisation'),
    ttl: t('Expiry changed'), reveal: t('Revealed'), 'revoke-all': t('Full revocation')
  };
  // Three families: what exposes a value, what modifies the vault, and what happens
  // on its own. That is the useful reading when looking for who touched what.
  const EVENT_CLASS = {
    use: 'lecture', reveal: 'alerte', 'revoke-all': 'alerte',
    create: 'ecriture', replace: 'ecriture', delete: 'ecriture',
    ttl: 'ecriture', mcp: 'ecriture',
    burn: 'auto', expire: 'auto'
  };

  // Who acted. Stored on entries written since the tracer exists; for older
  // ones, inferred only where the code path allows a single author (a use is
  // always the agent, a reveal always the owner), left blank otherwise.
  function actorOf(e) {
    if (e.by === 'claude') return 'Claude';
    if (e.by === 'user') return t('you');
    if (e.event === 'use' || e.event === 'replace-request') return 'Claude';
    if (e.event === 'burn' || e.event === 'expire') return '';
    if (e.event === 'create' || e.event === 'replace') return '';
    return t('you');
  }

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"]/g, c =>
      c === '&' ? '&amp;' : c === '<' ? '&lt;' : c === '>' ? '&gt;' : '&quot;');
  }

  // The panel follows the VS Code display language: l10n bundles are resolved by
  // the host at activation, so there is nothing for this extension to switch on
  // its own. Rather than pretend otherwise with a dead dropdown, we show which
  // language is in use and hand over to the native language picker.
  function chosenLang() {
    return context.globalState.get('uiLanguage', 'auto');
  }

  // The choice belongs to the extension, not to the editor. Changing it reloads
  // the bundle and rebuilds every surface right away: the panel, this window,
  // and the access log if it is open. Nothing is reloaded, nothing restarts.
  function setLang(code) {
    const want = i18n.LANGS.indexOf(code) === -1 ? 'auto' : code;
    context.globalState.update('uiLanguage', want);
    i18n.load(want, vscode.env.language);
    // Mirror the resolved language to the vault, so the hooks can address the
    // user in it when they refuse an MCP call the user will read.
    try { vault.setUiLang(i18n.current()); } catch (e) { /* hooks fall back to English */ }
    vscode.commands.executeCommand('claudeLimits.relocalize');
    if (settingsPanel) settingsPanel.webview.html = settingsHtml();
    if (auditPanel) auditPanel.webview.html = auditHtml();
    notify();
  }

  function langOptions() {
    const cur = chosenLang();
    const opts = [['auto', t('Same as VS Code') + ' (' + i18n.name(
      i18n.LANGS.indexOf(String(vscode.env.language || 'en').split(/[-_]/)[0]) === -1
        ? 'en' : String(vscode.env.language || 'en').split(/[-_]/)[0]) + ')']];
    for (const c of i18n.LANGS) opts.push([c, i18n.name(c)]);
    return opts.map(([v, label]) =>
      '<option value="' + v + '"' + (v === cur ? ' selected' : '') + '>' + esc(label) + '</option>'
    ).join('');
  }

  // ---------------------------------------------------------- settings window

  let settingsPanel = null;
  function showSettings() {
    if (settingsPanel) {
      settingsPanel.webview.html = settingsHtml();
      settingsPanel.reveal(vscode.ViewColumn.Active);
      return;
    }
    settingsPanel = vscode.window.createWebviewPanel(
      'claudeVault.settings', t('Claude Vault: settings'),
      vscode.ViewColumn.Active, { enableScripts: true });
    settingsPanel.webview.html = settingsHtml();
    settingsPanel.webview.onDidReceiveMessage(m => {
      if (!m) return;
      if (m.type === 'defaults') {
        setDefaults(m);
        vscode.window.setStatusBarMessage(t('Defaults saved'), 3000);
      }
      if (m.type === 'settingsMsg') {
        const c = vscode.workspace.getConfiguration('claudeLimits');
        const target = vscode.ConfigurationTarget.Global;
        Promise.all([
          c.update('pollSeconds', Math.max(120, Number(m.pollSeconds) || 210), target),
          c.update('pauseWhenExhausted', !!m.pause, target),
          c.update('showCredits', !!m.credits, target),
          c.update('alerts', !!m.alerts, target),
          c.update('statusBar', !!m.statusBar, target),
          c.update('badge', !!m.badge, target),
          c.update('statusBarPosition', m.statusPos === 'left' ? 'left' : 'right', target),
          c.update('statusBarStyle',
            ['classic', 'accent', 'prominent'].indexOf(m.statusStyle) !== -1 ? m.statusStyle : 'prominent', target),
          c.update('statusBarWeek', !!m.statusWeek, target)
        ]).then(() => {
          vscode.window.setStatusBarMessage(t('Settings saved'), 3000);
          if (settingsPanel) settingsPanel.webview.html = settingsHtml();
        }, e => vscode.window.showErrorMessage(t('Claude Vault: {0}', errText(e))));
      }
      if (m.type === 'connect') connect();
      if (m.type === 'audit') showAudit();
      if (m.type === 'revoke') revokeAll();
      if (m.type === 'langue') setLang(m.value);
    });
    settingsPanel.onDidDispose(() => { settingsPanel = null; });
    context.subscriptions.push(settingsPanel);
  }

  function settingsHtml() {
    const d = getDefaults();
    const st = installer.status(version);
    const h = vault.healthCheck();
    const nonce = require('crypto').randomBytes(16).toString('base64');
    const cl = vscode.workspace.getConfiguration('claudeLimits');
    const poll = Math.max(120, cl.get('pollSeconds', 210));
    // A whole number of minutes reads as "3 min"; a remainder as "3 min 30 s",
    // built from the two existing translations so no bundle needs a new key.
    // "210 s" for the default was confusing sitting among the minute options.
    const intervalLabel = s => {
      if (s < 60) return t('{0} s', String(s));
      const m = Math.floor(s / 60), r = s % 60;
      return r === 0 ? t('{0} min', String(m))
                     : t('{0} min', String(m)) + ' ' + t('{0} s', String(r));
    };
    const checkedAttr = v => (v ? ' checked' : '');
    const opt = (v, txt) => '<option value="' + v + '"' +
      ((d.burn ? 'burn' : String(d.ttlMs)) === String(v) ? ' selected' : '') + '>' + txt + '</option>';

    return `<!DOCTYPE html><html lang="${esc(vscode.env.language || 'en')}"><head><meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy"
      content="default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${nonce}';">
<style>
  /* A centred, single column like the native VS Code settings editor: sober,
     generous spacing, one setting per row with its own description. */
  :root { --line: color-mix(in srgb, var(--vscode-foreground) 12%, transparent); }
  body { font-family: var(--vscode-font-family); font-size: 13px; color: var(--vscode-foreground);
         margin: 0; padding: 0; line-height: 1.45; }
  .wrap { max-width: 680px; margin: 0 auto; padding: 32px 32px 64px; }
  h1 { font-size: 20px; font-weight: 600; margin: 0 0 4px; letter-spacing: -.2px; }
  .sub { font-size: 12.5px; opacity: .6; margin: 0 0 8px; }
  .sect { margin-top: 34px; padding-top: 22px; border-top: 1px solid var(--line); }
  .sect > h2 { font-size: 11px; font-weight: 700; letter-spacing: .6px; text-transform: uppercase;
               opacity: .55; margin: 0 0 16px; }
  .row { margin-bottom: 20px; }
  .row:last-child { margin-bottom: 0; }
  .name { font-size: 13px; font-weight: 600; margin-bottom: 2px; }
  .desc { font-size: 12px; opacity: .6; line-height: 1.5; margin: 2px 0 8px; max-width: 60ch; }
  select { font-family: inherit; font-size: 12.5px; padding: 5px 9px; border-radius: 4px; min-width: 260px;
           color: var(--vscode-settings-dropdownForeground, var(--vscode-input-foreground));
           background: var(--vscode-settings-dropdownBackground, var(--vscode-input-background));
           border: 1px solid var(--vscode-settings-dropdownBorder, var(--vscode-input-border, transparent)); }
  select:hover { border-color: color-mix(in srgb, var(--vscode-foreground) 30%, transparent); }
  select:focus { outline: none; border-color: var(--vscode-focusBorder); }
  .toggle { display: flex; align-items: center; gap: 9px; cursor: pointer; }
  .toggle input { margin: 0; accent-color: var(--vscode-checkbox-selectBackground, var(--vscode-button-background)); }
  .toggle .name { margin: 0; font-weight: 500; }
  button { appearance: none; font-family: inherit; font-size: 12.5px; padding: 5px 14px; cursor: pointer;
           border-radius: 4px; border: 0;
           background: var(--vscode-button-background); color: var(--vscode-button-foreground); }
  button:hover { background: var(--vscode-button-hoverBackground); }
  button.doux { background: none; color: var(--vscode-foreground); opacity: .85;
           border: 1px solid color-mix(in srgb, var(--vscode-foreground) 22%, transparent); }
  button.doux:hover { background: var(--vscode-list-hoverBackground); opacity: 1; }
  button:focus-visible { outline: 1px solid var(--vscode-focusBorder); }
  .etat { font-size: 12.5px; padding: 10px 13px; border-radius: 4px; margin-bottom: 12px;
          border-left: 3px solid var(--vscode-charts-green);
          background: color-mix(in srgb, var(--vscode-charts-green) 8%, transparent); }
  .etat.ko { border-left-color: var(--vscode-charts-yellow);
             background: color-mix(in srgb, var(--vscode-charts-yellow) 9%, transparent); }
  .actions { display: flex; gap: 8px; margin-top: 4px; flex-wrap: wrap; }
</style></head><body>
<div class="wrap">
<h1>${esc(t('Claude Monitor'))}</h1>
<div class="sub">${esc(t('The usage monitor and the vault, in one place.'))}</div>

<div class="sect">
<h2>${esc(t('Usage tracking'))}</h2>
<div class="row">
  <div class="name">${esc(t('Refresh interval'))}</div>
  <div class="desc">${esc(t('A cache shared across every VS Code window means one real request feeds them all. Going below 2 minutes risks a 429.'))}</div>
  <select id="poll">
    ${[120, 180, 210, 300, 600, 900, 1800].map(s => '<option value="' + s + '"' +
      (poll === s ? ' selected' : '') + '>' + esc(intervalLabel(s)) + '</option>').join('')}
  </select>
</div>
<div class="row">
  <label class="toggle"><input type="checkbox" id="pause"${checkedAttr(cl.get('pauseWhenExhausted', true))}>
    <span class="name">${esc(t('Suspend calls when a limit is exhausted'))}</span></label>
  <div class="desc">${esc(t('Follows the reset time Anthropic reports instead of polling while you are blocked. The refresh button overrides it, which is useful if you unblock your quota another way, with credits for example.'))}</div>
</div>
<div class="row">
  <label class="toggle"><input type="checkbox" id="credits"${checkedAttr(cl.get('showCredits', true))}>
    <span class="name">${esc(t('Show paid credits'))}</span></label>
  <div class="desc">${esc(t('Shows spending beyond the plan, in your account currency. The row only appears when extra usage is enabled in your Claude settings, otherwise there is nothing to show.'))}</div>
</div>
<div class="row">
  <label class="toggle"><input type="checkbox" id="alerts"${checkedAttr(cl.get('alerts', true))}>
    <span class="name">${esc(t('Threshold notifications (80%, 95%, weekly 90%)'))}</span></label>
</div>
</div>

<div class="sect">
<h2>${esc(t('Appearance'))}</h2>
<div class="row">
  <label class="toggle"><input type="checkbox" id="sbar"${checkedAttr(cl.get('statusBar', true))}>
    <span class="name">${esc(t('Show in the status bar'))}</span></label>
</div>
<div class="row">
  <div class="name">${esc(t('Status bar style'))}</div>
  <div class="desc">${esc(t('Prominent is a coloured pill at all times, amber, red near a limit. VS Code keeps the plain theme and colours only when a limit fills up.'))}</div>
  <select id="sstyle">
    ${['prominent', 'classic'].map(v => '<option value="' + v + '"' +
      (cl.get('statusBarStyle', 'prominent') === v ? ' selected' : '') + '>' +
      esc(v === 'prominent' ? t('Prominent') : t('VS Code')) +
      '</option>').join('')}
  </select>
</div>
<div class="row">
  <div class="name">${esc(t('Status bar position'))}</div>
  <div class="desc">${esc(t('The status bar has only two sides, VS Code has no centre for it.'))}</div>
  <select id="spos">
    <option value="right"${cl.get('statusBarPosition', 'right') === 'right' ? ' selected' : ''}>${esc(t('Right'))}</option>
    <option value="left"${cl.get('statusBarPosition', 'right') === 'left' ? ' selected' : ''}>${esc(t('Left'))}</option>
  </select>
</div>
<div class="row">
  <label class="toggle"><input type="checkbox" id="sweek"${checkedAttr(cl.get('statusBarWeek', false))}>
    <span class="name">${esc(t('Also show the week in the status bar'))}</span></label>
</div>
<div class="row">
  <label class="toggle"><input type="checkbox" id="badge"${checkedAttr(cl.get('badge', true))}>
    <span class="name">${esc(t('Show the session percentage on the activity-bar icon'))}</span></label>
</div>
</div>

<div class="sect">
<h2>${esc(t('Defaults for new keys'))}</h2>
<div class="row">
  <div class="name">${esc(t('Expiry'))}</div>
  <div class="desc">${esc(t('Pre-fills the panel form. Every key stays editable afterwards.'))}</div>
  <select id="ttl">
    ${opt(0, t('None'))}${opt(300000, t('5 minutes'))}${opt(3600000, t('1 hour'))}
    ${opt(28800000, t('8 hours'))}${opt(86400000, t('24 hours'))}${opt(604800000, t('7 days'))}
    ${opt('burn', t('Burn after first use'))}
  </select>
</div>
<div class="row">
  <label class="toggle"><input type="checkbox" id="mcp"${d.mcp ? ' checked' : ''}>
    <span class="name">${esc(t('Allow new keys for MCP tools'))}</span></label>
  <div class="desc">${esc(t('Not recommended: in an MCP call the value is placed in the tool arguments and sent to the MCP server, whereas in a shell command it never leaves the memory of the spawned process.'))}</div>
</div>
</div>

<div class="sect">
<h2>${esc(t('Language'))}</h2>
<div class="row">
  <div class="name">${esc(t('Interface language'))}</div>
  <div class="desc">${esc(t('Applies immediately, independently of the VS Code language. Command palette entries are the exception: VS Code resolves those itself, before the extension starts.'))}</div>
  <select id="lang">${langOptions()}</select>
</div>
</div>

<div class="sect">
<h2>${esc(t('Connection to Claude Code'))}</h2>
<div class="etat${st.installed && st.upToDate ? '' : ' ko'}">
  ${esc(st.installed && st.upToDate
    ? t('Connected · hooks {0}', installer.EVENTS.join(', '))
    : (st.installed ? t('Connection established with an older version: update it.')
                    : t('Not connected: Claude Code cannot read this vault yet.')))}
</div>
${issuesText(h.issues).map(i => '<div class="etat ko">' + esc(i.msg) + '</div>').join('')}
<div class="actions">
  <button class="doux" id="pont">${esc(st.installed ? t('Update the connection') : t('Connect to Claude Code'))}</button>
  <button class="doux" id="jour">${esc(t('Access log'))}</button>
  <button class="doux" id="rev">${esc(t('Revoke everything'))}</button>
</div>
</div>
</div>

<script nonce="${nonce}">
(function () {
  'use strict';
  var api = acquireVsCodeApi();
  var $ = function (id) { return document.getElementById(id); };

  // Apply on change, like the native settings editor: no Save button to hunt for.
  function pushConfig() {
    api.postMessage({
      type: 'settingsMsg',
      pollSeconds: Number($('poll').value),
      pause: $('pause').checked,
      credits: $('credits').checked,
      alerts: $('alerts').checked,
      statusBar: $('sbar').checked,
      badge: $('badge').checked,
      statusPos: $('spos').value,
      statusStyle: $('sstyle').value,
      statusWeek: $('sweek').checked
    });
  }
  function pushDefaults() {
    var v = $('ttl').value;
    api.postMessage({ type: 'defaults', ttlMs: v === 'burn' ? 0 : Number(v),
                      burn: v === 'burn', mcp: $('mcp').checked });
  }
  ['poll', 'pause', 'credits', 'alerts', 'sbar', 'badge', 'spos', 'sstyle', 'sweek']
    .forEach(function (id) { $(id).addEventListener('change', pushConfig); });
  ['ttl', 'mcp'].forEach(function (id) { $(id).addEventListener('change', pushDefaults); });
  $('lang').addEventListener('change', function (e) { api.postMessage({ type: 'langue', value: e.currentTarget.value }); });
  $('pont').addEventListener('click', function () { api.postMessage({ type: 'connect' }); });
  $('jour').addEventListener('click', function () { api.postMessage({ type: 'audit' }); });
  $('rev').addEventListener('click', function () { api.postMessage({ type: 'revoke' }); });
})();
</script></body></html>`;
  }

  let auditPanel = null;
  function showAudit() {
    if (auditPanel) {
      auditPanel.webview.html = auditHtml();
      auditPanel.reveal(vscode.ViewColumn.Active);
      return;
    }
    auditPanel = vscode.window.createWebviewPanel(
      'claudeVault.audit', t('Claude Vault: access log'),
      vscode.ViewColumn.Active, { enableScripts: true });
    auditPanel.webview.html = auditHtml();
    auditPanel.webview.onDidReceiveMessage(m => {
      if (m && m.type === 'refresh' && auditPanel) auditPanel.webview.html = auditHtml();
    });
    auditPanel.onDidDispose(() => { auditPanel = null; });
    context.subscriptions.push(auditPanel);
    // Detach it into its own VS Code window: the log is a reference you keep open
    // beside your work, not a tab that steals the editor. Needs a recent VS Code;
    // if the command is absent it simply stays a tab.
    setTimeout(() => {
      vscode.commands.executeCommand('workbench.action.moveEditorToNewWindow')
        .then(undefined, () => { /* older VS Code: it stays a tab, fine */ });
    }, 60);
  }

  function auditHtml() {
    const entries = vault.auditLog(500);
    const nonce = require('crypto').randomBytes(16).toString('base64');
    const n = {};
    for (const e of entries) n[e.event] = (n[e.event] || 0) + 1;

    const rowsHtml = entries.map(e => {
      const d = new Date(e.at);
      const cls = EVENT_CLASS[e.event] || 'auto';
      const who = actorOf(e);
      return '<tr data-c="' + cls + '" data-k="' +
        esc(((e.name || '') + ' ' + (EVENT_LABEL[e.event] || e.event) + ' ' + who).toLowerCase()) + '">' +
        '<td class="t">' + esc(d.toLocaleDateString()) + ' <b>' + esc(d.toLocaleTimeString()) + '</b></td>' +
        '<td><span class="ev ' + cls + '">' + esc(EVENT_LABEL[e.event] || e.event) + '</span></td>' +
        '<td class="n">' + esc(e.name || '') + '</td>' +
        '<td class="w' + (who === 'Claude' ? ' claude' : '') + '">' + esc(who) + '</td>' +
        '<td class="d">' + esc(e.detail ? t(e.detail) : '') + '</td></tr>';
    }).join('');

    const summary = [
      t('{0} event(s)', String(entries.length)),
      n.use ? t('{0} use(s)', String(n.use)) : null,
      n.reveal ? t('{0} reveal(s)', String(n.reveal)) : null
    ].filter(Boolean).join(' · ');

    return `<!DOCTYPE html><html lang="${esc(vscode.env.language || 'en')}"><head><meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy"
      content="default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${nonce}';">
<style>
  body { font-family: var(--vscode-font-family); font-size: 13px; color: var(--vscode-foreground);
         padding: 18px 24px 40px; max-width: 1100px; }
  h1 { font-size: 15px; font-weight: 600; margin: 0 0 3px; }
  .sub { opacity: .55; font-size: 12px; margin-bottom: 16px; }
  .bar { display: flex; gap: 6px; align-items: center; margin-bottom: 14px; flex-wrap: wrap; }
  input { flex: 1 1 200px; min-width: 150px; font-family: inherit; font-size: 12px; padding: 4px 8px;
          color: var(--vscode-input-foreground); background: var(--vscode-input-background);
          border: 1px solid var(--vscode-input-border, transparent); border-radius: 2px; }
  input:focus { outline: 1px solid var(--vscode-focusBorder); }
  button { appearance: none; font-family: inherit; font-size: 12px; padding: 4px 10px; cursor: pointer;
           border: 1px solid color-mix(in srgb, var(--vscode-foreground) 20%, transparent);
           border-radius: 2px; background: none; color: var(--vscode-foreground); opacity: .7; }
  button:hover { opacity: 1; background: var(--vscode-list-hoverBackground); }
  button[aria-pressed="true"] { opacity: 1; border-color: var(--vscode-focusBorder);
           background: color-mix(in srgb, var(--vscode-foreground) 8%, transparent); }
  button:focus-visible { outline: 1px solid var(--vscode-focusBorder); }
  table { border-collapse: collapse; width: 100%; }
  th { text-align: left; font-weight: 600; font-size: 11px; opacity: .5; padding: 0 10px 6px 0;
       text-transform: uppercase; letter-spacing: .4px; }
  td { padding: 5px 10px 5px 0; vertical-align: top;
       border-top: 1px solid color-mix(in srgb, var(--vscode-foreground) 9%, transparent); }
  tr:hover td { background: var(--vscode-list-hoverBackground); }
  .t { white-space: nowrap; opacity: .6; font-variant-numeric: tabular-nums; }
  .t b { font-weight: 600; opacity: .95; }
  .n { font-family: var(--vscode-editor-font-family, monospace); font-size: 12px; white-space: nowrap; }
  .w { white-space: nowrap; opacity: .8; }
  .w.claude { color: var(--vscode-charts-orange); }
  .d { opacity: .55; }
  .ev { font-size: 11px; padding: 1px 7px; border-radius: 9px; white-space: nowrap;
        border: 1px solid currentColor; }
  .ev.lecture  { color: var(--vscode-charts-blue); }
  .ev.ecriture { color: var(--vscode-charts-green); }
  .ev.alerte   { color: var(--vscode-charts-red); }
  .ev.auto     { opacity: .55; }
  .vide { opacity: .5; padding: 30px 0; text-align: center; }
  .note { margin-top: 24px; font-size: 11.5px; opacity: .5; line-height: 1.6;
          border-left: 2px solid color-mix(in srgb, var(--vscode-foreground) 20%, transparent);
          padding-left: 12px; }
</style></head><body>
<h1>${esc(t('Access log'))}</h1>
<div class="sub">${esc(summary)} · ${esc(t('newest first'))}</div>
<div class="bar">
  <input id="q" type="search" placeholder="${esc(t('Filter by key or by type…'))}" autocomplete="off">
  <button data-f="tout" aria-pressed="true">${esc(t('All'))}</button>
  <button data-f="lecture">${esc(t('Uses'))}</button>
  <button data-f="ecriture">${esc(t('Changes'))}</button>
  <button data-f="alerte">${esc(t('Sensitive'))}</button>
  <button id="maj">${esc(t('Refresh'))}</button>
</div>
${entries.length
  ? '<table><thead><tr><th>' + esc(t('When')) + '</th><th>' + esc(t('Event')) +
    '</th><th>' + esc(t('Key')) + '</th><th>' + esc(t('By')) + '</th><th>' + esc(t('Detail')) + '</th></tr></thead>' +
    '<tbody id="corps">' + rowsHtml + '</tbody></table>'
  : '<div class="vide">' + esc(t('No access recorded yet.')) + '</div>'}
<div class="note">${esc(t('This log never contains a secret value: only names, dates and access types. "Use" means a key was injected into a command without ever being revealed; "Revealed" means it was copied in plain text to the clipboard.'))}</div>
<script nonce="${nonce}">
(function () {
  'use strict';
  var api = acquireVsCodeApi();
  var q = document.getElementById('q');
  var corps = document.getElementById('corps');
  var activeFilter = 'tout';

  function applyFilter() {
    if (!corps) return;
    var texte = (q.value || '').trim().toLowerCase();
    var rows = corps.rows, vus = 0;
    for (var i = 0; i < rows.length; i++) {
      var okC = activeFilter === 'tout' || rows[i].getAttribute('data-c') === activeFilter;
      var okT = !texte || rows[i].getAttribute('data-k').indexOf(texte) !== -1;
      var ok = okC && okT;
      rows[i].style.display = ok ? '' : 'none';
      if (ok) vus++;
    }
  }

  if (q) q.addEventListener('input', applyFilter);
  var bs = document.querySelectorAll('[data-f]');
  for (var j = 0; j < bs.length; j++) {
    bs[j].addEventListener('click', function (e) {
      activeFilter = e.currentTarget.getAttribute('data-f');
      for (var k = 0; k < bs.length; k++) {
        bs[k].setAttribute('aria-pressed', bs[k] === e.currentTarget ? 'true' : 'false');
      }
      applyFilter();
    });
  }
  document.getElementById('maj').addEventListener('click', function () {
    api.postMessage({ type: 'refresh' });
  });
  if (q) q.focus();
})();
</script></body></html>`;
  }

  async function revokeAll() {
    const revoke = t('Revoke everything');
    const yes = await vscode.window.showWarningMessage(
      t('Revoke the whole vault?'),
      {
        modal: true,
        detail: t('The master key is regenerated: every key becomes unreadable immediately and permanently. Use this if you believe the machine is compromised.')
      },
      revoke);
    if (yes !== revoke) return;
    try {
      const n = vault.revokeAll();
      sessionKeys.clear();
      notify();
      vscode.window.showWarningMessage(
        t('{0} key(s) revoked. The vault starts empty again.', String(n)));
    } catch (e) { vscode.window.showErrorMessage(t('Claude Vault: {0}', errText(e))); }
  }

  async function connect() {
    try {
      installer.install(__dirname, version);
      try { vault.setUiLang(i18n.current()); } catch (e) { /* hooks fall back to English */ }
      try { installer.wrapMcpServers(); } catch (e) { /* the manual snippet remains */ }
      notify();
      vscode.window.showInformationMessage(
        t('Connected to Claude Code. Restart a session for the hooks to take effect.'));
    } catch (e) {
      vscode.window.showErrorMessage(t('Cannot connect: {0}', errText(e)));
    }
  }

  context.subscriptions.push(
    vscode.commands.registerCommand('claudeVault.add', addKey),
    vscode.commands.registerCommand('claudeVault.delete', deleteKey),
    vscode.commands.registerCommand('claudeVault.setTtl', changeTtl),
    vscode.commands.registerCommand('claudeVault.copyMarker', copyMarker),
    vscode.commands.registerCommand('claudeVault.reveal', revealKey),
    vscode.commands.registerCommand('claudeVault.toggleMcp', toggleMcp),
    vscode.commands.registerCommand('claudeVault.actions', keyActions),
    vscode.commands.registerCommand('claudeVault.settings', showSettings),
    vscode.commands.registerCommand('claudeVault.audit', showAudit),
    vscode.commands.registerCommand('claudeVault.revokeAll', revokeAll),
    vscode.commands.registerCommand('claudeVault.connect', connect),
    vscode.commands.registerCommand('claudeVault.details', showDetails),
    vscode.commands.registerCommand('claudeVault.mcpSnippet', mcpSnippet),
    vscode.commands.registerCommand('claudeVault.setNote', editNote),
    vscode.commands.registerCommand('claudeVault.autoApprove', toggleAutoApprove)
  );

  // Sweep for expirations. One minute is enough: the webview animates its bars on
  // its own between passes, without asking the extension for anything. The vault
  // also changes outside the extension: a hook that burns a single-use key deletes
  // it without going through here, so state is compared on every tick, or the panel
  // would stay stuck on a key that is gone.
  let fingerprint = vault.listFast().map(s => s.name + ':' + s.uses).join('|');
  const sweep = setInterval(() => {
    reviewPending();          // safety net if fs.watch is unavailable or died
    const gone = vault.sweep();
    vault.sweepTmp(3600000);
    if (gone.length) {
      vscode.window.showInformationMessage(t('{0}: expired and removed.', gone.join(', ')));
    }
    const nowSig = vault.listFast().map(s => s.name + ':' + s.uses).join('|');
    if (nowSig !== fingerprint) { fingerprint = nowSig; notify(); }
  }, 60000);

  // A key can now appear without the extension doing anything: Claude creates
  // one by piping a value into add.js. Waiting up to a minute for the sweep to
  // notice would make the panel look broken at the exact moment the user is
  // watching it. The watcher is a shortcut, not a replacement: if fs.watch is
  // unavailable or dies, the sweep still catches up.
  let vaultTimer = null;
  let vaultWatcher = null;
  const reread = () => {
    vaultTimer = null;
    reviewPending();
    const nowSig = vault.listFast().map(s => s.name + ':' + s.uses).join('|');
    if (nowSig !== fingerprint) { fingerprint = nowSig; notify(); }
  };
  try {
    vaultWatcher = fs.watch(vault.VAULT_DIR, (event, fname) => {
      if (fname && fname !== path.basename(vault.VAULT_PATH)) return;
      // Debounced: an atomic write is a create then a rename, so two events.
      if (vaultTimer) clearTimeout(vaultTimer);
      vaultTimer = setTimeout(reread, 250);
    });
    vaultWatcher.on('error', () => {
      try { vaultWatcher.close(); } catch (e) { /* already gone */ }
      vaultWatcher = null;
    });
  } catch (e) { /* fs.watch unavailable: the sweep is enough */ }

  context.subscriptions.push({
    dispose: () => {
      clearInterval(sweep);
      if (vaultTimer) clearTimeout(vaultTimer);
      if (vaultWatcher) { try { vaultWatcher.close(); } catch (e) { /* shutting down */ } }
      for (const n of sessionKeys) { try { vault.remove(n); } catch (e) { /* shutting down */ } }
      try { vault.sweepTmp(0); } catch (e) { /* shutting down */ }
    }
  });

  vault.sweep();

  // Automatic connection: the user has nothing to click for Claude Code to know
  // how to read the vault. We only install our own entries, the merge is
  // non-destructive, and a timestamped backup is written before any modification,
  // that is what makes the automation acceptable on a configuration file that is
  // not ours. The manual button remains as a safety net if the write fails
  // (permissions, locked file, disk full).
  try {
    const st = installer.status(version);
    if (!st.installed || !st.upToDate) {
      installer.install(__dirname, version);
      notify();
      vscode.window.setStatusBarMessage(
        st.installed
          ? t('Claude Vault: connection to Claude Code updated')
          : t('Claude Vault: connected to Claude Code, restart a session to activate the hooks'),
        8000);
    }
    // Every activation, cheaply: mirror the language for the hooks, and wrap any
    // local MCP server so an "Allow for MCP" key works through the proxy with no
    // configuration by hand. Both are idempotent and write only if something
    // changed, so a server the user adds later is picked up on the next reload.
    try { vault.setUiLang(i18n.current()); } catch (e) { /* hooks fall back to English */ }
    try { installer.wrapMcpServers(); } catch (e) { /* the manual snippet remains */ }
  } catch (e) {
    // Silent: the panel already shows "not connected" along with the button.
    console.error('Claude Vault: automatic connection failed:', e);
  }

  reviewPending();     // a request may have been left waiting from a past session

  return { snapshot, getDefaults, setDefaults, createFromPanel, addKey, deleteKey, changeTtl,
           copyMarker, revealKey, toggleMcp, keyActions, showAudit, showSettings,
           revokeAll, connect, showDetails, editNote, toggleAutoApprove, reviewPending,
           mcpSnippet };
}

module.exports = { activateVault };
