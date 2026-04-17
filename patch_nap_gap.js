const fs=require('fs');
let html=fs.readFileSync('C:/Users/Gary Coyne/acca-research/index.html','utf8');

// ════════════════════════════════════════════════════════════════════════
// 1. Container — add gap + tinted background so the break shows clearly
// ════════════════════════════════════════════════════════════════════════
html=html.replace(
  '<div id="racing-picks-container" style="display:flex;flex-direction:column;gap:0">',
  '<div id="racing-picks-container" style="display:flex;flex-direction:column;gap:10px;background:#edf0f5">'
);
console.log('1. Container gap + tinted background added');

// ════════════════════════════════════════════════════════════════════════
// 2. Cards — remove bottom divider (gap replaces it), add subtle top
//    coloured accent stripe per card so each feels self-contained
// ════════════════════════════════════════════════════════════════════════
html=html.replace(
  '\'<div style="background:#fff;border:none;border-left:4px solid \'+p.border+\';border-bottom:1px solid #edf0f5;overflow:hidden;">\'',
  '\'<div style="background:#fff;border:none;border-left:4px solid \'+p.border+\';overflow:hidden;">\''
);
console.log('2. Card bottom divider removed (gap handles separation)');

// ── Syntax check ────────────────────────────────────────────────────────
const ss=html.lastIndexOf('<script>'),se=html.lastIndexOf('</script>');
try{new Function(html.slice(ss+8,se));console.log('Syntax: OK');}
catch(e){console.error('SYNTAX:',e.message);process.exit(1);}

fs.writeFileSync('C:/Users/Gary Coyne/acca-research/index.html',html,'utf8');
console.log('Saved');
