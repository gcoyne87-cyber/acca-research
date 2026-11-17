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

// Read-only view of the feed youtube-feed-background.js maintains.
exports.handler = async function() {
  const headers = { 'Access-Control-Allow-Origin': '*', 'Content-Type': 'application/json' };
  try {
    const [feed, meta, transcribed] = await Promise.all([redisGet('youtube:feed'), redisGet('youtube:feed:meta'), redisGet('youtube:transcribed')]);
    const transcribedIds = Array.isArray(transcribed) ? transcribed : [];
    if (!Array.isArray(feed)) {
      return { statusCode: 200, headers, body: JSON.stringify({ status: 'loading', videos: [], meta: meta || null, transcribedIds }) };
    }
    return { statusCode: 200, headers, body: JSON.stringify({ status: 'done', count: feed.length, videos: feed, meta: meta || null, transcribedIds }) };
  } catch(e) {
    return { statusCode: 500, headers, body: JSON.stringify({ status: 'error', error: e.message }) };
  }
};
