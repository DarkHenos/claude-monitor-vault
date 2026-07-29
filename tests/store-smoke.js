// Integration smoke test for the vault's key storage, run against the REAL
// operating-system secret store — DPAPI, the macOS keychain, libsecret — not a
// stub. This is the piece that cannot be simulated from a developer machine,
// so CI runs it on the three platforms.
//
//   node tests/store-smoke.js
//
// EXPECT_MODE, when set, asserts which provider must have been chosen. Left
// unset, the test only checks that a secret survives a full round trip.
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

// A throwaway home, set BEFORE core.js is required: it reads os.homedir() once,
// at load time, to place the vault directory.
const home = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-vault-ci-'));
process.env.HOME = home;
process.env.USERPROFILE = home;
fs.mkdirSync(path.join(home, '.claude'), { recursive: true });

const vault = require('../vault/core.js');

const NAME = 'CI_SMOKE_KEY';
const VALUE = 'valeur-' + process.pid + '-' + Math.floor(process.uptime() * 1e6);
const expect = process.env.EXPECT_MODE || '';

let failures = 0;
function check(label, ok, detail) {
  console.log((ok ? 'PASS ' : 'FAIL ') + label + (detail ? '  -> ' + detail : ''));
  if (!ok) failures++;
}

function cleanup() {
  // The OS store outlives the temp directory, so take the entry back out.
  try {
    if (process.platform === 'darwin') {
      spawnSync('security', ['delete-generic-password', '-s', 'claude-vault', '-a', 'master-key'],
        { stdio: 'ignore' });
    } else if (process.platform === 'linux') {
      spawnSync('secret-tool', ['clear', 'service', 'claude-vault', 'account', 'master-key'],
        { stdio: 'ignore' });
    }
  } catch (e) { /* best effort */ }
  try { fs.rmSync(home, { recursive: true, force: true }); } catch (e) { /* best effort */ }
}

try {
  vault.put(NAME, VALUE, {});
  const back = vault.consume(NAME, 'ci').value;
  check('a secret survives a full round trip', back === VALUE);

  const kf = JSON.parse(fs.readFileSync(path.join(home, '.claude', 'vault', 'masterkey.bin'), 'utf8'));
  const health = vault.healthCheck();
  const issues = health.issues.map(i => i.msg);

  console.log('    platform : ' + process.platform);
  console.log('    mode     : ' + kf.mode);
  console.log('    issues   : ' + (issues.length ? issues.join(' | ') : 'none'));

  if (expect) {
    check('protection mode is ' + expect, kf.mode === expect, 'got ' + kf.mode);
  }

  // When a real OS store holds the key, the file must carry no key material.
  if (kf.mode === 'keychain' || kf.mode === 'libsecret') {
    check('the key file holds no key material', !kf.blob, JSON.stringify(kf.blob));
    check('no fallback warning is raised', issues.length === 0, issues.join(' | '));
  }
  // Under DPAPI the wrapped blob lives in the file, but never the raw key.
  if (kf.mode === 'dpapi') {
    check('the key file holds a wrapped blob', !!kf.blob && kf.blob.length > 0);
  }

  const raw = JSON.parse(fs.readFileSync(path.join(home, '.claude', 'vault', 'vault.json'), 'utf8'));
  check('the vault is written in the current format', raw.v === 2, 'v=' + raw.v);
  check('the value is nowhere in the vault file',
    fs.readFileSync(path.join(home, '.claude', 'vault', 'vault.json'), 'utf8').indexOf(VALUE) === -1);
} catch (e) {
  check('the run completed', false, e && e.message ? e.message : String(e));
} finally {
  cleanup();
}

console.log(failures ? '\n' + failures + ' FAILURE(S)' : '\nall good');
process.exit(failures ? 1 : 0);
