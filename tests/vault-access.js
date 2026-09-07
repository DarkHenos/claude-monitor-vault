'use strict';
const fs=require('fs'),path=require('path'),os=require('os'),assert=require('assert/strict');
const {spawnSync}=require('child_process');
const temp=fs.mkdtempSync(path.join(os.tmpdir(),'codex-access-'));
try {
 fs.copyFileSync(path.join(__dirname,'../vault/mcp-server.js'),path.join(temp,'mcp-server.js'));
 fs.writeFileSync(path.join(temp,'core.js'),`const actual=require(${JSON.stringify(path.join(__dirname,'../vault/core.js'))});module.exports={mcpAllows:actual.mcpAllows,listFast:()=>[
 {name:'CLAUDE_KEY',mcp:false},{name:'MCP_KEY',mcp:true},{name:'RESTRICTED',mcp:true,mcpServers:['another-server']},{name:'EXPIRED',mcp:true,expired:true}
 ]};`);
 function list(access){
  const result=spawnSync(process.execPath,[path.join(temp,'mcp-server.js'),'--root',temp,'--access',access],{input:JSON.stringify({jsonrpc:'2.0',id:1,method:'tools/call',params:{name:'vault_list'}})+'\n',encoding:'utf8',windowsHide:true,timeout:10000});
  assert.equal(result.status,0,result.stderr);
  return JSON.parse(JSON.parse(result.stdout).result.content[0].text).map(x=>x.name);
 }
 assert.deepEqual(list('mcp'),['MCP_KEY']);
 assert.deepEqual(list('claude'),['CLAUDE_KEY','MCP_KEY']);
 assert.deepEqual(list('invalid'),['MCP_KEY']);
 console.log('PASS Claude-equivalent access, strict MCP access, expiry and named-server restrictions');
}finally{fs.rmSync(temp,{recursive:true,force:true});}
