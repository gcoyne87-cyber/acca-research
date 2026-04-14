const fs=require('fs');
let html=fs.readFileSync('C:/Users/Gary Coyne/acca-research/index.html','utf8');

// ════════════════════════════════════════════════════════════════════════
// 0. Extract tomorrow course images from the existing carousel
// ════════════════════════════════════════════════════════════════════════
function getTmImgSrc(id){
  var anchor="navigateToTomorrowMeeting('"+id+"')";
  var pos=html.indexOf(anchor);
  if(pos<0) return '';
  var imgTag=html.indexOf('<img src="',pos);
  if(imgTag<0) return '';
  var start=imgTag+'<img src="'.length;
  var end=html.indexOf('"',start);
  return html.slice(start,end);
}
var chImg=getTmImgSrc('cheltenham');
var puImg=getTmImgSrc('punchestown');
var naImg=getTmImgSrc('navan');
var soImg=getTmImgSrc('southwell');
console.log('cheltenham:',chImg.length>0,'punchestown:',puImg.length>0,'navan:',naImg.length>0,'southwell:',soImg.length>0);

// ════════════════════════════════════════════════════════════════════════
// 1. Remove "Tap a course to jump to its race card" from Today
// ════════════════════════════════════════════════════════════════════════
const tapCourseToday='\n        <div style="font-size:13px;color:#4a8c6a;margin-top:4px">Tap a course to jump to its race card</div>\n';
if(!html.includes(tapCourseToday)){console.error('FAIL: Today tap-course text not found');process.exit(1);}
html=html.replace(tapCourseToday,'\n');
console.log('1. Removed Today tap-course subtitle');

// ════════════════════════════════════════════════════════════════════════
// 2. Swap Today: move Next Race section BEFORE NAP/NB section
// ════════════════════════════════════════════════════════════════════════
const picksStart=html.indexOf('\n    <!-- RACING PICKS -->');
const nextRaceStart=html.indexOf('\n    <!-- NEXT RACE -->');
const todayContentEnd=html.indexOf('\n  </div>\n\n  <div id="racing-tomorrow-content"');
if(picksStart<0||nextRaceStart<0||todayContentEnd<0){console.error('FAIL: Today section boundaries not found',picksStart,nextRaceStart,todayContentEnd);process.exit(1);}

const picksHtml=html.slice(picksStart,nextRaceStart);
const nextRaceHtml=html.slice(nextRaceStart,todayContentEnd);

// Replace: put nextRace first, then picks
html=html.slice(0,picksStart)+nextRaceHtml+picksHtml+html.slice(todayContentEnd);
console.log('2. Today: Next Race moved before NAP/NB section');

// ════════════════════════════════════════════════════════════════════════
// 3. Replace Tomorrow carousel + inline meeting with banner list structure
//    Keep the AI feed strip and NAP sections as-is (they stay below)
// ════════════════════════════════════════════════════════════════════════
const tmCarouselStart='\n  <div style="background:#e8f5ef;padding-bottom:4px;">\n  <!-- TOMORROW MEETINGS -->';
const tmInlineEnd='\n  <div id="racing-tomorrow-inline-meeting"';
// Find where the inline meeting div ends (closing div after it)
const tmInlineDivStart=html.indexOf(tmInlineEnd);
if(tmInlineDivStart<0){console.error('FAIL: tomorrow inline meeting div not found');process.exit(1);}
// Find the end of that div (next blank line after it)
const tmInlineEndMark=html.indexOf('\n\n  <!-- AI FEED STRIP TOMORROW -->');
if(tmInlineEndMark<0){console.error('FAIL: AI FEED STRIP TOMORROW anchor not found');process.exit(1);}

const tmCarouselPos=html.indexOf(tmCarouselStart);
if(tmCarouselPos<0){console.error('FAIL: tomorrow carousel start not found');process.exit(1);}

