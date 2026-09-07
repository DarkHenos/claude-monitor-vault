'use strict';
const fs=require('fs'),path=require('path'),i18n=require('../i18n');
function html(config) {
 const code=i18n.current();
 const nls=JSON.parse(fs.readFileSync(path.join(__dirname,'../package.nls'+(code==='en'?'':'.'+code)+'.json'),'utf8'));
 const esc=s=>String(s).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
 const defaults={quotaDisplay:'auto',codexVaultAccess:'claude',codexColorStyle:'thresholds',codexNormalColor:'charts.blue',codexWarningColor:'charts.yellow',codexCriticalColor:'charts.red'};
 function select(key,options) { const value=config.get(key,defaults[key]);return '<select data-companion-setting="'+key+'">'+options.map(([v,label])=>'<option value="'+v+'"'+(v===value?' selected':'')+'>'+esc(label)+'</option>').join('')+'</select>'; }
 const palette=require('./colors').allowed.map(key=>[key,i18n.t(({blue:'Blue',green:'Green',purple:'Purple',orange:'Orange',yellow:'Yellow',red:'Red',foreground:'Normal text'})[key.split('.').pop()])]);
 return '<div class="carte" id="assistants"><h3>'+esc(i18n.t('Assistant settings'))+'</h3>'
   +'<label>'+esc(nls['bridge.cfg.quotaDisplay'])+'<br>'+select('quotaDisplay',[['auto',i18n.t('Automatic')],['claude','Claude'],['codex','ChatGPT / Codex'],['both',i18n.t('Both assistants')]])+'</label>'
   +'<p><label><input type="checkbox" data-companion-setting="codexAutoSetup"'+(config.get('codexAutoSetup',true)?' checked':'')+'> '+esc(nls['bridge.cfg.autoSetup'])+'</label></p>'
   +'<label>'+esc(nls['bridge.cfg.vaultAccess'])+'<br>'+select('codexVaultAccess',[['claude',nls['bridge.access.claude']],['mcp',nls['bridge.access.mcp']]])+'</label>'
   +'<p><label>'+esc(i18n.t('Codex quota colours'))+'<br>'+select('codexColorStyle',[['thresholds',i18n.t('Usage thresholds')],['custom',i18n.t('Custom')]])+'</label></p>'
   +'<div id="codex-custom-colors"'+(config.get('codexColorStyle','thresholds')==='custom'?'':' hidden')+'>'
   +[['codexNormalColor','Normal: below 70%'],['codexWarningColor','Warning: 70–89%'],['codexCriticalColor','Critical: 90% and above']].map(([key,label])=>'<p><label>'+esc(i18n.t(label))+'<br>'+select(key,palette)+'</label></p>').join('')+'</div></div>';
}
module.exports={html};
