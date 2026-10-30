// vault-pane on a computer with neither VS Code nor the extension: a brand new
// home folder, the bridge the mod carries, and nothing else. Everything runs under
// a temporary home, so the vault of the person running the tests is never touched.
'use strict';
const { spawnSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const TOOLS = path.join(__dirname, '..', 'vault-pane', 'tools');
const results = [];
const check = (n, c, x) => results.push((c ? 'PASS ' : 'FAIL ') + n + (x ? '  → ' + x : ''));

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'vault-pane-'));
const config = path.join(home, '.claude');
const bridge = path.join(config, 'claude-vault-bridge');
const settings = path.join(config, 'settings.json');
const env = { ...process.env, USERPROFILE: home, HOME: home, CLAUDE_CONFIG_DIR: config };
const VALUE = 'demo-value-' + Date.now();

function node(args, input) {
  return spawnSync(process.execPath, args, { env, input, encoding: 'utf8', timeout: 60000 });
}
const setup = mode => node([path.join(TOOLS, 'setup.js'), mode]);
const list = () => node([path.join(bridge, 'list.js'), '--groups']);

try {
  fs.mkdirSync(config, { recursive: true });
  fs.writeFileSync(settings, JSON.stringify({ model: 'kept', hooks: { Stop: [{ hooks: [{ type: 'command', command: 'other' }] }] } }));

  check('--update installe rien sans pont', setup('--update').stdout.trim() === 'absent' && !fs.existsSync(bridge));

  const activated = setup('--activate');
  check('--activate installe le pont', activated.stdout.trim() === 'installed', activated.stderr);
  check('le pont se lance', list().status === 0, list().stderr);

  const merged = JSON.parse(fs.readFileSync(settings, 'utf8'));
  check('settings.json garde les reglages', merged.model === 'kept');
  check('settings.json garde les autres hooks', merged.hooks.Stop[0].hooks[0].command === 'other');
  for (const ev of ['SessionStart', 'UserPromptSubmit', 'PreToolUse', 'PostToolUse']) {
    check('hook ajoute : ' + ev, JSON.stringify(merged.hooks[ev] || '').includes('claude-vault-bridge'));
  }
  check('settings.json sauvegarde avant', fs.readdirSync(config).some(f => f.startsWith('settings.json.vault-backup-')));

  check('une relance ne change rien', setup('--activate').stdout.trim() === 'current');

  const created = node([path.join(TOOLS, 'new-key.js'), 'DEMO_STANDALONE'], 'cle de test\n' + VALUE + '\n');
  check('new-key cree la cle', created.status === 0, created.stderr);
  check('la cle est listee', /DEMO_STANDALONE/.test(list().stdout));
  check('la valeur ne sort jamais', !(created.stdout + created.stderr + list().stdout).includes(VALUE));
  const stored = fs.readFileSync(path.join(home, '.claude', 'vault', 'vault.json'), 'utf8');
  check('la valeur est chiffree sur le disque', !stored.includes(VALUE));

  check('new-key refuse un mauvais nom', node([path.join(TOOLS, 'new-key.js'), '9 bad'], 'x\ny\n').status === 2);
  const cancelled = node([path.join(TOOLS, 'new-key.js'), 'DEMO_EMPTY'], 'note\n\n');
  check('une valeur vide annule', cancelled.status === 1 && !/DEMO_EMPTY/.test(list().stdout));

  // What the whole vault is for: a marker in a command, resolved by the hook alone.
  const asked = JSON.stringify({
    hook_event_name: 'PreToolUse', tool_name: 'Bash', session_id: 'test', cwd: home,
    tool_input: { command: 'node -e "process.stdout.write(process.argv[1])" {{' + 'vault:DEMO_STANDALONE}}' },
  });
  const hooked = node([path.join(bridge, 'hook.js')], asked);
  let rewritten = '';
  try { rewritten = JSON.parse(hooked.stdout).hookSpecificOutput.updatedInput.command; } catch (e) { /* checked below */ }
  check('le hook reecrit le marqueur', rewritten !== '' && !rewritten.includes('{{'), hooked.stderr);
  check('la valeur n\'apparait pas dans la commande reecrite', !rewritten.includes(VALUE));
  const shell = process.platform === 'win32' ? 'bash' : '/bin/sh';
  const used = spawnSync(shell, ['-c', rewritten], { env, encoding: 'utf8', timeout: 60000 });
  check('la commande recoit la valeur', used.stdout === VALUE, used.stderr);

  // The mod's own bridge follows the mod.
  const versionFile = path.join(bridge, 'version.json');
  const written = JSON.parse(fs.readFileSync(versionFile, 'utf8'));
  check('le pont est marque comme celui du mod', written.owner === 'vault-pane');
  fs.writeFileSync(versionFile, JSON.stringify({ ...written, version: '0.0.1' }));
  check('--update suit le mod', setup('--update').stdout.trim() === 'updated');
  check('la cle survit a la mise a jour', /DEMO_STANDALONE/.test(list().stdout));

  // A bridge the extension wrote stays the extension's.
  fs.writeFileSync(versionFile, JSON.stringify({ version: '0.0.1' }));
  check('--update laisse le pont de l\'extension', setup('--update').stdout.trim() === 'extension');
  check('--activate laisse le pont de l\'extension', setup('--activate').stdout.trim() === 'extension');
  check('version de l\'extension intacte', JSON.parse(fs.readFileSync(versionFile, 'utf8')).version === '0.0.1');

  // Until the person presses Update: the vault backed up, then the bridge taken over.
  const backups = () => fs.readdirSync(config).filter(f => f.startsWith('vault-backup-'));
  check('aucune sauvegarde avant', backups().length === 0);
  const raised = setup('--upgrade');
  check('--upgrade prend le pont ancien', raised.stdout.trim() === 'upgraded', raised.stdout + raised.stderr);
  check('la sauvegarde existe', backups().length === 1);
  const saved = path.join(config, backups()[0] || 'none');
  check('la sauvegarde contient le coffre', fs.readFileSync(path.join(saved, 'vault.json'), 'utf8') ===
    fs.readFileSync(path.join(config, 'vault', 'vault.json'), 'utf8'));
  check('la sauvegarde reste chiffree', !fs.readFileSync(path.join(saved, 'vault.json'), 'utf8').includes(VALUE));
  check('le pont est maintenant celui du mod', JSON.parse(fs.readFileSync(versionFile, 'utf8')).owner === 'vault-pane');
  check('la cle est toujours la', /DEMO_STANDALONE/.test(list().stdout));
  check('les groupes marchent', list().status === 0);

  // An extension as new as the mod is left alone, and is not backed up for nothing.
  const { version } = JSON.parse(fs.readFileSync(path.join(TOOLS, '..', 'bridge', 'source.json'), 'utf8'));
  fs.writeFileSync(versionFile, JSON.stringify({ version }));
  check('--upgrade laisse une extension a jour', setup('--upgrade').stdout.trim() === 'extension');
  check('pas de seconde sauvegarde', backups().length === 1);

  // An older extension still installed is named: it would put its bridge back.
  fs.writeFileSync(versionFile, JSON.stringify({ version: '0.0.1' }));
  fs.mkdirSync(path.join(home, '.vscode', 'extensions', 'alexossart.claude-monitor-vault-0.0.1'), { recursive: true });
  check('une extension ancienne est signalee', setup('--upgrade').stdout.trim() === 'upgraded extension=0.0.1');
} catch (e) {
  check('le test va au bout', false, e.message);
} finally {
  fs.rmSync(home, { recursive: true, force: true });
}

console.log(results.join('\n'));
const pass = results.filter(r => r.startsWith('PASS')).length;
console.log('\n' + pass + ' OK, ' + (results.length - pass) + ' FAIL');
process.exit(pass === results.length ? 0 : 1);
