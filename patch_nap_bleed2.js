const fs=require('fs');
let html=fs.readFileSync('C:/Users/Gary Coyne/acca-research/index.html','utf8');

// 1. Container: remove side padding (full bleed), give heading its own inline padding
html=html.replace(
  'padding-top:12px;padding-bottom:0;padding-left:12px;padding-right:12px">\n\n      <div style="margin-bottom:12px">\n\n        <span style="font-size:24px;line-height:1;display:block;margin-bottom:6px">\uD83C\uDFAF</span>\n\n        <div style="font-size:22px;font-weight:700;color:var(--navy);line-height:1.1">Today\'s NAP &amp; NB</div>',
  'padding-top:12px;padding-bottom:0;padding-left:0;padding-right:0">\n\n      <div style="margin-bottom:12px;padding:0 16px">\n\n        <span style="font-size:24px;line-height:1;display:block;margin-bottom:6px">\uD83C\uDFAF</span>\n\n        <div style="font-size:22px;font-weight:700;color:var(--navy);line-height:1.1">Today\'s NAP &amp; NB</div>'
);
console.log('1. Container full-bleed, heading padded inline');

// 2. Cards container: tinted gap so break between tips is visible
html=html.replace(
  '<div id="racing-picks-container" style="display:flex;flex-direction:column;gap:12px">',
  '<div id="racing-picks-container" style="display:flex;flex-direction:column;gap:10px;background:#edf0f5">'
);
console.log('2. Container gap + tint added');

// 3. Card wrapper in render fn: no border-radius, no outer border — left stripe only
html=html.replace(
  "+'<div style=\"background:#fff;border:1px solid #e8eaed;border-radius:12px;overflow:hidden;border-left:4px solid '+p.border+'\">'",
  "+'<div style=\"background:#fff;border:none;border-left:4px solid '+p.border+';overflow:hidden;\">'"
);
console.log('3. Card style: full-bleed, no radius');

const ss=html.lastIndexOf('<script>'),se=html.lastIndexOf('</script>');
try{new Function(html.slice(ss+8,se));console.log('Syntax: OK');}
catch(e){console.error('SYNTAX:',e.message);process.exit(1);}

fs.writeFileSync('C:/Users/Gary Coyne/acca-research/index.html',html,'utf8');
console.log('Saved');
