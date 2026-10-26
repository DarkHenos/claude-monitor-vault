'use strict';
const { t } = require('../i18n');

// This fragment shares the existing webview and never receives credentials.
// It owns the provider toolbar and the two block titles only: the ChatGPT rows
// are drawn by the panel's own quota renderer (extension.js), the one that
// draws Claude's, so both blocks share markup, countdown, projection and
// footer, and differ by colour alone (#codex-quota sets --quota-color).
function html() {
  const labels = JSON.stringify({ auto: t('Automatic'), both: t('Both assistants'), actions: t('Assistant actions') }).replace(/</g, '\\u003c');
  return `<style>
  #quota-toolbar{display:flex;align-items:center;gap:8px;margin:0 0 14px;grid-column:1/-1}
  #quota-toolbar svg{width:20px;height:20px;flex:none;color:var(--vscode-descriptionForeground)}
  #quota-provider{min-width:0;flex:1;padding:5px 7px;color:var(--vscode-dropdown-foreground);background:var(--vscode-dropdown-background);border:1px solid var(--vscode-dropdown-border,transparent);border-radius:4px;font:inherit}
  #quota-toolbar button{font:inherit;color:var(--vscode-foreground);background:none;border:0;cursor:pointer;padding:4px 8px}
  #quota:not([hidden])+#codex-quota{margin-top:16px} #codex-quota h3,#claude-quota-title{font-family:var(--vscode-font-family);font-size:12px;margin:0 0 12px;color:var(--vscode-descriptionForeground)}
  #codex-quota .fill{background:var(--quota-color,var(--vscode-charts-blue))} #codex-quota .pct{color:var(--quota-color,var(--vscode-charts-blue))}  </style><div id="quota-toolbar">${require('./branding').logo}<select id="quota-provider" aria-label="Quotas"><option value="auto"></option><option value="claude">Claude</option><option value="codex">ChatGPT / Codex</option><option value="both"></option></select><button id="assistant-actions" type="button">···</button></div><div id="codex-quota" hidden><h3 id="codex-quota-title">ChatGPT / Codex</h3><div id="codex-rows"></div></div>
  <script NONCE_PLACEHOLDER>
  (function(){
    var labels=${labels},select=document.getElementById('quota-provider'),box=document.getElementById('codex-quota'),codexTitle=document.getElementById('codex-quota-title');
    select.options[0].textContent=labels.auto;select.options[3].textContent=labels.both;
    var button=document.getElementById('assistant-actions');button.title=labels.actions;button.setAttribute('aria-label',labels.actions);
    // Reuse the main webview's API through a DOM event, without acquiring it twice.
    select.onchange=function(){document.dispatchEvent(new CustomEvent('quota-action',{detail:{type:'quotaDisplay',value:select.value}}));};
    button.onclick=function(){document.dispatchEvent(new CustomEvent('quota-action',{detail:{type:'assistantActions'}}));};
    function paint(d){
      if(!d||!d.companion)return;var c=d.companion;
      select.value=c.mode;select.options[0].textContent=labels.auto+' · '+(c.providers.length===2?labels.both:c.providers[0]==='codex'?'ChatGPT / Codex':'Claude');
      var claude=document.getElementById('quota');if(!claude)return;claude.hidden=c.providers.indexOf('claude')<0;
      var title=document.getElementById('claude-quota-title');
      if(!title){title=document.createElement('h3');title.id='claude-quota-title';title.textContent='Claude';claude.before(title);claude.after(box);}
      // One rule for both titles: a block is named only when the other one is
      // on screen too, so a single provider looks the same whichever it is.
      var both=c.providers.indexOf('claude')>=0&&c.providers.indexOf('codex')>=0;
      title.hidden=claude.hidden||!both;codexTitle.hidden=!both;
      box.hidden=c.providers.indexOf('codex')<0;
    }
    window.addEventListener('message',function(e){paint(e.data);});
    document.addEventListener('quota-initial',function(e){paint(e.detail);});
  })();</script>`;
}
module.exports = { html };
