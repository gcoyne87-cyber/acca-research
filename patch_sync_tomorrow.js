const fs=require('fs');
let html=fs.readFileSync('C:/Users/Gary Coyne/acca-research/index.html','utf8');

// ════════════════════════════════════════════════════════════════════════
// 1. Compress today's card further — less space around the divider
// ════════════════════════════════════════════════════════════════════════
html=html.replace(
  '\'<div style="padding:13px 14px 9px;display:flex;align-items:flex-start;justify-content:space-between;gap:12px">\'',
  '\'<div style="padding:12px 14px 7px;display:flex;align-items:flex-start;justify-content:space-between;gap:12px">\''
);
html=html.replace(
  '\'<div style="padding:8px 14px 11px">\'',
  '\'<div style="padding:7px 14px 10px">\''
);
console.log('1. Today card spacing compressed');

// ════════════════════════════════════════════════════════════════════════
// 2. Fix tomorrow meeting banners to match today
//    - races count font-size: 13px → 10px
//    - bottom padding: 8px 14px 10px → 6px 10px 8px (match today)
//    - +/- circle: top:6px → top:8px, 24px → 28px, font 16px → 18px
// ════════════════════════════════════════════════════════════════════════
// +/- circle size
html=html.replace(
  "out+='<div style=\"position:absolute;top:6px;right:10px;width:24px;height:24px;border-radius:50%;background:rgba(255,255,255,0.2);border:1.5px solid rgba(255,255,255,0.5);display:flex;align-items:center;justify-content:center\">';",
  "out+='<div style=\"position:absolute;top:8px;right:10px;width:28px;height:28px;border-radius:50%;background:rgba(255,255,255,0.2);border:1.5px solid rgba(255,255,255,0.5);display:flex;align-items:center;justify-content:center\">';"
);
html=html.replace(
  "out+='<span style=\"font-size:16px;line-height:1;color:#fff;font-weight:300\">'+(isOpen?\"&minus;\":\"+\")+\"</span></div>\";",
  "out+='<span style=\"font-size:18px;line-height:1;color:#fff;font-weight:300\">'+(isOpen?\"&minus;\":\"+\")+\"</span></div>\";"
);
// Bottom text area padding + font size
html=html.replace(
  "out+='<div style=\"position:absolute;bottom:0;left:0;right:0;padding:8px 14px 10px\">';",
  "out+='<div style=\"position:absolute;bottom:0;left:0;right:0;padding:6px 10px 8px\">';"
);
html=html.replace(
  "out+='<span style=\"font-size:13px;font-weight:600;color:rgba(255,255,255,0.82)\">'+m.races.length+' races</span>';",
  "out+='<span style=\"font-size:10px;font-weight:500;color:rgba(255,255,255,0.75)\">'+m.races.length+' races</span>';"
);
console.log('2. Tomorrow meeting banners synced to today');

// ════════════════════════════════════════════════════════════════════════
// 3. Replace tomorrow's static NAP/NB header + cards to match today
// ════════════════════════════════════════════════════════════════════════

// NAP signals text (joined into research paragraph)
var napResearch=[
  '<strong style="font-weight:700;color:#0a5c38;font-size:10.5px;letter-spacing:.05em">FORM</strong> AI top-rated across form, going and trainer stats \u2014 highest score on tomorrow\u2019s card',
  '<strong style="font-weight:700;color:#0a5c38;font-size:10.5px;letter-spacing:.05em">GOING</strong> Won the Gold Cup last season \u2014 conditions suit again on forecast Good to Soft',
  '<strong style="font-weight:700;color:#0a5c38;font-size:10.5px;letter-spacing:.05em">TRAINER</strong> De Bromhead yard in top form with 6 winners this week \u2014 52% strike rate',
  '<strong style="font-weight:700;color:#0a5c38;font-size:10.5px;letter-spacing:.05em">JOCKEY</strong> Settles beautifully from the front \u2014 favourite profile strongly confirmed',
  '<strong style="font-weight:700;color:#0a5c38;font-size:10.5px;letter-spacing:.05em">MARKET</strong> Market has held firm all week \u2014 weight ideal for this trip'
].join('<span style="color:#6dbf96"> &middot; </span>');

var nbResearch=[
  '<strong style="font-weight:700;color:#0a5c38;font-size:10.5px;letter-spacing:.05em">FORM</strong> Second highest AI rating on tomorrow\u2019s card \u2014 strong profile across key metrics',
  '<strong style="font-weight:700;color:#0a5c38;font-size:10.5px;letter-spacing:.05em">CLASS</strong> Course and distance winner \u2014 two from two here, track suits his jumping style',
  '<strong style="font-weight:700;color:#0a5c38;font-size:10.5px;letter-spacing:.05em">JOCKEY</strong> Nicky Henderson booking top jockey \u2014 strong stable signal, retained rider up',
  '<strong style="font-weight:700;color:#0a5c38;font-size:10.5px;letter-spacing:.05em">CLASS</strong> Steps up after impressive Sandown win last month \u2014 on a career-best trajectory',
  '<strong style="font-weight:700;color:#0a5c38;font-size:10.5px;letter-spacing:.05em">GOING</strong> Handles soft ground well \u2014 conditions ideal for his ground-covering stride'
].join('<span style="color:#6dbf96"> &middot; </span>');

var AI_BADGE=
  '<div style="display:inline-flex;align-items:center;gap:4px;margin-bottom:8px;background:#0b1628;border:1.5px solid #c9a84c;border-radius:5px;padding:3px 8px">'
  +'<div style="width:5px;height:5px;border-radius:50%;background:#1e9e6b;flex-shrink:0"></div>'
  +'<span style="font-size:9px;font-weight:700;letter-spacing:0.1em;color:#fff">AI EDGE</span>'
  +'</div>';

