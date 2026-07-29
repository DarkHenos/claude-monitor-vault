// Claude Vault, installer for the connection to Claude Code.
//
// Two problems solved here:
//
// 1. STABLE PATH. A VSCode extension gets installed into a directory whose
//    name embeds its version number, which changes on every update. A hook
//    path pointing there would silently break on the very next update.
//    We therefore copy the code into ~/.claude/claude-vault-bridge/, a stable
//    path, and the hooks point there.
//
// 2. NON DESTRUCTIVE MERGE. settings.json holds the user's own settings
//    (permissions, plugins, model...). We merge into it, never overwrite it,
//    and back it up before touching anything.

'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawnSync } = require('child_process');

// Claude Code honours CLAUDE_CONFIG_DIR; writing hooks into a hard-coded
// ~/.claude would put them in a settings.json Claude Code never reads, and the
// panel would report "connected" while nothing ever fires.
const CLAUDE_DIR = process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude');
const BRIDGE_DIR = path.join(CLAUDE_DIR, 'claude-vault-bridge');
const SETTINGS = path.join(CLAUDE_DIR, 'settings.json');
const MARKER = 'claude-vault-bridge';     // lets us find OUR entries
const FILES = ['core.js', 'hook.js', 'get.js', 'list.js', 'add.js', 'env.js', 'mcp-proxy.js'];
const SHIMS = { win32: 'node-shim.cmd', posix: 'node-shim.sh' };
const EVENTS = ['SessionStart', 'UserPromptSubmit', 'PreToolUse', 'PostToolUse'];

function readJson(file, fallback, strict) {
  let txt;
  try { txt = fs.readFileSync(file, 'utf8'); }
  catch (e) { return fallback; }              // absent: the fallback is legitimate
  // A UTF-8 BOM — PowerShell Out-File/Set-Content, older Notepad — makes
  // JSON.parse throw on an otherwise perfectly valid file.
  if (txt.charCodeAt(0) === 0xFEFF) txt = txt.slice(1);
  try { return JSON.parse(txt); }
  catch (e) {
    // Silently falling back to {} here would rewrite settings.json with our
    // hooks alone and drop the user's permissions, model and plugins. Refusing
    // is the only safe answer on a file we cannot understand.
    if (!strict) return fallback;
    const err = new Error('cannot read ' + path.basename(file) + ': the file is not valid JSON');
    err.unparseable = true;
    throw err;
  }
}

function writeJson(file, obj) {
  const tmp = file + '.vault-tmp';
  fs.writeFileSync(tmp, JSON.stringify(obj, null, 2), 'utf8');
  fs.renameSync(tmp, file);
}

// Copies the code into the bridge. Idempotent: rewrites only if content differs.
function syncBridge(srcDir, version) {
  if (!fs.existsSync(BRIDGE_DIR)) fs.mkdirSync(BRIDGE_DIR, { recursive: true, mode: 0o700 });
  let changed = 0;
  for (const f of FILES) {
    const src = path.join(srcDir, f);
    const dst = path.join(BRIDGE_DIR, f);
    if (!fs.existsSync(src)) throw new Error('missing source file: ' + f);
    const a = fs.readFileSync(src, 'utf8');
    let b = null;
    try { b = fs.readFileSync(dst, 'utf8'); } catch (e) { /* missing */ }
    if (a !== b) { fs.writeFileSync(dst, a, 'utf8'); changed++; }
  }
  // The interpreter is recorded here so hook.js can rewrite commands with the
  // same one instead of re-deriving it from its own process.execPath.
  writeJson(path.join(BRIDGE_DIR, 'version.json'),
    { version, at: new Date().toISOString(), node: nodeExec() });
  return changed;
}

