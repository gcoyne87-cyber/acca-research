const fs=require('fs');
let html=fs.readFileSync('C:/Users/Gary Coyne/acca-research/index.html','utf8');

// ════════════════════════════════════════════════════════════════════════
// 1. Section nav: font 12px → 13px (primary nav, bigger than sub-bar)
// ════════════════════════════════════════════════════════════════════════
// Update HTML buttons
html=html.replace(
  /(<button id="secnav-[^"]+")[^>]*style="([^"]*?)font-size:12px([^"]*?)"/g,
  function(match,id,pre,post){return id+' onclick="'+match.match(/onclick="([^"]+)"/)[1]+'" style="'+pre+'font-size:13px'+post+'"';}
);
// Simpler approach — replace the two known style strings in HTML
const oldActiveHtml='border-bottom:2px solid #c9a84c;color:#0b1628;padding:10px 16px;font-size:12px;font-weight:600;cursor:pointer;font-family:inherit;white-space:nowrap;flex-shrink:0;letter-spacing:.01em';
const newActiveHtml='border-bottom:2px solid #c9a84c;color:#0b1628;padding:10px 16px;font-size:13px;font-weight:600;cursor:pointer;font-family:inherit;white-space:nowrap;flex-shrink:0;letter-spacing:.01em';
const oldInactiveHtml='border-bottom:2px solid transparent;color:#9aa3b5;padding:10px 16px;font-size:12px;font-weight:500;cursor:pointer;font-family:inherit;white-space:nowrap;flex-shrink:0;letter-spacing:.01em';
const newInactiveHtml='border-bottom:2px solid transparent;color:#9aa3b5;padding:10px 16px;font-size:13px;font-weight:500;cursor:pointer;font-family:inherit;white-space:nowrap;flex-shrink:0;letter-spacing:.01em';

if(!html.includes(oldActiveHtml)){console.error('FAIL: active html style not found');process.exit(1);}
if(!html.includes(oldInactiveHtml)){console.error('FAIL: inactive html style not found');process.exit(1);}
html=html.replace(new RegExp(oldActiveHtml.replace(/[.*+?^${}()|[\]\\]/g,'\\$&'),'g'), newActiveHtml);
html=html.replace(new RegExp(oldInactiveHtml.replace(/[.*+?^${}()|[\]\\]/g,'\\$&'),'g'), newInactiveHtml);

// Also update in JS selectRacingSection
// Update font-size:12px → 13px inside selectRacingSection only (use indexOf to avoid false matches)
const srsFnPos=html.indexOf('function selectRacingSection(s){');
const srsFnEnd=html.indexOf('\nfunction ',srsFnPos+10);
const srsFn=html.slice(srsFnPos,srsFnEnd);
const srsFnFixed=srsFn.replace(/font-size:12px/g,'font-size:13px');
html=html.slice(0,srsFnPos)+srsFnFixed+html.slice(srsFnEnd);
console.log('1. Section nav bumped to 13px');

// ════════════════════════════════════════════════════════════════════════
// 2. Date pills: shrink to 11px, lighter weight — clearly sub-bar
//    Add a tiny dot span inside each pill for the active indicator
// ════════════════════════════════════════════════════════════════════════
const oldPillToday='<button id="pill-today" onclick="selectRacingDate(\'today\')" style="background:none;color:#0b1628;border:none;border-bottom:2px solid #1e9e6b;padding:10px 18px;font-size:13px;font-weight:600;cursor:pointer;font-family:inherit">Today</button>';
const newPillToday='<button id="pill-today" onclick="selectRacingDate(\'today\')" style="background:none;color:#0b1628;border:none;border-bottom:2px solid #1e9e6b;padding:8px 14px;font-size:11px;font-weight:600;cursor:pointer;font-family:inherit;display:inline-flex;align-items:center;gap:5px"><span id="pdot-today" style="width:5px;height:5px;border-radius:50%;background:#1e9e6b;flex-shrink:0;display:inline-block"></span>Today</button>';

const oldPillTmrw='<button id="pill-tomorrow" onclick="selectRacingDate(\'tomorrow\')" style="background:none;color:#b0b8c8;border:none;border-bottom:2px solid transparent;padding:10px 18px;font-size:13px;font-weight:600;cursor:pointer;font-family:inherit">Tomorrow</button>';
const newPillTmrw='<button id="pill-tomorrow" onclick="selectRacingDate(\'tomorrow\')" style="background:none;color:#b0b8c8;border:none;border-bottom:2px solid transparent;padding:8px 14px;font-size:11px;font-weight:500;cursor:pointer;font-family:inherit;display:inline-flex;align-items:center;gap:5px"><span id="pdot-tomorrow" style="width:5px;height:5px;border-radius:50%;background:#1e9e6b;flex-shrink:0;display:none"></span>Tomorrow</button>';

