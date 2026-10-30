// vault-pane installs from GitHub as its own folder, so it cannot reach vault/:
// it carries a copy of the bridge, to work on a computer without VS Code.
//
//   node scripts/sync-vault-pane.js           refreshes the copy
//   node scripts/sync-vault-pane.js --check   fails when the copy has drifted
'use strict';
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const VAULT = path.join(ROOT, 'vault');
const COPY = path.join(ROOT, 'vault-pane', 'bridge');
const isCheck = process.argv.includes('--check');

const installer = fs.readFileSync(path.join(VAULT, 'install.js'), 'utf8');
const listed = installer.match(/const FILES = \[([\s\S]*?)\];/);
if (!listed) { console.error('FILES not found in install.js'); process.exit(2); }
const files = listed[1].match(/'([^']+)'/g).map(s => s.slice(1, -1)).concat('install.js');

const version = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')).version;
const expected = new Map(files.map(f => [f, fs.readFileSync(path.join(VAULT, f), 'utf8')]));
expected.set('source.json', JSON.stringify({ version }, null, 2) + '\n');

if (isCheck) {
  const drifted = [...expected].filter(([f, text]) => {
    try { return fs.readFileSync(path.join(COPY, f), 'utf8') !== text; }
    catch (e) { return true; }
  }).map(([f]) => f);
  if (drifted.length) {
    console.error('vault-pane/bridge differs from vault/: ' + drifted.join(', ') +
      '\nRun: node scripts/sync-vault-pane.js');
    process.exit(1);
  }
  console.log('vault-pane/bridge matches vault/ (' + expected.size + ' files)');
  process.exit(0);
}

fs.mkdirSync(COPY, { recursive: true });
for (const [f, text] of expected) fs.writeFileSync(path.join(COPY, f), text, 'utf8');
console.log('vault-pane/bridge refreshed (' + expected.size + ' files, version ' + version + ')');
