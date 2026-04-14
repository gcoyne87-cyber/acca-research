const fs=require('fs');
let html=fs.readFileSync('C:/Users/Gary Coyne/acca-research/index.html','utf8');

// ── 1. Update section header — remove icon, clean title + subtitle ────────
const oldHeader=[
'      <div style="margin-bottom:12px;padding:0 16px">\n\n',
'        <span style="font-size:24px;line-height:1;display:block;margin-bottom:6px">\uD83C\uDFAF</span>\n\n',
'        <div style="font-size:22px;font-weight:700;color:var(--navy);line-height:1.1">Today\'s NAP &amp; NB</div>\n\n',
'        <div style="font-size:13px;color:var(--muted);margin-top:4px;display:flex;align-items:center;gap:6px">With ',
'<div style="background:#0b1628;border:1.5px solid #c9a84c;border-radius:5px;padding:3px 8px;display:inline-flex;align-items:center;gap:4px;flex-shrink:0">',
'<div style="width:5px;height:5px;border-radius:50%;background:#1e9e6b;flex-shrink:0"></div>',
'<span style="font-size:9px;font-weight:700;letter-spacing:0.1em;color:#fff">AI EDGE</span></div></div>\n\n      </div>'
].join('');

const newHeader=
'      <div style="margin-bottom:14px;padding:0 16px">\n' +
'        <div style="font-size:20px;font-weight:700;color:#0b1628;line-height:1.2">Today\'s NAP &amp; NB</div>\n' +
'        <div style="font-size:12px;color:#9aa3b5;margin-top:3px">AI-powered picks for today\'s racing</div>\n' +
'      </div>';

if(html.indexOf(oldHeader)<0){console.error('FAIL: header not found');process.exit(1);}
html=html.replace(oldHeader,newHeader);
console.log('1. Section header updated');

// ── 2. Update container — remove tinted bg, add side padding ─────────────
html=html.replace(
  '<div id="racing-picks-container" style="display:flex;flex-direction:column;gap:10px;background:#edf0f5">',
  '<div id="racing-picks-container" style="display:flex;flex-direction:column;gap:12px;padding:0 16px 16px">'
);
console.log('2. Container updated');

// ── 3. Rewrite renderRacingPicks ───────────────────────���──────────────────
const fnStart=html.indexOf('\nfunction renderRacingPicks(){');
const fnEnd=html.indexOf('\nfunction renderRacingWinners(){');
if(fnStart<0||fnEnd<0){console.error('FAIL: fn bounds');process.exit(1);}

const AI_BADGE=
  '<div style=\\"display:inline-flex;align-items:center;gap:4px;margin-bottom:10px;background:#0b1628;border:1.5px solid #c9a84c;border-radius:5px;padding:3px 8px\\">'
  +'<div style=\\"width:5px;height:5px;border-radius:50%;background:#1e9e6b;flex-shrink:0\\"></div>'
  +'<span style=\\"font-size:9px;font-weight:700;letter-spacing:0.1em;color:#fff\\">AI EDGE</span>'
  +'</div>';

