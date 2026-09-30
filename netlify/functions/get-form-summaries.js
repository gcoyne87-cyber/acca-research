const https = require('https');

const UPSTASH_URL = process.env.UPSTASH_REDIS_REST_URL;
const UPSTASH_TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN;

function redisGet(key) {
  const url = new URL(UPSTASH_URL);
  return new Promise((resolve, reject) => {
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
  const idsParam = (event.queryStringParameters || {}).horse_ids || '';
  const horseIds = idsParam.split(',').map(function(s) { return s.trim(); }).filter(Boolean);

  if (!horseIds.length) {
    return { statusCode: 200, headers, body: JSON.stringify({ summaries: {} }) };
  }

  // Dated key first: the text engine writes form-summary:{id}:{date} for the
  // card date (styleVersion 4, written for that race's course and distance);
  // the undated key from the older job is the fallback. Date comes from
  // ?date= when the client passes it, else the Irish racing date today.
  const dateParam = (event.queryStringParameters || {}).date || '';
  const dateStr = /^\d{4}-\d{2}-\d{2}$/.test(dateParam) ? dateParam : (function() {
    const parts = new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Dublin' }).formatToParts(new Date());
    const g = function(t) { const p = parts.find(function(x) { return x.type === t; }); return p ? p.value : ''; };
    return g('year') + '-' + g('month') + '-' + g('day');
  })();

  try {
    const results = await Promise.all(horseIds.map(function(id) {
      return redisGet('form-summary:' + id + ':' + dateStr).then(function(dated) {
        if (dated) return { id: id, data: dated };
        return redisGet('form-summary:' + id).then(function(data) { return { id: id, data: data }; });
      });
    }));

    const summaries = {};
    results.forEach(function(r) {
      if (!r.data) return;
      // Normalise: the client reads .summary — wrap any legacy plain-text
      // value so the shape is identical whether Redis holds the JSON object
      // ({summary, generatedAt, ...}) or an old bare string.
      summaries[r.id] = (typeof r.data === 'string') ? { summary: r.data } : r.data;
    });

    return { statusCode: 200, headers, body: JSON.stringify({ summaries: summaries }) };
  } catch(e) {
    return { statusCode: 500, headers, body: JSON.stringify({ error: e.message }) };
  }
};
