// What the vault's own windows share: opening one, and asking a person in it.
'use strict';
const { spawnSync } = require('child_process');
const os = require('os');
const path = require('path');
const readline = require('readline');

const BRIDGE = path.join(process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude'), 'claude-vault-bridge');

const isFrench = new Intl.DateTimeFormat().resolvedOptions().locale.toLowerCase().startsWith('fr');

// Reopens a script in a new window and waits for it to close. Where none can be
// opened, exits with 3 and prints the command to run in a terminal.
function reopenInWindow(script, args) {
  if (process.platform !== 'win32') {
    process.stdout.write(`node "${script}" ${args.join(' ')}\n`);
    process.exit(3);
  }
  const shown = spawnSync('cmd', ['/c', 'start', 'Claude Vault', '/wait', process.execPath, script, ...args]);
  process.exit(shown.status === null ? 1 : shown.status);
}

function askLine(question) {
  return new Promise(resolve => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    rl.question(question, answer => { rl.close(); resolve(answer.trim()); });
  });
}

// Hidden, one key at a time. Ends at the first Enter, so a value holds one line.
function askHidden(question) {
  return new Promise(resolve => {
    process.stdout.write(question);
    const input = process.stdin;
    let value = '';
    const finish = result => {
      input.removeListener('data', onData);
      input.setRawMode(false);
      input.pause();
      process.stdout.write('\n');
      resolve(result);
    };
    const onData = chunk => {
      for (const ch of chunk.toString('utf8')) {
        if (ch === '\r' || ch === '\n') return finish(value);
        if (ch === '\u0003') return finish('');
        if (ch === '\b' || ch === '\u007f') value = value.slice(0, -1);
        else value += ch;
      }
    };
    input.setRawMode(true);
    input.resume();
    input.on('data', onData);
  });
}

module.exports = { BRIDGE, isFrench, reopenInWindow, askLine, askHidden };
