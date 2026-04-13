const fs=require('fs');
let html=fs.readFileSync('C:/Users/Gary Coyne/acca-research/index.html','utf8');

// ── 1. Add "Winners" pill to tab bar ─────────────────────────────────────────
const oldPills=
  '<button id="pill-upcoming" onclick="selectRacingDate(\'upcoming\')" style="background:none;color:#b0b8c8;border:none;border-bottom:2px solid transparent;padding:10px 18px;font-size:13px;font-weight:600;cursor:pointer;font-family:inherit">Upcoming</button>';
const newPills=
  '<button id="pill-upcoming" onclick="selectRacingDate(\'upcoming\')" style="background:none;color:#b0b8c8;border:none;border-bottom:2px solid transparent;padding:10px 18px;font-size:13px;font-weight:600;cursor:pointer;font-family:inherit">Upcoming</button>'
  +'<button id="pill-winners" onclick="selectRacingDate(\'winners\')" style="background:none;color:#b0b8c8;border:none;border-bottom:2px solid transparent;padding:10px 18px;font-size:13px;font-weight:600;cursor:pointer;font-family:inherit">Winners</button>';
if(!html.includes(oldPills)){console.error('FAIL: Upcoming pill not found');process.exit(1);}
html=html.replace(oldPills,newPills);
console.log('1. Winners pill added to tab bar');

// ── 2. Extract today winners+picks block (will move to winners tab) ───────────
const todayWinnersStart='\r\n\r\n    <!-- RACING WINNERS -->';
const todayWinnersEnd='\r\n\r\n    <!-- NEXT RACE -->';
const si=html.indexOf(todayWinnersStart);
const ei=html.indexOf(todayWinnersEnd);
if(si<0||ei<0){console.error('FAIL: today winners bounds not found');process.exit(1);}
const todayWinnersHtml=html.slice(si,ei);
// Remove from today-content
html=html.slice(0,si)+html.slice(ei);
console.log('2. Today winners+picks removed from today-content');

// ── 3. Extract tomorrow winners+nap block (will move to winners tab) ──────────
// Starts at <!-- TOMORROW WINNERS --> and ends at the closing </div> of racing-tomorrow-content
// The NAP section closes with: </div>\r\n\r\n    </div>\r\n\r\n  </div>\r\n\r\n</div>
// We'll replace the block with just the closing divs needed to close tomorrow-content
const tmWinnersStart='\r\n\r\n  <!-- TOMORROW WINNERS -->';
const tmWinnersEnd='\r\n\r\n  </div>\r\n\r\n</div><!-- /main -->';
const ti=html.indexOf(tmWinnersStart);
const te=html.indexOf(tmWinnersEnd);
if(ti<0||te<0){console.error('FAIL: tomorrow winners bounds not found; ti='+ti+' te='+te);process.exit(1);}
const tomorrowWinnersHtml=html.slice(ti,te); // save for winners tab
// Replace with just the closing structure
html=html.slice(0,ti)+html.slice(te);
console.log('3. Tomorrow winners+nap removed from tomorrow-content');

// ── 4. Insert racing-winners-content div before </div><!-- /main --> ──────────
const mainClose='\r\n\r\n</div><!-- /main -->';
const mainCloseIdx=html.indexOf(mainClose);
if(mainCloseIdx<0){console.error('FAIL: </div><!-- /main --> not found');process.exit(1);}

const winnersTabHtml=
  '\r\n\r\n  <div id="racing-winners-content" style="display:none;padding:0">'
  +todayWinnersHtml
  +tomorrowWinnersHtml
  +'\r\n\r\n  </div>';

html=html.slice(0,mainCloseIdx)+winnersTabHtml+html.slice(mainCloseIdx);
console.log('4. racing-winners-content div inserted with combined content');

