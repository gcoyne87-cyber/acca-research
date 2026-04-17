const fs=require('fs');
let html=fs.readFileSync('C:/Users/Gary Coyne/acca-research/index.html','utf8');

// ════════════════════════════════════════════════════════════════════════
// 1. Rewrite isOpen block:
//    pills → [race info line + two-button row when race selected] → runner list
// ════════════════════════════════════════════════════════════════════════
const OLD_ISOPEN=
'if(isOpen){\n'
+'      out+=\'<div style="background:#fff;border-top:1px solid #e4e8f0">\';\n'
+'      out+=\'<div id="tdpills-\'+m.id+\'" style="position:sticky;top:56px;z-index:20;background:#fff;display:flex;gap:7px;overflow-x:auto;padding:8px 12px;scrollbar-width:none;-webkit-overflow-scrolling:touch">\';\n'
+'\n'
+'      m.races.forEach(function(race,ri){\n'
+'        var isSel=selRace===ri;\n'
+'        out+=\'<div style="flex-shrink:0;width:66px;border:1px solid \'+(isSel?"#0b1628":"#e4e8f0")+\';border-radius:8px;padding:11px 4px;text-align:center;cursor:pointer;background:\'+(isSel?"#0b1628":"#f5f7fb")+\'" onclick="todaySelectRace(\\\'\'+m.id+\'\\\',\'+ri+\')">\';\n'
+'        out+=\'<div style="font-size:13px;font-weight:600;color:\'+(isSel?"#fff":"#0b1628")+\'">\'+escHtml(race.t)+\'</div>\';\n'
+'        out+=\'<div style="font-size:10px;color:\'+(isSel?"rgba(255,255,255,.55)":"#9aa3b5")+\';margin-top:1px">\'+race.r+\' rnrs</div>\';\n'
+'        out+=\'</div>\';\n'
+'      });\n'
+'      out+=\'</div>\';\n'
+'      out+=\'<button class="fx-cta" style="margin:4px 12px 8px;width:calc(100% - 24px)"><span style="color:var(--gold)">&#x2756;</span> Analyse Full \'+escHtml(m.name)+\' Card with AI &rarr;</button>\';\n'
+'      out+=rcRaceDetailHtml(m);\n'
+'      out+=\'</div>\';\n'
+'    }';

const NEW_ISOPEN=
'if(isOpen){\n'
+'      out+=\'<div style="background:#fff;border-top:1px solid #e4e8f0">\';\n'
+'      out+=\'<div id="tdpills-\'+m.id+\'" style="position:sticky;top:56px;z-index:20;background:#fff;display:flex;gap:7px;overflow-x:auto;padding:8px 12px;scrollbar-width:none;-webkit-overflow-scrolling:touch">\';\n'
+'\n'
+'      m.races.forEach(function(race,ri){\n'
+'        var isSel=selRace===ri;\n'
+'        out+=\'<div style="flex-shrink:0;width:66px;border:1px solid \'+(isSel?"#0b1628":"#e4e8f0")+\';border-radius:8px;padding:11px 4px;text-align:center;cursor:pointer;background:\'+(isSel?"#0b1628":"#f5f7fb")+\'" onclick="todaySelectRace(\\\'\'+m.id+\'\\\',\'+ri+\')">\';\n'
+'        out+=\'<div style="font-size:13px;font-weight:600;color:\'+(isSel?"#fff":"#0b1628")+\'">\'+escHtml(race.t)+\'</div>\';\n'
+'        out+=\'<div style="font-size:10px;color:\'+(isSel?"rgba(255,255,255,.55)":"#9aa3b5")+\';margin-top:1px">\'+race.r+\' rnrs</div>\';\n'
+'        out+=\'</div>\';\n'
+'      });\n'
+'      out+=\'</div>\';\n'
// If a race is selected: show compact info line + two side-by-side CTAs
+'      if(hasRace){\n'
+'        var sr=m.races[selRace];\n'
+'        out+=\'<div style="padding:8px 12px 4px;font-size:11px;color:#9aa3b5">\'+escHtml(sr.t)+\' &middot; \'+escHtml(sr.dist)+\' &middot; \'+sr.r+\' runners</div>\';\n'
+'        out+=\'<div style="display:flex;gap:8px;padding:0 12px 12px">\';\n'
+'        out+=\'<button onclick="void(0)" style="flex:1;background:#fff;color:var(--navy);border:1.5px solid var(--gold);border-radius:99px;padding:9px 10px;font-size:12px;font-weight:700;cursor:pointer;font-family:inherit;text-align:center"><span style="color:var(--gold)">&#x2756;</span> Full Card</button>\';\n'
+'        out+=\'<button onclick="void(0)" style="flex:2;background:#0b1628;color:#fff;border:1.5px solid #0b1628;border-radius:99px;padding:9px 10px;font-size:12px;font-weight:700;cursor:pointer;font-family:inherit;text-align:center"><span style="color:#c9a84c">&#x2756;</span> Analyse \'+escHtml(sr.t)+\' &rarr;</button>\';\n'
+'        out+=\'</div>\';\n'
+'      }\n'
+'      out+=rcRaceDetailHtml(m);\n'
+'      out+=\'</div>\';\n'
+'    }';

if(html.indexOf(OLD_ISOPEN)<0){console.error('FAIL: isOpen block not found');process.exit(1);}
html=html.replace(OLD_ISOPEN,NEW_ISOPEN);
console.log('1. isOpen block rewritten — two side-by-side CTAs');

// ════════════════════════════════════════════════════════════════════════
// 2. Strip header + CTA from rcRaceDetailHtml — just runner rows now
// ════════════════════════════════════════════════════════════════════════
const OLD_DETAIL=
'  var out=\'<div id="rc-detail-\'+m.id+\'" style="background:#fff;border-bottom:1px solid #e4e8f0">\'\n'
+'    +\'<div style="padding:6px 14px 2px;font-size:11px;color:#9aa3b5">\'+escHtml(race.t)+\' &middot; \'+escHtml(race.dist)+\' &middot; \'+race.r+\' runners</div>\'\n'
+'    +\'<button class="fx-cta" style="margin:4px 12px 10px;width:calc(100% - 24px)"><span style="color:var(--gold)">&#x2756;</span> Analyse \'+escHtml(race.t)+\' \'+escHtml(m.name)+\' with AI &rarr;</button>\';';

const NEW_DETAIL=
'  var out=\'<div id="rc-detail-\'+m.id+\'" style="background:#fff;border-bottom:1px solid #e4e8f0">\';';

if(html.indexOf(OLD_DETAIL)<0){console.error('FAIL: rcRaceDetailHtml header not found');process.exit(1);}
html=html.replace(OLD_DETAIL,NEW_DETAIL);
console.log('2. rcRaceDetailHtml stripped to runner list only');

// ── Syntax check ─────────────────────────────────────────────────────────
const ss=html.lastIndexOf('<script>'),se=html.lastIndexOf('</script>');
try{new Function(html.slice(ss+8,se));console.log('Syntax: OK');}
catch(e){console.error('GLOBAL SYNTAX:',e.message);process.exit(1);}

fs.writeFileSync('C:/Users/Gary Coyne/acca-research/index.html',html,'utf8');
console.log('Saved');
