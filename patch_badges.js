const fs=require('fs');
let html=fs.readFileSync('C:/Users/Gary Coyne/acca-research/index.html','utf8');

// ════════════════════════════════════════════════════════════════════════
// PATTERN A — 8 identical venue card corner badges (position:absolute)
//   border:1.5px solid #1e9e6b, padding:4px 9px, 6px green dot
// ════════════════════════════════════════════════════════════════════════
const pA_old='background:#0b1628;border:1.5px solid #1e9e6b;color:#fff;font-size:10px;font-weight:700;letter-spacing:.05em;padding:4px 9px;border-radius:5px;display:flex;align-items:center;gap:4px"><div style="width:6px;height:6px;border-radius:50%;background:#1e9e6b;flex-shrink:0"></div> AI EDGE';
const pA_new='background:#0b1628;border:1.5px solid #c9a84c;color:#fff;font-size:10px;font-weight:700;letter-spacing:.05em;padding:3px 8px;border-radius:5px;display:flex;align-items:center;gap:4px"><div style="width:6px;height:6px;border-radius:50%;background:#c9a84c;flex-shrink:0"></div> AI EDGE';
const cntA=(html.match(new RegExp(pA_old.replace(/[.*+?^${}()|[\]\\]/g,'\\$&'),'g'))||[]).length;
if(cntA!==8){console.error('FAIL Pattern A: expected 8, found '+cntA);process.exit(1);}
html=html.split(pA_old).join(pA_new);
console.log('Pattern A: '+cntA+' venue card badges updated');

// ════════════════════════════════════════════════════════════════════════
// PATTERN B — AI feed strip badge with ripple/pulsing dot
//   border:1.5px solid #1e9e6b, padding:4px 9px, ripple + ai-feed-dot
// ════════════════════════════════════════════════════════════════════════
const pB_old='background:#0b1628;border:1.5px solid #1e9e6b;color:#fff;font-size:10px;font-weight:700;letter-spacing:.05em;padding:4px 9px;border-radius:5px;display:flex;align-items:center;gap:4px"><div style="position:relative;width:6px;height:6px;flex-shrink:0"><div class="ai-feed-ripple"></div><div class="ai-feed-dot" style="position:relative;z-index:1;width:6px;height:6px;border-radius:50%;background:#1e9e6b"></div></div>AI EDGE';
const pB_new='background:#0b1628;border:1.5px solid #c9a84c;color:#fff;font-size:10px;font-weight:700;letter-spacing:.05em;padding:3px 8px;border-radius:5px;display:flex;align-items:center;gap:4px"><div style="position:relative;width:6px;height:6px;flex-shrink:0"><div class="ai-feed-ripple"></div><div class="ai-feed-dot" style="position:relative;z-index:1;width:6px;height:6px;border-radius:50%;background:#c9a84c"></div></div>AI EDGE';
if(!html.includes(pB_old)){console.error('FAIL Pattern B: feed strip badge not found');process.exit(1);}
html=html.replace(pB_old,pB_new);
console.log('Pattern B: feed strip badge updated');

// ════════════════════════════════════════════════════════════════════════
// CSS — ai-feed-ripple background: #1e9e6b → #c9a84c
// ════════════════════════════════════════════════════════════════════════
const pCSS_old='.ai-feed-ripple{position:absolute;width:6px;height:6px;border-radius:50%;background:#1e9e6b;';
const pCSS_new='.ai-feed-ripple{position:absolute;width:6px;height:6px;border-radius:50%;background:#c9a84c;';
if(!html.includes(pCSS_old)){console.error('FAIL CSS: ai-feed-ripple not found');process.exit(1);}
html=html.replace(pCSS_old,pCSS_new);
console.log('CSS: ai-feed-ripple colour updated');

// ════════════════════════════════════════════════════════════════════════
// OCC 10 — rcInsightsHtml badge (&#x2756; symbol, no border, border-radius:4px)
// ════════════════════════════════════════════════════════════════════════
const p10_old='display:inline-flex;align-items:center;gap:5px;background:#0b1628;border-radius:4px;padding:3px 8px;margin-bottom:10px';
const p10_new='display:inline-flex;align-items:center;gap:5px;background:#0b1628;border:1.5px solid #c9a84c;border-radius:5px;padding:3px 8px;margin-bottom:10px';
if(!html.includes(p10_old)){console.error('FAIL occ10: rcInsightsHtml badge not found');process.exit(1);}
html=html.replace(p10_old,p10_new);
console.log('Occ10: rcInsightsHtml badge updated');

// ════════════════════════════════════════════════════════════════════════
// OCC 11 — Inline badge with border:1.5px solid #1e9e6b, 4px dot, 10sp indent
// ════════════════════════════════════════════════════════════════════════
const p11_old=
  '\'<div style=\"display:inline-flex;align-items:center;gap:3px;background:#0b1628;border:1.5px solid #1e9e6b;border-radius:4px;padding:2px 6px;flex-shrink:0;margin-top:1px\">\'\r\n'
  +'          +\'<div style=\"width:4px;height:4px;border-radius:50%;background:#1e9e6b;flex-shrink:0\"></div>\'\r\n'
  +'          +\'<span style=\"font-size:8px;font-weight:700;letter-spacing:0.1em;color:#fff\">AI EDGE</span>\'\r\n'
  +'        +\'</div>\'';
