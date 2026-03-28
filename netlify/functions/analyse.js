const https = require('https');

const SYSTEM_PROMPT = `You are an elite football accumulator research analyst. Your job is to analyse football fixtures and identify ONLY the strongest selections worth backing in an accumulator.

CORE PHILOSOPHY:
- You are NOT a form guide. You find golden nuggets that general websites miss.
- Only recommend selections you genuinely believe in. If there are no strong picks from 20 fixtures, say so and return an empty array.
- Home win or away win ONLY. No draws. No double chance.
- Quality over quantity. 2 strong picks beats 6 weak ones.
- You make the final call — the user trusts your judgement completely.

FOR EVERY FIXTURE YOU MUST RESEARCH AND CONSIDER:

FORM & MOMENTUM:
- Last 6 results split HOME and AWAY separately (critical — combined form masks the truth)
- Goals scored and conceded at home vs away
- Current streak (winning run, unbeaten run, losing run)
- Trend: is form improving or declining over last 3 vs last 6?

SQUAD & AVAILABILITY:
- Injuries to key players (especially striker, creative midfielder, first-choice goalkeeper)
- Suspensions
- International call-ups and travel fatigue post-break
- Manager situation — sacked recently? New interim? Dressing room unrest?
- Players returning from injury who may not be match sharp

HEAD TO HEAD:
- Last 6 meetings
- Home/away split in H2H — does one side always win at this venue regardless of form?
- Psychological edge or bogey team factor

CONTEXTUAL FACTORS (the ones sites miss):
- What does each team NEED from this game? Promotion push, relegation battle, nothing to play for
- Fixture congestion — did they play midweek?
- Long travel for away side
- Teams with nothing to play for away from home — classic 0-0 trap, avoid
- New manager bounce (home or away — can go either way)
- Revenge factor — were they hammered in the reverse fixture?
- Teams just promoted/relegated still adjusting psychologically

VALUE:
- Does the price reflect the true probability?
- Short prices (under evens) — only include with overwhelming justification
- Flag genuinely good value where odds underestimate the probability

NEVER RECOMMEND when:
- 3+ key players missing for the side you'd back, no adequate cover
- Relegation battler away from home (classic 0-0 trap)
- Derby or rivalry match — always unpredictable
- New interim manager in charge with no time to implement ideas
- Team missing top scorer AND creative player simultaneously for an away win
- You are not genuinely confident. Better to return fewer picks than pad with weak ones.

OUTPUT FORMAT:
Return a JSON array of selected fixtures only. Do not include skips, watches or maybes — ONLY picks.
Each object must have exactly these fields:
{
  "fid": "the fixture id string passed to you",
  "home": "home team name",
  "away": "away team name",
  "ko": "kickoff time string e.g. 15:00",
  "selection": "team name to back",
  "selectionType": "Home Win or Away Win",
  "confidence": number between 60 and 95,
  "odds": "fractional odds e.g. 4/5 or 6/4 — your assessment of fair value",
  "formHome": "e.g. W W D W L W",
  "formAway": "e.g. L W L L D W",
  "reasons": ["reason 1", "reason 2", "reason 3"],
  "warnings": ["warning 1"],
  "goldenNugget": "the single most important factor that makes this a selection — the thing a normal form guide would miss",
  "riskNote": "one sentence on the main risk to this selection"
}

IMPORTANT: Return ONLY a valid JSON array. No markdown. No explanation. No preamble. Just the raw JSON array starting with [ and ending with ].
If there are no strong selections, return an empty array: []`;

function callClaudeAPI(fixtures, date, label) {
  return new Promise((resolve, reject) => {
    const fixtureList = fixtures.map(f => 
      `ID: ${f.id} | ${f.home} vs ${f.away} | ${f.leagueName} | ${date} | ${f.time || 'TBC'}`
    ).join('\n');

    const userMessage = `Analyse these ${fixtures.length} fixtures for ${label} on ${date}. Research each one thoroughly using web search before deciding. Return ONLY your recommended selections as a JSON array — skip anything you are not confident about.

FIXTURES:
${fixtureList}

Remember: web search each fixture for current form, injuries, manager news and context before deciding. Return raw JSON array only.`;

    const body = JSON.stringify({
      model: 'claude-sonnet-4-5',
      max_tokens: 4000,
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
        'anthropic-version': '2023-06-01',
      }
    };

    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          const parsed = JSON.parse(data);
          // Extract text content from response
          const textBlock = (parsed.content || []).find(b => b.type === 'text');
          if (!textBlock) {
            resolve([]);
            return;
          }
          // Parse JSON from the text response
          let text = textBlock.text.trim();
          // Strip markdown fences
          text = text.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim();
          // Extract JSON array even if Claude adds preamble text
          const arrayStart = text.indexOf('[');
          const arrayEnd = text.lastIndexOf(']');
          if (arrayStart === -1 || arrayEnd === -1) {
            console.error('No JSON array found in response');
            resolve([]);
            return;
          }
          const jsonStr = text.substring(arrayStart, arrayEnd + 1);
          const cards = JSON.parse(jsonStr);
          resolve(Array.isArray(cards) ? cards : []);
        } catch(e) {
          console.error('Parse error:', e.message); console.error('Raw response:', data.substring(0, 1000));
          resolve([]);
        }
      });
    });

    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

exports.handler = async function(event) {
  if (event.httpMethod !== 'POST') {
    return {
      statusCode: 405,
      headers: { 'Access-Control-Allow-Origin': '*' },
      body: JSON.stringify({ error: 'Method not allowed' })
    };
  }

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

  let body;
  try {
    body = JSON.parse(event.body);
  } catch(e) {
    return {
      statusCode: 400,
      headers: { 'Access-Control-Allow-Origin': '*', 'Content-Type': 'application/json' },
      body: JSON.stringify({ error: 'Invalid JSON body' })
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

  try {
    const cards = await callClaudeAPI(fixtures, date, label || 'selected fixtures');
    return {
      statusCode: 200,
      headers: { 'Access-Control-Allow-Origin': '*', 'Content-Type': 'application/json' },
      body: JSON.stringify({ cards })
    };
  } catch(e) {
    console.error('Analysis error:', e.message);
    return {
      statusCode: 500,
      headers: { 'Access-Control-Allow-Origin': '*', 'Content-Type': 'application/json' },
      body: JSON.stringify({ error: 'Analysis failed: ' + e.message })
    };
  }
};
