const https = require('https');

const SYSTEM_PROMPT = `You are an elite football accumulator research analyst. Find the best value selections by doing genuinely deep research.

YOU MUST WEB SEARCH EVERY FIXTURE before deciding. For each fixture search for:
1. Current form last 6 games HOME and AWAY separately
2. Injury and suspension news - search "[team] injury news March 2026"
3. Manager situation - sackings, new appointments, unrest?
4. What does each team NEED - promotion, relegation, nothing to play for?
5. H2H last 6 meetings
6. Goals scored and conceded home vs away

GOLDEN NUGGET FACTORS:
- Teams with nothing to play for AWAY - never back them
- New manager first home game - powerful signal  
- Revenge factor after heavy defeat in reverse fixture
- Losing top scorer AND creative player together
- Relegation battlers away - classic 0-0 trap

RULES:
- Home win or away win ONLY. Never draws.
- NEVER pick: relegation battler away, derby, 3+ key players missing, new interim with no prep
- 2 strong picks beats 6 weak ones
- Return [] if nothing genuinely stands out

Return ONLY a JSON array starting with [. No preamble. No markdown.

Each object:
{
  "fid": "fixture id",
  "home": "home team",
  "away": "away team",
  "ko": "kickoff e.g. 15:00",
  "selection": "team to back",
  "selectionType": "Home Win or Away Win",
  "confidence": 60-95,
  "odds": "e.g. 4/5",
  "formHome": "last 6 home e.g. W W D W L W",
  "formAway": "last 6 away e.g. L W L L D W",
  "reasons": ["reason 1", "reason 2", "reason 3"],
  "warnings": ["main warning"],
  "goldenNugget": "key insight a form guide would miss",
  "riskNote": "main risk in one sentence"
}`;

function callClaude(fixtures, date, label) {
  return new Promise((resolve, reject) => {
    const fixtureList = fixtures.map(f =>
      `ID:${f.id} | ${f.home} vs ${f.away} | ${f.leagueName} | ${date} | KO:${f.time || 'TBC'}`
    ).join('\n');

    const userMessage = `Research these ${fixtures.length} fixtures for ${label} on ${date}. Web search every fixture. Return best picks as JSON array only.\n\nFIXTURES:\n${fixtureList}`;

    const body = JSON.stringify({
      model: 'claude-sonnet-4-5',
      max_tokens: 3000,
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
          if (parsed.error) { reject(new Error(parsed.error.message)); return; }
          // Get ALL text blocks and combine them
          const allText = (parsed.content || [])
            .filter(b => b.type === 'text')
            .map(b => b.text)
            .join('\n');
          
          if (!allText) { 
            console.error('No text in response. Block types:', (parsed.content||[]).map(b=>b.type).join(','));
            resolve([]); 
            return; 
          }
          
          let text = allText.trim().replace(/```json\n?/g,'').replace(/```\n?/g,'').trim();
          
          // Find the LAST [ to ] in case there's preamble text
          const s = text.lastIndexOf('[');
          const e = text.lastIndexOf(']');
          
          if (s === -1 || e === -1 || e < s) { 
            console.error('No JSON array found. Full text:', text.substring(0,500)); 
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
    req.setTimeout(22000);
    req.write(body);
    req.end();
  });
}

exports.handler = async function(event) {
  const headers = {
    'Access-Control-Allow-Origin': '*',
    'Content-Type': 'application/json'
  };

  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 200, headers, body: '' };
  }

  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, headers, body: JSON.stringify({ error: 'Method not allowed' }) };
  }

  let body;
  try { body = JSON.parse(event.body); } catch(e) {
    return { statusCode: 400, headers, body: JSON.stringify({ error: 'Invalid JSON' }) };
  }

  const { fixtures, date, label } = body;
  if (!fixtures || !fixtures.length || !date) {
    return { statusCode: 400, headers, body: JSON.stringify({ error: 'fixtures and date required' }) };
  }

  console.log(`Analysing ${fixtures.length} fixtures for ${label} on ${date}`);

  try {
    const cards = await callClaude(fixtures, date, label);
    return { statusCode: 200, headers, body: JSON.stringify({ cards }) };
  } catch(e) {
    console.error('Failed:', e.message);
    return { statusCode: 500, headers, body: JSON.stringify({ error: e.message }) };
  }
};
