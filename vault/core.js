// Claude Vault, encrypted core. Shared by the VSCode extension, the Claude Code
// hooks and the MCP server. Zero dependency: native crypto + DPAPI via PowerShell.
//
// Model: a secret's value only ever exists in plaintext in the memory of the
// process that uses it. Never on disk, never in the UI, never in the model's
// context. This file is the only place that knows how to decrypt it.

'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawnSync } = require('child_process');

const VAULT_DIR = path.join(os.homedir(), '.claude', 'vault');
const VAULT_PATH = path.join(VAULT_DIR, 'vault.json');
const KEY_PATH = path.join(VAULT_DIR, 'masterkey.bin');
const TOKENS_PATH = path.join(VAULT_DIR, 'tokens.json');
const TMP_DIR = path.join(VAULT_DIR, 'tmp');

const NAME_RE = /^[A-Z][A-Z0-9_]{1,63}$/;
const KDF_INFO = 'claude-vault-secret-v1';
const MAC_INFO = 'claude-vault-filemac-v1';
const FP_INFO = 'claude-vault-fingerprint-v1';
const TOKEN_TTL_MS = 120000;   // execution token: 2 min, single use

// -------------------------------------------------------------------- utilities

// Translatable errors. This module also runs outside VSCode (the hooks are
// plain node processes), so it cannot call vscode.l10n itself. It therefore
// carries the English template and its arguments; the UI passes them through
// l10n.t() at display time, while the hook just uses the English message,
// which is the language we talk to Claude in anyway.
function fail(tpl, ...args) {
  const msg = tpl.replace(/\{(\d+)\}/g, (_, i) => (args[i] === undefined ? '' : args[i]));
  const e = new Error(msg);
  e.tpl = tpl;
  e.args = args.map(String);
  return e;
}

// Locks down the directories ONCE and for all: files created inside them
// inherit the ACL. Locking down every file on every write cost a spawn of
// icacls per write, ~600 ms per command with two markers. The marker file
// avoids repeating that, while still repairing earlier installs.
function ensureDirs() {
  for (const d of [VAULT_DIR, TMP_DIR]) {
    if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true, mode: 0o700 });
  }
  const sentinel = path.join(VAULT_DIR, '.acl');
  if (!fs.existsSync(sentinel)) {
    lockDown(VAULT_DIR);
    lockDown(TMP_DIR);
    try { fs.writeFileSync(sentinel, new Date().toISOString()); } catch (e) { /* best effort */ }
  }
  if (process.platform !== 'win32') {
    try { fs.chmodSync(VAULT_DIR, 0o700); } catch (e) { /* best effort */ }
  }
}

// Restricts a file to the current user only.
// Windows: icacls (inheritance cut off). POSIX: chmod 600.
function lockDown(file) {
  try {
    if (process.platform === 'win32') {
      const user = process.env.USERNAME || os.userInfo().username;
      spawnSync('icacls', [file, '/inheritance:r', '/grant:r', user + ':(F)'],
        { stdio: 'ignore', windowsHide: true });
    } else {
      // A directory must keep its execute bit to stay traversable. Locking one
      // down to 0600 shuts the vault out of its own files: the .acl sentinel
      // could then never be written, so ensureDirs() would redo this on every
      // single call.
      fs.chmodSync(file, fs.statSync(file).isDirectory() ? 0o700 : 0o600);
    }
  } catch (e) { /* best effort, reported by healthCheck() */ }
}

