const fs=require('fs');
let html=fs.readFileSync('C:/Users/Gary Coyne/acca-research/index.html','utf8');

// ════════════════════════════════════════════════════════════════════════
// 1. Move NAP & NB block back from winners-content to today-content
// ════════════════════════════════════════════════════════════════════════

// Extract the RACING PICKS block from inside racing-winners-content
const picksStart='\r\n\r\n    <!-- RACING PICKS -->';
const picksEnd='\r\n\r\n  <!-- TOMORROW WINNERS -->';
const si=html.indexOf(picksStart);
const ei=html.indexOf(picksEnd);
if(si<0||ei<0){console.error('FAIL: RACING PICKS bounds in winners-content not found si='+si+' ei='+ei);process.exit(1);}
const picksBlock=html.slice(si,ei);
// Remove from winners-content
html=html.slice(0,si)+html.slice(ei);
console.log('1a. Extracted RACING PICKS from winners-content');

// Insert it back into today-content, just before <!-- NEXT RACE -->
const nextRaceAnchor='\r\n\r\n    <!-- NEXT RACE -->';
if(!html.includes(nextRaceAnchor)){console.error('FAIL: NEXT RACE anchor not found');process.exit(1);}
html=html.replace(nextRaceAnchor, picksBlock+nextRaceAnchor);
console.log('1b. RACING PICKS restored to today-content before Next Race');

// ════════════════════════════════════════════════════════════════════════
// 2. Fix NAP "Add to My Slip" button — add onclick
// ════════════════════════════════════════════════════════════════════════
const oldNapBtn=
  "'<button style=\"width:100%;background:#0b1628;color:#fff;border:none;border-radius:99px;padding:12px;font-size:13px;font-weight:600;cursor:pointer;font-family:inherit\">+ Add to My Slip</button>'";
const newNapBtn=
  "'<button onclick=\"nrAddToSlip(\\''+escHtml(p.horse)+'\\',\\''+escHtml(p.odds)+'\\')\" style=\"width:100%;background:#0b1628;color:#fff;border:none;border-radius:99px;padding:12px;font-size:13px;font-weight:600;cursor:pointer;font-family:inherit\">+ Add to My Slip</button>'";
if(!html.includes(oldNapBtn)){console.error('FAIL: NAP button not found');process.exit(1);}
html=html.replace(oldNapBtn,newNapBtn);
console.log('2. NAP Add to My Slip button wired up');

// ════════════════════════════════════════════════════════════════════════
// 3. Add hamburger menu button to the pill/tab bar header
//    + sliding menu drawer with Login and Sign Up
// ════════════════════════════════════════════════════════════════════════

// 3a. Add menu button to the right side of the date pills bar
const oldPillBar=
  '<div style="background:#fff;border-bottom:1px solid #e4e8f0;display:flex;gap:0">';
const newPillBar=
  '<div style="background:#fff;border-bottom:1px solid #e4e8f0;display:flex;gap:0;align-items:center">';
if(!html.includes(oldPillBar)){console.error('FAIL: pill bar div not found');process.exit(1);}
html=html.replace(oldPillBar,newPillBar);

// Add the hamburger button after the Winners pill
const oldWinnersPill=
  '<button id="pill-winners" onclick="selectRacingDate(\'winners\')" style="background:none;color:#b0b8c8;border:none;border-bottom:2px solid transparent;padding:10px 18px;font-size:13px;font-weight:600;cursor:pointer;font-family:inherit">Winners</button>\r\n    </div>';
const newWinnersPill=
  '<button id="pill-winners" onclick="selectRacingDate(\'winners\')" style="background:none;color:#b0b8c8;border:none;border-bottom:2px solid transparent;padding:10px 18px;font-size:13px;font-weight:600;cursor:pointer;font-family:inherit">Winners</button>'
  +'<div style="margin-left:auto;padding:0 12px;flex-shrink:0">'
    +'<button onclick="openRacingMenu()" style="background:none;border:none;cursor:pointer;padding:6px;display:flex;flex-direction:column;gap:5px;align-items:center;justify-content:center">'
      +'<span style="display:block;width:20px;height:2px;background:#0b1628;border-radius:2px"></span>'
      +'<span style="display:block;width:20px;height:2px;background:#0b1628;border-radius:2px"></span>'
      +'<span style="display:block;width:20px;height:2px;background:#0b1628;border-radius:2px"></span>'
    +'</button>'
  +'</div>'
  +'\r\n    </div>';
if(!html.includes(oldWinnersPill)){console.error('FAIL: Winners pill closing not found');process.exit(1);}
html=html.replace(oldWinnersPill,newWinnersPill);
console.log('3a. Hamburger button added to pill bar');

