const fs=require('fs');
let html=fs.readFileSync('C:/Users/Gary Coyne/acca-research/index.html','utf8');

// ════════════════════════════════════════════════════════════════════════
// 1. Add going + nextMins as second line inside image header, below race count
// ════════════════════════════════════════════════════════════════════════
const OLD_RACEMETA=
'    out+=\'<span style="font-size:10px;font-weight:500;color:rgba(255,255,255,0.75)">\'+m.races.length+\' races</span>\';\n'
+'    out+=\'</div></div>\';\n'
+'    out+=\'</div>\';';

const NEW_RACEMETA=
'    out+=\'<span style="font-size:10px;font-weight:500;color:rgba(255,255,255,0.75)">\'+m.races.length+\' races</span>\';\n'
+'    out+=\'</div>\';\n'
+'    out+=\'<div style="font-size:10px;color:rgba(255,255,255,0.6);margin-top:2px">\'+escHtml(m.going)+\' &middot; Next in \'+m.nextMins+\' mins</div>\';\n'
+'    out+=\'</div>\';\n'
+'    out+=\'</div>\';';

if(html.indexOf(OLD_RACEMETA)<0){console.error('FAIL: race meta block not found');process.exit(1);}
html=html.replace(OLD_RACEMETA,NEW_RACEMETA);
console.log('1. going + nextMins added to image header');

// ════════════════════════════════════════════════════════════════════════
// 2. Remove the going/nextMins tag row from the expanded panel
// ════════════════════════════════════════════════════════════════════════
const OLD_TAGROW=
'      out+=\'<div style="display:flex;gap:6px;padding:6px 12px 8px;flex-wrap:wrap">\';\n'
+'      out+=\'<span style="font-size:11px;font-weight:600;padding:3px 9px;border-radius:20px;background:#fff8e6;color:#a07010;border:1px solid #f0d87a">\'+escHtml(m.going)+\'</span>\';\n'
+'      out+=\'<span style="font-size:11px;font-weight:600;padding:3px 9px;border-radius:20px;background:#eef4ff;color:#1a4fa0;border:1px solid #c0d4f8">Next in \'+m.nextMins+\' mins</span>\';\n'
+'      out+=\'</div>\';\n';

if(html.indexOf(OLD_TAGROW)<0){console.error('FAIL: tag row not found');process.exit(1);}
html=html.replace(OLD_TAGROW,'');
console.log('2. Going/nextMins tag row removed from expanded panel');

// ════════════════════════════════════════════════════════════════════════
// 3. Remove border-bottom from pill bar (divider between pills and AI button)
// ════════════════════════════════════════════════════════════════════════
html=html.replace(
  '"position:sticky;top:56px;z-index:20;background:#fff;border-bottom:1px solid #f0f2f7;display:flex;gap:7px;overflow-x:auto;padding:8px 12px;scrollbar-width:none;-webkit-overflow-scrolling:touch"',
  '"position:sticky;top:56px;z-index:20;background:#fff;display:flex;gap:7px;overflow-x:auto;padding:8px 12px;scrollbar-width:none;-webkit-overflow-scrolling:touch"'
);
console.log('3. border-bottom removed from pill bar');

// ── Syntax check ─────────────────────────────────────────────────────────
const ss=html.lastIndexOf('<script>'),se=html.lastIndexOf('</script>');
try{new Function(html.slice(ss+8,se));console.log('Syntax: OK');}
catch(e){console.error('GLOBAL SYNTAX:',e.message);process.exit(1);}

fs.writeFileSync('C:/Users/Gary Coyne/acca-research/index.html',html,'utf8');
console.log('Saved');
