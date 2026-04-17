const fs=require('fs');
let html=fs.readFileSync('C:/Users/Gary Coyne/acca-research/index.html','utf8');

// ════════════════════════════════════════════════════════════════════════
// 1. Section heading — remove "With AI EDGE" subtitle, tighten up
// ════════════════════════════════════════════════════════════════════════
const oldHeading=
  '<div style="margin-bottom:12px;padding:0 16px">\n\n        <span style="font-size:24px;line-height:1;display:block;margin-bottom:6px">🎯</span>\n\n        <div style="font-size:22px;font-weight:700;color:var(--navy);line-height:1.1">Today\'s NAP &amp; NB</div>\n\n        <div style="font-size:13px;color:var(--muted);margin-top:4px;display:flex;align-items:center;gap:6px">With <div style="background:#0b1628;border:1.5px solid #c9a84c;border-radius:5px;padding:3px 8px;display:inline-flex;align-items:center;gap:4px;flex-shrink:0"><div style="width:5px;height:5px;border-radius:50%;background:#1e9e6b;flex-shrink:0"></div><span style="font-size:9px;font-weight:700;letter-spacing:0.1em;color:#fff">AI EDGE</span></div></div>\n\n      </div>';
const newHeading=
  '<div style="margin-bottom:10px;padding:0 16px">\n\n        <div style="font-size:20px;font-weight:800;color:var(--navy);line-height:1.1;letter-spacing:-0.3px">Today\'s NAP &amp; NB</div>\n\n        <div style="font-size:12px;color:var(--muted);margin-top:3px">AI-powered picks updated daily</div>\n\n      </div>';
if(!html.includes(oldHeading)){console.error('FAIL: heading not found');process.exit(1);}
html=html.replace(oldHeading,newHeading);
console.log('1. Section heading simplified');

// ════════════════════════════════════════════════════════════════════════
// 2. Rewrite renderRacingPicks card layout
// ════════════════════════════════════════════════════════════════════════
const fnStart=html.indexOf('\nfunction renderRacingPicks(){');
const fnEnd=html.indexOf('\nfunction renderRacingWinners(){');
if(fnStart<0||fnEnd<0){console.error('FAIL: render fn bounds');process.exit(1);}

var newFn='\n'
+'function renderRacingPicks(){\n'
+'  var el=document.getElementById(\'racing-picks-container\');\n'
+'  if(!el) return;\n'
+'  el.innerHTML=RACING_PICKS.map(function(p){\n'

// Signal rows — same clean slate style
+'    var sigRows=p.signals.map(function(s){\n'
+'      return \'<div style="display:flex;align-items:flex-start;gap:8px">\'\n'
+'        +\'<span style="font-size:8px;font-weight:700;letter-spacing:.06em;white-space:nowrap;flex-shrink:0;margin-top:2px;border-radius:4px;padding:2px 7px;color:#334155;background:#eef1f7;border:1px solid #c8d0e0">\'+s.tag+\'</span>\'\n'
+'        +\'<span style="font-size:12.5px;color:#3a3f4a;line-height:1.45">\'+escHtml(s.text)+\'</span>\'\n'
+'        +\'</div>\';\n'
+'    }).join(\'\');\n'

// Header band background — use border color
+'    var hdrBg=p.border;\n'
+'    var hdrTextCol=\'#fff\';\n'

+'    return \'<div style="background:#fff;border:none;overflow:hidden;">\'\n'

// ── Coloured header band: pick type + course/time + AI EDGE badge ──
+'      +\'<div style="background:\'+hdrBg+\';padding:10px 16px 11px;display:flex;align-items:center;justify-content:space-between">\'\n'
+'        +\'<div>\'\n'
+'          +\'<div style="font-size:9px;font-weight:800;letter-spacing:.1em;color:rgba(255,255,255,0.7);text-transform:uppercase;margin-bottom:3px">\'+escHtml(p.type)+\'</div>\'\n'
+'          +\'<div style="font-size:12px;font-weight:600;color:rgba(255,255,255,0.9)">\'+escHtml(p.detail)+\'</div>\'\n'
+'        +\'</div>\'\n'
// AI EDGE badge top right
+'        +\'<div style="background:rgba(255,255,255,0.12);border:1px solid rgba(255,255,255,0.3);border-radius:5px;padding:4px 9px;display:inline-flex;align-items:center;gap:4px">\'\n'
+'          +\'<div style="position:relative;width:5px;height:5px;flex-shrink:0"><div class="ai-feed-ripple"></div><div class="ai-feed-dot" style="position:relative;z-index:1;width:5px;height:5px;border-radius:50%;background:#1e9e6b"></div></div>\'\n'
+'          +\'<span style="font-size:8px;font-weight:800;color:#fff;letter-spacing:.1em">AI EDGE</span>\'\n'
+'        +\'</div>\'\n'
+'      +\'</div>\'\n'