// Atomic write: temp file + fsync + rename.
function writeAtomic(file, data) {
  ensureDirs();
  const tmp = file + '.' + crypto.randomBytes(6).toString('hex') + '.tmp';
  const fd = fs.openSync(tmp, 'w', 0o600);
  try {
    fs.writeFileSync(fd, data);
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  fs.renameSync(tmp, file);   // atomic on NTFS as on POSIX
  // No lockDown here: the file inherits the directory's ACL, restricted at
  // creation time. On POSIX, mode 0600 is already set by openSync.
}

function b64(buf) { return Buffer.from(buf).toString('base64'); }
function unb64(s) { return Buffer.from(String(s), 'base64'); }

// Constant time comparison, tolerant of different lengths.
function equalCT(a, b) {
  const ba = Buffer.from(a), bb = Buffer.from(b);
  if (ba.length !== bb.length) {
    crypto.timingSafeEqual(ba, ba);   // consumes the same amount of time
    return false;
  }
  return crypto.timingSafeEqual(ba, bb);
}

// ------------------------------------------------------------------ master key

// Every OS helper below receives its payload on STDIN, never on argv: command
// lines are readable by any process of the session, so a secret passed as an
// argument would leak for the lifetime of the call.
function runIn(cmd, args, input) {
  const r = spawnSync(cmd, args,
    { input, encoding: 'utf8', windowsHide: true, timeout: 20000 });
  if (r.error) throw fail('{0} unavailable: {1}', cmd, r.error.message);
  if (r.status !== 0) throw fail('{0} failed: {1}', cmd, String(r.stderr || '').trim());
  return String(r.stdout || '').trim();
}

// --- Windows: DPAPI, CurrentUser scope. The wrapped blob lives in the key file.
function powershell(script) {
  return runIn('powershell.exe',
    ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', '-'], script);
}

function dpapiProtect(buf) {
  return unb64(powershell(
    "Add-Type -AssemblyName System.Security\n" +
    "$d = [Convert]::FromBase64String('" + b64(buf) + "')\n" +
    "$p = [System.Security.Cryptography.ProtectedData]::Protect($d, $null, 'CurrentUser')\n" +
    "[Convert]::ToBase64String($p)\n"));
}

function dpapiUnprotect(buf) {
  return unb64(powershell(
    "Add-Type -AssemblyName System.Security\n" +
    "$d = [Convert]::FromBase64String('" + b64(buf) + "')\n" +
    "$p = [System.Security.Cryptography.ProtectedData]::Unprotect($d, $null, 'CurrentUser')\n" +
    "[Convert]::ToBase64String($p)\n"));
}

const KEYRING_SERVICE = 'claude-vault';
const KEYRING_ACCOUNT = 'master-key';

// --- macOS: login keychain. `security -i` reads its COMMANDS from stdin, which
// is the only non-interactive way to store a password without putting it on the
// command line. Base64 contains no quote and no backslash, so the quoting holds.
function keychainStore(buf) {
  runIn('security', ['-i'],
    'add-generic-password -U -s ' + KEYRING_SERVICE + ' -a ' + KEYRING_ACCOUNT +
    ' -D "Claude Vault master key" -w "' + b64(buf) + '"\n');
}

function keychainLoad() {
  // Only the service and account names travel on argv here, never the secret.
  return unb64(runIn('security',
    ['find-generic-password', '-s', KEYRING_SERVICE, '-a', KEYRING_ACCOUNT, '-w'], ''));
}

// --- Linux: libsecret (GNOME keyring, KWallet via the Secret Service API).
// `secret-tool store` reads the secret on stdin by design — and takes ALL of
// stdin up to EOF, trailing newline included. Sending one would store 45 bytes
// where we mean 44, so the payload goes out bare.
// A GNOME "login" keyring unlocked with an EMPTY password — the usual headless
// and CI workaround — is written to disk UNENCRYPTED, while the Secret Service
// API keeps answering as if nothing were wrong. The round trip below would pass
// and healthCheck would report a healthy vault, so the only honest test is to
// go and look for the material itself in the keyring files.
function keyringStoresInClear(payload) {
  const dir = path.join(os.homedir(), '.local', 'share', 'keyrings');
  let names;
  try { names = fs.readdirSync(dir); } catch (e) { return false; }   // no keyring on disk: nothing to prove
  for (const n of names) {
    if (!n.endsWith('.keyring')) continue;
    try { if (fs.readFileSync(path.join(dir, n)).includes(payload)) return true; }
    catch (e) { /* unreadable file: move on */ }
  }
  return false;
}

function secretToolStore(buf) {
  const payload = b64(buf);
  runIn('secret-tool',
    ['store', '--label=Claude Vault master key', 'service', KEYRING_SERVICE, 'account', KEYRING_ACCOUNT],
    payload);
  if (keyringStoresInClear(payload)) {
    throw fail('the keyring is unlocked with an empty password and stores secrets unencrypted');
  }
}

function secretToolLoad() {
  const out = runIn('secret-tool',
    ['lookup', 'service', KEYRING_SERVICE, 'account', KEYRING_ACCOUNT], '');
  if (!out) throw fail('no entry in the keyring');
  return unb64(out);
}

// `inFile` tells whether the key material lives in the key file (wrapped) or in
// the OS keyring, in which case the file only carries the envelope.
const PROVIDERS = {
  dpapi:     { inFile: true,  protect: b => b64(dpapiProtect(b)), unprotect: blob => dpapiUnprotect(unb64(blob)) },
  keychain:  { inFile: false, protect: b => { keychainStore(b); return ''; }, unprotect: () => keychainLoad() },
  libsecret: { inFile: false, protect: b => { secretToolStore(b); return ''; }, unprotect: () => secretToolLoad() },
  plain:     { inFile: true,  protect: b => b64(b), unprotect: blob => unb64(blob) }
};

// Best protection first, 'plain' always last: a headless Linux box, a container
// or a machine with no keyring daemon must still be able to run the vault
// rather than refuse to start. healthCheck() reports the downgrade.
function providerChain() {
  if (process.platform === 'win32') return ['dpapi', 'plain'];
  if (process.platform === 'darwin') return ['keychain', 'plain'];
  if (process.platform === 'linux') return ['libsecret', 'plain'];
  return ['plain'];
}

// Key file envelope: { mode, blob, seq }
// seq = monotonic counter sealed together with the key: prevents replaying an older vault.
function readKeyFile() {
  const raw = JSON.parse(fs.readFileSync(KEY_PATH, 'utf8'));
  if (!raw || typeof raw.mode !== 'string' || !PROVIDERS[raw.mode]) throw fail('key file unreadable');
  // Keyring modes legitimately carry an empty blob: the material is not here.
  if (PROVIDERS[raw.mode].inFile && !raw.blob) throw fail('key file unreadable');
  return raw;
}

let _master = null;      // in memory cache, per process
let _masterMode = null;
let _downgrade = null;   // why the OS store was refused, when it was

// Writes the key with the best provider that ACTUALLY works, verified by a real
// round trip. A keyring that accepts a write but cannot read it back would lock
// every secret away for good, so it must never be trusted on the write alone.
function storeKey(keyBuf, seq) {
  const errs = [];
  for (const mode of providerChain()) {
    const p = PROVIDERS[mode];
    try {
      const blob = p.protect(keyBuf);
      const back = p.unprotect(blob);
      if (!Buffer.isBuffer(back) || !back.equals(keyBuf)) throw fail('round trip mismatch');
      writeAtomic(KEY_PATH, JSON.stringify({ v: 1, mode, blob, seq }));
      _masterMode = mode;
      // Keep why we had to settle for less: "no keyring" and "the keyring
      // stores in clear" both end up in 'plain' and call for different actions.
      _downgrade = errs.length ? errs.join(' | ') : null;
      return mode;
    } catch (e) { errs.push(mode + ': ' + e.message); }
  }
  throw fail('cannot store the master key ({0})', errs.join(' | '));
}

// A vault created before a keyring was reachable (older build, keyring daemon
// not started yet) sits in 'plain'. Move it up as soon as a real keyring
// answers, keeping the SAME key bytes so every existing secret stays readable.
function upgradeProtection(seq) {
  if (_masterMode !== 'plain' || providerChain()[0] === 'plain') return;
  try { storeKey(_master, seq); } catch (e) { /* keyring still out of reach: stay in plain */ }
}

function masterKey() {
  if (_master) return _master;
  ensureDirs();
  if (!fs.existsSync(KEY_PATH)) {
    const key = crypto.randomBytes(32);
    storeKey(key, 0);
    _master = key;
    return key;
  }
  const kf = readKeyFile();
  _masterMode = kf.mode;
  _master = PROVIDERS[kf.mode].unprotect(kf.blob);
  if (!Buffer.isBuffer(_master) || _master.length !== 32) throw fail('master key corrupted');
  upgradeProtection(kf.seq || 0);
  return _master;
}

function currentSeq() {
  try { return readKeyFile().seq || 0; } catch (e) { return 0; }
}

function bumpSeq(next) {
  storeKey(masterKey(), next);   // masterKey() first: it resolves the current mode
}

function derive(info, salt, len) {
  return Buffer.from(crypto.hkdfSync('sha256', masterKey(), salt, Buffer.from(info, 'utf8'), len || 32));
}

// ---------------------------------------------------------------------- vault file

function emptyVault() { return { v: 1, seq: 0, secrets: {}, audit: [] }; }

function canonical(entries, seq) {
  const ids = Object.keys(entries).sort();
  return JSON.stringify({ seq, e: ids.map(id => [id, entries[id].name, entries[id].ct]) });
}

function fileMac(entries, seq) {
  return crypto.createHmac('sha256', derive(MAC_INFO, Buffer.alloc(0), 32))
    .update(canonical(entries, seq)).digest('base64');
}

function loadRaw() {
  if (!fs.existsSync(VAULT_PATH)) return emptyVault();
  let v;
  try { v = JSON.parse(fs.readFileSync(VAULT_PATH, 'utf8')); }
  catch (e) { throw fail('vault unreadable (invalid JSON), restore a backup'); }
  if (!v || !v.secrets) return emptyVault();

  // Global integrity: prevents adding, removing or swapping entries.
  const expect = fileMac(v.secrets, v.seq || 0);
  if (!v.mac || !equalCT(v.mac, expect)) {
    throw fail('vault tampered with: the file signature does not match');
  }
  // Anti replay: the key file's counter is authoritative.
  const hw = currentSeq();
  if ((v.seq || 0) < hw) {
    throw fail('vault out of date (replay detected: seq {0} < {1})', v.seq || 0, hw);
  }
  return v;
}

function saveRaw(v, structural) {
  if (structural) {
    v.seq = (v.seq || 0) + 1;
    bumpSeq(v.seq);
  }
  v.audit = pruneAudit(v.audit);
  v.mac = fileMac(v.secrets, v.seq || 0);
  writeAtomic(VAULT_PATH, JSON.stringify(v, null, 0));
}

// The log is bounded on two axes, and both matter for a different reason.
//
// COUNT, because this file is parsed by every hook on every tool call. The
// entries are not covered by the MAC, so they are pure payload on the hot path:
// an unbounded log would quietly turn into latency on every command Claude runs.
//
// AGE, because a record of which key was used, and when, is itself sensitive.
// Keeping it forever gives an attacker who reaches the file a timeline of the
// user's work. Ninety days is long enough to investigate an incident and short
// enough that the file forgets on its own.
const AUDIT_MAX = 500;
const AUDIT_TTL_MS = 90 * 24 * 3600 * 1000;

function pruneAudit(entries) {
  if (!Array.isArray(entries) || !entries.length) return entries || [];
  const cutoff = Date.now() - AUDIT_TTL_MS;
  // An entry with no usable timestamp is kept: dropping it would be a silent
  // way of losing a record, which is exactly what a log must not do.
  const fresh = entries.filter(e => !e || typeof e.at !== 'number' || e.at >= cutoff);
  return fresh.length > AUDIT_MAX ? fresh.slice(-AUDIT_MAX) : fresh;
}

// `by` says which side acted: 'claude' (the agent, through the bridge, the
// hook or an MCP proxy) or 'user' (a VSCode gesture). Null for what happens
// on its own (expiry, burn) and for entries written before the field existed.
function audit(v, event, name, detail, by) {
  if (!v.audit) v.audit = [];
  v.audit.push({ at: Date.now(), event, name: name || null, detail: detail || null, by: by || null });
}

// ------------------------------------------------------------------- per secret encryption

function aad(entry) {
  // The mcp field is added ONLY when it is true: without this condition, keys
  // sealed before this field was introduced would produce a different AAD and
  // become undecryptable. An MCP authorization stays unforgeable: adding it by
  // hand in the JSON breaks the tag, since the original seal did not contain
  // it.
  const a = {
    id: entry.id, name: entry.name, exp: entry.expiresAt || 0,
    policy: entry.policy, maxUses: entry.maxUses || 0
  };
  if (entry.mcp) a.mcp = true;
  return Buffer.from(JSON.stringify(a), 'utf8');
}

function seal(entry, value) {
  const salt = crypto.randomBytes(16);
  const iv = crypto.randomBytes(12);
  const key = derive(KDF_INFO + '|' + entry.id, salt, 32);
  const c = crypto.createCipheriv('aes-256-gcm', key, iv);
  c.setAAD(aad(entry));
  const ct = Buffer.concat([c.update(Buffer.from(value, 'utf8')), c.final()]);
  key.fill(0);
  return { salt: b64(salt), iv: b64(iv), tag: b64(c.getAuthTag()), data: b64(ct) };
}

function open(entry) {
  const key = derive(KDF_INFO + '|' + entry.id, unb64(entry.ct.salt), 32);
  const d = crypto.createDecipheriv('aes-256-gcm', key, unb64(entry.ct.iv));
  d.setAAD(aad(entry));
  d.setAuthTag(unb64(entry.ct.tag));
  let out;
  try { out = Buffer.concat([d.update(unb64(entry.ct.data)), d.final()]); }
  catch (e) {
    key.fill(0);
    throw fail('decryption refused: metadata tampered with (TTL, name or policy changed)');
  }
  key.fill(0);
  return out.toString('utf8');
}

// Displayable fingerprint: HMAC (not a bare hash, a weak secret would still be
// vulnerable to a dictionary attack), truncated to 48 bits.
function fingerprint(value) {
  return crypto.createHmac('sha256', derive(FP_INFO, Buffer.alloc(0), 32))
    .update(value, 'utf8').digest('hex').slice(0, 12);
}

// Non reversible hint: never more than 4 characters, and nothing at all if the
// secret is short (on an 8 character key, 4 is already half of it).
function hintOf(value) {
  const s = String(value);
  if (s.length < 16) return '••••';
  return s.slice(0, 4) + '…' + '•'.repeat(4);
}

function looksLikePrivateKey(value) {
  return /-----BEGIN [A-Z ]*PRIVATE KEY-----/.test(value);
}

function detectKind(value) {
  if (looksLikePrivateKey(value)) {
    if (/BEGIN OPENSSH PRIVATE KEY/.test(value)) return 'OpenSSH private key';
    return 'PEM private key';
  }
  if (/^ghp_|^github_pat_/.test(value)) return 'GitHub token';
  if (/^sk-ant-/.test(value)) return 'Anthropic API key';
  if (/^sk_(live|test)_/.test(value)) return 'Stripe key';
  if (/^xox[baprs]-/.test(value)) return 'Slack token';
  if (/^eyJ[\w-]+\.[\w-]+\./.test(value)) return 'JWT';
  if (/^-----BEGIN CERTIFICATE-----/.test(value)) return 'certificate';
  if (/^\{[\s\S]*"private_key"/.test(value)) return 'JSON service account';
  return 'secret';
}

// The kind is written into the metadata at creation time, and until now it was
// written in French. Existing keys are not re-encrypted just for this: they are
// mapped back to the English source label at display time, and translation
// follows the same path as everything else.
const KIND_LEGACY = {
  'clé privée OpenSSH': 'OpenSSH private key',
  'clé privée PEM': 'PEM private key',
  'token GitHub': 'GitHub token',
  'clé API Anthropic': 'Anthropic API key',
  'clé Stripe': 'Stripe key',
  'token Slack': 'Slack token',
  'certificat': 'certificate',
  'compte de service JSON': 'JSON service account'
};

function kindSource(kind) {
  return KIND_LEGACY[kind] || kind || 'secret';
}

// ------------------------------------------------------------------ TTL

function isExpired(entry, now) {
  const t = now || Date.now();
  if (entry.expiresAt && t >= entry.expiresAt) return true;
  if (entry.maxUses && (entry.uses || 0) >= entry.maxUses) return true;
  return false;
}

// Purges expired entries. Returns the removed names.
function sweep() {
  let v;
  try { v = loadRaw(); } catch (e) { return []; }
  const now = Date.now();
  const gone = [];
  for (const id of Object.keys(v.secrets)) {
    if (isExpired(v.secrets[id], now)) {
      gone.push(v.secrets[id].name);
      audit(v, 'expire', v.secrets[id].name, null);
      delete v.secrets[id];
    }
  }
  if (gone.length) saveRaw(v, true);
  return gone;
}

// -------------------------------------------------------------------- public API

function validateName(name) {
  const n = String(name || '').trim();
  if (!NAME_RE.test(n)) {
    throw fail('Invalid name: uppercase letters, digits and underscores only, ' +
      'starting with a letter, 2 to 64 characters (e.g. VPS_SSH_KEY).');
  }
  return n;
}

function list() {
  sweep();
  let v;
  try { v = loadRaw(); } catch (e) { return { error: e.message, secrets: [] }; }
  const now = Date.now();
  const secrets = Object.keys(v.secrets).map(id => {
    const s = v.secrets[id];
    return {
      id, name: s.name, kind: s.kind, hint: s.hint, length: s.length,
      fingerprint: s.fingerprint, policy: s.policy,
      createdAt: s.createdAt, expiresAt: s.expiresAt || null,
      maxUses: s.maxUses || null, uses: s.uses || 0,
      lastUsedAt: s.lastUsedAt || null,
      expiresIn: s.expiresAt ? Math.max(0, s.expiresAt - now) : null,
      note: s.note || null
    };
  }).sort((a, b) => a.name.localeCompare(b.name));
  return { secrets };
}

// FAST metadata read: touches neither the master key nor DPAPI, so it adds no
// latency. Used by the hooks (on every prompt and every command) and by the
// UI. Deliberately NOT authenticated: the MAC and anti replay checks happen in
// consume(), the only path that returns a value. An attacker who edited the
// file would therefore gain nothing more than a garbled displayed name.
function listFast() {
  let v;
  try { v = JSON.parse(fs.readFileSync(VAULT_PATH, 'utf8')); }
  catch (e) { return []; }
  if (!v || !v.secrets) return [];
  const now = Date.now();
  return Object.keys(v.secrets).map(id => {
    const s = v.secrets[id];
    return {
      name: s.name, kind: s.kind, hint: s.hint, length: s.length, note: s.note || null,
      createdBy: s.createdBy || null,
      policy: s.policy, isFile: !!s.isFile, mcp: !!s.mcp, uses: s.uses || 0,
      lastUsedAt: s.lastUsedAt || null,
      createdAt: s.createdAt, expiresAt: s.expiresAt || null, maxUses: s.maxUses || null,
      expiresIn: s.expiresAt ? Math.max(0, s.expiresAt - now) : null,
      // remaining life fraction: feeds the draining bar in the UI
      lifeLeft: s.expiresAt && s.createdAt && s.expiresAt > s.createdAt
        ? Math.max(0, Math.min(1, (s.expiresAt - now) / (s.expiresAt - s.createdAt)))
        : null,
      expired: isExpired(s, now)
    };
  }).sort((a, b) => a.name.localeCompare(b.name));
}

function findByName(v, name) {
  const n = String(name || '').toUpperCase();
  for (const id of Object.keys(v.secrets)) {
    if (v.secrets[id].name === n) return v.secrets[id];
  }
  return null;
}

// Suggestions for an unknown name (prefix, then substring, then distance 1-2).
function suggest(name, names) {
  const n = String(name || '').toUpperCase();
  const pre = names.filter(x => x.startsWith(n));
  if (pre.length) return pre.slice(0, 5);
  const sub = names.filter(x => x.indexOf(n) !== -1);
  if (sub.length) return sub.slice(0, 5);
  const scored = names.map(x => {
    let common = 0;
    for (let i = 0; i < Math.min(x.length, n.length); i++) if (x[i] === n[i]) common++;
    return { x, common };
  }).filter(s => s.common >= 3).sort((a, b) => b.common - a.common);
  return scored.slice(0, 3).map(s => s.x);
}

// Creates or replaces. The old value is overwritten, never recoverable.
function put(name, value, opts) {
  const o = opts || {};
  const n = validateName(name);
  if (typeof value !== 'string' || !value.length) throw fail('Empty value');
  const v = loadRaw();
  const existing = findByName(v, n);
  const entry = {
    id: existing ? existing.id : crypto.randomUUID(),
    name: n,
    policy: o.policy === 'reveal' ? 'reveal' : 'exec-only',
    expiresAt: o.expiresAt || null,
    maxUses: o.maxUses || null,
    uses: 0,
    createdAt: Date.now(),
    lastUsedAt: null,
    // Authorization to inject into an MCP tool's arguments. False by
    // default: unlike the shell, the value there travels through the tool
    // call machinery instead of staying in a process's memory.
    mcp: !!o.mcp,
    note: o.note || null
  };
  // Who authored the value, kept on the entry itself so the key can say it
  // long after the journal has been pruned. On a replacement the field tells
  // who wrote the CURRENT value, which is the question one actually asks.
  entry.createdBy = o.by === 'claude' || o.by === 'user' ? o.by : null;
  entry.kind = detectKind(value);
  entry.hint = hintOf(value);
  entry.length = value.length;
  entry.fingerprint = fingerprint(value);
  entry.isFile = looksLikePrivateKey(value) || /^\{[\s\S]*"private_key"/.test(value);
  entry.ct = seal(entry, value);
  v.secrets[entry.id] = entry;
  audit(v, existing ? 'replace' : 'create', n, entry.kind, entry.createdBy);
  saveRaw(v, true);
  return { name: n, replaced: !!existing, fingerprint: entry.fingerprint, kind: entry.kind };
}

function remove(name) {
  const v = loadRaw();
  const s = findByName(v, name);
  if (!s) return false;
  delete v.secrets[s.id];
  audit(v, 'delete', s.name, null, 'user');
  saveRaw(v, true);
  return true;
}

function setTtl(name, expiresAt, maxUses) {
  const v = loadRaw();
  const s = findByName(v, name);
  if (!s) throw fail('unknown key: {0}', name);
  // The metadata is part of the AAD: it must be re-encrypted to change it.
  const value = open(s);
  s.expiresAt = expiresAt || null;
  s.maxUses = maxUses || null;
  s.ct = seal(s, value);
  audit(v, 'ttl', s.name, expiresAt ? new Date(expiresAt).toISOString() : 'aucun', 'user');
  saveRaw(v, true);
  return true;
}

// Authorizes (or revokes) injection into an MCP tool's arguments. Since the
// flag is part of the authenticated data, it requires re-encryption: it
// cannot be turned on just by editing the file.
function setMcp(name, allowed) {
  const v = loadRaw();
  const s = findByName(v, name);
  if (!s) throw fail('unknown key: {0}', name);
  const value = open(s);
  s.mcp = !!allowed;
  s.ct = seal(s, value);
  audit(v, 'mcp', s.name, allowed ? 'allowed' : 'removed', 'user');
  saveRaw(v, true);
  return !!allowed;
}

// Full revocation: new master key, everything existing becomes unreadable.
// Must work even on a corrupted or tampered vault: that is precisely the
// situation where we want to be able to discard everything. Never go through
// loadRaw() here.
function revokeAll() {
  let n = 0;
  try { n = Object.keys(JSON.parse(fs.readFileSync(VAULT_PATH, 'utf8')).secrets || {}).length; }
  catch (e) { /* vault absent or unreadable: revoke anyway */ }
  try { fs.unlinkSync(VAULT_PATH); } catch (e) { /* already gone */ }
  const seq = currentSeq() + 1;
  _master = crypto.randomBytes(32);
  storeKey(_master, seq);
  const v = emptyVault();
  v.seq = seq;
  audit(v, 'revoke-all', null, String(n), 'user');
  saveRaw(v, false);
  try { for (const f of fs.readdirSync(TMP_DIR)) fs.unlinkSync(path.join(TMP_DIR, f)); }
  catch (e) { /* nothing to purge */ }
  return n;
}

// Internal consumption, the ONLY path that returns a plaintext value.
function consume(name, who) {
  sweep();
  const v = loadRaw();
  const s = findByName(v, name);
  if (!s) {
    const names = Object.keys(v.secrets).map(id => v.secrets[id].name);
    const e = fail('unknown key: {0}', name);
    e.suggestions = suggest(name, names);
    throw e;
  }
  if (isExpired(s)) {
    delete v.secrets[s.id];
    audit(v, 'expire', s.name, null);
    saveRaw(v, true);
    throw fail('expired key: {0}', s.name);
  }
  const value = open(s);
  s.uses = (s.uses || 0) + 1;
  s.lastUsedAt = Date.now();
  // Every consume() caller is an agent channel (shell hook, MCP proxy, MCP
  // env): the owner's own path is reveal(), which signs 'user'.
  audit(v, 'use', s.name, who || null, 'claude');
  const burned = s.maxUses && s.uses >= s.maxUses;
  if (burned) {
    delete v.secrets[s.id];
    audit(v, 'burn', s.name, null);
  } else {
    // uses/lastUsedAt are not part of the AAD: no need to re-encrypt.
    s.ct = s.ct;
  }
  saveRaw(v, !!burned);
  return { value, entry: s, burned: !!burned };
}

// Deliberate reveal by the OWNER, from the VSCode interface.
// Distinct from consume() on three deliberate points: it does not count as a
// use, it never triggers burning, and it is logged under its own label in the
// audit trail. A key's policy (exec-only) constrains the agent, not the
// person who created it; Claude itself has no path to this function: it is
// only ever called from a VSCode command.
function reveal(name) {
  sweep();
  const v = loadRaw();
  const s = findByName(v, name);
  if (!s) throw fail('unknown key: {0}', name);
  if (isExpired(s)) throw fail('expired key: {0}', s.name);
  const value = open(s);
  audit(v, 'reveal', s.name, null, 'user');
  saveRaw(v, false);
  return { value, entry: s };
}

// Silent read, reserved for redacting tool outputs: the value must be known
// in order to mask it. Not logged, because the use was already recorded on
// the way in by consume(); logging the same call twice would make the audit
// trail unreadable. Never call it anywhere else.
function peek(name) {
  const v = loadRaw();
  const s = findByName(v, name);
  if (!s || isExpired(s)) return null;
  try { return open(s); } catch (e) { return null; }
}

// --- in flight calls: PreToolUse (or get.js) notes which keys it injected,
// PostToolUse uses that to mask those values in the provider's response.
//
// Names are stored, and next to each, an ENCRYPTED copy of the value: the
// redaction hint. It exists for one reason. A burn-after-use key is deleted
// the instant it is consumed, during PreToolUse; by the time PostToolUse runs,
// peek() finds nothing and the response goes unredacted, exactly where the
// policy is tightest. The hint keeps the value reachable for redaction without
// keeping the key alive. It is ciphertext under the master key, the same
// protection as the vault, never plaintext on disk, and it expires with the
// pending entry.
const PENDING_PATH = path.join(VAULT_DIR, 'pending-mcp.json');
const PENDING_TTL_MS = 300000;
const HINT_INFO = 'claude-vault-redaction-hint-v1';

function sealHint(value) {
  const iv = crypto.randomBytes(12);
  const key = derive(HINT_INFO, Buffer.alloc(0), 32);
  const c = crypto.createCipheriv('aes-256-gcm', key, iv);
  const ct = Buffer.concat([c.update(Buffer.from(String(value), 'utf8')), c.final()]);
  key.fill(0);
  return b64(iv) + '.' + b64(c.getAuthTag()) + '.' + b64(ct);
}

function openHint(blob) {
  try {
    const parts = String(blob).split('.');
    if (parts.length !== 3) return null;
    const key = derive(HINT_INFO, Buffer.alloc(0), 32);
    const d = crypto.createDecipheriv('aes-256-gcm', key, unb64(parts[0]));
    d.setAuthTag(unb64(parts[1]));
    const out = Buffer.concat([d.update(unb64(parts[2])), d.final()]);
    key.fill(0);
    return out.toString('utf8');
  } catch (e) { return null; }
}

function readPending() {
  try {
    const p = JSON.parse(fs.readFileSync(PENDING_PATH, 'utf8'));
    return p && typeof p === 'object' ? p : {};
  } catch (e) { return {}; }
}

// The call id is not guaranteed: we record under that id when it exists,
// and ALWAYS under a per session fallback entry too, so that masking the
// response does not depend on a field that might be missing.
//
// `values` is optional: a { name: plaintext } map of what was just injected.
// Each value is sealed before it is written, never stored in the clear. When
// the caller has the value (an MCP hook, or get.js at execution) it passes it,
// so redaction survives the key being burned.
function notePending(id, names, session, values) {
  if (!names || !names.length) return;
  ensureDirs();
  const all = readPending();
  const now = Date.now();
  for (const k of Object.keys(all)) if (all[k].at + PENDING_TTL_MS < now) delete all[k];
  const hints = {};
  if (values) for (const n of Object.keys(values)) {
    if (values[n] != null) hints[n] = sealHint(values[n]);
  }
  if (id) all[id] = { names, at: now, hints };
  const cle = 'session:' + (session || 'inconnue');
  const prev = (all[cle] && all[cle].at + PENDING_TTL_MS > now)
    ? all[cle] : { names: [], hints: {} };
  all[cle] = {
    names: Array.from(new Set((prev.names || []).concat(names))),
    hints: Object.assign({}, prev.hints || {}, hints),
    at: now
  };
  writeAtomic(PENDING_PATH, JSON.stringify(all));
}

// Decrypted redaction hints for a call: { name: value }. Read only, no delete,
// because several output chunks can carry the same value; the entries expire on
// their own. Falls back to nothing for a name that has no hint, in which case
// the caller still tries peek() for a key that is merely non-single-use.
function pendingHints(id, session) {
  const all = readPending();
  const now = Date.now();
  const out = {};
  const merge = rec => {
    if (!rec || rec.at + PENDING_TTL_MS < now || !rec.hints) return;
    for (const n of Object.keys(rec.hints)) {
      const v = openHint(rec.hints[n]);
      if (v != null) out[n] = v;
    }
  };
  if (id) merge(all[id]);
  merge(all['session:' + (session || 'inconnue')]);
  return out;
}

// Fallback: what was recently injected in this session. Unlike
// takePending(), we do not consume it here; several outputs can contain the
// same value, and the entry expires on its own after PENDING_TTL_MS.
function takeRecent(session) {
  const rec = readPending()['session:' + (session || 'inconnue')];
  if (!rec || rec.at + PENDING_TTL_MS < Date.now()) return null;
  return rec.names;
}

function takePending(id) {
  if (!id) return null;
  const all = readPending();
  const rec = all[id];
  if (!rec) return null;
  delete all[id];
  writeAtomic(PENDING_PATH, JSON.stringify(all));
  if (rec.at + PENDING_TTL_MS < Date.now()) return null;
  return rec.names;
}

// --- MCP proxy registry. A transparent proxy registers the server-id it
// fronts, so the PreToolUse hook knows to leave markers untouched for that
// server (the proxy substitutes them downstream, out of the transcript). The
// pid is recorded and checked on read: a proxy that died without deregistering
// is ignored, and a stale entry can at worst cause a marker to reach a server
// literally, a visibly broken call, never a leak.
const PROXIED_PATH = path.join(VAULT_DIR, 'mcp-proxied.json');

function readProxied() {
  try {
    const p = JSON.parse(fs.readFileSync(PROXIED_PATH, 'utf8'));
    return p && typeof p === 'object' ? p : {};
  } catch (e) { return {}; }
}

function noteProxied(name) {
  if (!name) return;
  ensureDirs();
  const all = readProxied();
  all[name] = { pid: process.pid, at: Date.now() };
  writeAtomic(PROXIED_PATH, JSON.stringify(all));
}

function unnoteProxied(name) {
  if (!name) return;
  const all = readProxied();
  if (all[name]) { delete all[name]; writeAtomic(PROXIED_PATH, JSON.stringify(all)); }
}

function isProxied(name) {
  const rec = readProxied()[name];
  if (!rec || !rec.pid) return false;
  try { process.kill(rec.pid, 0); return true; }   // alive?
  catch (e) { return e.code === 'EPERM'; }          // exists but not ours: still alive
}

function auditLog(limit) {
  try {
    const v = loadRaw();
    // Pruned on the way out as well as on the way in: a vault nobody has
    // written to for months would otherwise still display its old entries.
    return pruneAudit(v.audit).slice(-(limit || 100)).reverse();
  } catch (e) { return []; }
}

// ---------------------------------------------------- replacement under approval
//
// Claude may create a key on its own, but replacing one destroys a value that
// cannot be recovered, so it asks first. The new value is sealed straight away,
// with the same machinery as any secret, and parked until the user answers. It
// is never written in the clear anywhere, not even while it waits.
//
// A forged entry dropped into this slot by hand is not a way in: sealing
// requires the master key, so approval would simply fail to decrypt rather than
// swap in an attacker's value.

// The description attached to a key: what it is for, where the user's code
// reads it, when it was written. Plain metadata, deliberately outside the
// authenticated data, so it can be edited without re-encrypting anything.
// Bounded, because it sits in a file every hook parses on every tool call.
const NOTE_MAX = 400;

function setNote(name, note) {
  const v = loadRaw();
  const s = findByName(v, name);
  if (!s) throw fail('unknown key: {0}', name);
  const txt = String(note == null ? '' : note).replace(/\s+/g, ' ').trim().slice(0, NOTE_MAX);
  s.note = txt || null;
  audit(v, 'note', s.name, null, 'user');
  saveRaw(v, false);
  return { name: s.name, note: s.note };
}

const REPLACE_TTL_MS = 900000;   // 15 min, an unanswered request goes stale

function pruneReplacements(v) {
  if (!v.replace) return;
  const cutoff = Date.now() - REPLACE_TTL_MS;
  for (const n of Object.keys(v.replace)) {
    if ((v.replace[n].at || 0) < cutoff) delete v.replace[n];
  }
}

function requestReplace(name, value, note) {
  const n = validateName(name);
  if (typeof value !== 'string' || !value.length) throw fail('Empty value');
  const v = loadRaw();
  if (!findByName(v, n)) throw fail('unknown key: {0}', n);
  pruneReplacements(v);
  if (!v.replace) v.replace = {};

  // A fresh id, so the seal of the pending value is bound to this request and
  // not to the entry it is meant to succeed.
  const entry = { id: crypto.randomUUID(), name: n, policy: 'exec-only', expiresAt: null, maxUses: null };
  v.replace[n] = {
    id: entry.id, name: n, policy: 'exec-only',
    ct: seal(entry, value),
    // The new description travels with the request: a refused replacement must
    // leave the entry exactly as it was, description included.
    note: note ? String(note).replace(/\s+/g, ' ').trim().slice(0, NOTE_MAX) : null,
    kind: detectKind(value), length: value.length, at: Date.now()
  };
  audit(v, 'replace-request', n, null, 'claude');
  saveRaw(v, false);
  return { name: n, kind: v.replace[n].kind, length: value.length };
}

// Metadata only, like everywhere else: the caller learns what is waiting, never
// what it contains.
function pendingReplacements() {
  try {
    const v = loadRaw();
    pruneReplacements(v);
    return Object.keys(v.replace || {}).map(n => ({
      name: n, kind: v.replace[n].kind, length: v.replace[n].length,
      note: v.replace[n].note || null, at: v.replace[n].at
    }));
  } catch (e) { return []; }
}

function approveReplace(name) {
  const n = String(name || '').toUpperCase();
  const v = loadRaw();
  const p = v.replace && v.replace[n];
  if (!p) throw fail('no pending replacement for {0}', n);
  const value = open(p);

  // The replacement inherits the lifetime and the authorizations of the key it
  // succeeds. Silently resetting an expiry or an MCP authorization here would
  // be a change nobody asked for.
  // The value was authored by Claude; the approval is the user's own journal
  // line just below. createdBy therefore says 'claude', which answers the
  // question "where does the CURRENT value come from".
  const cur = findByName(v, n);
  const opts = cur ? {
    policy: cur.policy, expiresAt: cur.expiresAt,
    maxUses: cur.maxUses, mcp: cur.mcp, note: p.note || cur.note, by: 'claude'
  } : { note: p.note, by: 'claude' };

  delete v.replace[n];
  audit(v, 'replace-approved', n, null, 'user');
  saveRaw(v, false);
  const r = put(n, value, opts);
  return { name: n, kind: r.kind };
}

function rejectReplace(name) {
  const n = String(name || '').toUpperCase();
  const v = loadRaw();
  if (!v.replace || !v.replace[n]) return false;
  delete v.replace[n];
  audit(v, 'replace-rejected', n, null, 'user');
  saveRaw(v, false);
  return true;
}

// Local policy, read by add.js which has no access to VSCode settings. Kept in
// the vault directory, so the guard already puts it out of reach of a shell:
// Claude cannot grant itself the permission it is being denied.
const POLICY_PATH = path.join(VAULT_DIR, 'policy.json');

function policy() {
  try {
    const p = JSON.parse(fs.readFileSync(POLICY_PATH, 'utf8'));
    return { autoApprove: !!(p && p.autoApprove) };
  } catch (e) { return { autoApprove: false }; }
}

function setPolicy(o) {
  ensureDirs();
  writeAtomic(POLICY_PATH, JSON.stringify({ autoApprove: !!(o && o.autoApprove), at: Date.now() }));
  return policy();
}

// The chosen interface language, mirrored to a file so the hooks (bare node
// processes that cannot read VSCode state) can speak to the USER in their own
// language when they refuse something the user will read.
const UILANG_PATH = path.join(VAULT_DIR, 'ui-lang.json');

function uiLang() {
  try {
    const p = JSON.parse(fs.readFileSync(UILANG_PATH, 'utf8'));
    return (p && typeof p.lang === 'string') ? p.lang : 'en';
  } catch (e) { return 'en'; }
}

function setUiLang(code) {
  ensureDirs();
  writeAtomic(UILANG_PATH, JSON.stringify({ lang: String(code || 'en'), at: Date.now() }));
}

// -------------------------------------------------------------------- execution tokens

// The PreToolUse hook NEVER puts the value into the command. It injects a
// call to the helper, carrying a single use token with a short lifetime.
// Even if the rewritten command were logged, replaying it would yield nothing.

function readTokens() {
  try {
    const t = JSON.parse(fs.readFileSync(TOKENS_PATH, 'utf8'));
    return t && typeof t === 'object' ? t : {};
  } catch (e) { return {}; }
}

function mintToken(name, mode, session) {
  ensureDirs();
  const all = readTokens();
  const now = Date.now();
  for (const k of Object.keys(all)) if (all[k].exp < now) delete all[k];
  const tok = crypto.randomBytes(18).toString('base64url');
  all[tok] = { name, mode: mode || 'value', session: session || null, exp: now + TOKEN_TTL_MS };
  writeAtomic(TOKENS_PATH, JSON.stringify(all));
  return tok;
}

function redeemToken(tok) {
  const all = readTokens();
  const rec = all[tok];
  delete all[tok];                                    // single use, no matter what happens
  writeAtomic(TOKENS_PATH, JSON.stringify(all));
  if (!rec) throw fail('unknown or already used token');
  if (rec.exp < Date.now()) throw fail('expired token');
  return rec;
}

// Materializes a secret into a temporary file with a restricted ACL (ssh -i,
// certificate, service account). Removed by sweepTmp() or on revocation.
function materialize(name, value) {
  ensureDirs();
  const f = path.join(TMP_DIR, name + '.' + crypto.randomBytes(6).toString('hex'));
  writeAtomic(f, value);
  lockDown(f);
  return f;
}

function sweepTmp(maxAgeMs) {
  const cutoff = Date.now() - (maxAgeMs || 3600000);
  let n = 0;
  try {
    for (const f of fs.readdirSync(TMP_DIR)) {
      const p = path.join(TMP_DIR, f);
      try {
        if (fs.statSync(p).mtimeMs < cutoff) { fs.unlinkSync(p); n++; }
      } catch (e) { /* already gone */ }
    }
  } catch (e) { /* no tmp dir */ }
  return n;
}

// ------------------------------------------------------------------ redaction

// Masks every occurrence of the given values in a text. Best effort: covers
// the raw value, base64 and url-encoded. Does NOT cover a value transformed
// by the command itself (see README, "limitations" section).
function redactor(pairs) {
  const subs = [];
  for (const [name, value] of pairs) {
    if (!value || value.length < 6) continue;
    subs.push([value, name]);
    subs.push([Buffer.from(value, 'utf8').toString('base64'), name]);
    try { subs.push([encodeURIComponent(value), name]); } catch (e) { /* ignore */ }
    for (const line of value.split(/\r?\n/)) {
      if (line.trim().length >= 20) subs.push([line, name]);   // multiline PEM keys
    }
  }
  // HTTP Basic: "curl -u key:secret" sends base64("key:secret"), a string
  // that none of the values taken in isolation lets us recognize. Yet this is
  // exactly the form in which a tested token reappears in a "curl -v" or in
  // an API error message.
  for (const [na, va] of pairs) {
    for (const [nb, vb] of pairs) {
      if (!va || !vb) continue;
      subs.push([Buffer.from(va + ':' + vb, 'utf8').toString('base64'), na + '+' + nb]);
    }
  }
  subs.sort((a, b) => b[0].length - a[0].length);
  return function (text) {
    let out = String(text == null ? '' : text);
    for (const [needle, name] of subs) {
      if (needle && out.indexOf(needle) !== -1) out = out.split(needle).join('«vault:' + name + '»');
    }
    return out;
  };
}

// ------------------------------------------------------------------ diagnostic

// A diagnostic carries the template and its arguments in addition to the
// already assembled message: the UI can therefore translate it, while the
// hook just uses the message as is.
function issue(level, e) {
  return { level, msg: e.message, tpl: e.tpl || null, args: e.args || [] };
}

function healthCheck() {
  const issues = [];
  ensureDirs();
  try {
    masterKey();
  } catch (e) {
    issues.push(issue('error', fail('master key unreachable: {0}', e.message)));
    return { ok: false, issues, mode: null };
  }
  // Same contract on the three platforms: the key is held by the OS secret
  // store. Only the fallback is worth warning about, and the message names the
  // store that is missing so the user knows what to install or unlock.
  if (_masterMode === 'plain') {
    const best = providerChain()[0];
    // "No keyring available" would be a lie when there IS one and we refused it
    // because it keeps its contents in the clear; that case gets its own words.
    // Every other cause keeps the message that names what to install or unlock.
    issues.push(issue('warn', (_downgrade && _downgrade.indexOf('unencrypted') !== -1)
      ? fail('the keyring stores secrets unencrypted (login keyring with an empty password): the master key is protected only by file permissions (0600)')
      : best === 'dpapi'
        ? fail('DPAPI unavailable: the master key is stored unprotected on disk')
        : best === 'keychain'
          ? fail('macOS keychain unavailable: the master key is protected only by file permissions (0600)')
          : best === 'libsecret'
            ? fail('no keyring available (install libsecret-tools): the master key is protected only by file permissions (0600)')
            : fail('master key protected only by file permissions (0600)')));
  }
  try { loadRaw(); }
  catch (e) { issues.push(issue('error', e)); }
  return { ok: !issues.some(i => i.level === 'error'), issues, mode: _masterMode };
}

module.exports = {
  VAULT_DIR, VAULT_PATH, KEY_PATH, TMP_DIR, NAME_RE,
  validateName, list, listFast, put, remove, setTtl, setMcp, setNote, revokeAll, consume, reveal, peek,
  requestReplace, pendingReplacements, approveReplace, rejectReplace, policy, setPolicy,
  notePending, pendingHints, takePending, takeRecent, auditLog,
  noteProxied, unnoteProxied, isProxied, uiLang, setUiLang,
  sweep, sweepTmp, suggest, isExpired, fingerprint, detectKind, kindSource,
  mintToken, redeemToken, materialize, redactor, healthCheck, lockDown
};
