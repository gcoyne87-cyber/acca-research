const fs=require('fs');
let html=fs.readFileSync('C:/Users/Gary Coyne/acca-research/index.html','utf8');

// ════════════════════════════════════════════════════════════════════════
// 1. Open green wrapper before <!-- TOMORROW MEETINGS -->
// ════════════════════════════════════════════════════════════════════════
const openTarget='\r\n  <!-- TOMORROW MEETINGS -->\r\n\r\n  <div style="padding:16px 0 4px">';
const openReplacement='\r\n  <div style="background:#e8f5ef;padding-bottom:4px;">\r\n  <!-- TOMORROW MEETINGS -->\r\n\r\n  <div style="padding:16px 0 4px">';
if(!html.includes(openTarget)){console.error('FAIL: tomorrow open target not found');process.exit(1);}
html=html.replace(openTarget,openReplacement);
console.log('1. Green wrapper opening inserted');

// ════════════════════════════════════════════════════════════════════════
// 2. Fix Tomorrow heading colour: var(--navy) → #0b1628
// ════════════════════════════════════════════════════════════════════════
const oldHeading='font-size:20px;font-weight:700;color:var(--navy);line-height:1.1">Tomorrow\'s Meetings</div>';
const newHeading='font-size:20px;font-weight:700;color:#0b1628;line-height:1.1">Tomorrow\'s Meetings</div>';
if(!html.includes(oldHeading)){console.error('FAIL: tomorrow heading not found');process.exit(1);}
html=html.replace(oldHeading,newHeading);
console.log('2. Tomorrow heading colour updated');

// ════════════════════════════════════════════════════════════════════════
// 3. Fix Tomorrow subtitle colour: var(--muted) → #4a8c6a
// ════════════════════════════════════════════════════════════════════════
const oldSub='font-size:13px;color:var(--muted);margin-top:4px">Tap a course to jump to its race card</div>';
const newSub='font-size:13px;color:#4a8c6a;margin-top:4px">Tap a course to jump to its race card</div>';
if(!html.includes(oldSub)){console.error('FAIL: tomorrow subtitle not found');process.exit(1);}
html=html.replace(oldSub,newSub);
console.log('3. Tomorrow subtitle colour updated');

// ════════════════════════════════════════════════════════════════════════
// 4. Close green wrapper + add inline meeting shell + winners + NAP
//    Target is the end of the tomorrow-content section
// ════════════════════════════════════════════════════════════════════════
const closeTarget='    </div>\r\n\r\n  </div>\r\n\r\n  </div>\r\n\r\n  </div><!-- /racing-home-content -->';

// Winner card helper (static HTML matching renderRacingWinners card style)
function winnerCard(result,horse,time,course,type,price){
  var isWin=result==='Winner';
  var isEW=result==='Each Way';
  var borderTop=isWin?'3px solid #1e9e6b':isEW?'3px solid #b8e0cc':'3px solid #e4e8f0';
  var resultText=isWin?'WON':isEW?'E/W':result;
  var resultColor=isWin?'#1e9e6b':isEW?'#4a8c6a':'#9aa3b5';
  var priceColor=isWin?'#1e9e6b':isEW?'#4a8c6a':'#0b1628';
  var aiTag='<div style="display:inline-flex;align-items:center;gap:4px;background:#0b1628;border-radius:4px;padding:2px 7px"><div style="width:4px;height:4px;border-radius:50%;background:#1e9e6b;flex-shrink:0"></div><span style="font-size:8px;font-weight:700;color:#ffffff;letter-spacing:0.1em">AI EDGE</span></div>';
  return '<div style="flex-shrink:0;width:160px;background:#ffffff;border-radius:12px;border:1px solid #e4e8f0;border-top:'+borderTop+';padding:10px 12px">'
    +'<div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:7px">'+aiTag+'<div style="font-size:11px;font-weight:700;color:'+resultColor+'">'+resultText+'</div></div>'
    +'<div style="font-size:14px;font-weight:700;color:#0b1628;margin-bottom:2px">'+horse+'</div>'
    +'<div style="font-size:11px;color:#9aa3b5;margin-bottom:6px">'+time+' · '+course+'</div>'
    +'<div style="display:flex;align-items:center;justify-content:space-between">'
      +'<div style="font-size:10px;color:#9aa3b5">'+type+'</div>'
      +'<div style="font-size:17px;font-weight:700;color:'+priceColor+'">'+price+'</div>'
    +'</div>'
  +'</div>';
}

