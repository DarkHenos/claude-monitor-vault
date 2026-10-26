// Claude Vault, changes to existing keys and to the layout. One of the vault
// entry points Claude is allowed to run directly.
//
//   node set.js NAME [NAME...] --mcp=server,...|--mcp|--no-mcp [--reason "why"]
//   node set.js NAME [NAME...] --group "Name"|--no-group
//   node set.js --new-group "Name" [--at N] | --rename-group "Old" "New" | --delete-group "Name"
//   node set.js --separator ["label"] [--at N] | --move "Group or separator"|@P N
//
// Positions (--at, --move) count groups and separators from 1 at the top, the
// order `list.js --groups` prints them in. "@P" names the item at position P,
// the only way to reach a separator with no label or a label used twice.
// --reason is required to grant or widen MCP access, not to remove or narrow it.
//
// What applies at once: placing keys, reorganising the layout (unless the user
// turned that off), and REMOVING or narrowing MCP access. What may wait for the
// user: granting or widening MCP access, depending on their setting. The rules
// live in core.js (decideGrant), shared with ChatGPT's MCP tools, so this
// script only reads the command line and reports.
//
// Like add.js, it never reads, prints or receives a value. Nothing here can
// reach a plaintext secret: MCP flags are re-sealed by core without the value
// ever leaving it.

'use strict';

const vault = require('./core.js');

const WAIT_MS = 60000;
const POLL_MS = 500;

function die(msg) {
  process.stderr.write('claude-vault: ' + msg + '\n');
  process.exit(1);
}

function say(msg) { process.stdout.write(msg + '\n'); }

const USAGE =
  'usage:\n' +
  '  node set.js NAME [NAME...] --mcp=server,...|--mcp|--no-mcp [--reason "why"]\n' +
  '  node set.js NAME [NAME...] --group "Name"|--no-group\n' +
  '  node set.js --new-group "Name" [--at N] | --rename-group "Old" "New" | --delete-group "Name"\n' +
  '  node set.js --separator ["label"] [--at N] | --move "Group or separator"|@P N\n' +
  'Positions count groups and separators from 1 at the top (see list.js --groups);\n' +
  '@P names the item at position P, e.g. --move @3 1 for a separator with no label.\n' +
  '--reason is required to grant or widen MCP access, not to remove or narrow it.';

// --------------------------------------------------------------- command line

const argv = process.argv.slice(2);
const names = [];
let mcp = null;              // { allow, servers }
let group;                   // undefined: untouched; null: ungroup; string: target
let reason = null;
let layoutOp = null;         // { op, ... }
let at;

function needValue(i, flag) {
  if (i + 1 >= argv.length) die(flag + ' needs a value.\n' + USAGE);
  return argv[i + 1];
}

function setLayout(op) {
  if (layoutOp) die('one layout operation at a time.\n' + USAGE);
  layoutOp = op;
}

function position(s, flag) {
  const n = Number(s);
  if (!/^\d+$/.test(String(s)) || n < 1) die(flag + ' takes a position from 1 (the top), got "' + s + '"');
  return n - 1;
}

for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  if (a === '--mcp' || a === '--no-mcp' || a.startsWith('--mcp=')) {
    let next;
    if (a === '--no-mcp') next = { allow: false, servers: null };
    else if (a === '--mcp') next = { allow: true, servers: null };
    else {
      try { next = { allow: true, servers: vault.parseServerList(a.slice(6)) }; }
      catch (e) { die(e.message); }
    }
    if (mcp && JSON.stringify(mcp) !== JSON.stringify(next)) {
      die('conflicting MCP options: give one of --mcp, --mcp=SERVERS or --no-mcp');
    }
    mcp = next;
    continue;
  }
  if (a === '--reason') { reason = needValue(i, a); i++; continue; }
  if (a.startsWith('--reason=')) { reason = a.slice(9); continue; }
  if (a === '--group') { group = needValue(i, a); i++; continue; }
  if (a.startsWith('--group=')) { group = a.slice(8); continue; }
  if (a === '--no-group') { group = null; continue; }
  if (a === '--at') { at = position(needValue(i, a), a); i++; continue; }
  if (a.startsWith('--at=')) { at = position(a.slice(5), '--at'); continue; }
  if (a === '--new-group') { setLayout({ op: 'new-group', name: needValue(i, a) }); i++; continue; }
  if (a === '--rename-group') {
    if (i + 2 >= argv.length) die('--rename-group needs the current name and the new one.\n' + USAGE);
    setLayout({ op: 'rename-group', name: argv[i + 1], to: argv[i + 2] });
    i += 2;
    continue;
  }
  if (a === '--delete-group') { setLayout({ op: 'delete-group', name: needValue(i, a) }); i++; continue; }
  if (a === '--separator') {
    // The label is optional: a plain line is a legitimate separator.
    const nxt = argv[i + 1];
    if (nxt !== undefined && !nxt.startsWith('--')) { setLayout({ op: 'separator', label: nxt }); i++; }
    else setLayout({ op: 'separator', label: null });
    continue;
  }
  if (a === '--move') {
    if (i + 2 >= argv.length) die('--move needs a group or separator and a position.\n' + USAGE);
    setLayout({ op: 'move', name: argv[i + 1], to: position(argv[i + 2], '--move') });
    i += 2;
    continue;
  }
  if (a.startsWith('--')) die('unknown option ' + a + '\n' + USAGE);
  names.push(a);
}

