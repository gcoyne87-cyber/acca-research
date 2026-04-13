const fs=require('fs');
let html=fs.readFileSync('C:/Users/Gary Coyne/acca-research/index.html','utf8');

// ── Find winners-content boundaries ───────────────────────────────────────────
const winnersOpen='<div id="racing-winners-content" style="display:none;padding:0">';
const wi=html.indexOf(winnersOpen);
if(wi<0){console.error('FAIL: racing-winners-content not found');process.exit(1);}
const winnersDivStart=wi;

// Find where winners-content closes — it's the \r\n\r\n  </div> just before \r\n\r\n</div><!-- /main -->
const mainClose='\r\n\r\n</div><!-- /main -->';
const mc=html.indexOf(mainClose);
if(mc<0){console.error('FAIL: main close not found');process.exit(1);}
// The winners closing </div> is \r\n\r\n  </div> right before mainClose
const winnersDivClose=mc-('\r\n\r\n  </div>'.length);
const winnersDivEnd=mc; // full end including the \r\n\r\n  </div>

// Extract full current winners-content (from < to just before mainClose)
const currentWinnersContent=html.slice(winnersDivStart,winnersDivEnd);

// ── Find TOMORROW WINNERS start inside winners-content ────────────────────────
const twMarker='\r\n\r\n\r\n  <!-- TOMORROW WINNERS -->';
const twRelPos=currentWinnersContent.indexOf(twMarker);
if(twRelPos<0){console.error('FAIL: TOMORROW WINNERS not in winners-content');process.exit(1);}

// Everything before TOMORROW WINNERS = just the RACING WINNERS block
const racingWinnersOnly=currentWinnersContent.slice(0,twRelPos);
// Everything from TOMORROW WINNERS to end of winners-content = tomorrow block
const tomorrowBlock=currentWinnersContent.slice(twRelPos,currentWinnersContent.indexOf('\r\n\r\n  </div>',-1)+'\r\n\r\n  </div>'.length-currentWinnersContent.length+currentWinnersContent.length);

// Get the tomorrow section from TOMORROW WINNERS to the closing </div> of winners-content
const closingDiv='\r\n\r\n  </div>';
const lastClosingPos=currentWinnersContent.lastIndexOf(closingDiv);
const tomorrowContent=currentWinnersContent.slice(twRelPos,lastClosingPos);

console.log('RACING WINNERS block length:',racingWinnersOnly.length);
console.log('Tomorrow block length:',tomorrowContent.length);
console.log('Tomorrow block starts with:',tomorrowContent.slice(0,40));

// ── Rebuild winners-content with only RACING WINNERS ──────────────────────────
const newWinnersContent=racingWinnersOnly+'\r\n\r\n  </div>';
html=html.slice(0,winnersDivStart)+newWinnersContent+html.slice(winnersDivEnd);
console.log('1. Winners-content now contains only RACING WINNERS');

// ── Insert tomorrow block back into tomorrow-content ─────────────────────────
// tomorrow-content closes just before the (now smaller) racing-winners-content
const tmCloseAnchor='\r\n\r\n  </div>\r\n\r\n  '+winnersOpen;
const tmClosePos=html.indexOf(tmCloseAnchor);
if(tmClosePos<0){console.error('FAIL: tomorrow close anchor not found');process.exit(1);}
// Insert tomorrowContent before the closing </div> of tomorrow-content
html=html.slice(0,tmClosePos)+tomorrowContent+html.slice(tmClosePos);
console.log('2. TOMORROW WINNERS + NAP restored to tomorrow-content');

// ── Verify ────────────────────────────────────────────────────────────────────
const wiV=html.indexOf(winnersOpen);
const tiV=html.indexOf('id="racing-tomorrow-content"');
const winnersChunk=html.slice(wiV,wiV+3000);
const tmChunk=html.slice(tiV,wiV);
console.log('\nVerify — Winners-content:');
['RACING WINNERS','TOMORROW WINNERS','TOMORROW NAP'].forEach(function(s){
  console.log(' ',s+':',winnersChunk.includes(s)?'YES':'no');
});
console.log('Verify — Tomorrow-content:');
['TOMORROW WINNERS','TOMORROW NAP'].forEach(function(s){
  console.log(' ',s+':',tmChunk.includes(s)?'YES':'no');
});

// ── Syntax check ─────────────────────────────────────────────────────────────
const ss=html.lastIndexOf('<script>'),se=html.lastIndexOf('</script>');
try{new Function(html.slice(ss+8,se));console.log('\nSyntax: OK');}
catch(e){console.error('SYNTAX:',e.message);process.exit(1);}

fs.writeFileSync('C:/Users/Gary Coyne/acca-research/index.html',html,'utf8');
console.log('Saved');
