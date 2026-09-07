'use strict';
const fs = require('fs'), path = require('path'), os = require('os');
function identify(value) {
  const s = String(value || '').toLowerCase();
  if (/(?:^|[\s/\\.:])(codex|chatgpt)(?:$|[\s/\\.:-])/.test(s)) return 'codex';
  if (/(?:^|[\s/\\.:])claude(?:$|[\s/\\.:-])/.test(s)) return 'claude';
  return null;
}
function commandProvider(command) {
  const match=String(command || '').trim().match(/^(?:"([^"]+)"|'([^']+)'|([^\s]+))/);
  const executable=match && (match[1]||match[2]||match[3]).split(/[\\/]/).pop();
  const cli=executable && executable.match(/^(claude|codex)(?:\.exe|\.cmd|\.ps1)?$/i);
  return cli ? cli[1].toLowerCase() : null;
}
function detect(vscode, root, choice, home = os.homedir(), running = new Map()) {
  const activeTab = vscode.window.tabGroups?.activeTabGroup?.activeTab;
  const focused = identify(activeTab?.input?.viewType);
  if (focused) return [focused];
  const terminal = vscode.window.activeTerminal;
  const foreground = running.get(terminal) || identify(terminal?.name) || commandProvider(terminal?.creationOptions?.shellPath);
  if (foreground) return [foreground];
  if (choice?.provider) return [choice.provider];
  const terminals = [...new Set((vscode.window.terminals || []).map(t => running.get(t) || identify(t.name) || commandProvider(t.creationOptions?.shellPath)).filter(Boolean))];
  if (terminals.length) return terminals;
  const active = [['codex','openai.chatgpt'],['claude','anthropic.claude-code']].filter(([,id])=>vscode.extensions?.getExtension(id)?.isActive).map(([p])=>p);
  if (active.length) return active;
  // Installation alone is not evidence of current use. Prefer project files
  // written by the assistant, excluding the extension's own generated files.
  const project = [];
  if (root) {
    for (const [provider, file] of [['claude','CLAUDE.md'], ['codex','AGENTS.md']]) {
      try {
        const p=path.join(root,file); if(fs.statSync(p).size>=262144) continue;
        const native=fs.readFileSync(p,'utf8').replace(/<!-- agent-bridge:memory:start -->[\s\S]*?<!-- agent-bridge:memory:end -->/g,'')
          .replace(/<!-- claude-monitor-vault:codex:start -->[\s\S]*?<!-- claude-monitor-vault:codex:end -->/g,'').trim();
        if(native)project.push(provider);
      } catch (_) {}
    }
  }
  if (project.length) return project;
  const authenticated = [];
  if(fs.existsSync(path.join(process.env.CODEX_HOME || path.join(home,'.codex'),'auth.json'))) authenticated.push('codex');
  if(fs.existsSync(path.join(process.env.CLAUDE_CONFIG_DIR || path.join(home,'.claude'),'.credentials.json'))) authenticated.push('claude');
  return authenticated.length ? authenticated : ['claude'];
}
module.exports = { detect, identify, commandProvider };
