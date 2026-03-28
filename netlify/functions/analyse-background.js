const https = require('https');
const { getStore } = require('@netlify/blobs');

const SYSTEM_PROMPT = `You are an elite football accumulator research analyst. Your entire purpose is to find the best value selections from football fixtures by doing genuinely deep research.

YOU MUST WEB SEARCH EVERY SINGLE FIXTURE before making any decision. No exceptions. For each fixture search for:
1. Current form last 6 games HOME and AWAY separately
2. Injury and suspension news
3. Manager situation — sackings, new appointments, unrest?
4. What does each team NEED — promotion, relegation, nothing to play for?
5. H2H last 6 meetings home/away breakdown
6. Goals scored and conceded home vs away patterns
7. Fixture congestion, international call-ups, fatigue?

GOLDEN NUGGET FACTORS:
- Teams with nothing to play for AWAY — classic 0-0 trap, never back them
- New manager bounce — first home game under new boss is powerful
- Revenge factor — hammered in the reverse fixture?
- Losing top scorer AND creative player together
- Away sides with exceptional away records being underestimated
- Relegation six-pointer — both desperate, unpredictable

SELECTION RULES:
- Home win or away win ONLY. Never draws.
- NEVER select: relegation battler away, derby matches, 3+ key players missing, new interim manager with no prep time, nothing to play for away
- Short prices under evens only with overwhelming justification
- 2 strong picks beats 6 weak ones
- If nothing stands out after thorough research, return []

OUTPUT: JSON array only. Start with [. No preamble. No markdown.

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
  "goldenNugget": "the key insight a form guide would miss",
  "riskNote": "main risk in one sentence"
}`;

function callClaude(fixtures, date, label) {
  return new Promise((resolve, reject) => {
    const fixtureList = fixtures.map(f =>
      `ID:${f.id} | ${f.home} vs ${f.away} | ${f.leagueName} | ${date} | KO:${f.time || 'TBC'}`
    ).join('\n');

    const userMessage = `Research and analyse these ${fixtures.length} fixtures for ${label} on ${date}. Use web_search for EVERY fixture. Take as long as needed. Return best picks as JSON array only.\n\nFIXTURES:\n${fixtureList}`;

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
          if (parsed.error) { reject(new Error(parsed.error.message)); return; }
          const textBlock = (parsed.content || []).find(b => b.type === 'text');
          if (!textBlock) { resolve([]); return; }
          let text = textBlock.text.trim().replace(/```json\n?/g,'').replace(/```\n?/g,'').trim();
          const s = text.indexOf('['), e = text.lastIndexOf(']');
          if (s === -1 || e === -1) { console.error('No array found:', text.substring(0,200)); resolve([]); return; }
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
    req.setTimeout(840000);
    req.write(body);
    req.end();
  });
}

exports.handler = async function(event) {
  const store = getStore('analysis-results');
  let body;
  try { body = JSON.parse(event.body); } catch(e) { console.error('Bad body'); return; }
  const { jobId, fixtures, date, label } = body;
  if (!jobId || !fixtures || !date) { console.error('Missing fields'); return; }

  console.log(`Job ${jobId}: ${fixtures.length} fixtures for ${label} on ${date}`);
  try {
    await store.setJSON(jobId, { status: 'loading', cards: [], label, date });
    const cards = await callClaude(fixtures, date, label);
    await store.setJSON(jobId, { status: 'done', cards, label, date });
    console.log(`Job ${jobId}: Done. ${cards.length} cards.`);
  } catch(e) {
    console.error(`Job ${jobId} failed:`, e.message);
    try { await store.setJSON(jobId, { status: 'error', cards: [], label, date }); } catch(e2) {}
  }
};
