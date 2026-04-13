const fs=require('fs');
let html=fs.readFileSync('C:/Users/Gary Coyne/acca-research/index.html','utf8');

// ════════════════════════════════════════════════════════════════════════
// 1. Add Kempton image (SVG racecourse) to hidden img div
// ════════════════════════════════════════════════════════════════════════
const kemptonSvg="data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg' width='600' height='300' viewBox='0 0 600 300'><rect width='600' height='300' fill='%230b2a18'/><ellipse cx='300' cy='220' rx='260' ry='110' fill='none' stroke='%231e9e6b' stroke-width='18' opacity='0.35'/><rect x='0' y='155' width='600' height='55' fill='%23124a28' opacity='0.7'/><text x='300' y='125' font-family='Arial' font-size='26' font-weight='bold' fill='%23c9a84c' text-anchor='middle'>KEMPTON</text><text x='300' y='155' font-family='Arial' font-size='14' fill='%23ffffff' text-anchor='middle' opacity='0.6'>All Weather</text></svg>";

const imgAnchor='      <img id="img-aintree"';
const imgAnchorPos=html.indexOf(imgAnchor);
if(imgAnchorPos<0){console.error('FAIL: img-aintree not found');process.exit(1);}
const lineEnd=html.indexOf('\r\n',imgAnchorPos)+2;
html=html.slice(0,lineEnd)+'      <img id="img-kempton" src="'+kemptonSvg+'">\r\n'+html.slice(lineEnd);
console.log('1. Kempton image added');

// ════════════════════════════════════════════════════════════════════════
// 2. Reduce card height 72px → 72px (already done, skip if needed)
// ════════════════════════════════════════════════════════════════════════
// already 72px from previous patch — no change needed

// ════════════════════════════════════════════════════════════════════════
// 3. Remove time range from card meta line
// ════════════════════════════════════════════════════════════════════════
const oldMeta="weight:600;color:rgba(255,255,255,0.82)\">'+m.races.length+' races &middot; '+firstT+'&ndash;'+lastT+'</span>';";
const newMeta="weight:600;color:rgba(255,255,255,0.82)\">'+m.races.length+' races</span>';";
if(!html.includes(oldMeta)){console.error('FAIL: meta line not found\nSearching for:',oldMeta);process.exit(1);}
html=html.replace(oldMeta,newMeta);
console.log('3. Time range removed from card');

// ── Syntax check ─────────────────────────────────────────────────────────────
const ss=html.lastIndexOf('<script>'),se=html.lastIndexOf('</script>');
try{new Function(html.slice(ss+8,se));console.log('Syntax: OK');}
catch(e){console.error('SYNTAX:',e.message);process.exit(1);}

fs.writeFileSync('C:/Users/Gary Coyne/acca-research/index.html',html,'utf8');
console.log('Saved');
