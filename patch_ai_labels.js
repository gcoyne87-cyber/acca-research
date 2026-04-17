const fs=require('fs');
let html=fs.readFileSync('C:/Users/Gary Coyne/acca-research/index.html','utf8');

// ════════════════════════════════════════════════════════════════════════
// 1. Today strip — add "Today's Racing" label above badge
// ════════════════════════════════════════════════════════════════════════
// Find the today strip badge div (has ai-feed-dot class inside)
const todayBadgeOld=
  '<div style="background:#0b1628;border:1.5px solid #c9a84c;color:#fff;font-size:10px;font-weight:700;letter-spacing:.07em;padding:4px 9px;border-radius:5px;display:flex;align-items:center;gap:4px"><div style="position:relative;width:6px;height:6px;flex-shrink:0"><div class="ai-feed-ripple"></div><div class="ai-feed-dot" style="position:relative;z-index:1;width:6px;height:6px;border-radius:50%;background:#1e9e6b"></div></div>AI EDGE</div>\n          <span style="font-size:8px;font-weight:800;color:#e03131;letter-spacing:.04em">● LIVE</span>';

const todayBadgeNew=
  '<span style="font-size:9px;font-weight:700;color:#4a8c6a;text-transform:uppercase;letter-spacing:0.06em">Today\'s Racing</span>\n          <div style="background:#0b1628;border:1.5px solid #c9a84c;color:#fff;font-size:10px;font-weight:700;letter-spacing:.07em;padding:4px 9px;border-radius:5px;display:flex;align-items:center;gap:4px"><div style="position:relative;width:6px;height:6px;flex-shrink:0"><div class="ai-feed-ripple"></div><div class="ai-feed-dot" style="position:relative;z-index:1;width:6px;height:6px;border-radius:50%;background:#1e9e6b"></div></div>AI EDGE</div>\n          <span style="font-size:8px;font-weight:800;color:#e03131;letter-spacing:.04em">● LIVE</span>';

if(!html.includes(todayBadgeOld)){console.error('FAIL: today badge not found');process.exit(1);}
html=html.replace(todayBadgeOld,todayBadgeNew);
console.log('1. Today strip: "Today\'s Racing" label added');

// ════════════════════════════════════════════════════════════════════════
// 2. Tomorrow strip — add "Tomorrow's Racing" label, no LIVE badge
// ════════════════════════════════════════════════════════════════════════
// Tomorrow strip has same badge but no ai-feed-dot class on inner div
const tmrwBadgeOld=
  '<div style="background:#0b1628;border:1.5px solid #c9a84c;color:#fff;font-size:10px;font-weight:700;letter-spacing:.07em;padding:4px 9px;border-radius:5px;display:flex;align-items:center;gap:4px"><div style="position:relative;width:6px;height:6px;flex-shrink:0"><div class="ai-feed-ripple"></div><div style="position:relative;z-index:1;width:6px;height:6px;border-radius:50%;background:#1e9e6b"></div></div>AI EDGE</div>\n        <span style="font-size:8px;font-weight:800;color:#e03131;letter-spacing:.04em">● LIVE</span>';

const tmrwBadgeNew=
  '<span style="font-size:9px;font-weight:700;color:#4a8c6a;text-transform:uppercase;letter-spacing:0.06em">Tomorrow\'s Racing</span>\n        <div style="background:#0b1628;border:1.5px solid #c9a84c;color:#fff;font-size:10px;font-weight:700;letter-spacing:.07em;padding:4px 9px;border-radius:5px;display:flex;align-items:center;gap:4px"><div style="position:relative;width:6px;height:6px;flex-shrink:0"><div class="ai-feed-ripple"></div><div style="position:relative;z-index:1;width:6px;height:6px;border-radius:50%;background:#1e9e6b"></div></div>AI EDGE</div>';

if(!html.includes(tmrwBadgeOld)){console.error('FAIL: tomorrow badge not found');process.exit(1);}
html=html.replace(tmrwBadgeOld,tmrwBadgeNew);
console.log('2. Tomorrow strip: "Tomorrow\'s Racing" label added, LIVE removed');

// ── Syntax check ────────────────────────────────────────────────────────
const ss=html.lastIndexOf('<script>'),se=html.lastIndexOf('</script>');
try{new Function(html.slice(ss+8,se));console.log('Syntax: OK');}
catch(e){console.error('SYNTAX:',e.message);process.exit(1);}

fs.writeFileSync('C:/Users/Gary Coyne/acca-research/index.html',html,'utf8');
console.log('Saved');
