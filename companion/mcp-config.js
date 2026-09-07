'use strict';
const fs = require('fs');
const path = require('path');
const memory = require('./memory');
const START = '# claude-monitor-vault:codex:start';
const END = '# claude-monitor-vault:codex:end';
function plan(root, node, server, disconnect = false, access = 'mcp') {
  const file = '.codex/config.toml';
  const before = memory.read(root, file);
  const text = before || '';
  const a = text.indexOf(START), b = text.indexOf(END);
  if ((a < 0) !== (b < 0) || (a >= 0 && b < a)
      || text.indexOf(START, a + START.length) > a || text.indexOf(END, b + END.length) > b) throw new Error('Conflicting Codex MCP markers');
  const block = START + '\n[mcp_servers.claude-monitor-vault]\ncommand = ' + JSON.stringify(node)
    + '\nargs = ' + JSON.stringify([server, '--root', path.resolve(root), '--access', access === 'claude' ? 'claude' : 'mcp']) + '\n' + END;
  if (a < 0 && /^\s*\[\s*mcp_servers\.(?:["']?claude-monitor-vault["']?)(?:\.|\s*\])/m.test(text)) {
    throw new Error('An unmanaged claude-monitor-vault MCP server already exists. Keep or rename it before connecting.');
  }
  const after = a >= 0 ? text.slice(0, a) + (disconnect ? '' : block) + text.slice(b + END.length)
    : disconnect ? text : text + (text.endsWith('\n') || !text ? '' : '\n') + '\n' + block + '\n';
  return { root: path.resolve(root), originals: { [file]: before },
    changes: after === text ? [] : [{ file, before, after }] };
}
function installBridge(extensionPath, storagePath) {
  const dir = path.join(storagePath, 'codex-vault-bridge');
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  for (const name of ['core.js', 'wordlist.js', 'mcp-server.js']) {
    const data = fs.readFileSync(path.join(extensionPath, 'vault', name));
    const target = path.join(dir, name);
    try { if (fs.readFileSync(target).equals(data)) continue; } catch (_) {}
    const tmp = target + '.' + process.pid + '.tmp';
    try { fs.writeFileSync(tmp, data, { mode: 0o600 }); fs.renameSync(tmp, target); }
    finally { try { fs.unlinkSync(tmp); } catch (_) {} }
  }
  return path.join(dir, 'mcp-server.js');
}
module.exports = { plan, installBridge };
