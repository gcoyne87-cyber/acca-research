const fs=require('fs');
let html=fs.readFileSync('C:/Users/Gary Coyne/acca-research/index.html','utf8');

// ── 1. Fix outer container: align-items:flex-start → align-items:center ────────
const oldOuter='position:fixed;top:0;left:0;width:100%;height:100vh;flex-direction:column;justify-content:center;align-items:flex-start;z-index:9999;background:#0b1628';
const newOuter='position:fixed;top:0;left:0;width:100%;height:100vh;flex-direction:column;justify-content:center;align-items:center;z-index:9999;background:#0b1628';
if(!html.includes(oldOuter)){console.error('FAIL: racing-splash outer not found');process.exit(1);}
html=html.replace(oldOuter,newOuter);
console.log('1. Outer container centred');

// ── 2. Fix content div: left padding → centred column with text-align:center ───
const oldContent='position:relative;z-index:2;padding:32px 28px;width:100%;display:flex;flex-direction:column';
const newContent='position:relative;z-index:2;padding:32px 24px;width:100%;max-width:360px;display:flex;flex-direction:column;align-items:center;text-align:center';
if(!html.includes(oldContent)){console.error('FAIL: content div not found');process.exit(1);}
html=html.replace(oldContent,newContent);
console.log('2. Content div centred');

const ss=html.lastIndexOf('<script>'),se=html.lastIndexOf('</script>');
try{new Function(html.slice(ss+8,se));console.log('Syntax: OK');}
catch(e){console.error('SYNTAX:',e.message);process.exit(1);}

fs.writeFileSync('C:/Users/Gary Coyne/acca-research/index.html',html,'utf8');
console.log('Saved');
