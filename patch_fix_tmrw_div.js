const fs=require('fs');
let html=fs.readFileSync('C:/Users/Gary Coyne/acca-research/index.html','utf8');

// The stray extra </div> sits between racing-tomorrow-content's real close
// and racing-winners-content. Remove it.
const anchor='\n  </div>\n\n\n\n  <div id="racing-winners-content"';
if(!html.includes(anchor)){console.error('FAIL: stray div anchor not found');process.exit(1);}

// Remove the extra </div> before winners-content (keep the blank lines)
html=html.replace(anchor,'\n\n\n\n  <div id="racing-winners-content"');
console.log('Removed stray </div> before racing-winners-content');

// Verify the balance is now correct
const start=html.indexOf('<div id="racing-tomorrow-content"');
const end=html.indexOf('\n\n  <div id="racing-winners-content"',start);
const chunk=html.slice(start,end);
const opens=(chunk.match(/<div/g)||[]).length;
const closes=(chunk.match(/<\/div>/g)||[]).length;
console.log('tomorrow div balance: opens='+opens+' closes='+closes+' balance='+(opens-closes));
if(opens!==closes){console.error('WARN: still unbalanced');} else {console.log('Balance OK');}

const ss=html.lastIndexOf('<script>'),se=html.lastIndexOf('</script>');
try{new Function(html.slice(ss+8,se));console.log('Syntax: OK');}
catch(e){console.error('SYNTAX:',e.message);process.exit(1);}

fs.writeFileSync('C:/Users/Gary Coyne/acca-research/index.html',html,'utf8');
console.log('Saved');
