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

Each pick:
{
  "fid": "exact fixture ID from input",
  "home": "home team",
  "away": "away team",
  "ko": "kickoff time",
  "selection": "full team name to back",
  "selectionType": "Home Win or Away Win",
  "confidence": 65-92,
  "odds": "e.g. 4/5",
  "formHome": "last 6 home e.g. W W L W D W",
  "formAway": "last 6 away e.g. L L D L W L",
  "reasons": ["specific reason 1", "specific reason 2", "specific reason 3"],
  "warnings": ["one honest warning"],
  "goldenNugget": "the insight a standard form guide would miss",
  "riskNote": "main risk in one sentence"
}`;

function callClaude(fixtures, date, label) {
  return new Promise((resolve, reject) => {
    const fixtureList = fixtures.map(f =>
      `ID:${f.id} | ${f.home} vs ${f.away} | ${f.leagueName} | ${date} | KO:${f.time || 'TBC'}`
    ).join('\n');

    const userMessage = `Analyse these fixtures for ${label} on ${date}. Search the web for each one then return picks as JSON array.\n\n${fixtureList}`;

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
          if (parsed.error) { reject(new Error(parsed.error.message)); return; }
          const allText = (parsed.content || []).filter(b => b.type === 'text').map(b => b.text).join('\n');
          let text = allText.trim().replace(/```json\n?/g,'').replace(/```\n?/g,'').trim();
          const s = text.lastIndexOf('['), e = text.lastIndexOf(']');
          if (s === -1 || e === -1 || e < s) { console.error('No array found'); resolve([]); return; }
          const cards = JSON.parse(text.substring(s, e+1));
          console.log('Cards:', cards.length);
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
  let body;
  try { body = JSON.parse(event.body); } catch(e) { return; }
  const { jobId, fixtures, date, label } = body;
  if (!jobId || !fixtures || !date) return;

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
