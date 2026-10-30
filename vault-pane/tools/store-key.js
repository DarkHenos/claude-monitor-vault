// Stores a key from the pane's form. Everything comes on stdin as JSON, so the value
// is on no command line: { "name", "value", "note", "hasMcp" }. Prints the name only.
// Exits 2 on a bad request, 7 when the name is taken, 5 without a bridge.
//
// hasMcp is the owner's own choice in the form, which is why it is granted at once
// rather than requested. The mod denies commands of Claude's that name this file.
'use strict';
const path = require('path');
const { BRIDGE } = require('./console.js');

const NAME_RE = /^[A-Z][A-Z0-9_]{1,63}$/;

function die(message, code) {
  process.stderr.write('claude-vault: ' + message + '\n');
  process.exit(code);
}

let text = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', chunk => { text += chunk; });
process.stdin.on('end', () => {
  let asked;
  try { asked = JSON.parse(text); } catch (e) { die('bad request', 2); }
  text = '';
  const { name, value, note, hasMcp } = asked || {};
  if (typeof name !== 'string' || !NAME_RE.test(name)) die('invalid key name', 2);
  if (typeof value !== 'string' || !value) die('no value', 2);

  let vault;
  try { vault = require(path.join(BRIDGE, 'core.js')); }
  catch (e) { die('the vault bridge is not installed', 5); }

  try {
    if (vault.listFast().some(s => s.name === name)) die(name + ' already exists', 7);
    vault.put(name, value, { note: typeof note === 'string' ? note : undefined, by: 'user' });
    if (hasMcp === true) {
      vault.setMcp(name, true);
      // Routes the local MCP servers through the vault, as the extension does on a grant.
      try { require(path.join(__dirname, '..', 'bridge', 'install.js')).wrapMcpServers(); }
      catch (e) { /* the grant stands; a server can be wrapped by hand */ }
    }
  } catch (e) {
    die(e && e.message ? e.message : String(e), 1);
  }
  process.stdout.write(name + '\n');
  process.exit(0);
});
