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

async function fetchAllResults(horseId) {
  const PAGE = 50, MAX_PAGES = 4;
  let all = [], first = null;
  for (let pg = 0; pg < MAX_PAGES; pg++) {
    let body;
    try {
      body = await apiGetRacing('/v1/horses/' + encodeURIComponent(horseId)
        + '/results?limit=' + PAGE + '&skip=' + (pg * PAGE));
    } catch (e) { body = null; }
    if (!body || body.detail || !Array.isArray(body.results)) {
      if (pg === 0) return null;
      break;
    }
    if (pg === 0) first = body;
    all = all.concat(body.results);
    if (body.results.length < PAGE) break;
  }
  return Object.assign({}, first, { results: all, total: all.length, limit: all.length, skip: 0 });
}

exports.handler = async function(event) {
  const headers = { 'Access-Control-Allow-Origin': '*', 'Content-Type': 'application/json' };

  try {
    const horseId = (event.queryStringParameters || {}).horse_id;
    if (!horseId) {
      return { statusCode: 400, headers, body: JSON.stringify({ error: 'horse_id is required' }) };
    }

    const cacheKey = 'horse:profile:v2:' + horseId;

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
      fetchAllResults(horseId)
    ]);

    // A fulfilled call that returned an API error body ({detail: ...}) is a
    // failure for our purposes, not data. The results helper already folds
    // its own failures (error body, parse, first-page miss) into null.
    const profile = (profileSettled.status === 'fulfilled' && profileSettled.value && !profileSettled.value.detail)
      ? profileSettled.value : null;
    const results = (resultsSettled.status === 'fulfilled' && resultsSettled.value)
      ? resultsSettled.value : null;

    if (!profile && !results) {
      return { statusCode: 404, headers, body: JSON.stringify({ error: 'No data found for horse ' + horseId }) };
    }

    const combined = { profile: profile, results: results };

    // Cache write is best-effort — a Redis failure must never fail the
    // response the caller is waiting on. Only a COMPLETE result (both
    // halves) is cached: a partial is still served to the caller, but the
    // next request retries the missing half instead of pinning the gap
    // in Redis for 24 hours.
    if (profile && results) { try { await redisSetEx(cacheKey, combined, 86400); } catch (e) { /* best-effort */ } }

    return { statusCode: 200, headers, body: JSON.stringify(combined) };
  } catch (e) {
    return { statusCode: 500, headers, body: JSON.stringify({ error: e.message }) };
  }
};
