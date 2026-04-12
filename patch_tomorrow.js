const fs=require('fs');
let html=fs.readFileSync('C:/Users/Gary Coyne/acca-research/index.html','utf8');

// ════════════════════════════════════════════════════════════════════════
// PROMPT 1 — Replace tomorrow card gradients with today card images
// ════════════════════════════════════════════════════════════════════════

// The overlay gradient that follows every card's photo/gradient
const OVERLAY='\r\n\r\n          <div style="position:absolute;inset:0;background:linear-gradient(180deg,rgba(11,22,40,0.1)';

// Extract the 4 today img elements by order within racing-today-content
const todayStart=html.indexOf('id="racing-today-content"');
let scanPos=todayStart;
const todayImgs=[];
for(let i=0;i<4;i++){
  const s=html.indexOf('<img src="data:image/jpeg;base64,',scanPos);
  const e=html.indexOf(OVERLAY,s);
  todayImgs.push(html.slice(s,e));
  scanPos=e;
}
console.log('Extracted today imgs:',todayImgs.map((_,i)=>['Cork','Fairyhouse','Aintree','Kempton'][i]));

// Tomorrow venue name → today venue name → tomorrow gradient background
const pairs=[
  {tomorrowName:'Cheltenham', altFrom:'Cork',      todayImg:todayImgs[0], gradient:'background:linear-gradient(135deg,#0a2e1a 0%,#1a5c35 55%,#0b2840 100%)'},
  {tomorrowName:'Punchestown',altFrom:'Fairyhouse', todayImg:todayImgs[1], gradient:'background:linear-gradient(135deg,#0b2218 0%,#1e6b3a 50%,#152840 100%)'},
  {tomorrowName:'Navan',      altFrom:'Aintree',   todayImg:todayImgs[2], gradient:'background:linear-gradient(135deg,#0a2820 0%,#165c38 52%,#0b1e38 100%)'},
  {tomorrowName:'Southwell',  altFrom:'Kempton',   todayImg:todayImgs[3], gradient:'background:linear-gradient(135deg,#1a1a2e 0%,#2d3a5c 50%,#1a2840 100%)'},
];

for(const p of pairs){
  // Replace the img's alt attribute from today's venue to tomorrow's venue
  const newImg=p.todayImg.replace('alt="'+p.altFrom+'"','alt="'+p.tomorrowName+'"');
  // Build the gradient div to find and replace
  const gradientDiv='          <div style="position:absolute;inset:0;'+p.gradient+'"></div>';
  if(!html.includes(gradientDiv)){console.error('FAIL: gradient not found for '+p.tomorrowName);process.exit(1);}
  html=html.replace(gradientDiv,'          '+newImg);
  console.log('Replaced gradient with image for',p.tomorrowName);
}

// ════════════════════════════════════════════════════════════════════════
// PROMPT 2 — Pulsing / ripple animations on AI Edge strip
// ════════════════════════════════════════════════════════════════════════

// Add CSS keyframes before </style>
const newCSS=
'@keyframes aiFeedDotPulse{0%,100%{transform:scale(1);opacity:1}50%{transform:scale(1.4);opacity:0.6}}\n'+
'@keyframes aiFeedRipple{0%{transform:scale(1);opacity:0.2}100%{transform:scale(2.4);opacity:0}}\n'+
'@keyframes aiFeedBlink{0%,100%{opacity:1}50%{opacity:0.4}}\n'+
'.ai-feed-dot{animation:aiFeedDotPulse 1.5s ease-in-out infinite !important}\n'+
'.ai-feed-ripple{position:absolute;width:6px;height:6px;border-radius:50%;background:#1e9e6b;opacity:0.2;animation:aiFeedRipple 2s ease-out infinite;pointer-events:none}\n'+
'#feed-live-badge{animation:aiFeedBlink 2s ease-in-out infinite}\n';

const styleClose='</style>';
const styleCloseIdx=html.lastIndexOf(styleClose);
if(styleCloseIdx<0){console.error('FAIL: </style> not found');process.exit(1);}
html=html.slice(0,styleCloseIdx)+newCSS+html.slice(styleCloseIdx);
console.log('CSS animations added');

// Wrap the dot in a relative-positioned container so the ripple can sit behind it
const oldDot='<div style="background:#0b1628;border:1.5px solid #1e9e6b;color:#fff;font-size:10px;font-weight:700;letter-spacing:.05em;padding:4px 9px;border-radius:5px;display:flex;align-items:center;gap:4px"><div style="width:6px;height:6px;border-radius:50%;background:#1e9e6b;flex-shrink:0"></div>AI EDGE</div>';
const newDot='<div style="background:#0b1628;border:1.5px solid #1e9e6b;color:#fff;font-size:10px;font-weight:700;letter-spacing:.05em;padding:4px 9px;border-radius:5px;display:flex;align-items:center;gap:4px"><div style="position:relative;width:6px;height:6px;flex-shrink:0"><div class="ai-feed-ripple"></div><div class="ai-feed-dot" style="position:relative;z-index:1;width:6px;height:6px;border-radius:50%;background:#1e9e6b"></div></div>AI EDGE</div>';

if(!html.includes(oldDot)){console.error('FAIL: ai-feed-dot not found');process.exit(1);}
html=html.replace(oldDot,newDot);
console.log('Dot ripple wrapper added');

// ── Syntax check ──────────────────────────────────────────────────────────────
const ss=html.lastIndexOf('<script>'),se=html.lastIndexOf('</script>');
try{new Function(html.slice(ss+8,se));console.log('Syntax: OK');}
catch(e){console.error('SYNTAX:',e.message);process.exit(1);}

fs.writeFileSync('C:/Users/Gary Coyne/acca-research/index.html',html,'utf8');
console.log('Saved');
