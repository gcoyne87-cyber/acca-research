const fs=require('fs');
let html=fs.readFileSync('C:/Users/Gary Coyne/acca-research/index.html','utf8');

// ════════════════════════════════════════════════════════════════════════
// 1. Extract base64 img src for each course from the old carousel cards
// ════════════════════════════════════════════════════════════════════════
function getImgSrc(id){
  var anchor="navigateToMeetings('"+id+"')";
  var pos=html.indexOf(anchor);
  if(pos<0) return '';
  var imgTag=html.indexOf('<img src="',pos);
  if(imgTag<0) return '';
  var start=imgTag+'<img src="'.length;
  var end=html.indexOf('"',start);
  return html.slice(start,end);
}

var corkImg=getImgSrc('cork');
var fairyhouseImg=getImgSrc('fairyhouse');
var aintreeImg=getImgSrc('aintree');
var kempton=getImgSrc('kempton'); // may be empty
console.log('Cork img found:',corkImg.length>0);
console.log('Fairyhouse img found:',fairyhouseImg.length>0);
console.log('Aintree img found:',aintreeImg.length>0);

// ════════════════════════════════════════════════════════════════════════
// 2. Replace the carousel HTML + old expansion panel with:
//    - hidden img storage div
//    - new vertical list container
// ════════════════════════════════════════════════════════════════════════
const carouselStart='\r\n\r\n      <div style="display:flex;gap:10px;overflow-x:auto;padding:0 12px 14px;scrollbar-width:none;-webkit-overflow-scrolling:touch">';
const expansionEnd='    </div>\r\n\r\n    </div>\r\n\r\n    <!-- AI FEED STRIP -->';

const cs=html.indexOf(carouselStart);
if(cs<0){console.error('FAIL: carousel start not found');process.exit(1);}
const ee=html.indexOf(expansionEnd);
if(ee<0){console.error('FAIL: expansion end not found');process.exit(1);}

// Build the replacement
const imgStorageHtml=
  '\r\n\r\n    <div id="meeting-imgs" style="display:none">\r\n'
  +'      <img id="img-cork" src="'+corkImg+'">\r\n'
  +'      <img id="img-fairyhouse" src="'+fairyhouseImg+'">\r\n'
  +'      <img id="img-aintree" src="'+aintreeImg+'">\r\n'
  +'    </div>\r\n'
  +'    <div id="today-meetings-list" style="padding:0 0 4px"></div>\r\n\r\n'
  +'    </div>\r\n\r\n    <!-- AI FEED STRIP -->';

html=html.slice(0,cs)+imgStorageHtml+html.slice(ee+expansionEnd.length);
console.log('1. Carousel replaced with vertical list container + hidden img storage');

// ════════════════════════════════════════════════════════════════════════
// 3. Add new JS for the vertical meetings list
//    Insert before rcPillsHtml function
// ════════════════════════════════════════════════════════════════════════
const insertBefore='function rcPillsHtml(m){';
if(!html.includes(insertBefore)){console.error('FAIL: rcPillsHtml anchor not found');process.exit(1);}

