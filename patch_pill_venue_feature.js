const fs=require('fs');
let html=fs.readFileSync('C:/Users/Gary Coyne/acca-research/index.html','utf8');

// ════════════════════════════════════════════════════════════════════════
// 1. Date pills — remove green underline + dot, keep text-color only
// ════════════════════════════════════════════════════════════════════════

// HTML: pill-today — remove border-bottom green + dot span
html=html.replace(
  '<button id="pill-today" onclick="selectRacingDate(\'today\')" style="background:none;color:#0b1628;border:none;border-bottom:2px solid #1e9e6b;padding:11px 16px;font-size:13px;font-weight:600;cursor:pointer;font-family:inherit;display:inline-flex;align-items:center;gap:5px"><span id="pdot-today" style="width:5px;height:5px;border-radius:50%;background:#1e9e6b;flex-shrink:0;display:inline-block"></span>Today</button>',
  '<button id="pill-today" onclick="selectRacingDate(\'today\')" style="background:none;color:#0b1628;border:none;border-bottom:2px solid transparent;padding:11px 16px;font-size:13px;font-weight:700;cursor:pointer;font-family:inherit">Today</button>'
);

// HTML: pill-tomorrow — remove border+dot span
html=html.replace(
  '<button id="pill-tomorrow" onclick="selectRacingDate(\'tomorrow\')" style="background:none;color:#b0b8c8;border:none;border-bottom:2px solid transparent;padding:11px 16px;font-size:13px;font-weight:500;cursor:pointer;font-family:inherit;display:inline-flex;align-items:center;gap:5px"><span id="pdot-tomorrow" style="width:5px;height:5px;border-radius:50%;background:#1e9e6b;flex-shrink:0;display:none"></span>Tomorrow</button>',
  '<button id="pill-tomorrow" onclick="selectRacingDate(\'tomorrow\')" style="background:none;color:#b0b8c8;border:none;border-bottom:2px solid transparent;padding:11px 16px;font-size:13px;font-weight:400;cursor:pointer;font-family:inherit">Tomorrow</button>'
);

// HTML: pill-upcoming — remove border+dot span
html=html.replace(
  '<button id="pill-upcoming" onclick="selectRacingDate(\'upcoming\')" style="background:none;color:#b0b8c8;border:none;border-bottom:2px solid transparent;padding:11px 16px;font-size:13px;font-weight:500;cursor:pointer;font-family:inherit;display:inline-flex;align-items:center;gap:5px"><span id="pdot-upcoming" style="width:5px;height:5px;border-radius:50%;background:#1e9e6b;flex-shrink:0;display:none"></span>Upcoming</button>',
  '<button id="pill-upcoming" onclick="selectRacingDate(\'upcoming\')" style="background:none;color:#b0b8c8;border:none;border-bottom:2px solid transparent;padding:11px 16px;font-size:13px;font-weight:400;cursor:pointer;font-family:inherit">Upcoming</button>'
);
console.log('1a. Pill HTML updated (no border/dot)');

// JS pillActive/pillInactive in selectRacingDate
html=html.replace(
  'var pillActive="background:none;color:#0b1628;border:none;border-bottom:2px solid #1e9e6b;padding:11px 16px;font-size:13px;font-weight:600;cursor:pointer;font-family:inherit;display:inline-flex;align-items:center;gap:5px";',
  'var pillActive="background:none;color:#0b1628;border:none;border-bottom:2px solid transparent;padding:11px 16px;font-size:13px;font-weight:700;cursor:pointer;font-family:inherit;";'
);
html=html.replace(
  'var pillInactive="background:none;color:#b0b8c8;border:none;border-bottom:2px solid transparent;padding:11px 16px;font-size:13px;font-weight:500;cursor:pointer;font-family:inherit;display:inline-flex;align-items:center;gap:5px";',
  'var pillInactive="background:none;color:#b0b8c8;border:none;border-bottom:2px solid transparent;padding:11px 16px;font-size:13px;font-weight:400;cursor:pointer;font-family:inherit;";'
);
console.log('1b. Pill JS styles updated');

