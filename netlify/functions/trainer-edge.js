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

const SYSTEM_PROMPT = `You are a horse racing trainer analyst for RacingEdge. Your job is to produce a specific, factual profile of a trainer's observable patterns based on the horse's form history and known stable tendencies — the kind of intelligence a professional punter uses to read beyond raw form figures.

You will receive: the horse's name, trainer name, jockey name, current price, form string, and full form history.

YOUR OUTPUT RULES:

1. Be specific. Name the trainer throughout. Reference actual patterns visible in the form history — do not generalise.
2. Cover these angles where the data supports them — skip where thin:
   - Run pattern: how does this trainer use the horse — short breaks, long layoffs, frequent runs, carefully spaced campaigns? Give the actual gap lengths.
   - Jockey booking: is this jockey a retained stable rider or a notable outside booking? Has this jockey ridden this horse before — with what result? Name specific combinations.
   - Handicap management: is the trainer improving the horse's OR, keeping it stable, or running it off a falling mark? Note the trajectory across runs.
   - Course targeting: does the form show repeated visits to specific tracks, suggesting deliberate targeting?
   - Freshness patterns: does the trainer's record with this horse show better runs fresh or after a run?
   - If the trainer is well-known (e.g. Mullins, O'Brien, Nicholls, Henderson), note one or two documented tendencies for that stable — factual only, not speculative.
3. Present observable facts and patterns ONLY. Do not say "targets today's race", "confident today", "ideal conditions" or any language that implies a verdict on this specific race.
4. Keep the whole summary under 130 words. Punchy, specific, analyst voice.

Return ONLY a valid JSON object:
{
  "headline": "string — max 12 words, the single sharpest trainer or jockey pattern (e.g. 'Mullins retains Townend — combination has won three from four together')",
  "summary": "string — trainer and jockey profile under 130 words, observable facts and patterns only, no verdict"
}`;

function callClaude(payload) {
  return new Promise((resolve, reject) => {
    const historyLines = (payload.history || []).map(h => {
      const posStr = h.pos === 0 ? 'F/UR/PU' : `${h.pos}/${h.ran}`;
      return `${h.date} ${h.year} | ${h.course} (${h.hand}) | ${h.dist} | ${h.going} | Pos: ${posStr} | Wt: ${h.wt} | OR: ${h.or}`;
    }).join('\n');

    const userMessage = `Analyse the trainer and jockey profile for this horse and return your interpretation as a JSON object.

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
      max_tokens: 600,
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
  if (!horseName || !trainer) {
    return { statusCode: 400, headers, body: JSON.stringify({ error: 'Missing horseName or trainer' }) };
  }

  try {
    // Check pre-generated cache first — no live AI call if build has run
    const today = new Date().toISOString().slice(0, 10);
    const cached = await redisGet(`edge:trainer:${today}:${normaliseHorseName(horseName)}`);
    if (cached) return { statusCode: 200, headers, body: JSON.stringify(cached) };

    const result = await callClaude({ horseName, trainer, jockey, price, form, history: history || [] });
    return { statusCode: 200, headers, body: JSON.stringify(result) };
  } catch (e) {
    console.error('trainer-edge error:', e.message);
    return { statusCode: 500, headers, body: JSON.stringify({ error: e.message }) };
  }
};
