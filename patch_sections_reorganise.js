const fs=require('fs');
let html=fs.readFileSync('C:/Users/Gary Coyne/acca-research/index.html','utf8');

// ════════════════════════════════════════════════════════════════════════
// 1. Extract Next Race block from inside racing-today-content
//    and place it as a standalone hidden panel before /racing-home-content
// ════════════════════════════════════════════════════════════════════════
const nrBlockStart='\n    <!-- NEXT RACE -->';
const nrBlockEnd='\n    <!-- RACING PICKS -->';
const nrStartPos=html.indexOf(nrBlockStart);
const nrEndPos=html.indexOf(nrBlockEnd);
if(nrStartPos<0||nrEndPos<0){console.error('FAIL: Next Race block boundaries not found',nrStartPos,nrEndPos);process.exit(1);}

const nrHtml=html.slice(nrStartPos,nrEndPos); // the entire next-race block
// Remove it from Today content
html=html.slice(0,nrStartPos)+html.slice(nrEndPos);
console.log('1a. Next Race block removed from Today content');

// Place it as a standalone panel before /racing-home-content
const racingHomeEndAnchor='    </div><!-- /racing-home-content -->';
if(!html.includes(racingHomeEndAnchor)){console.error('FAIL: racing-home-content closing tag not found');process.exit(1);}

const nrPanel=
  '\n    <!-- NEXT RACE PANEL (section tab) -->\n'
 +'    <div id="section-nextrace-panel" style="display:none;padding:0 0 16px">\n'
 +nrHtml.replace(/^\n    /,'')+'\n'  // strip leading newline+indent
 +'    </div>\n';

html=html.replace(racingHomeEndAnchor, nrPanel+racingHomeEndAnchor);
console.log('1b. Next Race standalone panel created');

// ════════════════════════════════════════════════════════════════════════
// 2. Remove Winners pill from date pills bar
// ════════════════════════════════════════════════════════════════════════
const winnersBtn='<button id="pill-winners" onclick="selectRacingDate(\'winners\')" style="background:none;color:#b0b8c8;border:none;border-bottom:2px solid transparent;padding:10px 18px;font-size:13px;font-weight:600;cursor:pointer;font-family:inherit">Winners</button>';
if(!html.includes(winnersBtn)){console.error('FAIL: pill-winners button not found');process.exit(1);}
html=html.replace(winnersBtn,'');
console.log('2. Winners pill removed from date bar');

// ════════════════════════════════════════════════════════════════════════
// 3. Rewrite selectRacingSection to use the new panel-based structure
// ════════════════════════════════════════════════════════════════════════
const oldFnStart='function selectRacingSection(s){';
const oldFnEnd='\nfunction ';
const fnPos=html.indexOf(oldFnStart);
if(fnPos<0){console.error('FAIL: selectRacingSection not found');process.exit(1);}
const fnEndPos=html.indexOf(oldFnEnd,fnPos+10);
if(fnEndPos<0){console.error('FAIL: end of selectRacingSection not found');process.exit(1);}

const newFn=
'function selectRacingSection(s){\r\n'+
'  var datepills=document.getElementById("racing-datepills-bar");\r\n'+
'  var todayC=document.getElementById("racing-today-content");\r\n'+
'  var tmrwC=document.getElementById("racing-tomorrow-content");\r\n'+
'  var winnersC=document.getElementById("racing-winners-content");\r\n'+
'  var nrPanel=document.getElementById("section-nextrace-panel");\r\n'+
'  // Section nav button styles\r\n'+
'  var active="background:none;border:none;border-bottom:3px solid #c9a84c;color:#fff;padding:11px 18px;font-size:13px;font-weight:700;cursor:pointer;font-family:inherit;white-space:nowrap;flex-shrink:0";\r\n'+
'  var inactive="background:none;border:none;border-bottom:3px solid transparent;color:rgba(255,255,255,0.55);padding:11px 18px;font-size:13px;font-weight:700;cursor:pointer;font-family:inherit;white-space:nowrap;flex-shrink:0";\r\n'+
'  var bRC=document.getElementById("secnav-racecards");\r\n'+
'  var bNR=document.getElementById("secnav-nextrace");\r\n'+
'  var bWN=document.getElementById("secnav-winners");\r\n'+
'  var bPD=document.getElementById("secnav-pickofday");\r\n'+
'  if(bRC) bRC.style.cssText=s==="racecards"?active:inactive;\r\n'+
'  if(bNR) bNR.style.cssText=s==="nextrace"?active:inactive;\r\n'+
'  if(bWN) bWN.style.cssText=s==="winners"?active:inactive;\r\n'+
'  if(bPD) bPD.style.cssText=s==="pickofday"?active:inactive;\r\n'+
'  // Hide everything first\r\n'+
'  if(datepills) datepills.style.display="none";\r\n'+
'  if(todayC) todayC.style.display="none";\r\n'+
'  if(tmrwC) tmrwC.style.display="none";\r\n'+
'  if(winnersC) winnersC.style.display="none";\r\n'+
'  if(nrPanel) nrPanel.style.display="none";\r\n'+
'  if(s==="racecards"){\r\n'+
'    if(datepills) datepills.style.display="flex";\r\n'+
'    selectRacingDate("today");\r\n'+
'  } else if(s==="nextrace"){\r\n'+
'    if(nrPanel) nrPanel.style.display="";\r\n'+
'    renderNextRaceSection();\r\n'+
'  } else if(s==="winners"){\r\n'+
'    if(winnersC) winnersC.style.display="";\r\n'+
'  } else if(s==="pickofday"){\r\n'+
'    // Show Today content with only the picks section visible\r\n'+
'    if(todayC) todayC.style.display="";\r\n'+
'    // Hide meetings banner, AI feed; show only picks\r\n'+
'    var meetBanner=document.getElementById("today-meetings-list");\r\n'+
'    var aiFeed=document.getElementById("ai-feed-strip");\r\n'+
'    var picksDiv=document.querySelector(".main[style*=\'padding-top:12px\']");\r\n'+
'    if(meetBanner) meetBanner.style.display="none";\r\n'+
'    if(aiFeed) aiFeed.parentElement.style.display="none";\r\n'+
'  }\r\n'+
'}\r\n';

