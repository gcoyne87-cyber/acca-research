const fs=require('fs');
let html=fs.readFileSync('C:/Users/Gary Coyne/acca-research/index.html','utf8');

// ════════════════════════════════════════════════════════════════════════
// 1. Remove "Today's Meetings" heading block
// ════════════════════════════════════════════════════════════════════════
const todayHeadingBlock=
  '\n    <div style="padding:16px 0 4px">\n\n      <div style="padding:0 12px;display:flex;align-items:flex-end;justify-content:space-between;margin-bottom:12px">\n\n        <div>\n\n          <div style="font-size:20px;font-weight:700;color:#0b1628;line-height:1.1">Today\'s Meetings</div>\n\n\n        </div>\n\n      </div>\n';
if(!html.includes(todayHeadingBlock)){console.error('FAIL: Today heading block not found');process.exit(1);}
html=html.replace(todayHeadingBlock,'\n    <div style="padding:8px 0 4px">\n');
console.log('1. Today\'s Meetings heading removed');

// ════════════════════════════════════════════════════════════════════════
// 2. Remove "Tomorrow's Meetings" heading block
// ════════════════════════════════════════════════════════════════════════
const tmrwHeadingBlock=
  '\n  <div style="padding:16px 0 4px">\n\n    <div style="padding:0 12px;display:flex;align-items:flex-end;justify-content:space-between;margin-bottom:12px">\n\n      <div>\n\n        <div style="font-size:20px;font-weight:700;color:#0b1628;line-height:1.1">Tomorrow\'s Meetings</div>\n\n      </div>\n\n    </div>\n';
if(!html.includes(tmrwHeadingBlock)){console.error('FAIL: Tomorrow heading block not found');process.exit(1);}
html=html.replace(tmrwHeadingBlock,'\n  <div style="padding:8px 0 4px">\n');
console.log('2. Tomorrow\'s Meetings heading removed');

// ════════════════════════════════════════════════════════════════════════
// 3. Add progress bar CSS + improved fade keyframes
// ════════════════════════════════════════════════════════════════════════
const oldKeyframes='@keyframes aiFeedSlideOut{from{transform:translateX(0);opacity:1}to{transform:translateX(-100%);opacity:0}}\n@keyframes aiFeedSlideIn{from{transform:translateX(100%);opacity:0}to{transform:translateX(0);opacity:1}}';
const newKeyframes=
  '@keyframes aiFeedFadeUp{from{opacity:0;transform:translateY(5px)}to{opacity:1;transform:translateY(0)}}\n'+
  '@keyframes aiFeedFadeDown{from{opacity:1;transform:translateY(0)}to{opacity:0;transform:translateY(-5px)}}\n'+
  '@keyframes aiFeedProgressFill{from{width:0%}to{width:100%}}\n'+
  '@keyframes aiFeedSlideOut{from{transform:translateX(0);opacity:1}to{transform:translateX(-100%);opacity:0}}\n'+
  '@keyframes aiFeedSlideIn{from{transform:translateX(100%);opacity:0}to{transform:translateX(0);opacity:1}}';
if(!html.includes(oldKeyframes)){console.error('FAIL: keyframes not found');process.exit(1);}
html=html.replace(oldKeyframes,newKeyframes);
console.log('3. New CSS keyframes added');

