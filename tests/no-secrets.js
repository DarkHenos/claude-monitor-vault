// Nothing that looks like a credential may enter this repository. Checked on
// every push, because "we looked once" is how a key gets committed six months
// later. It cannot use the vault's own fingerprints, which need a real vault, so
// it looks for the shapes instead, and for file names that should never exist
// here at all.
'use strict';
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const results = [];
const check = (n, c, x) => results.push((c ? 'PASS ' : 'FAIL ') + n + (x ? '  → ' + x : ''));
const git = a => execSync('git ' + a, { cwd: ROOT, encoding: 'utf8', maxBuffer: 5e8 });

const BINAIRE = /\.(png|svg|jpg|jpeg|gif|ico|vsix|woff2?)$/i;

// Shapes that are a credential and nothing else. Deliberately anchored and
// long: a pattern that also matches ordinary text gets switched off after the
// third false alarm, and then it protects nothing.
const SHAPES = [
  ['PEM private key', /-----BEGIN (RSA |OPENSSH |EC |DSA |PGP )?PRIVATE KEY-----/],
  ['GitHub token', /\bghp_[A-Za-z0-9]{30,}/],
  ['GitHub PAT', /\bgithub_pat_[A-Za-z0-9_]{40,}/],
  ['Anthropic key', /\bsk-ant-[A-Za-z0-9-]{20,}/],
  ['OpenAI key', /\bsk-[A-Za-z0-9]{40,}/],
  ['Stripe secret key', /\bsk_(live|test)_[A-Za-z0-9]{20,}/],
  ['Slack token', /\bxox[baprs]-[A-Za-z0-9-]{10,}/],
  ['AWS access key', /\bAKIA[0-9A-Z]{16}\b/],
  ['Google OAuth token', /\bya29\.[A-Za-z0-9_-]{20,}/],
  ['service account', /"private_key"\s*:\s*"-----BEGIN/]
];

// Names that have no business being tracked, whatever they contain.
const NAMES = /(^|\/)(\.env|\.env\..+|.+\.pem|.+\.key|.+\.p12|.+\.pfx|id_rsa|id_ed25519|credentials\.json|\.credentials\.json|vault\.json|masterkey\.bin|recovery\.bin|trash\.json|policy\.json|.+\.cvault)$/i;

// --- what is tracked right now
const tracked = git('ls-files').trim().split('\n').filter(Boolean);
check('the repository has tracked files', tracked.length > 0, tracked.length + ' files');

const badNames = tracked.filter(f => NAMES.test(f));
check('no credential-shaped file name is tracked', badNames.length === 0, badNames.join(', '));

let scanned = 0;
const hits = [];
for (const f of tracked) {
  if (BINAIRE.test(f)) continue;
  let txt;
  try { txt = fs.readFileSync(path.join(ROOT, f), 'utf8'); } catch (e) { continue; }
  scanned++;
  for (const [name, re] of SHAPES) if (re.test(txt)) hits.push(name + ' in ' + f);
}
check('no credential shape in the tracked files', hits.length === 0,
  hits.length ? hits.join(' | ') : scanned + ' files read');

// --- and everything the history ever held
//
// Object types come from git, never guessed from the content. Filtering trees
// out by "does it contain a space" reads every blob as a tree and silently
// scans almost nothing, which is exactly the kind of check that reports success
// while looking at three files out of three hundred.
// Reachable objects only. --batch-all-objects also lists what git has not
// collected yet, and an unreachable blob is never pushed anywhere: reporting one
// is an alarm about a file that exists on this disk and nowhere else.
let named = new Map();
let blobs = [];
try {
  for (const l of git('rev-list --objects --all').trim().split('\n')) {
    const i = l.indexOf(' ');
    if (i !== -1) named.set(l.slice(0, i), l.slice(i + 1));
  }
  const types = new Map();
  for (const l of git('cat-file --batch-check --batch-all-objects').trim().split('\n')) {
    const p = l.split(' ');
    if (p.length >= 3) types.set(p[0], { type: p[1], size: Number(p[2]) });
  }
  for (const [sha, name] of named) {
    const t = types.get(sha);
    if (t && t.type === 'blob') blobs.push({ sha, name, size: t.size });
  }
} catch (e) { /* shallow clone: the tracked check above still stands */ }

if (blobs.length) {
  const past = [...new Set([...named.values()].filter(n => NAMES.test(n)))];
  check('no credential-shaped file name in the history', past.length === 0, past.join(', '));

  let seen = 0, bytes = 0;
  const old = [];
  for (const b of blobs) {
    if (BINAIRE.test(b.name) || b.size > 4000000) continue;
    let t;
    try { t = git('cat-file -p ' + b.sha); } catch (e) { continue; }
    seen++; bytes += t.length;
    for (const [name, re] of SHAPES) {
      if (re.test(t)) old.push(name + ' in ' + b.name + ' (' + b.sha.slice(0, 8) + ')');
    }
  }
  check('every blob in the history was read', seen >= tracked.length,
    seen + ' blobs, ' + Math.round(bytes / 1024) + ' KB');
  check('no credential shape anywhere in the history', old.length === 0,
    old.length ? old.join(' | ') : 'clean');
} else {
  check('history not available, tracked files checked only', true, 'shallow clone');
}

// --- the package that reaches the Marketplace
const ignore = fs.readFileSync(path.join(ROOT, '.vscodeignore'), 'utf8');
for (const must of ['tests/**', 'node_modules/**', '.git/**']) {
  check('.vscodeignore excludes ' + must, ignore.indexOf(must) !== -1);
}

console.log(results.join('\n'));
const pass = results.filter(r => r.startsWith('PASS')).length;
console.log('\n' + pass + ' OK, ' + (results.length - pass) + ' FAIL');
process.exit(pass === results.length ? 0 : 1);
