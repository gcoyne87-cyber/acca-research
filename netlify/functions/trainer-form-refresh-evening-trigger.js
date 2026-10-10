const https = require('https');

// Thin SCHEDULED (non-background) function for the evening Trainer Form
// table refresh — same pattern as class-drop-nightly-trigger.js and
// daily-build-trigger.js: it carries the cron and POSTs to
// trainer-form-refresh-background.js, because a schedule paired directly
// onto a -background function never fires and a scheduled function rejects
// external HTTP triggers at the edge (the form-summary incident).
//
// Intent: 18:30 Irish time, every evening. Netlify cron is UTC and Ireland
// moves between GMT (= UTC) and IST (UTC+1), so a single UTC minute cannot
// be 18:30 Irish all year: 17:30 UTC is 18:30 Irish in summer but 17:30
// Irish in winter. Firing at both 17:30 and 18:30 UTC covers both halves of
// the year; the background job re-checks Irish time on entry and only runs
// inside 18:15-19:15 Irish (once per slot), so the other fire is a harmless
// no-op. Same cron in netlify.toml — both places, deliberately.
module.exports.config = { schedule: '30 17,18 * * *' };

function triggerRefresh() {
  return new Promise((resolve, reject) => {
    const req = https.request({
      hostname: 'superlative-flan-93dfc4.netlify.app',
      path: '/.netlify/functions/trainer-form-refresh-background',
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
    const result = await triggerRefresh();
    console.log('[trainer-form-refresh-evening-trigger] POST to trainer-form-refresh-background ->', result.statusCode);
    return { statusCode: 200, body: JSON.stringify({ triggered: true, upstreamStatus: result.statusCode }) };
  } catch (e) {
    console.error('[trainer-form-refresh-evening-trigger] failed to trigger trainer-form-refresh-background:', e.message);
    return { statusCode: 500, body: JSON.stringify({ triggered: false, error: e.message }) };
  }
};
