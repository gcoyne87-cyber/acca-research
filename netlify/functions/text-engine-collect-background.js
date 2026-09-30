const https = require('https');
const engine = require('./text-engine-submit-background.js');

// text-engine-collect-background.js
//
// Stage 2 of the per-horse TEXT ENGINE. Reads text-engine:batch:{date},
// polls the Message Batch; while it is still processing it records progress
// and returns (re-invoke later). When ended, it fetches the JSONL results
// and, per horse, VALIDATES every checkable claim against the stored
// envelope before anything is written:
//   - every "Xth of Y" is a real row (position X, field size Y)
//   - every distance token is a distance the horse has run or the race's
//   - every going term named is a going in the rows
//   - every course named (from the GB/IRE course list) is in the rows or is
//     the race's course
//   - every "N runs/wins/placings/2nds/3rds" equals a computed count
//   - spell count, order, trainer and date ranges match the facts block
//   - word counts inside each section's range (±15%)
//   - valid JSON with every field present
// A horse failing ANY check stores nothing; the check and offending sentence
// are recorded. Failures are resubmitted ONCE as a second batch with the
// validator's notes appended; horses failing twice are named in coverage.
//
// Stores: form-summary:{id}:{date} (styleVersion 4), horse:trainer-history:{id}
// (no TTL), horse:summary:{id} (no TTL). Writes text-engine:coverage:{date}
// and appends the cost to the text-engine:ledger list.
//
// Invocation: POST with x-build-secret, ?date=YYYY-MM-DD. Re-invocable.

module.exports.config = { timeout: 900 };

const H = engine.helpers;

// Batch pricing (USD per million tokens): Sonnet 4.6 list price with the
// Message Batches 50% discount. Cache write = 1.25x input, cache read = 0.1x.
const PRICE = { input: 3.0 * 0.5, output: 15.0 * 0.5, cacheWrite: 3.75 * 0.5, cacheRead: 0.30 * 0.5 };

const WORD_RANGES = { recentForm: [30, 50], going: [30, 45], trip: [40, 60], track: [50, 70], spell: [45, 70], spellSingle: [15, 70], horseSummary: [60, 100] };
const TOLERANCE = 0.15;

// GB + IRE racecourses — used only to catch a course NAMED that is not in
// the horse's rows (and is not the race's own course).
const COURSES = ['Aintree','Ascot','Ayr','Ballinrobe','Bangor','Bath','Bellewstown','Beverley','Brighton','Carlisle','Cartmel','Catterick','Chelmsford','Cheltenham','Chepstow','Chester','Clonmel','Cork','Curragh','Doncaster','Down Royal','Downpatrick','Dundalk','Epsom','Exeter','Fairyhouse','Fakenham','Ffos Las','Fontwell','Galway','Goodwood','Gowran','Hamilton','Haydock','Hereford','Hexham','Huntingdon','Kelso','Kempton','Kilbeggan','Killarney','Laytown','Leicester','Leopardstown','Limerick','Lingfield','Listowel','Ludlow','Market Rasen','Musselburgh','Naas','Navan','Newbury','Newcastle','Newmarket','Newton Abbot','Nottingham','Perth','Plumpton','Pontefract','Punchestown','Redcar','Ripon','Roscommon','Salisbury','Sandown','Sedgefield','Sligo','Southwell','Stratford','Taunton','Thirsk','Thurles','Tipperary','Tramore','Uttoxeter','Warwick','Wetherby','Wexford','Wincanton','Windsor','Wolverhampton','Worcester','Yarmouth','York'];

const GOING_TERMS = ['good to firm','good to soft','good to yielding','yielding to soft','soft to heavy','standard to slow','standard to fast','yielding','heavy','soft','firm','standard'];
const NUM_WORDS = { one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, eleven: 11, twelve: 12 };

