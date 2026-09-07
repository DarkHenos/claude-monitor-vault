'use strict';
const fs = require('fs');
const path = require('path');
const os = require('os');

// Never execute a project's shim or concatenate a shell command. VS Code's
// process.execPath is Electron, so npm entry points need an actual Node binary.
function resolveCli(name, configured) {
  const dirs = (process.env.PATH || '').split(path.delimiter).filter(p => p && path.isAbsolute(p));
  const win = process.platform === 'win32';
  const file = p => { try { return fs.statSync(p).isFile(); } catch (_) { return false; } };
  if (configured) {
    if (!path.isAbsolute(configured) || !file(configured) || /\.(cmd|bat|ps1)$/i.test(configured)) {
      throw new Error('Choose an absolute executable path (.exe on Windows), not a shell script.');
    }
    return { command: configured, args: [] };
  }
  const nativeDirs = [...dirs, path.join(os.homedir(), '.local', 'bin')];
  for (const dir of nativeDirs) {
    const candidate = path.join(dir, name + (win ? '.exe' : ''));
    if (file(candidate)) return { command: candidate, args: [] };
    if (win) {
      const entry = path.join(dir, 'node_modules', name === 'codex'
        ? '@openai/codex/bin/codex.js' : '@anthropic-ai/claude-code/cli.js');
      if (name === 'codex') {
        const arch = process.arch === 'arm64' ? 'aarch64' : 'x86_64';
        const vendor = path.join(dir, 'node_modules', '@openai', 'codex', 'node_modules', '@openai',
          'codex-win32-' + process.arch, 'vendor', arch + '-pc-windows-msvc');
        for (const binary of [path.join(vendor, 'bin', 'codex.exe'), path.join(vendor, 'codex', 'codex.exe')]) {
          if (file(binary)) return { command: binary, args: [] };
        }
      }
      const node = dirs.map(d => path.join(d, 'node.exe')).find(file);
      if (file(entry) && node) return { command: node, args: [entry] };
    }
  }
  throw new Error(name + ' CLI not found. Install it or set agentBridge.' + name + 'Executable.');
}
module.exports = { resolveCli };
