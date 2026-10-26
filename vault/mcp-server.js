'use strict';
// Local stdio tool server: values travel only through the child environment.
// It deliberately offers no tool that returns a secret.
//
// 1.2: ChatGPT / Codex gets the same powers as Claude's bridge scripts, under
// the same rules, decided in core.js: create a key from a program's output
// (vault_create, the value never comes back), change MCP access or groups
// (vault_set), reorganise the layout (vault_layout). Every action is signed
// 'codex' in the journal. A core without these functions (an older bridge, a
// test stub) simply does not get the new tools.
const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');
const readline = require('readline');
const vault = require('./core');
const rootIndex = process.argv.indexOf('--root');
if (rootIndex < 0 || !process.argv[rootIndex + 1]) throw new Error('--root is required');
const root = fs.realpathSync(process.argv[rootIndex + 1]);
const SERVER = 'claude-monitor-vault';
const BY = 'codex';
const accessIndex = process.argv.indexOf('--access');
const claudeAccess = accessIndex >= 0 && process.argv[accessIndex + 1] === 'claude';
const send = msg => process.stdout.write(JSON.stringify(msg) + '\n');
const has = fn => typeof vault[fn] === 'function';
const V12 = ['layout', 'aiCreateKey', 'aiChangeMcp', 'setKeyGroup', 'createGroup', 'renameGroup',
  'deleteGroup', 'addSeparator', 'editSeparator', 'removeSeparator', 'moveItem', 'mcpRequestState',
  'policyFast'].every(has);
const WAIT_MS = 50000;            // under a typical MCP client timeout
const CREATE_MAX = 64 * 1024;     // a key, not a file dump
// Two access modes, and the advice differs. With --access claude, vault_run
// reaches every key, so "none" is enough for it. With --access mcp, vault_run
// only reaches keys allowed for this very server, and a key created with "none"
// is invisible to it: the texts must say so, or ChatGPT keeps creating keys it
// cannot use. Built once claudeAccess is known (above).
const RUN_ADVICE = claudeAccess
  ? null
  : 'vault_run here only uses keys allowed for "' + SERVER + '": pass mcp:["' + SERVER + '"] (applies at creation when the setting is ask) or add it later with vault_set.';
const mcpSchema = { description: claudeAccess
  ? '"none" (shell and vault_run only), "all" (every MCP server, always asks the user) or a list of MCP server names.'
  : '"none" (shell only: vault_run cannot use it here), "all" (every MCP server, always asks the user) or a list of MCP server names; include "' + SERVER + '" for vault_run.',
  oneOf: [{ type: 'string', enum: ['none', 'all'] }, { type: 'array', items: { type: 'string' } }] };
