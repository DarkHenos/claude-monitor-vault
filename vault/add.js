// Claude Vault, key creation and replacement. One of the two vault entry points
// Claude is allowed to run directly.
//
//   <command producing the value> | node add.js KEY_NAME --note "what it is for"
//   <command producing the value> | node add.js KEY_NAME --replace --note "..."
//
// The NAME comes from the command line, the VALUE only ever comes from stdin.
// That split is the whole point. A value passed as an argument would be visible
// in the process list, would sit in the shell history, and above all would mean
// the model typed it, so it would already be in the conversation. Through a pipe
// the value travels from the producing process straight into the vault, and
// nothing in between ever holds it as text.
//
//   openssl rand -hex 32 | node add.js SESSION_SECRET --note "signs the API session cookies, read in src/auth/session.ts"
//   node add.js DEPLOY_KEY < ~/.ssh/deploy_ed25519 --note "ssh deploy key for the staging VPS"
//
// CREATION is immediate. An existing name is refused: use --replace.
//
// REPLACEMENT waits for the user. The new value is sealed straight away and
// parked; the user approves or refuses in VSCode. Overwriting destroys a value
// that cannot be recovered, and that decision belongs to the person who owns it.
// The one exception is when they have turned auto approval on, which is theirs
// to grant and theirs to revoke.
//
// DELETION does not exist here, on purpose. It stays a human gesture.

'use strict';

const fs = require('fs');
const vault = require('./core.js');

const WAIT_MS = 60000;      // how long we wait for the user to answer
const POLL_MS = 500;

function die(msg) {
  process.stderr.write('claude-vault: ' + msg + '\n');
  process.exit(1);
}

// --------------------------------------------------------------- command line

const argv = process.argv.slice(2);
let name = null;
let note = null;
let replace = false;

for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  if (a === '--replace') { replace = true; continue; }
  if (a === '--note') { note = argv[++i]; continue; }
  if (a.startsWith('--note=')) { note = a.slice(7); continue; }
  if (a.startsWith('--')) die('unknown option ' + a);
  if (name !== null) {
    die('unexpected argument "' + a + '". The value is read from stdin only, never ' +
        'from the command line. Did you mean: <command> | node add.js ' + name + ' --note "..."');
  }
  name = a;
}

if (!name) {
  die('usage: <command producing the value> | node add.js KEY_NAME --note "what it is for"\n' +
      'Add --replace to update a key that already exists.');
}

try { name = vault.validateName(String(name).toUpperCase()); }
catch (e) { die(e.message); }

// The description is required, not optional. A vault of names nobody can
// explain six months later is a vault nobody dares clean up. Since Claude is
// the one wiring the key into the code, it is the one that knows where it is
// read from, and this is the moment it knows it.
if (!note || !String(note).trim()) {
  die('--note is required. Say what the key is for and where the code reads it, ' +
      'for example: --note "Mailjet API key, read by src/mail/client.ts at boot"');
}

// No pipe means someone would be waiting at a prompt that never comes. Say so
// instead of hanging for the length of the tool timeout.
if (process.stdin.isTTY) {
  die('no value on stdin. Pipe it in: <command> | node add.js ' + name + ' --note "..."');
}

const exists = vault.listFast().some(s => s.name === name);
if (exists && !replace) {
  die(name + ' already exists, so nothing was created. To update it, run the same ' +
      'command with --replace: the user will be asked to approve, since the old ' +
      'value cannot be recovered afterwards.');
}
if (!exists && replace) {
  die(name + ' does not exist yet, so there is nothing to replace. Run the same ' +
      'command without --replace to create it.');
}

// ------------------------------------------------------------------ the value