const newFn=[
'\nfunction renderRacingPicks(){\n\n',
'  var el=document.getElementById(\'racing-picks-container\');\n\n',
'  if(!el) return;\n\n',
'  el.innerHTML=RACING_PICKS.map(function(p,i){\n\n',

'    var isNap=p.type.indexOf(\'NAP\')>=0;\n',
'    var tagBg=isNap?\'#fef9e7\':\'#f0faf5\';\n',
'    var tagBorder=isNap?\'1px solid #c9a84c\':\'1px solid #1e9e6b\';\n',
'    var tagColor=isNap?\'#7a5800\':\'#065f46\';\n\n',

'    var researchHtml=p.signals.map(function(s){\n',
'      return \'<strong style="font-weight:700;color:#111827;font-size:11px;letter-spacing:.03em">\'+escHtml(s.tag)+\'</strong> \'+escHtml(s.text);\n',
'    }).join(\'  \xb7  \');\n\n',

// Card outer
'    return \'<div style="background:#fff;border-radius:12px;border:1px solid #e8eaed;overflow:hidden">\'\n\n',

// Top row: tag + horse + detail | odds
'      +\'<div style="padding:15px 15px 13px;display:flex;align-items:flex-start;justify-content:space-between;gap:12px">\'\n',
'        +\'<div style="flex:1;min-width:0">\'\n',
'          +\'<div style="display:inline-flex;align-items:center;margin-bottom:8px;border-radius:5px;padding:3px 9px;font-size:10px;font-weight:700;letter-spacing:.05em;background:\'+tagBg+\';border:\'+tagBorder+\';color:\'+tagColor+\'">\'+escHtml(p.type)+\'</div>\'\n',
'          +\'<div style="font-size:20px;font-weight:800;color:#0b1628;line-height:1.1;margin-bottom:4px">\'+escHtml(p.horse)+\'</div>\'\n',
'          +\'<div style="font-size:11px;color:#9aa3b5;line-height:1.4">\'+escHtml(p.detail)+\'</div>\'\n',
'        +\'</div>\'\n',
'        +\'<div style="text-align:right;flex-shrink:0">\'\n',
'          +\'<div style="font-size:22px;font-weight:800;color:#1e9e6b;line-height:1">\'+escHtml(p.odds)+\'</div>\'\n',
'          +\'<div style="font-size:11px;color:#9aa3b5;margin-top:3px">E/W</div>\'\n',
'        +\'</div>\'\n',
'      +\'</div>\'\n\n',

// Hairline divider
'      +\'<div style="height:1px;background:#f3f4f6;margin:0 15px"></div>\'\n\n',

// AI EDGE badge + insight (plain white, no green box)
'      +\'<div style="padding:13px 15px">\'\n',
'        +\'<div style="display:inline-flex;align-items:center;gap:4px;margin-bottom:10px;background:#0b1628;border:1.5px solid #c9a84c;border-radius:5px;padding:3px 8px">\'\n',
'          +\'<div style="width:5px;height:5px;border-radius:50%;background:#1e9e6b;flex-shrink:0"></div>\'\n',
'          +\'<span style="font-size:9px;font-weight:700;letter-spacing:0.1em;color:#fff">AI EDGE</span>\'\n',
'        +\'</div>\'\n',
'        +\'<div style="font-size:13px;color:#4b5563;line-height:1.65">\'+researchHtml+\'</div>\'\n',
'      +\'</div>\'\n\n',

// CTA button
'      +\'<div style="padding:0 15px 15px">\'\n',
'        +\'<button onclick="nrAddToSlip(\\\'\'+escHtml(p.horse)+\'\\\',\\\'\'+escHtml(p.odds)+\'\\\')" style="width:100%;background:#0b1628;color:#fff;border:none;border-radius:99px;padding:12px;font-size:13px;font-weight:600;cursor:pointer;font-family:inherit">+ Add to My Slip</button>\'\n',
'      +\'</div>\'\n\n',

'    +\'</div>\';\n\n',
'  }).join(\'\');\n\n',
'}\n'
].join('');

try{new Function(newFn);}catch(e){console.error('FN SYNTAX ERR:',e.message);process.exit(1);}
html=html.slice(0,fnStart)+newFn+html.slice(fnEnd);
console.log('3. renderRacingPicks rewritten');

// ── Syntax check ────────────────────────────��─────────────────────────────
const ss=html.lastIndexOf('<script>'),se=html.lastIndexOf('</script>');
try{new Function(html.slice(ss+8,se));console.log('Syntax: OK');}
catch(e){console.error('GLOBAL SYNTAX ERR:',e.message);process.exit(1);}

fs.writeFileSync('C:/Users/Gary Coyne/acca-research/index.html',html,'utf8');
console.log('Saved');
