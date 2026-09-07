'use strict';
// Local stdio tool server: values travel only through the child environment.
// It deliberately offers no tool that returns a secret.
const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');
const readline = require('readline');
const vault = require('./core');
const rootIndex = process.argv.indexOf('--root');
if (rootIndex < 0 || !process.argv[rootIndex + 1]) throw new Error('--root is required');
const root = fs.realpathSync(process.argv[rootIndex + 1]);
const SERVER = 'claude-monitor-vault';
const accessIndex = process.argv.indexOf('--access');
const claudeAccess = accessIndex >= 0 && process.argv[accessIndex + 1] === 'claude';
const send = msg => process.stdout.write(JSON.stringify(msg) + '\n');
const tools = [
  { name: 'vault_list', description: 'List metadata of secrets permitted for this MCP server. Never returns values.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false } },
  { name: 'vault_run', description: 'Run a program in this project with named vault secrets as environment variables. Output is buffered and redacted. No shell expansion. Never request a secret value directly.',
    inputSchema: { type: 'object', properties: {
      program: { type: 'string', description: 'Executable, for example node, git or curl.' },
      args: { type: 'array', items: { type: 'string' } },
      env: { type: 'object', description: 'Environment variable name to vault key name, e.g. GITHUB_TOKEN: GITHUB_TOKEN.', additionalProperties: { type: 'string' } }
    }, required: ['program', 'env'], additionalProperties: false } }
];
function allowed() { return vault.listFast().filter(s => !s.expired && vault.mcpAllows(claudeAccess ? { ...s, mcp: true } : s, SERVER)); }
async function call(name, args) {
  if (name === 'vault_list') return JSON.stringify(allowed().map(s => ({ name: s.name, note: s.note || '', confirm: !!s.confirm })));
  if (name !== 'vault_run') throw new Error('Unknown vault tool');
  if (!args || typeof args.program !== 'string' || !args.program || args.program.includes('\0')
      || !args.env || typeof args.env !== 'object' || Array.isArray(args.env)
      || (args.args !== undefined && (!Array.isArray(args.args) || args.args.some(a => typeof a !== 'string')))) throw new Error('Invalid execution arguments');
  const names = Object.entries(args.env);
  if (!names.length || names.length > 20) throw new Error('Choose between 1 and 20 environment variables');
  const entries = allowed();
  for (const [variable, key] of names) {
    if (!/^[A-Z_][A-Z0-9_]*$/.test(variable) || typeof key !== 'string' || !entries.some(s => s.name === key)) {
      throw new Error('A key or environment variable is not permitted for this server');
    }
  }
  const pairs = [];
  const environment = { ...process.env };
  for (const [variable, key] of names) {
    let pair = pairs.find(p => p[0] === key);
    if (!pair) { pair = [key, vault.consume(key, 'codex:mcp:' + SERVER).value]; pairs.push(pair); }
    environment[variable] = pair[1];
  }
  const redact = vault.redactor(pairs);
  return new Promise(resolve => {
    execFile(args.program, args.args || [], {
      cwd: root, env: environment, windowsHide: true, timeout: 60000,
      maxBuffer: 1024 * 1024, encoding: 'utf8', shell: false
    }, (error, stdout, stderr) => {
      resolve(JSON.stringify({ exitCode: error ? (typeof error.code === 'number' ? error.code : 1) : 0,
        stdout: redact(stdout), stderr: redact(stderr),
        error: error ? (error.killed ? 'Process timed out or exceeded its output limit' : 'Process failed') : null }));
    });
  });
}
async function handle(msg) {
  if (!msg || msg.id === undefined) return;
  try {
    let result;
    if (msg.method === 'initialize') result = { protocolVersion: '2024-11-05', capabilities: { tools: {} },
      serverInfo: { name: SERVER, version: '1.1.0' },
      instructions: 'Use vault_list to discover authorized key names. Use vault_run with env mapping to use them. Never print, encode, write or transmit credentials except to the intended service. Read project shared memory before work.' };
    else if (msg.method === 'ping') result = {};
    else if (msg.method === 'tools/list') result = { tools };
    else if (msg.method === 'tools/call') {
      try { result = { content: [{ type: 'text', text: await call(msg.params.name, msg.params.arguments || {}) }] }; }
      catch (e) { result = { isError: true, content: [{ type: 'text', text: e.message }] }; }
    } else { send({ jsonrpc: '2.0', id: msg.id, error: { code: -32601, message: 'Unknown method' } }); return; }
    send({ jsonrpc: '2.0', id: msg.id, result });
  } catch (_) { send({ jsonrpc: '2.0', id: msg.id, error: { code: -32603, message: 'Vault request failed' } }); }
}
// Sequential calls prevent this server from double-consuming one-use keys.
let queue = Promise.resolve();
const reader = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
reader.on('line', line => {
  if (Buffer.byteLength(line) > 1024 * 1024) { reader.close(); process.stdin.destroy(); return; }
  let msg; try { msg = JSON.parse(line); } catch (_) { return; }
  queue = queue.then(() => handle(msg));
});
