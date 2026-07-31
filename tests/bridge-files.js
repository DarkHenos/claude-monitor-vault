// The bridge is a COPY of vault/ dropped into ~/.claude. install.js copies a
// hand-written list of files, so any new local require() in the copied code is
// a trap: the extension keeps working (it loads from the repo, where the file
// is there) while the bridge dies at load time — no hooks, no markers, no MCP.
// That happened once, with wordlist.js. This test walks the requires so it
// cannot happen twice.
'use strict';
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const VAULT = path.join(ROOT, 'vault');
const results = [];
const check = (n, c, x) => results.push((c ? 'PASS ' : 'FAIL ') + n + (x ? '  → ' + x : ''));

const src = fs.readFileSync(path.join(VAULT, 'install.js'), 'utf8');
const m = src.match(/const FILES = \[([\s\S]*?)\];/);
if (!m) { console.error('FILES introuvable dans install.js'); process.exit(2); }
const FILES = m[1].match(/'([^']+)'/g).map(s => s.slice(1, -1));
check('FILES lue depuis install.js', FILES.length > 0, FILES.length + ' fichiers');

// Every copied file must exist in vault/.
for (const f of FILES) {
  check('present dans vault/ : ' + f, fs.existsSync(path.join(VAULT, f)));
}

// And every local require inside a copied file must itself be copied.
// Walked transitively: a dependency of a dependency is just as fatal.
const seen = new Set();
const queue = FILES.slice();
while (queue.length) {
  const f = queue.shift();
  if (seen.has(f)) continue;
  seen.add(f);
  const p = path.join(VAULT, f);
  if (!fs.existsSync(p)) continue;
  const code = fs.readFileSync(p, 'utf8');
  const reqs = [...code.matchAll(/require\(\s*'(\.\/[^']+)'\s*\)/g)].map(r => r[1]);
  for (const r of reqs) {
    const target = r.replace(/^\.\//, '') + (/\.js$/.test(r) ? '' : '.js');
    check(f + ' requiert ' + target + ' → copie par install.js',
      FILES.indexOf(target) !== -1,
      FILES.indexOf(target) === -1 ? 'ABSENT DE FILES : le pont ne demarrera pas' : '');
    queue.push(target);
  }
}

// The bridge must load with nothing but the files install.js copies. Loading it
// for real is the only check that proves it: a missing require throws here.
const os = require('os');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'bridge-'));
try {
  for (const f of FILES) fs.copyFileSync(path.join(VAULT, f), path.join(tmp, f));
  const core = require(path.join(tmp, 'core.js'));
  check('core.js se charge avec les seuls fichiers copies',
    typeof core.list === 'function' && typeof core.put === 'function');
} catch (e) {
  check('core.js se charge avec les seuls fichiers copies', false, e.message);
} finally {
  fs.rmSync(tmp, { recursive: true, force: true });
}

console.log(results.join('\n'));
const pass = results.filter(r => r.startsWith('PASS')).length;
console.log('\n' + pass + ' OK, ' + (results.length - pass) + ' FAIL');
process.exit(pass === results.length ? 0 : 1);
