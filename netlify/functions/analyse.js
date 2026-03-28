const https = require('https');

module.exports.config = { timeout: 300 };

const SYSTEM_PROMPT = `You are an expert football accumulator analyst. You have web search available. Use it.

For EVERY fixture in the list, search the web for:
- Recent form (last 5 results, home and away split)
- Any injuries or suspensions
- Manager news
- League position and what they need from the game

Then pick the best selections. You should find picks in most batches — if you are looking at 3-5 English football fixtures on a Saturday there will almost always be at least one good selection.

Selection criteria:
- Back strong home sides with good home records against teams with poor away form
- Back motivated sides (promotion push, avoiding relegation) vs teams with nothing to play for
- Avoid: derbies, teams missing multiple key players, new managers with no prep time
- Home win or away win only — no draws

ALWAYS return a JSON array. Never return empty array unless every single fixture is genuinely unbackable after research.

Format — return ONLY this JSON array, no other text:
[
  {
    "fid": "fixture id from the list",
    "home": "home team name",
    "away": "away team name",
    "ko": "kickoff time",
    "selection": "team name to back",
    "selectionType": "Home Win or Away Win",
    "confidence": 75,
    "odds": "4/5",
    "formHome": "W W D W L W",
    "formAway": "L D L W L D",
    "reasons": ["reason 1 with real detail", "reason 2 with real detail", "reason 3 with real detail"],
    "warnings": ["one honest warning"],
    "goldenNugget": "the insight that makes this stand out — something a form guide would miss",
    "riskNote": "main risk in one sentence"
  }
]`;

function callClaude(fixtures, date, label) {
  return new Promise((resolve, reject) => {
    const fixtureList = fixtures.map(f =>
      `ID:${f.id} | ${f.home} vs ${f.away} | ${f.leagueName} | ${date} | KO:${f.time || 'TBC'}`
    ).join('\n');

    const userMessage = `Analyse these fixtures for ${label} on ${date}. Search the web for each one, then return your picks as a JSON array.\n\n${fixtureList}`;

    const body = JSON.stringify({
      model: 'claude-sonnet-4-5',
      max_tokens: 4000,
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
            console.error('API error:', JSON.stringify(parsed.error));
            reject(new Error(parsed.error.message)); 
            return; 
          }
          const allText = (parsed.content || [])
            .filter(b => b.type === 'text')
            .map(b => b.text)
            .join('\n');
          console.log('Response text preview:', allText.substring(0, 300));
          let text = allText.trim().replace(/```json\n?/g,'').replace(/```\n?/g,'').trim();
          const s = text.lastIndexOf('[');
          const e = text.lastIndexOf(']');
          if (s === -1 || e === -1 || e < s) { 
            console.error('No JSON array found');
            resolve([]); 
            return; 
          }
          const cards = JSON.parse(text.substring(s, e+1));
          console.log('Cards returned:', cards.length);
          resolve(Array.isArray(cards) ? cards : []);
        } catch(err) {
          console.error('Parse error:', err.message);
          resolve([]);
        }
      });
    });
    req.on('error', reject);
    req.setTimeout(290000);
    req.write(body);
    req.end();
  });
}

exports.handler = async function(event) {
  const headers = { 'Access-Control-Allow-Origin': '*', 'Content-Type': 'application/json' };
  if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers, body: '' };
  if (event.httpMethod !== 'POST') return { statusCode: 405, headers, body: JSON.stringify({ error: 'Method not allowed' }) };

  let body;
  try { body = JSON.parse(event.body); } catch(e) {
    return { statusCode: 400, headers, body: JSON.stringify({ error: 'Invalid JSON' }) };
  }

  const { fixtures, date, label } = body;
  if (!fixtures || !fixtures.length || !date) {
    return { statusCode: 400, headers, body: JSON.stringify({ error: 'Missing fields' }) };
  }

  console.log(`Analysing ${fixtures.length} fixtures for ${label} on ${date}`);

  try {
    const cards = await callClaude(fixtures, date, label);
    return { statusCode: 200, headers, body: JSON.stringify({ cards }) };
  } catch(e) {
    console.error('Error:', e.message);
    return { statusCode: 500, headers, body: JSON.stringify({ error: e.message }) };
  }
};
