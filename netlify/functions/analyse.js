const https = require('https');

module.exports.config = { timeout: 300 };

const SYSTEM_PROMPT = `You are an expert football accumulator tipster with years of experience finding value in English and European football leagues. You must use web search to research every fixture properly before making selections.

RESEARCH PROCESS — do this for every fixture:
1. Search "[home team] [away team] form 2026" — get last 5-6 results for each
2. Search "[home team] injuries March 2026" — check for missing players
3. Check league table position and what each team needs from the game
4. Check H2H record at this venue

WHAT TO LOOK FOR:
- Home sides with strong home records (4+ wins in last 6 at home) against teams with poor away form
- Teams fighting for promotion vs teams with nothing to play for away — massive edge
- New manager bounce at home — first few games under new manager at home ground
- Revenge factor — were they hammered in the reverse fixture?
- Teams just below the playoff spots who are desperate for points
- Away teams who never win away — some sides genuinely cannot win on the road

WHAT TO AVOID:
- Local derbies — always unpredictable regardless of form
- Teams missing their top scorer and main creative player simultaneously
- Genuine relegation battlers playing away — tend to park the bus and nick a draw
- Very short prices under 4/6 — not worth including in an acca

SELECTION STANDARD:
You are looking for the same quality selections that win accumulators regularly. On any given Saturday with 10+ English football fixtures there are typically 3-5 strong selections. Be confident. Back your research. The user trusts your judgement.

Return ONLY a valid JSON array. Start with [. End with ]. No text before or after.

Each pick must have:
{
  "fid": "exact fixture ID from the input",
  "home": "home team",
  "away": "away team",
  "ko": "kickoff time",
  "selection": "full team name to back",
  "selectionType": "Home Win or Away Win",
  "confidence": number between 65 and 92,
  "odds": "fractional odds e.g. 4/5 or 6/4",
  "formHome": "home team last 6 home games e.g. W W L W D W",
  "formAway": "away team last 6 away games e.g. L L D L W L",
  "reasons": ["specific detailed reason 1", "specific detailed reason 2", "specific detailed reason 3"],
  "warnings": ["one honest warning about this pick"],
  "goldenNugget": "the one insight that a standard form guide would miss — motivation, context, specific stats",
  "riskNote": "the main risk to this selection in one honest sentence"
}`;

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