// 3b. Add the slide-in menu overlay + drawer before </body>
const oldBody='</body>';
const menuHtml=
  '\r\n\r\n<!-- RACING MENU DRAWER -->\r\n'
  +'<div id="racing-menu-overlay" onclick="closeRacingMenu()" style="display:none;position:fixed;inset:0;background:rgba(0,0,0,0.4);z-index:600"></div>\r\n'
  +'<div id="racing-menu-drawer" style="position:fixed;top:0;right:0;bottom:0;width:260px;background:#fff;z-index:601;transform:translateX(100%);transition:transform 0.3s ease;display:flex;flex-direction:column">\r\n'
    +'<div style="background:#0b1628;padding:20px 16px 16px;display:flex;align-items:center;justify-content:space-between">\r\n'
      +'<div style="font-family:Outfit,sans-serif;font-size:20px;font-weight:700"><span style="color:#fff">Accu</span><span style="color:#c9a84c">Edge</span></div>\r\n'
      +'<button onclick="closeRacingMenu()" style="background:none;border:none;color:#fff;font-size:22px;cursor:pointer;padding:4px;line-height:1">&times;</button>\r\n'
    +'</div>\r\n'
    +'<div style="flex:1;padding:16px;display:flex;flex-direction:column;gap:8px">\r\n'
      +'<button onclick="closeRacingMenu()" style="width:100%;background:#0b1628;color:#fff;border:none;border-radius:10px;padding:14px 16px;font-size:15px;font-weight:600;cursor:pointer;font-family:inherit;text-align:left">Log In</button>\r\n'
      +'<button onclick="closeRacingMenu()" style="width:100%;background:#1e9e6b;color:#fff;border:none;border-radius:10px;padding:14px 16px;font-size:15px;font-weight:600;cursor:pointer;font-family:inherit;text-align:left">Sign Up — Free</button>\r\n'
      +'<div style="height:1px;background:#e4e8f0;margin:8px 0"></div>\r\n'
      +'<button onclick="closeRacingMenu()" style="width:100%;background:none;color:#0b1628;border:none;padding:12px 16px;font-size:14px;font-weight:500;cursor:pointer;font-family:inherit;text-align:left">My Selections</button>\r\n'
      +'<button onclick="closeRacingMenu()" style="width:100%;background:none;color:#0b1628;border:none;padding:12px 16px;font-size:14px;font-weight:500;cursor:pointer;font-family:inherit;text-align:left">Settings</button>\r\n'
      +'<button onclick="closeRacingMenu()" style="width:100%;background:none;color:#0b1628;border:none;padding:12px 16px;font-size:14px;font-weight:500;cursor:pointer;font-family:inherit;text-align:left">Responsible Gambling</button>\r\n'
    +'</div>\r\n'
    +'<div style="padding:16px;border-top:1px solid #e4e8f0;font-size:10px;color:#b0b8c8;text-align:center">18+ · Gamble Responsibly</div>\r\n'
  +'</div>\r\n';

html=html.replace(oldBody, menuHtml+oldBody);
console.log('3b. Menu drawer HTML inserted');

// 3c. Add JS functions for menu open/close before </script>
const menuJS=
  "\r\nfunction openRacingMenu(){\r\n"+
  "  var ov=document.getElementById('racing-menu-overlay');\r\n"+
  "  var dr=document.getElementById('racing-menu-drawer');\r\n"+
  "  if(ov) ov.style.display='block';\r\n"+
  "  if(dr) dr.style.transform='translateX(0)';\r\n"+
  "}\r\n"+
  "function closeRacingMenu(){\r\n"+
  "  var ov=document.getElementById('racing-menu-overlay');\r\n"+
  "  var dr=document.getElementById('racing-menu-drawer');\r\n"+
  "  if(ov) ov.style.display='none';\r\n"+
  "  if(dr) dr.style.transform='translateX(100%)';\r\n"+
  "}\r\n";

const scriptEnd=html.lastIndexOf('</script>');
html=html.slice(0,scriptEnd)+menuJS+html.slice(scriptEnd);
console.log('3c. Menu JS functions added');

// ── Syntax check ─────────────────────────────────────────────────────────────
const ss=html.lastIndexOf('<script>'),se=html.lastIndexOf('</script>');
try{new Function(html.slice(ss+8,se));console.log('Syntax: OK');}
catch(e){console.error('SYNTAX:',e.message);process.exit(1);}

fs.writeFileSync('C:/Users/Gary Coyne/acca-research/index.html',html,'utf8');
console.log('Saved');
