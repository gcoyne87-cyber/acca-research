const https = require('https');

// Thin SCHEDULED (non-background) function. Its only job is to POST to
// fetch-horse-history-2-trigger-background and return -- the same shim
// pattern as form-summary-trigger.js, and for the same reason: pairing
// "schedule" directly onto a "-background" function is an unsupported
// combination that deploys successfully while never actually firing. This
// function carries the schedule instead and hands off to the unscheduled
// twin (which itself checks the build secret and calls
// fetch-horse-history-2-background.js) for the real run.
module.exports.config = { schedule: '50 23 * * *' };

function triggerRun() {
  return new Promise((resolve, reject) => {
    const req = https.request({
      hostname: 'superlative-flan-93dfc4.netlify.app',
      path: '/.netlify/functions/fetch-horse-history-2-trigger-background',
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
    console.log('[fetch-horse-history-2-trigger] POST to fetch-horse-history-2-trigger-background ->', result.statusCode);
    return { statusCode: 200, body: JSON.stringify({ triggered: true, upstreamStatus: result.statusCode }) };
  } catch (e) {
    console.error('[fetch-horse-history-2-trigger] failed to trigger fetch-horse-history-2-trigger-background:', e.message);
    return { statusCode: 500, body: JSON.stringify({ triggered: false, error: e.message }) };
  }
};
