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
  writeAtomic(KEY_PATH, JSON.stringify({ v: 1, mode: kf.mode, blob: kf.blob, seq: next }));
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
    policy: { autoApprove: !!p.autoApprove },
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
  setPolicy(Object.assign(policy(), { exportPath: String(file), exportAt: Date.now() }));
  return { file: String(file), bytes: text.length };
}

// Called after every structural save. Silent on failure by design: an unplugged
// drive must not make saving a key fail, and the panel reports the staleness.
function exportRefresh() {
  const p = policy();
  if (!p.exportPath) return false;
  try {
    writeAtomic(p.exportPath, exportBuild());
    setPolicy(Object.assign(policy(), { exportAt: Date.now() }));
    return true;
  } catch (e) { return false; }
}

function exportStatus() {
  const p = policy();
  const st = {
    path: p.exportPath || null, at: p.exportAt || null, present: false, at_file: null,
    // Portable means: the file carries the envelope, so the phrase opens it
    // anywhere. Without it the file is still a backup, readable here.
    portable: fs.existsSync(RECOVERY_PATH)
  };
  if (!st.path) return st;
  try {
    const s = fs.statSync(st.path);
    st.present = true;
    st.at_file = s.mtimeMs;
  } catch (e) { /* moved, unplugged, deleted */ }
  return st;
}

// Called at startup. A safety net nobody switched on protects nobody, so the
// file exists from the first launch, at a place the user can see and move.
// Never throws: a vault that cannot write its backup still has to open.
const DEFAULT_EXPORT = 'claude-vault-backup.' + 'cvault';

