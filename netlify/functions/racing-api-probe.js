const https = require('https');

// TEMPORARY read-only probe for the Racing API bloodline endpoints. Exists so
// a one-off proof test can be run with the site's credentials (which are
// masked outside the deploy). It forwards a single GET to the Racing API and
// returns the raw JSON plus timing. It writes to no store, calls no other
// service, and is to be deleted once the test is reported.
//
//   GET /.netlify/functions/racing-api-probe?path=/v1/sires/search?name=Mehmas
//   header: x-build-secret
//
// The path is allowlisted strictly to the sire, dam and damsire endpoints.

const AUTH = Buffer.from((process.env.RACING_API_USERNAME || '') + ':' + (process.env.RACING_API_KEY || '')).toString('base64');
const ALLOWED = /^\/v1\/(sires|dams|damsires)\/[A-Za-z0-9_\-\/]*(\?[A-Za-z0-9_\-=&%.+]*)?$/;

function apiGet(path) {
  return new Promise((resolve, reject) => {
    const req = https.request({
      hostname: 'api.theracingapi.com', path: path, method: 'GET',
      headers: { 'Authorization': 'Basic ' + AUTH, 'Accept': 'application/json' },
      timeout: 25000
    }, res => {
      let d = '';
      res.on('data', c => d += c);
      res.on('end', () => resolve({ status: res.statusCode, body: d }));
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('upstream timeout')); });
    req.end();
  });
}

exports.handler = async function(event) {
  const headers = { 'Content-Type': 'application/json' };
  if (event.httpMethod !== 'GET') return { statusCode: 405, headers, body: JSON.stringify({ error: 'GET only' }) };
  const secret = event.headers && event.headers['x-build-secret'];
  if (!secret || secret !== process.env.BUILD_SECRET) return { statusCode: 401, headers, body: JSON.stringify({ error: 'Unauthorised' }) };

  const path = (event.queryStringParameters || {}).path || '';
  if (!ALLOWED.test(path)) return { statusCode: 400, headers, body: JSON.stringify({ error: 'path not allowed', path }) };

  const t0 = Date.now();
  try {
    const r = await apiGet(path);
    let data;
    try { data = JSON.parse(r.body); } catch (e) { data = { _raw: r.body.substring(0, 2000) }; }
    return { statusCode: 200, headers, body: JSON.stringify({ path, upstreamStatus: r.status, ms: Date.now() - t0, data }) };
  } catch (e) {
    return { statusCode: 502, headers, body: JSON.stringify({ path, error: e.message, ms: Date.now() - t0 }) };
  }
};
