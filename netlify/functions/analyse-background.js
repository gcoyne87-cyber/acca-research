const https = require('https');

const SYSTEM_PROMPT = `You are an elite football accumulator research analyst with access to web search. Your entire purpose is to find the best value selections from football fixtures by doing genuinely deep research — not surface-level form guides.

YOU MUST WEB SEARCH EVERY SINGLE FIXTURE before making any decision. No exceptions. Search for:
1. Current form last 6 games HOME and AWAY separately
2. Injury and suspension news (search "[team] injury news [current month]")
3. Manager situation — any sackings, new appointments, unrest?
4. What does each team NEED from this game — promotion push, relegation battle, nothing to play for?
5. H2H last 6 meetings with home/away breakdown
6. Recent goals scored and conceded patterns
7. Any midweek fatigue, fixture congestion, international call-ups?
8. Referee assigned if known — booking/card tendencies

GOLDEN NUGGET FACTORS (what separates you from any form guide website):
- Teams with nothing to play for AWAY from home — classic 0-0 trap, never back them
- New manager bounce — first home game under new manager is powerful
- Revenge factor — were they hammered 4-0 in the reverse fixture?
- Teams where the ODDS do not reflect the true probability (value bets)
- Specific absences — not just "injuries" but losing the top scorer AND creative player together
- Teams on a long unbeaten run that are due a slip vs a genuinely strong opponent
- Away sides with exceptional away records that are being underestimated by the market
- Relegation six-pointer dynamics — both teams desperate, unpredictable

SELECTION RULES:
- Home win or away win ONLY. Never draws.
- NEVER select: relegation battler away from home, derby matches, teams missing 3+ key players in their selection, sides with new interim managers with no preparation time
- Short prices (under evens) only with overwhelming justification
- Always flag the single biggest risk to each selection honestly

OUTPUT: Return a JSON array of your picks. Include every fixture you are recommending. If after thorough research you genuinely have no confident picks, return []. But you must search every fixture first.

Each object must have exactly these fields:
{
  "fid": "fixture id string",
  "home": "home team name",
  "away": "away team name", 
  "ko": "kickoff time e.g. 15:00",
  "selection": "team name to back",
  "selectionType": "Home Win or Away Win",
  "confidence": number 60-95,
  "odds": "your fair value odds e.g. 4/5",
  "formHome": "home team last 6 home results e.g. W W D W L W",
  "formAway": "away team last 6 away results e.g. L W L L D W",
  "reasons": ["detailed reason 1", "detailed reason 2", "detailed reason 3"],
  "warnings": ["main warning or risk factor"],
  "goldenNugget": "the single factor a standard form guide would miss that makes this a pick",
  "riskNote": "the main risk to this selection in one honest sentence"
}

Return ONLY the JSON array. No preamble. No explanation. Start with [ and end with ].`;

function callClaude(fixtures, date, label) {
  return new Promise((resolve, reject) => {
    const fixtureList = fixtures.map(f =>
      `ID:${f.id} | ${f.home} vs ${f.away} | ${f.leagueName} | ${date} | KO:${f.time || 'TBC'}`
    ).join('\n');

    const userMessage = `Research and analyse these ${fixtures.length} football fixtures for ${label} on ${date}.

You must use web_search to look up current form, injuries, manager news and context for EVERY fixture before deciding.

FIXTURES TO RESEARCH:
${fixtureList}

Search each fixture. Take your time. Then return your best picks as a JSON array only.`;

    const body = JSON.stringify({
      model: 'claude-sonnet-4-5',
      max_tokens: 8000,
      tools: [{
        type: 'web_search_20250305',
        name: 'web_search'
      }],
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
            console.error('API error:', parsed.error);
            reject(new Error(parsed.error.message || 'API error'));
            return;
          }
          const textBlock = (parsed.content || []).find(b => b.type === 'text');
          if (!textBlock) {
            console.error('No text block in response. Content types:', (parsed.content||[]).map(b=>b.type));
            resolve([]);
            return;
          }
          let text = textBlock.text.trim();
          text = text.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim();
          const arrayStart = text.indexOf('[');
          const arrayEnd = text.lastIndexOf(']');
          if (arrayStart === -1 || arrayEnd === -1) {
            console.error('No JSON array in response. Text preview:', text.substring(0, 300));
            resolve([]);
            return;
          }
          const cards = JSON.parse(text.substring(arrayStart, arrayEnd + 1));
          console.log('Analysis complete. Cards returned:', cards.length);
          resolve(Array.isArray(cards) ? cards : []);
        } catch (e) {
          console.error('Parse error:', e.message);
          console.error('Raw:', data.substring(0, 500));
          resolve([]);
        }
      });
    });

    req.on('error', reject);
    req.setTimeout(600000); // 10 minute socket timeout
    req.write(body);
    req.end();
  });
}

// Background function handler — runs async, no timeout constraint
exports.handler = async function(event) {
  // Handle CORS preflight
  if (event.httpMethod === 'OPTIONS') {
    return {
      statusCode: 200,
      headers: {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Headers': 'Content-Type',
        'Access-Control-Allow-Methods': 'POST, OPTIONS'
      },
      body: ''
    };
  }

  if (event.httpMethod !== 'POST') {
    return {
      statusCode: 405,
      headers: { 'Access-Control-Allow-Origin': '*' },
      body: JSON.stringify({ error: 'Method not allowed' })
    };
  }

  let body;
  try {
    body = JSON.parse(event.body);
  } catch (e) {
    return {
      statusCode: 400,
      headers: { 'Access-Control-Allow-Origin': '*', 'Content-Type': 'application/json' },
      body: JSON.stringify({ error: 'Invalid JSON' })
    };
  }

  const { fixtures, date, label } = body;
  if (!fixtures || !fixtures.length || !date) {
    return {
      statusCode: 400,
      headers: { 'Access-Control-Allow-Origin': '*', 'Content-Type': 'application/json' },
      body: JSON.stringify({ error: 'fixtures, date and label required' })
    };
  }

  console.log(`Starting analysis: ${fixtures.length} fixtures for ${label} on ${date}`);

  try {
    const cards = await callClaude(fixtures, date, label);
    return {
      statusCode: 200,
      headers: { 'Access-Control-Allow-Origin': '*', 'Content-Type': 'application/json' },
      body: JSON.stringify({ cards })
    };
  } catch (e) {
    console.error('Analysis failed:', e.message);
    return {
      statusCode: 500,
      headers: { 'Access-Control-Allow-Origin': '*', 'Content-Type': 'application/json' },
      body: JSON.stringify({ error: 'Analysis failed: ' + e.message })
    };
  }
};