// NAP/NB pick card helper (static HTML matching renderRacingPicks card style)
function pickCard(border,icon,type,horse,detail,price,reasons){
  var rows=reasons.map(function(r){
    return '<div style="display:flex;align-items:baseline;gap:6px;font-size:12px;color:#555;line-height:1.5"><span style="color:#1e9e6b;font-weight:700;flex-shrink:0">✓</span><span>'+r+'</span></div>';
  }).join('');
  return '<div style="background:#fff;border:1px solid #e8eaed;border-radius:12px;overflow:hidden;border-left:4px solid '+border+'">'
    +'<div style="padding:14px 16px;display:flex;align-items:flex-start;justify-content:space-between;border-bottom:1px solid #f0f0f0">'
      +'<div>'
        +'<div style="display:inline-flex;align-items:center;gap:6px;border:1px solid #e8eaed;border-radius:99px;padding:3px 10px;margin-bottom:8px"><span style="font-size:12px">'+icon+'</span><span style="font-size:11px;font-weight:600;color:#0b1628">'+type+'</span></div>'
        +'<div style="font-size:19px;font-weight:700;color:#0b1628;line-height:1.1;margin-bottom:3px">'+horse+'</div>'
        +'<div style="font-size:11px;color:#aaa">'+detail+'</div>'
      +'</div>'
      +'<div style="text-align:right;flex-shrink:0;padding-left:12px">'
        +'<div style="font-size:10px;color:#aaa;margin-bottom:2px;letter-spacing:.04em">PRICE</div>'
        +'<div style="font-size:24px;font-weight:700;color:#1e9e6b;line-height:1">'+price+'</div>'
      +'</div>'
    +'</div>'
    +'<div style="padding:12px 16px;display:flex;flex-direction:column;gap:5px;border-bottom:1px solid #f0f0f0">'+rows+'</div>'
    +'<div style="padding:10px 16px 14px"><button style="width:100%;background:#0b1628;color:#fff;border:none;border-radius:99px;padding:12px;font-size:13px;font-weight:600;cursor:pointer;font-family:inherit">+ Add to My Slip</button></div>'
  +'</div>';
}

const tmrwWinnersHtml=
  winnerCard('Winner','Galopin Des Champs','14:00','Cheltenham','Pick of the Day','6/4')
  +winnerCard('Winner','Jonbon','13:30','Cheltenham','Each Way Pick','5/2')
  +winnerCard('Each Way','El Fabiolo','15:20','Punchestown','Dark Horse','7/2');

const napHtml=pickCard(
  '#1e9e6b','⚡','NAP · Pick of the Day',
  'Galopin Des Champs','14:00 Cheltenham · 3m Gold Cup Chase','6/4',
  ['AI top-rated across form, going and trainer stats','Won the Gold Cup last season — conditions suit again','De Bromhead yard in top form with 6 winners this week','Settles well from the front — favourite profile confirmed','Weight and draw both ideal for this trip']
);
const nbHtml=pickCard(
  '#0b1628','★','NB · Next Best',
  'Jonbon','13:30 Cheltenham · 2m Champion Chase','5/2',
  ['Second highest AI rating on tomorrow\'s card','Course and distance winner — two from two here','Nicky Henderson booking top jockey — strong stable signal','Steps up after impressive Sandown win last month','Handles soft ground well — conditions ideal']
);

