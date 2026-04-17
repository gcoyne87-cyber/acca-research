const fs=require('fs');
let html=fs.readFileSync('C:/Users/Gary Coyne/acca-research/index.html','utf8');

// ════════════════════════════════════════════════════════════════════════
// Helper: signal chip row
// ════════════════════════════════════════════════════════════════════════
function sig(tag,text){
  return '<div style="display:flex;align-items:flex-start;gap:8px">'
    +'<span style="font-size:8px;font-weight:700;letter-spacing:.06em;white-space:nowrap;flex-shrink:0;margin-top:2px;border-radius:4px;padding:2px 7px;color:#334155;background:#eef1f7;border:1px solid #c8d0e0">'+tag+'</span>'
    +'<span style="font-size:12px;color:#444;line-height:1.45">'+text+'</span>'
    +'</div>';
}

// ════════════════════════════════════════════════════════════════════════
// Helper: full card
// ════════════════════════════════════════════════════════════════════════
function card(opts){
  var sigs=opts.signals.map(function(s){return sig(s[0],s[1]);}).join('');
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
    +'<div style="padding:9px 16px;display:flex;align-items:center;gap:10px;border-bottom:1px solid #f0f0f0;background:#fafbfc">'
      +'<span style="font-size:9px;font-weight:700;letter-spacing:.07em;color:#9aa3b5;white-space:nowrap;text-transform:uppercase">AI Confidence</span>'
      +'<div style="flex:1;height:4px;border-radius:99px;background:#e8edf2">'
        +'<div style="height:100%;width:'+opts.confidence+'%;border-radius:99px;background:linear-gradient(90deg,#1e9e6b,#c9a84c)"></div>'
      +'</div>'
      +'<span style="font-size:13px;font-weight:800;color:#1e9e6b;white-space:nowrap">'+opts.confidence+'%</span>'
    +'</div>'
    +'<div style="padding:12px 16px;display:flex;flex-direction:column;gap:8px;border-bottom:1px solid #f0f0f0">'+sigs+'</div>'
    +'<div style="padding:10px 16px 14px">'
      +'<button style="width:100%;background:#0b1628;color:#fff;border:none;border-radius:99px;padding:12px;font-size:13px;font-weight:600;cursor:pointer;font-family:inherit">+ Add to My Slip</button>'
    +'</div>'
  +'</div>';
}

// ════════════════════════════════════════════════════════════════════════
// 1. Update tomorrow container: full-bleed + heading inline padding + tinted gap
// ════════════════════════════════════════════════════════════════════════

// Fix outer container side padding
html=html.replace(
  /(<div class="main" style="padding-top:12px;padding-bottom:0;padding-left:)12px(;padding-right:)12px(">\n\n    <div style="margin-bottom:12px">[\s\S]*?Tomorrow)/,
  function(m,a,b,c){
    return m.replace('padding-left:12px','padding-left:0').replace('padding-right:12px','padding-right:0');
  }
);

