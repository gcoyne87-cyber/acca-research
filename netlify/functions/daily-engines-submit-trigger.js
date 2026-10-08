const https = require('https');

// Thin SCHEDULED (non-background) function for the daily engines SUBMIT job —
// the daily-build-trigger.js pattern: it carries the cron and POSTs to
// daily-engines-submit-background.js, because a schedule paired directly
// onto a -background function never fires and a scheduled function rejects
// external HTTP triggers at the edge (the form-summary incident).
//
// Intent: 11:30 IRISH time daily. Netlify cron is UTC and Ireland is UTC+1
// in summer / UTC in winter, so 10:30 UTC is 11:30 Irish only in summer; in
// winter it is 10:30 Irish. Firing at both 10:30 and 11:30 UTC covers both
// halves of the year — the background job's own guard (11:15-12:15 Irish,
// once per day via batch:daily:{date}) makes the other fire a no-op. Same
// cron in netlify.toml — both places, deliberately.
module.exports.config = { schedule: '30 10,11 * * *' };

function triggerSubmit() {
  return new Promise((resolve, reject) => {
    const req = https.request({
      hostname: 'superlative-flan-93dfc4.netlify.app',
      path: '/.netlify/functions/daily-engines-submit-background',
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
    const result = await triggerSubmit();
    console.log('[daily-engines-submit-trigger] POST to daily-engines-submit-background ->', result.statusCode);
    return { statusCode: 200, body: JSON.stringify({ triggered: true, upstreamStatus: result.statusCode }) };
  } catch (e) {
    console.error('[daily-engines-submit-trigger] failed to trigger daily-engines-submit-background:', e.message);
    return { statusCode: 500, body: JSON.stringify({ triggered: false, error: e.message }) };
  }
};
