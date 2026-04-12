const fs=require('fs');
let html=fs.readFileSync('C:/Users/Gary Coyne/acca-research/index.html','utf8');

// ── 1. Insert opening wrapper div before the TODAY'S MEETINGS CAROUSEL comment ──
const openTarget='\r\n    <!-- TODAY\'S MEETINGS CAROUSEL -->\r\n\r\n    <div style="padding:16px 0 4px">';
const openReplacement='\r\n    <div style="background:#e8f5ef;padding-bottom:4px;">\r\n    <!-- TODAY\'S MEETINGS CAROUSEL -->\r\n\r\n    <div style="padding:16px 0 4px">';
if(!html.includes(openTarget)){console.error('FAIL: open target not found');process.exit(1);}
html=html.replace(openTarget,openReplacement);
console.log('Wrapper opening inserted');

// ── 2. Insert closing wrapper div after ai-feed-strip, before RACING WINNERS ──
const closeTarget='\r\n    </div>\r\n\r\n    <!-- RACING WINNERS -->';
const closeReplacement='\r\n    </div>\r\n    </div>\r\n\r\n    <!-- RACING WINNERS -->';
if(!html.includes(closeTarget)){console.error('FAIL: close target not found');process.exit(1);}
html=html.replace(closeTarget,closeReplacement);
console.log('Wrapper closing inserted');

// ── 3. Remove background:#e8f5ef from ai-feed-strip ──
const oldFeedStyle='id="ai-feed-strip" style="background:#e8f5ef;padding:8px 16px;display:flex;align-items:center;gap:10px"';
const newFeedStyle='id="ai-feed-strip" style="padding:8px 16px;display:flex;align-items:center;gap:10px"';
if(!html.includes(oldFeedStyle)){console.error('FAIL: ai-feed-strip style not found');process.exit(1);}
html=html.replace(oldFeedStyle,newFeedStyle);
console.log('ai-feed-strip background removed');

// ── 4. Change heading colour from var(--navy) to #0b1628 ──
const oldHeading='font-size:20px;font-weight:700;color:var(--navy);line-height:1.1">Today\'s Meetings</div>';
const newHeading='font-size:20px;font-weight:700;color:#0b1628;line-height:1.1">Today\'s Meetings</div>';
if(!html.includes(oldHeading)){console.error('FAIL: heading not found');process.exit(1);}
html=html.replace(oldHeading,newHeading);
console.log('Heading colour updated');

// ── 5. Change subtitle colour from var(--muted) to #4a8c6a ──
const oldSub='font-size:13px;color:var(--muted);margin-top:4px">Tap a course to jump to its race card</div>';
const newSub='font-size:13px;color:#4a8c6a;margin-top:4px">Tap a course to jump to its race card</div>';
if(!html.includes(oldSub)){console.error('FAIL: subtitle not found');process.exit(1);}
html=html.replace(oldSub,newSub);
console.log('Subtitle colour updated');

// ── Syntax check ──
const ss=html.lastIndexOf('<script>'),se=html.lastIndexOf('</script>');
try{new Function(html.slice(ss+8,se));console.log('Syntax: OK');}
catch(e){console.error('SYNTAX:',e.message);process.exit(1);}

fs.writeFileSync('C:/Users/Gary Coyne/acca-research/index.html',html,'utf8');
console.log('Saved');
