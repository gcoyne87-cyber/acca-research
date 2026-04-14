const fs=require('fs');
let html=fs.readFileSync('C:/Users/Gary Coyne/acca-research/index.html','utf8');

// ════════════════════════════════════════════════════════════════════════
// PROBLEM: Tomorrow NAP block is OUTSIDE racing-tomorrow-content (leaked out).
// It sits between racing-tomorrow-content closing tag and racing-winners-content.
// Fix: move it back inside racing-tomorrow-content, remove the stray </div>.
// ════════════════════════════════════════════════════════════════════════

// Find the Tomorrow NAP block (outside tomorrow content)
const tmNapAnchor='\n\n\n  <!-- TOMORROW NAP -->';
const tmNapEnd='\n\n\n\n  <div id="racing-winners-content"';
const tmNapPos=html.indexOf(tmNapAnchor);
const tmNapEndPos=html.indexOf(tmNapEnd);
if(tmNapPos<0||tmNapEndPos<0){console.error('FAIL: Tomorrow NAP boundaries not found',tmNapPos,tmNapEndPos);process.exit(1);}

// Extract the NAP block (excluding leading newlines, keep just content)
const tmNapBlock=html.slice(tmNapPos,tmNapEndPos);
console.log('Tomorrow NAP block length:',tmNapBlock.length);

// The stray </div> just before the NAP block — find it
// racing-tomorrow-content closes, then blank lines, then NAP
// We need to find the closing </div> of racing-tomorrow-content
const tmContentClose='\n  </div>\n\n\n  <!-- TOMORROW NAP -->';
const tmNapFollowedByWinners=tmNapBlock+tmNapEnd;
// We'll replace: [tmContent closing </div>] + [NAP block] + [stray </div>] + [blank lines]
// with:          [NAP block inside] + [tmContent closing </div>]

// Find exact boundary around the close of racing-tomorrow-content
// Line 2116 has "  </div>" that closes racing-tomorrow-content
// Then lines 2117-2118 blank, then 2119 <!-- TOMORROW NAP -->
// Then NAP content through line 2135
// Then line 2136 blank, line 2137 "  </div>" (stray extra div)
// Then lines 2138-2139 blank, then racing-winners-content

// Strategy: find the sequence  </div>\n\n\n  <!-- TOMORROW NAP -->
//           through to          </div>\n\n\n\n  <div id="racing-winners-content"
// and replace with: NAP block moved inside, close tomorrow-content once, then winners

const oldTmRegion=html.slice(html.indexOf('\n  </div>\n\n\n  <!-- TOMORROW NAP -->'), tmNapEndPos);
const oldTmRegionAnchor='\n  </div>\n\n\n  <!-- TOMORROW NAP -->';
const tmRegionStart=html.indexOf(oldTmRegionAnchor);
if(tmRegionStart<0){console.error('FAIL: tomorrow region anchor not found');process.exit(1);}

// Get just the NAP HTML (from <!-- TOMORROW NAP --> to end of its closing </div>)
// The NAP block is:  \n\n\n  <!-- TOMORROW NAP -->\n\n  <div class="main"...>...</div>\n\n  </div>
// The last </div> is a stray one - we remove it

// Find where NAP's own closing div is vs the stray extra </div>
// NAP structure: <!-- TOMORROW NAP --> <div class="main">...</div>  <-- that's the NAP
// Then there's one more </div> which is the stray

// Let's extract just the NAP <div class="main"> block
const napDivStart=html.indexOf('\n\n  <div class="main"', tmNapPos);
// Find its matching close: there's a </div>\n\n  </div> pattern
const napDivEnd=html.indexOf('\n\n  </div>\n\n\n\n  <div id="racing-winners-content"', napDivStart);
if(napDivEnd<0){console.error('FAIL: NAP div end not found');process.exit(1);}

// The NAP content to move inside tomorrow-content
const napContent='\n  <!-- TOMORROW NAP -->'+html.slice(napDivStart, napDivEnd)+'\n';
console.log('NAP content to move (first 100):', JSON.stringify(napContent.slice(0,100)));

// Build replacement: close tomorrow-content with NAP inside, remove stray divs
const newTmRegion=
  napContent  // NAP moves inside
 +'\n  </div>';  // closing racing-tomorrow-content

html=html.slice(0,tmRegionStart)+newTmRegion+html.slice(napDivEnd);
console.log('1. Tomorrow NAP moved inside racing-tomorrow-content, stray divs removed');

