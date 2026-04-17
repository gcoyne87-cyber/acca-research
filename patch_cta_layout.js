const fs=require('fs');
let html=fs.readFileSync('C:/Users/Gary Coyne/acca-research/index.html','utf8');

// ════════════════════════════════════════════════════════════════════════
// 1. Auto-select first race when a meeting is opened
// ════════════════════════════════════════════════════════════════════════
const OLD_TOGGLE=
'function toggleTodayMeeting(id){\n'
+'  if(todayOpenMeeting===id){\n'
+'    todayOpenMeeting="";\n'
+'    rcOpenRace={};\n'
+'  } else {\n'
+'    todayOpenMeeting=id;\n'
+'    rcOpenRace={};\n'
+'    var _m=RC_MEETINGS.filter(function(x){return x.id===id;})[0];\n'
+'    if(_m&&_m.races.length) rcOpenRace[id]=0;\n'
+'  }\n'
+'  renderTodayMeetingsList();\n'
+'}';

const NEW_TOGGLE=OLD_TOGGLE; // already applied in previous run — keep idempotent

// ════════════════════════════════════════════════════════════════════════
// 2. Update isOpen block — remove hasRace guard (always renders detail now)
// ════════════════════════════════════════════════════════════════════════
const OLD_IF='      if(hasRace) out+=rcRaceDetailHtml(m);\n      out+=\'</div>\';\n    }';
const NEW_IF='      out+=rcRaceDetailHtml(m);\n      out+=\'</div>\';\n    }';

if(html.indexOf(OLD_IF)<0){console.error('FAIL: hasRace guard not found');process.exit(1);}
html=html.replace(OLD_IF,NEW_IF);
console.log('2. hasRace guard removed — rcRaceDetailHtml always called');

// ════════════════════════════════════════════════════════════════════════
// 3. Rewrite rcRaceDetailHtml open — compact header, CTA above runners,
//    no top border (flows from full card CTA above)
// ════════════════════════════════════════════════════════════════════════
const OLD_DETAIL=
'  var out=\'<div id="rc-detail-\'+m.id+\'" style="background:#fff;border-top:1px solid #e4e8f0;border-bottom:1px solid #e4e8f0">\'\n'
+'\n'
+'    +\'<div style="padding:14px 16px 12px;display:flex;align-items:flex-start;justify-content:space-between">\'\n'
+'\n'
+'      +\'<div>\'\n'
+'\n'
+'        +\'<div style="font-size:16px;font-weight:700;color:#0b1628">\'+escHtml(race.t)+\' &middot; \'+escHtml(m.name)+\'</div>\'\n'
+'\n'
+'        +\'<div style="font-size:11px;color:#9aa3b5;margin-top:3px">\'+escHtml(race.dist)+\' &middot; \'+race.r+\' runners</div>\'\n'
+'\n'
+'      +\'</div>\'\n'
+'\n'
+'    +\'</div>\'\n'
+'    +\'<button class="fx-cta" style="margin:0 14px 4px;width:calc(100% - 28px)"><span style="color:var(--gold)">&#x2756;</span> Analyse \'+escHtml(race.t)+\' \'+escHtml(m.name)+\' with AI &rarr;</button>\';';

const NEW_DETAIL=
'  var out=\'<div id="rc-detail-\'+m.id+\'" style="background:#fff;border-bottom:1px solid #e4e8f0">\'\n'
+'    +\'<div style="padding:6px 14px 2px;font-size:11px;color:#9aa3b5">\'+escHtml(race.t)+\' &middot; \'+escHtml(race.dist)+\' &middot; \'+race.r+\' runners</div>\'\n'
+'    +\'<button class="fx-cta" style="margin:4px 12px 10px;width:calc(100% - 24px)"><span style="color:var(--gold)">&#x2756;</span> Analyse \'+escHtml(race.t)+\' \'+escHtml(m.name)+\' with AI &rarr;</button>\';';

if(html.indexOf(OLD_DETAIL)<0){console.error('FAIL: rcRaceDetailHtml open block not found');process.exit(1);}
html=html.replace(OLD_DETAIL,NEW_DETAIL);
console.log('3. rcRaceDetailHtml compacted — single meta line + CTA above runners');

// ── Syntax check ─────────────────────────────────────────────────────────
const ss=html.lastIndexOf('<script>'),se=html.lastIndexOf('</script>');
try{new Function(html.slice(ss+8,se));console.log('Syntax: OK');}
catch(e){console.error('GLOBAL SYNTAX:',e.message);process.exit(1);}

fs.writeFileSync('C:/Users/Gary Coyne/acca-research/index.html',html,'utf8');
console.log('Saved');