function exportEnsure() {
  try {
    const p = policy();
    if (p.exportPath) {
      if (fs.existsSync(p.exportPath)) return { created: false, path: p.exportPath };
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

function exportForget() {
  const p = policy();
  delete p.exportPath;
  delete p.exportAt;
  setPolicy(p);
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
    const entropy = phraseDecode(phrase);
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
    _master = master;
    _masterMode = null;
    storeKey(master, seq);
    // The local envelope, if there was one, wraps the key we have just replaced.
    // Left alone, recoveryStatus() would keep saying "active" while the phrase
    // it names restores a key that opens nothing. The imported envelope is the
    // right one: it is opened by the words the user just typed.
    try { writeAtomic(RECOVERY_PATH, JSON.stringify(f.recovery)); }
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
  if (data.policy) {
    try { setPolicy(Object.assign(policy(), { autoApprove: !!data.policy.autoApprove })); }
    catch (e) { /* keeps the local setting */ }
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
function sweep() {
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
  const secrets = Object.keys(v.secrets).map(id => {
    const s = v.secrets[id];
    return {
      id, name: s.name, kind: s.kind, hint: s.hint, length: s.length,
      fingerprint: s.fingerprint, policy: s.policy,
      createdAt: s.createdAt, expiresAt: s.expiresAt || null,
      maxUses: s.maxUses || null, uses: s.uses || 0, pub: !!s.pub, confirm: !!s.confirm,
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
    };
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
    mcpServers: (o.mcp && Array.isArray(o.mcpServers) && o.mcpServers.length)
      ? o.mcpServers.map(x => String(x)).slice(0, 32) : null,
    // Detected, never assumed: an explicit choice always wins over the guess.
    pub: o.pub === undefined ? detectPublic(value) : !!o.pub,
    confirm: !!o.confirm,
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
function setMcp(name, allowed, servers) {
  const v = loadRaw();
  const s = findByName(v, name);
  if (!s) throw fail('unknown key: {0}', name);
  const list = Array.isArray(servers)
    ? servers.map(x => String(x)).filter(Boolean).slice(0, 32)
    : [];
  const value = open(s);
  s.mcp = !!allowed;
  s.mcpServers = (allowed && list.length) ? list : null;
  s.ct = seal(s, value);
  audit(v, 'mcp', s.name,
    allowed ? (s.mcpServers ? s.mcpServers.join(',') : 'allowed') : 'removed', 'user');
  saveRaw(v, true);
  return !!allowed;
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
  try { fs.unlinkSync(TRASH_PATH); } catch (e) { /* nothing binned */ }
  // The export file itself is left where it is: it may sit on a drive that is
  // not plugged in, and deleting a file the user put somewhere on purpose is
  // not this function's job. It stops being refreshed, and stops opening.
  try { exportForget(); } catch (e) { /* no policy file */ }
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
  let v = loadRaw();
  let s = findByName(v, name);
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
  // Asked BEFORE the counter moves and before anything is decrypted: a refused
  // use must leave no trace beyond the log line.
  if (s.confirm) {
    const granted = askUse(s.name, who);
    // Up to a minute has passed inside that call, and the vault is a file other
    // processes write to. Everything read before it is stale, so it is read again
    // rather than written back over whatever happened meanwhile.
    v = loadRaw();
    s = findByName(v, name);
    if (!granted) {
      if (s) {
        audit(v, 'use-refused', s.name, who || null, 'user');
        saveRaw(v, false);
      }
      throw fail('{0} needs your confirmation for every use, and it was not given', name);
    }
    if (!s) throw fail('unknown key: {0}', name);
    if (isExpired(s)) {
      delete v.secrets[s.id];
      audit(v, 'expire', s.name, null);
      saveRaw(v, true);
      throw fail('expired key: {0}', s.name);
    }
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
  // mcpServers and pub travel with mcp, and forgetting them here was not a
  // cosmetic loss: put() resets an absent mcpServers to null, which turns a
  // grant restricted to one named server into a grant valid for every server —
  // on the one path where the value was authored by Claude. Same story for pub,
  // which put() would re-derive from the new value and so overwrite a choice
  // the user made explicitly.
  const cur = findByName(v, n);
  const opts = cur ? {
    policy: cur.policy, expiresAt: cur.expiresAt,
    maxUses: cur.maxUses, mcp: cur.mcp, mcpServers: cur.mcpServers, pub: cur.pub,
    confirm: cur.confirm,
    note: p.note || cur.note, by: 'claude'
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

function policy() {
  try {
    const p = JSON.parse(fs.readFileSync(POLICY_PATH, 'utf8'));
    return {
      autoApprove: !!(p && p.autoApprove),
      exportPath: (p && typeof p.exportPath === 'string') ? p.exportPath : null,
      exportAt: (p && Number(p.exportAt)) || null
    };
  } catch (e) { return { autoApprove: false, exportPath: null, exportAt: null }; }
}

function setPolicy(o) {
  ensureDirs();
  writeAtomic(POLICY_PATH, JSON.stringify({
    autoApprove: !!(o && o.autoApprove),
    exportPath: (o && typeof o.exportPath === 'string' && o.exportPath) ? o.exportPath : null,
    exportAt: (o && Number(o.exportAt)) || null,
    at: Date.now()
  }));
  return policy();
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
const RECOVERY_PATH = path.join(VAULT_DIR, 'recovery.bin');
const RECOVERY_INFO = 'claude-vault-recovery-v1';
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

// Rend la phrase UNE SEULE FOIS. Elle n'est stockée nulle part : seule
// l'enveloppe qu'elle ouvre l'est.
function recoveryEnable() {
  const key = masterKey();
  const entropy = crypto.randomBytes(PHRASE_BYTES);
  const salt = crypto.randomBytes(16);
  const iv = crypto.randomBytes(12);
  const rk = recoveryKey(entropy, salt);
  const c = crypto.createCipheriv('aes-256-gcm', rk, iv);
  c.setAAD(Buffer.from(RECOVERY_INFO, 'utf8'));
  const ct = Buffer.concat([c.update(key), c.final()]);
  rk.fill(0);
  writeAtomic(RECOVERY_PATH, JSON.stringify({
    v: 1, at: Date.now(), salt: b64(salt), iv: b64(iv),
    tag: b64(c.getAuthTag()), ct: b64(ct)
  }));
  return phraseEncode(entropy);
}

function recoveryDisable() {
  try { fs.unlinkSync(RECOVERY_PATH); } catch (e) { /* déjà absent */ }
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
  exportWrite, exportRefresh, exportStatus, exportForget, exportImport, exportInspect,
  exportEnsure,
  scanText,
  listTrash, restoreTrashed, emptyTrash, purgeTrash, TRASH_DAYS
};