// process.execPath inside a VS Code extension host is the ELECTRON binary, not
// node. A hook or MCP command built from it launches a second editor window on
// macOS and Linux, and only seems to work on Windows because the extension host
// leaks ELECTRON_RUN_AS_NODE into what it spawns. Without that variable the
// hook prints nothing and exits 0, so the guard and the {{vault:NAME}}
// substitution become silent no-ops. We resolve a real interpreter instead.
function realNode() {
  const exe = path.basename(process.execPath).toLowerCase();
  if (exe === 'node' || exe === 'node.exe') return process.execPath;
  const probe = process.platform === 'win32'
    ? spawnSync('where', ['node'], { encoding: 'utf8', windowsHide: true })
    : spawnSync('/bin/sh', ['-lc', 'command -v node'], { encoding: 'utf8' });
  if (!probe.error && probe.status === 0) {
    const first = String(probe.stdout || '').split(/\r?\n/).map(s => s.trim()).filter(Boolean)[0];
    if (first && fs.existsSync(first)) return first;
  }
  return null;
}

// No node on PATH. Electron behaves exactly like node once ELECTRON_RUN_AS_NODE
// is set, but neither a hook command string nor an MCP entry can carry an
// environment variable, so we write a drop-in launcher that sets it itself.
function writeLauncher() {
  if (!fs.existsSync(BRIDGE_DIR)) fs.mkdirSync(BRIDGE_DIR, { recursive: true, mode: 0o700 });
  if (process.platform === 'win32') {
    const p = path.join(BRIDGE_DIR, SHIMS.win32);
    fs.writeFileSync(p, '@echo off\r\nset ELECTRON_RUN_AS_NODE=1\r\n"' +
      process.execPath + '" %*\r\n', 'utf8');
    return p;
  }
  const p = path.join(BRIDGE_DIR, SHIMS.posix);
  fs.writeFileSync(p, '#!/bin/sh\nELECTRON_RUN_AS_NODE=1 exec "' +
    process.execPath + '" "$@"\n', 'utf8');
  try { fs.chmodSync(p, 0o700); } catch (e) { /* best effort */ }
  return p;
}

// Cached per process: the PATH probe spawns a shell.
let _node = null;
function nodeExec() {
  if (!_node) _node = realNode() || writeLauncher();
  return _node;
}

function hookCommand() {
  // Quotes are required: paths such as "Program Files", "developpement web"...
  return '"' + nodeExec() + '" "' + path.join(BRIDGE_DIR, 'hook.js') + '"';
}

function isOurs(entry) {
  return entry && typeof entry.command === 'string' && entry.command.indexOf(MARKER) !== -1;
}

// Removes all trace of our hooks from an event block, while keeping the others.
function stripOurs(list) {
  if (!Array.isArray(list)) return [];
  return list
    .map(m => Object.assign({}, m, { hooks: (m.hooks || []).filter(h => !isOurs(h)) }))
    .filter(m => (m.hooks || []).length > 0);
}

function install(srcDir, version) {
  const changed = syncBridge(srcDir, version);
  const s = readJson(SETTINGS, {}, true);   // strict: never overwrite what we failed to parse

  // Timestamped backup before any modification.
  if (fs.existsSync(SETTINGS)) {
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    fs.copyFileSync(SETTINGS, path.join(CLAUDE_DIR, 'settings.json.vault-backup-' + stamp));
  }

  if (!s.hooks || typeof s.hooks !== 'object') s.hooks = {};
  const cmd = hookCommand();
  for (const ev of EVENTS) {
    const kept = stripOurs(s.hooks[ev]);          // idempotent: we replace our own
    kept.push({ hooks: [{ type: 'command', command: cmd, timeout: 10 }] });
    s.hooks[ev] = kept;
  }
  writeJson(SETTINGS, s);
  return { bridge: BRIDGE_DIR, filesUpdated: changed, events: EVENTS };
}

