const fs=require('fs');
let html=fs.readFileSync('C:/Users/Gary Coyne/acca-research/index.html','utf8');

// runnerRow was accidentally deleted during the hoisting step.
// Re-insert it as a global function right after nrFormHtml (which ends with "}\r\n")
// We anchor on the end of nrFormHtml and the start of "\r\nfunction nrRenderCard"

const anchor='\r\nfunction nrRenderCard()';
if(html.indexOf(anchor)<0){console.error('FAIL: nrRenderCard not found');process.exit(1);}

const runnerRowFn=
"\r\nfunction runnerRow(ru){\r\n"+
"  var silk=ru.silk?nrSilk(ru.silk):'';\r\n"+
"  var jockey=ru.jockey||ru.jt||'';\r\n"+
"  var trainer=ru.trainer?'Tr: '+ru.trainer:'';\r\n"+
"  var form=ru.form?nrFormHtml(ru.form):'';\r\n"+
"  return '<div style=\"display:flex;align-items:center;padding:10px 14px;border-bottom:1px solid #f0f2f7;gap:10px\">'\r\n"+
"    +'<div style=\"display:flex;flex-direction:column;align-items:center;gap:2px;flex-shrink:0\">'\r\n"+
"      +silk\r\n"+
"      +'<span style=\"font-size:9px;color:#9aa3b5;font-weight:600\">'+ru.n+'</span>'\r\n"+
"    +'</div>'\r\n"+
"    +'<div style=\"flex:1;min-width:0\">'\r\n"+
"      +'<div style=\"font-size:14px;font-weight:700;color:#0b1628;white-space:nowrap;overflow:hidden;text-overflow:ellipsis\">'+escHtml(ru.name)+'</div>'\r\n"+
"      +'<div style=\"font-size:11px;color:#555;margin-top:2px\">'+escHtml(jockey)+'</div>'\r\n"+
"      +(trainer?'<div style=\"font-size:11px;color:#888;margin-top:1px\">'+escHtml(trainer)+'</div>':'')\r\n"+
"      +(form?'<div style=\"margin-top:3px;display:flex;align-items:center;gap:1px\">'+form+'</div>':'')\r\n"+
"      +'<div id=\"nr-insight-'+ru.n+'\"></div>'\r\n"+
"    +'</div>'\r\n"+
"    +'<button onclick=\"nrAddToSlip(\\''+escHtml(ru.name)+'\\',\\''+escHtml(ru.price)+'\\')\" style=\"background:#f0f2f7;border:1px solid #e4e8f0;border-radius:8px;padding:8px 12px;cursor:pointer;font-family:inherit;text-align:center;flex-shrink:0\">'\r\n"+
"      +'<div style=\"font-size:14px;font-weight:700;color:#0b1628\">'+escHtml(ru.price)+'</div>'\r\n"+
"    +'</button>'\r\n"+
"  +'</div>';\r\n"+
"}";

const pos=html.indexOf(anchor);
html=html.slice(0,pos)+runnerRowFn+html.slice(pos);
console.log('runnerRow inserted at global scope');

// ── Syntax check ─────────────────────────────────────────────────────────────
const ss=html.lastIndexOf('<script>'),se=html.lastIndexOf('</script>');
try{new Function(html.slice(ss+8,se));console.log('Syntax: OK');}
catch(e){console.error('SYNTAX:',e.message);process.exit(1);}

fs.writeFileSync('C:/Users/Gary Coyne/acca-research/index.html',html,'utf8');
console.log('Saved');