const oldPillUp='<button id="pill-upcoming" onclick="selectRacingDate(\'upcoming\')" style="background:none;color:#b0b8c8;border:none;border-bottom:2px solid transparent;padding:10px 18px;font-size:13px;font-weight:600;cursor:pointer;font-family:inherit">Upcoming</button>';
const newPillUp='<button id="pill-upcoming" onclick="selectRacingDate(\'upcoming\')" style="background:none;color:#b0b8c8;border:none;border-bottom:2px solid transparent;padding:8px 14px;font-size:11px;font-weight:500;cursor:pointer;font-family:inherit;display:inline-flex;align-items:center;gap:5px"><span id="pdot-upcoming" style="width:5px;height:5px;border-radius:50%;background:#1e9e6b;flex-shrink:0;display:none"></span>Upcoming</button>';

if(!html.includes(oldPillToday)){console.error('FAIL: pill-today not found');process.exit(1);}
if(!html.includes(oldPillTmrw)){console.error('FAIL: pill-tomorrow not found');process.exit(1);}
if(!html.includes(oldPillUp)){console.error('FAIL: pill-upcoming not found');process.exit(1);}
html=html.replace(oldPillToday,newPillToday);
html=html.replace(oldPillTmrw,newPillTmrw);
html=html.replace(oldPillUp,newPillUp);
console.log('2. Date pills shrunk to 11px with dot spans added');

// ════════════════════════════════════════════════════════════════════════
// 3. Update selectRacingDate pill styles + dot visibility
// ════════════════════════════════════════════════════════════════════════
const oldPillActive='"background:none;color:#0b1628;border:none;border-bottom:2px solid #1e9e6b;padding:10px 18px;font-size:13px;font-weight:600;cursor:pointer;font-family:inherit"';
const newPillActive='"background:none;color:#0b1628;border:none;border-bottom:2px solid #1e9e6b;padding:8px 14px;font-size:11px;font-weight:600;cursor:pointer;font-family:inherit;display:inline-flex;align-items:center;gap:5px"';
const oldPillInactive='"background:none;color:#b0b8c8;border:none;border-bottom:2px solid transparent;padding:10px 18px;font-size:13px;font-weight:600;cursor:pointer;font-family:inherit"';
const newPillInactive='"background:none;color:#b0b8c8;border:none;border-bottom:2px solid transparent;padding:8px 14px;font-size:11px;font-weight:500;cursor:pointer;font-family:inherit;display:inline-flex;align-items:center;gap:5px"';

if(!html.includes(oldPillActive)){console.error('FAIL: pillActive JS style not found');process.exit(1);}
if(!html.includes(oldPillInactive)){console.error('FAIL: pillInactive JS style not found');process.exit(1);}
html=html.replace(oldPillActive,newPillActive);
html=html.replace(oldPillInactive,newPillInactive);

// Add dot toggle after the pill style lines
// Find the lines that set cssText for pills and add dot logic after them
const oldDotBlock=
  '  if(pt) pt.style.cssText=d==="today"?pillActive:pillInactive;\n'+
  '  if(pm) pm.style.cssText=d==="tomorrow"?pillActive:pillInactive;\n'+
  '  if(pu) pu.style.cssText=d==="upcoming"?pillActive:pillInactive;\n';
const newDotBlock=
  '  if(pt) pt.style.cssText=d==="today"?pillActive:pillInactive;\n'+
  '  if(pm) pm.style.cssText=d==="tomorrow"?pillActive:pillInactive;\n'+
  '  if(pu) pu.style.cssText=d==="upcoming"?pillActive:pillInactive;\n'+
  '  // Active dot indicator\n'+
  '  var dtToday=document.getElementById("pdot-today");\n'+
  '  var dtTmrw=document.getElementById("pdot-tomorrow");\n'+
  '  var dtUp=document.getElementById("pdot-upcoming");\n'+
  '  if(dtToday) dtToday.style.display=d==="today"?"inline-block":"none";\n'+
  '  if(dtTmrw) dtTmrw.style.display=d==="tomorrow"?"inline-block":"none";\n'+
  '  if(dtUp) dtUp.style.display=d==="upcoming"?"inline-block":"none";\n';

if(!html.includes(oldDotBlock)){
  // try CRLF
  const oldDotBlockCR=oldDotBlock.replace(/\n/g,'\r\n');
  const newDotBlockCR=newDotBlock.replace(/\n/g,'\r\n');
  if(!html.includes(oldDotBlockCR)){console.error('FAIL: dot block anchor not found');process.exit(1);}
  html=html.replace(oldDotBlockCR,newDotBlockCR);
} else {
  html=html.replace(oldDotBlock,newDotBlock);
}
console.log('3. Dot toggle logic added to selectRacingDate');

// ── Syntax check ─────────────────────────────────────────────────────────────
const ss=html.lastIndexOf('<script>'),se=html.lastIndexOf('</script>');
try{new Function(html.slice(ss+8,se));console.log('Syntax: OK');}
catch(e){console.error('SYNTAX:',e.message);process.exit(1);}

fs.writeFileSync('C:/Users/Gary Coyne/acca-research/index.html',html,'utf8');
console.log('Saved');
