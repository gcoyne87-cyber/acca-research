const fs=require('fs');
let html=fs.readFileSync('C:/Users/Gary Coyne/acca-research/index.html','utf8');

// ════════════════════════════════════════════════════════════════════════
// 1. RACING_PICKS data — restore signals + confidence
// ════════════════════════════════════════════════════════════════════════
const dataStart=html.indexOf('var RACING_PICKS=[');
const dataEnd=html.indexOf('\nfunction renderRacingPicks(){');

const newData='var RACING_PICKS=[\n\n'
  +'  {type:"NAP \xb7 Pick of the Day",icon:"\u26a1",horse:"Majolique",detail:"13:15 Cork \xb7 2m7f Maiden Hurdle",\n'
  +'   confidence:88,odds:"2/1",border:"#1e9e6b",\n'
  +'   signals:[\n'
  +'     {tag:"FORM",    text:"Top AI rating across form, going and trainer stats \u2014 highest score on today\u2019s card"},\n'
  +'     {tag:"GOING",   text:"Won 3 of last 5 on Good to Yielding ground \u2014 conditions ideal today at Cork"},\n'
  +'     {tag:"JOCKEY",  text:"JP Townend booked \u2014 Mullins doesn\u2019t put his number one up without reason"},\n'
  +'     {tag:"TRAINER", text:"Mullins yard running at 52% strike rate this season \u2014 5 winners in last 7 days"},\n'
  +'     {tag:"MARKET",  text:"Weighted well at bottom of handicap \u2014 3lb lower than last winning mark"}\n'
  +'   ]},\n\n'
  +'  {type:"NB \xb7 Next Best",icon:"\u2605",horse:"Proactif",detail:"13:50 Cork \xb7 2m4f Handicap Chase",\n'
  +'   confidence:74,odds:"5/2",border:"#0b1628",\n'
  +'   signals:[\n'
  +'     {tag:"FORM",    text:"Second highest AI rating on today\u2019s card \u2014 strong profile across three key metrics"},\n'
  +'     {tag:"CLASS",   text:"Course and distance winner \u2014 won here twice last season, track suits his jumping style"},\n'
  +'     {tag:"JOCKEY",  text:"Mullins puts Walsh up \u2014 retained jockey booking is the strongest signal in jump racing"},\n'
  +'     {tag:"CLASS",   text:"Drops in class after near miss at Leopardstown \u2014 easier opportunity today"},\n'
  +'     {tag:"GOING",   text:"Strong finishing profile suits the long run-in at Cork on today\u2019s ground"}\n'
  +'   ]},\n\n'
  +'];\n';

try{new Function(newData);}catch(e){console.error('DATA ERR:',e.message);process.exit(1);}
html=html.slice(0,dataStart)+newData+html.slice(dataEnd);
console.log('1. Data updated with signals + confidence');

// ════════════════════════════════════════════════════════════════════════
// 2. renderRacingPicks — original card shell + confidence bar + signal chips
// ════════════════════════════════════════════════════════════════════════
const fnStart=html.indexOf('\nfunction renderRacingPicks(){');
const fnEnd=html.indexOf('\nfunction renderRacingWinners(){');

const newFn=[
'\nfunction renderRacingPicks(){\n\n',
'  var el=document.getElementById(\'racing-picks-container\');\n\n',
'  if(!el) return;\n\n',
'  el.innerHTML=RACING_PICKS.map(function(p,i){\n\n',

// Signal rows — single unified slate style
'    var sigRows=p.signals.map(function(s){\n',
'      return \'<div style="display:flex;align-items:flex-start;gap:8px">\'\n',
'        +\'<span style="font-size:8px;font-weight:700;letter-spacing:.06em;white-space:nowrap;flex-shrink:0;margin-top:2px;border-radius:4px;padding:2px 7px;color:#334155;background:#eef1f7;border:1px solid #c8d0e0">\'+s.tag+\'</span>\'\n',
'        +\'<span style="font-size:12px;color:#444;line-height:1.45">\'+escHtml(s.text)+\'</span>\'\n',
'        +\'</div>\';\n',
'    }).join(\'\');\n\n',

// Card wrapper — original style
'    return \'<div style="background:#fff;border:1px solid #e8eaed;border-radius:12px;overflow:hidden;border-left:4px solid \'+p.border+\'">\'\n\n',

// Header — original layout: badge pill + horse + detail | PRICE + odds
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

// Confidence bar — compact single row, always green
'      +\'<div style="padding:9px 16px;display:flex;align-items:center;gap:10px;border-bottom:1px solid #f0f0f0;background:#fafbfc">\'\n',
'        +\'<span style="font-size:9px;font-weight:700;letter-spacing:.07em;color:#9aa3b5;white-space:nowrap;text-transform:uppercase">AI Confidence</span>\'\n',
'        +\'<div style="flex:1;height:4px;border-radius:99px;background:#e8edf2">\'\n',
'          +\'<div style="height:100%;width:\'+p.confidence+\'%;border-radius:99px;background:linear-gradient(90deg,#1e9e6b,#c9a84c)"></div>\'\n',
'        +\'</div>\'\n',
'        +\'<span style="font-size:13px;font-weight:800;color:#1e9e6b;white-space:nowrap">\'+p.confidence+\'%</span>\'\n',
'      +\'</div>\'\n\n',

// Signal chips
'      +\'<div style="padding:12px 16px;display:flex;flex-direction:column;gap:8px;border-bottom:1px solid #f0f0f0">\'+sigRows+\'</div>\'\n\n',

// CTA
'      +\'<div style="padding:10px 16px 14px">\'\n\n',
'        +\'<button onclick="nrAddToSlip(\\\'\'+escHtml(p.horse)+\'\\\',\\\'\'+escHtml(p.odds)+\'\\\')" style="width:100%;background:#0b1628;color:#fff;border:none;border-radius:99px;padding:12px;font-size:13px;font-weight:600;cursor:pointer;font-family:inherit">+ Add to My Slip</button>\'\n\n',
'      +\'</div>\'\n\n',

'    +\'</div>\';\n\n',
'  }).join(\'\');\n\n',
'}\n'
].join('');

try{new Function(newFn);}catch(e){console.error('FN ERR:',e.message);process.exit(1);}
html=html.slice(0,fnStart)+newFn+html.slice(fnEnd);
console.log('2. Render function updated');

// ── Syntax check ────────────────────────────────────────────────────────
const ss=html.lastIndexOf('<script>'),se=html.lastIndexOf('</script>');
try{new Function(html.slice(ss+8,se));console.log('Full syntax: OK');}
catch(e){console.error('FULL SYNTAX:',e.message);process.exit(1);}

fs.writeFileSync('C:/Users/Gary Coyne/acca-research/index.html',html,'utf8');
console.log('Saved');
