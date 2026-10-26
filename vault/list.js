// Claude Vault, read only listing. One of the vault entry points Claude is
// allowed to run directly.
//
//   node list.js            one key name per line, nothing else
//   node list.js --groups   the layout, in order:
//
//     # Group name          a group (an empty group is a header alone)
//     NAME<TAB>mcp:all      a key of that group and its MCP scope
//     NAME<TAB>mcp:a,b      ... restricted to servers a and b
//     NAME<TAB>-            ... not allowed for MCP
//     ---<TAB>@5            a separator, and its position
//     --- label<TAB>@3      a separator with a title
//     # Ungrouped           always last
//
// The position (groups and separators counted from 1 at the top) is what
// set.js --move takes as "@3": a separator with no label, or with a label used
// twice, has no other name to be moved by.
//
// Names are what you need in order to know what you can call; the layout is
// what you need in order to reorganise it with set.js. Anything more would be
// noise in a context window.
//
// It never prints a value, and that is a property of the code rather than a
// promise: the only functions it calls are listFast() and layout(), which read
// metadata and never touch the master key. There is no code path from here to
// a plaintext secret.
//
// Any other argument is refused rather than ignored, so that a future option
// can never be smuggled in through a command the guard let through.

'use strict';

const vault = require('./core.js');

const args = process.argv.slice(2);
const groups = args.length === 1 && args[0] === '--groups';
if (args.length && !groups) {
  process.stderr.write('claude-vault: list takes no argument other than --groups\n');
  process.exit(1);
}

function scope(s) {
  if (!s.mcp) return '-';
  return s.mcpServers && s.mcpServers.length ? 'mcp:' + s.mcpServers.join(',') : 'mcp:all';
}

try {
  const keys = vault.listFast().filter(s => !s.expired);
  if (!groups) {
    const names = keys.map(s => s.name);
    process.stdout.write(names.length
      ? names.join('\n') + '\n'
      : 'Claude Vault is empty.\n');
    process.exit(0);
  }

  const items = vault.layout();
  if (!keys.length && !items.length) {
    process.stdout.write('Claude Vault is empty.\n');
    process.exit(0);
  }
  const lines = [];
  const placed = new Set();
  for (let i = 0; i < items.length; i++) {
    const it = items[i];
    if (it.type === 'separator') { lines.push((it.label ? '--- ' + it.label : '---') + '\t@' + (i + 1)); continue; }
    lines.push('# ' + it.name);
    for (const s of keys) {
      if (s.groupId !== it.id) continue;
      lines.push(s.name + '\t' + scope(s));
      placed.add(s.name);
    }
  }
  lines.push('# Ungrouped');
  for (const s of keys) if (!placed.has(s.name)) lines.push(s.name + '\t' + scope(s));
  process.stdout.write(lines.join('\n') + '\n');
  process.exit(0);
} catch (e) {
  process.stderr.write('claude-vault: ' + (e && e.message ? e.message : String(e)) + '\n');
  process.exit(1);
}
