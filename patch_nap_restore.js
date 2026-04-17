const fs=require('fs');
let html=fs.readFileSync('C:/Users/Gary Coyne/acca-research/index.html','utf8');

// ════════════════════════════════════════════════════════════════════════
// 1. Restore section heading + container
// ════════════════════════════════════════════════════════════════════════
// Current (simplified) heading
const curHeading='<div class="main" style="padding-top:12px;padding-bottom:0;padding-left:0;padding-right:0">\n\n      <div style="margin-bottom:10px;padding:0 16px">\n\n        <div style="font-size:20px;font-weight:800;color:var(--navy);line-height:1.1;letter-spacing:-0.3px">Today\'s NAP &amp; NB</div>\n\n        <div style="font-size:12px;color:var(--muted);margin-top:3px">AI-powered picks updated daily</div>\n\n      </div>\n\n      <div id="racing-picks-container" style="display:flex;flex-direction:column;gap:0;background:#edf0f5">';
const origHeading='<div class="main" style="padding-top:12px;padding-bottom:0;padding-left:12px;padding-right:12px">\n\n      <div style="margin-bottom:12px">\n\n        <span style="font-size:24px;line-height:1;display:block;margin-bottom:6px">🎯</span>\n\n        <div style="font-size:22px;font-weight:700;color:var(--navy);line-height:1.1">Today\'s NAP &amp; NB</div>\n\n        <div style="font-size:13px;color:var(--muted);margin-top:4px;display:flex;align-items:center;gap:6px">With <div style="background:#0b1628;border:1.5px solid #c9a84c;border-radius:5px;padding:3px 8px;display:inline-flex;align-items:center;gap:4px;flex-shrink:0"><div style="width:5px;height:5px;border-radius:50%;background:#1e9e6b;flex-shrink:0"></div><span style="font-size:9px;font-weight:700;letter-spacing:0.1em;color:#fff">AI EDGE</span></div></div>\n\n      </div>\n\n      <div id="racing-picks-container" style="display:flex;flex-direction:column;gap:12px">';
if(!html.includes(curHeading)){console.error('FAIL: current heading not found');process.exit(1);}
html=html.replace(curHeading,origHeading);
console.log('1. Section heading + container restored');

// ════════════════════════════════════════════════════════════════════════
// 2. Restore RACING_PICKS data
// ════════════════════════════════════════════════════════════════════════
const dataStart=html.indexOf('var RACING_PICKS=[');
const dataEnd=html.indexOf('\nfunction renderRacingPicks(){');
const origData=
'var RACING_PICKS=[\n\n'
+'  {type:\'NAP \xb7 Pick of the Day\',icon:\'\u26a1\',horse:\'Majolique\',detail:\'13:15 Cork \xb7 2m7f Maiden Hurdle\',reasons:[\'Top AI rating across form, going and trainer stats\',\'Won 3 of last 5 on Good to Yielding ground\',\'JP Townend booked \u2014 strong jockey booking signal\',\'Mullins yard in form with 5 winners this week\',\'Weighted well at the bottom of the handicap\'],odds:\'2/1\',border:\'#1e9e6b\'},\n\n'
+'  {type:\'NB \xb7 Next Best\',icon:\'\u2605\',horse:\'Proactif\',detail:\'13:50 Cork \xb7 2m4f Handicap Chase\',reasons:[\'Second highest AI rating on today\\\'s card\',\'Course and distance winner \u2014 won here twice last season\',\'Mullins booking Walsh \u2014 retained jockey is key signal\',\'Drops in class today after near miss at Leopardstown\',\'Strong finishing profile suits this track\\\'s long run-in\'],odds:\'5/2\',border:\'#0b1628\'},\n\n'
+'];\n';
try{new Function(origData);}catch(e){console.error('DATA SYNTAX:',e.message);process.exit(1);}
html=html.slice(0,dataStart)+origData+html.slice(dataEnd);
console.log('2. RACING_PICKS data restored');