const closeReplacement=
  '    </div>\r\n\r\n'   // closes carousel
  +'  </div>\r\n\r\n'   // closes padding:16px 0 4px
  +'  <div id="racing-tomorrow-inline-meeting" style="max-height:0;overflow:hidden;transition:max-height 0.35s ease"></div>\r\n\r\n'
  +'  </div>\r\n\r\n'  // closes green wrapper
  +'  <!-- TOMORROW WINNERS -->\r\n\r\n'
  +'  <div style="padding:18px 12px 4px">\r\n\r\n'
  +'    <div style="display:flex;align-items:flex-end;justify-content:space-between;margin-bottom:14px">\r\n\r\n'
  +'      <div>\r\n\r\n'
  +'        <div style="font-size:20px;font-weight:700;color:var(--navy)">AI Picks · Latest Winners</div>\r\n\r\n'
  +'        <div style="font-size:12px;color:#9aa3b5;margin-top:3px">Predicted by AI · How they ran</div>\r\n\r\n'
  +'      </div>\r\n\r\n'
  +'      <div style="font-size:12px;font-weight:500;color:var(--green)">Swipe right →</div>\r\n\r\n'
  +'    </div>\r\n\r\n'
  +'    <div style="display:flex;gap:10px;overflow-x:auto;padding-bottom:8px;scrollbar-width:none;-webkit-overflow-scrolling:touch" id="racing-tomorrow-winners">'
  +tmrwWinnersHtml
  +'</div>\r\n\r\n'
  +'  </div>\r\n\r\n'
  +'  <!-- TOMORROW NAP -->\r\n\r\n'
  +'  <div class="main" style="padding-top:12px;padding-bottom:0;padding-left:12px;padding-right:12px">\r\n\r\n'
  +'    <div style="margin-bottom:12px">\r\n\r\n'
  +'      <span style="font-size:24px;line-height:1;display:block;margin-bottom:6px">🎯</span>\r\n\r\n'
  +'      <div style="font-size:20px;font-weight:700;color:var(--navy);line-height:1.1">Tomorrow\'s NAP &amp; NB</div>\r\n\r\n'
  +'      <div style="font-size:13px;color:var(--muted);margin-top:4px">AI-researched selections · Tap to add to slip</div>\r\n\r\n'
  +'    </div>\r\n\r\n'
  +'    <div id="racing-tomorrow-nap" style="display:flex;flex-direction:column;gap:12px">'
  +napHtml+nbHtml
  +'</div>\r\n\r\n'
  +'  </div>\r\n\r\n'   // closes racing-tomorrow-content
  +'  </div><!-- /racing-home-content -->';

if(!html.includes(closeTarget)){console.error('FAIL: close target not found');process.exit(1);}
html=html.replace(closeTarget,closeReplacement);
console.log('4. Green wrapper closed, inline meeting shell, winners and NAP sections added');

// ════════════════════════════════════════════════════════════════════════
// 5. Fix selectRacingDate: Tomorrow → hide feed-live-badge instead of "● EARLY"
// ════════════════════════════════════════════════════════════════════════
const oldFeedLive='if(feedLive){\r\n    if(d===\"tomorrow\"){\r\n      feedLive.style.color=\"#c9a84c\";\r\n      feedLive.textContent=\"● EARLY\";\r\n    }else{\r\n      feedLive.style.color';
const newFeedLive='if(feedLive){\r\n    if(d===\"tomorrow\"){\r\n      feedLive.style.display=\"none\";\r\n    }else{\r\n      feedLive.style.display=\"\";\r\n      feedLive.style.color';
if(!html.includes(oldFeedLive)){console.error('FAIL: feedLive target not found');process.exit(1);}
html=html.replace(oldFeedLive,newFeedLive);
console.log('5. feed-live-badge hidden for Tomorrow tab');

// ── Syntax check ──────────────────────────────────────────────────────────────
const ss=html.lastIndexOf('<script>'),se=html.lastIndexOf('</script>');
try{new Function(html.slice(ss+8,se));console.log('Syntax: OK');}
catch(e){console.error('SYNTAX:',e.message);process.exit(1);}

fs.writeFileSync('C:/Users/Gary Coyne/acca-research/index.html',html,'utf8');
console.log('Saved');
