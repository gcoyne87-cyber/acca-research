const fs=require('fs');
let html=fs.readFileSync('C:/Users/Gary Coyne/acca-research/index.html','utf8');

// Change all gold dots (#c9a84c) back to green (#1e9e6b) on badge dot divs
const oldDot='border-radius:50%;background:#c9a84c';
const newDot='border-radius:50%;background:#1e9e6b';
const count=(html.split(oldDot).length-1);
if(count===0){console.error('FAIL: no gold dots found');process.exit(1);}
html=html.split(oldDot).join(newDot);
console.log('Changed '+count+' gold dots to green');

// Syntax check
const ss=html.lastIndexOf('<script>'),se=html.lastIndexOf('</script>');
try{new Function(html.slice(ss+8,se));console.log('Syntax: OK');}
catch(e){console.error('SYNTAX:',e.message);process.exit(1);}

fs.writeFileSync('C:/Users/Gary Coyne/acca-research/index.html',html,'utf8');
console.log('Saved');