html=html.slice(0,fnPos)+newFn+html.slice(fnEndPos);
console.log('3. selectRacingSection rewritten');

// ════════════════════════════════════════════════════════════════════════
// 4. Update selectRacingSection('racecards') call to also restore
//    any Pick of the Day hidden elements when switching back
//    (add restore logic inside selectRacingDate)
//    Simpler fix: restore meetBanner and aiFeed display in 'racecards' path
// ════════════════════════════════════════════════════════════════════════
// Actually, let's fix the pickofday approach to be cleaner:
// Use a dedicated container div instead of hiding children
// Find the pickofday section in the new fn and improve it
const oldPickofday=
  '  } else if(s==="pickofday"){\r\n'+
  '    // Show Today content with only the picks section visible\r\n'+
  '    if(todayC) todayC.style.display="";\r\n'+
  '    // Hide meetings banner, AI feed; show only picks\r\n'+
  '    var meetBanner=document.getElementById("today-meetings-list");\r\n'+
  '    var aiFeed=document.getElementById("ai-feed-strip");\r\n'+
  '    var picksDiv=document.querySelector(".main[style*=\'padding-top:12px\']");\r\n'+
  '    if(meetBanner) meetBanner.style.display="none";\r\n'+
  '    if(aiFeed) aiFeed.parentElement.style.display="none";\r\n'+
  '  }\r\n';

const newPickofday=
  '  } else if(s==="pickofday"){\r\n'+
  '    if(todayC) todayC.style.display="";\r\n'+
  '    // Hide meeting banners and AI strip, show only picks section\r\n'+
  '    var meetImgWrap=document.querySelector("#racing-today-content .main");\r\n'+
  '    var tmlEl=document.getElementById("today-meetings-list");\r\n'+
  '    var aiFeedWrap=document.getElementById("ai-feed-strip");\r\n'+
  '    var e8f=document.querySelector("#racing-today-content div[style*=\'background:#e8f5ef\']");\r\n'+
  '    if(e8f) e8f.style.display="none";\r\n'+
  '    if(aiFeedWrap&&aiFeedWrap.parentElement) aiFeedWrap.parentElement.style.display="none";\r\n'+
  '  }\r\n';

if(!html.includes(oldPickofday)){console.error('FAIL: pickofday block not found for update');process.exit(1);}
html=html.replace(oldPickofday,newPickofday);

// Also add restore of hidden elements when racecards is selected
const rcRestoreOld=
  '  if(s==="racecards"){\r\n'+
  '    if(datepills) datepills.style.display="flex";\r\n'+
  '    selectRacingDate("today");\r\n'+
  '  }';
const rcRestoreNew=
  '  if(s==="racecards"){\r\n'+
  '    if(datepills) datepills.style.display="flex";\r\n'+
  '    // Restore any elements hidden by pickofday\r\n'+
  '    var e8f=document.querySelector("#racing-today-content div[style*=\'background:#e8f5ef\']");\r\n'+
  '    var aiFeedWrap=document.getElementById("ai-feed-strip");\r\n'+
  '    if(e8f) e8f.style.display="";\r\n'+
  '    if(aiFeedWrap&&aiFeedWrap.parentElement) aiFeedWrap.parentElement.style.display="";\r\n'+
  '    selectRacingDate("today");\r\n'+
  '  }';
if(!html.includes(rcRestoreOld)){console.error('FAIL: racecards restore block not found');process.exit(1);}
html=html.replace(rcRestoreOld,rcRestoreNew);
console.log('4. Pick of the Day and Racecards restore logic improved');

// ════════════════════════════════════════════════════════════════════════
// 5. Remove winners handling from selectRacingDate pill styling
//    (pill-winners no longer exists, just remove the pw reference)
// ════════════════════════════════════════════════════════════════════════
const oldPwLines=
  '  var pw=document.getElementById("pill-winners");\r\n';
if(html.includes(oldPwLines)){
  html=html.replace(oldPwLines,'');
  // Also remove the pw style line and winners display line
  html=html.replace('  if(pw) pw.style.cssText=d==="winners"?pillActive:pillInactive;\r\n','');
  html=html.replace('  if(winners) winners.style.display=d==="winners"?"":"none";\r\n','');
  console.log('5. selectRacingDate cleaned of winners references');
} else {
  console.log('5. selectRacingDate winners refs (LF variant) — trying LF');
  html=html.replace('  var pw=document.getElementById("pill-winners");\n','');
  html=html.replace('  if(pw) pw.style.cssText=d==="winners"?pillActive:pillInactive;\n','');
  html=html.replace('  if(winners) winners.style.display=d==="winners"?"":"none";\n','');
  console.log('5. selectRacingDate cleaned (LF)');
}

// ── Syntax check ─────────────────────────────────────────────────────────────
const ss=html.lastIndexOf('<script>'),se=html.lastIndexOf('</script>');
try{new Function(html.slice(ss+8,se));console.log('Syntax: OK');}
catch(e){console.error('SYNTAX:',e.message);process.exit(1);}

fs.writeFileSync('C:/Users/Gary Coyne/acca-research/index.html',html,'utf8');
console.log('Saved');
