const fs=require('fs');
let html=fs.readFileSync('C:/Users/Gary Coyne/acca-research/index.html','utf8');

// ════════════════════════════════════════════════════════════════════════
// 1. CSS: topnav — taller, more padding, bigger logo
// ════════════════════════════════════════════════════════════════════════
html=html.replace(
  '.topnav-inner{max-width:900px;margin:0 auto;padding:0 16px;display:flex;align-items:center;gap:20px;height:54px}',
  '.topnav-inner{max-width:900px;margin:0 auto;padding:0 16px;display:flex;align-items:center;gap:20px;height:62px}'
);
// Topnav inner - check for 10px version too
html=html.replace(
  '.topnav-inner{max-width:900px;margin:0 auto;padding:0 10px;display:flex;align-items:center;gap:20px;height:54px}',
  '.topnav-inner{max-width:900px;margin:0 auto;padding:0 16px;display:flex;align-items:center;gap:20px;height:62px}'
);
// Inline racing logo font (17px)
html=html.replace(
  'font-size:17px;font-weight:700;letter-spacing:-0.5px;line-height:1',
  'font-size:22px;font-weight:700;letter-spacing:-0.5px;line-height:1'
);
console.log('1. Topnav scaled');

// ════════════════════════════════════════════════════════════════════════
// 2. Section nav — larger font + padding (covers both HTML attrs and JS vars)
// ════════════════════════════════════════════════════════════════════════
html=html.replace(/padding:10px 16px;font-size:13px;font-weight:600;cursor:pointer;font-family:inherit;white-space:nowrap;flex-shrink:0;letter-spacing:\.01em/g,
  'padding:13px 18px;font-size:14px;font-weight:600;cursor:pointer;font-family:inherit;white-space:nowrap;flex-shrink:0;letter-spacing:.01em');
html=html.replace(/padding:10px 16px;font-size:13px;font-weight:500;cursor:pointer;font-family:inherit;white-space:nowrap;flex-shrink:0;letter-spacing:\.01em/g,
  'padding:13px 18px;font-size:14px;font-weight:500;cursor:pointer;font-family:inherit;white-space:nowrap;flex-shrink:0;letter-spacing:.01em');
console.log('2. Section nav scaled');

// ════════════════════════════════════════════════════════════════════════
// 3. Date pills — bigger touch targets (covers HTML and JS)
// ════════════════════════════════════════════════════════════════════════
html=html.replace(/padding:8px 14px;font-size:11px;font-weight:600;cursor:pointer;font-family:inherit;display:inline-flex;align-items:center;gap:5px/g,
  'padding:11px 16px;font-size:13px;font-weight:600;cursor:pointer;font-family:inherit;display:inline-flex;align-items:center;gap:5px');
html=html.replace(/padding:8px 14px;font-size:11px;font-weight:500;cursor:pointer;font-family:inherit;display:inline-flex;align-items:center;gap:5px/g,
  'padding:11px 16px;font-size:13px;font-weight:500;cursor:pointer;font-family:inherit;display:inline-flex;align-items:center;gap:5px');
// Also fix the date pill border+color active style (selectRacingDate JS var)
html=html.replace(
  'border-bottom:2px solid #1e9e6b;padding:8px 14px;font-size:11px;font-weight:600',
  'border-bottom:2px solid #1e9e6b;padding:11px 16px;font-size:13px;font-weight:600');
html=html.replace(
  'border-bottom:2px solid transparent;padding:8px 14px;font-size:11px;font-weight:500',
  'border-bottom:2px solid transparent;padding:11px 16px;font-size:13px;font-weight:500');
console.log('3. Date pills scaled');

// ════════════════════════════════════════════════════════════════════════
// 4. Banner cards — taller images, bigger venue text
// ════════════════════════════════════════════════════════════════════════
html=html.replace(/height:72px;background:#0b1628;overflow:hidden;cursor:pointer/g,
  'height:96px;background:#0b1628;overflow:hidden;cursor:pointer');
html=html.replace(/font-size:16px;font-weight:700;color:#fff;line-height:1;letter-spacing:-0\.3px/g,
  'font-size:20px;font-weight:700;color:#fff;line-height:1;letter-spacing:-0.3px');
html=html.replace(/font-size:10px;font-weight:600;color:rgba\(255,255,255,0\.82\)/g,
  'font-size:12px;font-weight:600;color:rgba(255,255,255,0.82)');
html=html.replace(
  /style="position:absolute;bottom:0;left:0;right:0;padding:6px 12px 8px"/g,
  'style="position:absolute;bottom:0;left:0;right:0;padding:8px 14px 10px"');
console.log('4. Banner cards taller + text bigger');

// ════════════════════════════════════════════════════════════════════════
// 5. AI Edge strip — more padding, bigger text
// ════════════════════════════════════════════════════════════════════════
html=html.replace(/padding:10px 12px 14px/g,'padding:13px 14px 17px');
html=html.replace(
  /font-size:12\.5px;color:#0b2a18;font-weight:500;line-height:1\.45;overflow:hidden/g,
  'font-size:14px;color:#0b2a18;font-weight:500;line-height:1.45;overflow:hidden');
html=html.replace(
  /font-size:9px;font-weight:700;letter-spacing:\.07em;padding:3px 7px;border-radius:5px/g,
  'font-size:10px;font-weight:700;letter-spacing:.07em;padding:4px 9px;border-radius:5px');
html=html.replace(
  /font-size:10px;font-weight:600;color:#9aa3b5;min-width:24px;text-align:right/g,
  'font-size:12px;font-weight:600;color:#9aa3b5;min-width:28px;text-align:right');
console.log('5. AI Edge strip scaled');

// ════════════════════════════════════════════════════════════════════════
// 6. Race time pills in expanded meeting cards
// ════════════════════════════════════════════════════════════════════════
html=html.replace(/flex-shrink:0;width:58px;border:1px solid /g,
  'flex-shrink:0;width:66px;border:1px solid ');
html=html.replace(/border-radius:8px;padding:8px 4px;text-align:center;cursor:pointer;/g,
  'border-radius:8px;padding:11px 4px;text-align:center;cursor:pointer;');
html=html.replace(
  /font-size:12px;font-weight:600;color:/g,
  'font-size:13px;font-weight:600;color:');
console.log('6. Race time pills bigger');

// ════════════════════════════════════════════════════════════════════════
// 7. Section headings (Next Race, NAP & NB)
// ════════════════════════════════════════════════════════════════════════
html=html.replace(
  'font-size:20px;font-weight:700;color:var(--navy);line-height:1.1">Today\'s NAP &amp; NB',
  'font-size:22px;font-weight:700;color:var(--navy);line-height:1.1">Today\'s NAP &amp; NB');
html=html.replace(
  'font-size:20px;font-weight:700;color:var(--navy);line-height:1.1">Tomorrow\'s NAP &amp; NB',
  'font-size:22px;font-weight:700;color:var(--navy);line-height:1.1">Tomorrow\'s NAP &amp; NB');
html=html.replace(
  '">Next Race</div>',
  '" style="font-size:22px">Next Race</div>');
console.log('7. Headings scaled');

// ── Syntax check ─────────────────────────────────────────────────────────────
const ss=html.lastIndexOf('<script>'),se=html.lastIndexOf('</script>');
try{new Function(html.slice(ss+8,se));console.log('Syntax: OK');}
catch(e){console.error('SYNTAX:',e.message);process.exit(1);}

fs.writeFileSync('C:/Users/Gary Coyne/acca-research/index.html',html,'utf8');
console.log('Saved');
