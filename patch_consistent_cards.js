const fs=require('fs');
let html=fs.readFileSync('C:/Users/Gary Coyne/acca-research/index.html','utf8');

// ════════════════════════════════════════════════════════════════════════
// 1. Scale NAP/NB bullet text: font-size:12px → font-size:11px
//    Also tighten line-height and gap slightly
// ════════════════════════════════════════════════════════════════════════
const oldBullet='return \'<div style="display:flex;align-items:baseline;gap:6px;font-size:12px;color:#555;line-height:1.5"><span style="color:#1e9e6b;font-weight:700;flex-shrink:0">✓</span><span>\'+escHtml(r)+\'</span></div>\';\r\n\r\n    }).join(\'\');';
const newBullet='return \'<div style="display:flex;align-items:baseline;gap:5px;font-size:11px;color:#555;line-height:1.4"><span style="color:#1e9e6b;font-weight:700;flex-shrink:0">✓</span><span>\'+escHtml(r)+\'</span></div>\';\r\n\r\n    }).join(\'\');';
if(!html.includes(oldBullet)){console.error('FAIL: NAP bullet not found');process.exit(1);}
html=html.replace(oldBullet,newBullet);
console.log('1. NAP/NB bullet text scaled down');

// ════════════════════════════════════════════════════════════════════════
// 2. Update RC_RUNNERS with jockey/trainer/form/silk to match NR_RUNNERS
// ════════════════════════════════════════════════════════════════════════
const oldRC="var RC_RUNNERS=[\r\n\r\n  {n:9,name:'Majolique',jt:'J.P. Townend / W.P. Mullins',price:'2/1',pick:true,insight:'JP Townend booked — 38% win rate at Cork on Yielding, Mullins in top form this season'},\r\n\r\n  {n:7,name:'Proactif',jt:'M.P. Walsh / W.P. Mullins',price:'5/2',pick:false,insight:'Second Mullins runner — solid form, watch for market move pre-race'},\r\n\r\n  {n:3,name:'Macho Man',jt:'D.E. Mullins / W.P. Mullins',price:'4/1',pick:false},\r\n\r\n  {n:6,name:'North Shore',jt:'K. Donoghue / G. Cromwell',price:'8/1',pick:false,insight:'Won twice on Good to Yielding — conditions ideal today'},\r\n\r\n  {n:2,name:'Kai Lung',jt:'S. O\\'Keeffe / W.P. Mullins',price:'20/1',pick:false}\r\n\r\n];";
const newRC="var RC_RUNNERS=[\r\n\r\n  {n:9,name:'Majolique',jockey:'J.P. Townend',trainer:'W.P. Mullins',price:'2/1',pick:true,form:'1-2111',silk:{body:'#c0392b',sleeve:'#ffffff',cap:'#c0392b'},insight:'JP Townend booked — 38% win rate at Cork on Yielding, Mullins in top form this season'},\r\n\r\n  {n:7,name:'Proactif',jockey:'M.P. Walsh',trainer:'W.P. Mullins',price:'5/2',pick:false,form:'2-1122',silk:{body:'#1a3a8f',sleeve:'#f0c040',cap:'#1a3a8f'},insight:'Second Mullins runner — solid form, watch for market move pre-race'},\r\n\r\n  {n:3,name:'Macho Man',jockey:'D.E. Mullins',trainer:'W.P. Mullins',price:'4/1',pick:false,form:'3-2113',silk:{body:'#1e6b3a',sleeve:'#ffffff',cap:'#1e6b3a'}},\r\n\r\n  {n:6,name:'North Shore',jockey:'K. Donoghue',trainer:'G. Cromwell',price:'8/1',pick:false,form:'1-3214',silk:{body:'#1a1a1a',sleeve:'#e07020',cap:'#1a1a1a'},insight:'Won twice on Good to Yielding — conditions ideal today'},\r\n\r\n  {n:2,name:'Kai Lung',jockey:\"S. O'Keeffe\",trainer:'W.P. Mullins',price:'20/1',pick:false,form:'0-4032',silk:{body:'#6a2fa0',sleeve:'#ffffff',cap:'#6a2fa0'}}\r\n\r\n];";
if(!html.includes(oldRC)){console.error('FAIL: RC_RUNNERS not found');process.exit(1);}
html=html.replace(oldRC,newRC);
console.log('2. RC_RUNNERS updated with jockey/trainer/form/silk');

