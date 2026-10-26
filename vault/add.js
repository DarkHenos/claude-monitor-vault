// Claude Vault, key creation and replacement. One of the vault entry points
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
// At creation the AI also says what the key may do, since it is the one that
// knows what the key is for:
//
//   --mcp=server1,server2   usable in MCP tool calls of those servers only
//   --mcp                   usable by every MCP server (always asks the user)
//   --no-mcp                shell only, the default
//   --group "Name"          placed in that group (created if missing)
//
// Leaving the MCP decision out is not an error: the key is created shell only,
// nothing is lost, and access can be requested later with set.js.
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
const path = require('path');
const vault = require('./core.js');

const WAIT_MS = 60000;      // how long we wait for the user to answer
const POLL_MS = 500;
const SET_JS = path.join(__dirname, 'set.js');

function die(msg) {
  process.stderr.write('claude-vault: ' + msg + '\n');
  process.exit(1);
}

// --------------------------------------------------------------- command line

const argv = process.argv.slice(2);
let name = null;
let note = null;
let replace = false;
let mcpFlag = null;          // null: no decision; { allow, servers }
let groupArg = null;
let reasonArg = null;
let lastFlag = null;

function setMcp(next, flag) {
  if (mcpFlag && (mcpFlag.allow !== next.allow ||
      JSON.stringify(mcpFlag.servers) !== JSON.stringify(next.servers))) {
    die('conflicting MCP options: give one of --mcp, --mcp=SERVERS or --no-mcp');
  }
  mcpFlag = next;
  lastFlag = flag;
}

for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  if (a === '--replace') { replace = true; lastFlag = a; continue; }
  if (a === '--note') { note = argv[++i]; lastFlag = a; continue; }
  if (a.startsWith('--note=')) { note = a.slice(7); lastFlag = a; continue; }
  if (a === '--no-mcp') { setMcp({ allow: false, servers: null }, a); continue; }
  if (a === '--mcp') { setMcp({ allow: true, servers: null }, a); continue; }
  if (a.startsWith('--mcp=')) {
    let list;
    try { list = vault.parseServerList(a.slice(6)); } catch (e) { die(e.message); }
    setMcp({ allow: true, servers: list }, a);
    continue;
  }
  if (a === '--group') {
    if (i + 1 >= argv.length) die('--group needs a group name, for example --group "Scaleway"');
    groupArg = argv[++i]; lastFlag = a; continue;
  }
  if (a.startsWith('--group=')) { groupArg = a.slice(8); lastFlag = a; continue; }
  if (a === '--reason') { reasonArg = argv[++i]; lastFlag = a; continue; }
  if (a.startsWith('--reason=')) { reasonArg = a.slice(9); lastFlag = a; continue; }
  if (a.startsWith('--')) die('unknown option ' + a);
  if (name !== null) {
    // "--mcp github" is the one slip worth naming: the servers go after an '='.
    if (lastFlag === '--mcp') {
      die('unexpected argument "' + a + '". To name MCP servers write --mcp=' + a +
          ' (no space); --mcp alone means every server.');
    }
    die('unexpected argument "' + a + '". The value is read from stdin only, never ' +
        'from the command line. Did you mean: <command> | node add.js ' + name + ' --note "..."');
  }
  name = a;
  lastFlag = null;
}

