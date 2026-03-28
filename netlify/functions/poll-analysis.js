const https = require('https');

const UPSTASH_URL = process.env.UPSTASH_REDIS_REST_URL;
const UPSTASH_TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN;

async function redisGet(key) {
  return new Promise((resolve, reject) => {
    const url = new URL(UPSTASH_URL);
    const path = `/get/${encodeURIComponent(key)}`;
    const req = https.request({
      hostname: url.hostname,
      path,
      method: 'GET',
      headers: { 'Authorization': `Bearer ${UPSTASH_TOKEN}` }
    }, res => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => {
        try {
          const parsed = JSON.parse(data);
          if (parsed.result) resolve(JSON.parse(parsed.result));
          else resolve(null);
        } catch(e) { resolve(null); }
      });
    });
    req.on('error', reject);
    req.end();
  });
}

exports.handler = async function(event) {
  const headers = { 'Access-Control-Allow-Origin': '*', 'Content-Type': 'application/json' };
  const jobId = event.queryStringParameters && event.queryStringParameters.jobId;
  if (!jobId) return { statusCode: 400, headers, body: JSON.stringify({ error: 'jobId required' }) };

  try {
    const result = await redisGet(jobId);
    if (!result) return { statusCode: 200, headers, body: JSON.stringify({ status: 'loading' }) };
    return { statusCode: 200, headers, body: JSON.stringify(result) };
  } catch(e) {
    return { statusCode: 200, headers, body: JSON.stringify({ status: 'loading' }) };
  }
};
