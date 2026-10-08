const https = require('https');

// Thin SCHEDULED (non-background) function for the Class Drop nightly job —
// same pattern as daily-build-trigger.js: it carries the cron and POSTs to
// class-drop-nightly-background.js, because a schedule paired directly onto
// a -background function never fires and a scheduled function rejects
// external HTTP triggers at the edge (the form-summary incident).
//
// Intent: 02:00 Irish time, every night. Netlify cron is UTC and Ireland
// moves between GMT (= UTC) and IST (UTC+1), so a single UTC minute cannot
// be 02:00 Irish all year: 01:00 UTC is 02:00 Irish in summer but 01:00
// Irish in winter. Firing at both 01:00 and 02:00 UTC covers both halves of
// the year; the background job itself re-checks Irish time on entry and only
// runs inside 01:45-02:59 Irish (once per night), so the other fire is a
// harmless no-op. Same cron in netlify.toml — both places, deliberately.
module.exports.config = { schedule: '0 1,2 * * *' };

function triggerNightly() {
  return new Promise((resolve, reject) => {
    const req = https.request({
      hostname: 'superlative-flan-93dfc4.netlify.app',
      path: '/.netlify/functions/class-drop-nightly-background',
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
    const result = await triggerNightly();
    console.log('[class-drop-nightly-trigger] POST to class-drop-nightly-background ->', result.statusCode);
    return { statusCode: 200, body: JSON.stringify({ triggered: true, upstreamStatus: result.statusCode }) };
  } catch (e) {
    console.error('[class-drop-nightly-trigger] failed to trigger class-drop-nightly-background:', e.message);
    return { statusCode: 500, body: JSON.stringify({ triggered: false, error: e.message }) };
  }
};