// ════════════════════════════════════════════════════════════════════════
// 4. Replace TODAY ai-feed-strip HTML with redesigned version
// ════════════════════════════════════════════════════════════════════════
const oldTodayStrip=
  '<!-- AI FEED STRIP -->\n\n    <div id="ai-feed-strip" style="padding:8px 16px;display:flex;align-items:center;gap:10px">\n'+
  '      <div style="display:flex;flex-direction:column;align-items:center;gap:4px;flex-shrink:0">\n'+
  '        <span id="feed-date-label" style="font-size:9px;font-weight:700;color:#4a8c6a;text-transform:uppercase;letter-spacing:0.06em">Today\'s Racing</span>\n'+
  '        <div style="background:#0b1628;border:1.5px solid #c9a84c;color:#fff;font-size:10px;font-weight:700;letter-spacing:.05em;padding:3px 8px;border-radius:5px;display:flex;align-items:center;gap:4px"><div style="position:relative;width:6px;height:6px;flex-shrink:0"><div class="ai-feed-ripple"></div><div class="ai-feed-dot" style="position:relative;z-index:1;width:6px;height:6px;border-radius:50%;background:#1e9e6b"></div></div>AI EDGE</div>\n'+
  '        <span id="feed-live-badge" style="font-size:9px;font-weight:800;color:#e03131">● LIVE</span>\n'+
  '      </div>\n'+
  '      <div style="padding:8px 12px;flex:1;min-width:0">\n'+
  '        <div id="ai-feed-msg" style="font-size:13px;color:#1a5c3a;font-weight:500;line-height:1.4;position:relative"></div>\n'+
  '      </div>\n\n'+
  '    </div>';

const newTodayStrip=
  '<!-- AI FEED STRIP -->\n'+
  '    <div id="ai-feed-strip" style="margin:0 12px 6px;border-radius:10px;overflow:hidden;position:relative;background:#f4fbf7;border:1px solid #d4edd9">\n'+
  '      <div style="display:flex;align-items:center;gap:10px;padding:10px 12px 14px">\n'+
  '        <div style="flex-shrink:0;display:flex;flex-direction:column;align-items:center;gap:4px">\n'+
  '          <div style="background:#0b1628;border:1.5px solid #c9a84c;color:#fff;font-size:9px;font-weight:700;letter-spacing:.07em;padding:3px 7px;border-radius:5px;display:flex;align-items:center;gap:4px"><div style="position:relative;width:6px;height:6px;flex-shrink:0"><div class="ai-feed-ripple"></div><div class="ai-feed-dot" style="position:relative;z-index:1;width:6px;height:6px;border-radius:50%;background:#1e9e6b"></div></div>AI EDGE</div>\n'+
  '          <span style="font-size:8px;font-weight:800;color:#e03131;letter-spacing:.04em">● LIVE</span>\n'+
  '        </div>\n'+
  '        <div style="flex:1;min-width:0">\n'+
  '          <div id="ai-feed-msg" style="font-size:12.5px;color:#0b2a18;font-weight:500;line-height:1.45;overflow:hidden"></div>\n'+
  '        </div>\n'+
  '        <div id="ai-feed-counter" style="flex-shrink:0;font-size:10px;font-weight:600;color:#9aa3b5;min-width:24px;text-align:right"></div>\n'+
  '      </div>\n'+
  '      <div style="position:absolute;bottom:0;left:0;right:0;height:2px;background:#ddeee4">\n'+
  '        <div id="ai-feed-progress" style="height:100%;background:linear-gradient(90deg,#1e9e6b,#c9a84c);width:0"></div>\n'+
  '      </div>\n'+
  '    </div>';

if(!html.includes(oldTodayStrip)){console.error('FAIL: Today ai-feed-strip not found');process.exit(1);}
html=html.replace(oldTodayStrip,newTodayStrip);
console.log('4. Today AI strip redesigned');