function readStdin() {
  const chunks = [];
  const buf = Buffer.alloc(65536);
  while (true) {
    let n;
    try { n = fs.readSync(0, buf, 0, buf.length, null); }
    catch (e) {
      if (e.code === 'EOF') break;
      if (e.code === 'EAGAIN') continue;      // pipe not ready yet
      throw e;
    }
    if (!n) break;
    chunks.push(Buffer.from(buf.slice(0, n)));
  }
  return Buffer.concat(chunks).toString('utf8');
}

// The description is metadata: it is displayed, it is not protected. A value
// copied into it would defeat the whole vault, so it is checked rather than
// trusted. It cannot happen by accident today, since the value arrives through
// a pipe nobody read, but it costs one comparison to make sure it never can.
function noteHoldsValue(txt, value) {
  if (value.length < 8) return false;
  if (txt.indexOf(value) !== -1) return true;
  return txt.indexOf(value.slice(0, Math.max(12, Math.floor(value.length / 2)))) !== -1;
}

function stamp(txt) {
  const d = new Date();
  const day = d.getFullYear() + '-' +
    String(d.getMonth() + 1).padStart(2, '0') + '-' +
    String(d.getDate()).padStart(2, '0');
  return String(txt).trim() + ' [' + (exists ? 'updated' : 'added') + ' by Claude ' + day + ']';
}

function waitForAnswer(t0) {
  const deadline = Date.now() + WAIT_MS;
  while (Date.now() < deadline) {
    const recent = vault.auditLog(40).filter(e => e.at >= t0 && e.name === name);
    if (recent.some(e => e.event === 'replace-approved')) return 'approved';
    if (recent.some(e => e.event === 'replace-rejected')) return 'rejected';
    // Synchronous on purpose: this script does one thing and then exits.
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, POLL_MS);
  }
  return 'pending';
}

try {
  // A pipe almost always adds a trailing newline. One is stripped, not all
  // whitespace: a PEM block ends with a meaningful newline and a value could
  // legitimately end with a space.
  const value = readStdin().replace(/\r?\n$/, '');
  if (!value.length) die('empty value on stdin, nothing was created');
  if (noteHoldsValue(note, value)) {
    die('the note contains the value itself. The note is displayed in plain text, ' +
        'so it must describe the key, never repeat it.');
  }
  const described = stamp(note);

  if (!exists) {
    const r = vault.put(name, value, { note: described, by: 'claude' });
    process.stdout.write(
      name + ' created: ' + vault.kindSource(r.kind) + ', ' + value.length +
      ' characters. It is visible in the Claude Vault view now.\n' +
      'Use it by writing {{vault:' + name + '}} in a Bash or PowerShell command. ' +
      'Its value is not readable, including by you.\n');
    process.exit(0);
  }

  if (vault.policy().autoApprove) {
    const cur = vault.listFast().find(s => s.name === name) || {};
    const r = vault.put(name, value, {
      note: described, policy: cur.policy, expiresAt: cur.expiresAt,
      maxUses: cur.maxUses, mcp: cur.mcp, by: 'claude'
    });
    process.stdout.write(
      name + ' replaced without asking, because the user turned automatic approval on: ' +
      vault.kindSource(r.kind) + ', ' + value.length + ' characters. The previous value is gone.\n');
    process.exit(0);
  }

  const t0 = Date.now();
  vault.requestReplace(name, value, described);
  const answer = waitForAnswer(t0);

  if (answer === 'approved') {
    process.stdout.write(name + ' replaced, the user approved it. The previous value is gone.\n');
    process.exit(0);
  }
  if (answer === 'rejected') {
    die(name + ' was NOT replaced: the user refused. The existing value is untouched. ' +
        'Ask them what they would rather do instead of retrying.');
  }
  die(name + ' was NOT replaced yet: the request is waiting for the user in VSCode and ' +
      'they have not answered. Nothing has changed. Tell them the request is pending ' +
      'rather than sending it again.');
} catch (e) {
  process.stderr.write('claude-vault: ' + (e && e.message ? e.message : String(e)) + '\n');
  process.exit(1);
}
