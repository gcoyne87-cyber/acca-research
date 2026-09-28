const https = require('https');

// Read-only batched reader for the bloodline stats cache the horse chevron's
// Sire / Dam / Damsire panel uses: ancestor:stats:{id}, where id is the
// Racing API sire_id / dam_id / damsire_id carried on the stored racecard
// runner. Same shape and pattern as get-form-summaries.js. Ids with no cache
// entry come back as null so the client renders its "coming soon" state; the
// entries themselves are written by a separate job (not this function).

const UPSTASH_URL = process.env.UPSTASH_REDIS_REST_URL;
const UPSTASH_TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN;

function redisGet(key) {
  const url = new URL(UPSTASH_URL);
  return new Promise((resolve) => {
    const req = https.request({
      hostname: url.hostname,
      path: '/get/' + encodeURIComponent(key),
      method: 'GET',
      headers: { 'Authorization': 'Bearer ' + UPSTASH_TOKEN }
    }, res => {
      let d = '';
      res.on('data', c => d += c);
      res.on('end', () => {
        try {
          const r = JSON.parse(d);
          resolve(r.result ? JSON.parse(r.result) : null);
        } catch(e) { resolve(null); }
      });
    });
    req.on('error', () => resolve(null));
    req.end();
  });
}

exports.handler = async function(event) {
  const headers = { 'Access-Control-Allow-Origin': '*', 'Content-Type': 'application/json' };
  const idsParam = (event.queryStringParameters || {}).ids || '';
  // Only the three ancestor id shapes are looked up; anything else is ignored.
  const ids = idsParam.split(',').map(function(s) { return s.trim(); })
    .filter(function(s) { return /^(sir|dam|dsi)_[A-Za-z0-9]+$/.test(s); })
    .slice(0, 30);

  if (!ids.length) {
    return { statusCode: 200, headers, body: JSON.stringify({ stats: {} }) };
  }

  try {
    const results = await Promise.all(ids.map(function(id) {
      return redisGet('ancestor:stats:' + id).then(function(data) { return { id: id, data: data }; });
    }));
    const stats = {};
    results.forEach(function(r) { stats[r.id] = (r.data && typeof r.data === 'object') ? r.data : null; });
    return { statusCode: 200, headers, body: JSON.stringify({ stats: stats }) };
  } catch(e) {
    return { statusCode: 500, headers, body: JSON.stringify({ error: e.message }) };
  }
};
