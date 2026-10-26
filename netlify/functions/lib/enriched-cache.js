// enriched-cache.js — one shared 60-second cache of the fully-enriched
// racecard (tags, evidence, everything) at enriched:racecards:{date}.
//
// The full enrichment pipeline (racecards:{date} + trainer-form table +
// trainer:registry + one form:history per runner, ~3.3 MB of Redis reads)
// used to re-run on EVERY request in three places: the racecards handler,
// get-results' declaredCard step (both views) and get-popular-trainers.
// With this cache, whoever gets there first each minute pays the pipeline
// once and everyone else reads the ~0.7 MB result (2026-10-26 bandwidth
// audit: those re-runs were the site's top Redis bandwidth consumer).
//
// Freshness contract: the 60s TTL is only the ceiling. Every writer that
// changes tag-affecting data (racecards:{date} or trainer-form:table:{date})
// calls invalidate() right after its write, so no reader ever sees a state
// older than the latest write — see refresh-prices-background.js,
// trainer-form-refresh-background.js, daily-build-background.js and
// fetch-future-cards-background.js.
//
// Everything here is BEST-EFFORT: a read failure or corrupt JSON returns
// null (caller falls through to a live rebuild), a write/delete failure
// resolves silently. This cache must never be able to error a response.
const https = require('https');

const UPSTASH_URL = process.env.UPSTASH_REDIS_REST_URL;
const UPSTASH_TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN;
const TTL_SECONDS = 60;

function keyFor(date) { return 'enriched:racecards:' + date; }

function rawCall(path, body) {
  return new Promise(function(resolve) {
    try {
      const url = new URL(UPSTASH_URL);
      const req = https.request({
        hostname: url.hostname, path: path, method: 'POST',
        headers: Object.assign({ 'Authorization': 'Bearer ' + UPSTASH_TOKEN },
          body ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) } : {})
      }, function(res) {
        let d = '';
        res.on('data', function(c) { d += c; });
        res.on('end', function() { try { resolve(JSON.parse(d)); } catch (e) { resolve(null); } });
      });
      req.on('error', function() { resolve(null); });
      if (body) req.write(body);
      req.end();
    } catch (e) { resolve(null); }
  });
}

// Enriched meetings array for the date, or null (missing, corrupt, or any
// failure — the caller then rebuilds live).
async function getEnriched(date) {
  const r = await rawCall('/get/' + encodeURIComponent(keyFor(date)));
  if (!r || typeof r.result !== 'string') return null;
  try {
    const meetings = JSON.parse(r.result);
    return Array.isArray(meetings) ? meetings : null;
  } catch (e) { return null; }
}

// Store the enriched meetings with the 60s TTL. Never caches an empty day
// (nothing saved by caching emptiness) and never throws.
async function setEnriched(date, meetings) {
  if (!Array.isArray(meetings) || !meetings.length) return;
  try {
    await rawCall('/set/' + encodeURIComponent(keyFor(date)) + '?EX=' + TTL_SECONDS, JSON.stringify(meetings));
  } catch (e) { /* best-effort */ }
}

// Drop the cache for one or more dates so the next read rebuilds fresh —
// called by every writer of racecards:{date} or trainer-form:table:{date}
// right after its write. Never throws.
async function invalidate(dates) {
  const list = (Array.isArray(dates) ? dates : [dates]).filter(Boolean);
  if (!list.length) return;
  try {
    await rawCall('/pipeline', JSON.stringify(list.map(function(d) { return ['DEL', keyFor(d)]; })));
  } catch (e) { /* best-effort */ }
}

module.exports = { getEnriched: getEnriched, setEnriched: setEnriched, invalidate: invalidate, TTL_SECONDS: TTL_SECONDS };
