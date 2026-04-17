const fs=require('fs');
let html=fs.readFileSync('C:/Users/Gary Coyne/acca-research/index.html','utf8');

// ════════════════════════════════════════════════════════════════════════
// Helper: build the new strip HTML
// ════════════════════════════════════════════════════════════════════════
function buildStrip(opts){
  // opts: { id, msgId, counterId, progressId, label, live, indent }
  var ind=opts.indent||'    ';
  var out='';
  out+=ind+'<div id="'+opts.id+'" style="margin:0 12px 0;border-radius:10px 10px 0 0;overflow:hidden;position:relative;background:#f4fbf7;border:1px solid #d4edd9;border-bottom:none">\n';
  // Header row: label · badge · live  +  counter
  out+=ind+'  <div style="display:flex;justify-content:space-between;align-items:center;padding:9px 12px 5px">\n';
  out+=ind+'    <div style="display:flex;align-items:center;gap:6px">\n';
  out+=ind+'      <span style="font-size:9px;font-weight:700;color:#4a8c6a;text-transform:uppercase;letter-spacing:0.06em">'+opts.label+'</span>\n';
  out+=ind+'      <div style="background:#0b1628;border:1.5px solid #c9a84c;color:#fff;font-size:9px;font-weight:700;letter-spacing:.07em;padding:2px 7px;border-radius:4px;display:inline-flex;align-items:center;gap:3px">';
  out+='<div style="position:relative;width:5px;height:5px;flex-shrink:0">';
  if(opts.live) out+='<div class="ai-feed-ripple"></div><div class="ai-feed-dot" style="position:relative;z-index:1;width:5px;height:5px;border-radius:50%;background:#1e9e6b"></div>';
  else out+='<div style="position:relative;z-index:1;width:5px;height:5px;border-radius:50%;background:#1e9e6b"></div>';
  out+='</div>AI EDGE</div>\n';
  if(opts.live) out+=ind+'      <span style="font-size:8px;font-weight:800;color:#e03131;letter-spacing:.04em">&#9679; LIVE</span>\n';
  out+=ind+'    </div>\n';
  out+=ind+'    <div id="'+opts.counterId+'" style="font-size:10px;font-weight:600;color:#9aa3b5"></div>\n';
  out+=ind+'  </div>\n';
  // Full-width text row
  out+=ind+'  <div style="padding:2px 12px 12px">\n';
  out+=ind+'    <div id="'+opts.msgId+'" style="font-size:13.5px;color:#0b2a18;font-weight:500;line-height:1.4;overflow:hidden"></div>\n';
  out+=ind+'  </div>\n';
  // Progress bar
  out+=ind+'  <div style="position:absolute;bottom:0;left:0;right:0;height:2px;background:#ddeee4">\n';
  out+=ind+'    <div id="'+opts.progressId+'" style="height:100%;background:linear-gradient(90deg,#1e9e6b,#c9a84c);width:0"></div>\n';
  out+=ind+'  </div>\n';
  out+=ind+'</div>';
  return out;
}

// ════════════════════════════════════════════════════════════════════════
// 1. Replace TODAY ai-feed-strip — position based
// ════════════════════════════════════════════════════════════════════════
const todayStart=html.indexOf('<div id="ai-feed-strip" style=');
const todayEnd=html.indexOf('\n    <div id="today-meetings-list"',todayStart);
if(todayStart<0||todayEnd<0){console.error('FAIL: today strip bounds',todayStart,todayEnd);process.exit(1);}
const newTodayStrip=buildStrip({
  id:'ai-feed-strip', msgId:'ai-feed-msg', counterId:'ai-feed-counter',
  progressId:'ai-feed-progress', label:"Today's Racing", live:true, indent:'    '
});
html=html.slice(0,todayStart)+newTodayStrip+html.slice(todayEnd);
console.log('1. Today strip replaced');

// ════════════════════════════════════════════════════════════════════════
// 2. Replace TOMORROW ai-feed-strip-tomorrow — position based
// ════════════════════════════════════════════════════════════════════════
const tmStart=html.indexOf('<div id="ai-feed-strip-tomorrow" style=');
const tmEnd=html.indexOf('\n    <div id="tomorrow-meetings-list"',tmStart);
if(tmStart<0||tmEnd<0){console.error('FAIL: tomorrow strip bounds',tmStart,tmEnd);process.exit(1);}
const newTmStrip=buildStrip({
  id:'ai-feed-strip-tomorrow', msgId:'ai-feed-msg-tomorrow', counterId:'ai-feed-counter-tomorrow',
  progressId:'ai-feed-progress-tomorrow', label:"Tomorrow's Racing", live:false, indent:'  '
});
html=html.slice(0,tmStart)+newTmStrip+html.slice(tmEnd);
console.log('2. Tomorrow strip replaced');

// ════════════════════════════════════════════════════════════════════════
// 3. Cards get a gold top-border to connect visually to strip
//    today-meetings-list and tomorrow-meetings-list
// ════════════════════════════════════════════════════════════════════════
html=html.replace(
  '<div id="today-meetings-list" style="padding:0 0 4px">',
  '<div id="today-meetings-list" style="padding:0 0 4px;margin:0 12px;border:1px solid #d4edd9;border-top:2px solid #c9a84c;border-radius:0 0 10px 10px;overflow:hidden">'
);
html=html.replace(
  '<div id="tomorrow-meetings-list" style="padding:0 0 4px">',
  '<div id="tomorrow-meetings-list" style="padding:0 0 4px;margin:0 12px;border:1px solid #d4edd9;border-top:2px solid #c9a84c;border-radius:0 0 10px 10px;overflow:hidden">'
);
console.log('3. Meeting lists styled to connect to strip');

// ── Syntax check ────────────────────────────────────────────────────────
const ss=html.lastIndexOf('<script>'),se=html.lastIndexOf('</script>');
try{new Function(html.slice(ss+8,se));console.log('Syntax: OK');}
catch(e){console.error('SYNTAX:',e.message);process.exit(1);}

fs.writeFileSync('C:/Users/Gary Coyne/acca-research/index.html',html,'utf8');
console.log('Saved');