// ════════════════════════════════════════════════════════════════════════
// 5. Replace TOMORROW ai-feed-strip-tomorrow HTML
// ════════════════════════════════════════════════════════════════════════
// Use position-based replacement for tomorrow strip
const tmStripStart=html.indexOf('<!-- AI FEED STRIP TOMORROW -->');
const tmStripEnd=html.indexOf('\n\n    <div id="tomorrow-meetings-list"',tmStripStart);
if(tmStripStart<0||tmStripEnd<0){console.error('FAIL: Tomorrow AI strip boundaries not found',tmStripStart,tmStripEnd);process.exit(1);}
const newTmrwStrip=
  '<!-- AI FEED STRIP TOMORROW -->\n'+
  '  <div id="ai-feed-strip-tomorrow" style="margin:0 12px 6px;border-radius:10px;overflow:hidden;position:relative;background:#f4fbf7;border:1px solid #d4edd9">\n'+
  '    <div style="display:flex;align-items:center;gap:10px;padding:10px 12px 14px">\n'+
  '      <div style="flex-shrink:0;display:flex;flex-direction:column;align-items:center;gap:4px">\n'+
  '        <div style="background:#0b1628;border:1.5px solid #c9a84c;color:#fff;font-size:9px;font-weight:700;letter-spacing:.07em;padding:3px 7px;border-radius:5px;display:flex;align-items:center;gap:4px"><div style="position:relative;width:6px;height:6px;flex-shrink:0"><div class="ai-feed-ripple"></div><div style="position:relative;z-index:1;width:6px;height:6px;border-radius:50%;background:#1e9e6b"></div></div>AI EDGE</div>\n'+
  '        <span style="font-size:8px;font-weight:800;color:#e03131;letter-spacing:.04em">● LIVE</span>\n'+
  '      </div>\n'+
  '      <div style="flex:1;min-width:0">\n'+
  '        <div id="ai-feed-msg-tomorrow" style="font-size:12.5px;color:#0b2a18;font-weight:500;line-height:1.45;overflow:hidden"></div>\n'+
  '      </div>\n'+
  '      <div id="ai-feed-counter-tomorrow" style="flex-shrink:0;font-size:10px;font-weight:600;color:#9aa3b5;min-width:24px;text-align:right"></div>\n'+
  '    </div>\n'+
  '    <div style="position:absolute;bottom:0;left:0;right:0;height:2px;background:#ddeee4">\n'+
  '      <div id="ai-feed-progress-tomorrow" style="height:100%;background:linear-gradient(90deg,#1e9e6b,#c9a84c);width:0"></div>\n'+
  '    </div>\n'+
  '  </div>';

html=html.slice(0,tmStripStart)+newTmrwStrip+html.slice(tmStripEnd);
console.log('5. Tomorrow AI strip redesigned');

// ════════════════════════════════════════════════════════════════════════
// 6. Update aiFeedInit JS — add counter + progress bar start
// ════════════════════════════════════════════════════════════════════════
const oldInit=
  'function aiFeedInit(){\n'+
  '  var msg=document.getElementById("ai-feed-msg");\n'+
  '  if(!msg) return;\n'+
  '  aiFeedIdx=0;\n'+
  '  msg.textContent=AI_FEED_MESSAGES[0];\n'+
  '  msg.style.animation="";\n'+
  '  if(!window._aiFeedTimer) window._aiFeedTimer=setInterval(aiFeedTick,8000);\n'+
  '}';
const newInit=
  'function aiFeedInit(){\n'+
  '  var msg=document.getElementById("ai-feed-msg");\n'+
  '  if(!msg) return;\n'+
  '  aiFeedIdx=0;\n'+
  '  msg.textContent=AI_FEED_MESSAGES[0];\n'+
  '  msg.style.animation="";\n'+
  '  var ctr=document.getElementById("ai-feed-counter");\n'+
  '  if(ctr) ctr.textContent="1\u2009/\u2009"+AI_FEED_MESSAGES.length;\n'+
  '  aiFeedResetProgress("ai-feed-progress");\n'+
  '  if(!window._aiFeedTimer) window._aiFeedTimer=setInterval(aiFeedTick,8000);\n'+
  '}';
if(!html.includes(oldInit)){console.error('FAIL: aiFeedInit not found');process.exit(1);}
html=html.replace(oldInit,newInit);
console.log('6. aiFeedInit updated');

