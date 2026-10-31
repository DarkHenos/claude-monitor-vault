// The owner's actions on the vault, from the pane.
//
//   node owner.js status                  what waits, as JSON: names and sizes only
//   node owner.js refuse-replace NAME     a refusal gives nothing away: no window
//   node owner.js refuse-mcp REQUEST_ID
//   node owner.js refuse-use REQUEST_ID
//   node owner.js --window ACTION [ARG]   opens the action in a window and waits
//
// ACTION: replace NAME, mcp-request ID, use ID, delete NAME, mcp NAME, bin, phrase,
// phrase-show, phrase-history, restore, transfer-out, transfer-in. These are the decisions that are the owner's alone, so they run only at
// a real console, and ask there: a command Claude runs has none, so it cannot answer
// its own request. The extension draws the same decisions in its modal dialogs.
'use strict';
const path = require('path');
const { BRIDGE, isFrench, reopenInWindow, askLine, askHidden, copy, paste } = require('./console.js');
const actions = require('./owner-actions.js');

const T = isFrench ? actions.TEXTS.fr : actions.TEXTS.en;

const HUMAN = {
  replace: actions.replace,
  'mcp-request': actions.mcpRequest,
  use: actions.use,
  delete: actions.remove,
  mcp: actions.mcpKey,
  bin: actions.bin,
  phrase: actions.phrase,
  'phrase-show': actions.phraseDisplay,
  'phrase-history': actions.phraseHistory,
  restore: actions.restore,
  'transfer-out': actions.transferOut,
  'transfer-in': actions.transferIn,
};
const HAS_ARGUMENT = new Set(['replace', 'mcp-request', 'use', 'delete', 'mcp']);
const ARGUMENT_RE = /^[A-Za-z0-9_-]{1,128}$/;

function die(message, code) {
  process.stderr.write('claude-vault: ' + message + '\n');
  process.exit(code);
}

const argv = process.argv.slice(2);
const isWindow = argv[0] === '--window';
const [action, argument] = isWindow ? argv.slice(1) : argv;

if (argument !== undefined && !ARGUMENT_RE.test(argument)) die('invalid argument', 2);

// Named by the bridge's own code: the hooks and these actions read the vault alike.
function loadVault() {
  try {
    return require(path.join(BRIDGE, 'core.js'));
  } catch (e) {
    return die('the vault bridge is not installed', 5);
  }
}

function refuse(answer) {
  process.stdout.write(answer() ? 'refused\n' : 'gone\n');
  process.exit(0);
}

const SIMPLE = {
  status: () => {
    process.stdout.write(JSON.stringify(actions.status(loadVault())) + '\n');
    process.exit(0);
  },
  'refuse-replace': () => refuse(() => loadVault().rejectReplace(String(argument))),
  'refuse-mcp': () => refuse(() => {
    const vault = loadVault();
    return typeof vault.rejectMcp === 'function' && vault.rejectMcp(String(argument));
  }),
  'refuse-use': () => refuse(() => loadVault().answerUse(String(argument), false)),
};

if (!isWindow && SIMPLE[action]) {
  try { SIMPLE[action](); } catch (e) { die(e && e.message ? e.message : String(e), 1); }
}

if (!HUMAN[action]) die('unknown action', 2);
if (HAS_ARGUMENT.has(action) && !argument) die('this action needs an argument', 2);

if (isWindow) reopenInWindow(__filename, argument ? [action, argument] : [action]);

if (!process.stdin.isTTY || !process.stdout.isTTY) {
  die('this decision belongs to a person at a console: it is not taken from a pipe or a script', 4);
}

async function main() {
  let isCleared = false;
  const context = {
    vault: loadVault(),
    wrap: () => require(path.join(__dirname, '..', 'bridge', 'install.js')).wrapMcpServers(),
    T,
    ui: {
      say: line => process.stdout.write(line + '\n'),
      ask: askLine,
      askHidden,
      copy,
      paste,
      clear: () => { console.clear(); isCleared = true; },
    },
  };
  let code = 0;
  try {
    const changed = await HUMAN[action](context, argument);
    code = changed ? 0 : 6;
  } catch (e) {
    process.stderr.write('claude-vault: ' + (e && e.message ? e.message : String(e)) + '\n');
    code = 1;
  }
  // A phrase just shown has been cleared; anything else stays readable until Enter.
  if (!isCleared) await askLine('\n' + T.enterClose);
  return code;
}

main().then(code => process.exit(code), () => process.exit(1));
