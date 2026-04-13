const fs=require('fs');
let html=fs.readFileSync('C:/Users/Gary Coyne/acca-research/index.html','utf8');

// ── Replace rcRaceDetailHtml outer wrapper + dark header ─────────────────────
// Old: boxed card with margin, dark navy header bar
const oldHeader=
  "  var out='<div id=\"rc-detail-'+m.id+'\" style=\"margin:0 14px;background:#f5f7fb;border-radius:8px;border:1px solid #e4e8f0;overflow:hidden\">'\r\n\r\n"+
  "    +'<div style=\"background:#0b1628;border-radius:8px 8px 0 0;padding:10px 12px;display:flex;align-items:center;justify-content:space-between\">'\r\n\r\n"+
  "      +'<span style=\"font-size:13px;font-weight:600;color:#fff\">'+escHtml(race.t)+' '+escHtml(m.name)+' &middot; '+escHtml(race.dist)+'</span>'\r\n\r\n"+
  "      +'<span style=\"background:#1e9e6b;border-radius:99px;padding:3px 10px;font-size:11px;font-weight:600;color:#fff\">'+race.r+' rnrs</span>'\r\n\r\n"+
  "    +'</div>';";

// New: full-width white card matching Next Race style
const newHeader=
  "  var out='<div id=\"rc-detail-'+m.id+'\" style=\"background:#fff;border-top:1px solid #e4e8f0;border-bottom:1px solid #e4e8f0\">'\r\n\r\n"+
  "    +'<div style=\"padding:14px 16px 12px;display:flex;align-items:flex-start;justify-content:space-between\">'\r\n\r\n"+
  "      +'<div>'\r\n\r\n"+
  "        +'<div style=\"font-size:16px;font-weight:700;color:#0b1628\">'+escHtml(race.t)+' &middot; '+escHtml(m.name)+'</div>'\r\n\r\n"+
  "        +'<div style=\"font-size:11px;color:#9aa3b5;margin-top:3px\">'+escHtml(race.dist)+' &middot; '+race.r+' runners</div>'\r\n\r\n"+
  "      +'</div>'\r\n\r\n"+
  "    +'</div>';";

if(!html.includes(oldHeader)){console.error('FAIL: rcRaceDetailHtml header not found');process.exit(1);}
html=html.replace(oldHeader,newHeader);
console.log('1. Header updated to full-width white style');

// ── Replace closing div + analyse button ─────────────────────────────────────
// Old: closing </div> then button with left/right margin
const oldFooter=
  "  out+='</div>';\r\n\r\n"+
  "  out+='<button class=\"fx-cta\" style=\"margin:10px 14px 14px;width:calc(100% - 28px)\">'\r\n\r\n"+
  "    +'<span style=\"color:var(--gold)\">&#x2756;</span> Analyse '+escHtml(race.t)+' '+escHtml(m.name)+' with AI &rarr;</button>';\r\n\r\n"+
  "  return out;\r\n\r\n}";

// New: button inside a padded wrapper, no margin hacks, closes outer div cleanly
const newFooter=
  "  out+='<div style=\"padding:12px 16px\">'\r\n\r\n"+
  "    +'<button class=\"fx-cta\" style=\"width:100%\">'\r\n\r\n"+
  "      +'<span style=\"color:var(--gold)\">&#x2756;</span> Analyse '+escHtml(race.t)+' '+escHtml(m.name)+' with AI &rarr;'\r\n\r\n"+
  "    +'</button>'\r\n\r\n"+
  "  +'</div>'\r\n\r\n"+
  "  +'</div>';\r\n\r\n"+
  "  return out;\r\n\r\n}";

if(!html.includes(oldFooter)){console.error('FAIL: rcRaceDetailHtml footer not found');process.exit(1);}
html=html.replace(oldFooter,newFooter);
console.log('2. Footer / analyse button updated');

// ── Syntax check ─────────────────────────────────────────────────────────────
const ss=html.lastIndexOf('<script>'),se=html.lastIndexOf('</script>');
try{new Function(html.slice(ss+8,se));console.log('Syntax: OK');}
catch(e){console.error('SYNTAX:',e.message);process.exit(1);}

fs.writeFileSync('C:/Users/Gary Coyne/acca-research/index.html',html,'utf8');
console.log('Saved');
