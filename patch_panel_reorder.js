const fs=require('fs');
let html=fs.readFileSync('C:/Users/Gary Coyne/acca-research/index.html','utf8');

// ════════════════════════════════════════════════════════════════════════
// 1. Reorder isOpen block:
//    - Remove "Analyse Full Card" button from top
//    - Make pill bar always sticky (z-index:20, remove conditional)
//    - Move "Analyse Full Card" button to BELOW pill bar
// ════════════════════════════════════════════════════════════════════════

const OLD_OPEN=
'      out+=\'<div style="background:#fff;border-top:1px solid #e4e8f0">\';\n'
+'      out+=\'<button class="fx-cta" style="margin:10px 12px 4px;width:calc(100% - 24px)"><span style="color:var(--gold)">&#x2756;</span> Analyse Full \'+escHtml(m.name)+\' Card with AI &rarr;</button>\';\n'
+'      out+=\'<div style="display:flex;gap:6px;padding:6px 12px 8px;flex-wrap:wrap">\';\n'
+'      out+=\'<span style="font-size:11px;font-weight:600;padding:3px 9px;border-radius:20px;background:#fff8e6;color:#a07010;border:1px solid #f0d87a">\'+escHtml(m.going)+\'</span>\';\n'
+'      out+=\'<span style="font-size:11px;font-weight:600;padding:3px 9px;border-radius:20px;background:#eef4ff;color:#1a4fa0;border:1px solid #c0d4f8">Next in \'+m.nextMins+\' mins</span>\';\n'
+'      out+=\'</div>\';\n'
+'      var pillStyle=hasRace\n'
+'        ?"position:sticky;top:56px;z-index:10;background:#fff;border-bottom:1px solid #f0f2f7;"\n'
+'        :"border-top:1px solid #f0f2f7;";\n'
+'      out+=\'<div id="tdpills-\'+m.id+\'" style="\'+pillStyle+\'display:flex;gap:7px;overflow-x:auto;padding:8px 12px;scrollbar-width:none;-webkit-overflow-scrolling:touch">\';';

const NEW_OPEN=
'      out+=\'<div style="background:#fff;border-top:1px solid #e4e8f0">\';\n'
+'      out+=\'<div style="display:flex;gap:6px;padding:6px 12px 8px;flex-wrap:wrap">\';\n'
+'      out+=\'<span style="font-size:11px;font-weight:600;padding:3px 9px;border-radius:20px;background:#fff8e6;color:#a07010;border:1px solid #f0d87a">\'+escHtml(m.going)+\'</span>\';\n'
+'      out+=\'<span style="font-size:11px;font-weight:600;padding:3px 9px;border-radius:20px;background:#eef4ff;color:#1a4fa0;border:1px solid #c0d4f8">Next in \'+m.nextMins+\' mins</span>\';\n'
+'      out+=\'</div>\';\n'
+'      out+=\'<div id="tdpills-\'+m.id+\'" style="position:sticky;top:56px;z-index:20;background:#fff;border-bottom:1px solid #f0f2f7;display:flex;gap:7px;overflow-x:auto;padding:8px 12px;scrollbar-width:none;-webkit-overflow-scrolling:touch">\';\n';

// Also fix the pills close + Analyse button position
// Find the part after pills </div> where hasRace check is
const OLD_AFTER_PILLS=
'      out+=\'</div>\';\n'
+'      if(hasRace) out+=rcRaceDetailHtml(m);\n'
+'      out+=\'</div>\';\n'
+'    }';

const NEW_AFTER_PILLS=
'      out+=\'</div>\';\n'
+'      out+=\'<button class="fx-cta" style="margin:4px 12px 8px;width:calc(100% - 24px)"><span style="color:var(--gold)">&#x2756;</span> Analyse Full \'+escHtml(m.name)+\' Card with AI &rarr;</button>\';\n'
+'      if(hasRace) out+=rcRaceDetailHtml(m);\n'
+'      out+=\'</div>\';\n'
+'    }';

if(html.indexOf(OLD_OPEN)<0){console.error('FAIL: isOpen open block not found');process.exit(1);}
html=html.replace(OLD_OPEN,NEW_OPEN);
console.log('1a. isOpen top block rewritten (button removed from top, pill always sticky z-index:20)');

if(html.indexOf(OLD_AFTER_PILLS)<0){console.error('FAIL: after-pills block not found');process.exit(1);}
html=html.replace(OLD_AFTER_PILLS,NEW_AFTER_PILLS);
console.log('1b. Analyse Full Card button moved below pill bar');

// ── Syntax check ─────────────────────────────────────────────────────────
const ss=html.lastIndexOf('<script>'),se=html.lastIndexOf('</script>');
try{new Function(html.slice(ss+8,se));console.log('Syntax: OK');}
catch(e){console.error('GLOBAL SYNTAX:',e.message);process.exit(1);}

fs.writeFileSync('C:/Users/Gary Coyne/acca-research/index.html',html,'utf8');
console.log('Saved');
