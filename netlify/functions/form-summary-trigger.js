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
//
// 05:00 / 07:00 / 09:00 UTC — 3x/day, restored 2026-09-15. The 2026-09-11
// rewrite that introduced this trigger shim set the cron to '*/15 * * * *'
// (96 runs/day); each run scans all runners across the next 5 days and
// generates a Claude batch for anything unsummarised, so at that cadence a
// backlog that never fully drains inside one run's 780s budget just times
// out and restarts every 15 minutes, all day, every day — the run that
// exhausted the Anthropic budget on 2026-09-14/15. 5/7/9 UTC was the
// deliberately-chosen cadence before that rewrite (see commit 7758333) and
// is restored here; form-summary-watchdog still checks at 09:30 UTC.
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
