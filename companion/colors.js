'use strict';
const allowed=['charts.blue','charts.green','charts.purple','charts.orange','charts.yellow','charts.red','foreground'];
function paint(pct,config){
 const level=pct>=90?'crit':pct>=70?'warn':'ok';
 const keys={ok:'codexNormalColor',warn:'codexWarningColor',crit:'codexCriticalColor'};
 const defaults={ok:'charts.blue',warn:'charts.yellow',crit:'charts.red'};
 const custom=config.get('codexColorStyle','thresholds')==='custom';
 const color=custom?config.get(keys[level],defaults[level]):defaults[level];
 return {level,color:allowed.includes(color)?color:defaults[level]};
}
module.exports={paint,allowed};