// New variable + functions
const newJs=
'// ── TODAY MEETINGS VERTICAL LIST ────────────────────────────────────\r\n'+
'var todayOpenMeeting="";\r\n'+
'\r\n'+
'function getMeetingImg(id){\r\n'+
'  var el=document.getElementById("img-"+id);\r\n'+
'  return el?el.src:"";\r\n'+
'}\r\n'+
'\r\n'+
'function toggleTodayMeeting(id){\r\n'+
'  if(todayOpenMeeting===id){\r\n'+
'    todayOpenMeeting="";\r\n'+
'  } else {\r\n'+
'    todayOpenMeeting=id;\r\n'+
'    rcOpenRace={};\r\n'+
'  }\r\n'+
'  renderTodayMeetingsList();\r\n'+
'}\r\n'+
'\r\n'+
'function todaySelectRace(mid,ri){\r\n'+
'  rcOpenRace[mid]=rcOpenRace[mid]===ri?null:ri;\r\n'+
'  renderTodayMeetingsList();\r\n'+
'  if(rcOpenRace[mid]!=null){\r\n'+
'    setTimeout(function(){\r\n'+
'      var el=document.getElementById("tdpills-"+mid);\r\n'+
'      if(el) el.scrollIntoView({behavior:"smooth",block:"nearest"});\r\n'+
'    },60);\r\n'+
'  }\r\n'+
'}\r\n'+
'\r\n'+
'function renderTodayMeetingsList(){\r\n'+
'  var el=document.getElementById("today-meetings-list");\r\n'+
'  if(!el) return;\r\n'+
'  var out="";\r\n'+
'  RC_MEETINGS.forEach(function(m){\r\n'+
'    var isOpen=todayOpenMeeting===m.id;\r\n'+
'    var imgSrc=getMeetingImg(m.id);\r\n'+
'    var firstT=m.races[0]?m.races[0].t:"";\r\n'+
'    var lastT=m.races[m.races.length-1]?m.races[m.races.length-1].t:"";\r\n'+
'    // Row\r\n'+
'    out+=\'<div style="border-bottom:1px solid #f0f2f7">\';\r\n'+
'    out+=\'<div onclick="toggleTodayMeeting(\\\'\'+m.id+\'\\\')" style="display:flex;align-items:center;gap:12px;padding:12px;cursor:pointer;background:#fff">\';\r\n'+
'    // Thumbnail with AI EDGE badge\r\n'+
'    out+=\'<div style="position:relative;flex-shrink:0;width:60px;height:60px;border-radius:8px;overflow:hidden;background:#0b1628">\';\r\n'+
'    if(imgSrc) out+=\'<img src="\'+imgSrc+\'" style="width:100%;height:100%;object-fit:cover">\';\r\n'+
'    out+=\'<div style="position:absolute;top:4px;left:4px;background:#0b1628;border:1.5px solid #c9a84c;border-radius:4px;padding:1px 5px;display:inline-flex;align-items:center;gap:3px">\';\r\n'+
'    out+=\'<div style="width:3px;height:3px;border-radius:50%;background:#1e9e6b;flex-shrink:0"></div>\';\r\n'+
'    out+=\'<span style="font-size:7px;font-weight:700;color:#fff;letter-spacing:0.08em">AI EDGE</span></div></div>\';\r\n'+
'    // Course info\r\n'+
'    out+=\'<div style="flex:1;min-width:0">\';\r\n'+
'    out+=\'<div style="font-size:15px;font-weight:700;color:#0b1628">\'+escHtml(m.name)+\'</div>\';\r\n'+
'    out+=\'<div style="font-size:11px;color:#9aa3b5;margin-top:2px">\'+escHtml(m.going)+\' &middot; \'+m.races.length+\' races &middot; \'+firstT+\'&ndash;\'+lastT+\'</div>\';\r\n'+
'    out+=\'</div>\';\r\n'+
'    // Plus/minus\r\n'+
'    out+=\'<div style="font-size:22px;font-weight:300;color:#1e9e6b;flex-shrink:0;width:28px;text-align:center;line-height:1">\'+( isOpen?"&minus;":"+" )+"</div>";\r\n'+
'    out+=\'</div>\';\r\n'+
'    // Expanded content\r\n'+
'    if(isOpen){\r\n'+
'      var hasRace=rcOpenRace[m.id]!=null;\r\n'+
'      var selRace=rcOpenRace[m.id];\r\n'+
'      out+=\'<div style="background:#fff">\';\r\n'+
'      // Analyse CTA\r\n'+
'      out+=\'<button class="fx-cta" style="margin:8px 12px 4px;width:calc(100% - 24px)"><span style="color:var(--gold)">&#x2756;</span> Analyse Full \'+escHtml(m.name)+\' Card with AI &rarr;</button>\';\r\n'+
'      // Going / feature pills\r\n'+
'      out+=\'<div style="display:flex;gap:6px;padding:8px 12px;flex-wrap:wrap">\';\r\n'+
'      out+=\'<span style="font-size:11px;font-weight:600;padding:3px 9px;border-radius:20px;background:#fff8e6;color:#a07010;border:1px solid #f0d87a">\'+escHtml(m.going)+\'</span>\';\r\n'+
'      if(m.feature) out+=\'<span style="font-size:11px;font-weight:600;padding:3px 9px;border-radius:20px;background:#f0faf6;color:#085041;border:1px solid #c8ead9">Feature Meeting</span>\';\r\n'+
'      out+=\'<span style="font-size:11px;font-weight:600;padding:3px 9px;border-radius:20px;background:#eef4ff;color:#1a4fa0;border:1px solid #c0d4f8">Next in \'+m.nextMins+\' mins</span>\';\r\n'+
'      out+=\'</div>\';\r\n'+
'      // Race time pills — sticky when a race is selected\r\n'+
'      var pillStyle=hasRace\r\n'+
'        ?"position:sticky;top:56px;z-index:10;background:#fff;border-bottom:1px solid #f0f2f7;"\r\n'+
'        :"border-top:1px solid #f0f2f7;";\r\n'+
'      out+=\'<div id="tdpills-\'+m.id+\'" style="\'+pillStyle+\'display:flex;gap:7px;overflow-x:auto;padding:8px 12px;scrollbar-width:none;-webkit-overflow-scrolling:touch">\';\r\n'+
'      m.races.forEach(function(race,ri){\r\n'+
'        var isSel=selRace===ri;\r\n'+
'        out+=\'<div style="flex-shrink:0;width:58px;border:1px solid \'+( isSel?"#0b1628":"#e4e8f0" )+\';border-radius:8px;padding:8px 4px;text-align:center;cursor:pointer;background:\'+( isSel?"#0b1628":"#f5f7fb" )+\'" onclick="todaySelectRace(\\\'\'+m.id+\'\\\',\'+ri+\')">\';\r\n'+
'        out+=\'<div style="font-size:12px;font-weight:600;color:\'+( isSel?"#fff":"#0b1628" )+\'">\'+escHtml(race.t)+\'</div>\';\r\n'+
'        out+=\'<div style="font-size:10px;color:\'+( isSel?"rgba(255,255,255,.55)":"#9aa3b5" )+\';margin-top:1px">\'+race.r+\' rnrs</div>\';\r\n'+
'        out+=\'</div>\';\r\n'+
'      });\r\n'+
'      out+=\'</div>\';\r\n'+
'      // Race detail (runners) when a time is selected\r\n'+
'      if(hasRace) out+=rcRaceDetailHtml(m);\r\n'+
'      out+=\'</div>\';\r\n'+
'    }\r\n'+
'    out+=\'</div>\';\r\n'+
'  });\r\n'+
'  el.innerHTML=out;\r\n'+
'}\r\n'+
'\r\n'+
'function rcPillsHtml(m){';

html=html.replace(insertBefore, newJs);
console.log('2. New vertical meetings list JS added');

// ════════════════════════════════════════════════════════════════════════
// 4. Call renderTodayMeetingsList() from showRacingHome
// ════════════════════════════════════════════════════════════════════════
const oldInit='  aiFeedInit();\r\n\r\n  renderNextRaceSection();';
const newInit='  aiFeedInit();\r\n\r\n  renderTodayMeetingsList();\r\n\r\n  renderNextRaceSection();';
if(!html.includes(oldInit)){console.error('FAIL: showRacingHome init anchor not found');process.exit(1);}
html=html.replace(oldInit,newInit);
console.log('3. renderTodayMeetingsList() called from showRacingHome');

// ── Syntax check ─────────────────────────────────────────────────────────────
const ss=html.lastIndexOf('<script>'),se=html.lastIndexOf('</script>');
try{new Function(html.slice(ss+8,se));console.log('Syntax: OK');}
catch(e){console.error('SYNTAX:',e.message);process.exit(1);}

fs.writeFileSync('C:/Users/Gary Coyne/acca-research/index.html',html,'utf8');
console.log('Saved');
