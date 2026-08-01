// TEMPORARY diagnostic — investigates AUDIT-DAILY-INTELLIGENCE.md finding S6/item 3
// (Class Drop Pool 1 starvation: every cached historical result has empty
// race_class). Returns the raw Racing API results-endpoint response for a known
// horse so the actual field names can be inspected. Removed once the
// investigation is done.
const https = require('https');

const RACING_AUTH = Buffer.from(
  (process.env.RACING_API_USERNAME || '') + ':' + (process.env.RACING_API_KEY || '')
).toString('base64');

function apiGet(hostname, path, extraHeaders) {
  return new Promise((resolve, reject) => {
    const req = https.request({
      hostname, path, method: 'GET',
      headers: { 'Accept': 'application/json', ...(extraHeaders || {}) }
    }, res => {
      let d = ''; res.on('data', c => d += c);
      res.on('end', () => { try { resolve(JSON.parse(d)); } catch(e) { reject(new Error('Parse: ' + d.slice(0, 300))); } });
    });
    req.on('error', reject); req.end();
  });
}

exports.handler = async function(event) {
  const secret = (event.queryStringParameters && event.queryStringParameters.secret) || (event.headers && event.headers['x-build-secret']);
  if (secret !== process.env.BUILD_SECRET) {
    return { statusCode: 401, body: JSON.stringify({ error: 'Unauthorised' }) };
  }
  const horseId = (event.queryStringParameters && event.queryStringParameters.horse_id) || 'hrs_52054450';
  try {
    const data = await apiGet('api.theracingapi.com', '/v1/horses/' + encodeURIComponent(horseId) + '/results?limit=3', { 'Authorization': 'Basic ' + RACING_AUTH });
    return { statusCode: 200, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data, null, 2) };
  } catch (e) {
    return { statusCode: 500, body: JSON.stringify({ error: e.message }) };
  }
};
