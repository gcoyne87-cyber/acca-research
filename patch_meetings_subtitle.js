const fs=require('fs');
let html=fs.readFileSync('C:/Users/Gary Coyne/acca-research/index.html','utf8');

// ════════════════════════════════════════════════════════════════════════
// 1. Today's Meetings subtitle only (first occurrence, color:#4a8c6a)
//    "Tap a course to jump to its race card"
//    → "Analysis available with [AI EDGE badge — green dot, gold border]"
// ════════════════════════════════════════════════════════════════════════
const badge='<div style="background:#0b1628;border:1.5px solid #c9a84c;border-radius:5px;padding:3px 8px;display:inline-flex;align-items:center;gap:4px;flex-shrink:0"><div style="width:5px;height:5px;border-radius:50%;background:#1e9e6b;flex-shrink:0"></div><span style="font-size:9px;font-weight:700;letter-spacing:0.1em;color:#fff">AI EDGE</span></div>';

const oldTodaySub='<div style="font-size:13px;color:#4a8c6a;margin-top:4px">Tap a course to jump to its race card</div>\r\n\r\n        </div>';
const newTodaySub='<div style="font-size:13px;color:#4a8c6a;margin-top:4px;display:flex;align-items:center;gap:6px">Analysis available with '+badge+'</div>\r\n\r\n        </div>';

if(!html.includes(oldTodaySub)){console.error('FAIL: Today\'s Meetings subtitle not found');process.exit(1);}
html=html.replace(oldTodaySub,newTodaySub);
console.log('1. Today\'s Meetings subtitle updated');

// ════════════════════════════════════════════════════════════════════════
// 2. Remove AI EDGE corner badges from all 8 venue photo cards
// ════════════════════════════════════════════════════════════════════════
const venueBadge='<div style="position:absolute;top:10px;left:10px;background:#0b1628;border:1.5px solid #c9a84c;color:#fff;font-size:10px;font-weight:700;letter-spacing:.05em;padding:3px 8px;border-radius:5px;display:flex;align-items:center;gap:4px"><div style="width:6px;height:6px;border-radius:50%;background:#c9a84c;flex-shrink:0"></div> AI EDGE</div>';
const cnt=(html.split(venueBadge).length-1);
if(cnt!==8){console.error('FAIL: expected 8 venue badges, found '+cnt);process.exit(1);}
html=html.split(venueBadge).join('');
console.log('2. Removed '+cnt+' venue card corner badges');

// ── Syntax check ──────────────────────────────────────────────────────────────
const ss=html.lastIndexOf('<script>'),se=html.lastIndexOf('</script>');
try{new Function(html.slice(ss+8,se));console.log('Syntax: OK');}
catch(e){console.error('SYNTAX:',e.message);process.exit(1);}

fs.writeFileSync('C:/Users/Gary Coyne/acca-research/index.html',html,'utf8');
console.log('Saved');