// Add inline padding to heading div (tomorrow only — find Tomorrow's NAP heading context)
html=html.replace(
  /(Tomorrow's NAP &amp; NB[\s\S]{0,500}?<div id="racing-tomorrow-nap" style="display:flex;flex-direction:column;gap:)12px(")/,
  '$1' + '10px;background:#edf0f5' + '"'
);

// Also fix the heading wrapper to have inline padding
html=html.replace(
  /(<!-- TOMORROW NAP -->[\s\S]{0,200}?<div style="margin-bottom:12px)(">)/,
  '$1;padding:0 16px$2'
);

console.log('1. Container full-bleed + tinted gap + heading padding');

// ════════════════════════════════════════════════════════════════════════
// 2. Replace hard-coded card content inside racing-tomorrow-nap
// ════════════════════════════════════════════════════════════════════════
const napCard=card({
  icon:'\u26a1', type:'NAP \xb7 Pick of the Day',
  horse:'Galopin Des Champs', detail:'14:00 Cheltenham \xb7 3m Gold Cup Chase',
  odds:'6/4', border:'#1e9e6b', confidence:90,
  signals:[
    ['FORM',    'AI top-rated across form, going and trainer stats \u2014 highest score on tomorrow\u2019s card'],
    ['GOING',   'Won the Gold Cup last season \u2014 conditions suit again on forecast Good to Soft'],
    ['TRAINER', 'De Bromhead yard in top form with 6 winners this week \u2014 52% strike rate'],
    ['JOCKEY',  'Settles beautifully from the front \u2014 favourite profile strongly confirmed'],
    ['MARKET',  'Weight and draw both ideal for this trip \u2014 market has held firm all week']
  ]
});

const nbCard=card({
  icon:'\u2605', type:'NB \xb7 Next Best',
  horse:'Jonbon', detail:'13:30 Cheltenham \xb7 2m Champion Chase',
  odds:'5/2', border:'#0b1628', confidence:76,
  signals:[
    ['FORM',    'Second highest AI rating on tomorrow\u2019s card \u2014 strong profile across key metrics'],
    ['CLASS',   'Course and distance winner \u2014 two from two here, track suits his jumping style'],
    ['JOCKEY',  'Nicky Henderson booking top jockey \u2014 strong stable signal, retained rider up'],
    ['CLASS',   'Steps up after impressive Sandown win last month \u2014 on a career-best trajectory'],
    ['GOING',   'Handles soft ground well \u2014 conditions ideal for his ground-covering stride']
  ]
});

const newCardsHtml=napCard+nbCard;

// Find the opening tag of racing-tomorrow-nap and replace its inner content
const OPEN_TAG_PATTERN='id="racing-tomorrow-nap"';
const cardsStart=html.indexOf(OPEN_TAG_PATTERN);
if(cardsStart<0){console.error('FAIL: racing-tomorrow-nap not found');process.exit(1);}

// Find end of the opening div tag
const openTagEnd=html.indexOf('>',cardsStart)+1;

// Find where the content ends: look for </div> that closes the racing-tomorrow-nap div
// After the cards, the structure is: </div></div>\n\n  </div>\n\n  </div>
// The racing-tomorrow-nap div closes with the first </div> after all card content
// We can find this by locating the next section marker after it
const AFTER_MARKER='<div id="racing-winners-content"';
const afterPos=html.indexOf(AFTER_MARKER,cardsStart);
if(afterPos<0){console.error('FAIL: racing-winners-content not found');process.exit(1);}

// Walk backwards from afterPos to find the closing </div> of racing-tomorrow-nap
// The structure ends: ...button></div></div></div>\n\n  </div>\n\n  </div>\n\n\n\n\n  <div id="racing-winners-content"
// We need to keep the outer </div>\n\n  </div>\n\n  </div>... and only replace inside racing-tomorrow-nap

// Find "</div>" that ends the racing-tomorrow-nap flex container
// by scanning backwards from the AFTER_MARKER
let searchFrom=afterPos;
// The pattern before racing-winners-content is: </div></div>\n\n  </div>\n\n  </div>\n\n\n\n\n
// racing-tomorrow-nap's closing </div> is the FIRST </div> in that sequence
const beforeWinners=html.slice(openTagEnd,afterPos);
// Find the last card's closing </div> — this closes racing-tomorrow-nap
// The structure is: [cards]</div>\n\n  </div>\n\n  </div>
// racing-tomorrow-nap div closes before \n\n  </div>\n\n  </div>

// Strategy: find cardsEnd = position of the </div> that closes racing-tomorrow-nap
// It's followed by \n\n  </div>\n\n  </div>
const closingSeq='\n\n  </div>\n\n  </div>';
const closingPos=html.lastIndexOf(closingSeq,afterPos);
if(closingPos<0){console.error('FAIL: closing sequence not found');process.exit(1);}

// cardsEnd is right at closingPos (the \n\n  </div>... stays, we replace up to it)
html=html.slice(0,openTagEnd)+newCardsHtml+html.slice(closingPos);
console.log('2. Tomorrow cards replaced with new layout');

// ── Syntax check ────────────────────────────────────────────────────────
const ss=html.lastIndexOf('<script>'),se=html.lastIndexOf('</script>');
try{new Function(html.slice(ss+8,se));console.log('Syntax: OK');}
catch(e){console.error('SYNTAX:',e.message);process.exit(1);}

fs.writeFileSync('C:/Users/Gary Coyne/acca-research/index.html',html,'utf8');
console.log('Saved');
