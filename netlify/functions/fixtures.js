const https = require('https');

exports.handler = async function(event) {
  const API_KEY = '4876fc6e82fa43210ee8dc53214f000d';
  const { league, date, season } = event.queryStringParameters || {};
  const url = 'https://v3.football.api-sports.io/fixtures?league=' + league + '&date=' + date + '&season=' + '2025';

  return new Promise((resolve) => {
    const req = https.get(url, {
      headers: { 'x-apisports-key': API_KEY }
    }, (res) => {
      let body = '';
      res.on('data', chunk => body += chunk);
      res.on('end', () => {
        resolve({
          statusCode: 200,
          headers: { 'Access-Control-Allow-Origin': '*', 'Content-Type': 'application/json' },
          body: body
        });
      });
    });
    req.on('error', (e) => {
      resolve({ statusCode: 500, body: JSON.stringify({ error: e.message }) });
    });
  });
};
