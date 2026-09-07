'use strict';
const assert = require('assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const memory = require('../companion/memory');
const mcp = require('../companion/mcp-config');
const { quotaRows } = require('../companion/codex');
const { streamRedactor } = require('../vault/stream-redactor');
const { redactor } = require('../vault/core');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'companion-test-'));
let count = 0;
function check(name, fn) { fn(); count++; console.log('PASS ' + name); }
try {
  const project = path.join(root, 'project'); fs.mkdirSync(project);
  const backups = path.join(root, 'backups');
  fs.writeFileSync(path.join(project, 'CLAUDE.md'), '# Claude\r\nUse npm test.\r\n');
  fs.writeFileSync(path.join(project, 'AGENTS.md'), '# Codex\nKeep existing conventions.\n');
  const plan = memory.buildPlan(project, 'claude');
  check('preview never mutates project files', () => assert.equal(fs.existsSync(path.join(project, '.agent-bridge')), false));
  const backup = memory.applyPlan(plan, backups);
  check('both native instruction files preserve original contents', () => {
    assert.ok(memory.read(project, 'CLAUDE.md').startsWith('# Claude\r\nUse npm test.\r\n'));
    assert.ok(memory.read(project, 'AGENTS.md').startsWith('# Codex\nKeep existing conventions.\n'));
    assert.ok(memory.read(project, 'AGENTS.md').includes(memory.BLOCK));
  });
  check('Claude instructions enter shared memory', () => assert.ok(memory.read(project, memory.SHARED).includes('Use npm test.')));
  check('repeated synchronization and imports are idempotent', () => {
    assert.equal(memory.buildPlan(project).changes.length, 0);
    assert.equal(memory.buildPlan(project, 'claude').changes.length, 0);
  });
  check('restore puts original files back and removes newly created files', () => {
    memory.restore(backup); assert.equal(memory.read(project, memory.SHARED), null);
    assert.equal(memory.read(project, 'CLAUDE.md'), plan.originals['CLAUDE.md']);
  });
  check('a stale preview cannot overwrite concurrent edits', () => {
    const stale = memory.buildPlan(project);
    fs.appendFileSync(path.join(project, 'AGENTS.md'), 'New user change\n');
    assert.throws(() => memory.applyPlan(stale, backups), /changed since preview/);
    assert.equal(memory.read(project, memory.SHARED), null);
  });
  check('malformed or manually edited managed blocks stop synchronization', () => {
    assert.throws(() => memory.split(memory.BLOCK + memory.BLOCK), /Conflicting/);
    fs.writeFileSync(path.join(project, 'AGENTS.md'), memory.BLOCK.replace('Read', 'Ignore'));
    assert.throws(() => memory.buildPlan(project), /was edited/);
    fs.writeFileSync(path.join(project, 'AGENTS.md'), '# Codex\n');
  });
  check('AGENTS.override.md is detected instead of silently ignoring memory', () => {
    fs.writeFileSync(path.join(project, 'AGENTS.override.md'), 'Override');
    assert.throws(() => memory.buildPlan(project), /overrides/);
    fs.unlinkSync(path.join(project, 'AGENTS.override.md'));
  });
  check('memory paths cannot escape the project', () => assert.throws(() => memory.safePath(project, '../outside.md'), /escapes/));
  check('junctions cannot redirect writes outside the project', () => {
    const other = path.join(root, 'outside'); fs.mkdirSync(other);
    fs.rmdirSync(path.join(project, '.agent-bridge'));
    fs.symlinkSync(other, path.join(project, '.agent-bridge'), 'junction');
    assert.throws(() => memory.buildPlan(project), /links/);
    fs.unlinkSync(path.join(project, '.agent-bridge'));
  });
  check('memory imports append instead of replacing existing shared notes', () => {
    memory.applyPlan(memory.buildPlan(project, 'import', 'First durable decision'), backups);
    const next = memory.buildPlan(project, 'import', 'Second durable decision');
    const text = next.changes.find(c => c.file === memory.SHARED).after;
    assert.ok(text.includes('First durable decision') && text.includes('Second durable decision'));
  });
  check('Codex MCP merge preserves existing settings and is idempotent', () => {
    fs.mkdirSync(path.join(project, '.codex'));
    fs.writeFileSync(path.join(project, '.codex/config.toml'), 'model = "custom"\n[mcp_servers.other]\ncommand = "other"\n');
    const initial = mcp.plan(project, 'C:\\Program Files\\node.exe', 'C:\\bridge\\server.js');
    memory.applyPlan(initial, backups);
    assert.ok(memory.read(project, '.codex/config.toml').startsWith('model = "custom"'));
    assert.equal(mcp.plan(project, 'C:\\Program Files\\node.exe', 'C:\\bridge\\server.js').changes.length, 0);
    memory.applyPlan(mcp.plan(project, '', '', true), backups);
    assert.ok(!memory.read(project, '.codex/config.toml').includes('[mcp_servers.claude-monitor-vault]'));
  });
  check('quota windows preserve dynamic duration and seconds conversion', () => {
    const rows = quotaRows({ rateLimitsByLimitId: { a: { limitId: 'a', primary: { usedPercent: 42, windowDurationMins: 15, resetsAt: 1000 } }, b: { limitId: 'b', secondary: { usedPercent: 70, windowDurationMins: 10080, resetsAt: 2000 } } } });
    assert.equal(rows.length, 2); assert.equal(rows[0].minutes, 15); assert.equal(rows[0].resetAt, 1000000);
    assert.deepEqual(quotaRows({ rateLimits: { primary: { usedPercent: null } } }), []);
  });
  check('stream redaction works at every possible split and on short secrets', () => {
    for (const secret of ['long-test-secret-12345', 'abc', 'clé-éphémère']) {
      const redact = redactor([['TEST', secret]]);
      for (const [needle, name] of redact.patterns) {
        for (let i = 0; i <= needle.length; i++) {
          let out = ''; const stream = streamRedactor(() => redact.patterns, text => { out += text; });
          stream.write('before ' + needle.slice(0, i)); stream.write(needle.slice(i) + ' after'); stream.end();
          assert.equal(out, 'before «vault:' + name + '» after');
        }
      }
    }
  });
  check('late output can still be redacted with retained patterns', () => {
    const redact = redactor([['TEST', 'late-secret']]); let out = '';
    const stream = streamRedactor(() => redact.patterns, value => { out += value; });
    stream.write('response completed\n'); stream.write('late-'); stream.write('secret\n'); stream.end();
    assert.ok(!out.includes('late-secret')); assert.ok(out.includes('«vault:TEST»'));
  });
  check('Marketplace identity stays compatible with the existing listing', () => {
    const pkg = require('../package.json');
    assert.equal(pkg.name, 'claude-monitor-vault'); assert.equal(pkg.publisher, 'alexossart');
    assert.equal(pkg.capabilities.untrustedWorkspaces.supported, 'limited');
    for (const command of ['switch', 'sync', 'launch', 'connectVault']) assert.ok(pkg.contributes.commands.some(c => c.command === 'agentBridge.' + command));
  });
  console.log(count + ' companion checks passed');
} finally {
  // root is the verified absolute directory returned by mkdtemp, never a user path.
  fs.rmSync(root, { recursive: true, force: true });
}
