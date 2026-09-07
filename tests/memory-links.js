'use strict';
const assert = require('assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const links = require('../companion/memory-links');
const memory = require('../companion/memory');
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'linked-memory-test-'));
const project = path.join(temp, 'project'); fs.mkdirSync(project);
const write = (root, file, text) => { const dest = path.join(root, file); fs.mkdirSync(path.dirname(dest), { recursive: true }); fs.writeFileSync(dest, text); };
let count = 0;
const check = (name, fn) => { fn(); count++; console.log('PASS ' + name); };
try {
  write(project, 'CLAUDE.md', '# Main\n[Feedback](feedback_style.md)\n@rules/conventions.md\n`user_profile.md`\nRead decisions.md.\n[again](feedback_style.md#tone)\n[reference][extra]\n[extra]: <notes with spaces.md>\n');
  write(project, 'feedback_style.md', 'Use concise replies.\n[main](CLAUDE.md)\n');
  write(project, 'rules/conventions.md', '# Rules\n[parent](../decisions.md#choices)\n');
  write(project, 'user_profile.md', 'Prefer French.\n');
  write(project, 'decisions.md', '# Decisions\n');
  write(project, 'notes with spaces.md', 'Space in filename.\n');
  const graph = links.discover(path.join(project, 'CLAUDE.md'), project);
  check('different filenames and nested references are counted once, including cycles', () => {
    assert.equal(graph.files.length, 6); assert.equal(graph.missing.length, 0); assert.equal(graph.skipped.length, 0);
    assert.equal(new Set(graph.files.map(f => f.file)).size, 6);
  });
  check('Markdown labels are not mistaken for file references', () => {
    assert.deepEqual(links.references('[not-a-file.md](real.md#anchor)').map(r => r.value), ['real.md#anchor']);
    assert.deepEqual(links.references('Read .claude/topic.md and ../other.md.').map(r => r.value), ['.claude/topic.md', '../other.md']);
  });
  check('quoted imports, Windows separators and URL-encoded spaces are recognized', () => {
    const refs = links.references('@"notes with spaces.md"\n`rules\\conventions.md`\n[space](notes%20with%20spaces.md)');
    assert.equal(refs.length, 3);
  });
  check('multiple mentions of a missing file produce one missing-file entry', () => {
    write(project, 'broken.md', '[missing](unknown.md)\n`unknown.md`\nhttps://example.org/remote.md\n[remote](https://example.org/other.md)\n[escape](../private.md)');
    const found = links.discover(path.join(project, 'broken.md'), project);
    assert.equal(found.files.length, 1); assert.equal(found.missing.length, 1);
    assert.equal(found.skipped.length, 1); assert.equal(found.skipped[0].reason, 'outside-scope');
  });
  check('file-count and depth bounds report incomplete scans', () => {
    const limited = links.discover(path.join(project, 'CLAUDE.md'), project, text => text, { maxFiles: 2 });
    assert.equal(limited.files.length, 2); assert.ok(limited.skipped.length > 0);
    const shallow = links.discover(path.join(project, 'CLAUDE.md'), project, text => text, { maxDepth: 0 });
    assert.equal(shallow.files.length, 1); assert.ok(shallow.skipped.length > 0);
  });
  const plan = memory.buildPlan(project, 'claude');
  check('plan includes an inventory and a separate copy of every linked file', () => {
    assert.equal(plan.inventory.files.length, 6);
    assert.equal(plan.changes.filter(c => c.file.startsWith('.agent-bridge/imports/')).length, 6);
  });
  const backup = memory.applyPlan(plan, path.join(temp, 'backups'));
  check('relocated links resolve to imported files and preserve anchors', () => {
    const main = plan.changes.find(c => c.file.endsWith('/CLAUDE.md'));
    const copied = links.discover(path.join(project, main.file), path.dirname(path.join(project, main.file)));
    assert.equal(copied.files.length, 6); assert.equal(copied.missing.length, 0);
    const shared = memory.read(project, memory.SHARED);
    assert.ok(shared.includes('feedback_style.md#tone'));
    assert.ok(shared.includes('notes%20with%20spaces.md'));
  });
  check('identical reimport is idempotent after native managed blocks were added', () => {
    assert.equal(memory.buildPlan(project, 'claude').changes.length, 0);
  });
  check('a linked-file edit invalidates its pending preview', () => {
    const stale = memory.buildPlan(project, 'claude');
    write(project, 'decisions.md', '# A newer decision\n');
    assert.throws(() => memory.applyPlan(stale, path.join(temp, 'backups')), /Linked memory changed/);
  });
  check('a changed linked file creates a new snapshot and keeps previous imported notes', () => {
    const next = memory.buildPlan(project, 'claude');
    assert.notEqual(next.inventory.id, plan.inventory.id);
    assert.ok(next.changes.find(c => c.file === memory.SHARED).after.includes(plan.inventory.id));
    assert.ok(next.changes.some(c => c.file.endsWith('/decisions.md') && c.after.includes('newer decision')));
  });
  check('source files outside the project can be selected with their sibling memories', () => {
    const external = path.join(temp, 'claude-memories');
    write(external, 'MEMORY.md', '[One](first/topic.md)\n[Two](second/topic.md)');
    write(external, 'first/topic.md', 'First topic'); write(external, 'second/topic.md', 'Second topic');
    const imported = memory.buildPlan(project, 'import', { entry: path.join(external, 'MEMORY.md') });
    assert.equal(imported.inventory.files.length, 3);
    assert.equal(imported.changes.filter(c => c.file.endsWith('/topic.md')).length, 2);
  });
  check('a newly created formerly missing reference requires a fresh scan', () => {
    const stale = links.discover(path.join(project, 'broken.md'), project);
    write(project, 'unknown.md', 'Now available');
    assert.throws(() => links.assertUnchanged(stale), /appeared since preview/);
  });
  check('restoration removes imported snapshots and preserves untouched original memories', () => {
    memory.restore(backup);
    assert.equal(memory.read(project, memory.SHARED), null);
    assert.equal(memory.read(project, 'decisions.md'), '# A newer decision\n');
    assert.ok(!fs.existsSync(path.join(project, '.agent-bridge/imports', plan.inventory.id, 'feedback_style.md')));
  });
  console.log(count + ' linked-memory checks passed');
} finally { fs.rmSync(temp, { recursive: true, force: true }); }