function words(s) { const t = String(s || '').trim(); return t ? t.split(/\s+/).length : 0; }
function sentenceAround(text, index) {
  const s = String(text || ''); let a = index, b = index;
  while (a > 0 && !/[.!?]/.test(s[a - 1])) a--;
  while (b < s.length && !/[.!?]/.test(s[b])) b++;
  return s.slice(a, b + 1).trim();
}
function normGoing(s) {
  return String(s || '').toLowerCase().replace(/-/g, ' ').replace(/\bgd\b/g, 'good').replace(/\byld\b/g, 'yielding').replace(/\bhvy\b/g, 'heavy').replace(/\bstd\b/g, 'standard').replace(/\bslw\b/g, 'slow').replace(/\bfm\b/g, 'firm').replace(/\bsft\b/g, 'soft').replace(/\s+/g, ' ');
}

// Returns { ok, failures:[{check, sentence}] }.
function validate(parsed, env) {
  const failures = [];
  const fail = function(check, sentence) { failures.push({ check: check, sentence: (sentence || '').slice(0, 220) }); };
  if (!parsed || typeof parsed !== 'object') { fail('json', 'not an object'); return { ok: false, failures: failures }; }
  const need = ['recentForm', 'going', 'trip', 'track', 'trainerSpells', 'horseSummary'];
  need.forEach(function(k) { if (parsed[k] === undefined || parsed[k] === null) fail('json-missing-field', k); });
  ['recentForm', 'going', 'trip', 'track', 'horseSummary'].forEach(function(k) { if (typeof parsed[k] !== 'string') fail('json-field-type', k); });
  if (!Array.isArray(parsed.trainerSpells)) fail('json-field-type', 'trainerSpells');
  if (failures.length) return { ok: false, failures: failures };

  const f = env.facts; const rows = env.rows;
  const texts = { recentForm: parsed.recentForm, going: parsed.going, trip: parsed.trip, track: parsed.track, horseSummary: parsed.horseSummary };
  parsed.trainerSpells.forEach(function(s, i) { texts['spell' + i] = String((s && s.text) || ''); });
  const allText = Object.keys(texts).map(function(k) { return texts[k]; }).join('\n');

  // word counts
  const inRange = function(n, r) { return n >= Math.floor(r[0] * (1 - TOLERANCE)) && n <= Math.ceil(r[1] * (1 + TOLERANCE)); };
  ['recentForm', 'going', 'trip', 'track', 'horseSummary'].forEach(function(k) { if (!inRange(words(texts[k]), WORD_RANGES[k])) fail('words-' + k, words(texts[k]) + ' words: ' + texts[k].slice(0, 80)); });
  parsed.trainerSpells.forEach(function(s, i) {
    const fs = f.spells[i]; const r = (fs && fs.runs <= 1) ? WORD_RANGES.spellSingle : WORD_RANGES.spell;
    if (!inRange(words(s && s.text), r)) fail('words-spell', words(s && s.text) + ' words: ' + String((s && s.text) || '').slice(0, 80));
  });

  // "Xth of Y" -> real row
  const pairs = {}; rows.forEach(function(r) { const p = H.posNum(r.pos); if (p !== null && Number(r.ran)) pairs[p + '|' + Number(r.ran)] = true; });
  const reNth = /\b(\d+)(?:st|nd|rd|th)\s+of\s+(\d+)\b/g; let m;
  while ((m = reNth.exec(allText)) !== null) { if (!pairs[m[1] + '|' + m[2]]) fail('position-not-in-rows', sentenceAround(allText, m.index)); }

  // distances -> rows or race
  const allowedF = {}; rows.forEach(function(r) { const x = H.furlongs(r.dist); if (x) allowedF[x] = true; }); allowedF[env.raceDistF] = true;
  const reDist = /\b(\d+m(?:\d+f)?|\d+f)\b/g;
  while ((m = reDist.exec(allText)) !== null) { const x = H.furlongs(m[1]); if (x && !allowedF[x]) fail('distance-not-in-record', sentenceAround(allText, m.index)); }

  // going terms -> rows
  const rowGoing = {}; rows.forEach(function(r) { rowGoing[normGoing(H.primaryGoing(r.going))] = true; });
  const normAll = normGoing(allText);
  GOING_TERMS.forEach(function(term) {
    const re = new RegExp('\\b' + term.replace(/ /g, '\\s+') + '\\b', 'g'); let mm;
    while ((mm = re.exec(normAll)) !== null) {
      // a longer term containing this one (e.g. "good to soft" vs "soft") is checked on its own; skip the inner match
      const before = normAll.slice(Math.max(0, mm.index - 12), mm.index), after = normAll.slice(mm.index + term.length, mm.index + term.length + 12);
      if (/\bto\s*$/.test(before) || /^\s*to\b/.test(after)) continue;
      if (!rowGoing[term]) fail('going-not-in-record', sentenceAround(allText, Math.min(mm.index, allText.length - 1)));
    }
  });

  // courses named -> rows or race course
  const rowCourses = {}; rows.forEach(function(r) { rowCourses[H.stripParens(r.course).toLowerCase()] = true; }); rowCourses[String(env.raceCourse || '').toLowerCase()] = true;
  COURSES.forEach(function(c) {
    const re = new RegExp('\\b' + c.replace(/ /g, '\\s+') + '\\b', 'g'); let mm;
    while ((mm = re.exec(allText)) !== null) {
      const lc = c.toLowerCase();
      const known = Object.keys(rowCourses).some(function(k) { return k === lc || k.indexOf(lc) === 0; });
      if (!known) fail('course-not-in-record', sentenceAround(allText, mm.index));
    }
  });

  // counts mirroring facts
  const counts = { runs: {}, wins: {}, placings: {}, seconds: {}, thirds: {} };
  const add = function(kind, n) { if (n !== null && n !== undefined) counts[kind][n] = true; };
  add('runs', f.career.runs); add('wins', f.career.wins); add('seconds', f.career.seconds); add('thirds', f.career.thirds); add('placings', f.career.seconds + f.career.thirds); add('runs', 4);
  add('runs', f.atDistance.runs); add('wins', f.atDistance.wins); add('placings', f.atDistance.placings.length);
  f.otherDistances.forEach(function(o) { add('runs', o.runs); });
  f.going.forEach(function(g) { add('runs', g.runs); add('wins', g.wins); add('placings', g.placings); });
  f.courses.forEach(function(c) { add('runs', c.runs); add('wins', c.positions.filter(function(p) { return H.posNum(p.pos) === 1; }).length); });
  f.spells.forEach(function(s) { add('runs', s.runs); add('wins', s.wins); add('placings', s.placings); });
  const reCount = /\b(\d+|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve)\s+(runs?|starts?|wins?|placings?|seconds?|thirds?|2nds?|3rds?)\b/gi;
  while ((m = reCount.exec(allText)) !== null) {
    const n = /^\d+$/.test(m[1]) ? parseInt(m[1], 10) : NUM_WORDS[m[1].toLowerCase()];
    const noun = m[2].toLowerCase();
    const kind = /^(run|start)/.test(noun) ? 'runs' : /^win/.test(noun) ? 'wins' : /^placing/.test(noun) ? 'placings' : /^(second|2nd)/.test(noun) ? 'seconds' : 'thirds';
    if (!counts[kind][n]) fail('count-not-in-facts', sentenceAround(allText, m.index));
  }

  // spells: count, order, trainer, date range
  if (parsed.trainerSpells.length !== f.spells.length) fail('spell-count', 'got ' + parsed.trainerSpells.length + ', facts have ' + f.spells.length);
  else parsed.trainerSpells.forEach(function(s, i) {
    const fs = f.spells[i];
    const tn = String((s && s.trainer) || '').toLowerCase().trim(), fn = fs.trainer.toLowerCase().trim();
    if (tn !== fn && tn !== fs.surname.toLowerCase()) fail('spell-trainer', 'spell ' + (i + 1) + ': "' + (s && s.trainer) + '" vs "' + fs.trainer + '"');
    if (String((s && s.from) || '') !== fs.from) fail('spell-from', 'spell ' + (i + 1) + ': "' + (s && s.from) + '" vs "' + fs.from + '"');
    if (String((s && s.to) || '') !== fs.to) fail('spell-to', 'spell ' + (i + 1) + ': "' + (s && s.to) + '" vs "' + fs.to + '"');
  });

  return { ok: failures.length === 0, failures: failures };
}

