'use strict';
const memory = require('./memory'), mcp = require('./mcp-config');
const START = '<!-- claude-monitor-vault:codex:start -->', END = '<!-- claude-monitor-vault:codex:end -->';
const BLOCK = START + '\n## Local vault tools\n'
  + 'Read CLAUDE.md when present for existing project instructions, while preserving assistant-specific tool differences. '
  + 'Use the claude-monitor-vault MCP server. Call vault_list to discover available key names and their purposes. '
  + 'When the user refers to a key by name or $NAME, call vault_run with an env mapping from environment variable names to vault key names. '
  + 'Run the intended program with arguments; do not request, print, encode or write secret values. '
  + 'Per-key expiry, use limits, server restrictions and confirmation requirements remain in effect. '
  + 'If the tools are unavailable, report the connection problem instead of reading vault files.\n' + END;
function contextBlock(text, disconnect = false) {
  text = text || '';
  const a=text.indexOf(START), b=text.indexOf(END);
  if ((a<0)!==(b<0) || b<a || (a>=0 && (text.indexOf(START,a+START.length)>=0 || text.indexOf(END,b+END.length)>=0))) throw new Error('Conflicting Codex context markers');
  if(a>=0) {
    if(text.slice(a,b+END.length)!==BLOCK)throw new Error('The managed Codex vault context was edited.');
    return text.slice(0,a)+(disconnect?'':BLOCK)+text.slice(b+END.length);
  }
  return disconnect?text:text+(text.endsWith('\n')?'':'\n')+'\n'+BLOCK+'\n';
}
function plan(root,node,server,access='claude',disconnect=false) {
  const base=disconnect?{root,originals:{},changes:[]}:memory.buildPlan(root);
  const config=mcp.plan(root,node,server,disconnect,access);
  const file='AGENTS.md', before=memory.read(root,file);
  const previous=base.changes.find(c=>c.file===file);
  const after=contextBlock(previous?previous.after:before,disconnect);
  base.changes=base.changes.filter(c=>c.file!==file);
  base.originals[file]=before;
  if(after!==(before||''))base.changes.push({file,before,after});
  Object.assign(base.originals,config.originals);base.changes.push(...config.changes);
  return base;
}
module.exports={plan,contextBlock};
