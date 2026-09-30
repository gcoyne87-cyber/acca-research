const https = require('https');

// Shim for the per-horse TEXT ENGINE. NO schedule yet — scheduling is decided
// once a full run has been proven. POSTs to the chosen stage with the build
// secret and passes ?date= through:
//   /.netlify/functions/text-engine-trigger?stage=submit&date=YYYY-MM-DD
//   /.netlify/functions/text-engine-trigger?stage=collect&date=YYYY-MM-DD
// Same hand-off pattern as fetch-horse-history-2-trigger.js; the stages are
// background functions and reply 202 immediately, so this shim reports the
// hand-off status only.

function triggerRun(stage, date) {
  return new Promise((resolve, reject) => {
    const req = https.request({
      hostname: 'superlative-flan-93dfc4.netlify.app',
      path: '/.netlify/functions/text-engine-' + stage + '-background' + (date ? '?date=' + encodeURIComponent(date) : ''),
      method: 'POST',
      headers: { 'x-build-secret': process.env.BUILD_SECRET || '', 'Content-Length': 0 },
      timeout: 8000
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

exports.handler = async function(event) {
  const qs = (event && event.queryStringParameters) || {};
  const secret = (event.headers && event.headers['x-build-secret']) || qs.secret;
  if (secret !== process.env.BUILD_SECRET) return { statusCode: 401, body: JSON.stringify({ error: 'Unauthorised' }) };
  const stage = qs.stage === 'collect' ? 'collect' : 'submit';
  const date = /^\d{4}-\d{2}-\d{2}$/.test(qs.date || '') ? qs.date : '';
  try {
    const result = await triggerRun(stage, date);
    console.log('[text-engine-trigger] POST text-engine-' + stage + '-background' + (date ? ' date=' + date : '') + ' ->', result.statusCode);
    return { statusCode: 200, body: JSON.stringify({ triggered: true, stage: stage, date: date || 'today', upstreamStatus: result.statusCode }) };
  } catch (e) {
    return { statusCode: 500, body: JSON.stringify({ triggered: false, stage: stage, error: e.message }) };
  }
};
