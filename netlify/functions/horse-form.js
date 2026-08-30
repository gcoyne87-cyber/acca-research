const https = require('https');

const UPSTASH_URL = process.env.UPSTASH_REDIS_REST_URL;
const UPSTASH_TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN;
const RACING_AUTH = Buffer.from(
  (process.env.RACING_API_USERNAME || '') + ':' + (process.env.RACING_API_KEY || '')
).toString('base64');

// History lookup tries every available source before giving up (dated cache
// key -> today's key -> any cached key for the horse -> one live Racing API
// call). A horse with previous runs must always get a form table, on any
// date — the dated-key-only lookup silently returned [] for future racecards
// whose overnight prefetch hadn't covered them (4+ days out, late
// declarations, a failed 23:00 cache build), showing the summary with no
// table. Only a horse with no runs anywhere returns empty. The summary
// lookup is unchanged: dated key only.

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

function redisSet(key, value) {
  if (!UPSTASH_URL || !UPSTASH_TOKEN) return Promise.resolve(null);
  const url = new URL(UPSTASH_URL);
  const body = JSON.stringify(value);
  return new Promise(resolve => {
    const req = https.request({
      hostname: url.hostname, path: '/set/' + encodeURIComponent(key), method: 'POST',
      headers: { 'Authorization': 'Bearer ' + UPSTASH_TOKEN, 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) }
    }, res => { let d = ''; res.on('data', c => d += c); res.on('end', () => resolve(d)); });
    req.on('error', () => resolve(null)); req.write(body); req.end();
  });
}

// SCAN for every form:history key this horse has, any date. Query params are
// safe here (unlike NX) because MATCH and COUNT genuinely take an argument
// each. Iteration is capped as a runaway guard — worst case the caller just
// falls through to the live API tier.
function redisScanKeys(pattern) {
  if (!UPSTASH_URL || !UPSTASH_TOKEN) return Promise.resolve([]);
  const url = new URL(UPSTASH_URL);
  function scanPage(cursor) {
    return new Promise(resolve => {
      const req = https.request({
        hostname: url.hostname,
        path: '/scan/' + cursor + '?match=' + encodeURIComponent(pattern) + '&count=1000',
        method: 'GET',
        headers: { 'Authorization': 'Bearer ' + UPSTASH_TOKEN }
      }, res => {
        let d = '';
        res.on('data', c => d += c);
        res.on('end', () => {
          try { const r = JSON.parse(d); resolve(Array.isArray(r.result) ? r.result : ['0', []]); }
          catch(e) { resolve(['0', []]); }
        });
      });
      req.on('error', () => resolve(['0', []]));
      req.end();
    });
  }
  return (async () => {
    let cursor = '0';
    const keys = [];
    for (let i = 0; i < 60; i++) {
      const page = await scanPage(cursor);
      (page[1] || []).forEach(k => keys.push(k));
      cursor = String(page[0] || '0');
      if (cursor === '0') break;
    }
    return keys;
  })();
}

// Same call and same mapping the daily build's fetchHorseHistory makes —
// including the race.class || race.race_class fallback.
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

async function lookupHistory(horse_id, targetDate, today) {
  // 1. The dated key, exactly as before
  let h = await redisGet('form:history:' + horse_id + ':' + targetDate);
  if (Array.isArray(h) && h.length) return h;

  // 2. Today's key
  if (targetDate !== today) {
    h = await redisGet('form:history:' + horse_id + ':' + today);
    if (Array.isArray(h) && h.length) return h;
  }

  // 3. Any dated key this horse has — most recent date first (YYYY-MM-DD
  // suffixes sort chronologically as strings)
  try {
    const keys = await redisScanKeys('form:history:' + horse_id + ':*');
    keys.sort().reverse();
    for (const k of keys) {
      h = await redisGet(k);
      if (Array.isArray(h) && h.length) return h;
    }
  } catch(e) { /* scan failure falls through to the live call */ }

  // 4. One live Racing API call — the daily build's exact fetch and mapping.
  // The result is cached under the dated key (fire-and-forget) so the next
  // open of this horse is a tier-1 hit.
  try {
    const data = await apiGetRacing('/v1/horses/' + encodeURIComponent(horse_id) + '/results?limit=6');
    const history = (data.results || []).map(race => {
      const runner = (race.runners || []).find(r => r.horse_id === horse_id) || {};
      return {
        date: race.date || '',
        course: race.course || '',
        dist: race.dist || '',
        going: race.going || '',
        pos: runner.position || '-',
        ran: (race.runners || []).length || 0,
        sp: runner.sp || '',
        jockey: runner.jockey || '',
        race_class: race.class || race.race_class || ''
      };
    });
    if (history.length) {
      // Fire-and-forget — redisSet resolves (never rejects) on failure.
      redisSet('form:history:' + horse_id + ':' + targetDate, history);
      return history;
    }
  } catch(e) { /* no runs anywhere, or API down — empty is now genuinely empty */ }

  return [];
}

exports.handler = async function(event) {
  const headers = { 'Access-Control-Allow-Origin': '*', 'Content-Type': 'application/json' };
  if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers, body: '' };

  const { horse_id, date } = event.queryStringParameters || {};
  if (!horse_id) {
    return { statusCode: 400, headers, body: JSON.stringify({ error: 'horse_id required' }) };
  }

  const today = new Date().toISOString().slice(0, 10);
  const targetDate = date && /^\d{4}-\d{2}-\d{2}$/.test(date) ? date : today;

  const [summary, history] = await Promise.all([
    redisGet('form:summary:' + horse_id + ':' + targetDate),
    lookupHistory(horse_id, targetDate, today)
  ]);

  return {
    statusCode: 200,
    headers,
    body: JSON.stringify({ history: history || [], summary: summary || null })
  };
};