// ════════════════════════════════════════════════════════════════════════
// 3. Hoist nrSilk and nrFormHtml out of nrRenderCard to global scope
//    so rcRaceDetailHtml can reuse them
// ════════════════════════════════════════════════════════════════════════
// Extract the two functions from inside nrRenderCard (they sit between
// "NR_RUNNERS.slice(4);\r\n\r\n  function nrSilk" and "  var rHtml=")
const localFnStart=html.indexOf('\r\n\r\n  function nrSilk(s){');
const localFnEnd=html.indexOf('\r\n\r\n  var rHtml=shown.map(runnerRow)');
if(localFnStart<0||localFnEnd<0){console.error('FAIL: local fn boundaries not found');process.exit(1);}
const localFnBlock=html.slice(localFnStart,localFnEnd); // the two functions + runnerRow

// Remove from inside nrRenderCard
html=html.slice(0,localFnStart)+html.slice(localFnEnd);

// Build global versions (identical code, just at module level with function keyword)
const globalFns=
"\r\n\r\nfunction nrSilk(s){\r\n"+
"  return '<svg xmlns=\"http://www.w3.org/2000/svg\" width=\"26\" height=\"32\" viewBox=\"0 0 26 32\">'\r\n"+
"    +'<path d=\"M3 9L23 9L24 30L2 30Z\" fill=\"'+s.body+'\"/>'\r\n"+
"    +'<path d=\"M0 9L7 5L7 16L0 20Z\" fill=\"'+s.sleeve+'\"/>'\r\n"+
"    +'<path d=\"M26 9L19 5L19 16L26 20Z\" fill=\"'+s.sleeve+'\"/>'\r\n"+
"    +'<ellipse cx=\"13\" cy=\"5\" rx=\"8\" ry=\"5\" fill=\"'+s.cap+'\"/>'\r\n"+
"    +'<path d=\"M3 9L23 9L24 30L2 30Z\" fill=\"none\" stroke=\"rgba(0,0,0,0.15)\" stroke-width=\"0.5\"/>'\r\n"+
"  +'</svg>';\r\n"+
"}\r\n"+
"\r\nfunction nrFormHtml(form){\r\n"+
"  return form.split('').map(function(c){\r\n"+
"    if(c==='-') return '<span style=\"color:#d0d4dc;font-size:10px\">-</span>';\r\n"+
"    var col=c==='1'?'#1e9e6b':c==='2'?'#4a8c6a':c==='3'?'#9aa3b5':'#c0c6d0';\r\n"+
"    var fw=c==='1'?'700':'500';\r\n"+
"    return '<span style=\"color:'+col+';font-weight:'+fw+';font-size:11px\">'+c+'</span>';\r\n"+
"  }).join('');\r\n"+
"}";

// Insert before nrRenderCard
const nrCardPos=html.indexOf('\r\nfunction nrRenderCard()');
html=html.slice(0,nrCardPos)+globalFns+html.slice(nrCardPos);
console.log('3. nrSilk + nrFormHtml hoisted to global scope');

// ════════════════════════════════════════════════════════════════════════
// 4. Rewrite rcRaceDetailHtml runner loop to use silk/jockey/trainer/form
// ════════════════════════════════════════════════════════════════════════
const oldRunnerLoop=
  "  RC_RUNNERS.forEach(function(r,i){\r\n\r\n"+
  "    var last=i===RC_RUNNERS.length-1;\r\n"+
  "    var insightHtml=r.insight\r\n"+
  "      ?'<div style=\"display:flex;align-items:flex-start;gap:5px;margin-top:5px;flex-wrap:wrap\">'\r\n"+
  "        +'<div style=\"display:inline-flex;align-items:center;gap:3px;background:#0b1628;border:1.5px solid #c9a84c;border-radius:5px;padding:3px 8px;flex-shrink:0;margin-top:1px\">'\r\n"+
  "          +'<div style=\"width:4px;height:4px;border-radius:50%;background:#1e9e6b;flex-shrink:0\"></div>'\r\n"+
  "          +'<span style=\"font-size:8px;font-weight:700;letter-spacing:0.1em;color:#fff\">AI EDGE</span>'\r\n"+
  "        +'</div>'\r\n"+
  "        +'<span style=\"font-size:11px;color:#4a8c6a;line-height:1.4\">'+escHtml(r.insight)+'</span>'\r\n"+
  "      +'</div>'\r\n"+
  "      :'';\r\n\r\n"+
  "    out+='<div style=\"display:flex;align-items:center;padding:11px 14px;border-bottom:'+(last?'none':'1px solid #f0f2f7')+';background:#fff;gap:10px\">'\r\n"+
  "      +'<div style=\"font-size:11px;color:#9aa3b5;width:16px;flex-shrink:0\">'+r.n+'</div>'\r\n"+
  "      +'<div style=\"flex:1;min-width:0\">'\r\n"+
  "        +'<div style=\"font-size:14px;font-weight:600;color:#0b1628;white-space:nowrap;overflow:hidden;text-overflow:ellipsis\">'+escHtml(r.name)+'</div>'\r\n"+
  "        +'<div style=\"font-size:11px;color:#9aa3b5;margin-top:2px\">'+escHtml(r.jt)+'</div>'\r\n"+
  "        +insightHtml\r\n"+
  "      +'</div>'\r\n"+
  "      +'<button onclick=\"nrAddToSlip(\\''+escHtml(r.name)+'\\',\\''+escHtml(r.price)+'\\')\" style=\"background:#f0f2f7;border:1px solid #e4e8f0;border-radius:8px;padding:8px 12px;cursor:pointer;font-family:inherit;text-align:center;flex-shrink:0\">'\r\n"+
  "        +'<div style=\"font-size:14px;font-weight:700;color:#0b1628\">'+escHtml(r.price)+'</div>'\r\n"+
  "      +'</button>'\r\n"+
  "    +'</div>';\r\n\r\n"+
  "  });";