if (layoutOp && (names.length || mcp || group !== undefined)) {
  die('a layout operation does not take key names, MCP or group options.\n' + USAGE);
}
if (!layoutOp && !names.length) die(USAGE);
if (!layoutOp && !mcp && group === undefined) {
  die('nothing to change: add --mcp=..., --no-mcp, --group "Name" or --no-group.\n' + USAGE);
}
if (at !== undefined && !(layoutOp && (layoutOp.op === 'new-group' || layoutOp.op === 'separator'))) {
  die('--at only goes with --new-group or --separator.\n' + USAGE);
}
// No check on --reason here: whether the change is a grant (a reason is
// required) or a narrowing (none is) depends on what each key allows today,
// and core.js answers that the same way for both assistants (aiChangeMcp).

// -------------------------------------------------------------------- helpers

function sleep(ms) { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms); }

// 'gone': nothing waits any more, and nobody answered. Said as such rather
// than as "still pending", which would tell the AI not to ask again.
const GONE_TEXT = 'the request was withdrawn before the user answered (a key changed or was ' +
  'removed, the request expired, or MCP changes by the AI were turned off). MCP access is ' +
  'unchanged; file it again only if it is still needed.';

function waitFor(rid) {
  const deadline = Date.now() + WAIT_MS;
  while (Date.now() < deadline) {
    const st = vault.mcpRequestState(rid);
    if (st !== 'pending') return st;     // approved, rejected or gone
    sleep(POLL_MS);
  }
  return 'pending';
}

function scopeOf(s) {
  if (!s || !s.mcp) return 'no MCP access';
  return s.mcpServers && s.mcpServers.length ? 'MCP servers ' + s.mcpServers.join(', ') : 'every MCP server';
}

function errText(e) {
  let m = e && e.message ? e.message : String(e);
  if (e && e.suggestions && e.suggestions.length) m += ' (did you mean ' + e.suggestions.join(', ') + '?)';
  return m;
}

// ----------------------------------------------------------------------- run

try {
  if (layoutOp) {
    const op = layoutOp;
    if (op.op === 'new-group') {
      const g = vault.createGroup(op.name, at, 'claude');
      say('Group "' + g.name + '" created. It is empty: place keys with --group "' + g.name + '".');
    } else if (op.op === 'rename-group') {
      const r = vault.renameGroup(op.name, op.to, 'claude');
      say(r.unchanged ? 'Group "' + r.name + '" already has that name.' : 'Group "' + r.from + '" renamed to "' + r.name + '".');
    } else if (op.op === 'delete-group') {
      const r = vault.deleteGroup(op.name, 'claude');
      say('Group "' + r.name + '" deleted. Its ' + r.keys + ' key(s) are now ungrouped; no key was deleted.');
    } else if (op.op === 'separator') {
      const s = vault.addSeparator(op.label, at, 'claude');
      say('Separator added' + (s.label ? ' ("' + s.label + '")' : '') + '.');
    } else if (op.op === 'move') {
      const r = vault.moveItem(op.name, op.to, 'claude');
      say(r.unchanged ? 'Already at position ' + (r.index + 1) + '.' : 'Moved to position ' + (r.index + 1) + '.');
    }
    process.exit(0);
  }

  let failed = false;

  // Placement first: it never needs the user, and a key moved into its group
  // is useful even if the MCP part then waits for an answer.
  if (group !== undefined) {
    try {
      const r = vault.setKeyGroup(names, group, 'claude', { create: true });
      say(r.group
        ? r.names.join(', ') + ' placed in group "' + r.group + '"' + (r.created ? ' (new group).' : '.')
        : r.names.join(', ') + ' ungrouped.');
    } catch (e) {
      process.stderr.write('claude-vault: ' + errText(e) + '\n');
      failed = true;
    }
  }

  if (mcp) {
    const r = vault.aiChangeMcp({
      names, allow: mcp.allow, servers: mcp.servers, reason, by: 'claude', cwd: process.cwd()
    });
    if (r.status === 'refused') {
      process.stderr.write('claude-vault: MCP access unchanged: ' + r.why + '.' +
        (r.mode === 'off' ? ' Ask the user to change it in the Claude Vault view if it is needed.' : '') + '\n');
      failed = true;
    } else if (r.status === 'applied') {
      for (const k of r.keys) say(k.name + ': ' + scopeOf(k) + '.');
    } else {
      say('This needs the user (' + r.why + '): a request is waiting in VSCode for ' +
        r.request.names.join(', ') + '.');
      const answer = waitFor(r.request.rid);
      if (answer === 'approved') {
        const now = vault.listFast();
        for (const n of r.request.names) {
          const s = now.find(x => x.name === n);
          say('Approved. ' + n + ': ' + scopeOf(s) + '.');
        }
      } else if (answer === 'rejected') {
        process.stderr.write('claude-vault: the user refused. MCP access is unchanged; do not ask ' +
          'again without a new reason.\n');
        failed = true;
      } else if (answer === 'gone') {
        process.stderr.write('claude-vault: ' + GONE_TEXT + '\n');
        failed = true;
      } else {
        say('The user has not answered yet; the request is still waiting in VSCode. Nothing ' +
          'has changed. Do not send it again; tell the user it is pending.');
      }
    }
  }
  process.exit(failed ? 1 : 0);
} catch (e) {
  process.stderr.write('claude-vault: ' + errText(e) + '\n');
  process.exit(1);
}
