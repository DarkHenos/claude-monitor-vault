'use strict';
const assert = require('assert/strict');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawn } = require('child_process');
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'vault-mcp-test-'));
const marker = 'fixture-' + require('crypto').randomBytes(12).toString('hex');
fs.copyFileSync(path.join(__dirname, '../vault/mcp-server.js'), path.join(temp, 'mcp-server.js'));
// No access to the real vault or OS key store: only an ephemeral fixture.
fs.writeFileSync(path.join(temp, 'core.js'), `
const secret = ${JSON.stringify(marker)};
const redact = require(${JSON.stringify(path.join(__dirname, '../vault/core.js'))}).redactor;
let uses = 0;
module.exports = {
 listFast: () => [{name:'TEST_KEY',mcp:true,expired:false}],
 mcpAllows: (_s,server) => server === 'claude-monitor-vault',
 consume: (_name,who) => {if (!who.startsWith('codex:')) throw new Error('Actor missing'); if (++uses > 1) throw new Error('Already used'); return {value:secret};},
 redactor: redact
};`);
const child = spawn(process.execPath, [path.join(temp, 'mcp-server.js'), '--root', temp], { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
let buffer = '', id = 0;
const pending = new Map();
child.stdout.setEncoding('utf8');
child.stdout.on('data', chunk => {
  buffer += chunk; let pos;
  while ((pos = buffer.indexOf('\n')) >= 0) {
    const text = buffer.slice(0, pos); buffer = buffer.slice(pos + 1);
    assert.ok(!text.includes(marker), 'A secret entered the MCP response');
    const msg = JSON.parse(text); const p = pending.get(msg.id);
    if (p) { clearTimeout(p.timer); pending.delete(msg.id); p.resolve(msg); }
  }
});
function request(method, params = {}) {
  return new Promise((resolve, reject) => {
    const key = ++id; const timer = setTimeout(() => reject(new Error('MCP test timed out')), 10000);
    pending.set(key, { resolve, timer });
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: key, method, params }) + '\n');
  });
}
(async () => {
  const init = await request('initialize'); assert.ok(init.result.capabilities.tools);
  const list = await request('tools/list'); assert.deepEqual(list.result.tools.map(t => t.name), ['vault_list', 'vault_run']);
  console.log('PASS MCP initialize and tool discovery');
  const names = await request('tools/call', { name: 'vault_list' });
  assert.ok(names.result.content[0].text.includes('TEST_KEY'));
  console.log('PASS MCP lists permitted metadata without values');
  const deny = await request('tools/call', { name: 'vault_run', arguments: { program: process.execPath, env: { TOKEN: 'NOT_ALLOWED' } } });
  assert.equal(deny.result.isError, true); console.log('PASS unauthorized key refused before execution');
  const run = await request('tools/call', { name: 'vault_run', arguments: {
    program: process.execPath, args: ['-e', 'process.stdout.write(process.env.A); process.stderr.write(process.env.B);'],
    env: { A: 'TEST_KEY', B: 'TEST_KEY' }
  } });
  assert.ok(!run.result.isError);
  const output = JSON.parse(run.result.content[0].text);
  assert.equal(output.exitCode, 0); assert.equal(output.stdout, '«vault:TEST_KEY»'); assert.equal(output.stderr, '«vault:TEST_KEY»');
  console.log('PASS environment injection, one-use reuse and stdout/stderr redaction');
})().catch(e => { console.error(e); process.exitCode = 1; }).finally(() => {
  for (const p of pending.values()) clearTimeout(p.timer);
  child.stdin.end();
  child.on('close', () => fs.rmSync(temp, { recursive: true, force: true }));
});
