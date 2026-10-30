// Creates a key from the pane. The pane only ever hands over a name: the value is
// typed here, in a window of its own, hidden, and goes straight to add.js through
// a pipe. So it crosses neither the mod, nor the conversation, nor a command line.
//
//   node new-key.js NAME --window   opens this prompt in a new window and waits
//   node new-key.js NAME            asks here, in the terminal it runs in
//
// Where no new window can be opened it exits with 3 and prints the command to run.
'use strict';
const { spawnSync } = require('child_process');
const path = require('path');
const { BRIDGE, isFrench, reopenInWindow, askLine, askHidden } = require('./console.js');

const NAME_RE = /^[A-Z][A-Z0-9_]{1,63}$/;
const ADD = path.join(BRIDGE, 'add.js');
const T = isFrench
  ? {
    title: name => `Claude Vault : nouvelle clé ${name}`,
    note: 'À quoi sert cette clé ? ',
    value: 'Valeur (rien ne s\'affiche, Entrée pour valider) : ',
    defaultNote: 'Créée depuis le panneau Claude Vault',
    cancelled: 'Annulé : aucune clé créée.',
    close: 'Appuyez sur Entrée pour fermer.',
  }
  : {
    title: name => `Claude Vault: new key ${name}`,
    note: 'What is this key for? ',
    value: 'Value (nothing shows, Enter to confirm): ',
    defaultNote: 'Created from the Claude Vault pane',
    cancelled: 'Cancelled: no key created.',
    close: 'Press Enter to close.',
  };

const name = String(process.argv[2] || '').toUpperCase();
if (!NAME_RE.test(name)) {
  process.stderr.write('claude-vault: invalid key name\n');
  process.exit(2);
}

if (process.argv[3] === '--window') reopenInWindow(__filename, [name]);

// A pipe in place of a window, for the tests: the note, then the value, a line each.
function readPipe() {
  return new Promise(resolve => {
    let text = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', chunk => { text += chunk; });
    process.stdin.on('end', () => {
      const [note = '', value = ''] = text.split(/\r?\n/);
      resolve({ note: note.trim(), value });
    });
  });
}

async function pause() {
  if (process.stdin.isTTY) await askLine(T.close);
}

async function main() {
  let note;
  let value;
  if (process.stdin.isTTY) {
    process.stdout.write(T.title(name) + '\n\n');
    note = await askLine(T.note);
    value = await askHidden(T.value);
  } else {
    ({ note, value } = await readPipe());
  }

  if (!value) {
    process.stdout.write(T.cancelled + '\n');
    await pause();
    return 1;
  }

  const added = spawnSync(process.execPath, [ADD, name, '--note', note || T.defaultNote], { input: value, encoding: 'utf8' });
  value = '';
  process.stdout.write(added.stdout || '');
  process.stderr.write(added.stderr || '');
  await pause();
  return added.status === null ? 1 : added.status;
}

main().then(code => process.exit(code), () => process.exit(1));
