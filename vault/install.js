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

const CLAUDE_DIR = path.join(os.homedir(), '.claude');
const BRIDGE_DIR = path.join(CLAUDE_DIR, 'claude-vault-bridge');
const SETTINGS = path.join(CLAUDE_DIR, 'settings.json');
const MARKER = 'claude-vault-bridge';     // lets us find OUR entries
const FILES = ['core.js', 'hook.js', 'get.js', 'list.js', 'add.js', 'env.js', 'mcp-proxy.js'];
const EVENTS = ['SessionStart', 'UserPromptSubmit', 'PreToolUse', 'PostToolUse'];

function readJson(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch (e) { return fallback; }
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
  writeJson(path.join(BRIDGE_DIR, 'version.json'), { version, at: new Date().toISOString() });
  return changed;
}

function hookCommand() {
  // Quotes are required: paths such as "Program Files", "developpement web"...
  return '"' + process.execPath + '" "' + path.join(BRIDGE_DIR, 'hook.js') + '"';
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
  const s = readJson(SETTINGS, {});

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
  try { for (const f of FILES.concat(['version.json'])) fs.unlinkSync(path.join(BRIDGE_DIR, f)); }
  catch (e) { /* already clean */ }
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
    command: process.execPath,
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
    const { wrapped } = wrapServers(config, process.execPath, proxyPath);
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
  wrapServers, unwrapServers, wrapMcpServers, CLAUDE_JSON, WRAP_MARK
};
