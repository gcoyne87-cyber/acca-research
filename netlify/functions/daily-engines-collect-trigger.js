const https = require('https');

// Thin SCHEDULED (non-background) function for the daily engines COLLECT job
// — same shim pattern as daily-build-trigger.js: it carries the cron and
// POSTs to daily-engines-collect-background.js, because a schedule paired
// directly onto a -background function never fires and a scheduled function
// rejects external HTTP triggers at the edge (the form-summary incident).
//
// Every 15 minutes, all day: the cron only supplies ticks. The background
// job's own guard does the windowing (11:45-15:05 Irish) and exits silently
// outside it, so the clock change needs no cron adjustment. Same cron in
// netlify.toml — both places, deliberately.
module.exports.config = { schedule: '*/15 * * * *' };

function triggerCollect() {
  return new Promise((resolve, reject) => {
    const req = https.request({
      hostname: 'superlative-flan-93dfc4.netlify.app',
      path: '/.netlify/functions/daily-engines-collect-background',
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
    const result = await triggerCollect();
    console.log('[daily-engines-collect-trigger] POST to daily-engines-collect-background ->', result.statusCode);
    return { statusCode: 200, body: JSON.stringify({ triggered: true, upstreamStatus: result.statusCode }) };
  } catch (e) {
    console.error('[daily-engines-collect-trigger] failed to trigger daily-engines-collect-background:', e.message);
    return { statusCode: 500, body: JSON.stringify({ triggered: false, error: e.message }) };
  }
};
