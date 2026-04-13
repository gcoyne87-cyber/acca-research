const fs=require('fs');
let html=fs.readFileSync('C:/Users/Gary Coyne/acca-research/index.html','utf8');

// ════════════════════════════════════════════════════════════════════════
// 1. Add AccuEdge logo header bar above the pill bar
//    (hamburger moves to header; remove it from pill bar)
// ════════════════════════════════════════════════════════════════════════

// Target the pill bar line — add a header row before it
const oldPillBar=
  '    <!-- DATE PILLS -->\r\n\r\n'
  +'    <div style="background:#fff;border-bottom:1px solid #e4e8f0;display:flex;gap:0;align-items:center">';

if(!html.includes(oldPillBar)){console.error('FAIL: DATE PILLS anchor not found');process.exit(1);}

const headerBar=
  '    <!-- RACING HEADER -->\r\n'
  +'    <div style="background:#0b1628;padding:12px 16px;display:flex;align-items:center;justify-content:space-between">\r\n'
  +'      <div style="font-family:Outfit,sans-serif;font-size:20px;font-weight:700"><span style="color:#fff">Accu</span><span style="color:#c9a84c">Edge</span></div>\r\n'
  +'      <button onclick="openRacingMenu()" style="background:none;border:none;cursor:pointer;padding:6px;display:flex;flex-direction:column;gap:5px;align-items:center;justify-content:center">'
  +'<span style="display:block;width:20px;height:2px;background:#fff;border-radius:2px"></span>'
  +'<span style="display:block;width:20px;height:2px;background:#fff;border-radius:2px"></span>'
  +'<span style="display:block;width:20px;height:2px;background:#fff;border-radius:2px"></span>'
  +'</button>\r\n'
  +'    </div>\r\n'
  +'    <!-- DATE PILLS -->\r\n\r\n'
  +'    <div style="background:#fff;border-bottom:1px solid #e4e8f0;display:flex;gap:0;align-items:center">';

html=html.replace(oldPillBar, headerBar);
console.log('1. AccuEdge logo header bar added');

// Remove the hamburger button from the pill bar (it's now in the header)
const oldHamburgerInPill=
  '<div style="margin-left:auto;padding:0 12px;flex-shrink:0">'
  +'<button onclick="openRacingMenu()" style="background:none;border:none;cursor:pointer;padding:6px;display:flex;flex-direction:column;gap:5px;align-items:center;justify-content:center">'
  +'<span style="display:block;width:20px;height:2px;background:#0b1628;border-radius:2px"></span>'
  +'<span style="display:block;width:20px;height:2px;background:#0b1628;border-radius:2px"></span>'
  +'<span style="display:block;width:20px;height:2px;background:#0b1628;border-radius:2px"></span>'
  +'</button></div>';

if(!html.includes(oldHamburgerInPill)){
  console.log('Note: hamburger not found in pill bar (may already be removed) — skipping');
} else {
  html=html.replace(oldHamburgerInPill,'');
  console.log('1b. Hamburger removed from pill bar (now in header)');
}

// ════════════════════════════════════════════════════════════════════════
// 2. Fix nrAddToSlip — push directly to slipLegs system
// ════════════════════════════════════════════════════════════════════════
const oldAddToSlip=
  'function nrAddToSlip(name,price){\r\n'
  +'  if(typeof addToSlip==="function"){addToSlip(name,price);return;}\r\n'
  +'  var toast=document.createElement("div");\r\n'
  +'  toast.textContent=name+" ("+price+") added to slip";\r\n'
  +'  toast.style.cssText="position:fixed;bottom:80px;left:50%;transform:translateX(-50%);background:#0b1628;color:#fff;padding:10px 18px;border-radius:20px;font-size:13px;font-weight:600;z-index:9999;pointer-events:none;transition:opacity .3s";\r\n'
  +'  document.body.appendChild(toast);\r\n'
  +'  setTimeout(function(){toast.style.opacity="0";setTimeout(function(){toast.remove();},300);},1800);\r\n'
  +'}';

if(!html.includes(oldAddToSlip)){console.error('FAIL: nrAddToSlip body not found');process.exit(1);}

const newAddToSlip=
  'function nrAddToSlip(name,price){\r\n'
  +'  var legId=\'nr_\'+name.replace(/\\s+/g,\'_\');\r\n'
  +'  var already=slipLegs.some(function(s){return s.legId===legId;});\r\n'
  +'  if(already){\r\n'
  +'    slipLegs=slipLegs.filter(function(s){return s.legId!==legId;});\r\n'
  +'    renderSlip();\r\n'
  +'    return;\r\n'
  +'  }\r\n'
  +'  var parts=(price||\'EVS\').split(\'/\');\r\n'
  +'  var num=parseInt(parts[0])||1,den=parseInt(parts[1])||1;\r\n'
  +'  slipLegs.push({legId:legId,team:name,match:\'Horse Racing\',odds:price||\'EVS\',num:num,den:den});\r\n'
  +'  renderSlip();\r\n'
  +'  if(slipLegs.length===1&&!slipOpen) toggleSlip();\r\n'
  +'}';

html=html.replace(oldAddToSlip, newAddToSlip);
console.log('2. nrAddToSlip fixed to use slipLegs system');

// ── Syntax check ─────────────────────────────────────────────────────────────
const ss=html.lastIndexOf('<script>'),se=html.lastIndexOf('</script>');
try{new Function(html.slice(ss+8,se));console.log('Syntax: OK');}
catch(e){console.error('SYNTAX:',e.message);process.exit(1);}

fs.writeFileSync('C:/Users/Gary Coyne/acca-research/index.html',html,'utf8');
console.log('Saved');
