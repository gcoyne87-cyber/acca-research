const https = require('https');

// Hide one video from the private feed page: POST { videoId } adds the id to
// youtube:hidden. get-youtube-feed.js returns that list as hiddenIds (the
// page filters on it) and youtube-feed-background.js drops hidden ids at
// merge time, so a hidden video never comes back.
//
// Deliberately NO secret: the caller is a static page, and a secret shipped
// in page source is not a secret. The only thing this endpoint can do is add
// an id to the hidden list of a private, unlisted page.

const UPSTASH_URL = process.env.UPSTASH_REDIS_REST_URL;
const UPSTASH_TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN;

const HIDDEN_KEY = 'youtube:hidden';
const HIDDEN_CAP = 500;

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
        if (res.statusCode !== 200) return reject(new Error('Redis read failed: HTTP ' + res.statusCode));
        try {
          const r = JSON.parse(d);
          resolve(r.result ? JSON.parse(r.result) : null);
        } catch(e) { reject(new Error('Redis read parse error')); }
      });
    });
    req.on('error', reject);
    req.end();
  });
}

function redisSet(key, value) {
  const url = new URL(UPSTASH_URL);
  const body = JSON.stringify(value);
  return new Promise((resolve, reject) => {
    const req = https.request({
      hostname: url.hostname,
      path: '/set/' + encodeURIComponent(key),
      method: 'POST',
      headers: { 'Authorization': 'Bearer ' + UPSTASH_TOKEN, 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) }
    }, res => {
      let d = '';
      res.on('data', c => d += c);
      res.on('end', () => {
        if (res.statusCode !== 200) return reject(new Error('Redis write failed: HTTP ' + res.statusCode));
        try { const p = JSON.parse(d); if (p && p.error) return reject(new Error('Redis write error: ' + p.error)); } catch(e) {}
        resolve();
      });
    });
    req.on('error', reject);
    req.write(body); req.end();
  });
}

exports.handler = async function(event) {
  const headers = { 'Access-Control-Allow-Origin': '*', 'Content-Type': 'application/json' };
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, headers, body: JSON.stringify({ status: 'error', error: 'POST only' }) };
  }

  let videoId = '';
  try { videoId = String((JSON.parse(event.body || '{}') || {}).videoId || ''); } catch(e) {}
  // A YouTube video id is 11 characters of A-Z a-z 0-9 _ -; nothing else is stored.
  if (!/^[A-Za-z0-9_-]{11}$/.test(videoId)) {
    return { statusCode: 400, headers, body: JSON.stringify({ status: 'error', error: 'Invalid videoId' }) };
  }

  try {
    // A failed read rejects rather than resolving null, so a Redis blip can
    // never be mistaken for an empty list and wipe the existing hidden ids.
    const stored = await redisGet(HIDDEN_KEY);
    const list = Array.isArray(stored) ? stored : [];
    if (list.indexOf(videoId) === -1) {
      list.push(videoId);
      await redisSet(HIDDEN_KEY, list.slice(-HIDDEN_CAP));
    }
    return { statusCode: 200, headers, body: JSON.stringify({ status: 'done', videoId, hiddenCount: Math.min(list.length, HIDDEN_CAP) }) };
  } catch(e) {
    return { statusCode: 500, headers, body: JSON.stringify({ status: 'error', error: e.message }) };
  }
};
