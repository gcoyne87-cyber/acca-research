const https = require('https');

module.exports.config = { timeout: 60 };

const UPSTASH_URL = process.env.UPSTASH_REDIS_REST_URL;
const UPSTASH_TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN;

function normaliseHorseName(s) { return (s||'').toLowerCase().replace(/[^a-z0-9]/g,''); }

function redisGet(key) {
  if (!UPSTASH_URL || !UPSTASH_TOKEN) return Promise.resolve(null);
  const url = new URL(UPSTASH_URL);
  return new Promise(resolve => {
    const req = https.request({ hostname: url.hostname, path: '/get/'+encodeURIComponent(key), method: 'GET',
      headers: { 'Authorization': 'Bearer '+UPSTASH_TOKEN } }, res => {
      let d=''; res.on('data',c=>d+=c);
      res.on('end',()=>{ try{ const r=JSON.parse(d); resolve(r.result?JSON.parse(r.result):null); }catch(e){ resolve(null); } });
    });
    req.on('error',()=>resolve(null)); req.end();
  });
}

const SYSTEM_PROMPT = `You are a horse racing jockey analyst for RacingEdge. Your job is to identify whether there is a genuine, specific jockey angle worth highlighting — a notable booking, a meaningful jockey-trainer combination, or a clear jockey pattern visible in the form history.

You will receive: the horse's name, trainer name, jockey name, current price, form string, and full form history.

CRITICAL RULE — only set hasEdge to true when at least one of these applies:
- The jockey has ridden this horse before and the form history shows a clear, specific record together (name the results precisely: wins, places, unplaced)
- The jockey is a champion or senior jockey whose booking on this horse is notable given the price or the yard
- The form history shows the same jockey repeatedly retained across multiple runs, suggesting a genuine partnership
- The jockey-trainer combination appears multiple times in the form history with notable results
- The price (very short or very long) combined with the jockey choice creates a signal worth describing

Do NOT set hasEdge to true for:
- A jockey simply having the ride with no notable history on this horse
- Generic statements that any booking "shows confidence"
- Anything not directly supported by the form history or documented stable/jockey knowledge

YOUR OUTPUT RULES:
1. Count how many times the jockey appears in the form history — state the exact number and their results on this horse.
2. Be specific: name the jockey, name the trainer, cite actual runs and positions from the history.
3. No outcome language. Do not say "should win", "looks dangerous", "ideal booking today." Facts and observable patterns only.
4. If hasEdge is true, keep the summary under 100 words.

Return ONLY a valid JSON object:
{
  "hasEdge": true or false,
  "headline": "string (only if hasEdge true) — max 12 words, sharpest factual jockey or booking angle",
  "summary": "string (only if hasEdge true) — under 100 words, specific facts from the history, no verdict"
}`;

function callClaude(payload) {
  return new Promise((resolve, reject) => {
    const historyLines = (payload.history || []).map(h => {
      const posStr = h.pos === 0 ? 'F/UR/PU' : `${h.pos}/${h.ran}`;
      return `${h.date} ${h.year} | ${h.course} (${h.hand}) | ${h.dist} | ${h.going} | Pos: ${posStr} | Jockey: ${h.jockey || payload.jockey || 'unknown'} | Wt: ${h.wt} | OR: ${h.or}`;
    }).join('\n');

    const userMessage = `Assess the jockey angle for this horse and return your analysis as a JSON object.

Horse: ${payload.horseName}
Trainer: ${payload.trainer}
Jockey today: ${payload.jockey}
Price: ${payload.price}
Form: ${payload.form}

Form history (most recent first):
${historyLines}

Return ONLY the JSON object, nothing else.`;

    const body = JSON.stringify({
      model: 'claude-sonnet-4-6',
      max_tokens: 400,
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
          const allText = (parsed.content || [])
            .filter(b => b.type === 'text')
            .map(b => b.text)
            .join('\n');
          let text = allText
            .replace(/```json\s*/gi, '')
            .replace(/```\s*/gi, '')
            .trim();
          const start = text.indexOf('{');
          const end = text.lastIndexOf('}');
          if (start === -1 || end === -1 || end <= start) {
            reject(new Error('No JSON object in response'));
            return;
          }
          resolve(JSON.parse(text.substring(start, end + 1)));
        } catch (err) { reject(err); }
      });
    });
    req.on('error', reject);
    req.setTimeout(55000);
    req.write(body);
    req.end();
  });
}

exports.handler = async function(event) {
  const headers = { 'Access-Control-Allow-Origin': '*', 'Content-Type': 'application/json' };
  if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers, body: '' };
  if (event.httpMethod !== 'POST') return { statusCode: 405, headers, body: JSON.stringify({ error: 'Method not allowed' }) };

  let body;
  try { body = JSON.parse(event.body); } catch (e) {
    return { statusCode: 400, headers, body: JSON.stringify({ error: 'Invalid JSON' }) };
  }

  const { horseName, trainer, jockey, price, form, history } = body;
  if (!horseName || !jockey) {
    return { statusCode: 400, headers, body: JSON.stringify({ error: 'Missing horseName or jockey' }) };
  }

  try {
    // Check pre-generated cache first — no live AI call if build has run
    const today = new Date().toISOString().slice(0, 10);
    const cached = await redisGet(`edge:jockey:${today}:${normaliseHorseName(horseName)}`);
    if (cached) return { statusCode: 200, headers, body: JSON.stringify(cached) };

    const result = await callClaude({ horseName, trainer, jockey, price, form, history: history || [] });
    return { statusCode: 200, headers, body: JSON.stringify(result) };
  } catch (e) {
    console.error('jockey-edge error:', e.message);
    return { statusCode: 500, headers, body: JSON.stringify({ error: e.message }) };
  }
};
