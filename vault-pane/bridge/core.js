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
const zlib = require('zlib');
const { spawnSync } = require('child_process');

const VAULT_DIR = path.join(os.homedir(), '.claude', 'vault');
const VAULT_PATH = path.join(VAULT_DIR, 'vault.json');
const KEY_PATH = path.join(VAULT_DIR, 'masterkey.bin');
const TOKENS_PATH = path.join(VAULT_DIR, 'tokens.json');
const TMP_DIR = path.join(VAULT_DIR, 'tmp');
const TRASH_PATH = path.join(VAULT_DIR, 'trash.json');
const TRASH_INFO = 'claude-vault-trash-v1';
const TRASH_DAYS = 30;

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
  // Atomic on NTFS as on POSIX. But Windows refuses to replace a file another
  // process is reading at that very instant (EPERM / EACCES / EBUSY), and 1.2
  // made that routine: set.js, add.js and the MCP server poll the vault while
  // VS Code writes the user's answer, and the other way round. A brief retry,
  // as graceful-fs does, instead of failing an approval the user just gave.
  for (let attempt = 0; ; attempt++) {
    try { fs.renameSync(tmp, file); break; }
    catch (e) {
      if (attempt >= 40 || !e || !/^(EPERM|EACCES|EBUSY)$/.test(e.code)) {
        try { fs.unlinkSync(tmp); } catch (_) { /* nothing left to clean */ }
        throw e;
      }
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 25);
    }
  }
  // No lockDown here: the file inherits the directory's ACL, restricted at
  // creation time. On POSIX, mode 0600 is already set by openSync.
}

// ------------------------------------------------------------------ write lock
//
// Every writer is its own process: the extension host, the hooks, set.js,
// add.js, the MCP server. Each one loads, changes and saves, and checking the
// counter just before the save does not close the gap: another process can
// land its own save in between, and the last rename wins with a stale copy.
// That loses the other process's key, or leaves the vault one step behind its
// key file, which every later load refuses as a replay. The rename retry above
// turned that gap from microseconds into a second.
//
// So every read-modify-write of the vault, the layout or the policy holds this
// lock from its first read to its last write. Re-entrant within a process:
// put() runs inside approveReplace(), createGroup() inside setKeyGroup(), and
// so on. A holder that died, or that has held it for longer than any real
// operation takes, is broken rather than waited on forever.
const LOCK_PATH = path.join(VAULT_DIR, 'vault.lock');
const LOCK_WAIT_MS = 5000;
const LOCK_STALE_MS = 10000;
let _lockDepth = 0;

function readLockFile() {
  try { return fs.readFileSync(LOCK_PATH, 'utf8'); } catch (e) { return null; }
}

// True when the lock on disk belongs to nobody alive any more.
function lockIsStale(text) {
  let info = null;
  try { info = JSON.parse(text); } catch (e) { /* being written, or garbage */ }
  if (!info || typeof info !== 'object') {
    // Judged on its age alone: a holder writes its pid right after creating
    // the file, so an unreadable lock is either brand new or left by a crash.
    try { return Date.now() - fs.statSync(LOCK_PATH).mtimeMs > LOCK_STALE_MS; } catch (e) { return false; }
  }
  if (Date.now() - (Number(info.at) || 0) > LOCK_STALE_MS) return true;
  const pid = Number(info.pid);
  if (!pid) return true;
  // Our own pid while we hold nothing: left behind by a release that failed.
  if (pid === process.pid) return true;
  try { process.kill(pid, 0); return false; }
  catch (e) { return e.code !== 'EPERM'; }          // EPERM: alive, just not ours
}

function withVaultLock(fn) {
  if (_lockDepth > 0) {
    _lockDepth++;
    try { return fn(); } finally { _lockDepth--; }
  }
  ensureDirs();
  const token = crypto.randomBytes(8).toString('hex');
  const until = Date.now() + LOCK_WAIT_MS;
  for (;;) {
    let fd = null;
    try { fd = fs.openSync(LOCK_PATH, 'wx', 0o600); }
    catch (e) {
      // EPERM / EACCES: Windows refuses to create a file whose previous copy is
      // still being deleted. Same answer as an existing lock: wait a little.
      if (!e || !/^(EEXIST|EPERM|EACCES|EBUSY)$/.test(e.code)) throw e;
    }
    if (fd !== null) {
      try { fs.writeSync(fd, JSON.stringify({ pid: process.pid, at: Date.now(), t: token })); }
      finally { fs.closeSync(fd); }
      break;
    }
    const seen = readLockFile();
    // Read twice and compared: a lock replaced between the judgement and the
    // removal belongs to someone else, and must not be the one that goes.
    if (seen !== null && lockIsStale(seen) && readLockFile() === seen) {
      try { fs.unlinkSync(LOCK_PATH); continue; } catch (e) { /* someone else got there */ }
    }
    if (Date.now() > until) {
      const err = fail('the vault is busy with another operation: try again in a moment');
      err.busy = true;
      throw err;
    }
    sleepSync(25);
  }
  _lockDepth = 1;
  try { return fn(); }
  finally {
    _lockDepth = 0;
    // Only our own lock: if it was broken as stale meanwhile, the file now
    // belongs to whoever took it next.
    try {
      const cur = JSON.parse(readLockFile() || 'null');
      if (cur && cur.t === token) fs.unlinkSync(LOCK_PATH);
    } catch (e) { /* gone already, or unreadable: the stale rule cleans it */ }
  }
}