// ════════════════════════════════════════════════════════════════════════
// 2. Move AI Feed Strip ABOVE today-meetings-list (below heading, before cards)
//    Currently: heading → meeting-imgs → today-meetings-list → AI FEED STRIP
//    Target:    heading → meeting-imgs → AI FEED STRIP → today-meetings-list
// ════════════════════════════════════════════════════════════════════════

// Find the AI feed strip block for Today
const aiFeedStart='\n    <!-- AI FEED STRIP -->\n\n    <div id="ai-feed-strip"';
const aiFeedEnd='\n    </div>\n    </div>\n\n    <!-- RACING PICKS -->';
const aiFeedPos=html.indexOf(aiFeedStart);
const aiFeedEndPos=html.indexOf(aiFeedEnd);
if(aiFeedPos<0||aiFeedEndPos<0){console.error('FAIL: AI feed strip boundaries not found',aiFeedPos,aiFeedEndPos);process.exit(1);}

// The full AI strip block including its closing div and the today-content closing div
const aiFeedBlock=html.slice(aiFeedPos, aiFeedEndPos);
console.log('AI feed block first 80:', JSON.stringify(aiFeedBlock.slice(0,80)));

// Remove AI feed from current position (replace the whole block + trailing structure)
// After removal:  ...today-meetings-list</div>\n\n    </div>\n    </div>\n\n    <!-- RACING PICKS -->
html=html.slice(0,aiFeedPos)+'\n    </div>\n    </div>'+html.slice(aiFeedEndPos+'\n    </div>\n    </div>'.length);

// Now find today-meetings-list to insert AI feed BEFORE it
const meetingsListAnchor='\n    <div id="today-meetings-list"';
const mlPos=html.indexOf(meetingsListAnchor);
if(mlPos<0){console.error('FAIL: today-meetings-list not found');process.exit(1);}

// Insert AI feed strip just before the meetings list
// Strip the leading \n    from aiFeedBlock and add it cleanly
const aiFeedInsert=aiFeedBlock+'\n';
html=html.slice(0,mlPos)+aiFeedInsert+html.slice(mlPos);
console.log('2. AI feed strip moved above today-meetings-list');

// ════════════════════════════════════════════════════════════════════════
// 3. Move AI Feed Strip Tomorrow ABOVE tomorrow-meetings-list too
//    Currently: heading → tomorrow-meetings-list → AI FEED STRIP TOMORROW
//    Target:    heading → AI FEED STRIP TOMORROW → tomorrow-meetings-list
// ════════════════════════════════════════════════════════════════════════
const tmFeedStart='\n\n  <!-- AI FEED STRIP TOMORROW -->\n\n  <div id="ai-feed-strip-tomorrow"';
const tmFeedEnd='\n  </div>\n\n  </div>';  // closes ai-feed-strip-tomorrow + closes racing-tomorrow-content's bg div? No...
// Let's find the end more precisely
const tmFeedPos=html.indexOf(tmFeedStart);
if(tmFeedPos<0){console.error('FAIL: AI feed strip tomorrow not found');process.exit(1);}

// Find closing </div> of ai-feed-strip-tomorrow
const tmFeedDivClose=html.indexOf('\n\n  </div>\n\n  <!-- TOMORROW NAP -->', tmFeedPos);
if(tmFeedDivClose<0){console.error('FAIL: ai-feed-strip-tomorrow closing not found');process.exit(1);}

const tmFeedBlock=html.slice(tmFeedPos, tmFeedDivClose+'\n\n  </div>'.length);
console.log('TM feed block first 80:', JSON.stringify(tmFeedBlock.slice(0,80)));

// Remove from current position
html=html.slice(0,tmFeedPos)+html.slice(tmFeedPos+tmFeedBlock.length);

// Insert before tomorrow-meetings-list
const tmMlAnchor='\n    <div id="tomorrow-meetings-list"';
const tmMlPos=html.indexOf(tmMlAnchor);
if(tmMlPos<0){console.error('FAIL: tomorrow-meetings-list not found');process.exit(1);}

html=html.slice(0,tmMlPos)+'\n'+tmFeedBlock+'\n'+html.slice(tmMlPos);
console.log('3. AI feed strip tomorrow moved above tomorrow-meetings-list');

// ── Syntax check ─────────────────────────────────────────────────────────────
const ss=html.lastIndexOf('<script>'),se=html.lastIndexOf('</script>');
try{new Function(html.slice(ss+8,se));console.log('Syntax: OK');}
catch(e){console.error('SYNTAX:',e.message);process.exit(1);}

fs.writeFileSync('C:/Users/Gary Coyne/acca-research/index.html',html,'utf8');
console.log('Saved');
