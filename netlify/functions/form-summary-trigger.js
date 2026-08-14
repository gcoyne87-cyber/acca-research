const https = require('https');

// Thin SCHEDULED (non-background) function. Its only job is to POST to
// form-summary-background and return — the same shim pattern as
// daily-build-trigger.js, and for the same reason: pairing "schedule"
// directly onto a "-background" function is an unsupported combination that
// deploys successfully while never actually firing. Direct evidence here:
// form-summary:heartbeat:{date} keys show the scheduled path NEVER fired —
// the only heartbeats ever recorded are manual test invocations
// (scheduled:false, isTest:true, 2026-08-05 and 2026-08-07). This function
// carries the schedule instead and hands off to the background function for
// the real 5-15 minute run.
module.exports.config = { schedule: '0 5,7,9 * * *' };

function triggerRun() {
  return new Promise((resolve, reject) => {
    const req = https.request({
      hostname: 'superlative-flan-93dfc4.netlify.app',
      path: '/.netlify/functions/form-summary-background',
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
    console.log('[form-summary-trigger] POST to form-summary-background ->', result.statusCode);
    return { statusCode: 200, body: JSON.stringify({ triggered: true, upstreamStatus: result.statusCode }) };
  } catch (e) {
    console.error('[form-summary-trigger] failed to trigger form-summary-background:', e.message);
    return { statusCode: 500, body: JSON.stringify({ triggered: false, error: e.message }) };
  }
};
