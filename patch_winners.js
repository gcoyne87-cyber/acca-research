const fs=require('fs');
let html=fs.readFileSync('C:/Users/Gary Coyne/acca-research/index.html','utf8');

// ════════════════════════════════════════════════════════════════════════
// 1. Subtitle: "Predicted by AI" → "Predicted by AccuEdge" (both sections)
// ════════════════════════════════════════════════════════════════════════
const count=(html.match(/Predicted by AI · How they ran/g)||[]).length;
if(count!==2){console.error('FAIL: expected 2 subtitle occurrences, found '+count);process.exit(1);}
html=html.split('Predicted by AI · How they ran').join('Predicted by AccuEdge · How they ran');
console.log('1. Subtitle updated ('+count+' occurrences)');

// ════════════════════════════════════════════════════════════════════════
// 2. Remove aiTag variable definition from renderRacingWinners JS
// ════════════════════════════════════════════════════════════════════════
const oldAiTagDef=
  'var aiTag=\'<div style=\"display:inline-flex;align-items:center;gap:4px;background:#0b1628;border-radius:4px;padding:2px 7px\">\'\r\n'
  +'      +\'<div style=\"width:4px;height:4px;border-radius:50%;background:#1e9e6b;flex-shrink:0\"></div>\'\r\n'
  +'      +\'<span style=\"font-size:8px;font-weight:700;color:#ffffff;letter-spacing:0.1em\">AI EDGE</span>\'\r\n'
  +'    +\'</div>\';\r\n\r\n    ';
if(!html.includes(oldAiTagDef)){console.error('FAIL: aiTag definition not found');process.exit(1);}
html=html.replace(oldAiTagDef,'');
console.log('2. aiTag variable definition removed');

// ════════════════════════════════════════════════════════════════════════
// 3. Remove +aiTag usage inside winner card template
// ════════════════════════════════════════════════════════════════════════
const oldAiTagUse='        +aiTag\r\n        +\'<div style=\"font-size:11px;font-weight:700;color:\'';
const newAiTagUse='        +\'<div style=\"font-size:11px;font-weight:700;color:\'';
if(!html.includes(oldAiTagUse)){console.error('FAIL: aiTag usage not found');process.exit(1);}
html=html.replace(oldAiTagUse,newAiTagUse);
console.log('3. aiTag usage removed from card template');

// ════════════════════════════════════════════════════════════════════════
// 4. Remove AI EDGE badge from static tomorrow winner cards
//    Badge uses 4px dot (distinct from venue cards which use 6px)
// ════════════════════════════════════════════════════════════════════════
const badgeHtml='<div style="display:inline-flex;align-items:center;gap:4px;background:#0b1628;border-radius:4px;padding:2px 7px"><div style="width:4px;height:4px;border-radius:50%;background:#1e9e6b;flex-shrink:0"></div><span style="font-size:8px;font-weight:700;color:#ffffff;letter-spacing:0.1em">AI EDGE</span></div>';
const badgeCount=(html.match(/<div style="display:inline-flex;align-items:center;gap:4px;background:#0b1628;border-radius:4px;padding:2px 7px"><div style="width:4px/g)||[]).length;
console.log('  static badge occurrences:',badgeCount);
if(badgeCount===0){console.error('FAIL: static badge not found');process.exit(1);}
html=html.split(badgeHtml).join('');
console.log('4. Static winner card badges removed ('+badgeCount+' occurrences)');

// ── Syntax check ──────────────────────────────────────────────────────────────
const ss=html.lastIndexOf('<script>'),se=html.lastIndexOf('</script>');
try{new Function(html.slice(ss+8,se));console.log('Syntax: OK');}
catch(e){console.error('SYNTAX:',e.message);process.exit(1);}

fs.writeFileSync('C:/Users/Gary Coyne/acca-research/index.html',html,'utf8');
console.log('Saved');
