const https = require('https');

const UPSTASH_URL = process.env.UPSTASH_REDIS_REST_URL;
const UPSTASH_TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN;
const RACING_AUTH = Buffer.from(
  (process.env.RACING_API_USERNAME || '') + ':' + (process.env.RACING_API_KEY || '')
).toString('base64');

// Horse profile endpoint — one horse_id in, the horse's Pro record plus its
// last 50 results out. Cached in Redis for 24 hours (the ?EX= TTL means a
// present key IS a fresh key — no manual staleness bookkeeping), so repeat
// profile opens within a day cost zero Racing API calls. Modelled on
// horse-form.js: same Basic auth, same Upstash helpers, same
// resolve-null-never-throw error posture on the cache tier.

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

// Set with expiry — Upstash REST takes TTL as ?EX={seconds} on the /set/
// path (the same established-safe pattern get-results.js and
// form-summary-background.js use; only NX-style params are the historic
// footgun here).
function redisSetEx(key, value, ttlSeconds) {
  if (!UPSTASH_URL || !UPSTASH_TOKEN) return Promise.resolve(null);
  const url = new URL(UPSTASH_URL);
  const body = JSON.stringify(value);
  return new Promise(resolve => {
    const req = https.request({
      hostname: url.hostname,
      path: '/set/' + encodeURIComponent(key) + '?EX=' + ttlSeconds,
      method: 'POST',
      headers: { 'Authorization': 'Bearer ' + UPSTASH_TOKEN, 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) }
    }, res => { let d = ''; res.on('data', c => d += c); res.on('end', () => resolve(d)); });
    req.on('error', () => resolve(null)); req.write(body); req.end();
  });
}

function apiGetRacing(path) {
  return new Promise((resolve, reject) => {
    const req = https.request({
      hostname: 'api.theracingapi.com', path: path, method: 'GET',
      headers: { 'Authorization': 'Basic ' + RACING_AUTH, 'Accept': 'application/json' }
    }, res => {
      let d = ''; res.on('data', c => d += c);
      res.on('end', () => { try { resolve(JSON.parse(d)); } catch(e) { reject(new Error('Parse')); } });
    });
    req.on('error', reject); req.end();
  });
}

exports.handler = async function(event) {
  const headers = { 'Access-Control-Allow-Origin': '*', 'Content-Type': 'application/json' };

  try {
    const horseId = (event.queryStringParameters || {}).horse_id;
    if (!horseId) {
      return { statusCode: 400, headers, body: JSON.stringify({ error: 'horse_id is required' }) };
    }

    const cacheKey = 'horse:profile:' + horseId;

    // Cache tier — the 24h TTL below means any hit is fresh by definition.
    const cached = await redisGet(cacheKey);
    if (cached && (cached.profile || cached.results)) {
      return { statusCode: 200, headers, body: JSON.stringify(cached) };
    }

    // Two parallel Racing API calls; allSettled so one failure never takes
    // the other down — a profile with results but no Pro record (or vice
    // versa) is still worth returning.
    const [profileSettled, resultsSettled] = await Promise.allSettled([
      apiGetRacing('/v1/horses/' + encodeURIComponent(horseId) + '/pro'),
      apiGetRacing('/v1/horses/' + encodeURIComponent(horseId) + '/results?limit=200')
    ]);

    // A fulfilled call that returned an API error body ({detail: ...}) is a
    // failure for our purposes, not data.
    const profile = (profileSettled.status === 'fulfilled' && profileSettled.value && !profileSettled.value.detail)
      ? profileSettled.value : null;
    const results = (resultsSettled.status === 'fulfilled' && resultsSettled.value && !resultsSettled.value.detail)
      ? resultsSettled.value : null;

    if (!profile && !results) {
      return { statusCode: 404, headers, body: JSON.stringify({ error: 'No data found for horse ' + horseId }) };
    }

    const combined = { profile: profile, results: results };

    // Cache write is best-effort — a Redis failure must never fail the
    // response the caller is waiting on.
    try { await redisSetEx(cacheKey, combined, 86400); } catch (e) { /* best-effort */ }

    return { statusCode: 200, headers, body: JSON.stringify(combined) };
  } catch (e) {
    return { statusCode: 500, headers, body: JSON.stringify({ error: e.message }) };
  }
};
