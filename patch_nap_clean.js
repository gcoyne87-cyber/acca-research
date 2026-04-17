const fs=require('fs');
let html=fs.readFileSync('C:/Users/Gary Coyne/acca-research/index.html','utf8');

// ════════════════════════════════════════════════════════════════════════
// 1. Update renderRacingPicks() — today's cards
// ════════════════════════════════════════════════════════════════════════
const fnStart=html.indexOf('\nfunction renderRacingPicks(){');
const fnEnd=html.indexOf('\nfunction renderRacingWinners(){');
if(fnStart<0||fnEnd<0){console.error('FAIL: renderRacingPicks bounds');process.exit(1);}

const newFn=[
'\nfunction renderRacingPicks(){\n\n',
'  var el=document.getElementById(\'racing-picks-container\');\n\n',
'  if(!el) return;\n\n',
'  el.innerHTML=RACING_PICKS.map(function(p,i){\n\n',

'    var researchText=p.signals.map(function(s){return s.text;}).join(\' \xb7 \');\n\n',

'    return \'<div style="background:#fff;border:none;border-left:4px solid \'+p.border+\';overflow:hidden;">\'\n\n',

// Header
'      +\'<div style="padding:14px 16px;display:flex;align-items:flex-start;justify-content:space-between;border-bottom:1px solid #f0f0f0">\'\n\n',
'        +\'<div>\'\n\n',
'          +\'<div style="display:inline-flex;align-items:center;gap:6px;border:1px solid #e8eaed;border-radius:99px;padding:3px 10px;margin-bottom:8px"><span style="font-size:12px">\'+p.icon+\'</span><span style="font-size:11px;font-weight:600;color:#0b1628">\'+escHtml(p.type)+\'</span></div>\'\n\n',
'          +\'<div style="font-size:19px;font-weight:700;color:#0b1628;line-height:1.1;margin-bottom:3px">\'+escHtml(p.horse)+\'</div>\'\n\n',
'          +\'<div style="font-size:11px;color:#aaa">\'+escHtml(p.detail)+\'</div>\'\n\n',
'        +\'</div>\'\n\n',
'        +\'<div style="text-align:right;flex-shrink:0;padding-left:12px">\'\n\n',
'          +\'<div style="font-size:10px;color:#aaa;margin-bottom:2px;letter-spacing:.04em">PRICE</div>\'\n\n',
'          +\'<div style="font-size:24px;font-weight:700;color:#1e9e6b;line-height:1">\'+escHtml(p.odds)+\'</div>\'\n\n',
'        +\'</div>\'\n\n',
'      +\'</div>\'\n\n',

// AI EDGE badge + green research text
'      +\'<div style="padding:12px 16px 14px">\'\n',
'        +\'<div style="display:inline-flex;align-items:center;gap:4px;margin-bottom:8px;background:#0b1628;border:1.5px solid #c9a84c;border-radius:5px;padding:3px 8px">\'\n',
'          +\'<div style="width:5px;height:5px;border-radius:50%;background:#1e9e6b;flex-shrink:0"></div>\'\n',
'          +\'<span style="font-size:9px;font-weight:700;letter-spacing:0.1em;color:#fff">AI EDGE</span>\'\n',
'        +\'</div>\'\n',
'        +\'<div style="font-size:12px;color:#1e7a54;line-height:1.55">\'+escHtml(researchText)+\'</div>\'\n',
'      +\'</div>\'\n\n',

// CTA
'      +\'<div style="padding:0 16px 14px">\'\n\n',
'        +\'<button onclick="nrAddToSlip(\\\'\'+escHtml(p.horse)+\'\\\',\\\'\'+escHtml(p.odds)+\'\\\')" style="width:100%;background:#0b1628;color:#fff;border:none;border-radius:99px;padding:12px;font-size:13px;font-weight:600;cursor:pointer;font-family:inherit">+ Add to My Slip</button>\'\n\n',
'      +\'</div>\'\n\n',

'    +\'</div>\';\n\n',
'  }).join(\'\');\n\n',
'}\n'
].join('');

try{new Function(newFn);}catch(e){console.error('FN ERR:',e.message);process.exit(1);}
html=html.slice(0,fnStart)+newFn+html.slice(fnEnd);
console.log('1. renderRacingPicks updated');

// ════════════════════════════════════════════════════════════════════════
// 2. Replace tomorrow's static card HTML with same layout
// ════════════════════════════════════════════════════════════════════════
const AI_EDGE_HTML=
  '<div style="display:inline-flex;align-items:center;gap:4px;margin-bottom:8px;background:#0b1628;border:1.5px solid #c9a84c;border-radius:5px;padding:3px 8px">'
  +'<div style="width:5px;height:5px;border-radius:50%;background:#1e9e6b;flex-shrink:0"></div>'
  +'<span style="font-size:9px;font-weight:700;letter-spacing:0.1em;color:#fff">AI EDGE</span>'
  +'</div>';

