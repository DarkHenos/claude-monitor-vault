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
  child.on('close', () => { fs.rmSync(temp, { recursive: true, force: true }); toolsOf12(); reasonInRealCore(); });
});

// 1.2: ChatGPT creates keys, changes MCP access and groups, reorganises the
// layout. Against a stub core again (no real vault, no key store): the stub
// records what the server asks of core, so the test checks the server's own
// job: argument shapes, actor 'codex', 1-based positions, waiting for the
// user's answer, and never echoing a value it produced.
function toolsOf12() {
  const { spawnSync } = require('child_process');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vault-mcp12-test-'));
  const value = 'produced-' + require('crypto').randomBytes(12).toString('hex');
  const log = path.join(dir, 'calls.jsonl');
  fs.copyFileSync(path.join(__dirname, '../vault/mcp-server.js'), path.join(dir, 'mcp-server.js'));
  fs.writeFileSync(path.join(dir, 'core.js'), `
const fs = require('fs');
const LOG = ${JSON.stringify(log)};
const rec = (fn, args) => fs.appendFileSync(LOG, JSON.stringify({ fn, args }) + '\\n');
const G = { type: 'group', id: 'g1', name: 'Payments', collapsed: false };
let polls = 0;
const keys = [
  { name: 'LOOSE', mcp: true, mcpServers: null, groupId: null, group: null, expired: false },
  { name: 'STRIPE_KEY', mcp: true, mcpServers: ['claude-monitor-vault'], groupId: 'g1', group: 'Payments', expired: false },
  { name: 'HIDDEN', mcp: false, groupId: null, group: null, expired: false }
];
const layoutFn = name => (...args) => { rec(name, args); return { name: String(args[0]), index: args[1] }; };
module.exports = {
  listFast: () => keys,
  mcpAllows: (s, server) => !!s.mcp && (!s.mcpServers || s.mcpServers.includes(server)),
  validateName: n => String(n).toUpperCase(),
  parseServerList: l => { const a = (Array.isArray(l) ? l : String(l).split(',')).map(x => String(x).trim()).filter(Boolean); if (!a.length) throw new Error('name at least one server'); return a; },
  layout: () => [G, { type: 'separator', id: 's1', label: 'Prod' }],
  rotationOf: () => null,
  policyFast: () => ({ mcpByAI: 'ask', layoutByAI: true }),
  aiCreateKey: o => { rec('aiCreateKey', [o]); return { name: o.name, kind: 'generic', length: o.value.length, group: o.group || null, groupCreated: !!o.group, mcp: o.mcp && o.mcp.allow ? { status: 'requested', servers: o.mcp.servers, why: 'every server', request: { rid: 'r-create', names: [o.name] } } : { status: 'none' } }; },
  aiChangeMcp: o => { if (o.allow && !o.reason) throw new Error('a reason is required'); rec('aiChangeMcp', [o]); return o.allow ? { status: 'requested', why: 'widening', request: { rid: 'r-set', names: o.names } } : { status: 'applied', why: 'removal', keys: o.names.map(n => ({ name: n, mcp: false })) }; },
  mcpRequestState: rid => { rec('mcpRequestState', [rid]); return ++polls % 2 === 0 ? 'approved' : 'pending'; },
  setKeyGroup: (names, g, by, opts) => { rec('setKeyGroup', [names, g, by, opts]); return { group: g, names }; },
  createGroup: layoutFn('createGroup'), renameGroup: layoutFn('renameGroup'), deleteGroup: layoutFn('deleteGroup'),
  addSeparator: layoutFn('addSeparator'), editSeparator: layoutFn('editSeparator'), removeSeparator: layoutFn('removeSeparator'),
  moveItem: layoutFn('moveItem')
};`);
  const calls = [
    ['tools/list'],
    ['tools/call', { name: 'vault_list' }],
    ['tools/call', { name: 'vault_create', arguments: { name: 'new_key', note: 'made by a program', program: process.execPath,
      args: ['-e', 'process.stdout.write(' + JSON.stringify(value) + ' + "\\n")'], mcp: 'all', reason: 'needs it', group: 'Payments' } }],
    ['tools/call', { name: 'vault_create', arguments: { name: 'EMPTY_LIST', note: 'x', program: process.execPath, args: ['-e', '1'], mcp: [] } }],
    ['tools/call', { name: 'vault_set', arguments: { names: ['STRIPE_KEY'], mcp: ['other'] } }],
    ['tools/call', { name: 'vault_set', arguments: { names: ['STRIPE_KEY'], mcp: ['other'], reason: 'the other tool needs it', group: null } }],
    ['tools/call', { name: 'vault_set', arguments: { names: ['LOOSE'], mcp: 'none' } }],
    ['tools/call', { name: 'vault_layout', arguments: { op: 'createGroup', name: 'Mail', position: 2 } }],
    ['tools/call', { name: 'vault_layout', arguments: { op: 'move', name: 'Mail' } }],
    ['tools/call', { name: 'vault_layout', arguments: { op: 'move', name: 'Mail', position: 0 } }],
    ['tools/call', { name: 'vault_layout', arguments: { op: 'editSeparator', id: 's1', label: 'Production' } }]
  ];
  try {
    const input = calls.map((c, i) => JSON.stringify({ jsonrpc: '2.0', id: i + 1, method: c[0], params: c[1] || {} })).join('\n') + '\n';
    const r = spawnSync(process.execPath, [path.join(dir, 'mcp-server.js'), '--root', dir], { input, encoding: 'utf8', windowsHide: true, timeout: 60000 });
    assert.equal(r.status, 0, r.stderr);
    assert.ok(!r.stdout.includes(value), 'A produced value entered the MCP response');
    const res = r.stdout.trim().split(/\r?\n/).map(l => JSON.parse(l));
    const text = i => res[i].result.content[0].text;
    const calls12 = fs.readFileSync(log, 'utf8').trim().split(/\r?\n/).map(l => JSON.parse(l));
    const of = fn => calls12.filter(x => x.fn === fn).map(x => x.args);
    assert.deepEqual(res[0].result.tools.map(t => t.name), ['vault_list', 'vault_run', 'vault_create', 'vault_set', 'vault_layout']);
    console.log('PASS 1.2 tools offered when core has them');
    const list = JSON.parse(text(1));
    assert.deepEqual(list.layout, [{ type: 'group', name: 'Payments' }, { type: 'separator', label: 'Prod' }]);
    assert.deepEqual(list.keys.map(k => k.name), ['STRIPE_KEY', 'LOOSE'], 'grouped keys first, hidden key filtered');
    assert.equal(list.keys[0].group, 'Payments');
    assert.deepEqual(list.keys[0].scope, ['claude-monitor-vault']);
    assert.equal(list.keys[1].scope, 'all');
    console.log('PASS vault_list returns layout order, groups and MCP scope');
    const created = of('aiCreateKey')[0][0];
    assert.equal(created.value, value, 'one trailing newline stripped');
    assert.equal(created.by, 'codex');
    assert.equal(created.name, 'NEW_KEY');
    assert.equal(created.group, 'Payments');
    assert.deepEqual(created.mcp, { allow: true, servers: null });
    assert.ok(/added by ChatGPT/.test(created.note));
    const out = JSON.parse(text(2));
    assert.equal(out.mcp.status, 'requested');
    assert.equal(out.mcp.answer, 'approved');
    assert.equal(res[3].result.isError, true);
    assert.ok(/at least one server/.test(text(3)));
    assert.equal(of('aiCreateKey').length, 1, 'an empty server list runs nothing');
    console.log('PASS vault_create stores the program output, never returns it, waits for the answer');
    assert.equal(res[4].result.isError, true);
    assert.ok(/reason is required/.test(text(4)));
    const change = of('aiChangeMcp');
    assert.deepEqual(change[0][0].servers, ['other']);
    assert.equal(change[0][0].by, 'codex');
    assert.equal(change[0][0].reason, 'the other tool needs it');
    assert.deepEqual(of('setKeyGroup')[0], [['STRIPE_KEY'], null, 'codex', { create: true }]);
    assert.equal(JSON.parse(text(5)).mcp.answer, 'approved');
    assert.equal(change[1][0].allow, false);
    assert.equal(JSON.parse(text(6)).mcp.status, 'applied');
    console.log('PASS vault_set: reason required to grant, removal applies, placement, actor codex');
    assert.deepEqual(of('createGroup')[0], ['Mail', 1, 'codex'], 'position 2 is index 1');
    assert.equal(res[8].result.isError, true);
    assert.equal(res[9].result.isError, true);
    assert.equal(of('moveItem').length, 0, 'an invalid move reaches nothing');
    assert.deepEqual(of('editSeparator')[0], ['s1', 'Production', 'codex']);
    console.log('PASS vault_layout: 1-based positions, required position for move, separator by id');
  } catch (e) { console.error(e); process.exitCode = 1; }
  finally { fs.rmSync(dir, { recursive: true, force: true }); }
}