// ════════════════════════════════════════════════════════════════════════
// 7. Update aiFeedTick JS — fade-up animation + counter + progress reset
// ════════════════════════════════════════════════════════════════════════
const oldTick=
  'function aiFeedTick(){\n'+
  '  var msg=document.getElementById("ai-feed-msg");\n'+
  '  if(!msg) return;\n'+
  '  msg.style.animation="aiFeedSlideOut 0.4s ease forwards";\n'+
  '  setTimeout(function(){\n'+
  '    aiFeedIdx=(aiFeedIdx+1)%AI_FEED_MESSAGES.length;\n'+
  '    msg.textContent=AI_FEED_MESSAGES[aiFeedIdx];\n'+
  '    msg.style.animation="aiFeedSlideIn 0.4s ease forwards";\n'+
  '  },400);\n'+
  '}';
const newTick=
  'function aiFeedResetProgress(id){\n'+
  '  var pb=document.getElementById(id);\n'+
  '  if(!pb) return;\n'+
  '  pb.style.animation="none";\n'+
  '  pb.style.width="0";\n'+
  '  void pb.offsetWidth;\n'+
  '  pb.style.animation="aiFeedProgressFill 8s linear forwards";\n'+
  '}\n'+
  'function aiFeedTick(){\n'+
  '  var msg=document.getElementById("ai-feed-msg");\n'+
  '  if(!msg) return;\n'+
  '  msg.style.animation="aiFeedFadeDown 0.3s ease forwards";\n'+
  '  setTimeout(function(){\n'+
  '    aiFeedIdx=(aiFeedIdx+1)%AI_FEED_MESSAGES.length;\n'+
  '    msg.textContent=AI_FEED_MESSAGES[aiFeedIdx];\n'+
  '    msg.style.animation="aiFeedFadeUp 0.35s ease forwards";\n'+
  '    var ctr=document.getElementById("ai-feed-counter");\n'+
  '    if(ctr) ctr.textContent=(aiFeedIdx+1)+"\u2009/\u2009"+AI_FEED_MESSAGES.length;\n'+
  '    aiFeedResetProgress("ai-feed-progress");\n'+
  '  },300);\n'+
  '}';
if(!html.includes(oldTick)){console.error('FAIL: aiFeedTick not found');process.exit(1);}
html=html.replace(oldTick,newTick);
console.log('7. aiFeedTick updated with fade-up + counter + progress');

// ════════════════════════════════════════════════════════════════════════
// 8. Update aiFeedInitTomorrow similarly
// ════════════════════════════════════════════════════════════════════════
const tmInitStart=html.indexOf('function aiFeedInitTomorrow(){');
const tmInitEnd=html.indexOf('\n}',tmInitStart)+2;
const oldTmInitStr=html.slice(tmInitStart,tmInitEnd);
console.log('aiFeedInitTomorrow found:',oldTmInitStr.slice(0,80));

const newTmInitStr=oldTmInitStr
  .replace(
    'var msg=document.getElementById("ai-feed-msg-tomorrow");\n  if(!msg) return;',
    'var msg=document.getElementById("ai-feed-msg-tomorrow");\n  if(!msg) return;\n  var ctr=document.getElementById("ai-feed-counter-tomorrow");\n  if(ctr) ctr.textContent="1\u2009/\u2009"+(AI_FEED_TOMORROW_MESSAGES||AI_FEED_MESSAGES).length;\n  aiFeedResetProgress("ai-feed-progress-tomorrow");'
  );
html=html.slice(0,tmInitStart)+newTmInitStr+html.slice(tmInitEnd);
console.log('8. aiFeedInitTomorrow updated');

// ── Syntax check ─────────────────────────────────────────────────────────────
const ss=html.lastIndexOf('<script>'),se=html.lastIndexOf('</script>');
try{new Function(html.slice(ss+8,se));console.log('Syntax: OK');}
catch(e){console.error('SYNTAX:',e.message);process.exit(1);}

fs.writeFileSync('C:/Users/Gary Coyne/acca-research/index.html',html,'utf8');
console.log('Saved');
