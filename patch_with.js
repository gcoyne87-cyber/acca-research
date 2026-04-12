const fs=require('fs');
let html=fs.readFileSync('C:/Users/Gary Coyne/acca-research/index.html','utf8');

const replacements=[
  ['Analysis available with ','With '],  // 1 occurrence — Today's Meetings
  ['Predicted by ','With '],             // 2 occurrences — Today & Tomorrow Winners
  ['Researched by ','With '],            // 2 occurrences — Today & Tomorrow NAP
];

for(const [from,to] of replacements){
  const count=html.split(from).length-1;
  if(count===0){console.error('FAIL: "'+from+'" not found');process.exit(1);}
  html=html.split(from).join(to);
  console.log('"'+from.trim()+'" → "'+to.trim()+'" ('+count+' occurrence'+( count>1?'s':'')+')');
}

const ss=html.lastIndexOf('<script>'),se=html.lastIndexOf('</script>');
try{new Function(html.slice(ss+8,se));console.log('Syntax: OK');}
catch(e){console.error('SYNTAX:',e.message);process.exit(1);}

fs.writeFileSync('C:/Users/Gary Coyne/acca-research/index.html',html,'utf8');
console.log('Saved');
