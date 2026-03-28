const https = require('https');

const UPSTASH_URL = process.env.UPSTASH_REDIS_REST_URL;
const UPSTASH_TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN;

async function redisSet(key, value) {
  const body = JSON.stringify(['SET', key, JSON.stringify(value), 'EX', 3600]);
  return new Promise((resolve, reject) => {
    const url = new URL(UPSTASH_URL);
    const req = https.request({
      hostname: url.hostname,
      path: '/',
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${UPSTASH_TOKEN}`,
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body)
      }
    }, res => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => resolve(JSON.parse(data)));
    });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

const SYSTEM_PROMPT = `You are a football accumulator analyst. Your ONLY job is to output a JSON array of picks.

RULES:
- You MUST return a JSON array even if empty: []
- NEVER write any text outside the JSON array
- NEVER explain your reasoning outside the JSON
- NEVER refuse to return JSON
- If you have no picks, return: []
- If you have picks, return them in the array

For each fixture you want to pick, add an object to the array:
{"fid":"ID from input","home":"home team","away":"away team","ko":"kickoff time","selection":"team name","selectionType":"Home Win or Away Win","confidence":75,"odds":"4/5","formHome":"W W L W D W","formAway":"L L D L W L","reasons":["reason 1","reason 2","reason 3"],"warnings":["warning"],"goldenNugget":"key insight","riskNote":"main risk"}

Use web search to research form and injuries before picking. Only pick fixtures where you see clear value. Skip fixtures with no clear edge. But ALWAYS end your response with the JSON array — even if it is just [].`;

function callClaude(fixtures, date, label) {
  return new Promise((resolve, reject) => {
    const fixtureList = fixtures.map(f =>
      `ID:${f.id} | ${f.home} vs ${f.away} | ${f.leagueName} | ${date} | KO:${f.time || 'TBC'}`
    ).join('\n');

    const userMessage = `Research these fixtures for ${label} on ${date} and return your picks as a JSON array. Remember: your response MUST end with a valid JSON array starting with [ and ending with ].\n\n${fixtureList}`;

    const body = JSON.stringify({
      model: 'claude-sonnet-4-5',
      max_tokens: 8000,
      tools: [{ type: 'web_search_20250305', name: 'web_search' }],
      system: SYSTEM_PROMPT,
      messages: [{ role: 'user', content: userMessage }]
    });

    const options = {
      hostname: 'api.anthropic.com',
      path: '/v1/messages',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body),
        'x-api-key': process.env.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01'
      }
    };

    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          const parsed = JSON.parse(data);
          if (parsed.error) {
            console.error('Claude API error:', parsed.error.message);
            reject(new Error(parsed.error.message));
            return;
          }
          const allText = (parsed.content || [])
            .filter(b => b.type === 'text')
            .map(b => b.text)
            .join('\n');
          console.log('Raw response length:', allText.length);
          console.log('Response preview:', allText.substring(0, 300));
          let text = allText
            .replace(/```json\s*/gi, '')
            .replace(/```\s*/gi, '')
            .trim();
          const start = text.indexOf('[');
          const end = text.lastIndexOf(']');
          if (start === -1 || end === -1 || end <= start) {
            console.error('No JSON array found — returning empty');
            resolve([]);
            return;
          }
          const jsonStr = text.substring(start, end + 1);
          console.log('Extracted JSON length:', jsonStr.length);
          try {
            const cards = JSON.parse(jsonStr);
            console.log('Cards parsed:', cards.length);
            resolve(Array.isArray(cards) ? cards : []);
          } catch(parseErr) {
            console.error('JSON parse error:', parseErr.message);
            resolve([]);
          }
        } catch(err) {
          console.error('Response parse error:', err.message);
          resolve([]);
        }
      });
    });
    req.on('error', reject);
    req.setTimeout(840000);
    req.write(body);
    req.end();
  });
}

exports.handler = async function(event) {
  let body;
  try {
    body = JSON.parse(event.body);
  } catch(e) {
    console.error('Bad request body');
    return;
  }
  const { jobId, fixtures, date, label } = body;
  if (!jobId || !fixtures || !date) {
    console.error('Missing fields');
    return;
  }
  console.log(`Job ${jobId}: ${fixtures.length} fixtures for ${label}`);
  try {
    await redisSet(jobId, { status: 'loading' });
    const cards = await callClaude(fixtures, date, label);
    await redisSet(jobId, { status: 'done', cards });
    console.log(`Job ${jobId}: done, ${cards.length} cards`);
  } catch(e) {
    console.error(`Job ${jobId} error:`, e.message);
    try { await redisSet(jobId, { status: 'error' }); } catch(e2) {}
  }
};
