const fs=require('fs');
let html=fs.readFileSync('C:/Users/Gary Coyne/acca-research/index.html','utf8');

// ════════════════════════════════════════════════════════════════════════
// 1. Signal tags — replace per-signal colour with single professional style
//    Muted slate: background #eef1f7, text #334155, border #c8d0e0
// ════════════════════════════════════════════════════════════════════════
html=html.replace(
  '      var bg=s.col.replace(\'#\',\'\');\n'
  +'      return \'<div style="display:flex;align-items:flex-start;gap:8px;margin-bottom:0">\'\n'
  +'        +\'<span style="font-size:8px;font-weight:700;letter-spacing:.05em;white-space:nowrap;flex-shrink:0;margin-top:2px;border-radius:4px;padding:2px 6px;color:\'+s.col+\';border:1px solid \'+s.col+\';opacity:0.9">\'+s.tag+\'</span>\'\n'
  +'        +\'<span style="font-size:12px;color:#333;line-height:1.45">\'+escHtml(s.text)+\'</span>\'\n'
  +'        +\'</div>\';',

  '      return \'<div style="display:flex;align-items:flex-start;gap:8px;margin-bottom:0">\'\n'
  +'        +\'<span style="font-size:8px;font-weight:700;letter-spacing:.06em;white-space:nowrap;flex-shrink:0;margin-top:2px;border-radius:4px;padding:2px 7px;color:#334155;background:#eef1f7;border:1px solid #c8d0e0">\'+s.tag+\'</span>\'\n'
  +'        +\'<span style="font-size:12px;color:#333;line-height:1.45">\'+escHtml(s.text)+\'</span>\'\n'
  +'        +\'</div>\';'
);
console.log('1. Signal tags unified to single professional style');

// ════════════════════════════════════════════════════════════════════════
// 2. Confidence bar — always green (#1e9e6b), remove adaptive colour logic
// ════════════════════════════════════════════════════════════════════════
html=html.replace(
  '    var confCol=p.confidence>=80?\'#1e9e6b\':p.confidence>=65?\'#c9a84c\':\'#e03131\';',
  '    var confCol=\'#1e9e6b\';'
);
console.log('2. Confidence bar fixed to green');

// ── Syntax check ────────────────────────────────────────────────────────
const ss=html.lastIndexOf('<script>'),se=html.lastIndexOf('</script>');
try{new Function(html.slice(ss+8,se));console.log('Syntax: OK');}
catch(e){console.error('SYNTAX:',e.message);process.exit(1);}

fs.writeFileSync('C:/Users/Gary Coyne/acca-research/index.html',html,'utf8');
console.log('Saved');
