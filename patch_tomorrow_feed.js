const fs=require('fs');
let html=fs.readFileSync('C:/Users/Gary Coyne/acca-research/index.html','utf8');

// ════════════════════════════════════════════════════════════════════════
// 1. Remove duplicate TOMORROW WINNERS section (the second one)
// ════════════════════════════════════════════════════════════════════════
const twMarker='\r\n\r\n\r\n  <!-- TOMORROW WINNERS -->';
const tw1=html.indexOf(twMarker);
if(tw1<0){console.error('FAIL: first TOMORROW WINNERS not found');process.exit(1);}
const tw2=html.indexOf(twMarker,tw1+1);
if(tw2<0){console.error('FAIL: second TOMORROW WINNERS not found — may already be removed');process.exit(0);}
const tnMarker='\r\n\r\n  <!-- TOMORROW NAP -->';
const tn=html.indexOf(tnMarker,tw2);
if(tn<0){console.error('FAIL: TOMORROW NAP not found after second TW');process.exit(1);}
// Delete from start of second TW marker up to (not including) TOMORROW NAP marker
html=html.slice(0,tw2)+html.slice(tn);
console.log('1. Duplicate TOMORROW WINNERS section removed');

// ════════════════════════════════════════════════════════════════════════
// 2. Add AI rotating tips strip to Tomorrow tab
//    Insert just before <!-- TOMORROW WINNERS --> (now the only one)
// ════════════════════════════════════════════════════════════════════════
const insertAnchor='</div>\r\n\r\n  </div>\r\n\r\n\r\n  <!-- TOMORROW WINNERS -->';
if(!html.includes(insertAnchor)){console.error('FAIL: tomorrow insert anchor not found');process.exit(1);}

const tomorrowFeedHtml=
  '</div>\r\n\r\n  </div>\r\n\r\n'
  +'  <!-- AI FEED STRIP TOMORROW -->\r\n\r\n'
  +'  <div id="ai-feed-strip-tomorrow" style="padding:8px 16px;display:flex;align-items:center;gap:10px">\r\n'
  +'    <div style="display:flex;flex-direction:column;align-items:center;gap:4px;flex-shrink:0">\r\n'
  +'      <span style="font-size:9px;font-weight:700;color:#4a8c6a;text-transform:uppercase;letter-spacing:0.06em">Tomorrow\'s Racing</span>\r\n'
  +'      <div style="background:#0b1628;border:1.5px solid #c9a84c;color:#fff;font-size:10px;font-weight:700;letter-spacing:.05em;padding:3px 8px;border-radius:5px;display:flex;align-items:center;gap:4px"><div style="position:relative;width:6px;height:6px;flex-shrink:0"><div class="ai-feed-ripple"></div><div class="ai-feed-dot" style="position:relative;z-index:1;width:6px;height:6px;border-radius:50%;background:#1e9e6b"></div></div>AI EDGE</div>\r\n'
  +'    </div>\r\n'
  +'    <div style="padding:8px 12px;flex:1;min-width:0">\r\n'
  +'      <div id="ai-feed-msg-tomorrow" style="font-size:13px;color:#1a5c3a;font-weight:500;line-height:1.4;position:relative"></div>\r\n'
  +'    </div>\r\n'
  +'  </div>\r\n\r\n'
  +'\r\n  <!-- TOMORROW WINNERS -->';

html=html.replace(insertAnchor, tomorrowFeedHtml);
console.log('2. AI feed strip added to Tomorrow tab');

// ════════════════════════════════════════════════════════════════════════
// 3. Add aiFeedInitTomorrow() function and wire into selectRacingDate
// ════════════════════════════════════════════════════════════════════════

// 3a. Add the init function after aiFeedTick
const afterTick='function aiFeedInit(){';
if(!html.includes(afterTick)){console.error('FAIL: aiFeedInit not found');process.exit(1);}

const tomorrowInitFn=
  'function aiFeedInitTomorrow(){\r\n'+
  '  var msg=document.getElementById("ai-feed-msg-tomorrow");\r\n'+
  '  if(!msg) return;\r\n'+
  '  if(msg.textContent) return;\r\n'+
  '  msg.textContent=AI_FEED_MESSAGES[0];\r\n'+
  '  msg.style.animation="";\r\n'+
  '  if(!window._aiFeedTimerTm) window._aiFeedTimerTm=setInterval(function(){\r\n'+
  '    var m=document.getElementById("ai-feed-msg-tomorrow");\r\n'+
  '    if(!m) return;\r\n'+
  '    m.style.animation="aiFeedSlideOut 0.4s ease forwards";\r\n'+
  '    setTimeout(function(){\r\n'+
  '      aiFeedIdx=(aiFeedIdx+1)%AI_FEED_MESSAGES.length;\r\n'+
  '      m.textContent=AI_FEED_MESSAGES[aiFeedIdx];\r\n'+
  '      m.style.animation="aiFeedSlideIn 0.4s ease forwards";\r\n'+
  '    },400);\r\n'+
  '  },8000);\r\n'+
  '}\r\n'+
  'function aiFeedInit(){';

html=html.replace(afterTick, tomorrowInitFn);
console.log('3a. aiFeedInitTomorrow() added');

// 3b. Call aiFeedInitTomorrow() when tomorrow tab is selected
// Find the line in selectRacingDate that shows/hides tomorrow content
const oldTmDisplay='  if(tmrw) tmrw.style.display=d==="tomorrow"?"":"none";\r\n  if(winners)';
const newTmDisplay='  if(tmrw) tmrw.style.display=d==="tomorrow"?"":"none";\r\n  if(d==="tomorrow") aiFeedInitTomorrow();\r\n  if(winners)';
if(!html.includes(oldTmDisplay)){console.error('FAIL: tomorrow display line in selectRacingDate not found');process.exit(1);}
html=html.replace(oldTmDisplay, newTmDisplay);
console.log('3b. aiFeedInitTomorrow() called in selectRacingDate');

// ── Syntax check ─────────────────────────────────────────────────────────────
const ss=html.lastIndexOf('<script>'),se=html.lastIndexOf('</script>');
try{new Function(html.slice(ss+8,se));console.log('Syntax: OK');}
catch(e){console.error('SYNTAX:',e.message);process.exit(1);}

fs.writeFileSync('C:/Users/Gary Coyne/acca-research/index.html',html,'utf8');
console.log('Saved');
