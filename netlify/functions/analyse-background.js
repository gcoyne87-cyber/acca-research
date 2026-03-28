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

const SYSTEM_PROMPT = `You are an expert football accumulator tipster. Use web search to research every fixture before making selections.

RESEARCH PROCESS for every fixture:
1. Search "[home team] [away team] form 2026"
2. Search "[home team] injuries March 2026"
3. Check league position and what each team needs
4. Check H2H record

WHAT TO LOOK FOR:
- Home sides with strong home records against teams with poor away form
- Teams fighting for promotion vs teams with nothing to play for away
- New manager bounce at home
- Away teams who never win away

WHAT TO AVOID:
- Local derbies
- Teams missing top scorer and main creative player simultaneously
- Very short prices under 4/6

Return ONLY a valid JSON array with no text before or after. No markdown. No explanation. Just the raw JSON array starting with [ and ending with ].

Each object in the array:
{"fid":"fixture id","home":"home team","away":"away team","ko":"kickoff","selection":"team to back","selectionType":"Home Win or Away Win","confidence":75,"odds":"4/5","formHome":"W W L W D W","formAway":"L L D L W L","reasons":["reason 1","reason 2","reason 3"],"warnings":["one warning"],"goldenNugget":"key insight","riskNote":"main risk"}`;

function callClaude(fixtures, date, label) {
  return new Promise((resolve, reject) => {
    const fixtureList = fixtures.map(f =>
      `ID:${f.id} | ${f.home} vs ${f.away} | ${f.leagueName} | ${date} | KO:${f.time || 'TBC'}`
    ).join('\n');

    const userMessage = `Analyse these ${fixtures.length} fixtures for ${label} on ${date}. Search the web for each one. Return ONLY a JSON array, nothing else.\n\n${fixtureList}`;

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

          // Get all text blocks
          const allText = (parsed.content || [])
            .filter(b => b.type === 'text')
            .map(b => b.text)
            .join('\n');

          console.log('Raw response length:', allText.length);
          console.log('Response preview:', allText.substring(0, 500));

          // Strip any markdown code fences
          let text = allText
            .replace(/```json\s*/gi, '')
            .replace(/```\s*/gi, '')
            .trim();

          // Find the JSON array - look for first [ and last ]
          const start = text.indexOf('[');
          const end = text.lastIndexOf(']');

          if (start === -1 || end === -1 || end <= start) {
            console.error('No JSON array found in response');
            console.error('Full text:', text);
            resolve([]);
            return;
          }

          const jsonStr = text.substring(start, end + 1);
          console.log('Extracted JSON length:', jsonStr.length);

          const cards = JSON.parse(jsonStr);
          console.log('Cards parsed:', cards.length);
          resolve(Array.isArray(cards) ? cards : []);

        } catch(err) {
          console.error('Parse error:', err.message);
          console.error('Data received length:', data.length);
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
