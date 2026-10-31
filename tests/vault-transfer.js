// The transfer string and the phrase history, against the real core and real
// crypto, on throwaway vaults. Two "machines" means two home directories and two
// loads of core.js. 'plain' key storage is forced by hiding the platform: the OS
// keyring is one entry per user, so two vaults in it would overwrite each other,
// and a test has no business near the real one anyway.
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const assert = require('assert/strict');
const Module = require('module');

Object.defineProperty(process, 'platform', { value: 'freebsd' });

const CORE = path.join(__dirname, '..', 'vault', 'core.js');
const homes = [];

function machine() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-vault-transfer-'));
  fs.mkdirSync(path.join(home, '.claude'), { recursive: true });
  homes.push(home);
  const origLoad = Module._load;
  Module._load = function (request) {
    if (request === 'os') return Object.assign(Object.create(os), { homedir: () => home });
    return origLoad.apply(this, arguments);
  };
  for (const id of Object.keys(require.cache)) {
    if (id.startsWith(path.dirname(CORE))) delete require.cache[id];
  }
  const vault = require(CORE);
  Module._load = origLoad;
  vault.home = home;
  return vault;
}

const PASSWORD = 'correct horse battery staple';
const results = [];
async function test(name, fn) {
  try { await fn(); results.push('PASS ' + name); }
  catch (e) { results.push('FAIL ' + name + '  -> ' + (e && e.message)); }
}
const value = (v, name) => v.consume(name, 'test').value;
const dir = v => path.join(v.home, '.claude', 'vault');
const exportOf = v => JSON.parse(fs.readFileSync(v.exportStatus().path, 'utf8'));

