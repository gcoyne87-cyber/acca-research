const fs=require('fs');
let html=fs.readFileSync('C:/Users/Gary Coyne/acca-research/index.html','utf8');

// ════════════════════════════════════════════════════════════════════════
// 1. Hide main-topnav when racing section is shown
//    (stops the duplicate hamburger from appearing)
// ════════════════════════════════════════════════════════════════════════
const oldShowRacing=
  "  if(rh) rh.style.display='';\r\n\r\n  renderRacingWinners();";
const newShowRacing=
  "  if(rh) rh.style.display='';\r\n"+
  "  var tn=document.getElementById('main-topnav');\r\n"+
  "  if(tn) tn.style.display='none';\r\n\r\n  renderRacingWinners();";
if(!html.includes(oldShowRacing)){console.error('FAIL: showRacingHome body not found');process.exit(1);}
html=html.replace(oldShowRacing,newShowRacing);
console.log('1. main-topnav hidden in showRacingHome');

// ════════════════════════════════════════════════════════════════════════
// 2. Simplify menu drawer — remove My Selections / Settings / Responsible
// ════════════════════════════════════════════════════════════════════════
// Use split/indexOf to find and remove the extra menu items
const dividerAndExtras=
  '\r\n<div style="height:1px;background:#e4e8f0;margin:8px 0"></div>\r\n'
  +'<button onclick="closeRacingMenu()" style="width:100%;background:none;color:#0b1628;border:none;padding:12px 16px;font-size:14px;font-weight:500;cursor:pointer;font-family:inherit;text-align:left">My Selections</button>\r\n'
  +'<button onclick="closeRacingMenu()" style="width:100%;background:none;color:#0b1628;border:none;padding:12px 16px;font-size:14px;font-weight:500;cursor:pointer;font-family:inherit;text-align:left">Settings</button>\r\n'
  +'<button onclick="closeRacingMenu()" style="width:100%;background:none;color:#0b1628;border:none;padding:12px 16px;font-size:14px;font-weight:500;cursor:pointer;font-family:inherit;text-align:left">Responsible Gambling</button>';
if(!html.includes(dividerAndExtras)){console.error('FAIL: extra menu items not found');process.exit(1);}
html=html.replace(dividerAndExtras,'');
console.log('2. Menu simplified to Login + Sign Up only');

// ════════════════════════════════════════════════════════════════════════
// 3. Move TOMORROW NAP from winners-content back to tomorrow-content
// ════════════════════════════════════════════════════════════════════════
// Extract from winners-content
const tnapStart='\r\n\r\n  <!-- TOMORROW NAP -->';
const tnapEnd='\r\n\r\n  </div>\r\n\r\n  <div id="racing-winners-content"';
const tsi=html.indexOf(tnapStart);
const tei=html.indexOf(tnapEnd);
if(tsi<0||tei<0){console.error('FAIL: TOMORROW NAP bounds not found; tsi='+tsi+' tei='+tei);process.exit(1);}
const tnapBlock=html.slice(tsi,tei);
// Remove from winners area, keep the closing structure
html=html.slice(0,tsi)+html.slice(tei);
console.log('3a. TOMORROW NAP extracted from winners-content');

// Re-insert into tomorrow-content — just before its closing div (before racing-winners-content)
const tmInsertAnchor='\r\n\r\n  </div>\r\n\r\n  <div id="racing-winners-content"';
if(!html.includes(tmInsertAnchor)){console.error('FAIL: tomorrow closing anchor not found');process.exit(1);}
html=html.replace(tmInsertAnchor, tnapBlock+tmInsertAnchor);
console.log('3b. TOMORROW NAP restored to tomorrow-content');

// ════════════════════════════════════════════════════════════════════════
// 4. Fix NAP bullet text — scale to 11px / line-height 1.4 / gap 5px
// ════════════════════════════════════════════════════════════════════════
const oldBullet=
  'display:flex;align-items:baseline;gap:6px;font-size:12px;color:#555;line-height:1.5"><span style="color:#1e9e6b;font-weight:700;flex-shrink:0">✓</span><span>\''+'+escHtml(r)+\'</span></div>\';';
const newBullet=
  'display:flex;align-items:baseline;gap:4px;font-size:10px;color:#555;line-height:1.4"><span style="color:#1e9e6b;font-weight:700;flex-shrink:0;font-size:10px">✓</span><span>\''+'+escHtml(r)+\'</span></div>\';';
if(!html.includes(oldBullet)){
  // try without the join line
  const altOld='gap:6px;font-size:12px;color:#555;line-height:1.5';
  const altNew='gap:4px;font-size:10px;color:#555;line-height:1.4';
  const count=(html.split(altOld).length-1);
  console.log('fallback: occurrences of old bullet style:',count);
  if(count===0){console.error('FAIL: bullet style not found');process.exit(1);}
  html=html.split(altOld).join(altNew);
  // Also fix the checkmark size in the same context
  html=html.split('color:#1e9e6b;font-weight:700;flex-shrink:0">✓</span>').join('color:#1e9e6b;font-weight:700;flex-shrink:0;font-size:10px">✓</span>');
  console.log('4. Bullet scaled to 10px (fallback)');
} else {
  html=html.replace(oldBullet,newBullet);
  console.log('4. Bullet scaled to 10px');
}

// ── Syntax check ─────────────────────────────────────────────────────────────
const ss=html.lastIndexOf('<script>'),se=html.lastIndexOf('</script>');
try{new Function(html.slice(ss+8,se));console.log('Syntax: OK');}
catch(e){console.error('SYNTAX:',e.message);process.exit(1);}

fs.writeFileSync('C:/Users/Gary Coyne/acca-research/index.html',html,'utf8');
console.log('Saved');
