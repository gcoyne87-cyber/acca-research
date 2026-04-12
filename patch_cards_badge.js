const fs=require('fs');
let html=fs.readFileSync('C:/Users/Gary Coyne/acca-research/index.html','utf8');

// ════════════════════════════════════════════════════════════════════════
// 1. Remove the "With [AI EDGE]" subtitle from Today's Meetings heading
// ════════════════════════════════════════════════════════════════════════
const oldMeetingsSub='\r\n\r\n          <div style="font-size:13px;color:#4a8c6a;margin-top:4px;display:flex;align-items:center;gap:6px">With <div style="background:#0b1628;border:1.5px solid #c9a84c;border-radius:5px;padding:3px 8px;display:inline-flex;align-items:center;gap:4px;flex-shrink:0"><div style="width:5px;height:5px;border-radius:50%;background:#1e9e6b;flex-shrink:0"></div><span style="font-size:9px;font-weight:700;letter-spacing:0.1em;color:#fff">AI EDGE</span></div></div>';
if(!html.includes(oldMeetingsSub)){console.error('FAIL: Today\'s Meetings subtitle not found');process.exit(1);}
html=html.replace(oldMeetingsSub,'');
console.log('1. Today\'s Meetings subtitle removed');

// ════════════════════════════════════════════════════════════════════════
// Small AI EDGE badge for the cards (compact, right-aligned)
// ════════════════════════════════════════════════════════════════════════
const smallBadge='<div style="background:#0b1628;border:1.5px solid #c9a84c;border-radius:4px;padding:2px 6px;display:inline-flex;align-items:center;gap:3px"><div style="width:4px;height:4px;border-radius:50%;background:#1e9e6b;flex-shrink:0"></div><span style="font-size:8px;font-weight:700;color:#fff;letter-spacing:0.08em">AI EDGE</span></div>';

function newRow(raceCount){
  return '<div style="margin-top:5px;display:flex;align-items:center;justify-content:space-between">\r\n\r\n              <span style="font-size:10px;font-weight:600;color:rgba(255,255,255,0.85)">'+raceCount+'</span>\r\n\r\n              '+smallBadge+'\r\n\r\n            </div>';
}

// ════════════════════════════════════════════════════════════════════════
// 2. Update each today card's bottom row
// ════════════════════════════════════════════════════════════════════════
const cards=[
  {
    old: '<div style="margin-top:5px;display:flex;align-items:center;gap:6px">\r\n\r\n              <span style="font-size:11px;color:rgba(255,255,255,0.65)">Good to Yielding</span>\r\n\r\n              <span style="font-size:10px;font-weight:600;color:rgba(255,255,255,0.8);background:rgba(255,255,255,0.15);border-radius:99px;padding:2px 8px">8 races</span>\r\n\r\n            </div>',
    new: newRow('8 races')
  },
  {
    old: '<div style="margin-top:5px;display:flex;align-items:center;gap:6px">\r\n\r\n              <span style="font-size:11px;color:rgba(255,255,255,0.65)">Yielding</span>\r\n\r\n              <span style="font-size:10px;font-weight:600;color:rgba(255,255,255,0.8);background:rgba(255,255,255,0.15);border-radius:99px;padding:2px 8px">7 races</span>\r\n\r\n            </div>',
    new: newRow('7 races')
  },
  {
    old: '<div style="margin-top:5px;display:flex;align-items:center;gap:6px">\r\n\r\n              <span style="font-size:11px;color:rgba(255,255,255,0.65)">Good to Soft</span>\r\n\r\n              <span style="font-size:10px;font-weight:600;color:rgba(255,255,255,0.8);background:rgba(255,255,255,0.15);border-radius:99px;padding:2px 8px">8 races</span>\r\n\r\n            </div>',
    new: newRow('8 races')
  },
  {
    old: '<div style="margin-top:5px;display:flex;align-items:center;gap:6px">\r\n\r\n              <span style="font-size:11px;color:rgba(255,255,255,0.65)">Standard (AW)</span>\r\n\r\n              <span style="font-size:10px;font-weight:600;color:rgba(255,255,255,0.8);background:rgba(255,255,255,0.15);border-radius:99px;padding:2px 8px">7 races</span>\r\n\r\n            </div>',
    new: newRow('7 races')
  },
];

const venues=['Cork','Fairyhouse','Aintree','Kempton'];
cards.forEach((c,i)=>{
  if(!html.includes(c.old)){console.error('FAIL: '+venues[i]+' card row not found');process.exit(1);}
  html=html.replace(c.old,c.new);
  console.log('2. '+venues[i]+' card updated');
});

// ── Syntax check ──────────────────────────────────────────────────────────────
const ss=html.lastIndexOf('<script>'),se=html.lastIndexOf('</script>');
try{new Function(html.slice(ss+8,se));console.log('Syntax: OK');}
catch(e){console.error('SYNTAX:',e.message);process.exit(1);}

fs.writeFileSync('C:/Users/Gary Coyne/acca-research/index.html',html,'utf8');
console.log('Saved');
