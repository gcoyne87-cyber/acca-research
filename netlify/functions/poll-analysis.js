const https = require('https');

const UPSTASH_URL = process.env.UPSTASH_REDIS_REST_URL;
const UPSTASH_TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN;

exports.handler = async function(event) {
  const headers = { 'Access-Control-Allow-Origin': '*', 'Content-Type': 'application/json' };
  const jobId = event.queryStringParameters && event.queryStringParameters.jobId;
  if (!jobId) return { statusCode: 400, headers, body: JSON.stringify({ status: 'loading' }) };

  try {
    const url = new URL(UPSTASH_URL);
    const result = await new Promise((resolve, reject) => {
      const req = https.request({
        hostname: url.hostname,
        path: '/get/' + jobId,
        method: 'GET',
        headers: { 'Authorization': 'Bearer ' + UPSTASH_TOKEN }
      }, res => {
        let data = '';
        res.on('data', c => data += c);
        res.on('end', () => {
          try {
            const parsed = JSON.parse(data);
            console.log('Redis raw result for', jobId, ':', data.substring(0, 200));
            if (parsed.result) {
              resolve(JSON.parse(parsed.result));
            } else {
              resolve(null);
            }
          } catch(e) {
            console.error('Parse error:', e.message, 'Raw:', data.substring(0, 200));
            resolve(null);
          }
        });
      });
      req.on('error', reject);
      req.end();
    });

    if (!result) return { statusCode: 200, headers, body: JSON.stringify({ status: 'loading' }) };
    return { statusCode: 200, headers, body: JSON.stringify(result) };

  } catch(e) {
    console.error('Error:', e.message);
    return { statusCode: 200, headers, body: JSON.stringify({ status: 'loading' }) };
  }
};
