const https = require('https');

// Thin SCHEDULED (non-background) function for the Tomorrow's Hot Yard
// preview job — same pattern as class-drop-nightly-trigger.js and
// daily-build-trigger.js: it carries the cron and POSTs to
// hotyard-nightly-background.js, because a schedule paired directly onto a
// -background function never fires and a scheduled function rejects
// external HTTP triggers at the edge (the form-summary incident).
//
// Intent: 22:00 Irish time, every night — after the 21:30 trainer-form
// refresh has rewritten trainer-form:table:{today}, so the preview is
// computed from tonight's figures. Netlify cron is UTC and Ireland moves
// between GMT (= UTC) and IST (UTC+1), so a single UTC minute cannot be
// 22:00 Irish all year: 21:00 UTC is 22:00 Irish in summer but 21:00 Irish
// in winter. Firing at both 21:00 and 22:00 UTC covers both halves of the
// year; the background job itself re-checks Irish time on entry and only
// runs inside 21:45-22:59 Irish (once per night), so the other fire is a
// harmless no-op. Same cron in netlify.toml — both places, deliberately.
module.exports.config = { schedule: '0 21,22 * * *' };

function triggerNightly() {
  return new Promise((resolve, reject) => {
    const req = https.request({
      hostname: 'superlative-flan-93dfc4.netlify.app',
      path: '/.netlify/functions/hotyard-nightly-background',
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
    console.log('[hotyard-nightly-trigger] POST to hotyard-nightly-background ->', result.statusCode);
    return { statusCode: 200, body: JSON.stringify({ triggered: true, upstreamStatus: result.statusCode }) };
  } catch (e) {
    console.error('[hotyard-nightly-trigger] failed to trigger hotyard-nightly-background:', e.message);
    return { statusCode: 500, body: JSON.stringify({ triggered: false, error: e.message }) };
  }
};
