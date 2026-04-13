const fs=require('fs');
let html=fs.readFileSync('C:/Users/Gary Coyne/acca-research/index.html','utf8');

// ════════════════════════════════════════════════════════════════════════
// 1. Replace NR_RUNNERS with expanded data
// ════════════════════════════════════════════════════════════════════════
const oldRunners="var NR_RUNNERS=[\r\n\r\n  {n:9,name:'Majolique',jt:'J.P. Townend / W.P. Mullins',price:'2/1',pick:true},\r\n\r\n  {n:7,name:'Proactif',jt:'M.P. Walsh / W.P. Mullins',price:'5/2',pick:false},\r\n\r\n  {n:3,name:'Macho Man',jt:'D.E. Mullins / W.P. Mullins',price:'4/1',pick:false},\r\n\r\n  {n:6,name:'North Shore',jt:'K. Donoghue / G. Cromwell',price:'8/1',pick:false},\r\n\r\n  {n:2,name:'Kai Lung',jt:'S. O\\'Keeffe / W.P. Mullins',price:'20/1',pick:false},\r\n\r\n  {n:4,name:'Doctor Elvis',jt:'J.W. Kennedy / G. Elliott',price:'10/1',pick:false},\r\n\r\n  {n:1,name:'Sky And Sand',jt:'D. Gilligan / R. O\\'Sullivan',price:'12/1',pick:false},\r\n\r\n  {n:5,name:'Umpires Call',jt:'K. Donoghue / J.P. Dempsey',price:'16/1',pick:false},\r\n\r\n];";

const newRunners="var NR_RUNNERS=[\r\n\r\n  {n:9,name:'Majolique',jockey:'J.P. Townend',trainer:'W.P. Mullins',price:'2/1',pick:true,form:'1-2111',silk:{body:'#c0392b',sleeve:'#ffffff',cap:'#c0392b'}},\r\n\r\n  {n:7,name:'Proactif',jockey:'M.P. Walsh',trainer:'W.P. Mullins',price:'5/2',pick:false,form:'2-1122',silk:{body:'#1a3a8f',sleeve:'#f0c040',cap:'#1a3a8f'}},\r\n\r\n  {n:3,name:'Macho Man',jockey:'D.E. Mullins',trainer:'W.P. Mullins',price:'4/1',pick:false,form:'3-2113',silk:{body:'#1e6b3a',sleeve:'#ffffff',cap:'#1e6b3a'}},\r\n\r\n  {n:6,name:'North Shore',jockey:'K. Donoghue',trainer:'G. Cromwell',price:'8/1',pick:false,form:'1-3214',silk:{body:'#1a1a1a',sleeve:'#e07020',cap:'#1a1a1a'}},\r\n\r\n  {n:2,name:'Kai Lung',jockey:\"S. O'Keeffe\",trainer:'W.P. Mullins',price:'20/1',pick:false,form:'0-4032',silk:{body:'#6a2fa0',sleeve:'#ffffff',cap:'#6a2fa0'}},\r\n\r\n  {n:4,name:'Doctor Elvis',jockey:'J.W. Kennedy',trainer:'G. Elliott',price:'10/1',pick:false,form:'2-1420',silk:{body:'#e8c020',sleeve:'#1a1a1a',cap:'#e8c020'}},\r\n\r\n  {n:1,name:'Sky And Sand',jockey:'D. Gilligan',trainer:\"R. O'Sullivan\",price:'12/1',pick:false,form:'4-3221',silk:{body:'#f0f0f0',sleeve:'#0b1628',cap:'#0b1628'}},\r\n\r\n  {n:5,name:'Umpires Call',jockey:'K. Donoghue',trainer:'J.P. Dempsey',price:'16/1',pick:false,form:'0-0341',silk:{body:'#7a1a2e',sleeve:'#c9a84c',cap:'#7a1a2e'}},\r\n\r\n];";

if(!html.includes(oldRunners)){console.error('FAIL: NR_RUNNERS not found');process.exit(1);}
html=html.replace(oldRunners,newRunners);
console.log('1. NR_RUNNERS updated');

// ════════════════════════════════════════════════════════════════════════
// 2. Replace runnerRow — extract the exact button string from existing code
//    then rebuild the function around it
// ════════════════════════════════════════════════════════════════════════
const funcStart=html.indexOf('  function runnerRow(ru){');
const funcEnd=html.indexOf('\n  }',funcStart)+4;
if(funcStart<0){console.error('FAIL: runnerRow not found');process.exit(1);}

const existingFunc=html.slice(funcStart,funcEnd);

// Extract the button block verbatim from existing function
const btnStart=existingFunc.indexOf("+'<button ");
const btnEnd=existingFunc.indexOf("+'</button>'")+12;
const btnBlock=existingFunc.slice(btnStart,btnEnd);

