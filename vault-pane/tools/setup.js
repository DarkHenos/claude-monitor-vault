// Connects the vault to Claude Code on a computer without the VS Code extension:
// the same bridge, at the same stable path, with the same hooks in settings.json
// (merged, backed up first), so the extension can take over later as it stands.
//
//   node setup.js --activate   installs a missing bridge, refreshes the mod's own
//   node setup.js --update     refreshes the mod's own bridge, installs nothing
//   node setup.js --upgrade    takes over an older bridge the extension wrote, on
//                              the person's own press, the vault backed up first
//
// Otherwise a bridge the extension wrote is never touched: its version.json has no
// owner. Prints what happened: installed, updated, upgraded, current, extension or
// absent; after upgraded, `extension=VERSION` when an older extension is installed,
// since it puts its own bridge back whenever VS Code opens.
// It copies the vault's encrypted files as they are and never opens a value.
'use strict';
const { spawnSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const OWNER = 'vault-pane';
const VAULT = path.join(os.homedir(), '.claude', 'vault');
const SOURCE = path.join(__dirname, '..', 'bridge');
const BRIDGE = path.join(process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude'), 'claude-vault-bridge');
const VERSION_FILE = path.join(BRIDGE, 'version.json');

const mode = process.argv[2];
if (mode !== '--activate' && mode !== '--update' && mode !== '--upgrade') {
  process.stderr.write('usage: node setup.js --activate | --update | --upgrade\n');
  process.exit(2);
}

function isOlder(version, than) {
  const parts = v => String(v).split('.').map(n => parseInt(n, 10) || 0);
  const [a, b] = [parts(version), parts(than)];
  for (let i = 0; i < 3; i++) {
    if ((a[i] || 0) !== (b[i] || 0)) return (a[i] || 0) < (b[i] || 0);
  }
  return false;
}

// A dated copy beside the vault, closed to everyone else before anything lands in
// it. Whatever goes wrong here stops the upgrade: nothing has moved yet.
function backUpVault() {
  if (!fs.existsSync(VAULT)) return null;
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const copy = path.join(os.homedir(), '.claude', 'vault-backup-' + stamp);
  fs.mkdirSync(copy, { recursive: true, mode: 0o700 });
  if (process.platform === 'win32') {
    const user = process.env.USERNAME || os.userInfo().username;
    const locked = spawnSync('icacls', [copy, '/inheritance:r', '/grant:r', user + ':(OI)(CI)F'], { stdio: 'ignore', windowsHide: true });
    if (locked.status !== 0) throw new Error('could not restrict the backup folder');
  }
  fs.cpSync(VAULT, copy, { recursive: true, filter: from => path.basename(from) !== 'tmp' });
  if (!fs.existsSync(path.join(copy, 'vault.json')) && fs.existsSync(path.join(VAULT, 'vault.json'))) {
    throw new Error('the backup is incomplete');
  }
  return copy;
}

// The newest copy of the extension VS Code has, if any.
function extensionVersion() {
  try {
    const found = fs.readdirSync(path.join(os.homedir(), '.vscode', 'extensions'))
      .map(name => /^alexossart\.claude-monitor-vault-(\d+\.\d+\.\d+)/.exec(name))
      .filter(Boolean)
      .map(m => m[1]);
    return found.reduce((best, v) => (best === null || isOlder(best, v) ? v : best), null);
  } catch (e) {
    return null;
  }
}

function installedVersion() {
  try { return JSON.parse(fs.readFileSync(VERSION_FILE, 'utf8')); }
  catch (e) { return null; }
}

function install(version) {
  require(path.join(SOURCE, 'install.js')).install(SOURCE, version);
  const written = installedVersion();
  fs.writeFileSync(VERSION_FILE, JSON.stringify({ ...written, owner: OWNER }), 'utf8');
}

function run() {
  const { version } = JSON.parse(fs.readFileSync(path.join(SOURCE, 'source.json'), 'utf8'));
  const current = installedVersion();
  const isPresent = fs.existsSync(path.join(BRIDGE, 'list.js'));

  if (!isPresent) {
    if (mode === '--update') return 'absent';
    install(version);
    return 'installed';
  }
  if (!current || current.owner !== OWNER) {
    if (mode !== '--upgrade') return 'extension';
    if (current && !isOlder(current.version, version)) return 'extension';
    backUpVault();
    install(version);
    const extension = extensionVersion();
    return extension && isOlder(extension, version) ? `upgraded extension=${extension}` : 'upgraded';
  }
  if (current.version === version) return 'current';
  install(version);
  return 'updated';
}

try {
  process.stdout.write(run() + '\n');
} catch (e) {
  process.stderr.write('claude-vault: ' + (e && e.message ? e.message : String(e)) + '\n');
  process.exit(1);
}
