const fs=require('fs');
let html=fs.readFileSync('C:/Users/Gary Coyne/acca-research/index.html','utf8');

// ── 1. Remove padding wrapper around inline-meetings-list ────────────────────
// The padding:0 12px 16px wrapper is what creates the side inset on the race card
const oldWrapper='<div style="padding:0 12px 16px"><div id="inline-meetings-list"></div></div>';
const newWrapper='<div id="inline-meetings-list"></div>';
if(!html.includes(oldWrapper)){console.error('FAIL: meetings-list wrapper not found');process.exit(1);}
html=html.replace(oldWrapper,newWrapper);
console.log('1. Padding wrapper removed from inline-meetings-list');

// ── 2. In renderInlineMeeting fHtml:
//    a) Add margin to the venue card so it still has breathing room
//    b) Move rcRaceDetailHtml OUTSIDE the bordered card div so it goes full-width
const oldFhtml=
  "  var fHtml='<div style=\"background:#fff;border-radius:12px;border:1px solid #e4e8f0;overflow:hidden;margin-bottom:4px\">'\r\n"+
  "    +'<div style=\"padding:12px 14px 10px;display:flex;align-items:baseline;gap:10px;border-bottom:1px solid #f0f2f7\">'\r\n"+
  "      +'<span style=\"font-size:11px;font-weight:700;color:#9aa3b5;flex-shrink:0;width:24px\">'+escHtml(featured.flag)+'</span>'\r\n"+
  "      +'<span style=\"font-size:18px;font-weight:700;color:#0b1628\">'+escHtml(featured.name)+'</span>'\r\n"+
  "      +'<span style=\"font-size:12px;color:#9aa3b5;margin-left:2px\">'+featured.races.length+' races &middot; Next <span style=\"color:#1e9e6b;font-weight:600\">'+escHtml(featured.races[0].t)+'</span></span>'\r\n"+
  "    +'</div>'\r\n"+
  "    +rcPillsHtml(featured)\r\n"+
  "    +'<div style=\"padding:12px 14px 0\">'+rcInsightsHtml(featured,false)+'</div>'\r\n"+
  "    +'<button class=\"fx-cta\" style=\"margin:12px 14px 0;width:calc(100% - 28px)\"><span style=\"color:var(--gold)\">&#x2756;</span> Analyse Full '+escHtml(featured.name)+' Card with AI &rarr;</button>'\r\n"+
  "    +rcTimesHtml(featured,true)\r\n"+
  "    +rcRaceDetailHtml(featured)\r\n"+
  "  +'</div>';";

// New: venue card has margin:0 12px, rcRaceDetailHtml is outside the bordered card
const newFhtml=
  "  var fHtml='<div style=\"background:#fff;border-radius:12px;border:1px solid #e4e8f0;overflow:hidden;margin:0 12px 4px\">'\r\n"+
  "    +'<div style=\"padding:12px 14px 10px;display:flex;align-items:baseline;gap:10px;border-bottom:1px solid #f0f2f7\">'\r\n"+
  "      +'<span style=\"font-size:11px;font-weight:700;color:#9aa3b5;flex-shrink:0;width:24px\">'+escHtml(featured.flag)+'</span>'\r\n"+
  "      +'<span style=\"font-size:18px;font-weight:700;color:#0b1628\">'+escHtml(featured.name)+'</span>'\r\n"+
  "      +'<span style=\"font-size:12px;color:#9aa3b5;margin-left:2px\">'+featured.races.length+' races &middot; Next <span style=\"color:#1e9e6b;font-weight:600\">'+escHtml(featured.races[0].t)+'</span></span>'\r\n"+
  "    +'</div>'\r\n"+
  "    +rcPillsHtml(featured)\r\n"+
  "    +'<div style=\"padding:12px 14px 0\">'+rcInsightsHtml(featured,false)+'</div>'\r\n"+
  "    +'<button class=\"fx-cta\" style=\"margin:12px 14px 0;width:calc(100% - 28px)\"><span style=\"color:var(--gold)\">&#x2756;</span> Analyse Full '+escHtml(featured.name)+' Card with AI &rarr;</button>'\r\n"+
  "    +rcTimesHtml(featured,true)\r\n"+
  "  +'</div>'\r\n"+
  "  +rcRaceDetailHtml(featured);";

if(!html.includes(oldFhtml)){console.error('FAIL: fHtml block not found');process.exit(1);}
html=html.replace(oldFhtml,newFhtml);
console.log('2. rcRaceDetailHtml moved outside bordered card — now full-width');

// ── Syntax check ─────────────────────────────────────────────────────────────
const ss=html.lastIndexOf('<script>'),se=html.lastIndexOf('</script>');
try{new Function(html.slice(ss+8,se));console.log('Syntax: OK');}
catch(e){console.error('SYNTAX:',e.message);process.exit(1);}

fs.writeFileSync('C:/Users/Gary Coyne/acca-research/index.html',html,'utf8');
console.log('Saved');
