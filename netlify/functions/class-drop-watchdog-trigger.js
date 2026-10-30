const https = require('https');

// Thin SCHEDULED function for the Class Drop watchdog — same trigger/background
// pattern as class-drop-nightly-trigger.js. Fires at 02:30 Irish time; the
// background job re-checks Irish time on entry (02:20-02:55 window) so the
// off-season fire at the wrong UTC hour exits immediately. Ireland is UTC+1 in
// summer / UTC in winter: 01:30 UTC = 02:30 IST, 02:30 UTC = 02:30 GMT. Same
// cron in netlify.toml.
module.exports.config = { schedule: '30 1,2 * * *' };

function triggerWatchdog() {
  return new Promise((resolve, reject) => {
    const req = https.request({
      hostname: 'superlative-flan-93dfc4.netlify.app',
      path: '/.netlify/functions/class-drop-watchdog-background',
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
    const result = await triggerWatchdog();
    console.log('[class-drop-watchdog-trigger] POST to class-drop-watchdog-background ->', result.statusCode);
    return { statusCode: 200, body: JSON.stringify({ triggered: true, upstreamStatus: result.statusCode }) };
  } catch (e) {
    console.error('[class-drop-watchdog-trigger] failed to trigger class-drop-watchdog-background:', e.message);
    return { statusCode: 500, body: JSON.stringify({ triggered: false, error: e.message }) };
  }
};