function uninstall() {
  const s = readJson(SETTINGS, {});
  if (s.hooks) {
    for (const ev of EVENTS) {
      const kept = stripOurs(s.hooks[ev]);
      if (kept.length) s.hooks[ev] = kept; else delete s.hooks[ev];
    }
    if (!Object.keys(s.hooks).length) delete s.hooks;
    writeJson(SETTINGS, s);
  }
  // Unwrap the MCP servers BEFORE deleting the proxy they point at: left alone,
  // every wrapped server would keep launching a mcp-proxy.js that no longer
  // exists and would simply stop starting.
  try { unwrapMcpServers(); } catch (e) { /* never block the uninstall */ }
  for (const f of FILES.concat(['version.json', SHIMS.win32, SHIMS.posix])) {
    try { fs.unlinkSync(path.join(BRIDGE_DIR, f)); } catch (e) { /* already gone */ }
  }
  try { fs.rmdirSync(BRIDGE_DIR); } catch (e) { /* not empty, never mind */ }
  return true;
}

// ----------------------------------------------------- MCP server auto-wrapping
//
// So a key just needs "Allow for MCP" toggled on and it works through the proxy,
// with no config by hand. We rewrite each LOCAL stdio MCP server so it launches
// behind mcp-proxy.js. Then any {{vault:NAME}} in an MCP argument is resolved by
// the proxy, downstream of Claude Code, out of the transcript.
//
// Safety, because this edits ~/.claude.json, Claude Code's own file:
//   - only stdio servers are touched; http servers are left alone (no local
//     process to wrap, and the proxy is stdio only);
//   - the original command and args are kept verbatim under a marker, so
//     unwrapping restores the server exactly;
//   - already-wrapped servers are skipped, so it is idempotent and re-running
//     never nests one proxy inside another;
//   - the whole file is backed up, timestamped, before any write, and the write
//     is atomic (temp + rename);
//   - nothing else in the file is touched: we mutate only the server entries we
//     wrap and re-serialise, key order preserved.
const CLAUDE_JSON = path.join(os.homedir(), '.claude.json');
const WRAP_MARK = '_claudeVaultWrapped';

function proxyLauncher(id) {
  return {
    command: nodeExec(),
    args: [path.join(BRIDGE_DIR, 'mcp-proxy.js'), '--name', String(id), '--'],
    marker: WRAP_MARK
  };
}

// Pure: takes a parsed config object, returns { config, wrapped, unwrapped }.
// Walks the global mcpServers and every projects[*].mcpServers.
function wrapServers(config, nodePath, proxyPath) {
  const wrapped = [];
  const seen = [];

  const visit = servers => {
    if (!servers || typeof servers !== 'object') return;
    for (const id of Object.keys(servers)) {
      const srv = servers[id];
      if (!srv || typeof srv !== 'object') continue;
      const kind = srv.type || (srv.command ? 'stdio' : null);
      if (kind !== 'stdio' || !srv.command) continue;      // http/sse: not ours to wrap
      if (srv[WRAP_MARK]) { seen.push(id); continue; }      // already wrapped
      if (srv.command === nodePath &&
          Array.isArray(srv.args) && srv.args[0] === proxyPath) { seen.push(id); continue; }

      servers[id] = Object.assign({}, srv, {
        command: nodePath,
        args: [proxyPath, '--name', String(id), '--', srv.command].concat(srv.args || []),
        [WRAP_MARK]: { command: srv.command, args: srv.args || [] }
      });
      wrapped.push(id);
    }
  };

  visit(config.mcpServers);
  if (config.projects && typeof config.projects === 'object') {
    for (const p of Object.keys(config.projects)) {
      if (config.projects[p]) visit(config.projects[p].mcpServers);
    }
  }
  return { config, wrapped, alreadyWrapped: seen };
}

