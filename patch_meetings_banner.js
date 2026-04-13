const fs=require('fs');
let html=fs.readFileSync('C:/Users/Gary Coyne/acca-research/index.html','utf8');

// Find the function by its start/end markers
const fnStart=html.indexOf('function renderTodayMeetingsList(){');
const fnEnd=html.indexOf('\nfunction rcPillsHtml(m){');
if(fnStart<0||fnEnd<0){console.error('FAIL: function boundaries not found');process.exit(1);}

// Verify we found the right section
console.log('Function found, length:',(fnEnd-fnStart));

const newFn=
'function renderTodayMeetingsList(){\r\n'+
'  var el=document.getElementById("today-meetings-list");\r\n'+
'  if(!el) return;\r\n'+
'  var out="";\r\n'+
'  RC_MEETINGS.forEach(function(m){\r\n'+
'    var isOpen=todayOpenMeeting===m.id;\r\n'+
'    var imgSrc=getMeetingImg(m.id);\r\n'+
'    var firstT=m.races[0]?m.races[0].t:"";\r\n'+
'    var lastT=m.races[m.races.length-1]?m.races[m.races.length-1].t:"";\r\n'+
'    var hasRace=rcOpenRace[m.id]!=null;\r\n'+
'    var selRace=rcOpenRace[m.id];\r\n'+
'    // Full-width banner card\r\n'+
'    out+=\'<div style="margin:0 12px 10px;border-radius:12px;overflow:hidden;box-shadow:0 2px 8px rgba(11,22,40,0.12)">\';\r\n'+
'    // Image banner — tappable\r\n'+
'    out+=\'<div onclick="toggleTodayMeeting(\\\'\'+m.id+\'\\\')" style="position:relative;height:130px;background:#0b1628;overflow:hidden;cursor:pointer">\';\r\n'+
'    if(imgSrc) out+=\'<img src="\'+imgSrc+\'" style="width:100%;height:100%;object-fit:cover;display:block">\';\r\n'+
'    out+=\'<div style="position:absolute;inset:0;background:linear-gradient(180deg,rgba(11,22,40,0.06) 0%,rgba(11,22,40,0.80) 100%)"></div>\';\r\n'+
'    // AI EDGE badge top-left\r\n'+
'    out+=\'<div style="position:absolute;top:10px;left:10px;background:#0b1628;border:1.5px solid #c9a84c;border-radius:4px;padding:2px 7px;display:inline-flex;align-items:center;gap:3px">\';\r\n'+
'    out+=\'<div style="width:4px;height:4px;border-radius:50%;background:#1e9e6b;flex-shrink:0"></div>\';\r\n'+
'    out+=\'<span style="font-size:8px;font-weight:700;color:#fff;letter-spacing:0.08em">AI EDGE</span></div>\';\r\n'+
'    // +/- circle top-right\r\n'+
'    out+=\'<div style="position:absolute;top:8px;right:10px;width:28px;height:28px;border-radius:50%;background:rgba(255,255,255,0.2);border:1.5px solid rgba(255,255,255,0.5);display:flex;align-items:center;justify-content:center">\';\r\n'+
'    out+=\'<span style="font-size:18px;line-height:1;color:#fff;font-weight:300">\'+(isOpen?"&minus;":"+")+\'</span></div>\';\r\n'+
'    // Venue name + meta bottom-left\r\n'+
'    out+=\'<div style="position:absolute;bottom:0;left:0;right:0;padding:10px 12px 12px">\';\r\n'+
'    out+=\'<div style="font-size:22px;font-weight:700;color:#fff;line-height:1;letter-spacing:-0.3px">\'+escHtml(m.name)+\'</div>\';\r\n'+
'    out+=\'<div style="margin-top:5px;display:flex;align-items:center;gap:8px">\';\r\n'+
'    out+=\'<span style="font-size:10px;font-weight:600;color:rgba(255,255,255,0.82)">\'+m.races.length+\' races &middot; \'+firstT+\'&ndash;\'+lastT+\'</span>\';\r\n'+
'    if(m.feature) out+=\'<span style="font-size:9px;font-weight:700;background:#1e9e6b;color:#fff;padding:2px 7px;border-radius:99px;letter-spacing:.04em">FEATURE</span>\';\r\n'+
'    out+=\'</div></div>\';\r\n'+
'    out+=\'</div>\';\r\n'+
'    // Expanded white panel below banner\r\n'+
'    if(isOpen){\r\n'+
'      out+=\'<div style="background:#fff;border-top:1px solid #e4e8f0">\';\r\n'+
'      out+=\'<button class="fx-cta" style="margin:10px 12px 4px;width:calc(100% - 24px)"><span style="color:var(--gold)">&#x2756;</span> Analyse Full \'+escHtml(m.name)+\' Card with AI &rarr;</button>\';\r\n'+
'      out+=\'<div style="display:flex;gap:6px;padding:6px 12px 8px;flex-wrap:wrap">\';\r\n'+
'      out+=\'<span style="font-size:11px;font-weight:600;padding:3px 9px;border-radius:20px;background:#fff8e6;color:#a07010;border:1px solid #f0d87a">\'+escHtml(m.going)+\'</span>\';\r\n'+
'      out+=\'<span style="font-size:11px;font-weight:600;padding:3px 9px;border-radius:20px;background:#eef4ff;color:#1a4fa0;border:1px solid #c0d4f8">Next in \'+m.nextMins+\' mins</span>\';\r\n'+
'      out+=\'</div>\';\r\n'+
'      var pillStyle=hasRace\r\n'+
'        ?"position:sticky;top:56px;z-index:10;background:#fff;border-bottom:1px solid #f0f2f7;"\r\n'+
'        :"border-top:1px solid #f0f2f7;";\r\n'+
'      out+=\'<div id="tdpills-\'+m.id+\'" style="\'+pillStyle+\'display:flex;gap:7px;overflow-x:auto;padding:8px 12px;scrollbar-width:none;-webkit-overflow-scrolling:touch">\';\r\n'+
'      m.races.forEach(function(race,ri){\r\n'+
'        var isSel=selRace===ri;\r\n'+
'        out+=\'<div style="flex-shrink:0;width:58px;border:1px solid \'+(isSel?"#0b1628":"#e4e8f0")+\';border-radius:8px;padding:8px 4px;text-align:center;cursor:pointer;background:\'+(isSel?"#0b1628":"#f5f7fb")+\'" onclick="todaySelectRace(\\\'\'+m.id+\'\\\',\'+ri+\')">\';\r\n'+
'        out+=\'<div style="font-size:12px;font-weight:600;color:\'+(isSel?"#fff":"#0b1628")+\'">\'+escHtml(race.t)+\'</div>\';\r\n'+
'        out+=\'<div style="font-size:10px;color:\'+(isSel?"rgba(255,255,255,.55)":"#9aa3b5")+\';margin-top:1px">\'+race.r+\' rnrs</div>\';\r\n'+
'        out+=\'</div>\';\r\n'+
'      });\r\n'+
'      out+=\'</div>\';\r\n'+
'      if(hasRace) out+=rcRaceDetailHtml(m);\r\n'+
'      out+=\'</div>\';\r\n'+
'    }\r\n'+
'    out+=\'</div>\';\r\n'+
'  });\r\n'+
'  el.innerHTML=out;\r\n'+
'}';

html=html.slice(0,fnStart)+newFn+html.slice(fnEnd);
console.log('Banner card render function replaced');

// Syntax check
const ss=html.lastIndexOf('<script>'),se=html.lastIndexOf('</script>');
try{new Function(html.slice(ss+8,se));console.log('Syntax: OK');}
catch(e){console.error('SYNTAX:',e.message);process.exit(1);}

fs.writeFileSync('C:/Users/Gary Coyne/acca-research/index.html',html,'utf8');
console.log('Saved');
