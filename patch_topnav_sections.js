const fs=require('fs');
let html=fs.readFileSync('C:/Users/Gary Coyne/acca-research/index.html','utf8');

// ════════════════════════════════════════════════════════════════════════
// 1. Insert new section nav bar above the DATE PILLS bar
// ════════════════════════════════════════════════════════════════════════
const datePillsAnchor='    <!-- DATE PILLS -->';
if(!html.includes(datePillsAnchor)){console.error('FAIL: DATE PILLS anchor not found');process.exit(1);}

const sectionNav=
  '    <!-- SECTION NAV -->\r\n'
 +'    <div id="racing-section-nav" style="background:#0b1628;display:flex;gap:0;overflow-x:auto;scrollbar-width:none;-webkit-overflow-scrolling:touch;border-bottom:1px solid #1a2a45">\r\n'
 +'      <button id="secnav-racecards" onclick="selectRacingSection(\'racecards\')" style="background:none;border:none;border-bottom:3px solid #c9a84c;color:#fff;padding:11px 18px;font-size:13px;font-weight:700;cursor:pointer;font-family:inherit;white-space:nowrap;flex-shrink:0">Racecards</button>\r\n'
 +'      <button id="secnav-nextrace" onclick="selectRacingSection(\'nextrace\')" style="background:none;border:none;border-bottom:3px solid transparent;color:rgba(255,255,255,0.55);padding:11px 18px;font-size:13px;font-weight:700;cursor:pointer;font-family:inherit;white-space:nowrap;flex-shrink:0">Next Race</button>\r\n'
 +'      <button id="secnav-winners" onclick="selectRacingSection(\'winners\')" style="background:none;border:none;border-bottom:3px solid transparent;color:rgba(255,255,255,0.55);padding:11px 18px;font-size:13px;font-weight:700;cursor:pointer;font-family:inherit;white-space:nowrap;flex-shrink:0">Winners</button>\r\n'
 +'      <button id="secnav-pickofday" onclick="selectRacingSection(\'pickofday\')" style="background:none;border:none;border-bottom:3px solid transparent;color:rgba(255,255,255,0.55);padding:11px 18px;font-size:13px;font-weight:700;cursor:pointer;font-family:inherit;white-space:nowrap;flex-shrink:0">Pick of the Day</button>\r\n'
 +'    </div>\r\n'
 +'    <!-- DATE PILLS -->';

html=html.replace(datePillsAnchor, sectionNav);
console.log('1. Section nav bar inserted');

// ════════════════════════════════════════════════════════════════════════
// 2. Wrap date pills + racing content in a "racecards-panel" div
//    so we can show/hide the whole thing as one unit.
//    The date pill bar starts at "    <div style="background:#fff;border-bottom:..."
//    We'll add an id to that wrapper div.
// ════════════════════════════════════════════════════════════════════════

// Wrap the date pills div with an id wrapper
const oldDatePillDiv='    <div style="background:#fff;border-bottom:1px solid #e4e8f0;display:flex;gap:0;align-items:center">';
if(!html.includes(oldDatePillDiv)){console.error('FAIL: date pill div not found');process.exit(1);}
html=html.replace(oldDatePillDiv,'    <div id="racing-datepills-bar" style="background:#fff;border-bottom:1px solid #e4e8f0;display:flex;gap:0;align-items:center">');
console.log('2. Date pills div given id');

// ════════════════════════════════════════════════════════════════════════
// 3. Add selectRacingSection() JS function
//    Insert after selectRacingDate function end
// ════════════════════════════════════════════════════════════════════════
const insertAfter='function selectRacingDate(d){';
const fnPos=html.indexOf(insertAfter);
if(fnPos<0){console.error('FAIL: selectRacingDate not found');process.exit(1);}

// Find the end of selectRacingDate (next function declaration after it)
const nextFnPos=html.indexOf('\nfunction ',fnPos+1);
if(nextFnPos<0){console.error('FAIL: next function after selectRacingDate not found');process.exit(1);}

