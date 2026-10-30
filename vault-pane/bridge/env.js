// Claude Vault, credential launcher for MCP servers.
//
//   node env.js -- <command> [args...]
//
// Reads its OWN environment, replaces any vault marker it finds there by the
// real value, then launches the command with that environment and steps aside.
//
// This is deliberately not a proxy. We do not intercept calls, we do not relay
// requests, we are not on the path of anything. We start the process the user
// already wanted to start, with the environment that process already expected,
// and then we do nothing but forward its exit code.
//
// In .mcp.json or in the Claude Code settings:
//
//   {
//     "command": "node",
//     "args": ["C:/Users/you/.claude/claude-vault-bridge/env.js", "--", "npx", "-y", "some-mcp"],
//     "env": { "SERVICE_API_KEY": "<the vault marker for that key>" }
//   }
//
// What this buys, compared with substituting the value into tool arguments:
// the secret never appears in an argument, so it cannot reach the transcript,
// and .mcp.json holds a marker instead of a key, so it can be committed. The
// value only ever exists in the environment of the server that needs it.
//
// The file form of the marker is honoured too: it materialises a temporary
// file and exports its path, for a server that expects a certificate or a key
// file rather than a string.

'use strict';

const { spawn } = require('child_process');
const vault = require('./core.js');

const MARKER_RE = /\{\{\s*vault(-file)?\s*:\s*([A-Z][A-Z0-9_]{1,63})\s*\}\}/g;

function die(msg) {
  // The MCP server will not start, and this line is the only place the user
  // will look. It has to say what is missing and where to fix it.
  process.stderr.write('claude-vault: ' + msg + '\n');
  process.exit(1);
}

const sep = process.argv.indexOf('--');
const argv = sep === -1 ? process.argv.slice(2) : process.argv.slice(sep + 1);
if (!argv.length) {
  die('usage: node env.js -- <command> [args...]\n' +
      'Put a vault marker in the env block of your MCP server configuration.');
}

const env = Object.assign({}, process.env);
const resolved = [];

for (const name of Object.keys(env)) {
  const raw = env[name];
  if (typeof raw !== 'string' || raw.indexOf('{{') === -1) continue;

  MARKER_RE.lastIndex = 0;
  const found = [];
  let m;
  while ((m = MARKER_RE.exec(raw))) found.push({ whole: m[0], file: !!m[1], key: m[2] });
  if (!found.length) continue;

  let out = raw;
  for (const f of found) {
    let value;
    try {
      // Who is asking, for the log. Defaults to the MCP case this file was
      // written for; the vault terminal sets it to say so instead.
      const who = (process.env.CLAUDE_VAULT_WHO || 'mcp-env') + ':' + name;
      const r = vault.consume(f.key, who);
      // A server expecting a path wants a file, not the contents of one.
      value = f.file ? vault.materialize(f.key, r.value) : r.value;
    } catch (e) {
      die((e && e.message ? e.message : String(e)) +
          '\nThe MCP server was not started, because ' + name + ' would have been wrong. ' +
          'Create the key in the Claude Vault view in VSCode, then start the server again.');
    }
    out = out.split(f.whole).join(value);
  }
  env[name] = out;
  resolved.push(name);
}

if (resolved.length) {
  // Names only. This reaches the server's stderr, which is what a user reads
  // when debugging a configuration, so it must never carry a value.
  process.stderr.write('claude-vault: resolved ' + resolved.join(', ') + '\n');
}

// Spawned without a shell, so the arguments reach the server exactly as they
// were written, spaces included. On Windows that fails for npx and npm, which
// are .cmd shims and are not executables: only then do we retry through the
// shell. Trying the shell first would have meant concatenating arguments
// instead of passing them, which quietly breaks any argument with a space.
function start(useShell) {
  // stdio inherited: MCP speaks over stdin and stdout, and putting anything of
  // ours between the two ends would corrupt the protocol.
  const child = spawn(argv[0], argv.slice(1), {
    env, stdio: 'inherit', windowsHide: true, shell: !!useShell
  });

  // We are the parent of the real server, so signals sent to us are meant for
  // it. Without this, stopping Claude Code would leave orphans behind.
  for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
    process.on(sig, () => { try { child.kill(sig); } catch (e) { /* already gone */ } });
  }

  child.on('error', e => {
    if (!useShell && process.platform === 'win32' && e.code === 'ENOENT') return start(true);
    die('cannot start ' + argv[0] + ': ' + e.message);
  });
  child.on('exit', (code, signal) => {
    try { vault.sweepTmp(3600000); } catch (e) { /* best effort */ }
    process.exit(signal ? 1 : (code === null ? 1 : code));
  });
}

start(false);
