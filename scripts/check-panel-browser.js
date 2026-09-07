const fs = require('fs'), path = require('path'), os = require('os'), Module = require('module'), assert = require('assert/strict');
// Optional browser smoke test: install playwright-core and its Chromium browser,
// or provide MONITOR_PLAYWRIGHT_MODULE and MONITOR_CHROMIUM paths.
const { chromium } = require(process.env.MONITOR_PLAYWRIGHT_MODULE || 'playwright-core');
const root = path.resolve(__dirname, '..');
const entry = new Module(path.join(root, 'extension.js'), module);
entry.filename=path.join(root,'extension.js'); entry.paths=Module._nodeModulePaths(root);
const original=Module._load;
Module._load=function(name){if(name==='vscode')return { ThemeColor:class{}, env:{language:'en'} };return original.apply(this,arguments);};
entry._compile(fs.readFileSync(entry.filename,'utf8')+'\nmodule.exports.preview=()=>getHtml(panelStrings());',entry.filename);
Module._load=original;
require('../i18n').load('en','en');
const markup=entry.exports.preview();
(async()=>{
 const browser=await chromium.launch({...(process.env.MONITOR_CHROMIUM ? {executablePath:process.env.MONITOR_CHROMIUM} : {}),headless:true});
 try {
  const page=await browser.newPage({viewport:{width:360,height:820},locale:'en-US'});const errors=[];page.on('pageerror',e=>errors.push(e.message));
  await page.addInitScript(()=>{window.messages=[];window.acquireVsCodeApi=()=>({getState:()=>null,setState:()=>{},postMessage:m=>window.messages.push(m)});});
  // Init scripts execute on navigation; use a data URL containing the actual CSP and scripts.
  await page.goto('data:text/html;charset=utf-8,'+encodeURIComponent(markup));
  await page.addStyleTag({content:':root{--vscode-font-family:Segoe UI,sans-serif;--vscode-foreground:#cccccc;--vscode-descriptionForeground:#999;--vscode-dropdown-foreground:#ddd;--vscode-dropdown-background:#303238;--vscode-charts-blue:#59a9e7;--vscode-charts-green:#66baa6;--vscode-charts-yellow:#ddb96c;--vscode-charts-red:#ed7474;--vscode-widget-border:#444;--vscode-editor-background:#202329;--vscode-button-background:#326f94;--vscode-button-foreground:#fff}body{background:#202329}'});
  const payload={companion:{mode:'both',providers:['claude','codex'],quotas:[{label:'Session',minutes:300,pct:32,resetAt:Date.now()+3600000}],busy:false,updated:Date.now(),error:''},rows:[{label:'Claude · Session',short:'5h',pct:47,level:'ok',resetAt:Date.now()+7200000}],vault:{secrets:[],issues:[],connected:false},at:'12:00',error:null};
  await page.evaluate(d=>window.postMessage(d,'*'),payload);
  await page.waitForFunction(()=>document.querySelector('#codex-quota .pct')?.textContent==='32%');
  assert.equal(await page.locator('#quota').isVisible(),true);
  const bars=await page.evaluate(()=>['#quota .bar','#codex-quota .bar'].map(s=>{const c=getComputedStyle(document.querySelector(s));return {height:c.height,radius:c.borderRadius};}));
  assert.deepEqual(bars[0],bars[1]);
  const fills=await page.evaluate(()=>['#quota .fill','#codex-quota .fill'].map(s=>getComputedStyle(document.querySelector(s)).backgroundColor));
  assert.notEqual(fills[0],fills[1]);
  await page.selectOption('#quota-provider','codex');
  assert.deepEqual(await page.evaluate(()=>window.messages.at(-1)),{type:'quotaDisplay',value:'codex'});
  payload.companion.mode='codex';payload.companion.providers=['codex'];
  await page.evaluate(d=>window.postMessage(d,'*'),payload);
  await page.waitForFunction(()=>document.getElementById('quota').hidden);
  await page.click('#assistant-actions');assert.equal(await page.evaluate(()=>window.messages.at(-1).type),'assistantActions');
  payload.companion.mode='both';payload.companion.providers=['claude','codex'];
  await page.evaluate(d=>window.postMessage(d,'*'),payload);
  await page.waitForFunction(()=>!document.getElementById('quota').hidden);
  assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);
  fs.mkdirSync(path.join(root,'media/screenshots'),{recursive:true});
  await page.screenshot({path:path.join(root,'media/screenshots/panel-1.1.0.png')});
  payload.companion.mode='claude';payload.companion.providers=['claude'];
  await page.evaluate(d=>window.postMessage(d,'*'),payload);
  await page.waitForFunction(()=>document.getElementById('codex-quota').hidden);
  assert.deepEqual(errors,[]);
  console.log('PASS actual webview scripts, CSP, English labels, provider selection, both quotas, actions and narrow layout');
 } finally {await browser.close();}
})().catch(e=>{console.error(e);process.exitCode=1;});
