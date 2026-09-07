'use strict';
const { t } = require('../i18n');

// This fragment shares the existing webview and never receives credentials.
function html() {
  const labels = JSON.stringify({ auto: t('Automatic'), both: t('Both assistants'), actions: t('Assistant actions'), loading: t('Refreshing'), empty: t('No subscription quota returned'), attention: t('Connection needs attention') }).replace(/</g, '\\u003c');
  return `<style>
  #quota-toolbar{display:flex;align-items:center;gap:8px;margin:0 0 14px;grid-column:1/-1}
  #quota-toolbar svg{width:20px;height:20px;flex:none;color:var(--vscode-descriptionForeground)}
  #quota-provider{min-width:0;flex:1;padding:5px 7px;color:var(--vscode-dropdown-foreground);background:var(--vscode-dropdown-background);border:1px solid var(--vscode-dropdown-border,transparent);border-radius:4px;font:inherit}
  #quota-toolbar button{font:inherit;color:var(--vscode-foreground);background:none;border:0;cursor:pointer;padding:4px 8px}
  #codex-quota{margin-bottom:16px} #codex-quota h3,#claude-quota-title{font-family:var(--vscode-font-family);font-size:12px;margin:0 0 12px;color:var(--vscode-descriptionForeground)}
  #codex-quota .fill{background:var(--quota-color,var(--vscode-charts-blue))} #codex-quota .pct{color:var(--quota-color,var(--vscode-charts-blue))}
  </style><div id="quota-toolbar">${require('./branding').logo}<select id="quota-provider" aria-label="Quotas"><option value="auto"></option><option value="claude">Claude</option><option value="codex">ChatGPT / Codex</option><option value="both"></option></select><button id="assistant-actions" type="button">···</button></div><div id="codex-quota" hidden></div>
  <script NONCE_PLACEHOLDER>
  (function(){
    var labels=${labels},select=document.getElementById('quota-provider'),box=document.getElementById('codex-quota');
    select.options[0].textContent=labels.auto;select.options[3].textContent=labels.both;
    var button=document.getElementById('assistant-actions');button.title=labels.actions;button.setAttribute('aria-label',labels.actions);
    // Reuse the main webview's API through a DOM event, without acquiring it twice.
    select.onchange=function(){document.dispatchEvent(new CustomEvent('quota-action',{detail:{type:'quotaDisplay',value:select.value}}));};
    button.onclick=function(){document.dispatchEvent(new CustomEvent('quota-action',{detail:{type:'assistantActions'}}));};
    function node(tag,text,parent){var n=document.createElement(tag);if(text)n.textContent=text;parent.appendChild(n);return n;}
    function paint(d){
      if(!d||!d.companion)return;var c=d.companion;
      select.value=c.mode;select.options[0].textContent=labels.auto+' · '+(c.providers.length===2?labels.both:c.providers[0]==='codex'?'ChatGPT / Codex':'Claude');
      var claude=document.getElementById('quota');claude.hidden=c.providers.indexOf('claude')<0;
      var title=document.getElementById('claude-quota-title');
      if(!title){title=document.createElement('h3');title.id='claude-quota-title';title.textContent='Claude';claude.before(title);claude.after(box);}
      title.hidden=claude.hidden||c.providers.length<2;
      box.hidden=c.providers.indexOf('codex')<0;box.replaceChildren();if(box.hidden)return;
      node('h3','ChatGPT / Codex',box);
      if(c.error||c.setupError){node('p',labels.attention,box);node('small',c.error||c.setupError,box);}
      if(!c.quotas.length&&!c.error)node('p',c.busy||!c.updated?labels.loading:labels.empty,box);
      c.quotas.forEach(function(q){
        var row=node('div','',box);row.className='row';
        var allowed=['charts.blue','charts.green','charts.purple','charts.orange','charts.yellow','charts.red','foreground'];
        var color=allowed.indexOf(q.color)>=0?q.color:(q.pct>=90?'charts.red':q.pct>=70?'charts.yellow':'charts.blue');
        row.style.setProperty('--quota-color','var(--vscode-'+color.split('.').join('-')+')');
        var top=node('div','',row);top.className='top';
        node('span',q.label+(q.minutes?' / '+(q.minutes>=60?q.minutes/60+' h':q.minutes+' min'):''),top);
        var pct=node('span',Math.round(q.pct)+'%',top);pct.className='pct';
        var bar=node('div','',row);bar.className='bar';bar.setAttribute('role','progressbar');bar.setAttribute('aria-label',q.label);bar.setAttribute('aria-valuemin','0');bar.setAttribute('aria-valuemax','100');bar.setAttribute('aria-valuenow',Math.round(q.pct));
        var fill=node('div','',bar);fill.className='fill';fill.style.width=Math.max(0,Math.min(100,q.pct))+'%';
        if(q.resetAt){var eta=node('div',new Date(q.resetAt).toLocaleString(),row);eta.className='eta';}
      });
    }
    window.addEventListener('message',function(e){paint(e.data);});
    document.addEventListener('quota-initial',function(e){paint(e.detail);});
  })();</script>`;
}
module.exports = { html };