// The stub above only repeats the rule on the reason, which lives in core
// (aiChangeMcp). Here the real server meets the real core, in a temporary home.
// PATH points at an empty folder so that `security` and `secret-tool` cannot be
// found: their entry is shared by every home, and a test must never overwrite
// the real master key. The vault then settles for file permissions.
function reasonInRealCore() {
  const { spawnSync } = require('child_process');
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'vault-mcp-core-test-'));
  const emptyPath = path.join(home, 'no-tools');
  fs.mkdirSync(path.join(home, '.claude'));
  fs.mkdirSync(emptyPath);
  const env = { ...process.env, HOME: home, USERPROFILE: home, CLAUDE_CONFIG_DIR: path.join(home, '.claude'), PATH: emptyPath };
  const vaultDir = path.join(__dirname, '../vault');
  const seed = `
const v = require(${JSON.stringify(path.join(vaultDir, 'core.js'))});
const value = n => n + '-' + require('crypto').randomBytes(12).toString('hex');
v.put('SCOPED', value('a'), { mcp: true, mcpServers: ['claude-monitor-vault', 'github'] });
v.put('OPEN', value('b'), { mcp: true });`;
  const calls = [
    { name: 'vault_set', arguments: { names: ['SCOPED'], mcp: 'all' } },
    { name: 'vault_list' },
    { name: 'vault_set', arguments: { names: ['SCOPED'], mcp: ['claude-monitor-vault'] } },
    { name: 'vault_set', arguments: { names: ['OPEN'], mcp: 'none' } },
    { name: 'vault_list' }
  ];
  try {
    const seeded = spawnSync(process.execPath, ['-e', seed], { env, encoding: 'utf8', windowsHide: true, timeout: 60000 });
    assert.equal(seeded.status, 0, seeded.stderr);
    const input = calls.map((params, i) => JSON.stringify({ jsonrpc: '2.0', id: i + 1, method: 'tools/call', params })).join('\n') + '\n';
    const r = spawnSync(process.execPath, [path.join(vaultDir, 'mcp-server.js'), '--root', home], { input, env, encoding: 'utf8', windowsHide: true, timeout: 60000 });
    assert.equal(r.status, 0, r.stderr);
    const res = r.stdout.trim().split(/\r?\n/).map(l => JSON.parse(l));
    const text = i => res[i].result.content[0].text;
    const scope = (i, name) => (JSON.parse(text(i)).keys.find(k => k.name === name) || {}).scope;
    assert.equal(res[0].result.isError, true);
    assert.ok(/reason is required/.test(text(0)));
    assert.deepEqual(scope(1, 'SCOPED'), ['claude-monitor-vault', 'github'], 'a refused grant changes nothing');
    assert.ok(!res[2].result.isError, 'narrowing needs no reason');
    assert.equal(JSON.parse(text(2)).mcp.status, 'applied');
    assert.ok(!res[3].result.isError, 'removing needs no reason');
    assert.equal(JSON.parse(text(3)).mcp.status, 'applied');
    assert.deepEqual(scope(4, 'SCOPED'), ['claude-monitor-vault']);
    assert.equal(scope(4, 'OPEN'), undefined);
    console.log('PASS real core: a grant needs a reason, narrowing and removal do not');
  } catch (e) { console.error(e); process.exitCode = 1; }
  finally { fs.rmSync(home, { recursive: true, force: true }); }
}
