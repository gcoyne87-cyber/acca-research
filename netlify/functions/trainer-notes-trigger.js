const https = require('https');

// Thin (non-background) function whose only job is to POST to
// trainer-notes-background and return — same shim pattern as
// form-summary-trigger.js/daily-build-trigger.js. No schedule on this one:
// manual trigger only for now, standalone one-off scoped to 2026-09-13.

function triggerRun() {
  return new Promise((resolve, reject) => {
    const req = https.request({
      hostname: 'superlative-flan-93dfc4.netlify.app',
      path: '/.netlify/functions/trainer-notes-background',
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
    console.log('[trainer-notes-trigger] POST to trainer-notes-background ->', result.statusCode);
    return { statusCode: 200, body: JSON.stringify({ triggered: true, upstreamStatus: result.statusCode }) };
  } catch (e) {
    console.error('[trainer-notes-trigger] failed to trigger trainer-notes-background:', e.message);
    return { statusCode: 500, body: JSON.stringify({ triggered: false, error: e.message }) };
  }
};