const newSectionFn=
'\r\n'+
'function selectRacingSection(s){\r\n'+
'  var datepills=document.getElementById("racing-datepills-bar");\r\n'+
'  var todayC=document.getElementById("racing-today-content");\r\n'+
'  var tmrwC=document.getElementById("racing-tomorrow-content");\r\n'+
'  var winnersC=document.getElementById("racing-winners-content");\r\n'+
'  var picksC=document.getElementById("racing-picks-container");\r\n'+
'  var nrSection=document.getElementById("next-race-section");\r\n'+
'  // Section nav buttons\r\n'+
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
'  if(s==="racecards"){\r\n'+
'    if(datepills) datepills.style.display="flex";\r\n'+
'    if(todayC) todayC.style.display="";\r\n'+
'    if(tmrwC) tmrwC.style.display="none";\r\n'+
'    if(winnersC) winnersC.style.display="none";\r\n'+
'    // picks and next race stay inside today content — no change needed\r\n'+
'    selectRacingDate("today");\r\n'+
'  } else if(s==="nextrace"){\r\n'+
'    if(datepills) datepills.style.display="none";\r\n'+
'    if(todayC) todayC.style.display="none";\r\n'+
'    if(tmrwC) tmrwC.style.display="none";\r\n'+
'    if(winnersC) winnersC.style.display="none";\r\n'+
'    // Show a standalone next race wrapper\r\n'+
'    var nrWrap=document.getElementById("section-nextrace-wrap");\r\n'+
'    if(!nrWrap){\r\n'+
'      nrWrap=document.createElement("div");\r\n'+
'      nrWrap.id="section-nextrace-wrap";\r\n'+
'      nrWrap.style.cssText="padding:0 0 16px";\r\n'+
'      if(nrSection&&nrSection.parentNode){\r\n'+
'        nrSection.parentNode.insertBefore(nrWrap,nrSection);\r\n'+
'      }\r\n'+
'    }\r\n'+
'    nrWrap.style.display="";\r\n'+
'    if(nrSection) nrSection.style.display="";\r\n'+
'  } else if(s==="winners"){\r\n'+
'    if(datepills) datepills.style.display="none";\r\n'+
'    if(todayC) todayC.style.display="none";\r\n'+
'    if(tmrwC) tmrwC.style.display="none";\r\n'+
'    if(winnersC) winnersC.style.display="";\r\n'+
'  } else if(s==="pickofday"){\r\n'+
'    if(datepills) datepills.style.display="none";\r\n'+
'    if(todayC) todayC.style.display="none";\r\n'+
'    if(tmrwC) tmrwC.style.display="none";\r\n'+
'    if(winnersC) winnersC.style.display="none";\r\n'+
'    // Show a standalone picks wrapper\r\n'+
'    var picksWrap=document.getElementById("section-picks-wrap");\r\n'+
'    if(!picksWrap){\r\n'+
'      picksWrap=document.createElement("div");\r\n'+
'      picksWrap.id="section-picks-wrap";\r\n'+
'      picksWrap.style.cssText="padding:16px 0";\r\n'+
'      if(picksC&&picksC.parentNode){\r\n'+
'        picksC.parentNode.insertBefore(picksWrap,picksC);\r\n'+
'      }\r\n'+
'    }\r\n'+
'    picksWrap.style.display="";\r\n'+
'    if(picksC) picksC.style.display="flex";\r\n'+
'  }\r\n'+
'}\r\n';

html=html.slice(0,nextFnPos)+newSectionFn+html.slice(nextFnPos);
console.log('3. selectRacingSection() function added');

// ════════════════════════════════════════════════════════════════════════
// 4. Call selectRacingSection('racecards') from showRacingHome
//    so it initialises to Racecards on load
// ════════════════════════════════════════════════════════════════════════
// Use indexOf to find position of renderNextRaceSection() call in showRacingHome
const nrAnchor='  renderNextRaceSection();';
const nrPos=html.indexOf(nrAnchor);
if(nrPos<0){console.error('FAIL: renderNextRaceSection anchor not found');process.exit(1);}
// Insert selectRacingSection call just before renderNextRaceSection
html=html.slice(0,nrPos)+'  selectRacingSection(\'racecards\');\r\n\r\n'+html.slice(nrPos);
console.log('4. selectRacingSection called from showRacingHome');

// ── Syntax check ─────────────────────────────────────────────────────────────
const ss=html.lastIndexOf('<script>'),se=html.lastIndexOf('</script>');
try{new Function(html.slice(ss+8,se));console.log('Syntax: OK');}
catch(e){console.error('SYNTAX:',e.message);process.exit(1);}

fs.writeFileSync('C:/Users/Gary Coyne/acca-research/index.html',html,'utf8');
console.log('Saved');
