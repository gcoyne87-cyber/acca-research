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
  const today = new Date().toISOString().slice(0, 10);
  const dateParam = (event.queryStringParameters || {}).date;
  const tableDate = dateParam && /^\d{4}-\d{2}-\d{2}$/.test(dateParam) ? dateParam : today;

  try {
    let table = await redisGet('trainer-form:table:' + tableDate);
    // Yesterday fallback: the table is written by the ~10:30 daily build, so
    // before it lands each morning (and on a failed-build day) today's key is
    // empty and the section showed "Trainer form data updates daily". A
    // trainer's 14-day/7-day form barely moves overnight — yesterday's table
    // is honest data, so serve it rather than nothing. Applied only for the
    // default today request; an explicit ?date= gets exactly that date.
    if ((!Array.isArray(table) || !table.length) && tableDate === today) {
      const y = new Date(Date.now() - 86400000).toISOString().slice(0, 10);
      const ytable = await redisGet('trainer-form:table:' + y);
      if (Array.isArray(ytable) && ytable.length) table = ytable;
    }
    return {
      statusCode: 200,
      headers,
      body: JSON.stringify(Array.isArray(table) ? table : [])
    };
  } catch(e) {
    return { statusCode: 200, headers, body: JSON.stringify([]) };
  }
};
