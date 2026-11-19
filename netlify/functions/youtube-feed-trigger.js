const https = require('https');

// Thin SCHEDULED (non-background) function for the YouTube racing feed —
// same pattern as hotyard-nightly-trigger.js: it carries the cron and POSTs
// to youtube-feed-background.js, because a schedule paired directly onto a
// -background function never fires and a scheduled function rejects
// external HTTP triggers at the edge.
//
// Intent: THREE runs daily, at 07:00, 16:00 and 22:00 IRISH time. Netlify
// cron is UTC and Ireland is UTC in winter / UTC+1 in summer, so it fires at
// both candidate UTC hours for each slot:
//   07:00 Irish = 06:00 UTC (summer) / 07:00 UTC (winter)
//   16:00 Irish = 15:00 UTC (summer) / 16:00 UTC (winter)
//   22:00 Irish = 21:00 UTC (summer) / 22:00 UTC (winter)
// The background job re-checks Irish time on entry and runs only when the
// Irish hour is 7, 16 or 22, once per slot, so the off-season fire of each
// pair exits before spending any YouTube quota. Same cron in netlify.toml —
// both places.
module.exports.config = { schedule: '0 6,7,15,16,21,22 * * *' };

function triggerFeed() {
  return new Promise((resolve, reject) => {
    const req = https.request({
      hostname: 'superlative-flan-93dfc4.netlify.app',
      path: '/.netlify/functions/youtube-feed-background',
      method: 'POST',
      headers: {
        'x-build-secret': process.env.BUILD_SECRET || '',
        'Content-Length': 0
      },
      timeout: 4000
    }, res => {
      let d = '';
      res.on('data', c => d += c);
      res.on('end', () => resolve({ statusCode: res.statusCode, body: d }));
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('trigger request timed out')); });
    req.end();
  });
}

exports.handler = async function() {
  try {
    const result = await triggerFeed();
    console.log('[youtube-feed-trigger] POST to youtube-feed-background ->', result.statusCode);
    return { statusCode: 200, body: JSON.stringify({ triggered: true, upstreamStatus: result.statusCode }) };
  } catch (e) {
    console.error('[youtube-feed-trigger] failed to trigger youtube-feed-background:', e.message);
    return { statusCode: 500, body: JSON.stringify({ triggered: false, error: e.message }) };
  }
};
