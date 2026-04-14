const fs=require('fs');
let html=fs.readFileSync('C:/Users/Gary Coyne/acca-research/index.html','utf8');

// ════════════════════════════════════════════════════════════════════════
// 1. Add nrViewMeetingCard() helper — scroll to meetings + open card
// ════════════════════════════════════════════════════════════════════════
const insertBefore='\nfunction renderRacingPicks(){';
if(html.indexOf(insertBefore)<0){console.error('FAIL: insert point not found');process.exit(1);}

const helperFn=
'\nfunction nrViewMeetingCard(courseId,courseName){\n'
+'  selectRacingSection(\'racecards\');\n'
+'  selectRacingDate(\'today\');\n'
+'  if(todayOpenMeeting!==courseId) toggleTodayMeeting(courseId);\n'
+'  setTimeout(function(){\n'
+'    var el=document.getElementById(\'racing-today-meetings\');\n'
+'    if(el){\n'
+'      var top=el.getBoundingClientRect().top+window.pageYOffset-56;\n'
+'      window.scrollTo({top:top,behavior:\'smooth\'});\n'
+'    }\n'
+'  },80);\n'
+'}\n';

html=html.replace(insertBefore, helperFn+insertBefore);
console.log('1. nrViewMeetingCard helper added');

// ════════════════════════════════════════════════════════════════════════
// 2. Rewrite renderRacingPicks() with view-card link footer
// ════════════════════════════════════════════════════════════════════════
const fnStart=html.indexOf('\nfunction renderRacingPicks(){');
const fnEnd=html.indexOf('\nfunction renderRacingWinners(){');
if(fnStart<0||fnEnd<0){console.error('FAIL: fn bounds');process.exit(1);}

const newFn=[
'\nfunction renderRacingPicks(){\n\n',
'  var el=document.getElementById(\'racing-picks-container\');\n\n',
'  if(!el) return;\n\n',
'  el.innerHTML=RACING_PICKS.map(function(p,i){\n\n',

// Derive course name + meeting ID from detail field e.g. "13:15 Cork · 2m7f Maiden Hurdle"
'    var detailFirst=(p.detail.split(\' \xb7 \')[0]||p.detail).trim();\n',
'    var courseName=detailFirst.split(\' \').slice(1).join(\' \')||\'\';\n',
'    var courseId=courseName.toLowerCase();\n\n',

// Tag badge colours
'    var isNap=p.type.indexOf(\'NAP\')>=0;\n',
'    var tagBg=isNap?\'#fef9e7\':\'#f0faf5\';\n',
'    var tagBorder=isNap?\'1px solid #c9a84c\':\'1px solid #1e9e6b\';\n',
'    var tagColor=isNap?\'#7a5800\':\'#065f46\';\n\n',

// Research HTML — bolded tags + plain text
'    var researchHtml=p.signals.map(function(s){\n',
'      return \'<strong style="font-weight:700;color:#0a5c38;font-size:10.5px;letter-spacing:.05em">\'+escHtml(s.tag)+\'</strong> \'+escHtml(s.text);\n',
'    }).join(\'<span style="color:#6dbf96"> &middot; </span>\');\n\n',

// ── Card wrapper ─────────────────────────────────────────────────────────
'    return \'<div style="background:#fff;border-radius:12px;border:1px solid #e8eaed;overflow:hidden">\'\n\n',

// Top row: tag badge | horse + detail || odds + E/W
'      +\'<div style="padding:12px 14px 7px;display:flex;align-items:flex-start;justify-content:space-between;gap:12px">\'\n',
'        +\'<div style="flex:1;min-width:0">\'\n',
'          +\'<div style="display:inline-flex;align-items:center;margin-bottom:6px;border-radius:5px;padding:3px 9px;font-size:10px;font-weight:700;letter-spacing:.05em;background:\'+tagBg+\';border:\'+tagBorder+\';color:\'+tagColor+\'">\'+escHtml(p.type)+\'</div>\'\n',
'          +\'<div style="font-size:20px;font-weight:800;color:#0b1628;line-height:1.1;margin-bottom:4px">\'+escHtml(p.horse)+\'</div>\'\n',
'          +\'<div style="font-size:11px;color:#9aa3b5;line-height:1.4">\'+escHtml(p.detail)+\'</div>\'\n',
'        +\'</div>\'\n',
'        +\'<div style="text-align:right;flex-shrink:0">\'\n',
'          +\'<div style="font-size:22px;font-weight:800;color:#1e9e6b;line-height:1">\'+escHtml(p.odds)+\'</div>\'\n',
'          +\'<div style="font-size:11px;color:#9aa3b5;margin-top:3px">E/W</div>\'\n',
'        +\'</div>\'\n',
'      +\'</div>\'\n\n',

// Hairline divider
'      +\'<div style="height:1px;background:#f3f4f6;margin:0 14px"></div>\'\n\n',

// AI EDGE badge + insight text
'      +\'<div style="padding:7px 14px 10px">\'\n',
'        +\'<div style="display:inline-flex;align-items:center;gap:4px;margin-bottom:8px;background:#0b1628;border:1.5px solid #c9a84c;border-radius:5px;padding:3px 8px">\'\n',
'          +\'<div style="width:5px;height:5px;border-radius:50%;background:#1e9e6b;flex-shrink:0"></div>\'\n',
'          +\'<span style="font-size:9px;font-weight:700;letter-spacing:0.1em;color:#fff">AI EDGE</span>\'\n',
'        +\'</div>\'\n',
'        +\'<div style="font-size:12px;color:#1a6b4a;line-height:1.55;font-weight:450">\'+researchHtml+\'</div>\'\n',
'      +\'</div>\'\n\n',

// Footer: view-card link + Add to My Slip button
'      +\'<div style="padding:0 14px 13px">\'\n',
'        +(courseName ? \'<div onclick="nrViewMeetingCard(\\\'\'+courseId+\'\\\',\\\'\'+escHtml(courseName)+\'\\\')" style="font-size:12px;color:#1e9e6b;font-weight:500;cursor:pointer;margin-bottom:10px;letter-spacing:.01em">\u2192 View full \'+escHtml(courseName)+\' card</div>\' : \'\')\n',
'        +\'<button onclick="nrAddToSlip(\\\'\'+escHtml(p.horse)+\'\\\',\\\'\'+escHtml(p.odds)+\'\\\')" style="width:100%;background:#0b1628;color:#fff;border:none;border-radius:99px;padding:12px;font-size:13px;font-weight:600;cursor:pointer;font-family:inherit">+ Add to My Slip</button>\'\n',
'      +\'</div>\'\n\n',

'    +\'</div>\';\n\n',
'  }).join(\'\');\n\n',
'}\n'
].join('');

try{new Function(newFn);}catch(e){console.error('FN SYNTAX:',e.message);process.exit(1);}
html=html.slice(0,fnStart)+newFn+html.slice(fnEnd);
console.log('2. renderRacingPicks rewritten with view-card link');

// ── Global syntax check ───────────────────────────────────────────────────
const ss=html.lastIndexOf('<script>'),se=html.lastIndexOf('</script>');
try{new Function(html.slice(ss+8,se));console.log('Syntax: OK');}
catch(e){console.error('GLOBAL SYNTAX:',e.message);process.exit(1);}

fs.writeFileSync('C:/Users/Gary Coyne/acca-research/index.html',html,'utf8');
console.log('Saved');
