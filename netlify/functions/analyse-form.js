const https = require('https');

const UPSTASH_URL = process.env.UPSTASH_REDIS_REST_URL;
const UPSTASH_TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN;

// All form edge data is pre-cached by the daily build at morning run time.
// This function ONLY reads from Redis — it never makes live AI calls.
// Returns headline (keyAngle) and summary (formParagraph) from the cached form summary.

function redisGet(key) {
  if (!UPSTASH_URL || !UPSTASH_TOKEN) return Promise.resolve(null);
  const url = new URL(UPSTASH_URL);
  return new Promise(resolve => {
    const req = https.request({
      hostname: url.hostname,
      path: '/get/' + encodeURIComponent(key),
      method: 'GET',
      headers: { 'Authorization': 'Bearer ' + UPSTASH_TOKEN }
    }, res => {
      let d = '';
      res.on('data', c => d += c);
      res.on('end', () => {
        try { const r = JSON.parse(d); resolve(r.result ? JSON.parse(r.result) : null); }
        catch(e) { resolve(null); }
      });
    });
    req.on('error', () => resolve(null));
    req.end();
  });
}

exports.handler = async function(event) {
  const headers = { 'Access-Control-Allow-Origin': '*', 'Content-Type': 'application/json' };
  if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers, body: '' };

  const params = event.queryStringParameters || {};
  const horse_id = params.horse_id;
  if (!horse_id) {
    return { statusCode: 400, headers, body: JSON.stringify({ error: 'horse_id required' }) };
  }

  const today = new Date().toISOString().slice(0, 10);
  const summary = await redisGet('form:summary:' + horse_id + ':' + today);

  if (!summary) {
    return { statusCode: 200, headers, body: JSON.stringify({ headline: '', summary: '' }) };
  }

  return {
    statusCode: 200,
    headers,
    body: JSON.stringify({
      headline: summary.keyAngle || '',
      summary: summary.formParagraph || ''
    })
  };
};
