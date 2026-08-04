// TEMPORARY diagnostic function — calls the Racing API live for one known
// horse so the raw response shape (specifically weight/OR field names) can
// be inspected. Not scheduled, not referenced anywhere else. Delete after use.

const https = require('https');

const USERNAME = process.env.RACING_API_USERNAME;
const PASSWORD = process.env.RACING_API_KEY;
const BASE_URL = 'api.theracingapi.com';
const AUTH = Buffer.from((USERNAME || '') + ':' + (PASSWORD || '')).toString('base64');

function apiGet(path) {
  return new Promise((resolve, reject) => {
    const options = {
      hostname: BASE_URL,
      path: path,
      method: 'GET',
      headers: {
        'Authorization': 'Basic ' + AUTH,
        'Accept': 'application/json'
      }
    };
    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try { resolve(JSON.parse(data)); }
        catch(e) { reject(new Error('Parse error: ' + data.substring(0, 200))); }
      });
    });
    req.on('error', reject);
    req.end();
  });
}

exports.handler = async function(event) {
  const headers = { 'Access-Control-Allow-Origin': '*', 'Content-Type': 'application/json' };

  const secret = (event.queryStringParameters && event.queryStringParameters.secret) || (event.headers && event.headers['x-build-secret']);
  if (secret !== process.env.BUILD_SECRET) {
    return { statusCode: 401, headers, body: JSON.stringify({ error: 'Unauthorised' }) };
  }

  try {
    const horseId = (event.queryStringParameters && event.queryStringParameters.horse_id) || 'hrs_17390101400';
    const data = await apiGet('/v1/horses/' + encodeURIComponent(horseId) + '/results?limit=1');
    return { statusCode: 200, headers, body: JSON.stringify(data, null, 2) };
  } catch (e) {
    return { statusCode: 500, headers, body: JSON.stringify({ error: e.message }) };
  }
};