function card(opts){
  var research=opts.signals.join(' \xb7 ');
  return '<div style="background:#fff;border:none;border-left:4px solid '+opts.border+';overflow:hidden;">'
    +'<div style="padding:14px 16px;display:flex;align-items:flex-start;justify-content:space-between;border-bottom:1px solid #f0f0f0">'
      +'<div>'
        +'<div style="display:inline-flex;align-items:center;gap:6px;border:1px solid #e8eaed;border-radius:99px;padding:3px 10px;margin-bottom:8px">'
          +'<span style="font-size:12px">'+opts.icon+'</span>'
          +'<span style="font-size:11px;font-weight:600;color:#0b1628">'+opts.type+'</span>'
        +'</div>'
        +'<div style="font-size:19px;font-weight:700;color:#0b1628;line-height:1.1;margin-bottom:3px">'+opts.horse+'</div>'
        +'<div style="font-size:11px;color:#aaa">'+opts.detail+'</div>'
      +'</div>'
      +'<div style="text-align:right;flex-shrink:0;padding-left:12px">'
        +'<div style="font-size:10px;color:#aaa;margin-bottom:2px;letter-spacing:.04em">PRICE</div>'
        +'<div style="font-size:24px;font-weight:700;color:#1e9e6b;line-height:1">'+opts.odds+'</div>'
      +'</div>'
    +'</div>'
    +'<div style="padding:12px 16px 14px">'
      +AI_EDGE_HTML
      +'<div style="font-size:12px;color:#1e7a54;line-height:1.55">'+research+'</div>'
    +'</div>'
    +'<div style="padding:0 16px 14px">'
      +'<button style="width:100%;background:#0b1628;color:#fff;border:none;border-radius:99px;padding:12px;font-size:13px;font-weight:600;cursor:pointer;font-family:inherit">+ Add to My Slip</button>'
    +'</div>'
  +'</div>';
}

const napCard=card({
  icon:'\u26a1', type:'NAP \xb7 Pick of the Day',
  horse:'Galopin Des Champs', detail:'14:00 Cheltenham \xb7 3m Gold Cup Chase',
  odds:'6/4', border:'#1e9e6b',
  signals:[
    'AI top-rated across form, going and trainer stats \u2014 highest score on tomorrow\u2019s card',
    'Won the Gold Cup last season \u2014 conditions suit again on forecast Good to Soft',
    'De Bromhead yard in top form with 6 winners this week \u2014 52% strike rate',
    'Settles beautifully from the front \u2014 favourite profile strongly confirmed',
    'Market has held firm all week \u2014 weight ideal for this trip'
  ]
});

const nbCard=card({
  icon:'\u2605', type:'NB \xb7 Next Best',
  horse:'Jonbon', detail:'13:30 Cheltenham \xb7 2m Champion Chase',
  odds:'5/2', border:'#0b1628',
  signals:[
    'Second highest AI rating on tomorrow\u2019s card \u2014 strong profile across key metrics',
    'Course and distance winner \u2014 two from two here, track suits his jumping style',
    'Nicky Henderson booking top jockey \u2014 strong stable signal, retained rider up',
    'Steps up after impressive Sandown win last month \u2014 on a career-best trajectory',
    'Handles soft ground well \u2014 conditions ideal for his ground-covering stride'
  ]
});

const OPEN_TAG='id="racing-tomorrow-nap"';
const napPos=html.indexOf(OPEN_TAG);
if(napPos<0){console.error('FAIL: racing-tomorrow-nap not found');process.exit(1);}
const openTagEnd=html.indexOf('>',napPos)+1;

const AFTER_MARKER='<div id="racing-winners-content"';
const afterPos=html.indexOf(AFTER_MARKER,napPos);
if(afterPos<0){console.error('FAIL: racing-winners-content not found');process.exit(1);}

const closingSeq='\n\n  </div>\n\n  </div>';
const closingPos=html.lastIndexOf(closingSeq,afterPos);
if(closingPos<0){console.error('FAIL: closing sequence not found');process.exit(1);}

html=html.slice(0,openTagEnd)+napCard+nbCard+html.slice(closingPos);
console.log('2. Tomorrow cards updated');

// ── Syntax check ────────────────────────────────────────────────────────
const ss=html.lastIndexOf('<script>'),se=html.lastIndexOf('</script>');
try{new Function(html.slice(ss+8,se));console.log('Syntax: OK');}
catch(e){console.error('SYNTAX:',e.message);process.exit(1);}

fs.writeFileSync('C:/Users/Gary Coyne/acca-research/index.html',html,'utf8');
console.log('Saved');
