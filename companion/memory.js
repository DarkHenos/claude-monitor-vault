'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const links = require('./memory-links');
const START = '<!-- agent-bridge:memory:start -->';
const END = '<!-- agent-bridge:memory:end -->';
const SHARED = '.agent-bridge/MEMORY.md';
const LIMIT = 256 * 1024;
const hash = value => crypto.createHash('sha256').update(value).digest('hex');

function safePath(root, relative) {
  const base = path.resolve(root);
  const target = path.resolve(base, relative);
  if (!target.startsWith(base + path.sep)) throw new Error('Memory path escapes the project.');
  let current = base;
  for (const segment of path.relative(base, target).split(path.sep)) {
    current = path.join(current, segment);
    try { if (fs.lstatSync(current).isSymbolicLink()) throw new Error('Memory links are not supported: ' + relative); }
    catch (e) { if (e.code !== 'ENOENT') throw e; }
  }
  return target;
}
function read(root, relative) {
  const file = safePath(root, relative);
  try {
    if (fs.statSync(file).size > LIMIT) throw new Error('Memory file is larger than 256 KB: ' + relative);
    return fs.readFileSync(file, 'utf8');
  } catch (e) { if (e.code === 'ENOENT') return null; throw e; }
}
function split(text) {
  text = text || '';
  const a = text.indexOf(START), b = text.indexOf(END);
  if (a < 0 && b < 0) return { before: text, block: null, after: '' };
  if (a < 0 || b < a || text.indexOf(START, a + START.length) >= 0 || text.indexOf(END, b + END.length) >= 0) {
    throw new Error('Conflicting or incomplete Agent Bridge markers. Repair the file before syncing.');
  }
  return { before: text.slice(0, a), block: text.slice(a, b + END.length), after: text.slice(b + END.length) };
}
const BLOCK = START + '\n## Shared project memory\n'
  + 'Read `.agent-bridge/MEMORY.md` before working on this project. It contains shared conventions, decisions and handoff notes for Claude Code and Codex.\n'
  + 'Keep durable project knowledge there, never credentials or private conversation transcripts. Preserve assistant-specific instructions outside this block.\n' + END;

function buildPlan(root, source = 'shared', imported) {
  const originals = {};
  for (const file of ['CLAUDE.md', 'AGENTS.md', SHARED]) originals[file] = read(root, file);
  // Codex selects AGENTS.override.md in preference to AGENTS.md.
  if (read(root, 'AGENTS.override.md') !== null) throw new Error('AGENTS.override.md overrides AGENTS.md. Merge or rename it before enabling shared memory.');
  let shared = originals[SHARED];
  let inventory = null;
  const linkedChanges = [];
  if (source === 'shared' && shared !== null) inventory = links.discover(safePath(root, SHARED), root);
  if (source !== 'shared') {
    let incoming;
    const clean = text => { const parts = split(text); return (parts.before + parts.after).trim(); };
    if (source === 'import' && imported && typeof imported === 'object') {
      const entry = path.resolve(imported.entry);
      const scope = links.within(path.resolve(root), entry) ? path.resolve(root) : path.dirname(entry);
      inventory = links.discover(entry, scope, clean);
      incoming = inventory.files[0]?.text;
    } else if (source === 'import') incoming = imported;
    else if (source === 'claude' || source === 'codex') {
      inventory = links.discover(safePath(root, source === 'claude' ? 'CLAUDE.md' : 'AGENTS.md'), root, clean);
      incoming = inventory.files[0]?.text;
    } else throw new Error('Unknown memory source.');
    if (!incoming || !incoming.trim()) throw new Error('The selected memory source is empty.');
    if (Buffer.byteLength(incoming) > LIMIT) throw new Error('Memory source is larger than 256 KB.');
    if (inventory && inventory.files.length > 1) {
      const targets = new Map(inventory.files.map(node => [process.platform === 'win32' ? node.file.toLowerCase() : node.file,
        '.agent-bridge/imports/' + inventory.id + '/' + node.relative]));
      for (const node of inventory.files) {
        const target = targets.get(process.platform === 'win32' ? node.file.toLowerCase() : node.file);
        const before = read(root, target);
        const after = links.relocate(node, target, targets);
        if (Buffer.byteLength(after) > LIMIT) throw new Error('Relocated memory is larger than 256 KB: ' + node.relative);
        // Content-addressed snapshots cannot be overwritten after a user edits them.
        if (before !== null && before !== after) throw new Error('Imported memory was edited: ' + target + '. Preserve or rename it before importing again.');
        originals[target] = before;
        if (before !== after) linkedChanges.push({ file: target, before, after });
      }
      incoming = links.relocate(inventory.files[0], SHARED, targets);
      const mainTarget = targets.get(process.platform === 'win32' ? inventory.entry.toLowerCase() : inventory.entry);
      incoming += '\n\n[Imported memory index (' + inventory.files.length + ' files)]('
        + path.posix.relative(path.posix.dirname(SHARED), mainTarget).split('/').map(encodeURIComponent).join('/') + ')';
    }
    // Imports append a labelled snapshot; they never overwrite existing shared knowledge.
    const section = '\n\n## Imported project notes (' + source + ')\n\n' + incoming.trim() + '\n';
    if (!shared || !shared.includes(incoming.trim())) shared = (shared || '# Shared project memory\n') + section;
  }
  if (shared === null) shared = '# Shared project memory\n\n## Project conventions\n\n## Decisions\n\n## Handoff\n\nRecord current work, validation results and next steps here before switching assistants.\n';
  const changes = [];
  for (const file of ['CLAUDE.md', 'AGENTS.md']) {
    const parts = split(originals[file]);
    if (parts.block && parts.block !== BLOCK) throw new Error('The managed memory block was edited in ' + file + '. Review it before syncing.');
    const next = parts.block ? parts.before + BLOCK + parts.after
      : (parts.before ? parts.before + (parts.before.endsWith('\n\n') ? '' : '\n\n') : '') + BLOCK + '\n';
    if (next !== originals[file]) changes.push({ file, before: originals[file], after: next });
  }
  if (shared !== originals[SHARED]) changes.push({ file: SHARED, before: originals[SHARED], after: shared });
  if (Buffer.byteLength(shared) > LIMIT) throw new Error('Shared memory is larger than 256 KB. Archive older imported notes before continuing.');
  changes.push(...linkedChanges);
  return { root: path.resolve(root), originals, changes, inventory };
}

