const https = require('https');
const going = require('./lib/going-section.js');
const engine = require('./text-engine-submit-background.js');

// going-trial.js — standalone, secret-gated trial for the GOING section
// module (lib/going-section.js) ONLY. Not scheduled, not called by anything
// else, not wired into the live text engine. Makes real (non-Batch) Sonnet
// 4.6 calls, so it is deliberately hard to invoke by accident: POST with
// x-build-secret required.
//
//   POST /.netlify/functions/going-trial?date=YYYY-MM-DD&n=5
//
// For n distinct horses (real random shuffle, spread across >=3 meetings
// where possible) declared on that date's stored racecard, skipping
// non-runners and any horse whose going window has zero runs (debutants /
// no history in the last 18 months): builds the going envelope, calls the
// model directly, validates the result, and returns everything — envelope,
// output, validator result, tokens, per-horse and total cost. Stores nothing
// except one going-trial:{date}:{timestamp} record, 7-day TTL.

module.exports.config = { timeout: 120 };

const H = engine.helpers; // redisGet/redisSet/redisMGet/irishDateStr — reused, not duplicated

// Standard (non-Batch) Sonnet 4.6 pricing, USD per million tokens.
const PRICE = { input: 3.0, output: 15.0, cacheWrite: 3.75, cacheRead: 0.30 };

function anthropicDirect(systemText, userText, maxTokens) {
  const body = JSON.stringify({
    model: H.MODEL,
    max_tokens: maxTokens,
    system: [{ type: 'text', text: systemText, cache_control: { type: 'ephemeral' } }],
    messages: [{ role: 'user', content: userText }]
  });
  return new Promise((resolve, reject) => {
    const req = https.request({
      hostname: 'api.anthropic.com', path: '/v1/messages', method: 'POST',
      headers: { 'x-api-key': process.env.ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01', 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) }
    }, res => {
      let d = ''; res.on('data', c => d += c);
      res.on('end', () => { try { resolve({ status: res.statusCode, json: JSON.parse(d) }); } catch (e) { reject(new Error('parse HTTP ' + res.statusCode + ' ' + d.slice(0, 200))); } });
    });
    req.on('error', reject); req.setTimeout(60000, function() { req.destroy(); reject(new Error('timeout')); });
    req.write(body); req.end();
  });
}

// Fisher-Yates.
function shuffle(arr) {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); const t = a[i]; a[i] = a[j]; a[j] = t; }
  return a;
}

