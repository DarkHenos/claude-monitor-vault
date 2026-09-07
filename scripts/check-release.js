'use strict';
const fs = require('fs'), path = require('path'), assert = require('assert/strict');
const root = path.resolve(__dirname, '..');
const read = f => fs.readFileSync(path.join(root, f), 'utf8');
const p = JSON.parse(read('package.json'));
assert.equal(p.name, 'claude-monitor-vault'); assert.equal(p.publisher, 'alexossart');
if (fs.existsSync(path.join(root, 'package-lock.json'))) {
 const lock = JSON.parse(read('package-lock.json'));
 assert.equal(lock.version,p.version,'Lockfile version');
 assert.equal(lock.packages[''].version,p.version,'Root dependency version');
}
assert.ok(read('CHANGELOG.md').includes('## ['+p.version+']'));
assert.ok(read('README.md').includes('Version '+p.version));
for (const f of ['README.md','docs/GUIDE.md']) {
 for (const match of read(f).matchAll(/(?:src="|\]\()([^"\s)]+)(?:"|\))/g)) {
  const ref=match[1].split('#')[0];
  if (!ref || /^(https?:|data:)/.test(ref)) continue;
  assert.ok(fs.existsSync(path.resolve(root,path.dirname(f),ref)),f+': missing '+ref);
 }
}
console.log('PASS release version, Marketplace identity and local documentation links');
