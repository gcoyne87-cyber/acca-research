const fs=require('fs');
let html=fs.readFileSync('C:/Users/Gary Coyne/acca-research/index.html','utf8');

// ════════════════════════════════════════════════════════════════════════
// 1. Restyle the section nav HTML — white bg, subtle, minimal
// ════════════════════════════════════════════════════════════════════════
const oldNav=
  '<div id="racing-section-nav" style="background:#0b1628;display:flex;gap:0;overflow-x:auto;scrollbar-width:none;-webkit-overflow-scrolling:touch;border-bottom:1px solid #1a2a45">\r\n'
 +'      <button id="secnav-racecards" onclick="selectRacingSection(\'racecards\')" style="background:none;border:none;border-bottom:3px solid #c9a84c;color:#fff;padding:11px 18px;font-size:13px;font-weight:700;cursor:pointer;font-family:inherit;white-space:nowrap;flex-shrink:0">Racecards</button>\r\n'
 +'      <button id="secnav-nextrace" onclick="selectRacingSection(\'nextrace\')" style="background:none;border:none;border-bottom:3px solid transparent;color:rgba(255,255,255,0.55);padding:11px 18px;font-size:13px;font-weight:700;cursor:pointer;font-family:inherit;white-space:nowrap;flex-shrink:0">Next Race</button>\r\n'
 +'      <button id="secnav-winners" onclick="selectRacingSection(\'winners\')" style="background:none;border:none;border-bottom:3px solid transparent;color:rgba(255,255,255,0.55);padding:11px 18px;font-size:13px;font-weight:700;cursor:pointer;font-family:inherit;white-space:nowrap;flex-shrink:0">Winners</button>\r\n'
 +'      <button id="secnav-pickofday" onclick="selectRacingSection(\'pickofday\')" style="background:none;border:none;border-bottom:3px solid transparent;color:rgba(255,255,255,0.55);padding:11px 18px;font-size:13px;font-weight:700;cursor:pointer;font-family:inherit;white-space:nowrap;flex-shrink:0">Pick of the Day</button>\r\n'
 +'    </div>';

if(!html.includes(oldNav)){
  // try LF
  const oldNavLF=
    '<div id="racing-section-nav" style="background:#0b1628;display:flex;gap:0;overflow-x:auto;scrollbar-width:none;-webkit-overflow-scrolling:touch;border-bottom:1px solid #1a2a45">\n'
   +'      <button id="secnav-racecards" onclick="selectRacingSection(\'racecards\')" style="background:none;border:none;border-bottom:3px solid #c9a84c;color:#fff;padding:11px 18px;font-size:13px;font-weight:700;cursor:pointer;font-family:inherit;white-space:nowrap;flex-shrink:0">Racecards</button>\n'
   +'      <button id="secnav-nextrace" onclick="selectRacingSection(\'nextrace\')" style="background:none;border:none;border-bottom:3px solid transparent;color:rgba(255,255,255,0.55);padding:11px 18px;font-size:13px;font-weight:700;cursor:pointer;font-family:inherit;white-space:nowrap;flex-shrink:0">Next Race</button>\n'
   +'      <button id="secnav-winners" onclick="selectRacingSection(\'winners\')" style="background:none;border:none;border-bottom:3px solid transparent;color:rgba(255,255,255,0.55);padding:11px 18px;font-size:13px;font-weight:700;cursor:pointer;font-family:inherit;white-space:nowrap;flex-shrink:0">Winners</button>\n'
   +'      <button id="secnav-pickofday" onclick="selectRacingSection(\'pickofday\')" style="background:none;border:none;border-bottom:3px solid transparent;color:rgba(255,255,255,0.55);padding:11px 18px;font-size:13px;font-weight:700;cursor:pointer;font-family:inherit;white-space:nowrap;flex-shrink:0">Pick of the Day</button>\n'
   +'    </div>';
  if(!html.includes(oldNavLF)){console.error('FAIL: section nav not found');process.exit(1);}
  html=html.replace(oldNavLF, buildNewNav());
} else {
  html=html.replace(oldNav, buildNewNav());
}

function buildNewNav(){
  // White bg, hairline bottom border, tabs use small text + thin gold underline for active
  // inactive: medium gray, no underline — clean and airy
  var activeStyle='background:none;border:none;border-bottom:2px solid #c9a84c;color:#0b1628;padding:10px 16px;font-size:12px;font-weight:600;cursor:pointer;font-family:inherit;white-space:nowrap;flex-shrink:0;letter-spacing:.01em';
  var inactiveStyle='background:none;border:none;border-bottom:2px solid transparent;color:#9aa3b5;padding:10px 16px;font-size:12px;font-weight:500;cursor:pointer;font-family:inherit;white-space:nowrap;flex-shrink:0;letter-spacing:.01em';
  return '<div id="racing-section-nav" style="background:#fff;display:flex;gap:0;overflow-x:auto;scrollbar-width:none;-webkit-overflow-scrolling:touch;border-bottom:1px solid #e4e8f0">\n'
   +'      <button id="secnav-racecards" onclick="selectRacingSection(\'racecards\')" style="'+activeStyle+'">Racecards</button>\n'
   +'      <button id="secnav-nextrace" onclick="selectRacingSection(\'nextrace\')" style="'+inactiveStyle+'">Next Race</button>\n'
   +'      <button id="secnav-winners" onclick="selectRacingSection(\'winners\')" style="'+inactiveStyle+'">Winners</button>\n'
   +'      <button id="secnav-pickofday" onclick="selectRacingSection(\'pickofday\')" style="'+inactiveStyle+'">Pick of the Day</button>\n'
   +'    </div>';
}

console.log('1. Section nav restyled to white, minimal');

// ════════════════════════════════════════════════════════════════════════
// 2. Update selectRacingSection JS — active/inactive styles to match
// ════════════════════════════════════════════════════════════════════════
const oldActive='"background:none;border:none;border-bottom:3px solid #c9a84c;color:#fff;padding:11px 18px;font-size:13px;font-weight:700;cursor:pointer;font-family:inherit;white-space:nowrap;flex-shrink:0"';
const oldInactive='"background:none;border:none;border-bottom:3px solid transparent;color:rgba(255,255,255,0.55);padding:11px 18px;font-size:13px;font-weight:700;cursor:pointer;font-family:inherit;white-space:nowrap;flex-shrink:0"';

const newActive='"background:none;border:none;border-bottom:2px solid #c9a84c;color:#0b1628;padding:10px 16px;font-size:12px;font-weight:600;cursor:pointer;font-family:inherit;white-space:nowrap;flex-shrink:0;letter-spacing:.01em"';
const newInactive='"background:none;border:none;border-bottom:2px solid transparent;color:#9aa3b5;padding:10px 16px;font-size:12px;font-weight:500;cursor:pointer;font-family:inherit;white-space:nowrap;flex-shrink:0;letter-spacing:.01em"';

if(!html.includes(oldActive)||!html.includes(oldInactive)){
  console.error('FAIL: JS active/inactive styles not found');process.exit(1);
}
html=html.replace(oldActive, newActive);
html=html.replace(oldInactive, newInactive);
console.log('2. JS active/inactive button styles updated');

// ── Syntax check ─────────────────────────────────────────────────────────────
const ss=html.lastIndexOf('<script>'),se=html.lastIndexOf('</script>');
try{new Function(html.slice(ss+8,se));console.log('Syntax: OK');}
catch(e){console.error('SYNTAX:',e.message);process.exit(1);}

fs.writeFileSync('C:/Users/Gary Coyne/acca-research/index.html',html,'utf8');
console.log('Saved');
