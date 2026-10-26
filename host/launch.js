// Starts a program in an IDE terminal with extra environment variables.
//
// VS Code's createTerminal takes an environment; the IntelliJ terminal only
// takes a command line. This launcher receives the command, its arguments and
// the environment as one base64 JSON argument, and runs the program attached
// to the same terminal.
//
// The vault terminal passes markers ({{vault:NAME}}) here, never values:
// vault/env.js, started by this launcher, is what resolves them.

'use strict';

const { spawn } = require('child_process');

let spec;
try {
  spec = JSON.parse(Buffer.from(String(process.argv[2] || ''), 'base64').toString('utf8'));
} catch (e) {
  console.error('launch.js: unreadable launch specification');
  process.exit(2);
}

const child = spawn(spec.command, Array.isArray(spec.args) ? spec.args : [], {
  stdio: 'inherit',
  cwd: spec.cwd || process.cwd(),
  env: Object.assign({}, process.env, spec.env || {}),
  windowsHide: false
});

// Ctrl+C reaches the program through the shared console; the launcher only
// waits for it to finish.
process.on('SIGINT', () => {});
child.on('error', e => { console.error(e.message); process.exit(1); });
child.on('exit', code => process.exit(code === null ? 1 : code));
