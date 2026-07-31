// Claude Vault, transparent MCP proxy (stdio).
//
//   node mcp-proxy.js --name <server-id> -- <command producing the MCP server>
//
// Sits between Claude Code and a local stdio MCP server, on the PROTOCOL path,
// never the network path. It makes no outbound call and relays no request; it
// is a pipe that touches exactly two things and passes everything else through
// byte for byte.
//
// Why this closes the leak that argument injection could not. In the injection
// path, a PreToolUse hook rewrites the tool input to the literal value, and
// Claude Code persists AND replays that rewritten input, so the value lands in
// the transcript and back in the model's context. Here, the model writes a
// marker {{vault:NAME}}; Claude Code persists and replays THAT marker, because
// what Claude Code sends to its "server" is the marker. The substitution to the
// real value happens downstream, inside this process, invisible to Claude Code,
// and the value goes only into the child server's stdin. On the way back, any
// echo of the value in the server's response is redacted before it reaches
// Claude Code. So the value never enters the transcript, at rest or in replay.
//
// The three properties that make it safe against a same-user attacker:
//   1. No standing secret. Nothing here holds a value at rest; a marker is
//      resolved only at the instant a tools/call carrying it passes through,
//      and the value is dropped once its response has been redacted.
//   2. Destination bound by construction. There is no shared endpoint to attack.
//      The only thing this proxy will ever feed a value to is the one child it
//      launched. The pipe is the parent-child link; nothing else can join it.
//   3. Closed transport. No TCP port, no socket anyone can connect to. stdio
//      inherited from Claude Code on one side, a private pipe to the child on
//      the other.
//
// Assumes the MCP stdio framing: one JSON-RPC message per line, no embedded
// newlines, which is what the stdio transport specifies.

'use strict';

const { spawn } = require('child_process');
const vault = require('./core.js');

const MARKER_RE = /\{\{\s*vault(-file)?\s*:\s*([A-Z][A-Z0-9_]{1,63})\s*\}\}/g;
const VALUE_TTL_MS = 300000;   // a value with no matching response is dropped

function fail(msg) {
  process.stderr.write('claude-vault: ' + msg + '\n');
  process.exit(1);
}

// --------------------------------------------------------------- command line

const argv = process.argv.slice(2);
const sep = argv.indexOf('--');
const head = sep === -1 ? argv : argv.slice(0, sep);
const cmd = sep === -1 ? [] : argv.slice(sep + 1);
let serverName = null;
for (let i = 0; i < head.length; i++) {
  if (head[i] === '--name') serverName = head[++i];
  else if (head[i].indexOf('--name=') === 0) serverName = head[i].slice(7);
}
if (!cmd.length) {
  fail('usage: mcp-proxy.js --name <server-id> -- <command producing the MCP server>');
}
if (!serverName) {
  fail('--name <server-id> is required: it is the key of this server in .mcp.json, ' +
       'so the PreToolUse hook knows to let markers reach this proxy untouched.');
}

// The hook reads this registration to know it must NOT substitute for this
// server (the proxy will). A stale registration only ever causes a marker to
// reach a server literally, a visibly broken call, never a leak.
try { vault.noteProxied(serverName); } catch (e) { /* the hook falls back safely */ }
let cleaned = false;
function cleanup() {
  if (cleaned) return;
  cleaned = true;
  try { vault.unnoteProxied(serverName); } catch (e) { /* best effort */ }
  try { vault.sweepTmp(3600000); } catch (e) { /* best effort */ }
}
process.on('exit', cleanup);

// ------------------------------------------------------------------ the child

// Spawned without a shell first, so an absolute path with spaces reaches the OS
// intact. Only .cmd shims (npx, npm) fail that way on Windows; we then retry
// through the shell. Shell-first would concatenate arguments and break any path
// with a space, so the order matters. The command is the user's own .mcp.json
// entry, not anything Claude wrote.
let child = null;

function startChild(useShell) {
  child = spawn(cmd[0], cmd.slice(1), {
    stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true, shell: !!useShell
  });
  child.on('error', e => {
    if (!useShell && process.platform === 'win32' && e.code === 'ENOENT') return startChild(true);
    fail('cannot start ' + cmd[0] + ': ' + e.message);
  });
  child.on('exit', (code, signal) => { cleanup(); process.exit(signal ? 1 : (code === null ? 1 : code)); });
  child.stdout.on('data', d => fromChild(d.toString('utf8')));
  child.stderr.on('data', d => {
    // Server logs go to stderr, and a "curl -v"-style server can echo a header
    // there. Redact before it reaches the terminal.
    const pairs = currentPairs();
    process.stderr.write(pairs.length ? vault.redactor(pairs)(d.toString('utf8')) : d);
  });
}

for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
  process.on(sig, () => { try { if (child) child.kill(sig); } catch (e) { /* already gone */ } });
}

// ----------------------------------------------------------- in-flight values

// id -> { pairs: [[name,value]...], at }. Held only until the matching response
// is redacted, then dropped. Never written to disk.
const inflight = new Map();