// ── 5. Update selectRacingDate to handle winners tab ─────────────────────────
const oldSelectFn=
  "function selectRacingDate(d){\r\n"+
  "  var today=document.getElementById(\"racing-today-content\");\r\n"+
  "  var tmrw=document.getElementById(\"racing-tomorrow-content\");\r\n"+
  "  var pt=document.getElementById(\"pill-today\");\r\n"+
  "  var pm=document.getElementById(\"pill-tomorrow\");\r\n"+
  "  var pu=document.getElementById(\"pill-upcoming\");\r\n"+
  "  var lbl=document.querySelector(\"#ai-feed-strip span[data-feed-label]\");\r\n"+
  "  var dot=document.querySelector(\"#ai-feed-strip span[data-feed-live]\");\r\n"+
  "  var pillActive=\"background:none;color:#0b1628;border:none;border-bottom:2px solid #1e9e6b;padding:10px 18px;font-size:13px;font-weight:600;cursor:pointer;font-family:inherit\";\r\n"+
  "  var pillInactive=\"background:none;color:#b0b8c8;border:none;border-bottom:2px solid transparent;padding:10px 18px;font-size:13px;font-weight:600;cursor:pointer;font-family:inherit\";\r\n"+
  "  if(pt) pt.style.cssText=d===\"today\"?pillActive:pillInactive;\r\n"+
  "  if(pm) pm.style.cssText=d===\"tomorrow\"?pillActive:pillInactive;\r\n"+
  "  if(pu) pu.style.cssText=d===\"upcoming\"?pillActive:pillInactive;\r\n"+
  "  if(today) today.style.display=d===\"today\"?\"\":\"none\";\r\n"+
  "  if(tmrw) tmrw.style.display=d===\"tomorrow\"?\"\":\"none\";";

const newSelectFn=
  "function selectRacingDate(d){\r\n"+
  "  var today=document.getElementById(\"racing-today-content\");\r\n"+
  "  var tmrw=document.getElementById(\"racing-tomorrow-content\");\r\n"+
  "  var winners=document.getElementById(\"racing-winners-content\");\r\n"+
  "  var pt=document.getElementById(\"pill-today\");\r\n"+
  "  var pm=document.getElementById(\"pill-tomorrow\");\r\n"+
  "  var pu=document.getElementById(\"pill-upcoming\");\r\n"+
  "  var pw=document.getElementById(\"pill-winners\");\r\n"+
  "  var lbl=document.querySelector(\"#ai-feed-strip span[data-feed-label]\");\r\n"+
  "  var dot=document.querySelector(\"#ai-feed-strip span[data-feed-live]\");\r\n"+
  "  var pillActive=\"background:none;color:#0b1628;border:none;border-bottom:2px solid #1e9e6b;padding:10px 18px;font-size:13px;font-weight:600;cursor:pointer;font-family:inherit\";\r\n"+
  "  var pillInactive=\"background:none;color:#b0b8c8;border:none;border-bottom:2px solid transparent;padding:10px 18px;font-size:13px;font-weight:600;cursor:pointer;font-family:inherit\";\r\n"+
  "  if(pt) pt.style.cssText=d===\"today\"?pillActive:pillInactive;\r\n"+
  "  if(pm) pm.style.cssText=d===\"tomorrow\"?pillActive:pillInactive;\r\n"+
  "  if(pu) pu.style.cssText=d===\"upcoming\"?pillActive:pillInactive;\r\n"+
  "  if(pw) pw.style.cssText=d===\"winners\"?pillActive:pillInactive;\r\n"+
  "  if(today) today.style.display=d===\"today\"?\"\":\"none\";\r\n"+
  "  if(tmrw) tmrw.style.display=d===\"tomorrow\"?\"\":\"none\";\r\n"+
  "  if(winners) winners.style.display=d===\"winners\"?\"\":\"none\";";

if(!html.includes(oldSelectFn)){console.error('FAIL: selectRacingDate not found');process.exit(1);}
html=html.replace(oldSelectFn,newSelectFn);
console.log('5. selectRacingDate updated for winners tab');

// ── Syntax check ─────────────────────────────────────────────────────────────
const ss=html.lastIndexOf('<script>'),se=html.lastIndexOf('</script>');
try{new Function(html.slice(ss+8,se));console.log('Syntax: OK');}
catch(e){console.error('SYNTAX:',e.message);process.exit(1);}

fs.writeFileSync('C:/Users/Gary Coyne/acca-research/index.html',html,'utf8');
console.log('Saved');
