// The owner's decisions in vault-pane, with the extension nowhere: approvals,
// deletion, the bin and the recovery phrase, on a vault in a temporary home. The
// window is replaced by a script of answers; the check that a real console is
// required is exercised against owner.js itself.
'use strict';
const { spawnSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'vault-pane-owner-'));
const config = path.join(home, '.claude');
// Before anything loads the vault: its paths are fixed when core.js loads.
process.env.USERPROFILE = home;
process.env.HOME = home;
process.env.CLAUDE_CONFIG_DIR = config;

const TOOLS = path.join(__dirname, '..', 'vault-pane', 'tools');
const actions = require(path.join(TOOLS, 'owner-actions.js'));
const T = actions.TEXTS.en;

const results = [];
const check = (n, c, x) => results.push((c ? 'PASS ' : 'FAIL ') + n + (x ? '  → ' + x : ''));
const OWNER = path.join(TOOLS, 'owner.js');
const owner = (...args) => spawnSync(process.execPath, [OWNER, ...args], {
  env: process.env, encoding: 'utf8', input: '', timeout: 60000,
});

let spoken = [];
let wrapped = 0;
function window(vault, answers) {
  spoken = [];
  const next = () => Promise.resolve(answers.shift() ?? '');
  return {
    vault, T,
    wrap: () => { wrapped++; },
    ui: { say: l => spoken.push(l), ask: next, askHidden: next, clear: () => { spoken = []; } },
  };
}