function locked(fn) {
  return function lockedCall() {
    const args = arguments;
    return withVaultLock(() => fn.apply(this, args));
  };
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
function runIn(cmd, args, input, env) {
  const opts = { input, encoding: 'utf8', windowsHide: true, timeout: 20000 };
  if (env) opts.env = env;
  const r = spawnSync(cmd, args, opts);
  if (r.error) throw fail('{0} unavailable: {1}', cmd, r.error.message);
  if (r.status !== 0) throw fail('{0} failed: {1}', cmd, String(r.stderr || '').trim());
  return String(r.stdout || '').trim();
}

// libsecret reaches the Secret Service over the D-Bus SESSION bus, and GDBus
// only ever looks at DBUS_SESSION_BUS_ADDRESS. A VS Code extension host started
// from a desktop launcher or a systemd unit can carry a stripped environment:
// secret-tool then fails, and the vault quietly settles for file permissions
// even though a perfectly good keyring is running. $XDG_RUNTIME_DIR/bus is the
// standard systemd user bus, so we point at it when the variable is missing and
// the socket is genuinely there.
function busEnv() {
  if (process.platform !== 'linux' || process.env.DBUS_SESSION_BUS_ADDRESS) return null;
  const dir = process.env.XDG_RUNTIME_DIR ||
    (typeof process.getuid === 'function' ? '/run/user/' + process.getuid() : null);
  if (!dir) return null;
  // Built with a literal '/': this is a unix socket path, it must not depend on
  // the host separator that path.join would pick.
  const sock = String(dir).replace(/\/+$/, '') + '/bus';
  try { if (!fs.statSync(sock).isSocket()) return null; }
  catch (e) { return null; }
  return Object.assign({}, process.env, { DBUS_SESSION_BUS_ADDRESS: 'unix:path=' + sock });
}

// --- Windows: DPAPI, CurrentUser scope. The wrapped blob lives in the key file.
function powershell(script, env) {
  return runIn('powershell.exe',
    ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', '-'], script, env);
}

// The payload travels in an ENVIRONMENT VARIABLE, never inside the script text.
// Embedded as a literal, it was captured verbatim by PowerShell Script Block
// Logging and by transcription — meaning the key that decrypts the entire vault
// ended up in clear in a persistent Windows event log, readable by any machine
// administrator. The script itself is now a constant, so logging it reveals
// nothing. Environment blocks are not written to those logs.
function dpapiScript(verb) {
  return "Add-Type -AssemblyName System.Security\n" +
    "$d = [Convert]::FromBase64String($env:CLAUDE_VAULT_BLOB)\n" +
    "$p = [System.Security.Cryptography.ProtectedData]::" + verb + "($d, $null, 'CurrentUser')\n" +
    "[Convert]::ToBase64String($p)\n";
}

function dpapiProtect(buf) {
  return unb64(powershell(dpapiScript('Protect'),
    Object.assign({}, process.env, { CLAUDE_VAULT_BLOB: b64(buf) })));
}

function dpapiUnprotect(buf) {
  return unb64(powershell(dpapiScript('Unprotect'),
    Object.assign({}, process.env, { CLAUDE_VAULT_BLOB: b64(buf) })));
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
    payload, busEnv());
  if (keyringStoresInClear(payload)) {
    throw fail('the keyring is unlocked with an empty password and stores secrets unencrypted');
  }
}

function secretToolLoad() {
  const out = runIn('secret-tool',
    ['lookup', 'service', KEYRING_SERVICE, 'account', KEYRING_ACCOUNT], '', busEnv());
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
  // The "a signed policy exists" marker survives a new key (revocation, phrase
  // import): the policy is signed again under it, and must still be required.
  const pol = policyMarker() ? 1 : undefined;
  for (const mode of providerChain()) {
    const p = PROVIDERS[mode];
    try {
      const blob = p.protect(keyBuf);
      const back = p.unprotect(blob);
      if (!Buffer.isBuffer(back) || !back.equals(keyBuf)) throw fail('round trip mismatch');
      writeAtomic(KEY_PATH, JSON.stringify({ v: 1, mode, blob, seq, pol }));
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
    // A vault that still holds secrets with no key file beside it is NOT a
    // fresh install. Generating a new key here would make every one of those
    // secrets undecryptable, and the next load would then accuse the user of
    // tampering with a file they never touched. Refuse, and leave them the two
    // deliberate ways out: restore a backup, or revoke everything.
    if (fs.existsSync(VAULT_PATH)) {
      throw fail('the key file is missing while the vault still holds secrets: restore a backup of the vault directory, or revoke every key to start over');
    }
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

// Only the counter moves. The key material is already where it belongs — in
// the OS store, or wrapped in this very file — so re-running the whole provider
// chain here was both wasteful and dangerous: it spawned PowerShell twice on
// every single write, and one transient hiccup from the OS store was enough to
// silently rewrite the master key in the clear on disk, under mode 'plain'.
function bumpSeq(next) {
  masterKey();                       // resolves the current mode, cached per process
  const kf = readKeyFile();
  writeAtomic(KEY_PATH, JSON.stringify({ v: 1, mode: kf.mode, blob: kf.blob, seq: next, pol: kf.pol ? 1 : undefined }));
}

// Once a signed policy has been written, its absence is itself a change: a
// policy.json deleted, emptied or stripped of its signature would otherwise
// read as a file from before signatures existed, and fall back to defaults
// that are MORE permissive than an "off" the user chose. The marker sits in the
// key file, next to the anti-replay counter, and carries the same trust: the
// file whose loss already costs every key. Read without the master key, so the
// display path can use it too.
function policyMarker() {
  try { return !!JSON.parse(fs.readFileSync(KEY_PATH, 'utf8')).pol; } catch (e) { return false; }
}

function markPolicySigned() {
  if (policyMarker()) return;
  masterKey();
  const kf = readKeyFile();
  writeAtomic(KEY_PATH, JSON.stringify({ v: 1, mode: kf.mode, blob: kf.blob, seq: kf.seq || 0, pol: 1 }));
}

function derive(info, salt, len) {
  return Buffer.from(crypto.hkdfSync('sha256', masterKey(), salt, Buffer.from(info, 'utf8'), len || 32));
}

// ---------------------------------------------------------------------- vault file

const VAULT_FORMAT = 2;

function emptyVault() { return { v: VAULT_FORMAT, seq: 0, secrets: {}, audit: [] }; }

// v1 signed the identity and the ciphertext of each entry, and nothing else.
// The use counter, the cap and the expiry date sat outside it, yet those three
// are exactly what isExpired() and the burn-after-use decision read: anyone able
// to write the vault file could reset `uses` and make a key presented as burned
// usable again, indefinitely. They cannot decrypt anything without the master
// key, but a limit that can be erased is not a limit. v2 signs them.
function canonical(entries, seq, ver) {
  const ids = Object.keys(entries).sort();
  if (ver === 1) {
    return JSON.stringify({ seq, e: ids.map(id => [id, entries[id].name, entries[id].ct]) });
  }
  return JSON.stringify({
    v: 2, seq,
    e: ids.map(id => {
      const s = entries[id];
      return [id, s.name, s.ct, s.uses || 0, s.maxUses || 0, s.expiresAt || 0];
    })
  });
}

function fileMac(entries, seq, ver) {
  return crypto.createHmac('sha256', derive(MAC_INFO, Buffer.alloc(0), 32))
    .update(canonical(entries, seq, ver || VAULT_FORMAT)).digest('base64');
}

function loadRaw() {
  if (!fs.existsSync(VAULT_PATH)) return emptyVault();
  let v;
  try { v = JSON.parse(fs.readFileSync(VAULT_PATH, 'utf8')); }
  catch (e) { throw fail('vault unreadable (invalid JSON), restore a backup'); }
  if (!v || !v.secrets) return emptyVault();

  // Global integrity: prevents adding, removing or swapping entries.
  // A vault written before v2 is verified against the format it was signed with;
  // the next save rewrites it in v2, so the migration costs the user nothing.
  const ver = v.v === VAULT_FORMAT ? VAULT_FORMAT : 1;
  const expect = fileMac(v.secrets, v.seq || 0, ver);
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
  if (structural) v.seq = (v.seq || 0) + 1;
  // Refuse to write a vault older than the counter. Any caller that loaded, did
  // something slow, and saved could otherwise push seq backwards: the key file
  // would sit one ahead, every later load would cry replay, and the whole vault
  // would be lost along with whatever the concurrent writer had just done.
  // consume() opened exactly that window when it started waiting up to a minute
  // for a confirmation. Throwing here loses one operation; writing loses the vault.
  const hw = currentSeq();
  if ((v.seq || 0) < hw) {
    throw fail('the vault moved while this operation was in flight ({0} behind {1}): nothing was written', String(v.seq || 0), String(hw));
  }
  v.audit = pruneAudit(v.audit);
  v.v = VAULT_FORMAT;                // any save migrates the file to the current format
  v.mac = fileMac(v.secrets, v.seq || 0, VAULT_FORMAT);
  writeAtomic(VAULT_PATH, JSON.stringify(v, null, 0));
  // The counter moves ONLY once the vault is safely on disk. Bumping it first
  // — as this did — meant that any interruption in between (crash, power cut,
  // the OS killing the process) left the key file one ahead of the vault, and
  // loadRaw() then refused the whole file as a replay: every secret lost, for
  // good. In this order an interruption leaves the counter one behind, which
  // loadRaw() accepts, and the anti-replay guarantee still holds for the case
  // it exists to cover: an older vault put back in place.
  if (structural) bumpSeq(v.seq);
  // Last, and never able to break the save: the export file mirrors a vault
  // that is already safely on disk.
  if (structural) { try { exportRefresh(); } catch (e) { /* reported by the panel */ } }
}

// -------------------------------------------------------------- export file
//
// One file, kept up to date on its own, that opens with the recovery phrase on
// any machine. It replaces the twenty rotating copies that used to live beside
// the vault: those died with the disk that held them, and a list of twenty
// timestamps is a decision to make at the worst possible moment.
//
// The whole payload is encrypted, names included. A vault file leaves the
// entries sealed but shows what they are called, and "this person holds a
// STRIPE_SECRET_KEY" is exactly the kind of thing a file meant to leave the
// machine should not say.
//
// Two doors, both leading to the same master key:
//
//   the 17 words  ->  recovery key  ->  envelope  ->  master key
//   this machine  ->  OS secret store           ->  master key
//
// The second one is why re-importing your own file on your own machine asks
// nothing. The first is why it still works on a machine that has never seen it.

const EXPORT_MAGIC = 'claude-vault-export';
const EXPORT_INFO = 'claude-vault-export-v1';
const EXPORT_VERSION = 1;

function exportKey(master) {
  return Buffer.from(crypto.hkdfSync('sha256', master, Buffer.alloc(0),
    Buffer.from(EXPORT_INFO, 'utf8'), 32));
}

// Refusing without a phrase is not pedantry: a file nobody can open anywhere
// else is a copy of the problem, not a solution to it.
// Written whether or not a recovery phrase exists, because the two things it
// does are not the same thing. Without a phrase it is still a backup: this
// machine's own key opens it, and it covers the accident that actually happens,
// a vault deleted or corrupted. With a phrase it also becomes portable, and the
// envelope simply appears in it at the next refresh. Refusing to write anything
// until the phrase existed left people with no net at all in the meantime.
function exportBuild() {
  let env = null;
  try { env = JSON.parse(fs.readFileSync(RECOVERY_PATH, 'utf8')); }
  catch (e) { /* no phrase yet: the file stays local to this machine */ }

  const master = masterKey();
  const v = loadRaw();
  // Everything, not just the keys. A restore that hands back the secrets but
  // loses the bin, the log and the settings is not a restore, it is a rescue.
  // The export path itself is left out on purpose: it names a location on THIS
  // machine, and pointing a fresh install at a folder that does not exist there
  // is worse than asking once.
  const p = policy();
  const payload = Buffer.from(JSON.stringify({
    v: VAULT_FORMAT,
    seq: v.seq || 0,
    secrets: v.secrets,
    audit: Array.isArray(v.audit) ? v.audit : [],
    trash: readTrash(),
    // The decisions travel, the signature does not: it is bound to this
    // machine's key, and the importing side signs again under its own.
    policy: {
      autoApprove: !!p.autoApprove, mcpByAI: p.mcpByAI, layoutByAI: !!p.layoutByAI,
      perAI: p.perAI || {}
    },
    // Display only, but a restore that hands back thirty keys in one flat list
    // after the user spent an afternoon sorting them is not a restore.
    layout: readLayout().items,
    defaults: uiDefaults(),
    uiLang: uiLang()
  }), 'utf8');

  const iv = crypto.randomBytes(12);
  const k = exportKey(master);
  const c = crypto.createCipheriv('aes-256-gcm', k, iv);
  c.setAAD(Buffer.from(EXPORT_INFO, 'utf8'));
  const ct = Buffer.concat([c.update(payload), c.final()]);
  k.fill(0);
  payload.fill(0);

  return JSON.stringify({
    magic: EXPORT_MAGIC, v: EXPORT_VERSION, at: Date.now(),
    count: Object.keys(v.secrets).length,
    recovery: env,                      // absent: readable on this machine only
    iv: b64(iv), tag: b64(c.getAuthTag()), ct: b64(ct)
  });
}

function exportWrite(file) {
  const text = exportBuild();
  writeAtomic(String(file), text);
  setExportFields({ exportPath: String(file), exportAt: Date.now() });
  return { file: String(file), bytes: text.length };
}

// Called after every structural save. Silent on failure by design: an unplugged
// drive must not make saving a key fail, and the panel reports the staleness.
function exportRefresh() {
  const p = exportFields(readPolicyFile());
  if (!p.exportPath) return false;
  try {
    writeAtomic(p.exportPath, exportBuild());
    setExportFields({ exportAt: Date.now() });
    return true;
  } catch (e) { return false; }
}

function exportStatus() {
  const p = exportFields(readPolicyFile());
  const st = {
    path: p.exportPath || null, at: p.exportAt || null, present: false, at_file: null,
    // Portable means: the file carries the envelope, so the phrase opens it
    // anywhere. Without it the file is still a backup, readable here.
    portable: fs.existsSync(RECOVERY_PATH),
    phraseBehind: false
  };
  if (!st.path) return st;
  try {
    const s = fs.statSync(st.path);
    st.present = true;
    st.at_file = s.mtimeMs;
    st.phraseBehind = exportPhraseBehind(st.path);
  } catch (e) { /* moved, unplugged, deleted */ }
  return st;
}

// The file carries its own copy of the envelope, so it can stay on the previous
// phrase when a rewrite failed (drive unplugged). Saying "portable" then would
// send someone to a new machine with words that do not open their file.
function exportPhraseBehind(file) {
  try {
    const f = JSON.parse(fs.readFileSync(file, 'utf8'));
    const env = recoveryEnvelope();
    return ((f.recovery && f.recovery.ct) || null) !== ((env && env.ct) || null);
  } catch (e) { return false; }
}

// Called at startup. A safety net nobody switched on protects nobody, so the
// file exists from the first launch, at a place the user can see and move.
// Never throws: a vault that cannot write its backup still has to open.
const DEFAULT_EXPORT = 'claude-vault-backup.' + 'cvault';

function exportEnsure() {
  try {
    const p = exportFields(readPolicyFile());
    if (p.exportPath) {
      if (fs.existsSync(p.exportPath)) {
        if (exportPhraseBehind(p.exportPath)) exportRefresh();
        return { created: false, path: p.exportPath };
      }
      // Configured but gone: the drive was unplugged, or someone tidied up.
      // Writing it again where it was told to is the least surprising answer.
      exportRefresh();
      return { created: false, path: p.exportPath, rewritten: true };
    }
    if (!fs.existsSync(VAULT_PATH)) return { created: false, path: null };
    const target = path.join(os.homedir(), DEFAULT_EXPORT);
    exportWrite(target);
    return { created: true, path: target };
  } catch (e) { return { created: false, path: null, error: e.message }; }
}

// Explicit nulls, through the unsigned path: forgetting where the backup goes
// must work even while the master key is being thrown away (revokeAll).
function exportForget() {
  if (!readPolicyFile()) return true;
  setExportFields({ exportPath: null, exportAt: null });
  return true;
}

// Reads the envelope of the file without writing anything, so the UI can say
// what it holds and whether it will need the phrase BEFORE asking for it.
function exportInspect(text) {
  let f;
  try { f = JSON.parse(String(text)); }
  catch (e) { throw fail('this file is not a vault export'); }
  if (!f || f.magic !== EXPORT_MAGIC) throw fail('this file is not a vault export');
  if (Number(f.v) > EXPORT_VERSION) {
    throw fail('this export comes from a newer version of the extension');
  }
  let local = false;
  try { local = exportOpens(f, masterKey()); } catch (e) { /* no local key */ }
  // What the caller needs to warn about BEFORE anything is written: how many
  // keys are here now, and whether they would survive.
  let here = 0;
  try { here = listFast().length; } catch (e) { /* no vault yet */ }
  return {
    count: Number(f.count) || 0, at: Number(f.at) || 0, opensLocally: local,
    portable: !!(f.recovery && f.recovery.ct),
    // Which phrase it expects: someone holding several sheets needs the date.
    phraseAt: (f.recovery && Number(f.recovery.at)) || 0,
    here, survives: local          // same key here: the replaced keys can be binned
  };
}

// phrase is optional: on the machine that wrote the file, the local master key
// opens it and nothing is asked.
function exportImport(text, phrase) {
  let f;
  try { f = JSON.parse(String(text)); }
  catch (e) { throw fail('this file is not a vault export'); }
  if (!f || f.magic !== EXPORT_MAGIC) throw fail('this file is not a vault export');
  if (Number(f.v) > EXPORT_VERSION) {
    throw fail('this export comes from a newer version of the extension');
  }

  let master = null;
  let mode = 'local';
  let entropy = null;
  // 1. this machine's own key, if it happens to be the right one
  try {
    const local = masterKey();
    if (exportOpens(f, local)) master = local;
  } catch (e) { /* no local key at all: the phrase is the only way */ }

  // 2. otherwise the words, which also reinstate the key locally
  if (!master) {
    mode = 'phrase';
    const r = f.recovery;
    // A file written before its owner had a phrase is a backup, not an export:
    // it only ever opens on the machine that wrote it, and saying so is more
    // use than asking for words that would not have helped.
    if (!r || !r.salt || !r.iv || !r.tag || !r.ct) {
      throw fail('this file was written as a backup on another machine, with no recovery phrase: nothing can open it here');
    }
    if (!phrase) throw fail('this export was written by another machine: enter its recovery phrase');
    entropy = phraseDecode(phrase);
    const rk = recoveryKey(entropy, unb64(r.salt));
    const d = crypto.createDecipheriv('aes-256-gcm', rk, unb64(r.iv));
    d.setAAD(Buffer.from(RECOVERY_INFO, 'utf8'));
    d.setAuthTag(unb64(r.tag));
    let key;
    try { key = Buffer.concat([d.update(unb64(r.ct)), d.final()]); }
    catch (e) { rk.fill(0); throw fail('the recovery phrase does not open this export'); }
    rk.fill(0);
    if (key.length !== 32) throw fail('master key corrupted');
    if (!exportOpens(f, key)) throw fail('the recovery phrase does not open this export');
    master = key;
  }

  const data = exportOpen(f, master);
  if (!data || !data.secrets) throw fail('this export holds no vault');

  // What is here now is about to be overwritten. On this machine the master key
  // does not move, so those entries stay decryptable and the bin can hold them
  // for thirty days: an import stops being a one way door.
  //
  // After a phrase import it is a different key, and entries sealed under the
  // old one would sit in the bin as noise nobody could ever open. So they are
  // NOT binned, and exportImport reports how many were lost so the caller can
  // say so before it happens rather than after.
  let binned = 0, lost = 0;
  try {
    const old = loadRaw();
    const entries = Object.keys(old.secrets || {}).map(id => old.secrets[id]);
    if (mode === 'local') binned = trashPutMany(entries);
    else lost = entries.length;
  } catch (e) { /* unreadable vault: there was nothing to save anyway */ }

  // The counter only ever moves forward. A vault brought back verbatim looks
  // exactly like the replay this counter exists to catch.
  const seq = Math.max(currentSeq(), Number(data.seq) || 0);
  if (mode === 'phrase') {
    // Read while the old key still verifies it, signed again just below.
    let keptPolicy = null;
    try { if (readPolicyFile()) keptPolicy = policy(); } catch (e) { /* safe defaults */ }
    _master = master;
    _masterMode = null;
    storeKey(master, seq);
    if (readPolicyFile()) { try { resignPolicy(keptPolicy); } catch (e) { /* safe defaults */ } }
    // The local envelope, if there was one, wraps the key we have just replaced.
    // Left alone, recoveryStatus() would keep saying "active" while the phrase
    // it names restores a key that opens nothing. The imported envelope is the
    // right one: it is opened by the words the user just typed. The history was
    // sealed under the replaced key, so it restarts from those same words.
    try { recoveryAdopt(entropy, f.recovery, true); }
    catch (e) { /* unwritable: the vault is fine, the phrase is the file's */ }
  }
  const v = {
    v: VAULT_FORMAT, seq, secrets: data.secrets,
    audit: Array.isArray(data.audit) ? data.audit : []
  };
  audit(v, 'import', null, mode, 'user');
  saveRaw(v, true);

  // The rest of the configuration, restored after the vault so a failure here
  // never costs the keys. Each piece is optional: an export written before this
  // existed simply carries fewer of them.
  if (Array.isArray(data.trash)) {
    // The keys binned a few lines above must not be thrown away by the file's
    // own bin. Both are kept, the local ones winning on a shared identifier.
    const local = readTrash();
    const vus = new Set(local.map(i => i.id));
    const fusion = local.concat(data.trash.filter(i => i && i.id && !vus.has(i.id)));
    try { writeTrash(purgeTrashList(fusion)); } catch (e) { /* the vault is in */ }
  }
  if (data.policy && typeof data.policy === 'object') {
    // Only what is there and valid: an export written before these settings
    // existed carries autoApprove alone, and must not reset the rest here.
    const dp = data.policy;
    const patch = {};
    if (typeof dp.autoApprove === 'boolean') patch.autoApprove = dp.autoApprove;
    if (MCP_MODES.indexOf(dp.mcpByAI) !== -1) patch.mcpByAI = dp.mcpByAI;
    if (typeof dp.layoutByAI === 'boolean') patch.layoutByAI = dp.layoutByAI;
    if (dp.perAI && typeof dp.perAI === 'object') {
      // Restored, not merged: setPolicy() overlays a given override on the
      // local one, so every field is named, the absent ones as null, and what
      // comes out is exactly the exported override.
      patch.perAI = {};
      for (const ai of AIS) {
        patch.perAI[ai] = dp.perAI[ai]
          ? Object.assign({ autoApprove: null, mcpByAI: null, layoutByAI: null }, cleanOverride(dp.perAI[ai]))
          : null;
      }
    }
    try { setPolicy(patch); }
    catch (e) { /* keeps the local setting */ }
  }
  if (Array.isArray(data.layout)) {
    try { writeLayout(data.layout); } catch (e) { /* keeps the local layout */ }
    // The structural save above refreshed the export before the layout came
    // back; refresh it again so the file matches what was just restored.
    refreshAfterLayout();
  }
  if (data.defaults && data.defaults.set) {
    try { setUiDefaults(data.defaults); } catch (e) { /* keeps the local ones */ }
  }
  if (typeof data.uiLang === 'string') {
    try { setUiLang(data.uiLang); } catch (e) { /* keeps the local language */ }
  }
  return {
    secrets: Object.keys(data.secrets).length, mode, at: Number(f.at) || 0, binned, lost,
    restored: {
      audit: (v.audit || []).length,
      trash: Array.isArray(data.trash) ? data.trash.length : 0,
      settings: !!data.policy, defaults: !!(data.defaults && data.defaults.set),
      layout: Array.isArray(data.layout) ? data.layout.length : 0,
      language: typeof data.uiLang === 'string' ? data.uiLang : null
    }
  };
}

function exportOpen(f, master) {
  const k = exportKey(master);
  const d = crypto.createDecipheriv('aes-256-gcm', k, unb64(f.iv));
  d.setAAD(Buffer.from(EXPORT_INFO, 'utf8'));
  d.setAuthTag(unb64(f.tag));
  try {
    const clear = Buffer.concat([d.update(unb64(f.ct)), d.final()]);
    k.fill(0);
    return JSON.parse(clear.toString('utf8'));
  } catch (e) { k.fill(0); return null; }
}

function exportOpens(f, master) {
  try { return exportOpen(f, master) !== null; } catch (e) { return false; }
}

// ---------------------------------------------------------- transfer string
//
// One line of text that carries every key to another machine, for a person who
// wants to paste something rather than move a file.
//
// It is not the export file in another shape. The file is sealed under the
// master key, so restoring it elsewhere replaces that machine's key and costs
// whatever was sealed with the old one. Here the values are opened, the set is
// encrypted under a key derived from a password, and the receiving machine seals
// them again under ITS OWN key: what it already holds survives, and no master
// key ever travels.
//
// Only keys and their own settings travel. The policy, the log and the bin stay
// where they are: a string that could relax what an assistant may do on the
// receiving machine would be a much larger thing than a list of keys.
//
// The phrase can use HKDF because its 128 bits are random. A password is chosen
// by a person, and this string is meant to go through mail or chat, where anyone
// who catches it can guess for as long as they like. That is exactly what a
// costly derivation exists for: scrypt at the strength OWASP recommends.
//
//   cvault1.<base64url of: salt(16) logN r p | iv(12) tag(16) ciphertext | sum(4)>
//
// Nothing is readable without the password, not even the number of keys. The
// sum protects nothing and only tells a truncated paste from a wrong password.

const TRANSFER_PREFIX = 'cvault1.';
const TRANSFER_INFO = 'claude-vault-transfer-v1';
const TRANSFER_LOG_N = 17;                  // about 134 MB and half a second
const TRANSFER_LOG_N_MAX = 18;              // a forged string cannot ask for more
const TRANSFER_R = 8;
const TRANSFER_P = 1;
const TRANSFER_HEAD = 19;                   // salt + logN + r + p
const TRANSFER_SUM = 4;
const TRANSFER_MAX_CLEAR = 16 * 1024 * 1024;
const TRANSFER_PASSWORD_MIN = 12;

// A second layer on what the input box checks, so that no path through the core
// can seal a whole vault under a password of four letters.
function transferPasswordIssue(password) {
  const p = String(password == null ? '' : password);
  // Two different strings on two different screens, invisible behind the dots.
  if (p !== p.trim()) return fail('the password cannot start or end with a space');
  const chars = Array.from(p);
  if (chars.length < TRANSFER_PASSWORD_MIN) {
    return fail('the password needs at least {0} characters', TRANSFER_PASSWORD_MIN);
  }
  if (new Set(chars).size < 6) return fail('this password is too repetitive: use more different characters');
  return null;
}

// For whoever would rather not invent one. Twenty characters from an alphabet with
// no look-alikes, about 99 bits: this password has to survive offline guessing, and
// still be readable aloud or retyped from another screen.
const TRANSFER_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';

function transferPasswordGenerate() {
  for (;;) {
    let p = '';
    for (let i = 0; i < 20; i++) {
      if (i && i % 5 === 0) p += '-';
      p += TRANSFER_ALPHABET[crypto.randomInt(TRANSFER_ALPHABET.length)];
    }
    if (!transferPasswordIssue(p)) return p;
  }
}

// Asynchronous on purpose: half a second of scrypt must not freeze the editor.
// NFKC, because the same accented password can reach two machines encoded two ways.
function transferKey(password, salt, logN) {
  const N = Math.pow(2, logN);
  return new Promise((resolve, reject) => {
    crypto.scrypt(String(password).normalize('NFKC'), salt, 32,
      { N, r: TRANSFER_R, p: TRANSFER_P, maxmem: 256 * N * TRANSFER_R },
      (e, key) => (e ? reject(e) : resolve(key)));
  });
}

function transferSum(body) {
  return crypto.createHash('sha256').update(body).digest().subarray(0, TRANSFER_SUM);
}

// Reads the values under the lock, and logs it: a whole vault is about to leave
// in one piece, the one thing a person checking this log would want to find.
// A transfer is the owner's gesture, so like reveal() it does not count as a use,
// but a capped key arrives with what is left of its cap, not with a fresh one.
function transferSnapshot() {
  const v = loadRaw();
  const groups = groupIndex();
  const keys = [];
  const failed = [];
  for (const id of Object.keys(v.secrets)) {
    const s = v.secrets[id];
    if (isExpired(s)) continue;
    let value;
    try { value = open(s); } catch (e) { failed.push(s.name); continue; }
    keys.push({
      name: s.name, value, policy: s.policy, expiresAt: s.expiresAt || null,
      maxUses: s.maxUses ? Math.max(1, s.maxUses - (s.uses || 0)) : null,
      mcp: !!s.mcp, mcpServers: s.mcpServers || null, pub: !!s.pub, confirm: !!s.confirm,
      note: s.note || null, group: (s.groupId && groups.get(s.groupId)) || null
    });
  }
  if (!keys.length) throw fail('the vault holds no key to transfer');
  audit(v, 'transfer-out', null, String(keys.length), 'user');
  saveRaw(v, false);
  const layoutItems = readLayout().items.map(i => (i.type === 'group'
    ? { type: 'group', name: i.name, collapsed: !!i.collapsed }
    : { type: 'separator', label: i.label || null }));
  return { keys, failed, layout: layoutItems };
}

async function transferBuild(password) {
  const bad = transferPasswordIssue(password);
  if (bad) throw bad;
  const snap = transferSnapshot();
  const clear = Buffer.from(JSON.stringify({
    v: 1, at: Date.now(), keys: snap.keys, layout: snap.layout
  }), 'utf8');
  const packed = zlib.deflateRawSync(clear);
  clear.fill(0);

  const head = Buffer.concat([crypto.randomBytes(16),
    Buffer.from([TRANSFER_LOG_N, TRANSFER_R, TRANSFER_P])]);
  const key = await transferKey(password, head.subarray(0, 16), TRANSFER_LOG_N);
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', key, iv);
  c.setAAD(Buffer.concat([Buffer.from(TRANSFER_INFO, 'utf8'), head]));
  const ct = Buffer.concat([c.update(packed), c.final()]);
  key.fill(0);
  packed.fill(0);

  const body = Buffer.concat([head, iv, c.getAuthTag(), ct]);
  const text = TRANSFER_PREFIX + Buffer.concat([body, transferSum(body)]).toString('base64url');
  return { text, count: snap.keys.length, failed: snap.failed };
}

// Mail clients wrap long lines, hence the whitespace. Runs before any password
// is asked for: "this string is cut" is more use than "wrong password".
function transferParse(text) {
  const s = String(text == null ? '' : text).replace(/\s+/g, '');
  if (!s.startsWith(TRANSFER_PREFIX)) throw fail('this is not a transfer string');
  const raw = Buffer.from(s.slice(TRANSFER_PREFIX.length), 'base64url');
  if (raw.length < TRANSFER_HEAD + 12 + 16 + TRANSFER_SUM + 1) {
    throw fail('this transfer string is incomplete: copy it again, all of it');
  }
  const body = raw.subarray(0, raw.length - TRANSFER_SUM);
  if (!transferSum(body).equals(raw.subarray(raw.length - TRANSFER_SUM))) {
    throw fail('this transfer string is incomplete: copy it again, all of it');
  }
  const logN = body[16];
  if (logN > TRANSFER_LOG_N_MAX || logN < 10 || body[17] !== TRANSFER_R || body[18] !== TRANSFER_P) {
    throw fail('this transfer string comes from a newer version of the extension');
  }
  return { head: body.subarray(0, TRANSFER_HEAD), logN,
    iv: body.subarray(TRANSFER_HEAD, TRANSFER_HEAD + 12),
    tag: body.subarray(TRANSFER_HEAD + 12, TRANSFER_HEAD + 28),
    ct: body.subarray(TRANSFER_HEAD + 28) };
}

function transferCheck(text) {
  transferParse(text);
  return true;
}

// Anything that opens under the password is still only as trusted as whoever
// wrote it, so each field goes back through what put() would accept.
function transferCleanKeys(list) {
  const keys = [];
  const invalid = [];
  const seen = new Set();
  for (const k of Array.isArray(list) ? list : []) {
    let name = null;
    try { name = validateName(k && k.name); } catch (e) { /* counted below */ }
    if (!name || seen.has(name) || typeof k.value !== 'string' || !k.value) {
      invalid.push(String((k && k.name) || '?').slice(0, 64));
      continue;
    }
    seen.add(name);
    keys.push({
      name, value: k.value, policy: k.policy === 'reveal' ? 'reveal' : 'exec-only',
      expiresAt: Number(k.expiresAt) || null, maxUses: Number(k.maxUses) || null,
      mcp: !!k.mcp, pub: !!k.pub, confirm: !!k.confirm,
      mcpServers: (k.mcp && Array.isArray(k.mcpServers) && k.mcpServers.length)
        ? k.mcpServers.map(String).slice(0, 32) : null,
      note: k.note ? String(k.note).slice(0, NOTE_MAX) : null,
      group: normalizeGroupName(k.group)
    });
  }
  return { keys, invalid };
}

async function transferOpen(text, password) {
  const t = transferParse(text);
  const key = await transferKey(password, t.head.subarray(0, 16), t.logN);
  const d = crypto.createDecipheriv('aes-256-gcm', key, t.iv);
  d.setAAD(Buffer.concat([Buffer.from(TRANSFER_INFO, 'utf8'), t.head]));
  d.setAuthTag(t.tag);
  let packed;
  try { packed = Buffer.concat([d.update(t.ct), d.final()]); }
  catch (e) {
    key.fill(0);
    const wrong = fail('wrong password');
    wrong.wrongPassword = true;
    throw wrong;
  }
  key.fill(0);
  let data;
  try {
    data = JSON.parse(zlib.inflateRawSync(packed, { maxOutputLength: TRANSFER_MAX_CLEAR }).toString('utf8'));
  } catch (e) { throw fail('this transfer string holds no keys'); }
  if (!data || !Array.isArray(data.keys)) throw fail('this transfer string holds no keys');
  const clean = transferCleanKeys(data.keys);
  return {
    at: Number(data.at) || 0, keys: clean.keys, invalid: clean.invalid,
    layout: Array.isArray(data.layout) ? data.layout : []
  };
}

// Where each key would go, decided by fingerprint so that nothing already here
// gets decrypted just to be compared. Names only: this goes on screen.
function transferPreview(data) {
  const v = loadRaw();
  const now = Date.now();
  const out = { at: data.at, fresh: [], same: [], conflicts: [], expired: [], invalid: data.invalid, mcp: 0 };
  for (const k of data.keys) {
    if (k.expiresAt && k.expiresAt <= now) { out.expired.push(k.name); continue; }
    const here = findByName(v, k.name);
    if (!here) { out.fresh.push(k.name); if (k.mcp) out.mcp++; continue; }
    if (here.fingerprint === fingerprint(k.value)) out.same.push(k.name);
    else out.conflicts.push(k.name);
  }
  return out;
}

// All at once and with a single save: stopping on the fifth key of seventy would
// leave a half moved vault nobody could describe. A replaced key waits in the bin
// rather than being overwritten, which is what makes the choice safe to offer.
function transferApply(data, onConflict) {
  const v = loadRaw();
  const now = Date.now();
  const items = readLayout().items;
  const blank = !items.length;
  const result = { added: 0, replaced: 0, kept: 0, same: 0, expired: 0 };
  const binned = [];
  const groupIds = new Map();
  for (const i of items) if (i.type === 'group') groupIds.set(i.name.toLowerCase(), i.id);

  const addGroup = (name, collapsed) => {
    const n = normalizeGroupName(name);
    if (!n || n.toLowerCase() === 'none') return null;
    if (groupIds.has(n.toLowerCase())) return groupIds.get(n.toLowerCase());
    const id = crypto.randomUUID();
    items.push({ type: 'group', id, name: n, collapsed: !!collapsed });
    groupIds.set(n.toLowerCase(), id);
    return id;
  };

  // A machine with no layout takes the whole arrangement, empty groups and
  // separators included. One that was already arranged only gains the groups its
  // new keys need: dropping someone else's headings into a list that was sorted
  // by hand is not what "import my keys" asked for.
  if (blank) {
    for (const i of data.layout) {
      if (i && i.type === 'group') addGroup(i.name, i.collapsed);
      else if (i && i.type === 'separator') {
        items.push({ type: 'separator', id: crypto.randomUUID(), label: cleanLabel(i.label) });
      }
    }
  }

  for (const k of data.keys) {
    if (k.expiresAt && k.expiresAt <= now) { result.expired++; continue; }
    const here = findByName(v, k.name);
    if (here) {
      if (here.fingerprint === fingerprint(k.value)) { result.same++; continue; }
      if (onConflict !== 'replace') { result.kept++; continue; }
      binned.push(here);
      delete v.secrets[here.id];
      if (v.replace && v.replace[k.name]) delete v.replace[k.name];
      dropMcpRequestsFor(v, [k.name]);
    }
    const groupId = (k.group && addGroup(k.group, false)) || (here && here.groupId) || null;
    const entry = buildEntry(crypto.randomUUID(), k.name, k.value, {
      policy: k.policy, expiresAt: k.expiresAt, maxUses: k.maxUses, mcp: k.mcp,
      mcpServers: k.mcpServers, pub: k.pub, confirm: k.confirm, note: k.note, by: 'user'
    }, groupId, groupId ? 'user' : null);
    v.secrets[entry.id] = entry;
    audit(v, here ? 'replace' : 'create', k.name, entry.kind, 'user');
    if (entry.mcp) audit(v, 'mcp', k.name, entry.mcpServers ? entry.mcpServers.join(',') : 'allowed', 'user');
    if (here) result.replaced++;
    else result.added++;
  }

  if (!result.added && !result.replaced) return result;
  // Bin first: a crash after this leaves one spare entry in the bin, the other
  // way round it would leave a key that exists nowhere.
  trashPutMany(binned);
  if (items.length) writeLayout(items);
  audit(v, 'transfer-in', null, String(result.added + result.replaced), 'user');
  saveRaw(v, true);
  return result;
}

// ----------------------------------------------------------- the commit guard
//
// Answers one question: does this text contain one of your own secrets? It
// compares fingerprints, never values, so nothing is decrypted and the answer
// is exact. No entropy heuristic, no list of provider prefixes, and therefore
// no false positives to train the user into ignoring it.
//
// Two things keep this honest. The fingerprint is an HMAC keyed by the master
// key, so nobody without the vault can compute one. And it lives here, called
// by the extension, never by a git hook: a hook is a thing any repository can
// trigger, and a guard that answers "is this string one of your secrets" on
// demand is an oracle before it is a guard.
//
// Keys marked public are skipped. A Stripe pk_ belongs in the commit.

// '=' is NOT a token character, it is base64 padding at the very end. Left in
// the class, the commonest form of all — VAR=value — matched as a single token
// "API_KEY=sk-ant-..." and fingerprinted to nothing.
const SCAN_TOKEN = /[A-Za-z0-9_\-+/.~]{12,}={0,2}/g;
const SCAN_PEM = /-----BEGIN [^-]+-----[\s\S]*?-----END [^-]+-----/g;
const SCAN_MAX = 40000;                     // candidates per call, a hard stop

function knownFingerprints() {
  let v;
  try { v = JSON.parse(fs.readFileSync(VAULT_PATH, 'utf8')); }
  catch (e) { return null; }
  if (!v || !v.secrets) return null;
  const index = new Map();
  for (const id of Object.keys(v.secrets)) {
    const s = v.secrets[id];
    if (s.pub || !s.fingerprint) continue;
    index.set(s.fingerprint, s.name);
  }
  return index.size ? index : null;
}

// Returns the names of the keys whose value appears in the text. Empty on any
// doubt: this runs on the save path, and it must never be the reason an editor
// stutters or an error appears.
function scanText(text) {
  const index = knownFingerprints();
  if (!index) return [];
  const s = String(text || '');
  if (!s) return [];
  const hits = new Set();
  const seen = new Set();
  try {
    // Whole PEM blocks first: a private key spans lines, so no token match can
    // ever find it.
    for (const m of s.matchAll(SCAN_PEM)) {
      const name = index.get(fingerprint(m[0]));
      if (name) hits.add(name);
    }
    for (const m of s.matchAll(SCAN_TOKEN)) {
      const tok = m[0];
      if (seen.has(tok)) continue;
      seen.add(tok);
      if (seen.size > SCAN_MAX) break;
      let name = index.get(fingerprint(tok));
      // A diff line begins with '+', and '+' is a legal base64 character, so a
      // bare value on an added line arrives glued to it.
      if (!name && (tok[0] === '+' || tok[0] === '-') && tok.length > 13) {
        name = index.get(fingerprint(tok.slice(1)));
      }
      if (name) hits.add(name);
    }
  } catch (e) { return []; }
  return Array.from(hits);
}

// ------------------------------------------------------------------- the bin
//
// Deleting the wrong line is the most ordinary accident there is, and until now
// one confirmation stood between it and a value nobody could ever see again.
// A deleted entry now waits {TRASH_DAYS} days here, still sealed, before it
// really goes.
//
// It lives in its own file rather than inside the vault: putting it in vault.json
// would mean changing the signed format, and a format migration that goes wrong
// costs the user every key. A separate file with its own signature buys the
// same integrity for none of that risk.

function trashMac(items) {
  return crypto.createHmac('sha256', derive(TRASH_INFO, Buffer.alloc(0), 32))
    .update(JSON.stringify(items.map(i => [i.id, i.name, i.ct, i.deletedAt]))).digest('base64');
}

function readTrash() {
  let t;
  try { t = JSON.parse(fs.readFileSync(TRASH_PATH, 'utf8')); }
  catch (e) { return []; }
  if (!t || !Array.isArray(t.items)) return [];
  // A bin whose signature does not match is dropped, not repaired: it holds
  // nothing the vault needs, and resurrecting an entry someone else slipped in
  // is exactly what the signature is here to prevent.
  if (!t.mac || !equalCT(t.mac, trashMac(t.items))) return [];
  return t.items;
}

function writeTrash(items) {
  writeAtomic(TRASH_PATH, JSON.stringify({ v: 1, items, mac: trashMac(items) }, null, 0));
}

function trashPut(entry) { trashPutMany([entry]); }

function trashPutMany(entries) {
  if (!entries || !entries.length) return 0;
  const now = Date.now();
  const ids = new Set(entries.map(e => e.id));
  const items = readTrash().filter(i => !ids.has(i.id));
  for (const e of entries) items.push(Object.assign({}, e, { deletedAt: now }));
  writeTrash(purgeTrashList(items));
  return entries.length;
}

function purgeTrashList(items) {
  const cutoff = Date.now() - TRASH_DAYS * 86400000;
  return items.filter(i => (i.deletedAt || 0) >= cutoff);
}

function purgeTrash() {
  const items = readTrash();
  const kept = purgeTrashList(items);
  if (kept.length !== items.length) writeTrash(kept);
  return items.length - kept.length;
}

// Names and dates only. Same rule as everywhere else in this file: no read path.
function listTrash() {
  return readTrash().map(i => ({
    id: i.id, name: i.name, deletedAt: i.deletedAt || 0,
    kind: i.kind || 'secret', length: i.length || 0,
    expiresIn: Math.max(0, (i.deletedAt || 0) + TRASH_DAYS * 86400000 - Date.now())
  })).sort((a, b) => b.deletedAt - a.deletedAt);
}

// A free name for something coming back. The original if nothing took it, so
// every {{vault:NAME}} already written keeps working; otherwise a prefix, in
// English because a key name never is anything else. Refusing was the previous
// answer, and refusing to give back a key that is sitting right there, still
// decryptable, is not an answer.
function freeName(v, base) {
  const taken = new Set(Object.keys(v.secrets).map(id => v.secrets[id].name));
  if (!taken.has(base)) return base;
  for (let i = 1; i < 50; i++) {
    const prefix = i === 1 ? 'RECOVERY_' : 'RECOVERY' + i + '_';
    // The 64 character cap is enforced by NAME_RE, so a long name loses its
    // tail rather than the prefix that says where it came from.
    const n = (prefix + base).slice(0, 64).replace(/_+$/, '');
    if (NAME_RE.test(n) && !taken.has(n)) return n;
  }
  return null;
}

function restoreTrashed(id) {
  const items = readTrash();
  const it = items.find(i => i.id === id);
  if (!it) throw fail('nothing in the bin under that reference');
  const v = loadRaw();
  const entry = Object.assign({}, it);
  delete entry.deletedAt;

  const nom = freeName(v, entry.name);
  if (!nom) throw fail('no free name left for {0}', entry.name);
  const renamed = nom !== entry.name;
  // The identity can clash too, and that one is silent: an import brings back
  // the same entries with the same ids, so writing the binned copy under its own
  // id REPLACED the live one instead of joining it. Guarding the name alone was
  // not enough.
  const clash = !!v.secrets[entry.id];
  if (renamed || clash) {
    // Both the id and the name are part of what the entry was sealed against,
    // so the value has to be read before either changes, and sealed after.
    const value = open(entry);
    if (clash) entry.id = crypto.randomUUID();
    entry.name = nom;
    entry.ct = seal(entry, value);
  }

  v.secrets[entry.id] = entry;
  dropMcpRequestsFor(v, [entry.name]);
  audit(v, 'untrash', entry.name, renamed ? it.name : null, 'user');
  saveRaw(v, true);
  writeTrash(items.filter(i => i.id !== id));
  return { name: entry.name, from: it.name, renamed };
}

function emptyTrash() {
  const n = readTrash().length;
  try { fs.unlinkSync(TRASH_PATH); } catch (e) { /* already gone */ }
  return n;
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
  // In the AAD, and conditionally like the rest, because the flag has teeth:
  // it decides whether the commit guard looks at this key at all. Flipping a
  // secret to "public" by editing the JSON now breaks the seal instead of
  // quietly disarming the guard.
  if (entry.pub) a.pub = true;
  // Conditional like the others, and in the AAD for the same reason as pub:
  // clearing this flag by editing the JSON would silently remove the question
  // the user asked to be asked.
  if (entry.confirm) a.cfm = true;
  // Same conditional rule, same reason: a key authorised for every server
  // carries no server list, so its AAD is byte for byte what it always was.
  // Sorted, because the order the user picked them in is not part of the grant.
  if (entry.mcpServers && entry.mcpServers.length) a.srv = entry.mcpServers.slice().sort();
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

// ------------------------------------------------------- publishable values
//
// Plenty of services hand out a pair whose public half is meant to sit in client
// code: Stripe's pk_, Supabase's anon key, a Turnstile sitekey. Keeping them in
// the vault is perfectly reasonable — one place for the whole configuration —
// but treating them as secrets means warning about them, and a warning that is
// wrong three times gets the whole feature switched off.
//
// The detection is deliberately timid. Marking a real secret as public is the
// dangerous mistake: it is the one that would quietly exclude it from the
// commit guard. So only unmistakable published forms count, and the name alone
// is never enough — PUBLIC_KEY is what half the world calls its PRIVATE key's
// counterpart, and RSA private keys live in files called id_rsa.pub's sibling.
const PUBLISHABLE = [
  /^pk_(live|test)_[A-Za-z0-9]/,             // Stripe publishable
  /^pk\.eyJ[\w-]+\.[\w-]+/,                  // Mapbox public token
  /^0x4AAAAAAA[A-Za-z0-9_-]/,                // Cloudflare Turnstile sitekey
  /^rzp_(live|test)_/                        // Razorpay key id
  // A "pub_" catch-all used to sit here. I could not name a single provider
  // that issues it, and a pattern I cannot attribute has no business deciding
  // that a value stops being watched.
];

function detectPublic(value) {
  const s = String(value || '');
  for (const re of PUBLISHABLE) if (re.test(s)) return true;
  // Supabase and friends ship an anon key as a JWT whose payload says so. The
  // role is inside the token, so this reads what the value itself claims to be
  // rather than guessing from its shape.
  const m = /^eyJ[\w-]+\.([\w-]+)\./.exec(s);
  if (m) {
    try {
      const p = JSON.parse(Buffer.from(m[1].replace(/-/g, '+').replace(/_/g, '/'), 'base64')
        .toString('utf8'));
      if (p && (p.role === 'anon' || p.role === 'public')) return true;
    } catch (e) { /* not a readable payload: treat as secret */ }
  }
  return false;
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
// Runs on the panel's render path and before every use, so a vault that does
// not exist yet costs nothing here, and a lock held elsewhere only postpones
// the purge to the next call instead of failing the caller.
function sweep() {
  if (!fs.existsSync(VAULT_PATH) && !fs.existsSync(TRASH_PATH)) return [];
  try { return withVaultLock(sweepLocked); }
  catch (e) { if (e && e.busy) return []; throw e; }
}

function sweepLocked() {
  let v;
  try { v = loadRaw(); } catch (e) { return []; }
  try { purgeTrash(); } catch (e) { /* the bin must never block the vault */ }
  const now = Date.now();
  const gone = [];
  for (const id of Object.keys(v.secrets)) {
    if (isExpired(v.secrets[id], now)) {
      gone.push(v.secrets[id].name);
      // An expiry is the user's own instruction, on a schedule they set. Putting
      // it in the bin would quietly keep alive exactly what they asked to end.
      audit(v, 'expire', v.secrets[id].name, null);
      delete v.secrets[id];
    }
  }
  if (gone.length) saveRaw(v, true);
  return gone;
}

// -------------------------------------------------------------------- public API

// What a person types becomes a usable name instead of an error message.
// Accents lose their marks — é gives E — spaces and every other separator or
// symbol become a single underscore, and the result is upper-cased:
// "clé api Mailjet" gives CLE_API_MAILJET. Already-valid names pass through
// untouched, which is what lets the hook resolve a {{vault:NAME}} marker with
// the very same function.
function normalizeName(name) {
  let n = String(name == null ? '' : name)
    // Combining diacritical marks, escaped rather than pasted literally so the
    // range survives any re-encoding of this file.
    .normalize('NFD').replace(/[̀-ͯ]/g, '')   // é -> e, ç -> c
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, '_')
    .replace(/_{2,}/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 64);
  return n.replace(/_+$/, '');    // the slice above can leave one dangling
}

function validateName(name) {
  const n = normalizeName(name);
  if (!NAME_RE.test(n)) {
    throw fail('Invalid name: it must start with a letter and keep 2 to 64 ' +
      'letters or digits. Spaces and accents are accepted and converted ' +
      '(e.g. "clé ssh vps" becomes CLE_SSH_VPS).');
  }
  return n;
}

function list() {
  sweep();
  let v;
  try { v = loadRaw(); } catch (e) { return { error: e.message, secrets: [] }; }
  const now = Date.now();
  const groups = groupIndex();
  const secrets = Object.keys(v.secrets).map(id => {
    const s = v.secrets[id];
    return Object.assign({
      id, name: s.name, kind: s.kind, hint: s.hint, length: s.length,
      fingerprint: s.fingerprint, policy: s.policy,
      createdAt: s.createdAt, expiresAt: s.expiresAt || null,
      maxUses: s.maxUses || null, uses: s.uses || 0, pub: !!s.pub, confirm: !!s.confirm,
      lastUsedAt: s.lastUsedAt || null,
      expiresIn: s.expiresAt ? Math.max(0, s.expiresAt - now) : null,
      note: s.note || null
    }, groupFields(s, groups));
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
  const groups = groupIndex();
  return Object.keys(v.secrets).map(id => {
    const s = v.secrets[id];
    return Object.assign(groupFields(s, groups), {
      name: s.name, kind: s.kind, hint: s.hint, length: s.length, note: s.note || null,
      createdBy: s.createdBy || null,
      policy: s.policy, isFile: !!s.isFile, mcp: !!s.mcp,
      mcpServers: (s.mcpServers && s.mcpServers.length) ? s.mcpServers.slice() : null,
      pub: !!s.pub, confirm: !!s.confirm,
      uses: s.uses || 0,
      lastUsedAt: s.lastUsedAt || null,
      createdAt: s.createdAt, expiresAt: s.expiresAt || null, maxUses: s.maxUses || null,
      expiresIn: s.expiresAt ? Math.max(0, s.expiresAt - now) : null,
      // remaining life fraction: feeds the draining bar in the UI
      lifeLeft: s.expiresAt && s.createdAt && s.expiresAt > s.createdAt
        ? Math.max(0, Math.min(1, (s.expiresAt - now) / (s.expiresAt - s.createdAt)))
        : null,
      expired: isExpired(s, now)
    });
  }).sort((a, b) => a.name.localeCompare(b.name));
}

function findByName(v, name) {
  // Normalised on the way in too, so looking a key up is as forgiving as
  // creating one: "ma cle" finds MA_CLE.
  const n = normalizeName(name);
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
  // A proposal waiting for approval describes the value that was there when it
  // was made. Writing a new one makes it obsolete, and approving it afterwards
  // would overwrite what the user just put in with something older.
  if (v.replace && v.replace[n]) delete v.replace[n];
  // Same reasoning for a pending MCP request: it was shown with this key's
  // fingerprint, and the value it would expose is about to change.
  dropMcpRequestsFor(v, [n]);
  // The group is display metadata, so a replacement keeps it unless the caller
  // says otherwise. Every replacement path (replaceValue, approveReplace, the
  // automatic approval in add.js) goes through here, which is what makes the
  // carry-over impossible to forget.
  let groupId = null, groupBy = null;
  if (o.groupId === undefined) {
    if (existing) { groupId = existing.groupId || null; groupBy = existing.groupBy || null; }
  } else if (o.groupId) {
    groupId = String(o.groupId);
    groupBy = actorOf(o.groupBy !== undefined ? o.groupBy : o.by);
  }
  const entry = buildEntry(existing ? existing.id : crypto.randomUUID(), n, value, o, groupId, groupBy);
  v.secrets[entry.id] = entry;
  audit(v, existing ? 'replace' : 'create', n, entry.kind, entry.createdBy);
  // A key born with MCP access gets the same journal line as a later grant, so
  // "who opened this key to MCP" has one answer whichever way it happened.
  if (!existing && entry.mcp) {
    audit(v, 'mcp', n, entry.mcpServers ? entry.mcpServers.join(',') : 'allowed', entry.createdBy);
  }
  saveRaw(v, true);
  return { name: n, replaced: !!existing, fingerprint: entry.fingerprint, kind: entry.kind };
}

function buildEntry(id, n, value, o, groupId, groupBy) {
  const entry = {
    id,
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
    mcpServers: (o.mcp && Array.isArray(o.mcpServers) && o.mcpServers.length)
      ? o.mcpServers.map(x => String(x)).slice(0, 32) : null,
    // Detected, never assumed: an explicit choice always wins over the guess.
    pub: o.pub === undefined ? detectPublic(value) : !!o.pub,
    confirm: !!o.confirm,
    note: o.note || null,
    // Outside the AAD and outside the file MAC, like the note: moving a key to
    // another group must never cost a re-encryption, and a forged group can at
    // worst display a key under the wrong heading.
    groupId,
    groupBy
  };
  // Who authored the value, kept on the entry itself so the key can say it
  // long after the journal has been pruned. On a replacement the field tells
  // who wrote the CURRENT value, which is the question one actually asks.
  entry.createdBy = o.by === 'claude' || o.by === 'user' || o.by === 'codex' ? o.by : null;
  entry.kind = detectKind(value);
  entry.hint = hintOf(value);
  entry.length = value.length;
  entry.fingerprint = fingerprint(value);
  entry.isFile = looksLikePrivateKey(value) || /^\{[\s\S]*"private_key"/.test(value);
  entry.ct = seal(entry, value);
  return entry;
}

// Replaces the VALUE and nothing else. put() rebuilds the whole entry from the
// options it is given, so calling it plainly here would silently drop the
// expiry, the use cap, the MCP authorisation and the description — the owner
// would think they had only pasted a new value. The old value is overwritten
// and unrecoverable, which is the point.
function replaceValue(name, value) {
  const v = loadRaw();
  const s = findByName(v, name);
  if (!s) {
    const names = Object.keys(v.secrets).map(id => v.secrets[id].name);
    const e = fail('unknown key: {0}', name);
    e.suggestions = suggest(name, names);
    throw e;
  }
  return put(s.name, value, {
    policy: s.policy,
    expiresAt: s.expiresAt,
    maxUses: s.maxUses,
    mcp: s.mcp,
    mcpServers: s.mcpServers,
    pub: s.pub,
    confirm: s.confirm,
    note: s.note,
    groupId: s.groupId || null,
    groupBy: s.groupBy || null,
    by: 'user'
  });
}

// Renaming is NOT a field assignment. The name is part of the AAD that seals
// the value, so the entry has to be opened under the old name and sealed again
// under the new one. Writing s.name = n and saving would leave a secret nobody
// could ever decrypt again — the tag would never match.
function rename(oldName, newName) {
  const to = validateName(newName);
  const v = loadRaw();
  const s = findByName(v, oldName);
  if (!s) {
    const names = Object.keys(v.secrets).map(id => v.secrets[id].name);
    const e = fail('unknown key: {0}', oldName);
    e.suggestions = suggest(oldName, names);
    throw e;
  }
  const from = s.name;
  if (from === to) return { from, name: to, unchanged: true };
  if (findByName(v, to)) throw fail('a key named {0} already exists', to);
  // A pending replacement is sealed under the OLD name as well. Rather than
  // re-seal a value Claude submitted and the owner has not looked at yet, we
  // ask for that decision first.
  if (v.replace && v.replace[from]) {
    throw fail('a replacement is waiting for {0}: approve or reject it before renaming', from);
  }
  // An MCP request names keys; the user must answer it about the names it was
  // shown with, not about a key that quietly changed name in between.
  if (validMcpRequests(v).some(r => r.names.indexOf(from) !== -1)) {
    throw fail('an MCP access request is waiting for {0}: approve or refuse it before renaming', from);
  }

  const value = open(s);
  s.name = to;
  s.ct = seal(s, value);          // resealed under the new AAD
  audit(v, 'rename', to, from, 'user');
  saveRaw(v, true);
  return { from, name: to };
}

function remove(name) {
  const v = loadRaw();
  const s = findByName(v, name);
  if (!s) return false;
  // Into the bin first: if that write fails, the key is still in the vault
  // rather than nowhere at all.
  trashPut(s);
  // A pending proposal for a key that no longer exists would come back as a
  // NEW key on approval, stripped of its expiry, its limits and its
  // authorisations, and the binned entry would then be unrestorable because
  // the name is taken again.
  if (v.replace && v.replace[s.name]) delete v.replace[s.name];
  dropMcpRequestsFor(v, [s.name]);
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
// servers: undefined or [] means every MCP server, a non-empty list restricts
// the grant to those names. Blanket authorisation was the only option until
// now, so a key needed by one server was exposed to all of them.
// `by` says who changed it: the panel passes nothing ('user'), the bridge and
// the MCP server pass 'claude' or 'codex' once decideGrant() has said yes.
function setMcp(name, allowed, servers, by) {
  setMcpMany([{ name, allowed, servers }], by);
  return !!allowed;
}

function applyMcp(v, s, allowed, servers, by) {
  const list = Array.isArray(servers)
    ? Array.from(new Set(servers.map(x => String(x)).filter(Boolean))).slice(0, 32)
    : [];
  const value = open(s);
  s.mcp = !!allowed;
  s.mcpServers = (allowed && list.length) ? list : null;
  s.ct = seal(s, value);
  audit(v, 'mcp', s.name,
    allowed ? (s.mcpServers ? s.mcpServers.join(',') : 'allowed') : 'removed', actorOf(by) || 'user');
}

// Several keys in one go, all or nothing: every entry is opened BEFORE any is
// re-sealed, so a key that fails to decrypt aborts the batch with nothing
// written, and the whole change costs one structural save instead of one per key.
function setMcpMany(changes, by) {
  const list = Array.isArray(changes) ? changes : [];
  if (!list.length) return [];
  const v = loadRaw();
  const targets = list.map(c => {
    const s = findByName(v, c.name);
    if (!s) {
      const e = fail('unknown key: {0}', c.name);
      e.suggestions = suggest(c.name, Object.keys(v.secrets).map(id => v.secrets[id].name));
      throw e;
    }
    open(s);                         // throws on a tampered entry, before anything moves
    return { s, c };
  });
  for (const t of targets) applyMcp(v, t.s, !!t.c.allowed, t.c.servers, by);
  saveRaw(v, true);
  return targets.map(t => ({ name: t.s.name, mcp: !!t.s.mcp, mcpServers: t.s.mcpServers || null }));
}

// The flag sits in the AAD, so changing it re-seals the entry — the same price
// the MCP authorisation pays, for the same reason.
function setPublic(name, isPublic) {
  const v = loadRaw();
  const s = findByName(v, name);
  if (!s) throw fail('unknown key: {0}', name);
  const value = open(s);
  s.pub = !!isPublic;
  s.ct = seal(s, value);
  audit(v, 'visibility', s.name, isPublic ? 'public' : 'secret', 'user');
  saveRaw(v, true);
  return !!isPublic;
}

// The single place that answers "may this server use this key?", so the proxy
// and the UI can never drift apart on the answer.
function mcpAllows(entry, serverName) {
  if (!entry || !entry.mcp) return false;
  if (!entry.mcpServers || !entry.mcpServers.length) return true;
  return entry.mcpServers.indexOf(String(serverName)) !== -1;
}

// Full revocation: new master key, everything existing becomes unreadable.
// Must work even on a corrupted or tampered vault: that is precisely the
// situation where we want to be able to discard everything. Never go through
// loadRaw() here.
// Takes an explicit token, and this is not ceremony: called with no argument,
// this function destroyed a real vault of eleven keys during a test run that
// meant to hit a throwaway profile. Nothing in the old signature distinguished
// "the user pressed the panic button" from "a script reached this line".
// The UI passes the token; a stray call now throws instead of erasing.
function revokeAll(confirm) {
  if (confirm !== 'REVOKE') {
    throw fail('revokeAll requires its confirmation token: this call would have destroyed every key');
  }
  let n = 0;
  try { n = Object.keys(JSON.parse(fs.readFileSync(VAULT_PATH, 'utf8')).secrets || {}).length; }
  catch (e) { /* vault absent or unreadable: revoke anyway */ }
  try { fs.unlinkSync(VAULT_PATH); } catch (e) { /* already gone */ }
  // Both of these are sealed under the key we are about to throw away. The
  // export file would simply stop decrypting, but the recovery envelope is
  // worse: it holds the OLD key, so restoring from it after a revocation would
  // put back a key that no longer opens anything.
  try { fs.unlinkSync(RECOVERY_PATH); } catch (e) { /* none set up */ }
  try { fs.unlinkSync(RECOVERY_LOG_PATH); } catch (e) { /* no history */ }
  try { fs.unlinkSync(TRASH_PATH); } catch (e) { /* nothing binned */ }
  // Pending MCP requests live inside the vault file just deleted; the layout
  // only names groups and stays, since it holds nothing sealed.
  // The export file itself is left where it is: it may sit on a drive that is
  // not plugged in, and deleting a file the user put somewhere on purpose is
  // not this function's job. It stops being refreshed, and stops opening.
  try { exportForget(); } catch (e) { /* no policy file */ }
  // Read under the old key, signed again under the new one (see resignPolicy).
  let keptPolicy = null;
  try { if (readPolicyFile()) keptPolicy = policy(); } catch (e) { /* safe defaults */ }
  const seq = currentSeq() + 1;
  _master = crypto.randomBytes(32);
  storeKey(_master, seq);
  if (readPolicyFile()) { try { resignPolicy(keptPolicy); } catch (e) { /* safe defaults */ } }
  const v = emptyVault();
  v.seq = seq;
  audit(v, 'revoke-all', null, String(n), 'user');
  saveRaw(v, false);
  try { for (const f of fs.readdirSync(TMP_DIR)) fs.unlinkSync(path.join(TMP_DIR, f)); }
  catch (e) { /* nothing to purge */ }
  return n;
}

// Internal consumption, the ONLY path that returns a plaintext value.
// The write lock is taken twice, around each read-modify-write, and never
// across the confirmation: that wait lasts up to a minute, and holding the lock
// through it would shut every other process out of the vault meanwhile.
function consume(name, who) {
  sweep();
  const first = withVaultLock(() => {
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
    return { name: s.name, confirm: !!s.confirm };
  });
  // Asked BEFORE the counter moves and before anything is decrypted: a refused
  // use must leave no trace beyond the log line.
  const granted = first.confirm ? askUse(first.name, who) : true;
  return withVaultLock(() => consumeLocked(name, who, first.confirm, granted));
}

function consumeLocked(name, who, asked, granted) {
  // Read again in every case: up to a minute may have passed inside askUse(),
  // and the vault is a file other processes write to. Everything read before
  // is stale, so nothing of it is written back over what happened meanwhile.
  const v = loadRaw();
  const s = findByName(v, name);
  if (asked && !granted) {
    if (s) {
      audit(v, 'use-refused', s.name, who || null, 'user');
      saveRaw(v, false);
    }
    throw fail('{0} needs your confirmation for every use, and it was not given', name);
  }
  if (!s) throw fail('unknown key: {0}', name);
  // Switched to "confirm every use" between the two reads: nobody was asked,
  // so the use is refused rather than let through.
  if (s.confirm && !asked) {
    throw fail('{0} needs your confirmation for every use, and it was not given', name);
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
  audit(v, 'use', s.name, who || null, String(who || '').startsWith('codex:') ? 'codex' : 'claude');
  const burned = s.maxUses && s.uses >= s.maxUses;
  if (burned) {
    delete v.secrets[s.id];
    audit(v, 'burn', s.name, null);
  }
  // No re-encryption: uses/lastUsedAt are not part of the per-entry AAD. They
  // are covered by the FILE signature since v2 though, and saveRaw recomputes
  // it below on every call, structural or not — which is what makes the cap and
  // the burn actually enforceable rather than merely displayed.
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
  // One proposal per key. Silently swapping the value of a request the user
  // may be reading right now would let them approve something they never saw.
  if (v.replace[n]) {
    throw fail('a replacement is already waiting for {0}: wait for the user to answer it', n);
  }

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
    return Object.keys(v.replace || {}).map(n => {
      // What the new value would inherit, so the dialog can say "this key is
      // open to MCP" before the user lets someone else's value through.
      const cur = findByName(v, n) || {};
      return {
        name: n, kind: v.replace[n].kind, length: v.replace[n].length,
        note: v.replace[n].note || null, at: v.replace[n].at,
        mcp: !!cur.mcp, mcpServers: (cur.mcpServers && cur.mcpServers.length) ? cur.mcpServers.slice() : null
      };
    });
  } catch (e) { return []; }
}

// `at` is the timestamp the dialog showed: a request replaced in between (the
// AI cannot do that any more, but an older bridge could) is refused rather than
// approved blind. opts.dropMcp lets the user accept the value but not the access.
function approveReplace(name, at, opts) {
  const o = opts || {};
  const n = String(name || '').toUpperCase();
  const v = loadRaw();
  const p = v.replace && v.replace[n];
  if (!p) throw fail('no pending replacement for {0}', n);
  if (at !== undefined && at !== null && Number(at) !== Number(p.at)) {
    throw fail('the request changed after it was shown: nothing was applied');
  }
  const value = open(p);

  // The replacement inherits the lifetime and the authorizations of the key it
  // succeeds. Silently resetting an expiry or an MCP authorization here would
  // be a change nobody asked for.
  // The value was authored by Claude; the approval is the user's own journal
  // line just below. createdBy therefore says 'claude', which answers the
  // question "where does the CURRENT value come from".
  // mcpServers and pub travel with mcp, and forgetting them here was not a
  // cosmetic loss: put() resets an absent mcpServers to null, which turns a
  // grant restricted to one named server into a grant valid for every server —
  // on the one path where the value was authored by Claude. Same story for pub,
  // which put() would re-derive from the new value and so overwrite a choice
  // the user made explicitly.
  const cur = findByName(v, n);
  // Laundering guard: a value that already lives under ANOTHER name would
  // otherwise inherit this key's MCP access, and a key the user never opened to
  // MCP would reach a tool call under a borrowed name. The value goes in, the
  // access does not.
  const owner = fingerprintOwner(v, fingerprint(value), n);
  const dropMcp = !!o.dropMcp || !!owner;
  const putOpts = cur ? {
    policy: cur.policy, expiresAt: cur.expiresAt,
    maxUses: cur.maxUses,
    mcp: dropMcp ? false : cur.mcp, mcpServers: dropMcp ? null : cur.mcpServers,
    pub: cur.pub,
    confirm: cur.confirm,
    note: p.note || cur.note, by: 'claude',
    groupId: cur.groupId || null, groupBy: cur.groupBy || null
  } : { note: p.note, by: 'claude' };

  delete v.replace[n];
  audit(v, 'replace-approved', n, null, 'user');
  saveRaw(v, false);
  const r = put(n, value, putOpts);
  return { name: n, kind: r.kind, mcpDropped: !!(cur && cur.mcp && dropMcp), sameValueAs: owner ? owner.name : null };
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

// ------------------------------------------------------- confirm on every use
//
// Opt in, key by key. The default does not move: you ask Claude, Claude uses the
// key, nobody is interrupted. This exists for the handful of keys where the
// opposite is what you want, a production database, a live payment key.
//
// The awkward part is where the question is born. consume() runs inside a hook,
// a bare node process with no editor to draw a dialog in. So the hook writes the
// request to a file and waits; the extension sees the file, asks the human, and
// writes the answer back. Nobody there, or nobody answering: the use is refused.
// A key guarded this way must fail closed, or the guard is decoration.

const USE_PATH = path.join(VAULT_DIR, 'pending-use.json');
const USE_TTL_MS = 120000;
const USE_WAIT_MS = 55000;                  // under the hook timeout, on purpose

function readUses() {
  try {
    const p = JSON.parse(fs.readFileSync(USE_PATH, 'utf8'));
    return p && typeof p === 'object' ? p : {};
  } catch (e) { return {}; }
}

function pruneUses(all) {
  const cutoff = Date.now() - USE_TTL_MS;
  for (const id of Object.keys(all)) if (!all[id] || all[id].at < cutoff) delete all[id];
  return all;
}

// Waiting requests, for the extension to ask about.
function pendingUses() {
  const all = pruneUses(readUses());
  return Object.keys(all).filter(id => all[id].state === 'wait')
    .map(id => ({ id, name: all[id].name, who: all[id].who || null, at: all[id].at }));
}

function answerUse(id, ok) {
  const all = pruneUses(readUses());
  if (!all[id]) return false;
  all[id].state = ok ? 'ok' : 'no';
  writeAtomic(USE_PATH, JSON.stringify(all));
  return true;
}

// A synchronous wait, because consume() is synchronous and every caller of it is
// a process whose only job right now is this one command.
function sleepSync(ms) {
  try { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms); }
  catch (e) { const t = Date.now(); while (Date.now() - t < ms) { /* spin */ } }
}

function askUse(name, who) {
  ensureDirs();
  const id = crypto.randomUUID();
  const all = pruneUses(readUses());
  all[id] = { id, name, who: who || null, at: Date.now(), state: 'wait' };
  writeAtomic(USE_PATH, JSON.stringify(all));

  const until = Date.now() + USE_WAIT_MS;
  let verdict = false;
  for (;;) {
    const cur = readUses()[id];
    if (!cur || cur.state === 'no') break;
    if (cur.state === 'ok') { verdict = true; break; }
    if (Date.now() > until) break;
    sleepSync(250);
  }
  const after = pruneUses(readUses());
  delete after[id];
  try { writeAtomic(USE_PATH, JSON.stringify(after)); } catch (e) { /* it expires anyway */ }
  return verdict;
}

function setConfirm(name, on) {
  const v = loadRaw();
  const s = findByName(v, name);
  if (!s) throw fail('unknown key: {0}', name);
  const value = open(s);
  s.confirm = !!on;
  s.ct = seal(s, value);
  audit(v, 'confirm', s.name, on ? 'on' : 'off', 'user');
  saveRaw(v, true);
  return !!on;
}

// Local policy, read by add.js which has no access to VSCode settings. Kept in
// the vault directory, so the guard already puts it out of reach of a shell:
// Claude cannot grant itself the permission it is being denied.
const POLICY_PATH = path.join(VAULT_DIR, 'policy.json');
const POLICY_INFO = 'claude-vault-policy-v1';
const MCP_MODES = ['off', 'ask', 'auto'];
const AIS = ['claude', 'codex'];

// The decision fields are signed. A shell cannot reach this file through the
// guard, but "cannot reach" is one layer; the MAC is the second: a policy.json
// edited by hand to switch MCP to automatic simply stops being believed.
// The export fields stay outside the signature on purpose: they say where a
// backup goes, they decide nothing about what an assistant may do.
const POLICY_SAFE = { autoApprove: false, mcpByAI: 'ask', layoutByAI: true };
const POLICY_LOCKED = { autoApprove: false, mcpByAI: 'off', layoutByAI: false };

function readPolicyFile() {
  try {
    const p = JSON.parse(fs.readFileSync(POLICY_PATH, 'utf8'));
    return p && typeof p === 'object' ? p : null;
  } catch (e) { return null; }
}

function cleanOverride(o) {
  const out = {};
  if (!o || typeof o !== 'object') return out;
  if (MCP_MODES.indexOf(o.mcpByAI) !== -1) out.mcpByAI = o.mcpByAI;
  if (typeof o.layoutByAI === 'boolean') out.layoutByAI = o.layoutByAI;
  if (typeof o.autoApprove === 'boolean') out.autoApprove = o.autoApprove;
  return out;
}

function cleanPerAI(p) {
  const out = {};
  if (!p || typeof p !== 'object') return out;
  for (const ai of AIS) {
    const o = cleanOverride(p[ai]);
    if (Object.keys(o).length) out[ai] = o;
  }
  return out;
}

// Canonical form: fixed order, cleaned values, so that the same decision always
// signs to the same bytes whatever order the file happens to hold its keys in.
function policyCanon(d) {
  const per = cleanPerAI(d.perAI);
  return JSON.stringify([
    !!d.autoApprove, d.mcpByAI, !!d.layoutByAI,
    AIS.map(ai => {
      const o = per[ai] || {};
      return [ai, o.autoApprove === undefined ? null : o.autoApprove,
        o.mcpByAI === undefined ? null : o.mcpByAI,
        o.layoutByAI === undefined ? null : o.layoutByAI];
    })
  ]);
}

function policyMac(d) {
  return crypto.createHmac('sha256', derive(POLICY_INFO, Buffer.alloc(0), 32))
    .update(policyCanon(d)).digest('base64');
}

function exportFields(p) {
  return {
    exportPath: (p && typeof p.exportPath === 'string' && p.exportPath) ? p.exportPath : null,
    exportAt: (p && Number(p.exportAt)) || null
  };
}

// Verified read. Three cases, each with its own answer:
//  - no signature at all: a file written before signatures existed. Its
//    decisions are not trusted, they fall back to the safe defaults, and the
//    export location (which decides nothing) is kept;
//  - a signature that does not match: someone edited the decisions. Everything
//    the AI could do is switched off and `tampered` says why;
//  - a signature that matches: the file is believed.
// No master key on disk means nothing could ever have been signed here, and
// creating one just to read a setting is out of the question on a render path.
// Two more cases lock instead of falling back, since a fallback to the safe
// defaults would turn an "off" the user chose into "ask":
//  - a policy was signed here before (the key file says so) and the file is
//    now missing, unreadable or unsigned;
//  - an unsigned file carrying decisions that only exist since signatures do.
function unsignedIsTampered(p) {
  if (policyMarker()) return true;
  return !!p && ('mcpByAI' in p || 'layoutByAI' in p || 'perAI' in p);
}

function policy() {
  const p = readPolicyFile();
  const exp = exportFields(p);
  const base = Object.assign({}, POLICY_SAFE, { perAI: {}, tampered: false }, exp);
  if (!fs.existsSync(KEY_PATH)) return base;
  if (!p || !p.mac) {
    return unsignedIsTampered(p)
      ? Object.assign({}, POLICY_LOCKED, { perAI: {}, tampered: true }, exp)
      : base;
  }
  const d = {
    autoApprove: !!p.autoApprove,
    mcpByAI: MCP_MODES.indexOf(p.mcpByAI) !== -1 ? p.mcpByAI : 'ask',
    layoutByAI: typeof p.layoutByAI === 'boolean' ? p.layoutByAI : true,
    perAI: cleanPerAI(p.perAI)
  };
  let good = false;
  try { good = equalCT(String(p.mac), policyMac(d)); } catch (e) { return base; }
  if (!good) return Object.assign({}, POLICY_LOCKED, { perAI: {}, tampered: true }, exp);
  return Object.assign({}, d, { tampered: false }, exp);
}

// The effective rules for one assistant: its override where it has one, the
// shared setting otherwise.
function policyFor(ai) {
  const p = policy();
  const o = (p.perAI && p.perAI[ai]) || {};
  return {
    autoApprove: o.autoApprove !== undefined ? o.autoApprove : p.autoApprove,
    mcpByAI: o.mcpByAI !== undefined ? o.mcpByAI : p.mcpByAI,
    layoutByAI: o.layoutByAI !== undefined ? o.layoutByAI : p.layoutByAI,
    tampered: !!p.tampered
  };
}

// UNVERIFIED, for display only (the panel line, the SessionStart text). Never
// touches the master key, so it costs nothing on a hot path; nothing that
// decides anything may read it.
function policyFast(ai) {
  const raw = readPolicyFile();
  const p = raw || {};
  const top = {
    mcpByAI: MCP_MODES.indexOf(p.mcpByAI) !== -1 ? p.mcpByAI : 'ask',
    layoutByAI: typeof p.layoutByAI === 'boolean' ? p.layoutByAI : true
  };
  // Same reading as policy(), so the panel line never shows "ask" where the
  // verified read has locked everything.
  if (!p.mac) {
    return fs.existsSync(KEY_PATH) && unsignedIsTampered(raw)
      ? { mcpByAI: POLICY_LOCKED.mcpByAI, layoutByAI: POLICY_LOCKED.layoutByAI }
      : { mcpByAI: 'ask', layoutByAI: true };
  }
  const o = (ai && cleanPerAI(p.perAI)[ai]) || {};
  return {
    mcpByAI: o.mcpByAI !== undefined ? o.mcpByAI : top.mcpByAI,
    layoutByAI: o.layoutByAI !== undefined ? o.layoutByAI : top.layoutByAI
  };
}

// MERGES what it is given into the current policy and signs the result. It
// used to rebuild the file from its argument alone, so a caller that only
// meant to switch auto approval off also erased the backup location.
// An invalid value keeps the current one; an explicit null on an export field
// clears it (exportForget); perAI[ai] = null removes that override.
function setPolicy(patch) {
  const o = patch || {};
  const cur = policy();
  const next = {
    autoApprove: cur.autoApprove, mcpByAI: cur.mcpByAI, layoutByAI: cur.layoutByAI,
    perAI: JSON.parse(JSON.stringify(cur.perAI || {}))
  };
  if (typeof o.autoApprove === 'boolean') next.autoApprove = o.autoApprove;
  if (MCP_MODES.indexOf(o.mcpByAI) !== -1) next.mcpByAI = o.mcpByAI;
  if (typeof o.layoutByAI === 'boolean') next.layoutByAI = o.layoutByAI;
  if (o.perAI && typeof o.perAI === 'object') {
    for (const ai of AIS) {
      if (!(ai in o.perAI)) continue;
      const given = o.perAI[ai];
      if (given === null) { delete next.perAI[ai]; continue; }
      if (!given || typeof given !== 'object') continue;
      const merged = Object.assign({}, next.perAI[ai] || {});
      for (const k of ['autoApprove', 'mcpByAI', 'layoutByAI']) {
        if (given[k] === null) delete merged[k];
      }
      Object.assign(merged, cleanOverride(given));
      if (Object.keys(merged).length) next.perAI[ai] = merged; else delete next.perAI[ai];
    }
  }
  const exp = { exportPath: cur.exportPath, exportAt: cur.exportAt };
  if ('exportPath' in o) exp.exportPath = (typeof o.exportPath === 'string' && o.exportPath) ? o.exportPath : null;
  if ('exportAt' in o) exp.exportAt = Number(o.exportAt) || null;
  ensureDirs();
  next.perAI = cleanPerAI(next.perAI);
  writeAtomic(POLICY_PATH, JSON.stringify(Object.assign({}, next, exp, {
    at: Date.now(), mac: policyMac(next)
  })));
  // After the file, never before: a marker without a signed file beside it
  // would lock every AI permission for nothing.
  markPolicySigned();
  // The settings travel in the export, so the export follows them.
  if (exp.exportPath) { try { exportRefresh(); } catch (e) { /* reported by the panel */ } }
  return policy();
}

// The master key changes in two places (revocation, import with a phrase), and
// a policy signed under the old one would read as tampered afterwards: every
// AI permission would switch off for a reason the user cannot see. The caller
// reads the decisions while the old key still verifies them, and they are
// signed again under the new one.
function resignPolicy(d) {
  if (!d || d.tampered) d = Object.assign({}, POLICY_SAFE, { perAI: {} });
  const next = {
    autoApprove: !!d.autoApprove,
    mcpByAI: MCP_MODES.indexOf(d.mcpByAI) !== -1 ? d.mcpByAI : 'ask',
    layoutByAI: typeof d.layoutByAI === 'boolean' ? d.layoutByAI : true,
    perAI: cleanPerAI(d.perAI)
  };
  const exp = exportFields(readPolicyFile());
  ensureDirs();
  writeAtomic(POLICY_PATH, JSON.stringify(Object.assign({}, next, exp, {
    at: Date.now(), mac: policyMac(next)
  })));
  markPolicySigned();
}

// A file written by 1.1, where automatic replacement approval was on. Its
// decisions are unsigned, so they are not believed, and re-signing them on
// our own would turn a file anyone could have written into a real permission.
// The extension asks the user once instead; either answer signs the file, so
// the question never comes back.
function legacyAutoApprove() {
  const p = readPolicyFile();
  if (!p || p.mac || p.autoApprove !== true) return false;
  if ('mcpByAI' in p || 'layoutByAI' in p || 'perAI' in p) return false;
  return !policyMarker();
}

// Export bookkeeping only. Kept off the signed path on purpose: it runs after
// every structural save, and the location of a backup decides nothing.
function setExportFields(fields) {
  const p = readPolicyFile() || {};
  const exp = exportFields(p);
  if ('exportPath' in fields) exp.exportPath = fields.exportPath || null;
  if ('exportAt' in fields) exp.exportAt = Number(fields.exportAt) || null;
  ensureDirs();
  writeAtomic(POLICY_PATH, JSON.stringify(Object.assign({}, p, exp, { at: Date.now() })));
}

// Defaults for a new key. They lived in VS Code's own state, which the export
// cannot reach: a restored vault came back without them. Mirrored here so they
// travel with everything else, and so the file stays the single place that
// answers "what is this vault's configuration".
const DEFAULTS_PATH = path.join(VAULT_DIR, 'defaults.json');

function uiDefaults() {
  try {
    const d = JSON.parse(fs.readFileSync(DEFAULTS_PATH, 'utf8'));
    return {
      ttlMs: typeof d.ttlMs === 'number' ? d.ttlMs : 0,
      burn: !!d.burn,
      mcp: !!d.mcp,
      set: true
    };
  } catch (e) { return { ttlMs: 0, burn: false, mcp: false, set: false }; }
}

function setUiDefaults(o) {
  ensureDirs();
  writeAtomic(DEFAULTS_PATH, JSON.stringify({
    ttlMs: Number(o && o.ttlMs) || 0, burn: !!(o && o.burn), mcp: !!(o && o.mcp)
  }));
  return uiDefaults();
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

// ------------------------------------------------------------ groups and layout
//
// Folders in a sidebar, nothing more. Groups and separators are objects of
// their own, ordered, and they exist empty as well as filled. A key points to
// its group by id (entry.groupId), so renaming a group touches one line of the
// layout and no key at all.
//
// The layout is display, not security: it lives beside the vault in its own
// unsigned file, and the worst a forged one can do is show a key under the
// wrong heading. Every change is still journaled with its author, because a
// list that reorganises itself with nobody to blame is a list nobody trusts.

const LAYOUT_PATH = path.join(VAULT_DIR, 'layout.json');
const GROUP_MAX = 40;
const SEP_MAX = 60;
const LAYOUT_MAX = 500;

function actorOf(by) {
  return by === 'user' || by === 'claude' || by === 'codex' ? by : null;
}

function isAI(by) { return by === 'claude' || by === 'codex'; }

// Letters, digits, space and . _ & + - only. Anything else is dropped rather
// than refused, the same forgiving rule as key names.
function normalizeGroupName(s) {
  if (s == null) return null;
  const kept = Array.from(String(s).replace(/\s+/g, ' '))
    .filter(ch => /[\p{L}\p{N} ._&+-]/u.test(ch)).join('');
  const n = kept.replace(/ {2,}/g, ' ').trim().slice(0, GROUP_MAX).trim();
  return n || null;
}

function cleanLabel(s) {
  if (s == null) return null;
  const n = String(s).replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ')
    .trim().slice(0, SEP_MAX).trim();
  return n || null;
}

function cleanItems(items) {
  if (!Array.isArray(items)) return [];
  const out = [];
  const ids = new Set();
  const names = new Set();
  for (const it of items) {
    if (out.length >= LAYOUT_MAX) break;
    if (!it || typeof it !== 'object' || typeof it.id !== 'string' || !it.id ||
        it.id.length > 64 || ids.has(it.id)) continue;
    if (it.type === 'group') {
      const name = normalizeGroupName(it.name);
      if (!name || names.has(name.toLowerCase())) continue;
      names.add(name.toLowerCase());
      ids.add(it.id);
      out.push({ type: 'group', id: it.id, name, collapsed: !!it.collapsed });
    } else if (it.type === 'separator') {
      ids.add(it.id);
      out.push({ type: 'separator', id: it.id, label: cleanLabel(it.label) });
    }
  }
  return out;
}

function readLayout() {
  try {
    const l = JSON.parse(fs.readFileSync(LAYOUT_PATH, 'utf8'));
    return { v: 1, items: cleanItems(l && l.items), at: Number(l && l.at) || 0 };
  } catch (e) { return { v: 1, items: [], at: 0 }; }
}

function writeLayout(items) {
  const clean = cleanItems(items);
  writeAtomic(LAYOUT_PATH, JSON.stringify({ v: 1, items: clean, at: Date.now() }));
  return clean;
}

function layout() {
  return readLayout().items.map(i => Object.assign({}, i));
}

function groupIndex() {
  const m = new Map();
  for (const i of readLayout().items) if (i.type === 'group') m.set(i.id, i.name);
  return m;
}

// A groupId pointing to a deleted group counts as ungrouped, everywhere.
function groupFields(s, idx) {
  const name = s && s.groupId ? idx.get(s.groupId) : null;
  return {
    groupId: name ? s.groupId : null,
    groupBy: name ? (s.groupBy || null) : null,
    group: name || null
  };
}

function findGroup(nameOrId) {
  if (nameOrId == null) return null;
  const items = readLayout().items;
  const raw = String(nameOrId);
  const byId = items.find(i => i.type === 'group' && i.id === raw);
  if (byId) return Object.assign({}, byId);
  const n = normalizeGroupName(raw);
  if (!n) return null;
  const hit = items.find(i => i.type === 'group' && i.name.toLowerCase() === n.toLowerCase());
  return hit ? Object.assign({}, hit) : null;
}

// A group by name or id, a separator by id or by its label when that label is
// unique, or any item by its position written "@3" (counted from 1 at the top,
// as list.js --groups prints it). The position is what makes a plain separator,
// or one of two separators with the same label, addressable at all.
const POSITION_RE = /^@(\d{1,4})$/;

function findItem(nameOrId) {
  const raw = String(nameOrId == null ? '' : nameOrId).trim();
  const items = readLayout().items;
  const pos = POSITION_RE.exec(raw);
  if (pos) {
    const it = items[Number(pos[1]) - 1];
    return it ? Object.assign({}, it) : null;
  }
  const g = findGroup(nameOrId);
  if (g) return g;
  const byId = items.find(i => i.id === raw);
  if (byId) return Object.assign({}, byId);
  const lab = cleanLabel(raw);
  if (!lab) return null;
  const hits = items.filter(i => i.type === 'separator' && i.label && i.label.toLowerCase() === lab.toLowerCase());
  return hits.length === 1 ? Object.assign({}, hits[0]) : null;
}

// The user's "the AI may not reorganise my keys" switch, enforced HERE rather
// than in each script, so the bridge and the MCP server cannot drift apart.
function layoutGate(by) {
  if (isAI(by) && !policyFor(by).layoutByAI) {
    throw fail('the user does not let the AI reorganise the keys: ask them to do it in the Claude Vault view');
  }
}

function clampIndex(at, len) {
  if (at === undefined || at === null || at === '' || !isFinite(Number(at))) return len;
  return Math.max(0, Math.min(len, Math.trunc(Number(at))));
}

// The layout is part of the export, so a change made here should reach the
// backup like any key change does. Never allowed to fail the change itself.
function refreshAfterLayout() {
  try { exportRefresh(); } catch (e) { /* reported by the panel */ }
}

// Order of operations matters: the vault is read FIRST, so an unreadable vault
// stops the change before the layout file moves, and the journal line is never
// missing for a change that happened.
function commitLayout(items, event, name, detail, by) {
  const v = loadRaw();
  const clean = writeLayout(items);
  audit(v, event, name, detail, actorOf(by) || 'user');
  saveRaw(v, false);
  refreshAfterLayout();
  return clean;
}

// "none" is how the journal used to say "out of any group", and older entries
// still say it that way: a group of that name would read as an ungrouping.
function refuseReservedGroup(n) {
  if (n.toLowerCase() === 'none') throw fail('invalid group name: {0} is reserved', n);
}

function createGroup(name, at, by) {
  layoutGate(by);
  const n = normalizeGroupName(name);
  if (!n) throw fail('invalid group name: use letters, digits, spaces and . _ & + - (40 characters at most)');
  refuseReservedGroup(n);
  const items = readLayout().items;
  if (items.some(i => i.type === 'group' && i.name.toLowerCase() === n.toLowerCase())) {
    throw fail('a group named {0} already exists', n);
  }
  if (items.length >= LAYOUT_MAX) throw fail('too many groups and separators');
  const item = { type: 'group', id: crypto.randomUUID(), name: n, collapsed: false };
  items.splice(clampIndex(at, items.length), 0, item);
  commitLayout(items, 'group-create', n, null, by);
  return Object.assign({}, item);
}

function renameGroup(nameOrId, newName, by) {
  layoutGate(by);
  const g = findGroup(nameOrId);
  if (!g) throw fail('unknown group: {0}', String(nameOrId));
  const n = normalizeGroupName(newName);
  if (!n) throw fail('invalid group name: use letters, digits, spaces and . _ & + - (40 characters at most)');
  refuseReservedGroup(n);
  const items = readLayout().items;
  if (items.some(i => i.type === 'group' && i.id !== g.id && i.name.toLowerCase() === n.toLowerCase())) {
    throw fail('a group named {0} already exists', n);
  }
  if (n === g.name) return { id: g.id, name: n, from: g.name, unchanged: true };
  for (const i of items) if (i.id === g.id) i.name = n;
  commitLayout(items, 'group-rename', n, g.name, by);
  return { id: g.id, name: n, from: g.name };
}

// Its keys become ungrouped, never deleted: a group is a heading, and taking a
// heading away must not take anything under it.
function deleteGroup(nameOrId, by) {
  layoutGate(by);
  const g = findGroup(nameOrId);
  if (!g) throw fail('unknown group: {0}', String(nameOrId));
  const v = loadRaw();
  let n = 0;
  for (const id of Object.keys(v.secrets)) {
    const s = v.secrets[id];
    if (s.groupId === g.id) { s.groupId = null; s.groupBy = null; n++; }
  }
  writeLayout(readLayout().items.filter(i => i.id !== g.id));
  audit(v, 'group-delete', g.name, String(n), actorOf(by) || 'user');
  saveRaw(v, false);
  refreshAfterLayout();
  return { name: g.name, keys: n };
}

function addSeparator(label, at, by) {
  layoutGate(by);
  const items = readLayout().items;
  if (items.length >= LAYOUT_MAX) throw fail('too many groups and separators');
  const item = { type: 'separator', id: crypto.randomUUID(), label: cleanLabel(label) };
  items.splice(clampIndex(at, items.length), 0, item);
  commitLayout(items, 'separator-add', null, item.label, by);
  return Object.assign({}, item);
}

function findSeparator(idOrLabel) {
  const it = findItem(idOrLabel);
  return it && it.type === 'separator' ? it : null;
}

function editSeparator(id, label, by) {
  layoutGate(by);
  const sep = findSeparator(id);
  if (!sep) throw fail('unknown separator: {0}', String(id));
  const lab = cleanLabel(label);
  const items = readLayout().items;
  for (const i of items) if (i.id === sep.id) i.label = lab;
  commitLayout(items, 'separator-edit', null, lab, by);
  return { id: sep.id, label: lab };
}

function removeSeparator(id, by) {
  layoutGate(by);
  const sep = findSeparator(id);
  if (!sep) throw fail('unknown separator: {0}', String(id));
  commitLayout(readLayout().items.filter(i => i.id !== sep.id), 'separator-remove', null, sep.label, by);
  return { id: sep.id, label: sep.label };
}

// toIndex counts groups and separators from 0, after the item has been taken
// out: moving to 0 puts it at the top, to the length (or beyond) at the end.
function moveItem(nameOrId, toIndex, by) {
  layoutGate(by);
  const it = findItem(nameOrId);
  if (!it) throw fail('unknown group or separator: {0}', String(nameOrId));
  const items = readLayout().items.filter(i => i.id !== it.id);
  const at = clampIndex(toIndex, items.length);
  const cur = readLayout().items.findIndex(i => i.id === it.id);
  if (cur === at) return { id: it.id, index: at, unchanged: true };
  items.splice(at, 0, readLayout().items.find(i => i.id === it.id));
  commitLayout(items, 'layout-move',
    it.type === 'group' ? it.name : (it.label || '---'), String(at), by);
  return { id: it.id, index: at };
}

// Folding is the user's view of the list, not a decision: no journal line and
// no backup refresh for every click on a header.
function setCollapsed(nameOrId, collapsed) {
  const g = findGroup(nameOrId);
  if (!g) throw fail('unknown group: {0}', String(nameOrId));
  const items = readLayout().items;
  for (const i of items) if (i.id === g.id) i.collapsed = !!collapsed;
  writeLayout(items);
  return !!collapsed;
}

function setAllCollapsed(collapsed) {
  const items = readLayout().items;
  for (const i of items) if (i.type === 'group') i.collapsed = !!collapsed;
  writeLayout(items);
  return items.filter(i => i.type === 'group').length;
}

// Places keys in a group (or takes them out with null). Every key is checked
// before anything moves, so a typo in the fifth name leaves the first four
// where they were. opts.create builds a missing group on the fly, which is
// itself a journaled layout change.
function setKeyGroup(names, target, by, opts) {
  const o = opts || {};
  layoutGate(by);
  const list = Array.from(new Set((Array.isArray(names) ? names : [names])
    .map(x => normalizeName(x)).filter(Boolean)));
  if (!list.length) throw fail('name at least one key');
  let v = loadRaw();
  for (const n of list) {
    if (!findByName(v, n)) {
      const e = fail('unknown key: {0}', n);
      e.suggestions = suggest(n, Object.keys(v.secrets).map(id => v.secrets[id].name));
      throw e;
    }
  }
  let g = null;
  let created = false;
  if (target !== null && target !== undefined && target !== '') {
    g = findGroup(target);
    if (!g) {
      if (!o.create) throw fail('unknown group: {0}', String(target));
      g = createGroup(target, undefined, by);
      created = true;
      v = loadRaw();               // createGroup saved the vault (journal line)
    }
  }
  const who = actorOf(by) || 'user';
  const done = [];
  for (const n of list) {
    const s = findByName(v, n);
    s.groupId = g ? g.id : null;
    s.groupBy = g ? who : null;
    // No detail at all for an ungrouping, so no group name can ever be
    // mistaken for one (entries written before this say 'none').
    audit(v, 'group', s.name, g ? g.name : null, who);
    done.push(s.name);
  }
  saveRaw(v, false);
  refreshAfterLayout();
  return { group: g ? g.name : null, groupId: g ? g.id : null, names: done, created };
}

// ------------------------------------------------------- group suggestions
//
// Proposals, never applied on their own: the user (or the AI, through set.js)
// decides. The rules aim at what a person would do by hand: a rotated copy
// belongs with the key it replaces, BO_DEV_* and BO_PROD_* are two different
// things even though they share a prefix, and CLOUDLFARE is a typo of
// CLOUDFLARE, not a third provider.

const ENV_TOKENS = ['DEV', 'PROD', 'PRD', 'STAGING', 'STG', 'PREPROD', 'TEST', 'QA', 'UAT', 'LOCAL', 'SANDBOX'];
const ROTATION_RE = /_(\d{4})(?:_(\d{2}))?(?:_(\d{2}))?$/;

// KEY_2026_10 -> KEY. Only a plausible date counts: KEY_1234 is a name, not a
// rotation.
function stripRotation(name) {
  const s = String(name || '');
  const m = ROTATION_RE.exec(s);
  if (!m) return s;
  const y = Number(m[1]);
  if (y < 1990 || y > 2199) return s;
  if (m[2] && (Number(m[2]) < 1 || Number(m[2]) > 12)) return s;
  if (m[3] && (Number(m[3]) < 1 || Number(m[3]) > 31)) return s;
  return s.slice(0, m.index) || s;
}

// The base name when `name` is a dated copy of a key that still exists.
function rotationOf(name, names) {
  const s = String(name || '');
  const base = stripRotation(s);
  if (base === s) return null;
  return (names || []).indexOf(base) !== -1 ? base : null;
}

// Optimal string alignment distance: a swapped pair of letters counts as one
// edit, which is the commonest typo of all (CLOUDLFARE).
function editDistance(a, b) {
  const d = [];
  for (let i = 0; i <= a.length; i++) { d[i] = [i]; }
  for (let j = 0; j <= b.length; j++) d[0][j] = j;
  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + cost);
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) {
        d[i][j] = Math.min(d[i][j], d[i - 2][j - 2] + 1);
      }
    }
  }
  return d[a.length][b.length];
}

function suggestGroups() {
  const keys = listFast().filter(s => !s.expired && !s.groupId);
  const buckets = new Map();
  for (const s of keys) {
    const tokens = stripRotation(s.name).split('_').filter(Boolean);
    if (!tokens.length) continue;
    const prefix = tokens[0];
    const env = tokens.slice(1).find(t => ENV_TOKENS.indexOf(t) !== -1) || null;
    const k = prefix + (env ? ' ' + env : '');
    if (!buckets.has(k)) buckets.set(k, { prefix, env, names: [], typo: [], merged: false });
    buckets.get(k).names.push(s.name);
  }
  // The bigger bucket wins a near spelling: two CLOUDFLARE keys and one
  // CLOUDLFARE key make one CLOUDFLARE group with the odd one flagged.
  const arr = Array.from(buckets.values())
    .sort((a, b) => b.names.length - a.names.length || a.prefix.localeCompare(b.prefix));
  for (let i = 0; i < arr.length; i++) {
    const a = arr[i];
    if (a.merged || a.prefix.length < 6) continue;
    for (let j = i + 1; j < arr.length; j++) {
      const b = arr[j];
      if (b.merged || b.env !== a.env || b.prefix.length < 6 || b.prefix === a.prefix) continue;
      if (editDistance(a.prefix, b.prefix) !== 1) continue;
      a.names = a.names.concat(b.names);
      a.typo = a.typo.concat(b.names);
      b.merged = true;
    }
  }
  const out = [];
  for (const b of arr) {
    if (b.merged || b.names.length < 2) continue;
    const name = b.prefix + (b.env ? ' ' + b.env : '');
    const existing = findGroup(name);
    out.push({
      group: existing ? existing.name : name,
      groupId: existing ? existing.id : null,
      names: b.names.sort(),
      typo: b.typo.sort()
    });
  }
  return out.sort((x, y) => x.group.localeCompare(y.group));
}

// ------------------------------------------------------- MCP access by the AI
//
// Who may open a key to MCP, and when the user has to be asked. The bridge
// scripts and the MCP server never decide this themselves: they describe the
// change and decideGrant() answers, so Claude and ChatGPT live under exactly
// the same rules.

const VAULT_MCP_SERVER = 'claude-monitor-vault';
const CLAUDE_JSON_PATH = path.join(os.homedir(), '.claude.json');

function readJsonQuiet(file) {
  try {
    let txt = fs.readFileSync(file, 'utf8');
    if (txt.charCodeAt(0) === 0xFEFF) txt = txt.slice(1);
    const o = JSON.parse(txt);
    return o && typeof o === 'object' ? o : null;
  } catch (e) { return null; }
}

// Every MCP server Claude Code knows about, with what matters to a grant: how
// it is reached, and whether a value would travel through the vault proxy
// (a local process we launched) or through a tool call to somewhere else.
// `hash` fingerprints the definition so an approval can tell that the server
// it was shown is still the one it would open the key to. Read only, never
// throws: a broken config means fewer known servers, not a broken vault.
function mcpServerInfo(cwd) {
  const defs = {};
  const scopes = {};
  const add = (servers, scope) => {
    if (!servers || typeof servers !== 'object') return;
    for (const id of Object.keys(servers)) {
      const def = servers[id];
      if (!def || typeof def !== 'object' || !/^[A-Za-z0-9._-]{1,64}$/.test(id)) continue;
      (defs[id] = defs[id] || []).push(def);
      (scopes[id] = scopes[id] || []).indexOf(scope) === -1 && scopes[id].push(scope);
    }
  };
  try {
    const cj = readJsonQuiet(CLAUDE_JSON_PATH);
    if (cj) {
      add(cj.mcpServers, 'user');
      if (cj.projects && typeof cj.projects === 'object') {
        for (const p of Object.keys(cj.projects)) {
          if (cj.projects[p]) add(cj.projects[p].mcpServers, 'local');
        }
      }
    }
    if (cwd) {
      const pj = readJsonQuiet(path.join(String(cwd), '.mcp.json'));
      if (pj) add(pj.mcpServers, 'project');
    }
  } catch (e) { /* fewer servers known, never an error */ }

  const out = {};
  for (const id of Object.keys(defs)) {
    let transport = 'stdio';
    let wrapped = true;
    for (const def of defs[id]) {
      const t = String(def.type || '').toLowerCase();
      const tr = (t === 'http' || t === 'streamable-http') ? 'http'
        : t === 'sse' ? 'sse'
          : (def.url && !def.command) ? 'http' : 'stdio';
      const args = Array.isArray(def.args) ? def.args.map(String) : [];
      // Our own vault server never passes a value through a tool call either:
      // it hands it to a child process environment, inside the same machine.
      const w = tr === 'stdio' && (args.some(a => /(^|[\\/])mcp-proxy\.js$/i.test(a)) ||
        (id === VAULT_MCP_SERVER && args.some(a => /(^|[\\/])mcp-server\.js$/i.test(a))));
      if (tr !== 'stdio') transport = tr;
      if (!w) wrapped = false;
    }
    if (transport !== 'stdio') wrapped = false;
    const blob = defs[id].map(d => JSON.stringify(d)).sort().join('\n');
    out[id] = {
      scope: scopes[id].join(','), transport, wrapped,
      def: defs[id][0],
      hash: crypto.createHash('sha256').update(blob).digest('hex').slice(0, 16)
    };
  }
  // ChatGPT reaches keys through this server, which is configured on the Codex
  // side (its own config file), not in Claude's. Always known, so a grant to it
  // can be decided; local by construction.
  if (!out[VAULT_MCP_SERVER]) {
    out[VAULT_MCP_SERVER] = {
      scope: 'builtin', transport: 'stdio', wrapped: true, def: null,
      hash: crypto.createHash('sha256').update('builtin:' + VAULT_MCP_SERVER).digest('hex').slice(0, 16)
    };
  }
  return out;
}

// "server1, server2" (or an array) -> a clean, deduplicated list. An empty list
// is an error and NEVER means "every server": a slip of the keyboard must not
// widen a grant.
function parseServerList(str) {
  const parts = (Array.isArray(str) ? str : String(str == null ? '' : str).split(','))
    .map(s => String(s == null ? '' : s).trim()).filter(Boolean);
  const out = Array.from(new Set(parts));
  if (!out.length) throw fail('name at least one server, or use --mcp alone');
  for (const s of out) {
    if (!/^[A-Za-z0-9._-]{1,64}$/.test(s)) throw fail('invalid MCP server name: {0}', s);
  }
  if (out.length > 32) throw fail('32 MCP servers at most');
  return out;
}

// True when the new access is no wider than the current one: a removal, the
// same scope, or a subset of the named servers. Applies without asking.
function isNarrowing(entry, allowed, servers) {
  if (!allowed) return true;
  if (!entry || !entry.mcp) return false;
  const cur = (entry.mcpServers && entry.mcpServers.length) ? entry.mcpServers : null;
  const next = (Array.isArray(servers) && servers.length) ? servers : null;
  if (!cur) return true;
  if (!next) return false;
  return next.every(s => cur.indexOf(s) !== -1);
}

// The whole rule book, in one place, in the order it is applied:
//   off                         -> refuse
//   removal / narrowing         -> apply
//   a named server nobody knows -> refuse (probably a typo; the known ids are listed)
//   a "confirm every use" key   -> ask
//   every server, or a server not behind the vault proxy -> ask
//   ask: at creation -> apply, on an existing key -> ask
//   auto                        -> apply
function decideGrant(o) {
  const a = o || {};
  const entries = Array.isArray(a.entries) ? a.entries.filter(Boolean) : [];
  const allow = a.allow === undefined ? true : !!a.allow;
  const servers = Array.isArray(a.servers) ? a.servers : null;
  const info = a.info || {};
  const mode = MCP_MODES.indexOf(a.mode) !== -1 ? a.mode : 'off';
  if (mode === 'off') {
    return { action: 'refuse', why: 'the user does not let the AI change MCP access (setting: off)' };
  }
  if (!allow) return { action: 'apply', why: 'removing MCP access never needs the user' };
  if (!a.creation && entries.length && entries.every(e => isNarrowing(e, true, servers))) {
    return { action: 'apply', why: 'narrowing MCP access never needs the user' };
  }
  if (servers) {
    const unknown = servers.filter(s => !info[s]);
    if (unknown.length) {
      return {
        action: 'refuse',
        why: 'unknown MCP server: ' + unknown.join(', ') + '. Known servers: ' +
          (Object.keys(info).sort().join(', ') || 'none')
      };
    }
  }
  if (entries.some(e => e.confirm)) {
    return { action: 'request', why: 'a key marked "confirm every use" always needs the user' };
  }
  if (!servers) return { action: 'request', why: 'access for every MCP server always needs the user' };
  const remote = servers.filter(s => !(info[s].transport === 'stdio' && info[s].wrapped));
  if (remote.length) {
    return { action: 'request', why: 'not a local server behind the vault proxy: ' + remote.join(', ') };
  }
  if (mode === 'ask') {
    return a.creation
      ? { action: 'apply', why: 'a new key on named local servers (setting: ask)' }
      : { action: 'request', why: 'widening access on an existing key asks the user (setting: ask)' };
  }
  return { action: 'apply', why: 'automatic MCP setting' };
}

// Who already holds this value, live or in the bin. Fingerprints only: nothing
// is decrypted to answer.
function fingerprintOwner(v, fp, exceptName) {
  if (!fp) return null;
  for (const id of Object.keys(v.secrets || {})) {
    const s = v.secrets[id];
    if (s.fingerprint === fp && s.name !== exceptName) return { name: s.name, binned: false };
  }
  for (const i of readTrash()) {
    if (i.fingerprint === fp && i.name !== exceptName) return { name: i.name, binned: true };
  }
  return null;
}

// The AI is refused a second name for a value the vault already holds: a copy
// is a way around the access the user gave (or did not give) to the first one.
function fingerprintTaken(value, exceptName) {
  if (typeof value !== 'string' || !value.length) return null;
  const v = loadRaw();
  const r = fingerprintOwner(v, fingerprint(value), exceptName ? normalizeName(exceptName) : null);
  return r ? r.name : null;
}

// ------------------------------------------------------- MCP access requests
//
// When decideGrant() says "ask", the request is parked inside the vault file
// and the extension shows ONE window: who asks, which keys, which servers, and
// why. One request at a time, vault-wide, so the user never approves a pile
// of things at once. Each request carries its own MAC: a request typed into
// the file by hand is ignored and dropped, it can never reach the dialog.
//
// The approval applies exactly what the window showed. If the keys, their
// values or the server definitions changed in between, nothing is applied.

const MCPREQ_INFO = 'claude-vault-mcpreq-v1';
const MCPREQ_TTL_MS = 900000;   // 15 min, like a replacement
const REASON_MAX = 200;

function mcpReqCanon(r) {
  const srv = r.srv && typeof r.srv === 'object' ? r.srv : {};
  return JSON.stringify([
    r.rid, r.names, r.entryIds, r.fps, !!r.allow, r.servers || null, r.reason, r.by, r.at,
    Object.keys(srv).sort().map(k => [k, srv[k]]), r.cwd || null
  ]);
}

function mcpReqMac(r) {
  return crypto.createHmac('sha256', derive(MCPREQ_INFO, Buffer.alloc(0), 32))
    .update(mcpReqCanon(r)).digest('base64');
}

function validMcpRequests(v) {
  const now = Date.now();
  const out = [];
  for (const rid of Object.keys((v && v.mcpReq) || {})) {
    const r = v.mcpReq[rid];
    if (!r || r.rid !== rid || !Array.isArray(r.names) || !Array.isArray(r.entryIds) ||
        !Array.isArray(r.fps) || r.names.length !== r.entryIds.length) continue;
    if ((Number(r.at) || 0) + MCPREQ_TTL_MS < now) continue;
    let ok = false;
    try { ok = equalCT(String(r.mac || ''), mcpReqMac(r)); } catch (e) { ok = false; }
    if (ok) out.push(r);
  }
  return out;
}

function pruneMcpRequests(v) {
  if (!v.mcpReq) return;
  const keep = new Set(validMcpRequests(v).map(r => r.rid));
  for (const rid of Object.keys(v.mcpReq)) if (!keep.has(rid)) delete v.mcpReq[rid];
  if (!Object.keys(v.mcpReq).length) delete v.mcpReq;
}

// A request dropped without an answer leaves a journal line carrying its id,
// so the script waiting on it learns at once that nothing is waiting any more.
function withdrawMcpRequest(v, rid) {
  const r = v.mcpReq && v.mcpReq[rid];
  if (!r) return;
  delete v.mcpReq[rid];
  audit(v, 'mcp-withdrawn', r && Array.isArray(r.names) ? r.names.join(',') : null, rid, null);
}

function dropMcpRequestsFor(v, names) {
  if (!v.mcpReq) return;
  for (const rid of Object.keys(v.mcpReq)) {
    const r = v.mcpReq[rid];
    if (!r || !Array.isArray(r.names) || r.names.some(n => names.indexOf(n) !== -1)) withdrawMcpRequest(v, rid);
  }
  if (!Object.keys(v.mcpReq).length) delete v.mcpReq;
}

function cleanReason(reason) {
  return String(reason == null ? '' : reason).replace(/\s+/g, ' ').trim().slice(0, REASON_MAX);
}

function publicRequest(r) {
  return {
    rid: r.rid, names: r.names.slice(), servers: r.servers ? r.servers.slice() : null,
    reason: r.reason, by: r.by, at: r.at
  };
}

// `cwd` is where the requester runs: it decides which .mcp.json counts, and
// the approval reads the server definitions again from the same place.
function requestMcp(names, servers, reason, by, info, cwd) {
  const who = actorOf(by);
  if (!isAI(who)) throw fail('only an assistant files an MCP access request');
  const why = cleanReason(reason);
  if (!why) throw fail('say why the access is needed: a reason is required (one line, 200 characters at most)');
  const list = Array.from(new Set((Array.isArray(names) ? names : [names])
    .map(x => normalizeName(x)).filter(Boolean)));
  if (!list.length) throw fail('name at least one key');
  if (list.length > 50) throw fail('50 keys at most in one request');
  const srvList = (servers === null || servers === undefined) ? null : parseServerList(servers);
  const inf = info || mcpServerInfo(cwd);
  const v = loadRaw();
  pruneMcpRequests(v);
  // A request from an assistant the user has since switched to "off" is never
  // shown (pendingMcp skips it), so it must not hold the one slot either.
  let withdrew = false;
  for (const rid of Object.keys(v.mcpReq || {})) {
    let mode = 'off';
    try { mode = policyFor(v.mcpReq[rid].by).mcpByAI; } catch (e) { mode = 'off'; }
    if (mode === 'off') { withdrawMcpRequest(v, rid); withdrew = true; }
  }
  if (v.mcpReq && !Object.keys(v.mcpReq).length) delete v.mcpReq;
  if (v.mcpReq && Object.keys(v.mcpReq).length) {
    if (withdrew) saveRaw(v, false);
    throw fail('another MCP access request is already waiting for the user: wait for their answer before asking again');
  }
  const entries = list.map(n => {
    const s = findByName(v, n);
    if (!s) {
      const e = fail('unknown key: {0}', n);
      e.suggestions = suggest(n, Object.keys(v.secrets).map(id => v.secrets[id].name));
      throw e;
    }
    return s;
  });
  const srv = {};
  if (srvList) {
    for (const id of srvList) {
      if (!inf[id]) throw fail('unknown MCP server: {0}', id);
      srv[id] = inf[id].hash;
    }
  }
  const r = {
    rid: crypto.randomUUID(),
    names: entries.map(s => s.name), entryIds: entries.map(s => s.id),
    fps: entries.map(s => s.fingerprint || null),
    allow: true, servers: srvList, reason: why, by: who, at: Date.now(), srv,
    cwd: cwd ? String(cwd) : null
  };
  r.mac = mcpReqMac(r);
  if (!v.mcpReq) v.mcpReq = {};
  v.mcpReq[r.rid] = r;
  audit(v, 'mcp-request', r.names.join(','), srvList ? srvList.join(',') : 'all', who);
  saveRaw(v, false);
  return publicRequest(r);
}

// What the window needs to show, facts included, never a value. A requester
// whose MCP setting is now 'off' has nothing to show: the user switched it off
// after the request was filed.
function pendingMcp() {
  let v;
  try { v = loadRaw(); } catch (e) { return []; }
  let reqs;
  try { reqs = validMcpRequests(v); } catch (e) { return []; }
  if (!reqs.length) return [];
  const groups = groupIndex();
  const out = [];
  for (const r of reqs) {
    let mode = 'off';
    try { mode = policyFor(r.by).mcpByAI; } catch (e) { mode = 'off'; }
    if (mode === 'off') continue;
    const inf = mcpServerInfo(r.cwd || undefined);
    const keys = r.names.map(n => {
      const s = findByName(v, n);
      if (!s) return null;
      return {
        name: s.name, kind: kindSource(s.kind), createdBy: s.createdBy || null,
        group: groupFields(s, groups).group, confirm: !!s.confirm, mcp: !!s.mcp,
        mcpServers: (s.mcpServers && s.mcpServers.length) ? s.mcpServers.slice() : null
      };
    }).filter(Boolean);
    const srvInfo = {};
    for (const id of (r.servers || Object.keys(inf))) {
      if (inf[id]) srvInfo[id] = { transport: inf[id].transport, wrapped: inf[id].wrapped, scope: inf[id].scope };
    }
    out.push(Object.assign(publicRequest(r), { keys, srvInfo, known: Object.keys(inf).sort() }));
  }
  return out;
}

// shown = { names, servers, chosen }: what the window displayed. `chosen` true
// means the user picked the servers themselves ("Choose servers"); otherwise
// the servers must be exactly the request's own.
function approveMcp(rid, shown) {
  const sh = shown || {};
  const v = loadRaw();
  const r = validMcpRequests(v).find(x => x.rid === rid);
  if (!r) throw fail('no pending MCP access request under that reference');
  // A request that no longer matches what was shown can never be approved, so
  // it is answered right here, as refused. Left in place, it would never be
  // shown again, hold the one request slot for fifteen minutes, and keep the
  // waiting script saying "pending".
  const changed = () => {
    delete v.mcpReq[rid];
    if (!Object.keys(v.mcpReq).length) delete v.mcpReq;
    audit(v, 'mcp-rejected', r.names.join(','), rid, 'user');
    try { saveRaw(v, false); } catch (e) { /* the request expires on its own */ }
    return fail('the request changed after it was shown: nothing was applied');
  };
  const sorted = a => a.map(String).slice().sort();
  if (!Array.isArray(sh.names) || JSON.stringify(sorted(sh.names)) !== JSON.stringify(sorted(r.names))) {
    throw changed();
  }
  let servers;
  if (sh.chosen) {
    if (!Array.isArray(sh.servers) || !sh.servers.length) throw fail('choose at least one server');
    servers = parseServerList(sh.servers);
  } else {
    const a = sh.servers == null ? null : (Array.isArray(sh.servers) ? sorted(sh.servers) : 'bad');
    const b = r.servers ? sorted(r.servers) : null;
    if (JSON.stringify(a) !== JSON.stringify(b)) throw changed();
    servers = r.servers ? r.servers.slice() : null;
  }
  const entries = r.entryIds.map((id, i) => {
    const s = v.secrets[id];
    if (!s || s.name !== r.names[i] || (s.fingerprint || null) !== r.fps[i]) throw changed();
    return s;
  });
  const inf = mcpServerInfo(r.cwd || undefined);
  for (const id of Object.keys(r.srv || {})) {
    if (!inf[id] || inf[id].hash !== r.srv[id]) throw changed();
  }
  for (const s of entries) open(s);          // a tampered entry aborts before anything moves
  delete v.mcpReq[rid];
  if (!Object.keys(v.mcpReq).length) delete v.mcpReq;
  audit(v, 'mcp-approved', r.names.join(','), rid, 'user');
  for (const s of entries) applyMcp(v, s, true, servers, r.by);
  saveRaw(v, true);
  return { rid, names: r.names.slice(), servers, by: r.by };
}

function rejectMcp(rid) {
  const v = loadRaw();
  const r = v.mcpReq && v.mcpReq[rid];
  if (!r) return false;
  delete v.mcpReq[rid];
  if (!Object.keys(v.mcpReq).length) delete v.mcpReq;
  audit(v, 'mcp-rejected', Array.isArray(r.names) ? r.names.join(',') : null, rid, 'user');
  saveRaw(v, false);
  return true;
}

// The state of a request for a waiting script: 'approved', 'rejected',
// 'pending', or 'gone' when nothing is waiting any more without an answer
// having been given (the key changed or was removed, the request expired, or
// its author was switched off). Read from the journal, where every outcome
// carries the request id, then from the vault itself.
// One read for both questions: an answer and the removal of the request land
// in the same save, so a single copy of the file can never show the request
// gone while its answer is still missing.
function mcpRequestState(rid) {
  let v;
  try { v = loadRaw(); } catch (e) { return 'pending'; }   // unreadable for now
  const hits = pruneAudit(v.audit).slice(-100).filter(e => e && e.detail === rid);
  if (hits.some(e => e.event === 'mcp-approved')) return 'approved';
  if (hits.some(e => e.event === 'mcp-rejected')) return 'rejected';
  if (hits.some(e => e.event === 'mcp-withdrawn')) return 'gone';
  if (!validMcpRequests(v).some(r => r.rid === rid)) return 'gone';
  return 'pending';
}

// ------------------------------------------------- what an assistant may do
//
// The two doors (the bridge scripts for Claude, the MCP server for ChatGPT)
// call these and only format the answer. Same rules, same refusals, same
// requests, whoever asks.

// Changes MCP access on existing keys. Removal and narrowing apply at once;
// a grant follows decideGrant() and may become a request for the user.
// Returns { status: 'applied'|'requested'|'refused', why, keys?, request? }.
function aiChangeMcp(o) {
  const a = o || {};
  const by = actorOf(a.by);
  if (!isAI(by)) throw fail('only an assistant goes through this path');
  const allow = !!a.allow;
  const servers = allow && a.servers != null ? parseServerList(a.servers) : null;
  const list = Array.from(new Set((Array.isArray(a.names) ? a.names : [a.names])
    .map(x => normalizeName(x)).filter(Boolean)));
  if (!list.length) throw fail('name at least one key');
  const reason = cleanReason(a.reason);
  const pol = policyFor(by);
  const info = mcpServerInfo(a.cwd);
  const v = loadRaw();
  const entries = list.map(n => {
    const s = findByName(v, n);
    if (!s) {
      const e = fail('unknown key: {0}', n);
      e.suggestions = suggest(n, Object.keys(v.secrets).map(id => v.secrets[id].name));
      throw e;
    }
    return { name: s.name, mcp: !!s.mcp, mcpServers: s.mcpServers || null, confirm: !!s.confirm };
  });
  const d = decideGrant({ entries, servers, info, mode: pol.mcpByAI, creation: false, allow });
  if (d.action === 'refuse') return { status: 'refused', why: d.why, mode: pol.mcpByAI };
  // A reason is what the user reads before deciding on a grant. Removing,
  // narrowing or keeping the same scope decides nothing for them, so it needs
  // none; and "off" is reported above, before any complaint about a reason.
  const narrowing = !allow || entries.every(e => isNarrowing(e, true, servers));
  if (!narrowing && !reason) {
    throw fail('say why the access is needed: a reason is required (one line, 200 characters at most)');
  }
  if (d.action === 'apply') {
    const keys = setMcpMany(entries.map(e => ({ name: e.name, allowed: allow, servers })), by);
    return { status: 'applied', why: d.why, keys, mode: pol.mcpByAI };
  }
  const request = requestMcp(entries.map(e => e.name), servers, reason, by, info, a.cwd);
  return { status: 'requested', why: d.why, request, mode: pol.mcpByAI };
}

// Creates a key on behalf of an assistant: refuses a value the vault already
// holds under another name, resolves the group (an existing one is a
// placement; creating one follows the layout setting), decides MCP, writes the
// key, and files a request when the user has to be asked. Never returns the value.
function aiCreateKey(o) {
  const a = o || {};
  const by = actorOf(a.by);
  if (!isAI(by)) throw fail('only an assistant goes through this path');
  const n = validateName(a.name);
  const value = a.value;
  if (typeof value !== 'string' || !value.length) throw fail('Empty value');
  const v = loadRaw();
  if (findByName(v, n)) throw fail('a key named {0} already exists', n);
  const owner = fingerprintOwner(v, fingerprint(value), n);
  if (owner) {
    const e = owner.binned
      ? fail('this value is already stored in the bin as {0}: ask the user to restore it rather than storing a copy', owner.name)
      : fail('this value is already stored as {0}: use that key, or ask the user to rename it, rather than storing a copy', owner.name);
    e.owner = owner.name;
    throw e;
  }
  const pol = policyFor(by);
  const res = { name: n, group: null, groupCreated: false, groupNote: null, mcp: { status: 'none' } };

  let groupId = null;
  if (a.group !== undefined && a.group !== null && a.group !== '') {
    if (!normalizeGroupName(a.group)) {
      throw fail('invalid group name: use letters, digits, spaces and . _ & + - (40 characters at most)');
    }
    const g = findGroup(a.group);
    if (g) groupId = g.id;
    else if (pol.layoutByAI) {
      const made = createGroup(a.group, undefined, by);
      groupId = made.id;
      res.groupCreated = true;
    } else {
      const names = layout().filter(i => i.type === 'group').map(i => i.name);
      res.groupNote = 'not placed in a group: "' + normalizeGroupName(a.group) + '" does not exist and the user ' +
        'does not let the AI create groups. Existing groups: ' + (names.length ? names.join(', ') : 'none');
    }
  }

  let grant = null;
  let ask = null;
  let info = null;
  if (a.mcp && a.mcp.allow) {
    const servers = a.mcp.servers != null ? parseServerList(a.mcp.servers) : null;
    info = mcpServerInfo(a.cwd);
    const d = decideGrant({
      entries: [{ name: n, mcp: false, confirm: false }], servers, info,
      mode: pol.mcpByAI, creation: true, allow: true
    });
    if (d.action === 'apply') grant = { servers };
    else if (d.action === 'request') ask = { servers, why: d.why };
    else res.mcp = { status: 'refused', why: d.why, servers };
  } else if (a.mcp && !a.mcp.allow) {
    res.mcp = { status: 'off' };
  }

  const r = put(n, value, {
    note: a.note || null, by,
    mcp: !!grant, mcpServers: grant ? grant.servers : null,
    groupId: groupId || null, groupBy: groupId ? by : null
  });
  res.kind = r.kind;
  res.length = value.length;
  if (groupId) { const g = findGroup(groupId); res.group = g ? g.name : null; }
  if (grant) res.mcp = { status: 'applied', servers: grant.servers };
  if (ask) {
    try {
      const reason = cleanReason(a.reason) || cleanReason('new key: ' + (a.note || n));
      const request = requestMcp([n], ask.servers, reason, by, info, a.cwd);
      res.mcp = { status: 'requested', servers: ask.servers, why: ask.why, request };
    } catch (e) {
      res.mcp = { status: 'request-failed', servers: ask.servers, why: ask.why, error: e.message };
    }
  }
  return res;
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
    if (!value) continue;
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
  const redact = function (text) {
    let out = String(text == null ? '' : text);
    for (const [needle, name] of subs) {
      if (needle && out.indexOf(needle) !== -1) out = out.split(needle).join('«vault:' + name + '»');
    }
    return out;
  };
  redact.patterns = subs;
  return redact;
}

// ------------------------------------------------------------------ diagnostic

// A diagnostic carries the template and its arguments in addition to the
// already assembled message: the UI can therefore translate it, while the
// hook just uses the message as is.
function issue(level, e) {
  return { level, msg: e.message, tpl: e.tpl || null, args: e.args || [] };
}

// ------------------------------------------------------------------ phrase de secours
//
// La clé maîtresse est scellée par le magasin de secrets de l'OS. Si ce magasin
// disparaît — nouvelle machine, profil Windows réinitialisé, trousseau vidé —
// le coffre est définitivement illisible. La phrase de secours est une SECONDE
// enveloppe, indépendante de l'OS, ouverte par 17 mots générés ici et notés par
// l'utilisateur.
//
// Pourquoi des mots générés plutôt qu'une phrase choisie : une phrase humaine
// dépasse rarement 40 bits d'entropie, ces 17 mots en portent 128. Et pourquoi
// HKDF plutôt qu'un scrypt : une dérivation coûteuse ne sert qu'à compenser un
// secret faible. Ici le secret est déjà uniforme sur 128 bits, il n'y a rien à
// compenser — ralentir ne protégerait que contre une attaque déjà impossible.
//
// Une copie de la phrase reste dans recovery-log.bin, scellée sous la clé
// maîtresse. La promesse précédente était « stockée nulle part », et elle se
// payait cher : une phrase mal notée, ou un remplacement par erreur, laissait
// quelqu'un sans filet au moment où il en avait besoin. Cette copie n'enlève
// rien : elle ne s'ouvre qu'avec la clé maîtresse, et qui détient cette clé lit
// déjà tout le coffre. Elle ne quitte pas la machine, le fichier d'export n'en
// contient pas, et elle ne remplace pas le papier : si le magasin de l'OS est
// perdu, elle est perdue avec lui.
const RECOVERY_PATH = path.join(VAULT_DIR, 'recovery.bin');
const RECOVERY_INFO = 'claude-vault-recovery-v1';
const RECOVERY_LOG_PATH = path.join(VAULT_DIR, 'recovery-log.bin');
const RECOVERY_LOG_INFO = 'claude-vault-recovery-log-v1';
const RECOVERY_LOG_MAX = 5;
const WORDS = require('./wordlist.js');
const PHRASE_BYTES = 16;                    // 128 bits + 1 octet de contrôle = 17 mots

function phraseEncode(entropy) {
  const sum = crypto.createHash('sha256').update(entropy).digest()[0];
  return Array.from(Buffer.concat([entropy, Buffer.from([sum])])).map(b => WORDS[b]);
}

// Tolérant à la saisie : casse, ponctuation, espaces multiples, et un mot
// reconnu sur ses trois premières lettres — le dictionnaire garantit qu'elles
// sont uniques, donc « elep » suffit pour « elephant ».
function phraseDecode(input) {
  const raw = String(input || '').toLowerCase().split(/[^a-z]+/).filter(Boolean);
  if (raw.length !== PHRASE_BYTES + 1) {
    throw fail('the recovery phrase must hold {0} words, {1} given', PHRASE_BYTES + 1, raw.length);
  }
  const bytes = [];
  for (const w of raw) {
    let i = WORDS.indexOf(w);
    if (i === -1) {
      const p = w.slice(0, 3);
      const hits = [];
      for (let k = 0; k < WORDS.length; k++) if (WORDS[k].slice(0, 3) === p) hits.push(k);
      if (hits.length === 1) i = hits[0];
    }
    if (i === -1) throw fail('unknown word in the recovery phrase: {0}', w);
    bytes.push(i);
  }
  const entropy = Buffer.from(bytes.slice(0, PHRASE_BYTES));
  const sum = crypto.createHash('sha256').update(entropy).digest()[0];
  if (sum !== bytes[PHRASE_BYTES]) {
    throw fail('the recovery phrase is not valid: check the words and their order');
  }
  return entropy;
}

function recoveryKey(entropy, salt) {
  return Buffer.from(crypto.hkdfSync('sha256', entropy, salt,
    Buffer.from(RECOVERY_INFO, 'utf8'), 32));
}

function recoveryStatus() {
  try {
    const r = JSON.parse(fs.readFileSync(RECOVERY_PATH, 'utf8'));
    return { enabled: true, at: r.at || null };
  } catch (e) { return { enabled: false, at: null }; }
}

function recoveryEnvelope() {
  try { return JSON.parse(fs.readFileSync(RECOVERY_PATH, 'utf8')); }
  catch (e) { return null; }
}

function writeEnvelope(entropy, id) {
  const key = masterKey();
  const salt = crypto.randomBytes(16);
  const iv = crypto.randomBytes(12);
  const rk = recoveryKey(entropy, salt);
  const c = crypto.createCipheriv('aes-256-gcm', rk, iv);
  c.setAAD(Buffer.from(RECOVERY_INFO, 'utf8'));
  const ct = Buffer.concat([c.update(key), c.final()]);
  rk.fill(0);
  writeAtomic(RECOVERY_PATH, JSON.stringify({
    v: 1, id, at: Date.now(), salt: b64(salt), iv: b64(iv),
    tag: b64(c.getAuthTag()), ct: b64(ct)
  }));
}

// Illisible (clé remplacée, fichier modifié) revient à vide : l'historique est
// un filet, le coffre ne dépend jamais de lui.
function recoveryLogRead() {
  if (!fs.existsSync(RECOVERY_LOG_PATH)) return [];
  try {
    const f = JSON.parse(fs.readFileSync(RECOVERY_LOG_PATH, 'utf8'));
    const k = derive(RECOVERY_LOG_INFO, Buffer.alloc(0), 32);
    const d = crypto.createDecipheriv('aes-256-gcm', k, unb64(f.iv));
    d.setAAD(Buffer.from(RECOVERY_LOG_INFO, 'utf8'));
    d.setAuthTag(unb64(f.tag));
    const clear = Buffer.concat([d.update(unb64(f.ct)), d.final()]);
    k.fill(0);
    const items = JSON.parse(clear.toString('utf8'));
    return Array.isArray(items) ? items : [];
  } catch (e) { return []; }
}

// Du plus ancien au plus récent : la fin de la liste est ce qui reste.
function recoveryLogWrite(items) {
  const kept = items.slice(-RECOVERY_LOG_MAX);
  const iv = crypto.randomBytes(12);
  const k = derive(RECOVERY_LOG_INFO, Buffer.alloc(0), 32);
  const c = crypto.createCipheriv('aes-256-gcm', k, iv);
  c.setAAD(Buffer.from(RECOVERY_LOG_INFO, 'utf8'));
  const ct = Buffer.concat([c.update(Buffer.from(JSON.stringify(kept), 'utf8')), c.final()]);
  k.fill(0);
  writeAtomic(RECOVERY_LOG_PATH, JSON.stringify({
    v: 1, iv: b64(iv), tag: b64(c.getAuthTag()), ct: b64(ct)
  }));
}

// La phrase active passe dans le passé. Une phrase d'avant cet historique n'a
// jamais été conservée : on garde sa date, c'est tout ce qui existe d'elle.
function recoveryRetire(items, env, now) {
  if (!env) return;
  const it = items.find(i => i.id && i.id === env.id);
  if (it) { it.replacedAt = now; return; }
  items.push({ id: env.id || crypto.randomUUID(), createdAt: env.at || null, replacedAt: now, words: null });
}

function recoveryAudit(event, detail) {
  try {
    const v = loadRaw();
    audit(v, event, null, detail || null, 'user');
    saveRaw(v, false);
  } catch (e) { /* un coffre illisible ne doit pas priver de la phrase qui le sauve */ }
}

// Sans l'ancienne phrase, volontairement : celui qui veut en changer est souvent
// celui qui l'a perdue, et la clé maîtresse qui ouvre ce coffre suffit à sceller
// la nouvelle. Le filet n'est donc pas une question posée avant, mais ce qu'on
// peut défaire après : l'ancienne reste dans l'historique et se réactive.
// L'ordre compte : copie scellée, puis enveloppe. Une coupure entre les deux
// laisse l'ancienne phrase active et rien de perdu.
function recoveryEnable() {
  masterKey();
  const entropy = crypto.randomBytes(PHRASE_BYTES);
  const words = phraseEncode(entropy);
  const id = crypto.randomUUID();
  const now = Date.now();
  const env = recoveryEnvelope();
  const items = recoveryLogRead();
  recoveryRetire(items, env, now);
  items.push({ id, createdAt: now, replacedAt: null, words: words.join(' ') });
  recoveryLogWrite(items);
  writeEnvelope(entropy, id);
  recoveryAudit(env ? 'recovery-replace' : 'recovery-create');
  // Le fichier de sauvegarde porte l'enveloppe : sans cette ligne, il attendait la
  // prochaine modification du coffre et ne s'ouvrait toujours qu'avec l'ancienne.
  exportRefresh();
  return words;
}

// Ce que le panneau peut dire sans afficher un seul mot. Le dernier mot n'est
// qu'une somme de contrôle des seize autres : il permet de reconnaître sa feuille
// de papier sans rien révéler de la phrase.
function recoveryDetails() {
  const env = recoveryEnvelope();
  const items = recoveryLogRead();
  const current = env ? items.find(i => i.id && i.id === env.id) : null;
  const lastWord = i => (i && i.words ? i.words.split(' ').pop() : null);
  const history = items.map(i => ({
    id: i.id, createdAt: i.createdAt || null,
    replacedAt: i === current ? null : (i.replacedAt || i.createdAt || null),
    last: lastWord(i), canShow: !!i.words, current: i === current
  })).reverse();
  if (env && !current) {
    history.unshift({ id: null, createdAt: env.at || null, replacedAt: null, last: null, canShow: false, current: true });
  }
  return {
    enabled: !!env, at: env ? env.at || null : null, id: current ? current.id : null,
    canShow: !!(current && current.words), last: lastWord(current), history
  };
}

function recoveryShow(id) {
  const it = recoveryLogRead().find(i => i.id && i.id === id);
  if (!it || !it.words) throw fail('this phrase was not kept: it cannot be displayed');
  recoveryAudit('recovery-show');
  return it.words.split(' ');
}

// Rend son pouvoir à une phrase de l'historique : un remplacement par erreur se
// défait, y compris s'il n'a pas été fait par la personne qui s'en aperçoit.
function recoveryActivate(id) {
  const items = recoveryLogRead();
  const it = items.find(i => i.id && i.id === id);
  if (!it || !it.words) throw fail('this phrase was not kept: it cannot be displayed');
  const env = recoveryEnvelope();
  if (env && env.id === id) return true;
  recoveryRetire(items, env, Date.now());
  it.replacedAt = null;
  items.splice(items.indexOf(it), 1);
  items.push(it);
  recoveryLogWrite(items);
  writeEnvelope(phraseDecode(it.words), it.id);
  recoveryAudit('recovery-activate');
  exportRefresh();
  return true;
}

// Installe l'enveloppe qu'une phrase saisie vient d'ouvrir, et garde cette phrase.
// C'est aussi le chemin par lequel une phrase d'avant l'historique y entre.
function recoveryAdopt(entropy, env, reset) {
  const id = env.id || crypto.randomUUID();
  writeAtomic(RECOVERY_PATH, JSON.stringify(Object.assign({}, env, { id })));
  const items = reset ? [] : recoveryLogRead();
  const words = phraseEncode(entropy).join(' ');
  const it = items.find(i => i.id === id);
  if (it) it.words = words;
  else items.push({ id, createdAt: env.at || Date.now(), replacedAt: null, words });
  recoveryLogWrite(items);
}

// Tout part : l'enveloppe, les copies scellées, et l'enveloppe portée par le
// fichier de sauvegarde, sinon « la phrase n'ouvre plus rien » resterait faux
// jusqu'à la prochaine modification du coffre.
function recoveryDisable() {
  recoveryAudit('recovery-off');
  try { fs.unlinkSync(RECOVERY_PATH); } catch (e) { /* déjà absent */ }
  try { fs.unlinkSync(RECOVERY_LOG_PATH); } catch (e) { /* jamais créé */ }
  exportRefresh();
  return true;
}

// Rouvre le coffre avec la phrase, puis REPOSE la clé dans le magasin de l'OS :
// la récupération ne doit pas laisser l'utilisateur dépendant de sa phrase.
function recoveryRestore(phrase) {
  const entropy = phraseDecode(phrase);
  let r;
  try { r = JSON.parse(fs.readFileSync(RECOVERY_PATH, 'utf8')); }
  catch (e) { throw fail('no recovery phrase has been set up on this vault'); }
  const rk = recoveryKey(entropy, unb64(r.salt));
  const d = crypto.createDecipheriv('aes-256-gcm', rk, unb64(r.iv));
  d.setAAD(Buffer.from(RECOVERY_INFO, 'utf8'));
  d.setAuthTag(unb64(r.tag));
  let key;
  try { key = Buffer.concat([d.update(unb64(r.ct)), d.final()]); }
  catch (e) { rk.fill(0); throw fail('the recovery phrase does not open this vault'); }
  rk.fill(0);
  if (key.length !== 32) throw fail('master key corrupted');

  // Le compteur du coffre fait foi : le fichier de clé doit repartir au même
  // niveau, sinon loadRaw() refuserait le coffre comme périmé.
  let seq = 0;
  try { seq = JSON.parse(fs.readFileSync(VAULT_PATH, 'utf8')).seq || 0; } catch (e) { /* coffre neuf */ }
  _master = key;
  _masterMode = null;
  storeKey(key, seq);
  try { recoveryAdopt(entropy, r, false); } catch (e) { /* le coffre est rouvert, c'est l'essentiel */ }
  return { mode: _masterMode, secrets: listFast().length };
}

function healthCheck() {
  const issues = [];
  ensureDirs();
  // Nothing has been created yet: say so instead of CREATING it. This runs on
  // the panel's render path, and forcing the master key into existence there
  // meant two blocking PowerShell spawns on the extension host at first paint,
  // on a machine where the user may never store a single secret.
  if (!fs.existsSync(KEY_PATH) && !fs.existsSync(VAULT_PATH)) {
    return { ok: true, issues, mode: null };
  }
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
  // `downgrade` is raw diagnostic data, never shown as-is: it carries the exact
  // reason the OS store was refused, which is the only thing that makes a
  // fallback debuggable from a machine one does not own.
  return { ok: !issues.some(i => i.level === 'error'), issues, mode: _masterMode, downgrade: _downgrade };
}

// Every read-modify-write of the vault, the layout, the bin or the policy goes
// through the write lock (see withVaultLock). The names are rebound rather
// than each body wrapped, so the calls these functions make to one another go
// through the same, re-entrant, lock. consume() and sweep() take it themselves:
// consume() must not hold it across the confirmation it may wait a minute for.
put = locked(put);
replaceValue = locked(replaceValue);
rename = locked(rename);
remove = locked(remove);
setTtl = locked(setTtl);
setMcpMany = locked(setMcpMany);
setPublic = locked(setPublic);
setConfirm = locked(setConfirm);
setNote = locked(setNote);
reveal = locked(reveal);
revokeAll = locked(revokeAll);
requestReplace = locked(requestReplace);
approveReplace = locked(approveReplace);
rejectReplace = locked(rejectReplace);
setPolicy = locked(setPolicy);
resignPolicy = locked(resignPolicy);
setExportFields = locked(setExportFields);
exportWrite = locked(exportWrite);
exportRefresh = locked(exportRefresh);
exportImport = locked(exportImport);
transferSnapshot = locked(transferSnapshot);
transferApply = locked(transferApply);
recoveryRestore = locked(recoveryRestore);
recoveryEnable = locked(recoveryEnable);
recoveryDisable = locked(recoveryDisable);
recoveryActivate = locked(recoveryActivate);
recoveryShow = locked(recoveryShow);
trashPutMany = locked(trashPutMany);
purgeTrash = locked(purgeTrash);
restoreTrashed = locked(restoreTrashed);
emptyTrash = locked(emptyTrash);
createGroup = locked(createGroup);
renameGroup = locked(renameGroup);
deleteGroup = locked(deleteGroup);
addSeparator = locked(addSeparator);
editSeparator = locked(editSeparator);
removeSeparator = locked(removeSeparator);
moveItem = locked(moveItem);
setCollapsed = locked(setCollapsed);
setAllCollapsed = locked(setAllCollapsed);
setKeyGroup = locked(setKeyGroup);
requestMcp = locked(requestMcp);
approveMcp = locked(approveMcp);
rejectMcp = locked(rejectMcp);
aiChangeMcp = locked(aiChangeMcp);
aiCreateKey = locked(aiCreateKey);

module.exports = {
  VAULT_DIR, VAULT_PATH, KEY_PATH, TMP_DIR, NAME_RE,
  validateName, normalizeName, list, listFast, put, rename, replaceValue, remove, setTtl, setMcp, setNote,
  setPublic, detectPublic, setConfirm, pendingUses, answerUse,
  revokeAll, consume, reveal, peek,
  requestReplace, pendingReplacements, approveReplace, rejectReplace, policy, setPolicy,
  notePending, pendingHints, takePending, takeRecent, auditLog,
  noteProxied, unnoteProxied, isProxied, uiLang, setUiLang, uiDefaults, setUiDefaults,
  mcpAllows,
  sweep, sweepTmp, suggest, isExpired, fingerprint, detectKind, kindSource,
  mintToken, redeemToken, materialize, redactor, healthCheck, lockDown,
  recoveryEnable, recoveryDisable, recoveryStatus, recoveryRestore,
  recoveryDetails, recoveryShow, recoveryActivate,
  exportWrite, exportRefresh, exportStatus, exportForget, exportImport, exportInspect,
  exportEnsure,
  transferPasswordIssue, transferPasswordGenerate, transferCheck, transferBuild, transferOpen, transferPreview, transferApply,
  scanText,
  listTrash, restoreTrashed, emptyTrash, purgeTrash, TRASH_DAYS,
  // 1.2: groups and separators
  layout, normalizeGroupName, findGroup, createGroup, renameGroup, deleteGroup,
  addSeparator, editSeparator, removeSeparator, moveItem, setCollapsed, setAllCollapsed,
  setKeyGroup, suggestGroups, rotationOf,
  // 1.2: MCP access decided by the AI
  setMcpMany, parseServerList, isNarrowing, mcpServerInfo, fingerprintTaken, decideGrant,
  requestMcp, pendingMcp, approveMcp, rejectMcp, mcpRequestState, VAULT_MCP_SERVER,
  aiChangeMcp, aiCreateKey,
  // 1.2: signed policy
  policyFor, policyFast, legacyAutoApprove
};
