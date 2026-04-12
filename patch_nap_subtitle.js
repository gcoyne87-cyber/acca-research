const fs=require('fs');
let html=fs.readFileSync('C:/Users/Gary Coyne/acca-research/index.html','utf8');

// The NAP & NB subtitle uses an inline style div (distinct from the sec-sub class version)
const oldSub='<div style="font-size:13px;color:var(--muted);margin-top:4px">AI-researched selections · Tap to add to slip</div>';

const badge='<div style="background:#0b1628;border:1.5px solid #c9a84c;border-radius:5px;padding:3px 8px;display:inline-flex;align-items:center;gap:4px;flex-shrink:0"><div style="width:5px;height:5px;border-radius:50%;background:#c9a84c;flex-shrink:0"></div><span style="font-size:9px;font-weight:700;letter-spacing:0.1em;color:#fff">AI EDGE</span></div>';

const newSub='<div style="font-size:13px;color:var(--muted);margin-top:4px;display:flex;align-items:center;gap:6px">Researched by '+badge+'</div>';

const count=(html.match(/<div style="font-size:13px;color:var\(--muted\);margin-top:4px">AI-researched selections · Tap to add to slip<\/div>/g)||[]).length;
if(count!==2){console.error('FAIL: expected 2 occurrences, found '+count);process.exit(1);}

html=html.split(oldSub).join(newSub);
console.log('NAP subtitle replaced ('+count+' occurrences)');

const ss=html.lastIndexOf('<script>'),se=html.lastIndexOf('</script>');
try{new Function(html.slice(ss+8,se));console.log('Syntax: OK');}
catch(e){console.error('SYNTAX:',e.message);process.exit(1);}

fs.writeFileSync('C:/Users/Gary Coyne/acca-research/index.html',html,'utf8');
console.log('Saved');
