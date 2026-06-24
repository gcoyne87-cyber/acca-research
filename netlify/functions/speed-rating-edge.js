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

const SYSTEM_PROMPT = `You are a horse racing handicap and speed analyst for RacingEdge. Your job is to identify whether there is a genuine, specific speed or rating angle worth highlighting — a horse running off a notable OR mark, a clear rating trajectory, or a handicap position that stands out given its recent form figures.

You will receive: the horse's name, trainer name, jockey name, current price, form string, and full form history with official ratings (OR).

CRITICAL RULE — only set hasEdge to true when at least one of these applies:
- The horse is running off its lowest OR in recent runs, suggesting the handicapper has dropped it to a workable mark
- The horse is running off its career-best OR or near-highest OR, showing significant progression
- The OR trajectory shows a clear decline across multiple runs (being eased down the weights steadily)
- The horse won or placed last time out from this mark or a higher mark — cite the specific OR figures
- The horse is dropping markedly in class relative to recent runs, visible from OR comparison across runs
- The price is notably short for the current handicap mark, suggesting market confidence in the rating

Do NOT set hasEdge to true for:
- A horse simply having an OR with no notable trajectory or comparative angle
- Generic statements about any horse carrying a weight or rating
- Anything not directly supported by the OR figures visible in the form history

YOUR OUTPUT RULES:
1. State exact OR values from the history — compare current OR to highest, lowest, and recent trend across runs.
2. Be specific: cite actual finishing positions and OR figures. Note weight carried where relevant.
3. No outcome language. Do not say "well treated", "too high a mark", "looks dangerous". Facts and observable OR figures only.
4. If hasEdge is true, keep the summary under 100 words.

Return ONLY a valid JSON object:
{
  "hasEdge": true or false,
  "headline": "string (only if hasEdge true) — max 12 words, sharpest factual rating or handicap angle",
  "summary": "string (only if hasEdge true) — under 100 words, specific OR figures and trajectory, no verdict"
}`;

function callClaude(payload) {
  return new Promise((resolve, reject) => {
    const historyLines = (payload.history || []).map(h => {
      const posStr = h.pos === 0 ? 'F/UR/PU' : `${h.pos}/${h.ran}`;
      return `${h.date} ${h.year} | ${h.course} (${h.hand}) | ${h.dist} | ${h.going} | Pos: ${posStr} | Wt: ${h.wt} | OR: ${h.or}`;
    }).join('\n');

    const userMessage = `Assess the speed/rating angle for this horse and return your analysis as a JSON object.

Horse: ${payload.horseName}
Trainer: ${payload.trainer}
Jockey: ${payload.jockey}
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
  if (!horseName) {
    return { statusCode: 400, headers, body: JSON.stringify({ error: 'Missing horseName' }) };
  }

  try {
    // Check pre-generated cache first — no live AI call if build has run
    const today = new Date().toISOString().slice(0, 10);
    const cached = await redisGet(`edge:speed:${today}:${normaliseHorseName(horseName)}`);
    if (cached) return { statusCode: 200, headers, body: JSON.stringify(cached) };

    const result = await callClaude({ horseName, trainer, jockey, price, form, history: history || [] });
    return { statusCode: 200, headers, body: JSON.stringify(result) };
  } catch (e) {
    console.error('speed-rating-edge error:', e.message);
    return { statusCode: 500, headers, body: JSON.stringify({ error: e.message }) };
  }
};