exports.handler = async function(event) {
  const headers = { 'Content-Type': 'application/json' };
  const qs = (event && event.queryStringParameters) || {};
  const secret = (event.headers && event.headers['x-build-secret']) || qs.secret;
  if (secret !== process.env.BUILD_SECRET) return { statusCode: 401, headers, body: JSON.stringify({ error: 'Unauthorised' }) };
  const date = /^\d{4}-\d{2}-\d{2}$/.test(qs.date || '') ? qs.date : H.irishDateStr();
  const n = Math.max(1, Math.min(20, parseInt(qs.n, 10) || 5));

  try {
    const card = await H.redisGet('racecards:' + date);
    if (!card || !Array.isArray(card.meetings)) return { statusCode: 200, headers, body: JSON.stringify({ error: 'no racecards:' + date }) };

    // Distinct horses, first race each, non-runners skipped.
    const seen = {}; const candidates = [];
    card.meetings.forEach(function(m) { (m.races || []).forEach(function(r) { (r.runners || []).forEach(function(ru) {
      if (!ru.horse_id || seen[ru.horse_id]) return;
      if (ru.nonRunner === true || ru.price === 'NR') return;
      seen[ru.horse_id] = true;
      candidates.push({ horse: ru, meeting: m.name, time: r.t });
    }); }); });

    const hv = await H.redisMGet(candidates.map(function(c) { return 'form:history:' + c.horse.horse_id + ':' + date; }));
    const eligible = [];
    candidates.forEach(function(c, i) {
      const rows = hv[i];
      if (!Array.isArray(rows) || !rows.length) return; // debutant / no history key at all
      const w = going.goingWindow(rows, date);
      if (w.size > 0) eligible.push({ c: c, rows: rows, window: w });
    });

    // Real random shuffle, then greedily cover >=3 distinct meetings first,
    // filling remaining slots from whatever's left in shuffle order.
    const shuffled = shuffle(eligible);
    const picked = []; const meetingsUsed = {};
    for (const e of shuffled) { if (picked.length >= n) break; if (!meetingsUsed[e.c.meeting] && Object.keys(meetingsUsed).length < 3) { picked.push(e); meetingsUsed[e.c.meeting] = true; } }
    for (const e of shuffled) { if (picked.length >= n) break; if (picked.indexOf(e) === -1) { picked.push(e); meetingsUsed[e.c.meeting] = true; } }

    const results = []; const total = { input: 0, output: 0, cacheWrite: 0, cacheRead: 0 };
    for (const e of picked) {
      const groups = going.goingGroups(e.window.rows);
      const neverRun = going.goingNeverRun(groups);
      const envelopeText = going.goingEnvelope(e.c.horse, { course: e.c.meeting, time: e.c.time }, e.window, groups, neverRun);
      let modelText = '', usage = { input_tokens: 0, output_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 }, apiError = null;
      try {
        const resp = await anthropicDirect(going.GOING_SYSTEM_PROMPT, envelopeText, going.GOING_MAX_TOKENS);
        if (resp.status !== 200 || !resp.json || !resp.json.content) { apiError = 'HTTP ' + resp.status + ' ' + JSON.stringify(resp.json).slice(0, 300); }
        else { modelText = resp.json.content.filter(function(b) { return b.type === 'text'; }).map(function(b) { return b.text; }).join('').trim(); usage = resp.json.usage || usage; }
      } catch (apiErr) { apiError = apiErr.message; }
      const u = { input: usage.input_tokens || 0, output: usage.output_tokens || 0, cacheWrite: usage.cache_creation_input_tokens || 0, cacheRead: usage.cache_read_input_tokens || 0 };
      total.input += u.input; total.output += u.output; total.cacheWrite += u.cacheWrite; total.cacheRead += u.cacheRead;
      const validation = apiError ? null : going.validateGoing(modelText, groups, neverRun);
      results.push({
        horseName: e.c.horse.name, raceCourse: e.c.meeting, raceTime: e.c.time,
        careerRows: e.rows.length, windowSize: e.window.size, limitApplied: e.window.limitApplied,
        envelope: envelopeText, modelOutput: modelText, apiError: apiError,
        wordCount: validation ? validation.wordCount : null,
        validator: validation ? { ok: validation.ok, failures: validation.failures } : null,
        tokens: u
      });
    }

    const costOf = function(t) { return +((t.input * PRICE.input + t.output * PRICE.output + t.cacheWrite * PRICE.cacheWrite + t.cacheRead * PRICE.cacheRead) / 1e6).toFixed(4); };
    const record = { date: date, requested: n, meetingsCovered: Object.keys(meetingsUsed).length, eligiblePool: eligible.length, results: results, totalTokens: total, totalCostUSD: costOf(total), pricing: PRICE, ranAt: new Date().toISOString() };
    const storeKey = 'going-trial:' + date + ':' + Date.now();
    try { await H.redisSet(storeKey, record); await setTtl(storeKey); } catch (e) { /* best-effort */ }

    return { statusCode: 200, headers, body: JSON.stringify(record) };
  } catch (e) {
    return { statusCode: 500, headers, body: JSON.stringify({ error: e.message }) };
  }
};

// H.redisSet has no TTL param; a tiny local EX-set mirrors the pattern used
// elsewhere in this codebase (?EX=seconds on the Upstash /set/ path) without
// touching text-engine-submit-background.js's own redisSet.
function setTtl(key) {
  const url = new URL(process.env.UPSTASH_REDIS_REST_URL);
  return new Promise((resolve) => {
    const req = https.request({ hostname: url.hostname, path: '/expire/' + encodeURIComponent(key) + '/604800', method: 'POST', headers: { 'Authorization': 'Bearer ' + process.env.UPSTASH_REDIS_REST_TOKEN } }, res => { res.resume(); res.on('end', resolve); });
    req.on('error', () => resolve()); req.end();
  });
}