function applyPlan(plan, backupRoot) {
  if (plan.inventory) links.assertUnchanged(plan.inventory);
  // Refuse a stale preview before writing any file.
  for (const [file, before] of Object.entries(plan.originals)) {
    if (read(plan.root, file) !== before) throw new Error('Memory changed since preview: ' + file + '. Preview again.');
  }
  if (!plan.changes.length) return null;
  const dir = path.join(backupRoot, hash(plan.root).slice(0, 20), Date.now() + '-' + crypto.randomBytes(4).toString('hex'));
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const record = { root: plan.root, changes: plan.changes };
  const backup = path.join(dir, 'backup.json');
  fs.writeFileSync(backup, JSON.stringify(record), { mode: 0o600, flag: 'wx' });
  const written = [];
  try {
    for (const change of plan.changes) {
      const file = safePath(plan.root, change.file);
      if (read(plan.root, change.file) !== change.before) throw new Error('Concurrent memory edit: ' + change.file);
      fs.mkdirSync(path.dirname(file), { recursive: true });
      atomic(file, change.after); written.push(change);
    }
  } catch (e) {
    for (const change of written.reverse()) {
      // Do not roll back over edits made by another process after our write.
      if (read(plan.root, change.file) !== change.after) continue;
      const file = safePath(plan.root, change.file);
      if (change.before === null) fs.unlinkSync(file); else atomic(file, change.before);
    }
    throw e;
  }
  return backup;
}
function atomic(file, text) {
  const temp = file + '.' + crypto.randomBytes(6).toString('hex') + '.tmp';
  try { fs.writeFileSync(temp, text, { mode: 0o600, flag: 'wx' }); fs.renameSync(temp, file); }
  finally { try { fs.unlinkSync(temp); } catch (_) {} }
}
function restore(backup) {
  const record = JSON.parse(fs.readFileSync(backup, 'utf8'));
  for (const change of record.changes) {
    if (read(record.root, change.file) !== change.after) throw new Error('Cannot restore over newer edits: ' + change.file);
  }
  for (const change of record.changes) {
    const file = safePath(record.root, change.file);
    if (change.before === null) fs.unlinkSync(file); else atomic(file, change.before);
  }
  return record.root;
}
module.exports = { SHARED, BLOCK, split, read, safePath, buildPlan, applyPlan, restore };