function currentPairs() {
  const now = Date.now();
  const pairs = [];
  for (const [id, rec] of inflight) {
    if (rec.at + VALUE_TTL_MS < now) { inflight.delete(id); continue; }
    for (const p of rec.pairs) pairs.push(p);
  }
  return pairs;
}

// ------------------------------------------------------------ message framing

function lineReader(onLine) {
  let buf = '';
  return chunk => {
    buf += chunk;
    let nl;
    while ((nl = buf.indexOf('\n')) !== -1) {
      const line = buf.slice(0, nl);
      buf = buf.slice(nl + 1);
      onLine(line);
    }
  };
}

function parse(line) {
  const s = line.trim();
  if (!s) return null;
  try { return JSON.parse(s); } catch (e) { return undefined; }   // undefined = not JSON
}

// ---------------------------------------------------- Claude Code -> child

function substituteArguments(node, pairs, problems) {
  if (typeof node === 'string') {
    return node.replace(MARKER_RE, (full, fileFlag, name) => {
      const s = vault.listFast().find(x => x.name === name && !x.expired);
      if (!s) { problems.push(name + ': unknown in the vault'); return full; }
      if (fileFlag) { problems.push(name + ': the file form does not make sense in an MCP call'); return full; }
      if (!s.mcp) { problems.push(name + ': not allowed for MCP calls (enable it in the Claude Vault view)'); return full; }
      // Authorised, but maybe not here: a key scoped to one server must not
      // leak into another server's tool call just because both are wrapped.
      if (!vault.mcpAllows(s, serverName)) {
        problems.push(name + ': allowed for MCP, but not for the server "' + serverName +
          '" (its list: ' + s.mcpServers.join(', ') + ')');
        return full;
      }
      try {
        const v = vault.consume(name, 'mcp-proxy:' + serverName).value;
        pairs.push([name, v]);
        return v;
      } catch (e) { problems.push(name + ': ' + e.message); return full; }
    });
  }
  if (Array.isArray(node)) return node.map(n => substituteArguments(n, pairs, problems));
  if (node && typeof node === 'object') {
    const o = {};
    for (const k of Object.keys(node)) o[k] = substituteArguments(node[k], pairs, problems);
    return o;
  }
  return node;
}

function sendToChild(obj) { child.stdin.write(JSON.stringify(obj) + '\n'); }
function sendToClaude(obj) { process.stdout.write(JSON.stringify(obj) + '\n'); }

const fromClaude = lineReader(line => {
  const msg = parse(line);

  // Not JSON, or nothing we transform: pass the raw line through untouched.
  if (msg === undefined || msg === null) { child.stdin.write(line + '\n'); return; }
  if (msg.method !== 'tools/call' || !msg.params || msg.params.arguments == null ||
      JSON.stringify(msg.params.arguments).indexOf('{{') === -1) {
    sendToChild(msg);
    return;
  }

  const pairs = [];
  const problems = [];
  const newArgs = substituteArguments(msg.params.arguments, pairs, problems);

  if (problems.length) {
    // Refuse this one call with a JSON-RPC error, never forward a half
    // substituted argument. The value, if any was consumed, still gets
    // redacted from nothing, so nothing leaks.
    sendToClaude({
      jsonrpc: '2.0', id: msg.id,
      error: { code: -32001, message: 'Claude Vault: ' + problems.join('; ') }
    });
    return;
  }

  if (pairs.length && msg.id != null) inflight.set(msg.id, { pairs, at: Date.now() });
  const forwarded = Object.assign({}, msg, {
    params: Object.assign({}, msg.params, { arguments: newArgs })
  });
  sendToChild(forwarded);
});

// ---------------------------------------------------- child -> Claude Code

// Apply the redactor to every string in the message, recursively. Same shape
// as the PostToolUse hook's redactDeep, kept here so the proxy needs nothing
// from the hook.
function redactDeep(node, red) {
  if (typeof node === 'string') return red(node);
  if (Array.isArray(node)) return node.map(n => redactDeep(n, red));
  if (node && typeof node === 'object') {
    const o = {};
    for (const k of Object.keys(node)) o[k] = redactDeep(node[k], red);
    return o;
  }
  return node;
}

function redactOutbound(msg) {
  const pairs = currentPairs();
  if (!pairs.length) return msg;
  return redactDeep(msg, vault.redactor(pairs));
}

const fromChild = lineReader(line => {
  const msg = parse(line);
  if (msg === undefined || msg === null) {
    // Non-JSON line from the server: redact it as raw text just in case.
    const pairs = currentPairs();
    process.stdout.write((pairs.length ? vault.redactor(pairs)(line) : line) + '\n');
    return;
  }
  const cleaned = redactOutbound(msg);
  sendToClaude(cleaned);
  // Final response for a call we injected into: drop its values now.
  if (msg.id != null && inflight.has(msg.id) && (msg.result !== undefined || msg.error !== undefined)) {
    inflight.delete(msg.id);
  }
});

startChild(false);

process.stdin.setEncoding('utf8');
process.stdin.on('data', d => fromClaude(d));
process.stdin.on('end', () => { try { if (child) child.stdin.end(); } catch (e) { /* child gone */ } });
