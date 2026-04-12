const fs=require('fs');
let html=fs.readFileSync('C:/Users/Gary Coyne/acca-research/index.html','utf8');

const badge='<div style="background:#0b1628;border:1.5px solid #c9a84c;border-radius:4px;padding:1px 5px;display:inline-flex;align-items:center;gap:3px"><div style="width:3px;height:3px;border-radius:50%;background:#1e9e6b;flex-shrink:0"></div><span style="font-size:7px;font-weight:700;color:#fff;letter-spacing:0.08em">AI EDGE</span></div>';

['8 races','7 races','6 races'].forEach(races=>{
  // Old: block div stack with margin-bottom
  const oldRow='<div style="margin-top:4px"><div style="font-size:10px;font-weight:600;color:rgba(255,255,255,0.85);margin-bottom:2px">'+races+'</div>'+badge+'</div>';
  // New: flex column, gap:2px, line-height:1 kills default line-box gaps
  const newRow='<div style="margin-top:4px;display:flex;flex-direction:column;align-items:flex-start;gap:2px;line-height:1"><span style="font-size:10px;font-weight:600;color:rgba(255,255,255,0.85)">'+races+'</span>'+badge+'</div>';
  const count=html.split(oldRow).length-1;
  if(count===0){console.log('(no match for '+races+', skipping)');return;}
  html=html.split(oldRow).join(newRow);
  console.log('Updated '+count+'× "'+races+'"');
});

const ss=html.lastIndexOf('<script>'),se=html.lastIndexOf('</script>');
try{new Function(html.slice(ss+8,se));console.log('Syntax: OK');}
catch(e){console.error('SYNTAX:',e.message);process.exit(1);}

fs.writeFileSync('C:/Users/Gary Coyne/acca-research/index.html',html,'utf8');
console.log('Saved');
