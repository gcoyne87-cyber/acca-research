const fs=require('fs');
let html=fs.readFileSync('C:/Users/Gary Coyne/acca-research/index.html','utf8');

// Tiny stacked badge — smaller than before
function smallBadge(){
  return '<div style="background:#0b1628;border:1.5px solid #c9a84c;border-radius:4px;padding:1px 5px;display:inline-flex;align-items:center;gap:3px"><div style="width:3px;height:3px;border-radius:50%;background:#1e9e6b;flex-shrink:0"></div><span style="font-size:7px;font-weight:700;color:#fff;letter-spacing:0.08em">AI EDGE</span></div>';
}

function stackedRow(races){
  return '<div style="margin-top:5px">\r\n\r\n              <div style="font-size:10px;font-weight:600;color:rgba(255,255,255,0.85);margin-bottom:3px">'+races+'</div>\r\n\r\n              '+smallBadge()+'\r\n\r\n            </div>';
}

// ── TODAY cards (currently side-by-side layout) ──────────────────────────────
const todayCards=[
  { races:'8 races' },
  { races:'7 races' },
  { races:'8 races' },
  { races:'7 races' },
];

const sideByBadge='<div style="background:#0b1628;border:1.5px solid #c9a84c;border-radius:4px;padding:2px 6px;display:inline-flex;align-items:center;gap:3px"><div style="width:4px;height:4px;border-radius:50%;background:#1e9e6b;flex-shrink:0"></div><span style="font-size:8px;font-weight:700;color:#fff;letter-spacing:0.08em">AI EDGE</span></div>';

todayCards.forEach(c=>{
  const old='<div style="margin-top:5px;display:flex;align-items:center;justify-content:space-between">\r\n\r\n              <span style="font-size:10px;font-weight:600;color:rgba(255,255,255,0.85)">'+c.races+'</span>\r\n\r\n              '+sideByBadge+'\r\n\r\n            </div>';
  if(!html.includes(old)){console.error('FAIL: today card row not found for '+c.races);process.exit(1);}
  html=html.replace(old,stackedRow(c.races));
});
console.log('Today cards updated (4)');

// ── TOMORROW cards (still have old ground+races structure) ────────────────────
const tomorrowCards=[
  { ground:'Good to Soft',   races:'7 races' },
  { ground:'Yielding',       races:'8 races' },
  { ground:'Good to Yielding',races:'6 races' },
  { ground:'Standard',       races:'7 races' },
];

tomorrowCards.forEach(c=>{
  const old='<div style="margin-top:5px;display:flex;align-items:center;gap:6px">\r\n\r\n              <span style="font-size:11px;color:rgba(255,255,255,0.65)">'+c.ground+'</span>\r\n\r\n              <span style="font-size:10px;font-weight:600;color:rgba(255,255,255,0.8);background:rgba(255,255,255,0.15);border-radius:99px;padding:2px 8px">'+c.races+'</span>\r\n\r\n            </div>';
  if(!html.includes(old)){console.error('FAIL: tomorrow card row not found for '+c.ground);process.exit(1);}
  html=html.replace(old,stackedRow(c.races));
});
console.log('Tomorrow cards updated (4)');

// ── Syntax check ──────────────────────────────────────────────────────────────
const ss=html.lastIndexOf('<script>'),se=html.lastIndexOf('</script>');
try{new Function(html.slice(ss+8,se));console.log('Syntax: OK');}
catch(e){console.error('SYNTAX:',e.message);process.exit(1);}

fs.writeFileSync('C:/Users/Gary Coyne/acca-research/index.html',html,'utf8');
console.log('Saved');