// ════════════════════════════════════════════════════════════════════════
// 3. Restore renderRacingPicks function
// ════════════════════════════════════════════════════════════════════════
const fnStart=html.indexOf('\nfunction renderRacingPicks(){');
const fnEnd=html.indexOf('\nfunction renderRacingWinners(){');
const origFn='\n'
+'function renderRacingPicks(){\n\n'
+'  var el=document.getElementById(\'racing-picks-container\');\n\n'
+'  if(!el) return;\n\n'
+'  el.innerHTML=RACING_PICKS.map(function(p,i){\n\n'
+'    var rows=p.reasons.map(function(r){\n\n'
+'      return \'<div style="display:flex;align-items:baseline;gap:4px;font-size:10px;color:#555;line-height:1.4"><span style="color:#1e9e6b;font-weight:700;flex-shrink:0;font-size:10px">\u2713</span><span>\'+escHtml(r)+\'</span></div>\';\n\n'
+'    }).join(\'\');\n\n'
+'    return \'<div style="background:#fff;border:1px solid #e8eaed;border-radius:12px;overflow:hidden;border-left:4px solid \'+p.border+\'">\'\n\n'
+'      +\'<div style="padding:14px 16px;display:flex;align-items:flex-start;justify-content:space-between;border-bottom:1px solid #f0f0f0">\'\n\n'
+'        +\'<div>\'\n\n'
+'          +\'<div style="display:inline-flex;align-items:center;gap:6px;border:1px solid #e8eaed;border-radius:99px;padding:3px 10px;margin-bottom:8px"><span style="font-size:12px">\'+p.icon+\'</span><span style="font-size:11px;font-weight:600;color:#0b1628">\'+escHtml(p.type)+\'</span></div>\'\n\n'
+'          +\'<div style="font-size:19px;font-weight:700;color:#0b1628;line-height:1.1;margin-bottom:3px">\'+escHtml(p.horse)+\'</div>\'\n\n'
+'          +\'<div style="font-size:11px;color:#aaa">\'+escHtml(p.detail)+\'</div>\'\n\n'
+'        +\'</div>\'\n\n'
+'        +\'<div style="text-align:right;flex-shrink:0;padding-left:12px">\'\n\n'
+'          +\'<div style="font-size:10px;color:#aaa;margin-bottom:2px;letter-spacing:.04em">PRICE</div>\'\n\n'
+'          +\'<div style="font-size:24px;font-weight:700;color:#1e9e6b;line-height:1">\'+escHtml(p.odds)+\'</div>\'\n\n'
+'        +\'</div>\'\n\n'
+'      +\'</div>\'\n\n'
+'      +\'<div style="padding:12px 16px;display:flex;flex-direction:column;gap:5px;border-bottom:1px solid #f0f0f0">\'+rows+\'</div>\'\n\n'
+'      +\'<div style="padding:10px 16px 14px">\'\n\n'
+'        +\'<button onclick="nrAddToSlip(\\\'\'+escHtml(p.horse)+\'\\\',\\\'\'+escHtml(p.odds)+\'\\\')" style="width:100%;background:#0b1628;color:#fff;border:none;border-radius:99px;padding:12px;font-size:13px;font-weight:600;cursor:pointer;font-family:inherit">+ Add to My Slip</button>\'\n\n'
+'      +\'</div>\'\n\n'
+'    +\'</div>\';\n\n'
+'  }).join(\'\');\n\n'
+'}\n';
try{new Function(origFn);}catch(e){console.error('FN SYNTAX:',e.message);process.exit(1);}
html=html.slice(0,fnStart)+origFn+html.slice(fnEnd);
console.log('3. renderRacingPicks restored');

// ── Syntax check ────────────────────────────────────────────────────────
const ss=html.lastIndexOf('<script>'),se=html.lastIndexOf('</script>');
try{new Function(html.slice(ss+8,se));console.log('Syntax: OK');}
catch(e){console.error('FULL SYNTAX:',e.message);process.exit(1);}

fs.writeFileSync('C:/Users/Gary Coyne/acca-research/index.html',html,'utf8');
console.log('Saved');
