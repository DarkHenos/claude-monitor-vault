'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const MAX_FILE = 256 * 1024;
const MAX_TOTAL = 4 * 1024 * 1024;
const MAX_FILES = 128;
const MAX_DEPTH = 20;

// Return source offsets as well as names: copied Markdown can keep working
// after relocation, including fragments, quoted paths and reference-style links.
function references(text) {
  const refs = [], occupied = [];
  const add = (value, start, end, encoded = false) => {
    if (occupied.some(([a, b]) => start >= a && start < b)) return;
    if (!/\.(?:md|markdown)(?:[?#].*)?$/i.test(value)) return;
    refs.push({ value, start, end, encoded });
  };
  const link = /!?\[[^\]\n]*\]\(\s*(?:<([^>\n]+)>|([^\s)]+))(?:\s+['"][^\n]*?['"])?\s*\)/g;
  for (const m of text.matchAll(link)) {
    const value = m[1] || m[2];
    const start = m.index + m[0].indexOf(value, m[0].indexOf('](') + 2);
    add(value, start, start + value.length, true); occupied.push([m.index, m.index + m[0].length]);
  }
  const definition = /^\s{0,3}\[[^\]\n]+\]:\s*(?:<([^>\n]+)>|([^\s]+))/gm;
  for (const m of text.matchAll(definition)) {
    const value = m[1] || m[2], start = m.index + m[0].lastIndexOf(value);
    add(value, start, start + value.length, true); occupied.push([m.index, m.index + m[0].length]);
  }
  for (const m of text.matchAll(/`([^`\n]+)`|@(?:"([^"\n]+)"|'([^'\n]+)'|([^\s<>`"']+))/g)) {
    const value = m[1] || m[2] || m[3] || m[4];
    const start = m.index + m[0].indexOf(value);
    add(value, start, start + value.length); occupied.push([m.index, m.index + m[0].length]);
  }
  // Plain filenames in prose are common in MEMORY.md indexes. A whole URI is
  // captured here so its tail is never mistaken for a local filename.
  for (const m of text.matchAll(/[^\s<>`"'\[\]()*,;]+?\.(?:md|markdown)(?:#[\w%-]+)?(?=$|[\s<>`"'\[\]()*,;.!?])/gi)) {
    add(m[0], m.index, m.index + m[0].length);
  }
  return refs.sort((a, b) => a.start - b.start);
}

function within(scope, target) {
  const relative = path.relative(scope, target);
  return !path.isAbsolute(relative) && relative !== '..' && !relative.startsWith('..' + path.sep);
}
function checked(scope, target) {
  if (!within(scope, target)) throw new Error('outside-scope');
  let current = scope;
  // Resolve the explicitly chosen directory once, then reject links beneath it.
  for (const segment of path.relative(scope, target).split(path.sep)) {
    current = path.join(current, segment);
    if (fs.lstatSync(current).isSymbolicLink()) throw new Error('symbolic-link');
  }
  return target;
}
function readSource(scope, target) {
  checked(scope, target);
  const stat = fs.statSync(target);
  if (!stat.isFile()) throw new Error('not-a-file');
  if (stat.size > MAX_FILE) throw new Error('file-too-large');
  return fs.readFileSync(target, 'utf8');
}
function destination(ref, from) {
  if (/^[a-z][a-z0-9+.-]*:/i.test(ref) && !/^[a-z]:[\\/]/i.test(ref)) return { external: true };
  if (ref.startsWith('//') || ref.startsWith('\\\\')) return { external: true };
  const at = ref.search(/[?#]/);
  const raw = at >= 0 ? ref.slice(0, at) : ref;
  let decoded;
  try { decoded = decodeURIComponent(raw).replace(/\\/g, path.sep); } catch (_) { return { invalid: true }; }
  if (decoded.includes('\0') || decoded.startsWith('~')) return { invalid: true };
  return { file: path.resolve(path.dirname(from), decoded), suffix: at >= 0 ? ref.slice(at) : '' };
}
function discover(entry, scope, clean = text => text, limits = {}) {
  const chosenScope = path.resolve(scope);
  entry = path.resolve(entry);
  scope = fs.realpathSync(scope);
  if (within(chosenScope, entry)) entry = path.resolve(scope, path.relative(chosenScope, entry));
  const files = [], missing = [], skipped = [], seen = new Set(), issues = new Set();
  const queue = [{ file: entry, depth: 0 }]; let totalBytes = 0;
  const identity = file => process.platform === 'win32' ? file.toLowerCase() : file;
  const issue = (bucket, from, reference, reason, file) => {
    const key = reason + ':' + (file || reference);
    if (!issues.has(key)) { bucket.push({ from, reference, reason, file }); issues.add(key); }
  };
  while (queue.length) {
    const item = queue.shift(), key = identity(item.file);
    if (seen.has(key)) continue;
    seen.add(key);
    if (files.length >= (limits.maxFiles || MAX_FILES) || item.depth > (limits.maxDepth ?? MAX_DEPTH)) {
      issue(skipped, item.from, item.reference || item.file, 'scan-limit', item.file); continue;
    }
    let original;
    try { original = readSource(scope, item.file); }
    catch (e) {
      if (item.file === entry) throw new Error('Cannot read memory index: ' + e.message);
      issue(e.code === 'ENOENT' ? missing : skipped, item.from, item.reference || item.file,
        e.code === 'ENOENT' ? 'missing' : e.message, item.file); continue;
    }
    if (totalBytes + Buffer.byteLength(original) > (limits.maxTotalBytes || MAX_TOTAL)) {
      issue(skipped, item.from, item.reference || item.file, 'total-size-limit', item.file); continue;
    }
    totalBytes += Buffer.byteLength(original);
    const text = clean(original);
    const refs = references(text).map(ref => ({ ...ref, ...destination(ref.value, item.file) }));
    files.push({ file: item.file, relative: path.relative(scope, item.file).split(path.sep).join('/'), original, text, refs });
    for (const ref of refs) {
      if (ref.external) continue; // Never fetch web links or network shares.
      if (ref.invalid) { issue(skipped, item.file, ref.value, 'unsupported-path'); continue; }
      if (!within(scope, ref.file)) { issue(skipped, item.file, ref.value, 'outside-scope', ref.file); continue; }
      queue.push({ file: ref.file, depth: item.depth + 1, from: item.file, reference: ref.value });
    }
  }
  const digest = crypto.createHash('sha256');
  digest.update(entry);
  for (const file of files) digest.update('\0' + file.relative + '\0' + file.text);
  return { entry, scope, files, missing, skipped, totalBytes, id: digest.digest('hex').slice(0, 20) };
}

function relocate(node, targetFile, targets) {
  let text = node.text;
  for (const ref of [...node.refs].reverse()) {
    const dest = ref.file && targets.get(process.platform === 'win32' ? ref.file.toLowerCase() : ref.file);
    if (!dest) continue;
    const relative = path.posix.relative(path.posix.dirname(targetFile), dest);
    // Percent encoding is readable by both Markdown links and file references.
    const value = (ref.encoded ? relative.split('/').map(encodeURIComponent).join('/') : relative) + (ref.suffix || '');
    text = text.slice(0, ref.start) + value + text.slice(ref.end);
  }
  return text;
}
function assertUnchanged(graph) {
  for (const node of graph.files) {
    if (readSource(graph.scope, node.file) !== node.original) throw new Error('Linked memory changed since preview: ' + node.relative);
  }
  for (const missing of graph.missing) {
    if (missing.file && fs.existsSync(missing.file)) throw new Error('A missing memory file appeared since preview: ' + missing.reference);
  }
}
module.exports = { references, discover, relocate, assertUnchanged, within };