(async () => {
  const a = machine();
  a.createGroup('Payments');
  a.addSeparator('Second part');
  a.createGroup('Empty one');
  a.put('API_ONE', 'value-of-api-one-0123456789', { mcp: true, mcpServers: ['server-a'], note: 'first', groupId: a.findGroup('Payments').id, by: 'user' });
  a.put('API_TWO', 'value-of-api-two-0123456789', { confirm: true, maxUses: 5, by: 'user' });
  a.put('SHARED', 'same-on-both-machines-012345', { by: 'user' });
  a.put('CLASH', 'value-from-a-0123456789', { by: 'user' });
  a.put('GONE', 'already-expired-0123456789', { expiresAt: Date.now() + 100000, by: 'user' });

  let built;
  await test('the string reveals nothing readable and has a recognisable shape', async () => {
    built = await a.transferBuild(PASSWORD);
    assert.ok(built.text.startsWith('cvault1.'));
    assert.equal(/\s/.test(built.text), false);
    assert.equal(built.count, 5);
    const decoded = Buffer.from(built.text.slice(8), 'base64url').toString('latin1');
    for (const needle of ['API_ONE', 'value-of-api', 'Payments', 'first']) {
      assert.equal(built.text.includes(needle) || decoded.includes(needle), false, needle);
    }
  });

  await test('creating a string is logged and costs no use', () => {
    assert.ok(a.auditLog(50).some(e => e.event === 'transfer-out' && e.detail === '5'));
    assert.equal(a.list().secrets.find(s => s.name === 'API_TWO').uses || 0, 0);
  });

  await test('weak passwords are refused by the core itself', async () => {
    for (const bad of ['short', 'aaaaaaaaaaaaaaaa', ' spaces around it ']) {
      assert.ok(a.transferPasswordIssue(bad), bad);
      await assert.rejects(a.transferBuild(bad));
    }
    assert.equal(a.transferPasswordIssue(PASSWORD), null);
  });

  await test('a generated password is strong, readable, and opens its string', async () => {
    const seen = new Set();
    for (let i = 0; i < 200; i++) {
      const p = a.transferPasswordGenerate();
      assert.match(p, /^[A-HJKMNP-Z2-9]{5}(-[A-HJKMNP-Z2-9]{5}){3}$/);
      assert.equal(a.transferPasswordIssue(p), null);
      seen.add(p);
    }
    assert.equal(seen.size, 200);
    const p = a.transferPasswordGenerate();
    const made = await a.transferBuild(p);
    assert.equal((await a.transferOpen(made.text, p)).keys.length, 5);
  });

  const b = machine();
  b.createGroup('Mine');
  b.put('LOCAL_ONLY', 'value-only-on-b-0123456789', { by: 'user', groupId: b.findGroup('Mine').id });
  b.put('SHARED', 'same-on-both-machines-012345', { by: 'user' });
  b.put('CLASH', 'value-from-b-0123456789', { by: 'user' });
  const bKey = fs.readFileSync(path.join(dir(b), 'masterkey.bin'), 'utf8');

  await test('a damaged string is told apart from a wrong password', async () => {
    const cut = built.text.slice(0, built.text.length - 40);
    assert.throws(() => b.transferCheck(cut), /incomplete/);
    assert.throws(() => b.transferCheck('hello'), /not a transfer string/);
    const middle = Math.floor(built.text.length / 2);
    const flipped = built.text.slice(0, middle) + (built.text[middle] === 'A' ? 'B' : 'A') + built.text.slice(middle + 1);
    assert.throws(() => b.transferCheck(flipped), /incomplete/);
    await assert.rejects(b.transferOpen(built.text, 'not the right password'), e => e.wrongPassword === true);
  });

  await test('a line-wrapped paste still opens', async () => {
    const wrapped = built.text.replace(/(.{76})/g, '$1\r\n');
    assert.equal(b.transferCheck(wrapped), true);
    assert.equal((await b.transferOpen(wrapped, PASSWORD)).keys.length, 5);
  });

  await test('a string asking for an absurd scrypt cost is refused before deriving', () => {
    const raw = Buffer.from(built.text.slice(8), 'base64url');
    const body = raw.subarray(0, raw.length - 4);
    body[16] = 40;
    const sum = require('crypto').createHash('sha256').update(body).digest().subarray(0, 4);
    const forged = 'cvault1.' + Buffer.concat([body, sum]).toString('base64url');
    assert.throws(() => b.transferCheck(forged), /newer version/);
  });

  await test('the preview sorts every key without writing anything', async () => {
    const before = fs.readFileSync(path.join(dir(b), 'vault.json'), 'utf8');
    const data = await b.transferOpen(built.text, PASSWORD);
    const p = b.transferPreview(data);
    assert.deepEqual(p.fresh.sort(), ['API_ONE', 'API_TWO', 'GONE']);
    assert.deepEqual(p.same, ['SHARED']);
    assert.deepEqual(p.conflicts, ['CLASH']);
    assert.equal(p.mcp, 1);
    assert.equal(fs.readFileSync(path.join(dir(b), 'vault.json'), 'utf8'), before);
  });

  await test('importing merges: nothing here is lost, and no master key travels', async () => {
    const data = await b.transferOpen(built.text, PASSWORD);
    const r = b.transferApply(data, 'keep');
    assert.deepEqual(r, { added: 3, replaced: 0, kept: 1, same: 1, expired: 0 });
    assert.equal(fs.readFileSync(path.join(dir(b), 'masterkey.bin'), 'utf8').includes(JSON.parse(bKey).blob), true);
    assert.equal(value(b, 'LOCAL_ONLY'), 'value-only-on-b-0123456789');
    assert.equal(value(b, 'CLASH'), 'value-from-b-0123456789');
    assert.equal(value(b, 'API_ONE'), 'value-of-api-one-0123456789');
    assert.ok(b.auditLog(50).some(e => e.event === 'transfer-in' && e.detail === '3'));
  });

  await test('a key keeps its own settings, and a cap keeps only what is left of it', () => {
    const list = b.listFast();
    const one = list.find(s => s.name === 'API_ONE');
    assert.equal(one.mcp, true);
    assert.deepEqual(one.mcpServers, ['server-a']);
    assert.equal(one.note, 'first');
    assert.equal(b.findGroup('Payments').id, one.groupId);
    const two = list.find(s => s.name === 'API_TWO');
    assert.equal(two.confirm, true);
    assert.equal(two.maxUses, 5);
    assert.ok(list.find(s => s.name === 'GONE').expiresAt);
  });

  await test('an arranged list only gains the groups its new keys need', () => {
    const names = b.layout().map(i => i.name || i.label);
    assert.deepEqual(names, ['Mine', 'Payments']);
  });

  await test('the receiving policy does not move', () => {
    assert.equal(b.policy().autoApprove, false);
  });

  await test('replacing on a conflict puts the old key in the bin', async () => {
    const data = await b.transferOpen(built.text, PASSWORD);
    const r = b.transferApply(data, 'replace');
    assert.equal(r.replaced, 1);
    assert.equal(r.added, 0);
    assert.equal(value(b, 'CLASH'), 'value-from-a-0123456789');
    assert.ok(b.listTrash().some(i => i.name === 'CLASH'));
    const back = b.restoreTrashed(b.listTrash().find(i => i.name === 'CLASH').id);
    assert.equal(value(b, back.name), 'value-from-b-0123456789');
  });

  await test('importing twice changes nothing', async () => {
    const data = await b.transferOpen(built.text, PASSWORD);
    const again = b.transferPreview(data);
    assert.equal(again.fresh.length, 0);
    assert.equal(again.conflicts.length, 0);
    const before = b.list().secrets.length;
    const r = b.transferApply(data, 'keep');
    assert.equal(r.added + r.replaced, 0);
    assert.equal(b.list().secrets.length, before);
  });

  const c = machine();
  await test('a blank machine takes the whole arrangement', async () => {
    c.transferApply(await c.transferOpen(built.text, PASSWORD), 'keep');
    assert.deepEqual(c.layout().map(i => i.name || i.label), ['Payments', 'Second part', 'Empty one']);
    assert.equal(c.list().secrets.length, 5);
  });

  await test('an expired key does not travel, and a passed date stops it at the door', async () => {
    const d = machine();
    const until = Date.now() + 4000;
    d.put('LATE', 'value-with-near-expiry-012345', { expiresAt: until, by: 'user' });
    d.put('FINE', 'value-without-any-expiry-0123', { by: 'user' });
    const s = await d.transferBuild(PASSWORD);
    assert.equal(s.count, 2);
    const e = machine();
    const data = await e.transferOpen(s.text, PASSWORD);
    await new Promise(r => setTimeout(r, Math.max(0, until - Date.now()) + 50));
    assert.deepEqual(e.transferPreview(data).expired, ['LATE']);
    assert.equal(e.transferApply(data, 'keep').expired, 1);
    assert.equal((await d.transferBuild(PASSWORD)).count, 1);
  });

  await test('an empty vault refuses to make a string', async () => {
    await assert.rejects(machine().transferBuild(PASSWORD), /no key to transfer/);
  });

  await test('what opens under the password is still checked, field by field', async () => {
    const crypto = require('crypto');
    const clear = Buffer.from(JSON.stringify({
      v: 1, at: 1,
      keys: [
        { name: 'GOOD_ONE', value: 'a-good-value-0123456789', policy: 'whatever', mcp: false, mcpServers: ['x'], note: 'n'.repeat(5000) },
        { name: 'GOOD_ONE', value: 'a-second-copy-0123456789' },
        { name: 'x', value: 'name-cannot-be-normalised' },
        { name: 'NO_VALUE', value: '' },
        { name: 'NOT_TEXT', value: { a: 1 } },
        null
      ],
      layout: [{ type: 'group', name: 'none' }, { type: 'nonsense' }, 'text']
    }), 'utf8');
    const head = Buffer.concat([crypto.randomBytes(16), Buffer.from([17, 8, 1])]);
    const key = crypto.scryptSync(PASSWORD, head.subarray(0, 16), 32, { N: 2 ** 17, r: 8, p: 1, maxmem: 256 * 2 ** 17 * 8 });
    const iv = crypto.randomBytes(12);
    const c = crypto.createCipheriv('aes-256-gcm', key, iv);
    c.setAAD(Buffer.concat([Buffer.from('claude-vault-transfer-v1'), head]));
    const ct = Buffer.concat([c.update(require('zlib').deflateRawSync(clear)), c.final()]);
    const body = Buffer.concat([head, iv, c.getAuthTag(), ct]);
    const sum = crypto.createHash('sha256').update(body).digest().subarray(0, 4);
    const f = machine();
    const data = await f.transferOpen('cvault1.' + Buffer.concat([body, sum]).toString('base64url'), PASSWORD);
    assert.deepEqual(data.keys.map(k => k.name), ['GOOD_ONE']);
    assert.equal(data.keys[0].policy, 'exec-only');
    assert.equal(data.keys[0].mcpServers, null);
    assert.ok(data.keys[0].note.length <= 400);
    assert.equal(data.invalid.length, 5);
    assert.equal(f.transferApply(data, 'keep').added, 1);
    assert.equal(value(f, 'GOOD_ONE'), 'a-good-value-0123456789');
    assert.deepEqual(f.layout(), []);
  });

  // ---------------------------------------------------------- phrase history

  const p = machine();
  p.put('KEY_ONE', 'value-one-0123456789', { by: 'user' });
  p.exportWrite(path.join(p.home, 'backup.cvault'));

  await test('the panel knows a phrase without being handed its words', () => {
    assert.equal(p.recoveryDetails().enabled, false);
    const words = p.recoveryEnable();
    const d = p.recoveryDetails();
    assert.equal(d.enabled, true);
    assert.equal(d.canShow, true);
    assert.equal(d.last, words[16]);
    assert.equal(JSON.stringify(d).includes(words[0] + ' ' + words[1]), false);
    assert.deepEqual(p.recoveryShow(d.id), words);
    assert.ok(p.auditLog(50).some(e => e.event === 'recovery-show'));
  });

  await test('nothing on disk holds the phrase in clear', () => {
    const words = p.recoveryShow(p.recoveryDetails().id).join(' ');
    for (const f of fs.readdirSync(dir(p))) {
      const file = path.join(dir(p), f);
      if (fs.statSync(file).isFile()) assert.equal(fs.readFileSync(file, 'utf8').includes(words), false, f);
    }
    assert.equal(fs.readFileSync(p.exportStatus().path, 'utf8').includes(words), false);
  });

  await test('a new phrase needs no old one and reaches the backup file at once', () => {
    const before = exportOf(p).recovery.ct;
    const oldId = p.recoveryDetails().id;
    const oldWords = p.recoveryShow(oldId);
    const fresh = p.recoveryEnable();
    assert.notEqual(exportOf(p).recovery.ct, before);
    assert.equal(p.exportStatus().phraseBehind, false);
    const d = p.recoveryDetails();
    assert.equal(d.history.length, 2);
    assert.equal(d.history[0].current, true);
    assert.equal(d.history[1].id, oldId);
    assert.ok(d.history[1].replacedAt);
    assert.deepEqual(p.recoveryShow(oldId), oldWords);
    assert.ok(p.auditLog(50).some(e => e.event === 'recovery-replace'));
    assert.equal(p.recoveryRestore(fresh.join(' ')).secrets, 1);
    assert.throws(() => p.recoveryRestore(oldWords.join(' ')), /does not open/);
  });

  await test('a replacement can be undone, and the file follows', () => {
    const d = p.recoveryDetails();
    const earlier = d.history[1];
    const before = p.recoveryShow(earlier.id);
    const hereNow = p.recoveryShow(d.id);
    p.recoveryActivate(earlier.id);
    assert.equal(p.recoveryDetails().id, earlier.id);
    assert.equal(p.recoveryRestore(before.join(' ')).secrets, 1);
    assert.throws(() => p.recoveryRestore(hereNow.join(' ')), /does not open/);
    assert.equal(p.exportStatus().phraseBehind, false);
    assert.equal(p.recoveryDetails().history.length, 2);
    assert.equal(p.recoveryDetails().history[0].current, true);
  });

  await test('the backup file opens elsewhere with the active phrase, and keeps it viewable', () => {
    const words = p.recoveryShow(p.recoveryDetails().id);
    const elsewhere = machine();
    const text = fs.readFileSync(p.exportStatus().path, 'utf8');
    const r = elsewhere.exportImport(text, words.join(' '));
    assert.equal(r.mode, 'phrase');
    assert.equal(value(elsewhere, 'KEY_ONE'), 'value-one-0123456789');
    const d = elsewhere.recoveryDetails();
    assert.equal(d.enabled, true);
    assert.deepEqual(elsewhere.recoveryShow(d.id), words);
    assert.equal(d.history.length, 1);
  });

  await test('a phrase from before the history cannot be shown, and joins it once typed', () => {
    const old = machine();
    old.put('KEY_OLD', 'value-old-0123456789', { by: 'user' });
    const words = old.recoveryEnable();
    fs.unlinkSync(path.join(dir(old), 'recovery-log.bin'));
    const env = JSON.parse(fs.readFileSync(path.join(dir(old), 'recovery.bin'), 'utf8'));
    delete env.id;
    fs.writeFileSync(path.join(dir(old), 'recovery.bin'), JSON.stringify(env));
    const d = old.recoveryDetails();
    assert.equal(d.enabled, true);
    assert.equal(d.canShow, false);
    assert.equal(d.history[0].canShow, false);
    assert.throws(() => old.recoveryShow(d.id), /not kept/);
    old.recoveryRestore(words.join(' '));
    assert.equal(old.recoveryDetails().canShow, true);
    assert.deepEqual(old.recoveryShow(old.recoveryDetails().id), words);
  });

  await test('replacing a phrase from before the history keeps its date', () => {
    const old = machine();
    old.put('KEY_OLD', 'value-old-0123456789', { by: 'user' });
    old.recoveryEnable();
    fs.unlinkSync(path.join(dir(old), 'recovery-log.bin'));
    const env = JSON.parse(fs.readFileSync(path.join(dir(old), 'recovery.bin'), 'utf8'));
    delete env.id;
    fs.writeFileSync(path.join(dir(old), 'recovery.bin'), JSON.stringify(env));
    old.recoveryEnable();
    const h = old.recoveryDetails().history;
    assert.equal(h.length, 2);
    assert.equal(h[1].canShow, false);
    assert.equal(h[1].createdAt, env.at);
    assert.ok(h[1].replacedAt);
  });

  await test('a backup file left behind by a failed rewrite is reported, then healed', () => {
    const b2 = machine();
    b2.put('KEY_TWO', 'value-two-0123456789', { by: 'user' });
    const file = path.join(b2.home, 'backup.cvault');
    b2.exportWrite(file);
    b2.recoveryEnable();
    const carried = fs.readFileSync(file, 'utf8');
    b2.recoveryEnable();
    fs.writeFileSync(file, carried);
    assert.equal(b2.exportStatus().phraseBehind, true);
    b2.exportEnsure();
    assert.equal(b2.exportStatus().phraseBehind, false);
  });

  await test('the history is bounded', () => {
    const h = machine();
    h.put('KEY_H', 'value-h-0123456789', { by: 'user' });
    for (let i = 0; i < 7; i++) h.recoveryEnable();
    const d = h.recoveryDetails();
    assert.equal(d.history.length, 5);
    assert.equal(d.history[0].current, true);
  });

  await test('a damaged history costs the history, never the phrase or the vault', () => {
    const h = machine();
    h.put('KEY_H', 'value-h-0123456789', { by: 'user' });
    const words = h.recoveryEnable();
    fs.writeFileSync(path.join(dir(h), 'recovery-log.bin'), '{"iv":"AAAA","tag":"AAAA","ct":"AAAA"}');
    assert.equal(h.recoveryDetails().canShow, false);
    assert.equal(h.recoveryRestore(words.join(' ')).secrets, 1);
    assert.equal(h.recoveryDetails().canShow, true);
  });

  await test('turning it off erases the copies and takes the envelope out of the file', () => {
    p.recoveryDisable();
    assert.equal(fs.existsSync(path.join(dir(p), 'recovery-log.bin')), false);
    assert.equal(p.recoveryDetails().enabled, false);
    assert.equal(p.recoveryDetails().history.length, 0);
    assert.equal(exportOf(p).recovery, null);
    assert.equal(p.exportStatus().phraseBehind, false);
  });

  await test('revoking everything erases the copies', () => {
    const r = machine();
    r.put('KEY_R', 'value-r-0123456789', { by: 'user' });
    r.recoveryEnable();
    r.revokeAll('REVOKE');
    assert.equal(fs.existsSync(path.join(dir(r), 'recovery-log.bin')), false);
    assert.equal(r.recoveryDetails().enabled, false);
  });

  for (const home of homes) {
    try { fs.rmSync(home, { recursive: true, force: true }); } catch (e) { /* best effort */ }
  }
  console.log(results.join('\n'));
  const failed = results.filter(r => r.startsWith('FAIL')).length;
  console.log('\n' + (results.length - failed) + ' OK, ' + failed + ' FAIL');
  process.exit(failed ? 1 : 0);
})();