// Build new function — paste the button block in unchanged
const newFunc=
  "  function nrSilk(s){\r\n"+
  "    return '<svg xmlns=\"http://www.w3.org/2000/svg\" width=\"26\" height=\"32\" viewBox=\"0 0 26 32\">'\r\n"+
  "      +'<path d=\"M3 9L23 9L24 30L2 30Z\" fill=\"'+s.body+'\"/>'\r\n"+
  "      +'<path d=\"M0 9L7 5L7 16L0 20Z\" fill=\"'+s.sleeve+'\"/>'\r\n"+
  "      +'<path d=\"M26 9L19 5L19 16L26 20Z\" fill=\"'+s.sleeve+'\"/>'\r\n"+
  "      +'<ellipse cx=\"13\" cy=\"5\" rx=\"8\" ry=\"5\" fill=\"'+s.cap+'\"/>'\r\n"+
  "      +'<path d=\"M3 9L23 9L24 30L2 30Z\" fill=\"none\" stroke=\"rgba(0,0,0,0.15)\" stroke-width=\"0.5\"/>'\r\n"+
  "    +'</svg>';\r\n"+
  "  }\r\n"+
  "  function nrFormHtml(form){\r\n"+
  "    return form.split('').map(function(c){\r\n"+
  "      if(c==='-') return '<span style=\"color:#d0d4dc;font-size:10px\">-</span>';\r\n"+
  "      var col=c==='1'?'#1e9e6b':c==='2'?'#4a8c6a':c==='3'?'#9aa3b5':'#c0c6d0';\r\n"+
  "      var fw=c==='1'?'700':'500';\r\n"+
  "      return '<span style=\"color:'+col+';font-weight:'+fw+';font-size:11px\">'+c+'</span>';\r\n"+
  "    }).join('');\r\n"+
  "  }\r\n"+
  "  function runnerRow(ru){\r\n"+
  "    var silk=ru.silk?nrSilk(ru.silk):'';\r\n"+
  "    var jockey=ru.jockey||ru.jt||'';\r\n"+
  "    var trainer=ru.trainer?'Tr: '+ru.trainer:'';\r\n"+
  "    var form=ru.form?nrFormHtml(ru.form):'';\r\n"+
  "    return '<div style=\"display:flex;align-items:center;padding:10px 14px;border-bottom:1px solid #f0f2f7;gap:10px\">'\r\n"+
  "      +'<div style=\"display:flex;flex-direction:column;align-items:center;gap:2px;flex-shrink:0\">'\r\n"+
  "        +silk\r\n"+
  "        +'<span style=\"font-size:9px;color:#9aa3b5;font-weight:600\">'+ru.n+'</span>'\r\n"+
  "      +'</div>'\r\n"+
  "      +'<div style=\"flex:1;min-width:0\">'\r\n"+
  "        +'<div style=\"font-size:14px;font-weight:700;color:#0b1628;white-space:nowrap;overflow:hidden;text-overflow:ellipsis\">'+escHtml(ru.name)+'</div>'\r\n"+
  "        +'<div style=\"font-size:11px;color:#555;margin-top:2px\">'+escHtml(jockey)+'</div>'\r\n"+
  "        +(trainer?'<div style=\"font-size:11px;color:#888;margin-top:1px\">'+escHtml(trainer)+'</div>':'')\r\n"+
  "        +(form?'<div style=\"margin-top:3px;display:flex;align-items:center;gap:1px\">'+form+'</div>':'')\r\n"+
  "        +'<div id=\"nr-insight-'+ru.n+'\"></div>'\r\n"+
  "      +'</div>'\r\n"+
  "      "+btnBlock+"\r\n"+
  "    +'</div>';\r\n"+
  "  }";

html=html.slice(0,funcStart)+newFunc+html.slice(funcEnd);
console.log('2. runnerRow rebuilt with silk/jockey/trainer/form');

// ════════════════════════════════════════════════════════════════════════
// 3. Remove AI EDGE badge from nrApplyInsights — keep insight text only
// ════════════════════════════════════════════════════════════════════════
const oldInsight=
  "    el.innerHTML='<div style=\"display:flex;align-items:flex-start;gap:5px;margin-top:5px;flex-wrap:wrap\">'\r\n"+
  "      +'<div style=\"display:inline-flex;align-items:center;gap:3px;background:#0b1628;border:1.5px solid #c9a84c;border-radius:5px;padding:3px 8px;flex-shrink:0;margin-top:1px\">'\r\n"+
  "        +'<div style=\"width:4px;height:4px;border-radius:50%;background:#1e9e6b;flex-shrink:0\"></div>'\r\n"+
  "        +'<span style=\"font-size:8px;font-weight:700;letter-spacing:0.1em;color:#fff\">AI EDGE</span>'\r\n"+
  "      +'</div>'\r\n"+
  "      +'<span style=\"font-size:11px;color:#4a8c6a;line-height:1.4\">'+escHtml(nrHorseInsights[n])+'</span>'\r\n"+
  "    +'</div>';";

const newInsight=
  "    el.innerHTML='<div style=\"font-size:11px;color:#4a8c6a;line-height:1.4;margin-top:4px\">'+escHtml(nrHorseInsights[n])+'</div>';";

if(!html.includes(oldInsight)){console.error('FAIL: nrApplyInsights badge not found');process.exit(1);}
html=html.replace(oldInsight,newInsight);
console.log('3. AI EDGE removed from runner insights');

// ── Syntax check ──────────────────────────────────────────────────────────────
const ss=html.lastIndexOf('<script>'),se=html.lastIndexOf('</script>');
try{new Function(html.slice(ss+8,se));console.log('Syntax: OK');}
catch(e){console.error('SYNTAX:',e.message);process.exit(1);}

fs.writeFileSync('C:/Users/Gary Coyne/acca-research/index.html',html,'utf8');
console.log('Saved');