// Pure inverse: restore every wrapped server to its original command/args.
function unwrapServers(config) {
  const restored = [];
  const visit = servers => {
    if (!servers || typeof servers !== 'object') return;
    for (const id of Object.keys(servers)) {
      const srv = servers[id];
      if (srv && srv[WRAP_MARK] && typeof srv[WRAP_MARK] === 'object') {
        const orig = srv[WRAP_MARK];
        const clean = Object.assign({}, srv, { command: orig.command, args: orig.args });
        delete clean[WRAP_MARK];
        servers[id] = clean;
        restored.push(id);
      }
    }
  };
  visit(config.mcpServers);
  if (config.projects && typeof config.projects === 'object') {
    for (const p of Object.keys(config.projects)) {
      if (config.projects[p]) visit(config.projects[p].mcpServers);
    }
  }
  return { config, restored };
}

// Reads ~/.claude.json, wraps, and writes back only if something changed. Backup
// first. Never throws to the caller: a failure here must not block the vault.
function wrapMcpServers() {
  try {
    if (!fs.existsSync(CLAUDE_JSON)) return { wrapped: [], skipped: true };
    const raw = fs.readFileSync(CLAUDE_JSON, 'utf8');
    let config;
    try { config = JSON.parse(raw); } catch (e) { return { wrapped: [], error: 'unparseable' }; }
    const proxyPath = path.join(BRIDGE_DIR, 'mcp-proxy.js');
    const before = JSON.stringify(config);
    const { wrapped } = wrapServers(config, nodeExec(), proxyPath);
    if (JSON.stringify(config) === before) return { wrapped: [] };   // nothing changed

    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    fs.copyFileSync(CLAUDE_JSON, path.join(os.homedir(), '.claude.json.vault-backup-' + stamp));
    const tmp = CLAUDE_JSON + '.vault-tmp';
    fs.writeFileSync(tmp, JSON.stringify(config, null, 2), 'utf8');
    fs.renameSync(tmp, CLAUDE_JSON);
    return { wrapped };
  } catch (e) {
    return { wrapped: [], error: e.message };
  }
}

// Symmetric to wrapMcpServers, and called by uninstall(): without it every
// wrapped server keeps pointing at a mcp-proxy.js that has just been deleted,
// and simply stops starting.
function unwrapMcpServers() {
  try {
    if (!fs.existsSync(CLAUDE_JSON)) return { restored: [], skipped: true };
    let config;
    try { config = JSON.parse(fs.readFileSync(CLAUDE_JSON, 'utf8')); }
    catch (e) { return { restored: [], error: 'unparseable' }; }
    const before = JSON.stringify(config);
    const { restored } = unwrapServers(config);
    if (JSON.stringify(config) === before) return { restored: [] };   // nothing wrapped

    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    fs.copyFileSync(CLAUDE_JSON, path.join(os.homedir(), '.claude.json.vault-backup-' + stamp));
    const tmp = CLAUDE_JSON + '.vault-tmp';
    fs.writeFileSync(tmp, JSON.stringify(config, null, 2), 'utf8');
    fs.renameSync(tmp, CLAUDE_JSON);
    return { restored };
  } catch (e) {
    return { restored: [], error: e.message };
  }
}

// Is the installation in place AND up to date?
function status(version) {
  const s = readJson(SETTINGS, {});
  const hooked = EVENTS.filter(ev =>
    Array.isArray(s.hooks && s.hooks[ev]) &&
    s.hooks[ev].some(m => (m.hooks || []).some(isOurs)));
  const v = readJson(path.join(BRIDGE_DIR, 'version.json'), null);
  return {
    installed: hooked.length === EVENTS.length,
    hookedEvents: hooked,
    missingEvents: EVENTS.filter(e => hooked.indexOf(e) === -1),
    bridgeVersion: v ? v.version : null,
    upToDate: !!v && v.version === version
  };
}

module.exports = {
  install, uninstall, status, BRIDGE_DIR, SETTINGS, EVENTS,
  wrapServers, unwrapServers, wrapMcpServers, unwrapMcpServers, CLAUDE_JSON, WRAP_MARK,
  nodeExec
};
