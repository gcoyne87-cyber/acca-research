const fs=require('fs');
let html=fs.readFileSync('C:/Users/Gary Coyne/acca-research/index.html','utf8');

// ════════════════════════════════════════════════════════════════════════
// Helper: build a signal chip row
// ════════════════════════════════════════════════════════════════════════
function sig(tag,text){
  return '<div style="display:flex;align-items:flex-start;gap:8px">'
    +'<span style="font-size:8px;font-weight:700;letter-spacing:.06em;white-space:nowrap;flex-shrink:0;margin-top:2px;border-radius:4px;padding:2px 7px;color:#334155;background:#eef1f7;border:1px solid #c8d0e0">'+tag+'</span>'
    +'<span style="font-size:12px;color:#444;line-height:1.45">'+text+'</span>'
    +'</div>';
}

// ════════════════════════════════════════════════════════════════════════
// Helper: build a full tomorrow pick card
// ════════════════════════════════════════════════════════════════════════
function card(opts){
  // opts: icon, type, horse, detail, odds, border, confidence, signals[]
  var sigs=opts.signals.map(function(s){return sig(s[0],s[1]);}).join('');
  return '<div style="background:#fff;border:none;border-left:4px solid '+opts.border+';overflow:hidden;">'

    // Header
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

    // Confidence bar
    +'<div style="padding:9px 16px;display:flex;align-items:center;gap:10px;border-bottom:1px solid #f0f0f0;background:#fafbfc">'
      +'<span style="font-size:9px;font-weight:700;letter-spacing:.07em;color:#9aa3b5;white-space:nowrap;text-transform:uppercase">AI Confidence</span>'
      +'<div style="flex:1;height:4px;border-radius:99px;background:#e8edf2">'
        +'<div style="height:100%;width:'+opts.confidence+'%;border-radius:99px;background:linear-gradient(90deg,#1e9e6b,#c9a84c)"></div>'
      +'</div>'
      +'<span style="font-size:13px;font-weight:800;color:#1e9e6b;white-space:nowrap">'+opts.confidence+'%</span>'
    +'</div>'

    // Signals
    +'<div style="padding:12px 16px;display:flex;flex-direction:column;gap:8px;border-bottom:1px solid #f0f0f0">'+sigs+'</div>'

    // CTA
    +'<div style="padding:10px 16px 14px">'
      +'<button style="width:100%;background:#0b1628;color:#fff;border:none;border-radius:99px;padding:12px;font-size:13px;font-weight:600;cursor:pointer;font-family:inherit">+ Add to My Slip</button>'
    +'</div>'

  +'</div>';
}

// ════════════════════════════════════════════════════════════════════════
// 1. Update container: full-bleed + heading inline padding + tinted gap
// ════════════════════════════════════════════════════════════════════════
html=html.replace(
  '<!-- TOMORROW NAP -->\n\n  <div class="main" style="padding-top:12px;padding-bottom:0;padding-left:12px;padding-right:12px">\n\n    <div style="margin-bottom:12px">',
  '<!-- TOMORROW NAP -->\n\n  <div class="main" style="padding-top:12px;padding-bottom:0;padding-left:0;padding-right:0">\n\n    <div style="margin-bottom:12px;padding:0 16px">'
);
html=html.replace(
  '<div id="racing-tomorrow-nap" style="display:flex;flex-direction:column;gap:12px">',
  '<div id="racing-tomorrow-nap" style="display:flex;flex-direction:column;gap:10px;background:#edf0f5">'
);
console.log('1. Container full-bleed + tinted gap');

// ════════════════════════════════════════════════════════════════════════
// 2. Replace hard-coded card HTML with new layout
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

// Find and replace the old hard-coded cards block
const cardsStart=html.indexOf('<div id="racing-tomorrow-nap" style="display:flex;flex-direction:column;gap:10px;background:#edf0f5">');
const cardsEnd=html.indexOf('</div>\n\n  </div>\n\n  </div>\n\n\n\n\n\n  <div id="racing-winners-content"', cardsStart);

if(cardsStart<0||cardsEnd<0){console.error('FAIL: cards bounds',cardsStart,cardsEnd);process.exit(1);}

// The old content is between the opening div tag and the closing
const openTagEnd=html.indexOf('>',cardsStart)+1;
html=html.slice(0,openTagEnd)+newCardsHtml+html.slice(cardsEnd);
console.log('2. Tomorrow cards replaced with new layout');

// ── Syntax check ────────────────────────────────────────────────────────
const ss=html.lastIndexOf('<script>'),se=html.lastIndexOf('</script>');
try{new Function(html.slice(ss+8,se));console.log('Syntax: OK');}
catch(e){console.error('SYNTAX:',e.message);process.exit(1);}

fs.writeFileSync('C:/Users/Gary Coyne/acca-research/index.html',html,'utf8');
console.log('Saved');