// Build replacement: hidden img storage + meetings list container
const tmReplacement=
  '\n  <div style="background:#e8f5ef;padding-bottom:4px;">\n  <!-- TOMORROW MEETINGS -->'
 +'\n\n  <div style="padding:16px 0 4px">'
 +'\n\n    <div style="padding:0 12px;display:flex;align-items:flex-end;justify-content:space-between;margin-bottom:12px">'
 +'\n\n      <div>'
 +'\n\n        <div style="font-size:20px;font-weight:700;color:#0b1628;line-height:1.1">Tomorrow\'s Meetings</div>'
 +'\n\n      </div>'
 +'\n\n    </div>'
 +'\n'
 +'    <div id="tomorrow-meeting-imgs" style="display:none">\n'
 +'      <img id="img-cheltenham" src="'+chImg+'">\n'
 +'      <img id="img-punchestown" src="'+puImg+'">\n'
 +'      <img id="img-navan" src="'+naImg+'">\n'
 +'      <img id="img-southwell" src="'+soImg+'">\n'
 +'    </div>\n'
 +'    <div id="tomorrow-meetings-list" style="padding:0 0 4px"></div>\n\n'
 +'  </div>\n'
 +'  </div>';

html=html.slice(0,tmCarouselPos)+tmReplacement+html.slice(tmInlineEndMark);
console.log('3. Tomorrow carousel replaced with banner list');

// ════════════════════════════════════════════════════════════════════════
// 4. Remove "Tap a course to jump to its race card" from Tomorrow
//    (may no longer exist after carousel replace, but check just in case)
// ════════════════════════════════════════════════════════════════════════
const tapCourseTmrw='\n        <div style="font-size:13px;color:#4a8c6a;margin-top:4px">Tap a course to jump to its race card</div>\n';
if(html.includes(tapCourseTmrw)){
  html=html.replace(tapCourseTmrw,'\n');
  console.log('4. Removed Tomorrow tap-course subtitle');
} else {
  console.log('4. Tomorrow tap-course subtitle already gone (removed with carousel)');
}

// ════════════════════════════════════════════════════════════════════════
// 5. Add tomorrow banner list JS
//    Insert before navigateToTomorrowMeeting function
// ════════════════════════════════════════════════════════════════════════
const insertBefore='function navigateToTomorrowMeeting(id){';
if(!html.includes(insertBefore)){console.error('FAIL: navigateToTomorrowMeeting not found');process.exit(1);}