async function main() {
  fs.mkdirSync(config, { recursive: true });
  const setup = spawnSync(process.execPath, [path.join(TOOLS, 'setup.js'), '--activate'], { env: process.env, encoding: 'utf8' });
  check('le pont du mod s\'installe', setup.stdout.trim() === 'installed', setup.stderr);

  const vault = require(path.join(config, 'claude-vault-bridge', 'core.js'));
  const SECRET = 'demo-secret-' + Date.now();
  vault.put('DEMO_KEY', SECRET, { note: 'test' });

  // The form's Save: name and value on stdin, the owner's MCP choice applied at once.
  const store = asked => spawnSync(process.execPath, [path.join(TOOLS, 'store-key.js')], {
    env: process.env, encoding: 'utf8', input: typeof asked === 'string' ? asked : JSON.stringify(asked), timeout: 60000,
  });
  const FORM_VALUE = 'form-value-' + Date.now();
  const stored = store({ name: 'DEMO_FORM', value: FORM_VALUE, note: 'from the form', hasMcp: true });
  check('le formulaire enregistre la cle', stored.status === 0 && stored.stdout.trim() === 'DEMO_FORM', stored.stderr);
  check('la valeur ne sort pas du formulaire', !(stored.stdout + stored.stderr).includes(FORM_VALUE));
  check('la valeur est celle tapee', vault.reveal('DEMO_FORM').value === FORM_VALUE);
  const formKey = vault.listFast().find(s => s.name === 'DEMO_FORM');
  check('le MCP du formulaire est actif', formKey.mcp === true && !formKey.mcpServers);
  const taken = store({ name: 'DEMO_FORM', value: 'other-value', hasMcp: false });
  check('un nom pris ne change rien', taken.status === 7 && vault.reveal('DEMO_FORM').value === FORM_VALUE, taken.stderr);
  check('sans MCP, pas de MCP', store({ name: 'DEMO_FORM2', value: 'x-value', hasMcp: false }).status === 0 &&
    vault.listFast().find(s => s.name === 'DEMO_FORM2').mcp === false);
  check('un mauvais nom est refuse', store({ name: '9 bad', value: 'x', hasMcp: false }).status === 2);
  check('une valeur vide est refusee', store({ name: 'DEMO_EMPTY', value: '', hasMcp: false }).status === 2);
  check('une demande illisible est refusee', store('not json').status === 2);
  vault.remove('DEMO_FORM');
  vault.remove('DEMO_FORM2');
  vault.emptyTrash();

  // A decision needs a person: no console, no decision.
  for (const args of [['replace', 'DEMO_KEY'], ['delete', 'DEMO_KEY'], ['mcp', 'DEMO_KEY'], ['phrase'], ['restore'], ['bin']]) {
    const ran = owner(...args);
    check('sans console, refuse : ' + args[0], ran.status === 4, ran.stderr);
  }
  check('la cle est toujours la', vault.listFast().some(s => s.name === 'DEMO_KEY'));

  // Replacement: nothing moves on a non-answer, and the choice is honoured.
  vault.requestReplace('DEMO_KEY', SECRET + '-new', 'rotation');
  const shown = JSON.parse(owner('status').stdout);
  check('status montre le remplacement', shown.replaces[0] && shown.replaces[0].name === 'DEMO_KEY');
  check('status ne contient aucune valeur', !JSON.stringify(shown).includes(SECRET));
  check('sans reponse, rien ne change', !(await actions.replace(window(vault, ['']), 'DEMO_KEY')));
  check('la demande reste en attente', vault.pendingReplacements().length === 1);
  check('les mots montres ne contiennent pas la valeur', !spoken.join('\n').includes(SECRET));
  check('oui remplace', await actions.replace(window(vault, [T.yes]), 'DEMO_KEY'));
  check('la nouvelle valeur est en place', vault.reveal('DEMO_KEY').value === SECRET + '-new');

  vault.requestReplace('DEMO_KEY', SECRET + '-other', 'again');
  check('non garde la valeur', await actions.replace(window(vault, [T.no]), 'DEMO_KEY'));
  check('la valeur n\'a pas change', vault.reveal('DEMO_KEY').value === SECRET + '-new');
  vault.requestReplace('DEMO_KEY', SECRET + '-third', 'again');
  const refused = owner('refuse-replace', 'DEMO_KEY');
  check('refuser passe sans fenetre', refused.stdout.trim() === 'refused', refused.stderr);
  check('plus rien en attente', vault.pendingReplacements().length === 0);

  // MCP by hand, and the wrapping that makes the grant take effect.
  wrapped = 0;
  check('MCP : Entree ne change rien', !(await actions.mcpKey(window(vault, ['']), 'DEMO_KEY')));
  check('MCP : un nom invalide est refuse', !(await actions.mcpKey(window(vault, ['bad name!']), 'DEMO_KEY')));
  check('MCP : un serveur autorise', await actions.mcpKey(window(vault, ['github']), 'DEMO_KEY'));
  const scoped = vault.listFast().find(s => s.name === 'DEMO_KEY');
  check('MCP : portee enregistree', scoped.mcp === true && String(scoped.mcpServers) === 'github');
  check('MCP : serveurs enveloppes', wrapped === 1);
  check('MCP : retrait', await actions.mcpKey(window(vault, ['-']), 'DEMO_KEY'));
  check('MCP : retire', vault.listFast().find(s => s.name === 'DEMO_KEY').mcp === false);

  // Deletion goes to the bin, and only on the name typed in full.
  check('supprimer sans le nom annule', !(await actions.remove(window(vault, [T.yes]), 'DEMO_KEY')));
  check('la cle reste', vault.listFast().some(s => s.name === 'DEMO_KEY'));
  check('le nom tape supprime', await actions.remove(window(vault, ['DEMO_KEY']), 'DEMO_KEY'));
  check('la cle part', !vault.listFast().some(s => s.name === 'DEMO_KEY'));
  check('status compte la corbeille', JSON.parse(owner('status').stdout).binned === 1);
  check('corbeille : Entree laisse', !(await actions.bin(window(vault, ['']))));
  check('corbeille : le numero restaure', await actions.bin(window(vault, ['1'])));
  check('la cle revient avec sa valeur', vault.reveal('DEMO_KEY').value === SECRET + '-new');

  // The recovery phrase opens the vault again, and is said once, in the window.
  check('status : pas encore de phrase', JSON.parse(owner('status').stdout).hasRecovery === false);
  let words = '';
  const ctx = window(vault, ['']);
  const say = ctx.ui.say;
  ctx.ui.say = l => { say(l); if (l.startsWith('  ')) words = l.trim(); };
  ctx.ui.clear = () => { spoken = []; };
  check('la phrase se cree', await actions.phrase(ctx));
  check('la phrase est montree', words.split(/\s+/).length >= 12);
  check('la fenetre s\'efface ensuite', spoken.length === 0);
  check('status : phrase presente', JSON.parse(owner('status').stdout).hasRecovery === true);
  check('status ne contient pas la phrase', !owner('status').stdout.includes(words));
  check('une phrase existante demande confirmation', !(await actions.phrase(window(vault, [T.no]))));
  check('restaurer sans phrase annule', !(await actions.restore(window(vault, ['']))));
  let wrong = false;
  try { await actions.restore(window(vault, ['abandon abandon abandon'])); } catch (e) { wrong = true; }
  check('une mauvaise phrase est refusee', wrong);
  check('la bonne phrase rouvre le coffre', await actions.restore(window(vault, [words])));
  check('les cles sont la apres restauration', vault.reveal('DEMO_KEY').value === SECRET + '-new');
}

main()
  .catch(e => check('le test va au bout', false, e && e.stack))
  .finally(() => {
    try { fs.rmSync(home, { recursive: true, force: true }); } catch (e) { /* temp folder */ }
    console.log(results.join('\n'));
    const pass = results.filter(r => r.startsWith('PASS')).length;
    console.log('\n' + pass + ' OK, ' + (results.length - pass) + ' FAIL');
    process.exit(pass === results.length ? 0 : 1);
  });