const tools = [
  { name: 'vault_list', description: 'List metadata of secrets permitted for this MCP server, in the user\'s layout order (groups, separators), with each key\'s group and MCP scope. Never returns values.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false } },
  { name: 'vault_run', description: 'Run a program in this project with named vault secrets as environment variables. Output is buffered and redacted. No shell expansion. Never request a secret value directly.',
    inputSchema: { type: 'object', properties: {
      program: { type: 'string', description: 'Executable, for example node, git or curl.' },
      args: { type: 'array', items: { type: 'string' } },
      env: { type: 'object', description: 'Environment variable name to vault key name, e.g. GITHUB_TOKEN: GITHUB_TOKEN.', additionalProperties: { type: 'string' } }
    }, required: ['program', 'env'], additionalProperties: false } }
];
if (V12) tools.push(
  { name: 'vault_create', description: 'Create a vault key whose value is the standard output of a program (run without a shell, in this project, 60 s, 64 KB at most). The value goes straight into the vault and is never returned. Decide MCP access now: ' + (claudeAccess ? '"none" when only vault_run or the shell needs it' : '["' + SERVER + '"] when vault_run needs it (vault_run here only uses keys allowed for this server), "none" for the shell only') + ', a list of named servers, or "all" (always asks the user). A value already stored under another name is refused.',
    inputSchema: { type: 'object', properties: {
      name: { type: 'string', description: 'Key name, e.g. STRIPE_SECRET_KEY.' },
      note: { type: 'string', description: 'What the key is for and where the code reads it. Never the value.' },
      program: { type: 'string', description: 'Executable producing the value on stdout, e.g. openssl.' },
      args: { type: 'array', items: { type: 'string' } },
      mcp: mcpSchema,
      group: { type: 'string', description: 'Group to place the key in (created if missing, when the user allows it).' },
      reason: { type: 'string', description: 'One line shown to the user if MCP access needs their approval.' }
    }, required: ['name', 'note', 'program'], additionalProperties: false } },
  { name: 'vault_set', description: 'Change MCP access and/or the group of existing keys. Removing or narrowing MCP access applies at once; granting or widening follows the user\'s setting and may wait for their approval in VSCode (a reason is required). Placement applies at once.',
    inputSchema: { type: 'object', properties: {
      names: { type: 'array', items: { type: 'string' }, description: 'Key names.' },
      mcp: mcpSchema,
      group: { type: ['string', 'null'], description: 'Group name (created if missing), or null to ungroup.' },
      reason: { type: 'string', description: 'Why the access is needed, one line, 200 characters at most. Required to grant or widen; not needed to remove or narrow.' }
    }, required: ['names'], additionalProperties: false } },
  { name: 'vault_layout', description: 'Reorganise the vault layout: groups and separators. Positions count groups and separators from 1 at the top.',
    inputSchema: { type: 'object', properties: {
      op: { type: 'string', enum: ['createGroup', 'renameGroup', 'deleteGroup', 'addSeparator', 'editSeparator', 'removeSeparator', 'move'] },
      name: { type: 'string', description: 'Group name, or separator label or id (renameGroup, deleteGroup, editSeparator, removeSeparator, move; the new name for createGroup).' },
      newName: { type: 'string', description: 'renameGroup: the new name.' },
      label: { type: 'string', description: 'addSeparator / editSeparator: the label, optional.' },
      id: { type: 'string', description: 'Separator id, as an alternative to its label.' },
      position: { type: 'integer', minimum: 1, description: 'createGroup / addSeparator (optional), move (required).' }
    }, required: ['op'], additionalProperties: false } }
);
function allowed() { return vault.listFast().filter(s => !s.expired && vault.mcpAllows(claudeAccess ? { ...s, mcp: true } : s, SERVER)); }
function scopeOf(s) { return !s.mcp ? 'none' : (s.mcpServers && s.mcpServers.length ? s.mcpServers.slice() : 'all'); }
function policyLine() {
  if (!has('policyFast')) return null;
  const p = vault.policyFast(BY);
  return { mcpByAI: p.mcpByAI, layoutByAI: p.layoutByAI };
}
const RULES = [
  RUN_ADVICE || 'vault_run never needs MCP access: MCP access is only for MCP tool calls of other servers.',
  'When MCP access is needed, name the server rather than "all"; avoid blanket MCP access.',
  'Keep related keys in one group (vault_set group, vault_layout).',
  'Granting or widening MCP access may wait for the user; removing it applies at once.'
];
// Keys in layout order: each group's keys under it, the ungrouped ones last,
// a dated copy flagged as the newer copy of its base key.
function listing() {
  const keys = allowed();
  const names = vault.listFast().map(s => s.name);
  const meta = s => ({ name: s.name, note: s.note || '', confirm: !!s.confirm, group: s.group || null,
    mcp: !!s.mcp, mcpServers: s.mcpServers || null, scope: scopeOf(s),
    newerCopyOf: has('rotationOf') ? vault.rotationOf(s.name, names) : null });
  const layout = vault.layout().map(i => i.type === 'group' ? { type: 'group', name: i.name } : { type: 'separator', label: i.label || null });
  const ordered = [];
  for (const i of vault.layout()) if (i.type === 'group') for (const s of keys) if (s.groupId === i.id) ordered.push(meta(s));
  for (const s of keys) if (!s.groupId) ordered.push(meta(s));
  return { layout, keys: ordered, policy: policyLine(), rules: RULES };
}
function instructions() {
  let text = 'Use vault_list to discover authorized key names. Use vault_run with env mapping to use them. Never print, encode, write or transmit credentials except to the intended service. Read project shared memory before work.';
  if (!V12) return text;
  try {
    const p = vault.policyFast(BY);
    const l = listing();
    const groups = l.layout.filter(i => i.type === 'group').map(i => {
      const ks = l.keys.filter(k => k.group === i.name).map(k => k.name);
      return i.name + ': ' + (ks.length ? ks.join(', ') : 'empty group');
    });
    const rest = l.keys.filter(k => !k.group).map(k => k.name + (k.newerCopyOf ? ' (newer copy of ' + k.newerCopyOf + ')' : ''));
    if (groups.length || rest.length) text += ' Keys now: ' + groups.concat(rest.length ? ['Ungrouped: ' + rest.join(', ')] : []).join('; ') + '.';
    const mcpKeys = l.keys.filter(k => k.mcp).map(k => k.name + ' (' + (k.scope === 'all' ? 'all servers' : 'servers: ' + k.scope.join(', ')) + ')');
    if (mcpKeys.length) text += ' Allowed for MCP tool calls: ' + mcpKeys.join(', ') + '.';
    text += ' To create a key use vault_create (the value comes from a program and never returns); to change MCP access or groups use vault_set; to reorganise use vault_layout. ' + RULES.join(' ') +
      ' MCP access setting: ' + p.mcpByAI + (p.mcpByAI === 'off' ? ' (you cannot change MCP access; ask the user).' : p.mcpByAI === 'auto' ? ' (grants apply on their own, except keys that confirm every use, every server, or remote servers).' : ' (removing applies; granting at creation on named local servers applies; anything else asks the user).') +
      (p.layoutByAI ? '' : ' The user does not let you reorganise keys.');
  } catch (_) { /* the base text is enough */ }
  return text;
}
function mcpArg(v) {
  if (v === undefined) return undefined;
  if (v === 'none') return { allow: false, servers: null };
  if (v === 'all') return { allow: true, servers: null };
  if (Array.isArray(v) && v.every(x => typeof x === 'string')) {
    if (!v.length) throw new Error('mcp: name at least one server, or use "all"');
    return { allow: true, servers: vault.parseServerList(v) };
  }
  throw new Error('mcp must be "none", "all" or a list of server names');
}
function noteHoldsValue(txt, value) {
  if (value.length < 8) return false;
  if (txt.indexOf(value) !== -1) return true;
  return txt.indexOf(value.slice(0, Math.max(12, Math.floor(value.length / 2)))) !== -1;
}
function stamp(txt) {
  const d = new Date();
  const day = d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
  return String(txt).replace(/\s+/g, ' ').trim() + ' [added by ChatGPT ' + day + ']';
}
const sleep = ms => new Promise(r => setTimeout(r, ms));
// 'gone': dropped unanswered. Not "still waiting", which would forbid asking again.
const GONE_NOTE = 'The request was withdrawn before the user answered (a key changed or was removed, the request expired, or MCP changes by the AI were turned off). Nothing changed; file it again only if it is still needed.';
async function waitFor(rid) {
  const until = Date.now() + WAIT_MS;
  while (Date.now() < until) {
    const st = vault.mcpRequestState(rid);
    if (st !== 'pending') return st;
    await sleep(500);
  }
  return 'pending';
}
function errorOf(e) {
  let m = e && e.message ? e.message : String(e);
  if (e && e.suggestions && e.suggestions.length) m += ' (did you mean ' + e.suggestions.join(', ') + '?)';
  return m;
}
// The program's stdout IS the value: it is never returned, logged or echoed,
// and neither is stderr, which a failing program may fill with the same text.
function produce(program, args) {
  return new Promise((resolve, reject) => {
    execFile(program, args || [], {
      cwd: root, env: process.env, windowsHide: true, timeout: 60000,
      maxBuffer: CREATE_MAX, encoding: 'utf8', shell: false
    }, (error, stdout) => {
      if (error) {
        const why = error.killed || error.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER'
          ? 'the program timed out or wrote more than 64 KB'
          : 'the program failed' + (typeof error.code === 'number' ? ' (exit code ' + error.code + ')' : '');
        reject(new Error(why + ': nothing was stored'));
        return;
      }
      resolve(String(stdout || '').replace(/\r?\n$/, ''));
    });
  });
}
async function createKey(args) {
  if (!args || typeof args.name !== 'string' || typeof args.note !== 'string' || typeof args.program !== 'string'
      || !args.program || args.program.includes('\0')
      || (args.args !== undefined && (!Array.isArray(args.args) || args.args.some(a => typeof a !== 'string')))
      || (args.group !== undefined && typeof args.group !== 'string')
      || (args.reason !== undefined && typeof args.reason !== 'string')) throw new Error('Invalid creation arguments');
  if (!args.note.trim()) throw new Error('note is required: say what the key is for and where the code reads it');
  const name = vault.validateName(args.name);
  if (vault.listFast().some(s => s.name === name)) throw new Error(name + ' already exists, so nothing was created. Changing a value stays with the user.');
  const decision = mcpArg(args.mcp);
  let value = await produce(args.program, args.args);
  if (!value.length) throw new Error('the program printed nothing: nothing was stored');
  if (noteHoldsValue(args.note, value)) { value = null; throw new Error('the note contains the value itself: describe the key, never repeat it. Nothing was stored.'); }
  let r;
  try {
    r = vault.aiCreateKey({ name, value, note: stamp(args.note), by: BY, cwd: root,
      mcp: decision || null, group: args.group, reason: args.reason });
  } finally { value = null; }
  const out = { name: r.name, kind: has('kindSource') ? vault.kindSource(r.kind) : r.kind, length: r.length,
    group: r.group, groupCreated: !!r.groupCreated, note: r.groupNote || undefined,
    mcp: { status: r.mcp.status, servers: r.mcp.servers === undefined ? undefined : (r.mcp.servers || 'all'), why: r.mcp.why, error: r.mcp.error } };
  if (r.mcp.status === 'requested') {
    out.mcp.answer = await waitFor(r.mcp.request.rid);
    if (out.mcp.answer === 'approved') { const s = vault.listFast().find(x => x.name === r.name); out.mcp.scope = s ? scopeOf(s) : null; }
    if (out.mcp.answer === 'gone') out.mcp.note = GONE_NOTE;
  }
  if (!decision) {
    out.hint = claudeAccess
      ? 'No MCP decision was given: the key works with vault_run only. If an MCP tool of another server needs it, use vault_set with a reason.'
      : 'No MCP decision was given, so the key has no MCP access and ' + RUN_ADVICE;
  }
  out.use = claudeAccess
    ? 'Use it with vault_run (env mapping).'
    : 'Use it with vault_run (env mapping) once it is allowed for "' + SERVER + '", or ask the user.';
  return JSON.stringify(out);
}
async function setKeys(args) {
  if (!args || !Array.isArray(args.names) || !args.names.length || args.names.length > 50 || args.names.some(n => typeof n !== 'string')
      || (args.reason !== undefined && typeof args.reason !== 'string')
      || (args.group !== undefined && args.group !== null && typeof args.group !== 'string')) throw new Error('Invalid arguments: names is a list of 1 to 50 key names');
  const decision = mcpArg(args.mcp);
  if (!decision && args.group === undefined) throw new Error('Nothing to change: give mcp and/or group');
  // The reason is checked in core (aiChangeMcp): required for a grant, not for
  // a removal or a narrowing, the same answer Claude's set.js gets.
  const out = {};
  if (args.group !== undefined) {
    try { out.group = vault.setKeyGroup(args.names, args.group, BY, { create: true }); }
    catch (e) { out.group = { error: errorOf(e) }; }
  }
  if (decision) {
    const r = vault.aiChangeMcp({ names: args.names, allow: decision.allow, servers: decision.servers, reason: args.reason, by: BY, cwd: root });
    out.mcp = { status: r.status, why: r.why };
    if (r.status === 'applied') out.mcp.keys = r.keys.map(k => ({ name: k.name, scope: scopeOf(k) }));
    if (r.status === 'requested') {
      out.mcp.answer = await waitFor(r.request.rid);
      const now = vault.listFast();
      out.mcp.keys = r.request.names.map(n => { const s = now.find(x => x.name === n); return { name: n, scope: s ? scopeOf(s) : null }; });
      if (out.mcp.answer === 'pending') out.mcp.note = 'The request is still waiting in VSCode. Do not send it again; tell the user.';
      if (out.mcp.answer === 'gone') out.mcp.note = GONE_NOTE;
    }
  }
  if (!decision && out.group && out.group.error) throw new Error(out.group.error);
  return JSON.stringify(out);
}
function layoutOp(args) {
  const a = args || {};
  const pos = a.position === undefined ? undefined : Number(a.position);
  if (pos !== undefined && (!Number.isInteger(pos) || pos < 1)) throw new Error('position counts from 1 (the top)');
  const at = pos === undefined ? undefined : pos - 1;
  const target = typeof a.id === 'string' && a.id ? a.id : a.name;
  const needName = () => { if (typeof a.name !== 'string' || !a.name.trim()) throw new Error('name is required for ' + a.op); };
  let result;
  if (a.op === 'createGroup') { needName(); result = vault.createGroup(a.name, at, BY); }
  else if (a.op === 'renameGroup') { needName(); if (typeof a.newName !== 'string') throw new Error('newName is required'); result = vault.renameGroup(a.name, a.newName, BY); }
  else if (a.op === 'deleteGroup') { needName(); result = vault.deleteGroup(a.name, BY); }
  else if (a.op === 'addSeparator') result = vault.addSeparator(typeof a.label === 'string' ? a.label : null, at, BY);
  else if (a.op === 'editSeparator') { if (typeof target !== 'string') throw new Error('id or name (the current label) is required'); result = vault.editSeparator(target, typeof a.label === 'string' ? a.label : null, BY); }
  else if (a.op === 'removeSeparator') { if (typeof target !== 'string') throw new Error('id or name (the label) is required'); result = vault.removeSeparator(target, BY); }
  else if (a.op === 'move') { if (typeof target !== 'string') throw new Error('name (group or separator) is required'); if (at === undefined) throw new Error('position is required for move'); result = vault.moveItem(target, at, BY); }
  else throw new Error('Unknown layout operation');
  return JSON.stringify({ result, layout: vault.layout().map(i => i.type === 'group' ? { type: 'group', name: i.name } : { type: 'separator', id: i.id, label: i.label || null }) });
}
async function call(name, args) {
  if (name === 'vault_list') {
    // A core without layouts (older bridge, test stub) keeps the 1.1 answer.
    if (!has('layout')) return JSON.stringify(allowed().map(s => ({ name: s.name, note: s.note || '', confirm: !!s.confirm })));
    return JSON.stringify(listing());
  }
  if (V12 && name === 'vault_create') return createKey(args);
  if (V12 && name === 'vault_set') return setKeys(args);
  if (V12 && name === 'vault_layout') return layoutOp(args);
  if (name !== 'vault_run') throw new Error('Unknown vault tool');
  if (!args || typeof args.program !== 'string' || !args.program || args.program.includes('\0')
      || !args.env || typeof args.env !== 'object' || Array.isArray(args.env)
      || (args.args !== undefined && (!Array.isArray(args.args) || args.args.some(a => typeof a !== 'string')))) throw new Error('Invalid execution arguments');
  const names = Object.entries(args.env);
  if (!names.length || names.length > 20) throw new Error('Choose between 1 and 20 environment variables');
  const entries = allowed();
  for (const [variable, key] of names) {
    if (!/^[A-Z_][A-Z0-9_]*$/.test(variable) || typeof key !== 'string' || !entries.some(s => s.name === key)) {
      throw new Error('A key or environment variable is not permitted for this server');
    }
  }
  const pairs = [];
  const environment = { ...process.env };
  for (const [variable, key] of names) {
    let pair = pairs.find(p => p[0] === key);
    if (!pair) { pair = [key, vault.consume(key, 'codex:mcp:' + SERVER).value]; pairs.push(pair); }
    environment[variable] = pair[1];
  }
  const redact = vault.redactor(pairs);
  return new Promise(resolve => {
    execFile(args.program, args.args || [], {
      cwd: root, env: environment, windowsHide: true, timeout: 60000,
      maxBuffer: 1024 * 1024, encoding: 'utf8', shell: false
    }, (error, stdout, stderr) => {
      resolve(JSON.stringify({ exitCode: error ? (typeof error.code === 'number' ? error.code : 1) : 0,
        stdout: redact(stdout), stderr: redact(stderr),
        error: error ? (error.killed ? 'Process timed out or exceeded its output limit' : 'Process failed') : null }));
    });
  });
}
async function handle(msg) {
  if (!msg || msg.id === undefined) return;
  try {
    let result;
    if (msg.method === 'initialize') result = { protocolVersion: '2024-11-05', capabilities: { tools: {} },
      serverInfo: { name: SERVER, version: '1.2.0' },
      instructions: instructions() };
    else if (msg.method === 'ping') result = {};
    else if (msg.method === 'tools/list') result = { tools };
    else if (msg.method === 'tools/call') {
      try { result = { content: [{ type: 'text', text: await call(msg.params.name, msg.params.arguments || {}) }] }; }
      catch (e) { result = { isError: true, content: [{ type: 'text', text: errorOf(e) }] }; }
    } else { send({ jsonrpc: '2.0', id: msg.id, error: { code: -32601, message: 'Unknown method' } }); return; }
    send({ jsonrpc: '2.0', id: msg.id, result });
  } catch (_) { send({ jsonrpc: '2.0', id: msg.id, error: { code: -32603, message: 'Vault request failed' } }); }
}
// Sequential calls prevent this server from double-consuming one-use keys.
let queue = Promise.resolve();
const reader = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
reader.on('line', line => {
  if (Buffer.byteLength(line) > 1024 * 1024) { reader.close(); process.stdin.destroy(); return; }
  let msg; try { msg = JSON.parse(line); } catch (_) { return; }
  queue = queue.then(() => handle(msg));
});
