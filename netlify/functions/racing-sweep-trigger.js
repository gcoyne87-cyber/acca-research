const https = require('https');

// Thin SCHEDULED (non-background) function. Its only job is to POST to
// racing-sweep-background and return — the same shim pattern as
// fetch-horse-history-1-trigger.js and form-summary-trigger.js: pairing
// "schedule" directly onto a "-background" function is an unsupported
// combination that deploys successfully while never actually firing. This
// function carries the schedule instead and hands off to the background
// function for the real run.
//
// 01:15 UTC / 02:15 Irish (summer) — after both nightly history fetchers
// (fetch-horse-history-1-trigger.js at 23:30 UTC, fetch-horse-history-2-
// trigger.js at 23:50 UTC) have fully finished.
module.exports.config = { schedule: '15 1 * * *' };

function triggerRun() {
  return new Promise((resolve, reject) => {
    const req = https.request({
      hostname: 'superlative-flan-93dfc4.netlify.app',
      path: '/.netlify/functions/racing-sweep-background',
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
    const result = await triggerRun();
    console.log('[racing-sweep-trigger] POST to racing-sweep-background ->', result.statusCode);
    return { statusCode: 200, body: JSON.stringify({ triggered: true, upstreamStatus: result.statusCode }) };
  } catch (e) {
    console.error('[racing-sweep-trigger] failed to trigger racing-sweep-background:', e.message);
    return { statusCode: 500, body: JSON.stringify({ triggered: false, error: e.message }) };
  }
};