function parseJsonText(text) {
  let t = String(text || '').trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
  const a = t.indexOf('{'), b = t.lastIndexOf('}');
  if (a > 0 || (b >= 0 && b < t.length - 1)) t = t.slice(a, b + 1);
  try { return JSON.parse(t); } catch (e) { return null; }
}

function fetchText(urlStr) {
  const u = new URL(urlStr);
  return new Promise((resolve, reject) => {
    const req = https.request({ hostname: u.hostname, path: u.pathname + u.search, method: 'GET', headers: { 'x-api-key': process.env.ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01' } }, res => {
      let d = ''; res.on('data', c => d += c);
      res.on('end', () => { if (res.statusCode !== 200) return reject(new Error('results fetch HTTP ' + res.statusCode + ' ' + d.slice(0, 200))); resolve(d); });
    });
    req.on('error', reject); req.setTimeout(120000, function() { req.destroy(); reject(new Error('results fetch timeout')); }); req.end();
  });
}

async function storeHorse(id, date, env, parsed) {
  const now = new Date().toISOString();
  await H.redisSet('form-summary:' + id + ':' + date, { horseName: env.horseName, summary: parsed.recentForm, recentForm: parsed.recentForm, going: parsed.going, trip: parsed.trip, track: parsed.track, styleVersion: 4, generatedAt: now, course: env.course, distance: env.distance });
  await H.redisSet('horse:trainer-history:' + id, { horseName: env.horseName, spells: parsed.trainerSpells.map(function(s, i) { const fs = env.facts.spells[i] || {}; return { trainer: fs.trainer || s.trainer, from: s.from, to: s.to, text: s.text, runs: fs.runs, wins: fs.wins, places: fs.placings }; }), generatedAt: now, source: 'text-engine' });
  await H.redisSet('horse:summary:' + id, { horseName: env.horseName, text: parsed.horseSummary, generatedAt: now, source: 'text-engine' });
}

// Rebuilds the envelope's facts/rows for validation from the stored form
// history (the batch record keeps only the envelope text, to stay small).
async function envelopeFor(id, date, stored) {
  const rows = await H.redisGet('form:history:' + id + ':' + date);
  if (!Array.isArray(rows)) return null;
  // The card trainer (which closes the spell list) is carried in the stored envelope text.
  const mt = /Current trainer: (.+?)\.\n/.exec((stored.text || '') + '\n');
  const built = engine.buildEnvelope({ name: stored.horseName, trainer: mt ? mt[1] : '' }, { course: stored.course, dist: stored.distance }, rows);
  return { horseName: stored.horseName, course: stored.course, distance: stored.distance, raceCourse: stored.course, raceDistF: built.raceDistF, rows: rows, facts: built.facts, text: stored.text };
}

function usageOf(msg) {
  const u = (msg && msg.usage) || {};
  return { input: u.input_tokens || 0, output: u.output_tokens || 0, cacheWrite: u.cache_creation_input_tokens || 0, cacheRead: u.cache_read_input_tokens || 0 };
}
function addUsage(t, u) { t.input += u.input; t.output += u.output; t.cacheWrite += u.cacheWrite; t.cacheRead += u.cacheRead; }
function costOf(t) { return +((t.input * PRICE.input + t.output * PRICE.output + t.cacheWrite * PRICE.cacheWrite + t.cacheRead * PRICE.cacheRead) / 1e6).toFixed(4); }

async function processResults(batchId, record, date, pass, tag) {
  const status = await H.anthropic('GET', '/v1/messages/batches/' + batchId);
  if (status.status !== 200 || !status.json) throw new Error('batch status HTTP ' + status.status + ' ' + status.raw.slice(0, 200));
  if (status.json.processing_status !== 'ended') {
    return { pending: true, counts: status.json.request_counts || {} };
  }
  const jsonl = await fetchText(status.json.results_url);
  const lines = jsonl.split('\n').filter(Boolean);
  const out = { passed: [], failed: [], usage: { input: 0, output: 0, cacheWrite: 0, cacheRead: 0 }, errored: [] };
  for (const line of lines) {
    let item; try { item = JSON.parse(line); } catch (e) { continue; }
    const id = item.custom_id; const stored = record.envelopes[id];
    if (!stored) continue;
    if (!item.result || item.result.type !== 'succeeded') { out.errored.push({ horse_id: id, horseName: stored.horseName, reason: 'batch result ' + ((item.result && item.result.type) || 'missing') }); continue; }
    addUsage(out.usage, usageOf(item.result.message));
    const text = ((item.result.message && item.result.message.content) || []).filter(function(b) { return b.type === 'text'; }).map(function(b) { return b.text; }).join('');
    const parsed = parseJsonText(text);
    const env = await envelopeFor(id, date, stored);
    if (!env) { out.failed.push({ horse_id: id, horseName: stored.horseName, failures: [{ check: 'no-history-key', sentence: '' }] }); continue; }
    const v = validate(parsed, env);
    if (v.ok) {
      try { await storeHorse(id, date, env, parsed); out.passed.push(id); }
      catch (e) { out.failed.push({ horse_id: id, horseName: stored.horseName, failures: [{ check: 'store', sentence: e.message }] }); }
    } else {
      out.failed.push({ horse_id: id, horseName: stored.horseName, failures: v.failures });
      console.log(tag, 'pass ' + pass + ' FAIL', stored.horseName, id, JSON.stringify(v.failures.slice(0, 3)));
    }
  }
  return out;
}

exports.handler = async function(event) {
  const headers = { 'Content-Type': 'application/json' };
  const qs = (event && event.queryStringParameters) || {};
  const secret = (event.headers && event.headers['x-build-secret']) || qs.secret;
  if (secret !== process.env.BUILD_SECRET) return { statusCode: 401, headers, body: JSON.stringify({ error: 'Unauthorised' }) };
  const date = /^\d{4}-\d{2}-\d{2}$/.test(qs.date || '') ? qs.date : H.irishDateStr();
  const tag = '[text-engine collect ' + date + ']';

  try {
    const record = await H.redisGet('text-engine:batch:' + date);
    if (!record || !record.batchId) return { statusCode: 200, headers, body: JSON.stringify({ error: 'no batch record for ' + date }) };
    if (record.phase === 'done') return { statusCode: 200, headers, body: JSON.stringify({ date: date, status: 'already complete', coverage: await H.redisGet('text-engine:coverage:' + date) }) };

    // ── First pass ──
    if (record.phase === 'first') {
      const r = await processResults(record.batchId, record, date, 1, tag);
      if (r.pending) {
        await H.redisSet('text-engine:batch:' + date, Object.assign({}, record, { lastPoll: new Date().toISOString(), lastCounts: r.counts }));
        return { statusCode: 200, headers, body: JSON.stringify({ date: date, status: 'processing', batchId: record.batchId, counts: r.counts }) };
      }
      record.firstPass = { passed: r.passed.length, failed: r.failed.length, errored: r.errored, usage: r.usage, failures: r.failed };
      const retryable = r.failed.filter(function(f) { return !f.failures.some(function(x) { return x.check === 'no-history-key' || x.check === 'store'; }); });
      if (retryable.length) {
        const requests = retryable.map(function(f) {
          const stored = record.envelopes[f.horse_id];
          const notes = f.failures.map(function(x) { return '- ' + x.check + (x.sentence ? ': "' + x.sentence + '"' : ''); }).join('\n');
          const userText = stored.text + '\n\nPREVIOUS ATTEMPT FAILED VALIDATION — every claim is checked in code against the rows and facts above. Failures:\n' + notes + '\nRewrite so that every position, distance, going, course and count appears in the rows or facts exactly, every section stays inside its word range, and the spell list matches the facts block spell for spell.';
          return { custom_id: f.horse_id, params: { model: H.MODEL, max_tokens: H.MAX_TOKENS, system: [{ type: 'text', text: engine.STATIC_PROMPT, cache_control: { type: 'ephemeral' } }], messages: [{ role: 'user', content: userText }] } };
        });
        const resp = await H.anthropic('POST', '/v1/messages/batches', { requests: requests });
        if (resp.status !== 200 || !resp.json || !resp.json.id) throw new Error('retry batch submit failed HTTP ' + resp.status + ' ' + resp.raw.slice(0, 200));
        record.phase = 'retry'; record.retryBatchId = resp.json.id; record.retrySubmittedAt = new Date().toISOString(); record.retryCount = requests.length;
        await H.redisSet('text-engine:batch:' + date, record);
        console.log(tag, 'first pass: passed', r.passed.length, '| failed', r.failed.length, '| retry batch', resp.json.id, 'for', requests.length);
        return { statusCode: 200, headers, body: JSON.stringify({ date: date, status: 'retry submitted', firstPass: { passed: r.passed.length, failed: r.failed.length }, retryBatchId: resp.json.id, retryCount: requests.length }) };
      }
      record.phase = 'finalise';
      record.retryPass = { passed: 0, failed: 0, usage: { input: 0, output: 0, cacheWrite: 0, cacheRead: 0 }, failures: [] };
    }

    // ── Retry pass ──
    if (record.phase === 'retry') {
      const r = await processResults(record.retryBatchId, record, date, 2, tag);
      if (r.pending) {
        await H.redisSet('text-engine:batch:' + date, Object.assign({}, record, { lastPoll: new Date().toISOString(), lastCounts: r.counts }));
        return { statusCode: 200, headers, body: JSON.stringify({ date: date, status: 'retry processing', batchId: record.retryBatchId, counts: r.counts }) };
      }
      record.retryPass = { passed: r.passed.length, failed: r.failed.length, errored: r.errored, usage: r.usage, failures: r.failed };
      record.phase = 'finalise';
    }

    // ── Coverage + ledger ──
    const fp = record.firstPass, rp = record.retryPass;
    const total = { input: 0, output: 0, cacheWrite: 0, cacheRead: 0 }; addUsage(total, fp.usage); addUsage(total, rp.usage);
    const retriedIds = {}; (rp.failures || []).forEach(function(f) { retriedIds[f.horse_id] = f; });
    const failedTwice = (fp.failures || []).filter(function(f) { return retriedIds[f.horse_id]; }).map(function(f) { return { horse_id: f.horse_id, horseName: f.horseName, firstPass: f.failures.slice(0, 3), retry: retriedIds[f.horse_id].failures.slice(0, 3) }; });
    const unretried = (fp.failures || []).filter(function(f) { return f.failures.some(function(x) { return x.check === 'no-history-key' || x.check === 'store'; }); });
    const coverage = {
      date: date, batchId: record.batchId, retryBatchId: record.retryBatchId || null, completedAt: new Date().toISOString(),
      horsesOnCard: record.horseCount + record.debutantCount + record.noHistoryKey,
      submitted: record.horseCount, debutantTemplates: record.debutantCount, noHistoryKey: record.noHistoryKey,
      validatedFirstPass: fp.passed, passedOnRetry: rp.passed, failedTwice: failedTwice.length, failedTwiceNamed: failedTwice,
      unretried: unretried.map(function(f) { return { horse_id: f.horse_id, horseName: f.horseName, reason: f.failures[0].check }; }),
      batchErrors: (fp.errored || []).concat(rp.errored || []),
      generated: fp.passed + rp.passed,
      tokens: { uncachedInput: total.input, cacheWrite: total.cacheWrite, cacheRead: total.cacheRead, output: total.output },
      costUSD: costOf(total), pricing: PRICE
    };
    await H.redisSet('text-engine:coverage:' + date, coverage);
    try {
      const ledger = (await H.redisGet('text-engine:ledger')) || [];
      ledger.push({ date: date, batchId: record.batchId, generated: coverage.generated, tokens: coverage.tokens, costUSD: coverage.costUSD, at: coverage.completedAt });
      await H.redisSet('text-engine:ledger', ledger.slice(-365));
    } catch (e) { console.log(tag, 'ledger write failed', e.message); }
    record.phase = 'done'; delete record.envelopes;
    await H.redisSet('text-engine:batch:' + date, record);
    console.log(tag, 'DONE', JSON.stringify({ generated: coverage.generated, firstPass: fp.passed, retry: rp.passed, failedTwice: failedTwice.length, cost: coverage.costUSD }));
    return { statusCode: 200, headers, body: JSON.stringify(coverage) };
  } catch (e) {
    console.log(tag, 'ERROR', e.message);
    return { statusCode: 500, headers, body: JSON.stringify({ error: e.message }) };
  }
};

module.exports.validate = validate;
module.exports.parseJsonText = parseJsonText;
