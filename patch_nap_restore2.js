const fs=require('fs');
let html=fs.readFileSync('C:/Users/Gary Coyne/acca-research/index.html','utf8');

// ── Restore RACING_PICKS data ────────────────────────────────────────────
const dataStart=html.indexOf('var RACING_PICKS=[');
const dataEnd=html.indexOf('\nfunction renderRacingPicks(){');

const origData='var RACING_PICKS=[\n\n'
  +'  {type:\'NAP \xb7 Pick of the Day\',icon:\'\u26a1\',horse:\'Majolique\',detail:\'13:15 Cork \xb7 2m7f Maiden Hurdle\','
  +'reasons:[\'Top AI rating across form, going and trainer stats\','
  +'\'Won 3 of last 5 on Good to Yielding ground\','
  +'\'JP Townend booked \u2014 strong jockey booking signal\','
  +'\'Mullins yard in form with 5 winners this week\','
  +'\'Weighted well at the bottom of the handicap\'],'
  +'odds:\'2/1\',border:\'#1e9e6b\'},\n\n'
  +'  {type:\'NB \xb7 Next Best\',icon:\'\u2605\',horse:\'Proactif\',detail:\'13:50 Cork \xb7 2m4f Handicap Chase\','
  +'reasons:[\'Second highest AI rating on today\\\'s card\','
  +'\'Course and distance winner \u2014 won here twice last season\','
  +'\'Mullins booking Walsh \u2014 retained jockey is key signal\','
  +'\'Drops in class today after near miss at Leopardstown\','
  +'\'Strong finishing profile suits this track\\\'s long run-in\'],'
  +'odds:\'5/2\',border:\'#0b1628\'},\n\n'
  +'];\n';

try{new Function(origData);}catch(e){console.error('DATA ERR:',e.message);process.exit(1);}
html=html.slice(0,dataStart)+origData+html.slice(dataEnd);
console.log('1. Data restored');

// ── Restore renderRacingPicks ────────────────────────────────────────────
const fnStart=html.indexOf('\nfunction renderRacingPicks(){');
const fnEnd=html.indexOf('\nfunction renderRacingWinners(){');

const origFn=[
'\nfunction renderRacingPicks(){\n\n',
'  var el=document.getElementById(\'racing-picks-container\');\n\n',
'  if(!el) return;\n\n',
'  el.innerHTML=RACING_PICKS.map(function(p,i){\n\n',
'    var rows=p.reasons.map(function(r){\n\n',
'      return \'<div style="display:flex;align-items:baseline;gap:4px;font-size:10px;color:#555;line-height:1.4"><span style="color:#1e9e6b;font-weight:700;flex-shrink:0;font-size:10px">\u2713</span><span>\'+escHtml(r)+\'</span></div>\';\n\n',
'    }).join(\'\');\n\n',
'    return \'<div style="background:#fff;border:1px solid #e8eaed;border-radius:12px;overflow:hidden;border-left:4px solid \'+p.border+\'">\'\n\n',
'      +\'<div style="padding:14px 16px;display:flex;align-items:flex-start;justify-content:space-between;border-bottom:1px solid #f0f0f0">\'\n\n',
'        +\'<div>\'\n\n',
'          +\'<div style="display:inline-flex;align-items:center;gap:6px;border:1px solid #e8eaed;border-radius:99px;padding:3px 10px;margin-bottom:8px"><span style="font-size:12px">\'+p.icon+\'</span><span style="font-size:11px;font-weight:600;color:#0b1628">\'+escHtml(p.type)+\'</span></div>\'\n\n',
'          +\'<div style="font-size:19px;font-weight:700;color:#0b1628;line-height:1.1;margin-bottom:3px">\'+escHtml(p.horse)+\'</div>\'\n\n',
'          +\'<div style="font-size:11px;color:#aaa">\'+escHtml(p.detail)+\'</div>\'\n\n',
'        +\'</div>\'\n\n',
'        +\'<div style="text-align:right;flex-shrink:0;padding-left:12px">\'\n\n',
'          +\'<div style="font-size:10px;color:#aaa;margin-bottom:2px;letter-spacing:.04em">PRICE</div>\'\n\n',
'          +\'<div style="font-size:24px;font-weight:700;color:#1e9e6b;line-height:1">\'+escHtml(p.odds)+\'</div>\'\n\n',
'        +\'</div>\'\n\n',
'      +\'</div>\'\n\n',
'      +\'<div style="padding:12px 16px;display:flex;flex-direction:column;gap:5px;border-bottom:1px solid #f0f0f0">\'+rows+\'</div>\'\n\n',
'      +\'<div style="padding:10px 16px 14px">\'\n\n',
'        +\'<button onclick="nrAddToSlip(\\\'\'+escHtml(p.horse)+\'\\\',\\\'\'+escHtml(p.odds)+\'\\\')" style="width:100%;background:#0b1628;color:#fff;border:none;border-radius:99px;padding:12px;font-size:13px;font-weight:600;cursor:pointer;font-family:inherit">+ Add to My Slip</button>\'\n\n',
'      +\'</div>\'\n\n',
'    +\'</div>\';\n\n',
'  }).join(\'\');\n\n',
'}\n'
].join('');

try{new Function(origFn);}catch(e){console.error('FN ERR:',e.message);process.exit(1);}
html=html.slice(0,fnStart)+origFn+html.slice(fnEnd);
console.log('2. Render function restored');

// ── Syntax check ────────────────────────────────────────────────────────
const ss=html.lastIndexOf('<script>'),se=html.lastIndexOf('</script>');
try{new Function(html.slice(ss+8,se));console.log('Full syntax: OK');}
catch(e){console.error('FULL SYNTAX:',e.message);process.exit(1);}

fs.writeFileSync('C:/Users/Gary Coyne/acca-research/index.html',html,'utf8');
console.log('Saved');
