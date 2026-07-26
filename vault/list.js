// Claude Vault, read only listing. One of the two vault entry points Claude is
// allowed to run directly.
//
//   node list.js
//
// It prints one key name per line, nothing else. Names are what you need in
// order to know what you can call; anything more would be noise in a context
// window.
//
// It never prints a value, and that is a property of the code rather than a
// promise: the only function it calls is listFast(), which reads the metadata
// block of the vault file and never touches the master key. There is no code
// path from here to a plaintext secret.
//
// It takes no argument. Anything on the command line is refused rather than
// ignored, so that a future option can never be smuggled in through a command
// the guard let through.

'use strict';

const vault = require('./core.js');

if (process.argv.length > 2) {
  process.stderr.write('claude-vault: list takes no argument\n');
  process.exit(1);
}

try {
  const names = vault.listFast().filter(s => !s.expired).map(s => s.name);
  process.stdout.write(names.length
    ? names.join('\n') + '\n'
    : 'Claude Vault is empty.\n');
  process.exit(0);
} catch (e) {
  process.stderr.write('claude-vault: ' + (e && e.message ? e.message : String(e)) + '\n');
  process.exit(1);
}
