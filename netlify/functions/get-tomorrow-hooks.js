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

function redisCommand(commandArr) {
  const url = new URL(UPSTASH_URL);
  const body = JSON.stringify(commandArr);
  return new Promise((resolve, reject) => {
    const req = https.request({
      hostname: url.hostname,
      path: '/',
      method: 'POST',
      headers: {
        'Authorization': 'Bearer ' + UPSTASH_TOKEN,
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body)
      }
    }, res => {
      let d = '';
      res.on('data', c => d += c);
      res.on('end', () => {
        try { resolve(JSON.parse(d)); } catch(e) { reject(e); }
      });
    });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

function redisScan(cursor, pattern) {
  return redisCommand(['SCAN', cursor, 'MATCH', pattern, 'COUNT', '1000']).then(r => {
    const result = (r && r.result) || ['0', []];
    return { cursor: result[0], keys: result[1] || [] };
  });
}

async function scanAllKeys(pattern) {
  let cursor = '0';
  let allKeys = [];
  do {
    const { cursor: nextCursor, keys } = await redisScan(cursor, pattern);
    allKeys = allKeys.concat(keys);
    cursor = nextCursor;
  } while (cursor !== '0');
  return allKeys;
}

exports.handler = async function(event) {
  const headers = { 'Access-Control-Allow-Origin': '*', 'Content-Type': 'application/json' };

  try {
    const now = new Date();
    const tomorrow = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1);
    const y = tomorrow.getFullYear();
    const mo = String(tomorrow.getMonth() + 1).padStart(2, '0');
    const dy = String(tomorrow.getDate()).padStart(2, '0');
    const tomorrowDate = y + '-' + mo + '-' + dy;

    const prefix = 'hook:race:' + tomorrowDate + ':';
    const keys = await scanAllKeys(prefix + '*');

    const hooks = await Promise.all(keys.map(async function(key) {
      const raceHook = await redisGet(key);
      if (!raceHook) return null;
      const remainder = key.slice(prefix.length);
      const sep = remainder.indexOf(':');
      if (sep === -1) return null;
      const course = remainder.slice(0, sep);
      const time = remainder.slice(sep + 1);
      return {
        race: (course + ' ' + time).toLowerCase(),
        raceHook: raceHook
      };
    }));

    return {
      statusCode: 200,
      headers,
      body: JSON.stringify(hooks.filter(Boolean))
    };
  } catch(e) {
    return { statusCode: 500, headers, body: JSON.stringify({ error: e.message }) };
  }
};