// ── Hero: horse name + odds ──
+'      +\'<div style="padding:14px 16px 10px;display:flex;align-items:flex-end;justify-content:space-between;border-bottom:1px solid #f0f2f7">\'\n'
+'        +\'<div style="min-width:0;flex:1;padding-right:12px">\'\n'
+'          +\'<div style="font-size:30px;font-weight:900;color:#0b1628;line-height:1;letter-spacing:-0.8px;margin-bottom:0">\'+escHtml(p.horse)+\'</div>\'\n'
+'        +\'</div>\'\n'
+'        +\'<div style="text-align:right;flex-shrink:0">\'\n'
+'          +\'<div style="font-size:10px;color:#9aa3b5;letter-spacing:.06em;font-weight:600;margin-bottom:1px">ODDS</div>\'\n'
+'          +\'<div style="font-size:32px;font-weight:900;color:#1e9e6b;line-height:1;letter-spacing:-1px">\'+escHtml(p.odds)+\'</div>\'\n'
+'        +\'</div>\'\n'
+'      +\'</div>\'\n'

// ── Confidence bar — single compact row ──
+'      +\'<div style="padding:10px 16px;display:flex;align-items:center;gap:10px;border-bottom:1px solid #f0f2f7;background:#fafbfc">\'\n'
+'        +\'<span style="font-size:9px;font-weight:700;letter-spacing:.07em;color:#9aa3b5;white-space:nowrap;text-transform:uppercase">AI Confidence</span>\'\n'
+'        +\'<div style="flex:1;height:5px;border-radius:99px;background:#e8edf2">\'\n'
+'          +\'<div style="height:100%;width:\'+p.confidence+\'%;border-radius:99px;background:linear-gradient(90deg,#1e9e6b,#c9a84c)"></div>\'\n'
+'        +\'</div>\'\n'
+'        +\'<span style="font-size:14px;font-weight:800;color:#1e9e6b;white-space:nowrap">\'+p.confidence+\'%</span>\'\n'
+'      +\'</div>\'\n'

// ── Signal chips ──
+'      +\'<div style="padding:12px 16px 14px;display:flex;flex-direction:column;gap:9px;border-bottom:1px solid #f0f2f7">\'+sigRows+\'</div>\'\n'

// ── CTA ──
+'      +\'<div style="padding:12px 16px 14px">\'\n'
+'        +\'<button onclick="nrAddToSlip(\\\'\'+escHtml(p.horse)+\'\\\',\\\'\'+escHtml(p.odds)+\'\\\')" style="width:100%;background:#0b1628;color:#fff;border:none;border-radius:99px;padding:13px;font-size:13px;font-weight:600;cursor:pointer;font-family:inherit">+ Add to My Slip</button>\'\n'
+'      +\'</div>\'\n'

+'    +\'</div>\';\n'
+'  }).join(\'\');\n'
+'}\n';

// Syntax-check in isolation
try{new Function(newFn);}catch(e){console.error('FN SYNTAX:',e.message);process.exit(1);}
console.log('2. Card render function syntax OK');

html=html.slice(0,fnStart)+newFn+html.slice(fnEnd);

// ── Full syntax check ────────────────────────────────────────────────────
const ss=html.lastIndexOf('<script>'),se=html.lastIndexOf('</script>');
try{new Function(html.slice(ss+8,se));console.log('Full syntax: OK');}
catch(e){console.error('FULL SYNTAX:',e.message);process.exit(1);}

fs.writeFileSync('C:/Users/Gary Coyne/acca-research/index.html',html,'utf8');
console.log('Saved');