if (!name) {
  die('usage: <command producing the value> | node add.js KEY_NAME --note "what it is for" ' +
      '[--mcp=SERVER,... | --mcp | --no-mcp] [--group "Name"]\n' +
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

if (groupArg !== null && groupArg !== undefined && !vault.normalizeGroupName(groupArg)) {
  die('invalid group name "' + groupArg + '": use letters, digits, spaces and . _ & + - (40 characters at most)');
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
      if (e.code === 'EAGAIN') {
        // The pipe is not ready. Looping straight back would spin a core at
        // 100 % until the tool times out, and fd 0 really is non-blocking here:
        // reading process.stdin.isTTY above instantiates the stream, which sets
        // O_NONBLOCK on POSIX. Atomics.wait is the only way to sleep in a
        // synchronous read loop without pulling in a dependency.
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 1);
        continue;
      }
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

function sleep(ms) { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms); }

function waitForAnswer(t0) {
  const deadline = Date.now() + WAIT_MS;
  while (Date.now() < deadline) {
    const recent = vault.auditLog(40).filter(e => e.at >= t0 && e.name === name);
    if (recent.some(e => e.event === 'replace-approved')) return 'approved';
    if (recent.some(e => e.event === 'replace-rejected')) return 'rejected';
    // Synchronous on purpose: this script does one thing and then exits.
    sleep(POLL_MS);
  }
  return 'pending';
}

// An MCP request is answered by its id, which the journal carries as detail.
// The core also says 'gone' when the request was dropped unanswered.
function waitForMcp(rid) {
  const deadline = Date.now() + WAIT_MS;
  while (Date.now() < deadline) {
    const st = vault.mcpRequestState(rid);
    if (st !== 'pending') return st;
    sleep(POLL_MS);
  }
  return 'pending';
}

function q(p) { return "'" + String(p).replace(/\\/g, '/') + "'"; }

// The interpreter running this script is the one the bridge recorded, so the
// hint can be pasted as is.
function setHint() {
  return q(process.execPath) + ' ' + q(SET_JS) + ' ' + name + ' --mcp=SERVER --reason "why it needs MCP"';
}

function scopeText(servers) {
  return servers ? 'MCP servers ' + servers.join(', ') : 'every MCP server';
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
    // Duplicate value, group, MCP decision and request: all decided in core,
    // exactly as for ChatGPT's vault_create. This script only says what happened.
    let r;
    try {
      r = vault.aiCreateKey({
        name, value, note: described, by: 'claude', cwd: process.cwd(),
        mcp: mcpFlag, group: groupArg, reason: reasonArg
      });
    } catch (e) {
      if (e && e.owner) {
        die(e.message + '. Nothing was created. Use {{vault:' + e.owner + '}} in your commands ' +
            'if it is the same key.');
      }
      throw e;
    }
    let out = name + ' created: ' + vault.kindSource(r.kind) + ', ' + r.length +
      ' characters. It is visible in the Claude Vault view now.\n' +
      'Use it by writing {{vault:' + name + '}} in a Bash or PowerShell command. ' +
      'Its value is not readable, including by you.\n';
    if (r.group) out += 'Placed in group "' + r.group + '"' + (r.groupCreated ? ' (new group).\n' : '.\n');
    if (r.groupNote) out += 'Note: ' + r.groupNote + '.\n';
    const m = r.mcp;
    if (m.status === 'applied') out += 'Allowed for ' + scopeText(m.servers) + '.\n';
    else if (m.status === 'refused') {
      out += 'MCP access was NOT given: ' + m.why + '. The key is usable in shell commands only.\n';
    } else if (m.status === 'request-failed') {
      out += 'MCP access for ' + scopeText(m.servers) + ' needs the user (' + m.why +
        ') but could not be requested now: ' + m.error + '. The key is usable in shell ' +
        'commands only. Ask again later with: ' + setHint() + '\n';
    } else if (m.status === 'requested') {
      out += 'MCP access for ' + scopeText(m.servers) + ' needs the user (' + m.why +
        '): a request is waiting in VSCode.\n';
      process.stdout.write(out);
      out = '';
      const answer = waitForMcp(m.request.rid);
      if (answer === 'approved') {
        const s = vault.listFast().find(x => x.name === name) || {};
        out += 'The user approved: allowed for ' + scopeText(s.mcpServers || null) + '.\n';
      } else if (answer === 'rejected') {
        out += 'The user refused MCP access. The key stays usable in shell commands only; ' +
          'do not ask again without a new reason.\n';
      } else if (answer === 'gone') {
        out += 'The request was withdrawn before the user answered (the key changed or was ' +
          'removed, the request expired, or MCP changes by the AI were turned off). The key is ' +
          'usable in shell commands only. If an MCP tool still needs it, request access again with: ' +
          setHint() + '\n';
      } else {
        out += 'The user has not answered yet; the request is still waiting in VSCode. ' +
          'The key is usable in shell commands meanwhile. Do not send the request again.\n';
      }
    } else if (!mcpFlag) {
      out += 'No MCP decision was given, so the key is usable in shell commands only. ' +
        'If an MCP tool needs it, request access with: ' + setHint() + '\n';
    }
    process.stdout.write(out);
    process.exit(0);
  }

  // A replacement keeps everything the key already had. MCP and group are
  // decisions about the key, not about its value, and they have their own door.
  const ignored = [];
  if (mcpFlag) ignored.push('MCP');
  if (groupArg !== null && groupArg !== undefined) ignored.push('group');
  const ignoredNote = ignored.length
    ? 'Note: the ' + ignored.join(' and ') + ' option' + (ignored.length > 1 ? 's were' : ' was') +
      ' ignored, since --replace only changes the value. Use ' + q(SET_JS) + ' for that.\n'
    : '';
  // Who else holds this value. At creation a second name is refused outright;
  // on a replacement the value may go in, but never with this key's MCP access.
  const owner = vault.fingerprintTaken(value, name);

  if (vault.policyFor('claude').autoApprove) {
    const cur = vault.listFast().find(s => s.name === name) || {};
    // Same rule as approveReplace: mcpServers and pub must be carried over, or
    // an automatic approval quietly widens an MCP grant and re-derives a
    // visibility the user had set by hand. And the same laundering guard: a
    // value that already lives under another name does not inherit MCP access.
    const keepMcp = cur.mcp && !owner;
    const r = vault.put(name, value, {
      note: described, policy: cur.policy, expiresAt: cur.expiresAt,
      maxUses: cur.maxUses, mcp: keepMcp, mcpServers: keepMcp ? cur.mcpServers : null, pub: cur.pub,
      confirm: cur.confirm,
      groupId: cur.groupId || null, groupBy: cur.groupBy || null,
      by: 'claude'
    });
    process.stdout.write(
      name + ' replaced without asking, because the user turned automatic approval on: ' +
      vault.kindSource(r.kind) + ', ' + value.length + ' characters. The previous value is gone.\n' +
      (cur.mcp && owner ? 'MCP access was removed: the same value is already stored as ' + owner + '.\n' : '') +
      ignoredNote);
    process.exit(0);
  }

  const t0 = Date.now();
  vault.requestReplace(name, value, described);
  const answer = waitForAnswer(t0);

  if (answer === 'approved') {
    process.stdout.write(name + ' replaced, the user approved it. The previous value is gone.\n' + ignoredNote);
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