const newRunnerLoop=
  "  RC_RUNNERS.forEach(function(r,i){\r\n\r\n"+
  "    var last=i===RC_RUNNERS.length-1;\r\n"+
  "    var silk=r.silk?nrSilk(r.silk):'';\r\n"+
  "    var jockey=r.jockey||r.jt||'';\r\n"+
  "    var trainer=r.trainer?'Tr: '+r.trainer:'';\r\n"+
  "    var form=r.form?nrFormHtml(r.form):'';\r\n"+
  "    var insightHtml=r.insight?'<div style=\"font-size:11px;color:#4a8c6a;line-height:1.4;margin-top:4px\">'+escHtml(r.insight)+'</div>':'';\r\n\r\n"+
  "    out+='<div style=\"display:flex;align-items:center;padding:10px 14px;border-bottom:'+(last?'none':'1px solid #f0f2f7')+';background:#fff;gap:10px\">'\r\n"+
  "      +'<div style=\"display:flex;flex-direction:column;align-items:center;gap:2px;flex-shrink:0\">'\r\n"+
  "        +silk\r\n"+
  "        +'<span style=\"font-size:9px;color:#9aa3b5;font-weight:600\">'+r.n+'</span>'\r\n"+
  "      +'</div>'\r\n"+
  "      +'<div style=\"flex:1;min-width:0\">'\r\n"+
  "        +'<div style=\"font-size:14px;font-weight:700;color:#0b1628;white-space:nowrap;overflow:hidden;text-overflow:ellipsis\">'+escHtml(r.name)+'</div>'\r\n"+
  "        +'<div style=\"font-size:11px;color:#555;margin-top:2px\">'+escHtml(jockey)+'</div>'\r\n"+
  "        +(trainer?'<div style=\"font-size:11px;color:#888;margin-top:1px\">'+escHtml(trainer)+'</div>':'')\r\n"+
  "        +(form?'<div style=\"margin-top:3px;display:flex;align-items:center;gap:1px\">'+form+'</div>':'')\r\n"+
  "        +insightHtml\r\n"+
  "      +'</div>'\r\n"+
  "      +'<button onclick=\"nrAddToSlip(\\''+escHtml(r.name)+'\\',\\''+escHtml(r.price)+'\\')\" style=\"background:#f0f2f7;border:1px solid #e4e8f0;border-radius:8px;padding:8px 12px;cursor:pointer;font-family:inherit;text-align:center;flex-shrink:0\">'\r\n"+
  "        +'<div style=\"font-size:14px;font-weight:700;color:#0b1628\">'+escHtml(r.price)+'</div>'\r\n"+
  "      +'</button>'\r\n"+
  "    +'</div>';\r\n\r\n"+
  "  });";

if(!html.includes(oldRunnerLoop)){console.error('FAIL: rcRaceDetailHtml runner loop not found');process.exit(1);}
html=html.replace(oldRunnerLoop,newRunnerLoop);
console.log('4. rcRaceDetailHtml runner cards updated to match Next Race style');

// ── Syntax check ──────────────────────────────────────────────────────────────
const ss=html.lastIndexOf('<script>'),se=html.lastIndexOf('</script>');
try{new Function(html.slice(ss+8,se));console.log('Syntax: OK');}
catch(e){console.error('SYNTAX:',e.message);process.exit(1);}

fs.writeFileSync('C:/Users/Gary Coyne/acca-research/index.html',html,'utf8');
console.log('Saved');