// Remove dot toggle block from selectRacingDate
const oldDotBlock=
  '  // Active dot indicator\n'+
  '  var dtToday=document.getElementById("pdot-today");\n'+
  '  var dtTmrw=document.getElementById("pdot-tomorrow");\n'+
  '  var dtUp=document.getElementById("pdot-upcoming");\n'+
  '  if(dtToday) dtToday.style.display=d==="today"?"inline-block":"none";\n'+
  '  if(dtTmrw) dtTmrw.style.display=d==="tomorrow"?"inline-block":"none";\n'+
  '  if(dtUp) dtUp.style.display=d==="upcoming"?"inline-block":"none";\n';
if(html.includes(oldDotBlock)){
  html=html.replace(oldDotBlock,'');
  console.log('1c. Dot toggle JS removed');
} else {
  // try CRLF
  const cr=oldDotBlock.replace(/\n/g,'\r\n');
  if(html.includes(cr)){html=html.replace(cr,'');console.log('1c. Dot toggle JS removed (CRLF)');}
  else{console.log('WARN: dot block not found, skipping');}
}

// ════════════════════════════════════════════════════════════════════════
// 2. Venue names on banner cards — bump to 24px
// ════════════════════════════════════════════════════════════════════════

// Today cards (renderTodayMeetingsList)
html=html.replace(
  'out+=\'<div style="font-size:15px;font-weight:700;color:#fff;line-height:1;letter-spacing:-0.2px">\'+escHtml(m.name)+\'</div>\';',
  'out+=\'<div style="font-size:24px;font-weight:700;color:#fff;line-height:1;letter-spacing:-0.5px">\'+escHtml(m.name)+\'</div>\';'
);

// Tomorrow cards (renderTomorrowMeetingsList)
html=html.replace(
  'out+=\'<div style="font-size:20px;font-weight:700;color:#fff;line-height:1;letter-spacing:-0.3px">\'+escHtml(m.name)+\'</div>\';',
  'out+=\'<div style="font-size:24px;font-weight:700;color:#fff;line-height:1;letter-spacing:-0.5px">\'+escHtml(m.name)+\'</div>\';'
);
console.log('2. Venue names bumped to 24px');

// ════════════════════════════════════════════════════════════════════════
// 3. Remove FEATURE badge from banner cards
// ════════════════════════════════════════════════════════════════════════
html=html.replace(
  /\s*if\(m\.feature\) out\+='<span style="font-size:9px;font-weight:700;background:#1e9e6b;color:#fff;padding:2px 7px;border-radius:99px;letter-spacing:\.04em">FEATURE<\/span>';/g,
  ''
);
html=html.replace(
  /\s*if\(m\.feature\) out\+='<span style="font-size:11px;font-weight:600;padding:3px 9px;border-radius:20px;background:#f0faf6;color:#085041;border:1px solid #c8ead9">Feature Meeting<\/span>';/g,
  ''
);
html=html.replace(
  /\s*if\(m\.feature\) p\+='<span style="font-size:11px;font-weight:600;padding:3px 9px;border-radius:20px;background:#f0faf6;color:#085041;border:1px solid #c8ead9">Feature Meeting<\/span>';/g,
  ''
);
console.log('3. FEATURE badges removed');

// ── Syntax check ────────────────────────────────────────────────────────
const ss=html.lastIndexOf('<script>'),se=html.lastIndexOf('</script>');
try{new Function(html.slice(ss+8,se));console.log('Syntax: OK');}
catch(e){console.error('SYNTAX:',e.message);process.exit(1);}

fs.writeFileSync('C:/Users/Gary Coyne/acca-research/index.html',html,'utf8');
console.log('Saved');
