const https = require('https');

// Thin SCHEDULED (non-background) function. Its only job is to POST to the
// background twin and return — Netlify's own scheduled-functions docs give
// scheduled functions a 30s limit and background functions are documented as
// a separate, longer-running function type; pairing "schedule" directly onto
// a "-background" function (the old daily-build-background.js config) is an
// unsupported combination that community reports describe deploying
// successfully while never actually firing. This function carries the
// schedule instead, and hands off to daily-build-test-background.js (an
// ordinary background function) for the real 5-17 minute build.
module.exports.config = { schedule: '30 9 * * *' };

function triggerBuild() {
  return new Promise((resolve, reject) => {
    const req = https.request({
      hostname: 'superlative-flan-93dfc4.netlify.app',
      path: '/.netlify/functions/daily-build-test-background',
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
    const result = await triggerBuild();
    console.log('[daily-build-trigger] POST to daily-build-test-background ->', result.statusCode);
    return { statusCode: 200, body: JSON.stringify({ triggered: true, upstreamStatus: result.statusCode }) };
  } catch (e) {
    console.error('[daily-build-trigger] failed to trigger daily-build-test-background:', e.message);
    return { statusCode: 500, body: JSON.stringify({ triggered: false, error: e.message }) };
  }
};
