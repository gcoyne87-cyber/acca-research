const fs=require('fs');
let html=fs.readFileSync('C:/Users/Gary Coyne/acca-research/index.html','utf8');

// ════════════════════════════════════════════════════════════════════════
// 1. Ensure aiFeedTmrwIdx is declared (idempotent)
// ════════════════════════════════════════════════════════════════════════
if(!html.includes('var aiFeedTmrwIdx')){
  html=html.replace('var aiFeedIdx=0;','var aiFeedIdx=0;\nvar aiFeedTmrwIdx=0;');
  console.log('1. aiFeedTmrwIdx declared');
} else {
  console.log('1. aiFeedTmrwIdx already present');
}

// ════════════════════════════════════════════════════════════════════════
// 2. Rewrite aiFeedInitTomorrow — position-based replacement
// ════════════════════════════════════════════════════════════════════════
const fnStart=html.indexOf('function aiFeedInitTomorrow(){');
const fnEnd=html.indexOf('\nfunction aiFeedInit(){',fnStart);
if(fnStart<0||fnEnd<0){console.error('FAIL: aiFeedInitTomorrow boundary not found',fnStart,fnEnd);process.exit(1);}

const newInit=
  'function aiFeedInitTomorrow(){\n'+
  '  var msg=document.getElementById("ai-feed-msg-tomorrow");\n'+
  '  if(!msg) return;\n'+
  '  aiFeedTmrwIdx=0;\n'+
  '  msg.textContent=AI_FEED_MESSAGES[0];\n'+
  '  msg.style.animation="";\n'+
  '  var ctr=document.getElementById("ai-feed-counter-tomorrow");\n'+
  '  if(ctr) ctr.textContent="1\u2009/\u2009"+AI_FEED_MESSAGES.length;\n'+
  '  aiFeedResetProgress("ai-feed-progress-tomorrow");\n'+
  '  if(window._aiFeedTimerTm) clearInterval(window._aiFeedTimerTm);\n'+
  '  window._aiFeedTimerTm=setInterval(function(){\n'+
  '    var m=document.getElementById("ai-feed-msg-tomorrow");\n'+
  '    if(!m) return;\n'+
  '    m.style.animation="aiFeedFadeDown 0.3s ease forwards";\n'+
  '    setTimeout(function(){\n'+
  '      aiFeedTmrwIdx=(aiFeedTmrwIdx+1)%AI_FEED_MESSAGES.length;\n'+
  '      m.textContent=AI_FEED_MESSAGES[aiFeedTmrwIdx];\n'+
  '      m.style.animation="aiFeedFadeUp 0.35s ease forwards";\n'+
  '      var c=document.getElementById("ai-feed-counter-tomorrow");\n'+
  '      if(c) c.textContent=(aiFeedTmrwIdx+1)+"\u2009/\u2009"+AI_FEED_MESSAGES.length;\n'+
  '      aiFeedResetProgress("ai-feed-progress-tomorrow");\n'+
  '    },300);\n'+
  '  },8000);\n'+
  '}';

html=html.slice(0,fnStart)+newInit+html.slice(fnEnd);
console.log('2. aiFeedInitTomorrow rewritten');

// ── Syntax check ────────────────────────────────────────────────────────
const ss=html.lastIndexOf('<script>'),se=html.lastIndexOf('</script>');
try{new Function(html.slice(ss+8,se));console.log('Syntax: OK');}
catch(e){console.error('SYNTAX:',e.message);process.exit(1);}

fs.writeFileSync('C:/Users/Gary Coyne/acca-research/index.html',html,'utf8');
console.log('Saved');
