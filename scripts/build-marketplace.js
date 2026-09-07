'use strict';
// Editorial diagrams use the maintained vector logo and a real webview capture.
const fs = require('fs'), path = require('path');
const { Resvg } = require('@resvg/resvg-js');
const root = path.resolve(__dirname, '..'), out = path.join(root, 'media/marketplace');
fs.mkdirSync(out, { recursive: true });
const version = require('../package.json').version;
const esc = s => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;');
const text = (x,y,s,size=24,color='#bbc3cb',weight=400) => `<text x="${x}" y="${y}" fill="${color}" font-size="${size}" font-weight="${weight}">${esc(s)}</text>`;
const line = (x,y,x2,y2,color='#3c4854') => `<path d="M${x} ${y}H${x2}V${y2}" stroke="${color}" stroke-width="2" fill="none"/>`;
const rect = (x,y,w,h,fill='#202a34') => `<rect x="${x}" y="${y}" width="${w}" height="${h}" rx="12" fill="${fill}"/>`;
function render(name,h,body) {
 const svg=`<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" width="1200" height="${h}" viewBox="0 0 1200 ${h}"><rect width="1200" height="${h}" fill="#141c24"/><g font-family="Segoe UI, Arial, sans-serif">${body}</g></svg>`;
 fs.writeFileSync(path.join(out,name+'.svg'),svg);
 fs.writeFileSync(path.join(out,name+'.png'),new Resvg(svg).render().asPng());
}
const logo=fs.readFileSync(path.join(root,'media/logo-companion.svg'),'utf8').replace(/<svg[^>]*>/,'<svg x="938" y="95" width="190" height="190" viewBox="0 0 128 128">');
render('hero',420,
 text(64,68,'CLAUDE MONITOR & VAULT',19,'#d9977e',600)+text(64,144,'Your assistants.',55,'#f2f4f6',600)+
 text(64,207,'One familiar workspace.',55,'#f2f4f6',600)+text(64,264,'Claude Code + ChatGPT / Codex',26,'#a8b6c4')+
 line(64,307,1136,307)+text(64,360,'QUOTAS',17,'#d9977e',600)+text(260,360,'PROJECT MEMORY',17,'#6ec5b4',600)+text(560,360,'LOCAL VAULT',17,'#bbc3cb',600)+text(1020,360,'v'+version,18)+logo);
const shot=fs.readFileSync(path.join(root,'media/panel-1.1.0.png')).toString('base64');
render('quotas',950,
 text(64,73,'01 / USAGE',18,'#d9977e',600)+text(64,132,'Choose what you see.',42,'#f2f4f6',600)+
 text(64,214,'One assistant or both',27,'#f2f4f6',600)+text(64,253,'Automatic detects the active assistant.',22)+text(64,286,'Select Claude, Codex or both at any time.',22)+
 text(64,389,'Separate, readable quotas',27,'#f2f4f6',600)+text(64,428,'Usage percentages and reset windows',22)+text(64,461,'stay attached to the right assistant.',22)+
 text(64,567,'Actions within reach',27,'#f2f4f6',600)+text(64,606,'The compact menu opens model choice,',22)+text(64,639,'session launch and project memory.',22)+
 text(64,830,'ACTUAL WEBVIEW · DEMONSTRATION VALUES',15,'#8293a4')+text(64,866,'Shown in English; five interface languages.',20)+
 rect(702,46,402,858,'#303c49')+`<image x="723" y="65" width="360" height="820" xlink:href="data:image/png;base64,${shot}"/>`);
render('memory',690,
 text(64,68,'02 / PROJECT MEMORY',18,'#6ec5b4',600)+text(64,124,'Keep context when you switch.',42,'#f2f4f6',600)+
 text(64,170,'Linked files are discovered. Changes are reviewed. Existing notes are preserved.',23)+
 rect(64,220,315,226)+text(88,260,'1  DISCOVER',17,'#d9977e',600)+text(88,310,'MEMORY.md',25,'#f2f4f6',600)+text(88,352,'↳ user_profile.md',20)+text(88,389,'↳ project_decisions.md',20)+text(88,423,'↳ other linked files…',20)+
 rect(443,220,315,226)+text(467,260,'2  REVIEW',17,'#d9977e',600)+text(467,310,'Inventory + differences',24,'#f2f4f6',600)+text(467,352,'Included / missing / skipped',20)+text(467,389,'Preview before applying',20)+text(467,423,'Local backups for changes',20)+
 rect(822,220,314,226)+text(846,260,'3  SHARE',17,'#6ec5b4',600)+text(846,310,'Project notes',25,'#f2f4f6',600)+text(846,352,'.agent-bridge/MEMORY.md',19)+text(846,389,'CLAUDE.md → shared notes',19)+text(846,423,'AGENTS.md → shared notes',19)+
 text(399,342,'→',30,'#6ec5b4')+text(778,342,'→',30,'#6ec5b4')+
 line(64,501,1136,501)+text(64,550,'Different filenames. One inventory. No duplicate imports.',28,'#f2f4f6',600)+
 text(64,599,'Shares local project files, not chat history or personal ChatGPT web memories.',22));
console.log('Built hero, quota walkthrough and memory diagram for version '+version);