function buildCard(opts){
  var tagBg   = opts.isNap ? '#fef9e7' : '#f0faf5';
  var tagBorder= opts.isNap ? '1px solid #c9a84c' : '1px solid #1e9e6b';
  var tagColor = opts.isNap ? '#7a5800' : '#065f46';
  return '<div style="background:#fff;border-radius:12px;border:1px solid #e8eaed;overflow:hidden">'
    +'<div style="padding:12px 14px 7px;display:flex;align-items:flex-start;justify-content:space-between;gap:12px">'
      +'<div style="flex:1;min-width:0">'
        +'<div style="display:inline-flex;align-items:center;margin-bottom:6px;border-radius:5px;padding:3px 9px;font-size:10px;font-weight:700;letter-spacing:.05em;background:'+tagBg+';border:'+tagBorder+';color:'+tagColor+'">'+opts.type+'</div>'
        +'<div style="font-size:20px;font-weight:800;color:#0b1628;line-height:1.1;margin-bottom:4px">'+opts.horse+'</div>'
        +'<div style="font-size:11px;color:#9aa3b5;line-height:1.4">'+opts.detail+'</div>'
      +'</div>'
      +'<div style="text-align:right;flex-shrink:0">'
        +'<div style="font-size:22px;font-weight:800;color:#1e9e6b;line-height:1">'+opts.odds+'</div>'
        +'<div style="font-size:11px;color:#9aa3b5;margin-top:3px">E/W</div>'
      +'</div>'
    +'</div>'
    +'<div style="height:1px;background:#f3f4f6;margin:0 15px"></div>'
    +'<div style="padding:7px 14px 10px">'
      +AI_BADGE
      +'<div style="font-size:12px;color:#1a6b4a;line-height:1.55;font-weight:450">'+opts.research+'</div>'
    +'</div>'
    +'<div style="padding:0 14px 13px">'
      +'<button style="width:100%;background:#0b1628;color:#fff;border:none;border-radius:99px;padding:12px;font-size:13px;font-weight:600;cursor:pointer;font-family:inherit">+ Add to My Slip</button>'
    +'</div>'
  +'</div>';
}

var napCard=buildCard({
  isNap:true,
  type:'NAP \u00b7 Pick of the Day',
  horse:'Galopin Des Champs',
  detail:'14:00 Cheltenham \u00b7 3m Gold Cup Chase',
  odds:'6/4',
  research:napResearch
});

var nbCard=buildCard({
  isNap:false,
  type:'NB \u00b7 Next Best',
  horse:'Jonbon',
  detail:'13:30 Cheltenham \u00b7 2m Champion Chase',
  odds:'5/2',
  research:nbResearch
});

// New header — AI EDGE badge above title, same pattern as today
var newTmrwHeader=
'  <div class="main" style="padding-top:12px;padding-bottom:0;padding-left:0;padding-right:0">\n\n'
+'    <div style="margin-bottom:14px;padding:0 16px">\n'
+'      <div style="display:inline-flex;align-items:center;gap:3px;margin-bottom:7px;background:#0b1628;border:1.5px solid #c9a84c;border-radius:5px;padding:2px 8px">\n'
+'        <div style="width:4px;height:4px;border-radius:50%;background:#1e9e6b;flex-shrink:0"></div>\n'
+'        <span style="font-size:9px;font-weight:700;letter-spacing:0.1em;color:#fff">AI EDGE</span>\n'
+'      </div>\n'
+'      <div style="font-size:21px;font-weight:700;color:#0b1628;line-height:1.2">Picks of the Day</div>\n'
+'    </div>\n\n'
+'    <div id="racing-tomorrow-nap" style="display:flex;flex-direction:column;gap:12px;padding:0 16px 16px">'
+napCard+nbCard
+'</div>\n\n'
+'  </div>';

// Find and replace the full tomorrow NAP section
const OLD_COMMENT='<!-- TOMORROW NAP -->';
const OLD_END='\n\n  </div>';
const startIdx=html.indexOf(OLD_COMMENT);
if(startIdx<0){console.error('FAIL: TOMORROW NAP comment not found');process.exit(1);}

// Find the closing </div> of the .main wrapper (after the nap container)
const napContainerIdx=html.indexOf('id="racing-tomorrow-nap"',startIdx);
const napOpenEnd=html.indexOf('>',napContainerIdx)+1;

// Find where the nap container closes — before racing-winners-content
const winnersMarker='</div>\n\n\n<div id="racing-winners-content"';
const closingIdx=html.indexOf(winnersMarker,startIdx);
if(closingIdx<0){console.error('FAIL: closing boundary not found');process.exit(1);}

// The old section runs from OLD_COMMENT to just before the winners marker
html=html.slice(0,startIdx)+'\n'+newTmrwHeader+'\n'+html.slice(closingIdx);
console.log('3. Tomorrow NAP section replaced');

// ── Syntax check ─────────────────────────────────────────────────────────
const ss=html.lastIndexOf('<script>'),se=html.lastIndexOf('</script>');
try{new Function(html.slice(ss+8,se));console.log('Syntax: OK');}
catch(e){console.error('GLOBAL SYNTAX:',e.message);process.exit(1);}

// Verify div balance around tomorrow content
const tmrwS=html.indexOf('<div id="racing-tomorrow-content"');
const winnersS=html.indexOf('<div id="racing-winners-content"');
const seg=html.slice(tmrwS,winnersS);
const opens=(seg.match(/<div/g)||[]).length;
const closes=(seg.match(/<\/div>/g)||[]).length;
console.log('Div balance (should be 0):',opens-closes);

fs.writeFileSync('C:/Users/Gary Coyne/acca-research/index.html',html,'utf8');
console.log('Saved');
