// Claude Vault, retrieval helper. Called ONLY from a command rewritten by the
// PreToolUse hook, with a single use token.
//
//   node get.js <token>
//
// Writes the value (or the path to the temp file) to stdout, with no trailing
// newline, and nothing else. The shell captures it via $( ): the value never
// passes through a command line argument, so it never shows up in the
// process list.
//
// The token is burned on first use, valid for 2 minutes, and bound to the
// requested key. Replaying a rewritten command therefore yields nothing.

'use strict';

const vault = require('./core.js');

const token = process.argv[2];
if (!token) {
  process.stderr.write('claude-vault: missing token\n');
  process.exit(1);
}

try {
  const rec = vault.redeemToken(token);
  const { value, entry, burned } = vault.consume(rec.name, 'hook:' + (rec.session || 'session'));

  // Leave a redaction hint keyed by the session. If the command echoes the
  // value back (an API error quoting the token, "curl -v" dumping the auth
  // header), PostToolUse can still mask it, even though consume() just burned
  // a single-use key and peek() would now find nothing. Sealed, not plaintext.
  try { vault.notePending(null, [rec.name], rec.session, { [rec.name]: value }); }
  catch (e) { /* redaction is a safety net, never block the real use for it */ }

  // writeSync, not process.stdout.write: writes to a pipe are ASYNCHRONOUS on
  // Windows, so the process.exit(0) below could cut a value larger than the
  // pipe buffer and hand the command a partial secret.
  if (rec.mode === 'file') {
    // ssh -i, certificate, service account: a path is expected, not the value.
    require('fs').writeSync(1, vault.materialize(entry.name, value));
  } else {
    require('fs').writeSync(1, value);
  }

  if (burned) process.stderr.write('claude-vault: ' + entry.name + ' burned after use\n');
  vault.sweepTmp(3600000);
  process.exit(0);
} catch (e) {
  // stderr only: never a partial value on stdout.
  process.stderr.write('claude-vault: ' + (e && e.message ? e.message : String(e)) + '\n');
  process.exit(1);
}