const p11_new=
  '\'<div style=\"display:inline-flex;align-items:center;gap:3px;background:#0b1628;border:1.5px solid #c9a84c;border-radius:5px;padding:3px 8px;flex-shrink:0;margin-top:1px\">\'\r\n'
  +'          +\'<div style=\"width:4px;height:4px;border-radius:50%;background:#c9a84c;flex-shrink:0\"></div>\'\r\n'
  +'          +\'<span style=\"font-size:8px;font-weight:700;letter-spacing:0.1em;color:#fff\">AI EDGE</span>\'\r\n'
  +'        +\'</div>\'';
if(!html.includes(p11_old)){console.error('FAIL occ11: inline badge (with border) not found');process.exit(1);}
html=html.replace(p11_old,p11_new);
console.log('Occ11: inline badge (border, 10sp) updated');

// ════════════════════════════════════════════════════════════════════════
// OCC 12 — Inline badge with &#x2756;, no border, padding:3px 7px, 8sp indent
// ════════════════════════════════════════════════════════════════════════
const p12_old='flex-shrink:0;background:#0b1628;border-radius:4px;padding:3px 7px;display:inline-flex;align-items:center;gap:4px;margin-top:1px';
const p12_new='flex-shrink:0;background:#0b1628;border:1.5px solid #c9a84c;border-radius:5px;padding:3px 8px;display:inline-flex;align-items:center;gap:4px;margin-top:1px';
if(!html.includes(p12_old)){console.error('FAIL occ12: diamond badge not found');process.exit(1);}
html=html.replace(p12_old,p12_new);
console.log('Occ12: diamond badge updated');

// ════════════════════════════════════════════════════════════════════════
// OCC 13 — nrAiTag() badge: no border, border-radius:4px, 5px dot
// ════════════════════════════════════════════════════════════════════════
const p13_old=
  '\'<div style=\"display:inline-flex;align-items:center;gap:4px;background:#0b1628;border-radius:4px;padding:3px 8px\">\'\r\n'
  +'    +\'<div style=\"width:5px;height:5px;border-radius:50%;background:#1e9e6b;flex-shrink:0\"></div>\'\r\n'
  +'    +\'<span style=\"font-size:9px;font-weight:700;letter-spacing:0.1em;color:#fff\">AI EDGE</span>\'\r\n'
  +'  +\'</div>\';';
const p13_new=
  '\'<div style=\"display:inline-flex;align-items:center;gap:4px;background:#0b1628;border:1.5px solid #c9a84c;border-radius:5px;padding:3px 8px\">\'\r\n'
  +'    +\'<div style=\"width:5px;height:5px;border-radius:50%;background:#c9a84c;flex-shrink:0\"></div>\'\r\n'
  +'    +\'<span style=\"font-size:9px;font-weight:700;letter-spacing:0.1em;color:#fff\">AI EDGE</span>\'\r\n'
  +'  +\'</div>\';';
if(!html.includes(p13_old)){console.error('FAIL occ13: nrAiTag badge not found');process.exit(1);}
html=html.replace(p13_old,p13_new);
console.log('Occ13: nrAiTag badge updated');

// ════════════════════════════════════════════════════════════════════════
// OCC 14 — Inline badge: no border, border-radius:4px, 4px dot, 6sp indent
// ════════════════════════════════════════════════════════════════════════
const p14_old=
  '\'<div style=\"display:inline-flex;align-items:center;gap:3px;background:#0b1628;border-radius:4px;padding:2px 6px;flex-shrink:0;margin-top:1px\">\'\r\n'
  +'        +\'<div style=\"width:4px;height:4px;border-radius:50%;background:#1e9e6b;flex-shrink:0\"></div>\'\r\n'
  +'        +\'<span style=\"font-size:8px;font-weight:700;letter-spacing:0.1em;color:#fff\">AI EDGE</span>\'\r\n'
  +'      +\'</div>\'';
const p14_new=
  '\'<div style=\"display:inline-flex;align-items:center;gap:3px;background:#0b1628;border:1.5px solid #c9a84c;border-radius:5px;padding:3px 8px;flex-shrink:0;margin-top:1px\">\'\r\n'
  +'        +\'<div style=\"width:4px;height:4px;border-radius:50%;background:#c9a84c;flex-shrink:0\"></div>\'\r\n'
  +'        +\'<span style=\"font-size:8px;font-weight:700;letter-spacing:0.1em;color:#fff\">AI EDGE</span>\'\r\n'
  +'      +\'</div>\'';
if(!html.includes(p14_old)){console.error('FAIL occ14: inline badge (no border, 6sp) not found');process.exit(1);}
html=html.replace(p14_old,p14_new);
console.log('Occ14: inline badge (no border, 6sp) updated');

// ── Verify no #1e9e6b remains in any AI EDGE badge context ───────────────────
const remaining=[];
let p=0;
while(true){
  const idx=html.indexOf('AI EDGE',p);
  if(idx<0) break;
  const ctx=html.slice(idx-400,idx+10);
  if(ctx.includes('#1e9e6b')) remaining.push(idx);
  p=idx+1;
}
if(remaining.length>0){
  console.error('WARNING: #1e9e6b still present near AI EDGE at positions:',remaining);
}else{
  console.log('Verification: no #1e9e6b remaining in any AI EDGE badge');
}

// ── Syntax check ──────────────────────────────────────────────────────────────
const ss=html.lastIndexOf('<script>'),se=html.lastIndexOf('</script>');
try{new Function(html.slice(ss+8,se));console.log('Syntax: OK');}
catch(e){console.error('SYNTAX:',e.message);process.exit(1);}

fs.writeFileSync('C:/Users/Gary Coyne/acca-research/index.html',html,'utf8');
console.log('Saved');
