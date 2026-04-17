const fs=require('fs');
let html=fs.readFileSync('C:/Users/Gary Coyne/acca-research/index.html','utf8');

// ════════════════════════════════════════════════════════════════════════
// 1. Container — remove left/right padding, keep top, move heading padding inline
// ════════════════════════════════════════════════════════════════════════
html=html.replace(
  '<div class="main" style="padding-top:12px;padding-bottom:0;padding-left:12px;padding-right:12px">',
  '<div class="main" style="padding-top:12px;padding-bottom:0;padding-left:0;padding-right:0">'
);
// Heading block needs its own side padding now the container has none
html=html.replace(
  '<div style="margin-bottom:12px">\n\n        <span style="font-size:24px;line-height:1;display:block;margin-bottom:6px">🎯</span>',
  '<div style="margin-bottom:12px;padding:0 16px">\n\n        <span style="font-size:24px;line-height:1;display:block;margin-bottom:6px">🎯</span>'
);
// Cards container — remove gap (divider line replaces it)
html=html.replace(
  '<div id="racing-picks-container" style="display:flex;flex-direction:column;gap:12px">',
  '<div id="racing-picks-container" style="display:flex;flex-direction:column;gap:0">'
);
console.log('1. Container made full-bleed, heading padded inline');

// ════════════════════════════════════════════════════════════════════════
// 2. Cards — remove rounded corners, shadow, outer border
//    Keep left colour border as identity strip, add bottom divider
// ════════════════════════════════════════════════════════════════════════
// Update the card wrapper in renderRacingPicks
html=html.replace(
  '\'<div style="background:#fff;border:1px solid #e4e8f0;border-radius:14px;overflow:hidden;border-left:4px solid \'+p.border+\';box-shadow:0 1px 4px rgba(0,0,0,0.05);">\'',
  '\'<div style="background:#fff;border:none;border-left:4px solid \'+p.border+\';border-bottom:1px solid #edf0f5;overflow:hidden;">\'',
);
console.log('2. Card style: full-bleed, no radius/shadow, left border + bottom divider');

// ── Syntax check ────────────────────────────────────────────────────────
const ss=html.lastIndexOf('<script>'),se=html.lastIndexOf('</script>');
try{new Function(html.slice(ss+8,se));console.log('Syntax: OK');}
catch(e){console.error('SYNTAX:',e.message);process.exit(1);}

fs.writeFileSync('C:/Users/Gary Coyne/acca-research/index.html',html,'utf8');
console.log('Saved');
