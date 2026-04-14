const fs=require('fs');
let html=fs.readFileSync('C:/Users/Gary Coyne/acca-research/index.html','utf8');

// The today-meetings-list is currently INSIDE the ai-feed-strip flex div.
// Fix: close ai-feed-strip first, then put meetings list below it.

const oldBlock=
  '\n    <div id="today-meetings-list" style="padding:0 0 4px"></div>\n\n    </div>\n\n    </div>\n    </div>';

const newBlock=
  '\n    </div>\n\n    <div id="today-meetings-list" style="padding:0 0 4px"></div>\n\n    </div>\n    </div>';

if(!html.includes(oldBlock)){console.error('FAIL: today-meetings block not found');process.exit(1);}
html=html.replace(oldBlock,newBlock);
console.log('Fixed: today-meetings-list moved outside ai-feed-strip');

const ss=html.lastIndexOf('<script>'),se=html.lastIndexOf('</script>');
try{new Function(html.slice(ss+8,se));console.log('Syntax: OK');}
catch(e){console.error('SYNTAX:',e.message);process.exit(1);}

fs.writeFileSync('C:/Users/Gary Coyne/acca-research/index.html',html,'utf8');
console.log('Saved');