const newTmJs=
'// ── TOMORROW MEETINGS VERTICAL LIST ────────────────────────────────────\r\n'+
'var tmOpenMeeting="";\r\n'+
'\r\n'+
'function getTomorrowMeetingImg(id){\r\n'+
'  var el=document.getElementById("img-"+id);\r\n'+
'  if(!el||!el.src||el.src.length<10) el=document.getElementById("img-cheltenham");\r\n'+
'  return el?el.src:"";\r\n'+
'}\r\n'+
'\r\n'+
'function toggleTomorrowMeeting(id){\r\n'+
'  if(tmOpenMeeting===id){\r\n'+
'    tmOpenMeeting="";\r\n'+
'  } else {\r\n'+
'    tmOpenMeeting=id;\r\n'+
'    tmOpenRace={};\r\n'+
'  }\r\n'+
'  renderTomorrowMeetingsList();\r\n'+
'}\r\n'+
'\r\n'+
'function tomorrowSelectRace(mid,ri){\r\n'+
'  tmOpenRace[mid]=tmOpenRace[mid]===ri?null:ri;\r\n'+
'  renderTomorrowMeetingsList();\r\n'+
'  if(tmOpenRace[mid]!=null){\r\n'+
'    setTimeout(function(){\r\n'+
'      var el=document.getElementById("tmpills-"+mid);\r\n'+
'      if(el) el.scrollIntoView({behavior:"smooth",block:"nearest"});\r\n'+
'    },60);\r\n'+
'  }\r\n'+
'}\r\n'+
'\r\n'+
'function renderTomorrowMeetingsList(){\r\n'+
'  var el=document.getElementById("tomorrow-meetings-list");\r\n'+
'  if(!el) return;\r\n'+
'  var out="";\r\n'+
'  TM_MEETINGS.forEach(function(m){\r\n'+
'    var isOpen=tmOpenMeeting===m.id;\r\n'+
'    var imgSrc=getTomorrowMeetingImg(m.id);\r\n'+
'    var hasRace=tmOpenRace[m.id]!=null;\r\n'+
'    var selRace=tmOpenRace[m.id];\r\n'+
'    // Full-width banner card\r\n'+
'    out+=\'<div style="margin:0 0 2px;border-radius:0;overflow:hidden">\';\r\n'+
'    // Image banner — tappable\r\n'+
'    out+=\'<div onclick="toggleTomorrowMeeting(\\\'\'+m.id+\'\\\')" style="position:relative;height:72px;background:#0b1628;overflow:hidden;cursor:pointer">\';\r\n'+
'    if(imgSrc) out+=\'<img src="\'+imgSrc+\'" style="width:100%;height:100%;object-fit:cover;display:block">\';\r\n'+
'    out+=\'<div style="position:absolute;inset:0;background:linear-gradient(180deg,rgba(11,22,40,0.06) 0%,rgba(11,22,40,0.72) 100%)"></div>\';\r\n'+
'    // AI EDGE badge top-left\r\n'+
'    out+=\'<div style="position:absolute;top:8px;left:10px;background:#0b1628;border:1.5px solid #c9a84c;border-radius:4px;padding:2px 7px;display:inline-flex;align-items:center;gap:3px">\';\r\n'+
'    out+=\'<div style="width:4px;height:4px;border-radius:50%;background:#1e9e6b;flex-shrink:0"></div>\';\r\n'+
'    out+=\'<span style="font-size:8px;font-weight:700;color:#fff;letter-spacing:0.08em">AI EDGE</span></div>\';\r\n'+
'    // +/- circle top-right\r\n'+
'    out+=\'<div style="position:absolute;top:6px;right:10px;width:24px;height:24px;border-radius:50%;background:rgba(255,255,255,0.2);border:1.5px solid rgba(255,255,255,0.5);display:flex;align-items:center;justify-content:center">\';\r\n'+
'    out+=\'<span style="font-size:16px;line-height:1;color:#fff;font-weight:300">\'+(isOpen?"&minus;":"+")+\'</span></div>\';\r\n'+
'    // Venue name bottom-left\r\n'+
'    out+=\'<div style="position:absolute;bottom:0;left:0;right:0;padding:6px 12px 8px">\';\r\n'+
'    out+=\'<div style="font-size:16px;font-weight:700;color:#fff;line-height:1;letter-spacing:-0.3px">\'+escHtml(m.name)+\'</div>\';\r\n'+
'    out+=\'<div style="margin-top:3px;display:flex;align-items:center;gap:6px">\';\r\n'+
'    out+=\'<span style="font-size:10px;font-weight:600;color:rgba(255,255,255,0.82)">\'+m.races.length+\' races</span>\';\r\n'+
'    if(m.feature) out+=\'<span style="font-size:9px;font-weight:700;background:#1e9e6b;color:#fff;padding:2px 7px;border-radius:99px;letter-spacing:.04em">FEATURE</span>\';\r\n'+
'    out+=\'</div></div>\';\r\n'+
'    out+=\'</div>\';\r\n'+
'    // Expanded white panel\r\n'+
'    if(isOpen){\r\n'+
'      out+=\'<div style="background:#fff;border-top:1px solid #e4e8f0">\';\r\n'+
'      out+=\'<button class="fx-cta" style="margin:10px 12px 4px;width:calc(100% - 24px)"><span style="color:var(--gold)">&#x2756;</span> Analyse Full \'+escHtml(m.name)+\' Card with AI &rarr;</button>\';\r\n'+
'      out+=\'<div style="display:flex;gap:6px;padding:6px 12px 8px;flex-wrap:wrap">\';\r\n'+
'      out+=\'<span style="font-size:11px;font-weight:600;padding:3px 9px;border-radius:20px;background:#fff8e6;color:#a07010;border:1px solid #f0d87a">\'+escHtml(m.going)+\'</span>\';\r\n'+
'      if(m.feature) out+=\'<span style="font-size:11px;font-weight:600;padding:3px 9px;border-radius:20px;background:#f0faf6;color:#085041;border:1px solid #c8ead9">Feature Meeting</span>\';\r\n'+
'      out+=\'</div>\';\r\n'+
'      var pillStyle=hasRace\r\n'+
'        ?"position:sticky;top:56px;z-index:10;background:#fff;border-bottom:1px solid #f0f2f7;"\r\n'+
'        :"border-top:1px solid #f0f2f7;";\r\n'+
'      out+=\'<div id="tmpills-\'+m.id+\'" style="\'+pillStyle+\'display:flex;gap:7px;overflow-x:auto;padding:8px 12px;scrollbar-width:none;-webkit-overflow-scrolling:touch">\';\r\n'+
'      m.races.forEach(function(race,ri){\r\n'+
'        var isSel=selRace===ri;\r\n'+
'        out+=\'<div style="flex-shrink:0;width:58px;border:1px solid \'+(isSel?"#0b1628":"#e4e8f0")+\';border-radius:8px;padding:8px 4px;text-align:center;cursor:pointer;background:\'+(isSel?"#0b1628":"#f5f7fb")+\'" onclick="tomorrowSelectRace(\\\'\'+m.id+\'\\\',\'+ri+\')">\';\r\n'+
'        out+=\'<div style="font-size:12px;font-weight:600;color:\'+(isSel?"#fff":"#0b1628")+\'">\'+escHtml(race.t)+\'</div>\';\r\n'+
'        out+=\'<div style="font-size:10px;color:\'+(isSel?"rgba(255,255,255,.55)":"#9aa3b5")+\';margin-top:1px">\'+race.r+\' rnrs</div>\';\r\n'+
'        out+=\'</div>\';\r\n'+
'      });\r\n'+
'      out+=\'</div>\';\r\n'+
'      if(hasRace) out+=tmRaceDetailHtml(m);\r\n'+
'      out+=\'</div>\';\r\n'+
'    }\r\n'+
'    out+=\'</div>\';\r\n'+
'  });\r\n'+
'  el.innerHTML=out;\r\n'+
'}\r\n'+
'\r\n'+
'function navigateToTomorrowMeeting(id){';

html=html.replace(insertBefore, newTmJs);
console.log('5. Tomorrow banner list JS added');

// ════════════════════════════════════════════════════════════════════════
// 6. Call renderTomorrowMeetingsList() from selectRacingDate('tomorrow')
// ════════════════════════════════════════════════════════════════════════
const oldTmInit='  if(d==="tomorrow") aiFeedInitTomorrow();';
if(!html.includes(oldTmInit)){console.error('FAIL: tomorrow init anchor not found');process.exit(1);}
html=html.replace(oldTmInit,'  if(d==="tomorrow"){ aiFeedInitTomorrow(); renderTomorrowMeetingsList(); }');
console.log('6. renderTomorrowMeetingsList() called from selectRacingDate');

// ── Syntax check ─────────────────────────────────────────────────────────────
const ss=html.lastIndexOf('<script>'),se=html.lastIndexOf('</script>');
try{new Function(html.slice(ss+8,se));console.log('Syntax: OK');}
catch(e){console.error('SYNTAX:',e.message);process.exit(1);}

fs.writeFileSync('C:/Users/Gary Coyne/acca-research/index.html',html,'utf8');
console.log('Saved');
