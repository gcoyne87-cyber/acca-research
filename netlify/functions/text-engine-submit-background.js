const https = require('https');

// text-engine-submit-background.js
//
// Per-horse TEXT ENGINE, stage 1 of 2. For every distinct runner on one
// date's stored racecard it builds a fact envelope in code (rows + computed
// facts — the model never counts) and submits ONE Anthropic Message Batch
// with one request per horse. Each request asks for the three texts at once
// (form summary in four sections, trainer history per spell, horse summary)
// and shares the same static system block, which is prompt-cached.
// Debutants (empty history) get no request: fixed template text is written
// to all three key families and counted in coverage.
//
// Stage 2 (text-engine-collect-background.js) polls the batch, validates
// every claim against this envelope, stores passes and retries failures once.
//
// Invocation: POST with x-build-secret, ?date=YYYY-MM-DD (default Irish
// today). No schedule — text-engine-trigger.js is the shim; scheduling is
// decided after the run is proven. Writes: text-engine:batch:{date} only.

module.exports.config = { timeout: 900 };

const UPSTASH_URL = process.env.UPSTASH_REDIS_REST_URL;
const UPSTASH_TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN;
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;

const MODEL = 'claude-sonnet-4-6';
const MAX_TOKENS = 1400;
const ROWS_IN_ENVELOPE = 12;

// ── Redis helpers (same shapes as form-summary-background.js) ─────────────

function redisGet(key) {
  const url = new URL(UPSTASH_URL);
  return new Promise((resolve) => {
    const req = https.request({
      hostname: url.hostname, path: '/get/' + encodeURIComponent(key), method: 'GET',
      headers: { 'Authorization': 'Bearer ' + UPSTASH_TOKEN }
    }, res => {
      let d = ''; res.on('data', c => d += c);
      res.on('end', () => { try { const r = JSON.parse(d); resolve(r.result ? JSON.parse(r.result) : null); } catch (e) { resolve(null); } });
    });
    req.on('error', () => resolve(null)); req.end();
  });
}

function redisSet(key, value) {
  const url = new URL(UPSTASH_URL);
  const body = JSON.stringify(value);
  return new Promise((resolve, reject) => {
    const req = https.request({
      hostname: url.hostname, path: '/set/' + encodeURIComponent(key), method: 'POST',
      headers: { 'Authorization': 'Bearer ' + UPSTASH_TOKEN, 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) }
    }, res => {
      let d = ''; res.on('data', c => d += c);
      res.on('end', () => {
        if (res.statusCode !== 200) return reject(new Error('Redis write failed: HTTP ' + res.statusCode + ' ' + d.slice(0, 120)));
        try { const p = JSON.parse(d); if (p && p.error) return reject(new Error('Redis write error: ' + p.error)); } catch (e) {}
        resolve(d);
      });
    });
    req.on('error', reject); req.write(body); req.end();
  });
}

// Pipeline GET for many keys in one round trip (history rows for a whole card).
function redisMGet(keys) {
  if (!keys.length) return Promise.resolve([]);
  const url = new URL(UPSTASH_URL);
  const body = JSON.stringify(keys.map(function(k) { return ['GET', k]; }));
  return new Promise((resolve) => {
    const req = https.request({
      hostname: url.hostname, path: '/pipeline', method: 'POST',
      headers: { 'Authorization': 'Bearer ' + UPSTASH_TOKEN, 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) }
    }, res => {
      let d = ''; res.on('data', c => d += c);
      res.on('end', () => {
        try { resolve(JSON.parse(d).map(function(x) { try { return x.result ? JSON.parse(x.result) : null; } catch (e) { return null; } })); }
        catch (e) { resolve(keys.map(function() { return null; })); }
      });
    });
    req.on('error', () => resolve(keys.map(function() { return null; }))); req.write(body); req.end();
  });
}

// Anthropic call with status; used for the one batch-submit POST.
function anthropic(method, path, body) {
  const b = body ? JSON.stringify(body) : null;
  return new Promise((resolve, reject) => {
    const headers = { 'x-api-key': ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01', 'Content-Type': 'application/json' };
    if (b) headers['Content-Length'] = Buffer.byteLength(b);
    const req = https.request({ hostname: 'api.anthropic.com', path: path, method: method, headers: headers }, res => {
      let d = ''; res.on('data', c => d += c);
      res.on('end', () => { let j = null; try { j = JSON.parse(d); } catch (e) {} resolve({ status: res.statusCode, json: j, raw: d }); });
    });
    req.on('error', reject); req.setTimeout(120000, function() { req.destroy(); reject(new Error('anthropic timeout')); });
    if (b) req.write(b); req.end();
  });
}

function irishDateStr(d) {
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Dublin' }).formatToParts(d || new Date());
  const g = function(t) { const p = parts.find(function(x) { return x.type === t; }); return p ? p.value : ''; };
  return g('year') + '-' + g('month') + '-' + g('day');
}

// ── Distance / going / date helpers (racecards.js semantics) ──────────────

const MON = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
function stripParens(s) { return String(s || '').replace(/\s*\([^)]*\)/g, '').trim(); }
function furlongs(distStr) {
  const s = String(distStr || '');
  const mi = (s.match(/(\d+)m/) || [])[1];
  const f = (s.match(/(\d+)f/) || [])[1];
  return (mi ? parseInt(mi, 10) : 0) * 8 + (f ? parseInt(f, 10) : 0);
}
// 10 -> "1m2f", 8 -> "1m", 7 -> "7f"
function distLabel(f) {
  if (!f) return '';
  const m = Math.floor(f / 8), r = f % 8;
  return (m ? m + 'm' : '') + (r ? r + 'f' : '');
}
function primaryGoing(g) {
  return String(g || '').replace(/^[a-z]+\s*:\s*/i, '').split(/[,(]/)[0].trim();
}
function monYear(iso) {
  const m = /^(\d{4})-(\d{2})/.exec(String(iso || ''));
  return m ? MON[parseInt(m[2], 10) - 1] + ' ' + m[1] : '';
}
function dayMonYear(iso) {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(iso || ''));
  return m ? parseInt(m[3], 10) + ' ' + MON[parseInt(m[2], 10) - 1] + ' ' + m[1] : String(iso || '');
}
function posNum(p) { const n = parseInt(p, 10); return isNaN(n) ? null : n; }
function surname(name) {
  const parts = String(name || '').replace(/\s*\([^)]*\)/g, '').trim().split(/\s+/);
  return parts.length ? parts[parts.length - 1] : '';
}
function classLabel(c) { const m = String(c || '').match(/\d+/); return m ? 'Class ' + m[0] : (c ? String(c) : ''); }

// ── Facts computed in code from ALL rows ───────────────────────────────────
// rows: form:history rows, newest first. cardTrainer: the card's current
// trainer, appended as a zero-run spell when the newest row's trainer differs.
function buildFacts(rowsNewestFirst, raceDistF, cardTrainer) {
  const rows = rowsNewestFirst.filter(function(r) { return r && r.date; });
  const asc = rows.slice().sort(function(a, b) { return String(a.date).localeCompare(String(b.date)); });
  const isPlace = function(r) { const p = posNum(r.pos); return p === 2 || p === 3; };
  const facts = {};

  // career
  const runs = asc.length;
  const wins = asc.filter(function(r) { return posNum(r.pos) === 1; }).length;
  const seconds = asc.filter(function(r) { return posNum(r.pos) === 2; }).length;
  const thirds = asc.filter(function(r) { return posNum(r.pos) === 3; }).length;
  let spanMonths = 0, longestGap = null, shortestGap = null;
  if (runs) {
    const first = Date.parse(asc[0].date), last = Date.parse(asc[asc.length - 1].date);
    spanMonths = Math.round((last - first) / (30.44 * 86400000));
    for (let i = 1; i < asc.length; i++) {
      const gap = Math.round((Date.parse(asc[i].date) - Date.parse(asc[i - 1].date)) / 86400000);
      if (longestGap === null || gap > longestGap) longestGap = gap;
      if (shortestGap === null || gap < shortestGap) shortestGap = gap;
    }
  }
  facts.career = { runs: runs, wins: wins, seconds: seconds, thirds: thirds, spanMonths: spanMonths, longestGapDays: longestGap, shortestGapDays: shortestGap,
    firstRun: runs ? asc[0].date : null, lastRun: runs ? asc[asc.length - 1].date : null };

  // at the race's distance
  const atD = asc.filter(function(r) { return furlongs(r.dist) === raceDistF; });
  facts.atDistance = {
    distance: distLabel(raceDistF), runs: atD.length,
    wins: atD.filter(function(r) { return posNum(r.pos) === 1; }).length,
    placings: atD.filter(function(r) { const p = posNum(r.pos); return p !== null && p <= 3; })
      .map(function(r) { return { pos: posNum(r.pos), ran: Number(r.ran) || 0, course: stripParens(r.course), date: r.date }; })
  };

  // other distances
  const byDist = {};
  asc.forEach(function(r) {
    const f = furlongs(r.dist); if (f === raceDistF || !f) return;
    const k = distLabel(f); byDist[k] = byDist[k] || { distance: k, runs: 0, best: null };
    byDist[k].runs++; const p = posNum(r.pos); if (p !== null && (byDist[k].best === null || p < byDist[k].best)) byDist[k].best = p;
  });
  facts.otherDistances = Object.keys(byDist).map(function(k) { return byDist[k]; });

  // going record
  const byGoing = {};
  asc.forEach(function(r) {
    const g = primaryGoing(r.going) || 'Unknown';
    byGoing[g] = byGoing[g] || { going: g, runs: 0, wins: 0, placings: 0 };
    byGoing[g].runs++; if (posNum(r.pos) === 1) byGoing[g].wins++; if (isPlace(r)) byGoing[g].placings++;
  });
  facts.going = Object.keys(byGoing).map(function(k) { return byGoing[k]; });

  // courses
  const byCourse = {};
  asc.forEach(function(r) {
    const c = stripParens(r.course) || 'Unknown';
    byCourse[c] = byCourse[c] || { course: c, runs: 0, positions: [] };
    byCourse[c].runs++; byCourse[c].positions.push({ pos: r.pos, ran: Number(r.ran) || 0, date: r.date, distance: distLabel(furlongs(r.dist)) });
  });
  facts.courses = Object.keys(byCourse).map(function(k) { return byCourse[k]; });

  // field sizes
  const withRan = asc.filter(function(r) { return Number(r.ran) > 0; });
  if (withRan.length) {
    const big = withRan.reduce(function(a, r) { return Number(r.ran) > Number(a.ran) ? r : a; });
    const small = withRan.reduce(function(a, r) { return Number(r.ran) < Number(a.ran) ? r : a; });
    facts.fieldSizes = { largest: { size: Number(big.ran), pos: big.pos, course: stripParens(big.course), date: big.date },
      smallest: { size: Number(small.ran), pos: small.pos, course: stripParens(small.course), date: small.date } };
  } else facts.fieldSizes = null;

  // last 4, newest first
  facts.last4 = rows.slice(0, 4).map(function(r) { return { date: r.date, course: stripParens(r.course), pos: r.pos, ran: Number(r.ran) || 0, distance: distLabel(furlongs(r.dist)), going: primaryGoing(r.going) }; });

  // spells — consecutive runs under the same trainer, career order
  const spells = [];
  asc.forEach(function(r) {
    const t = String(r.trainer || '').trim() || 'Unknown';
    const cur = spells[spells.length - 1];
    if (cur && cur.trainer.toLowerCase() === t.toLowerCase()) cur.rows.push(r); else spells.push({ trainer: t, rows: [r] });
  });
  const cardT = String(cardTrainer || '').trim();
  if (cardT && (!spells.length || spells[spells.length - 1].trainer.toLowerCase() !== cardT.toLowerCase())) spells.push({ trainer: cardT, rows: [] });
  facts.spells = spells.map(function(s, i) {
    const rs = s.rows; const current = i === spells.length - 1;
    const uniq = function(arr) { return arr.filter(function(x, k) { return x && arr.indexOf(x) === k; }); };
    return {
      trainer: s.trainer, surname: surname(s.trainer), current: current,
      from: rs.length ? monYear(rs[0].date) : '', to: current ? 'current' : (rs.length ? monYear(rs[rs.length - 1].date) : ''),
      firstRun: rs.length ? rs[0].date : null, lastRun: rs.length ? rs[rs.length - 1].date : null,
      runs: rs.length, wins: rs.filter(function(r) { return posNum(r.pos) === 1; }).length, placings: rs.filter(isPlace).length,
      distances: uniq(rs.map(function(r) { return distLabel(furlongs(r.dist)); })),
      classes: uniq(rs.map(function(r) { return classLabel(r.race_class || r.class); })),
      jockeys: uniq(rs.map(function(r) { return String(r.jockey || '').trim(); }))
    };
  });
  return facts;
}

// ── Envelope text ──────────────────────────────────────────────────────────

function rowLine(r) {
  const cls = classLabel(r.race_class || r.class);
  return [dayMonYear(r.date), stripParens(r.course) + (/(AW)/.test(String(r.course)) ? ' (AW)' : ''), distLabel(furlongs(r.dist)) || String(r.dist || ''),
    primaryGoing(r.going) || '-', (r.pos || '-') + ' of ' + (r.ran || '?'), 'SP ' + (r.sp || '-'), cls || '-', 'T: ' + (r.trainer || '-'), 'J: ' + (r.jockey || '-')].join(' | ');
}

function factsText(f) {
  const L = [];
  const c = f.career;
  L.push('Career: ' + c.runs + ' runs, ' + c.wins + ' wins, ' + c.seconds + ' 2nds, ' + c.thirds + ' 3rds; span ' + c.spanMonths + ' months (' + dayMonYear(c.firstRun) + ' to ' + dayMonYear(c.lastRun) + ')' +
    (c.longestGapDays !== null ? '; longest gap between runs ' + c.longestGapDays + ' days, shortest ' + c.shortestGapDays + ' days' : '') + '.');
  const d = f.atDistance;
  L.push('At the race distance (' + d.distance + '): ' + d.runs + ' runs, ' + d.wins + ' wins' + (d.placings.length ? '; placings ' + d.placings.map(function(p) { return p.pos + (p.pos === 1 ? 'st' : p.pos === 2 ? 'nd' : 'rd') + ' of ' + p.ran + ' (' + p.course + ', ' + dayMonYear(p.date) + ')'; }).join(', ') : '; no placings') + '.');
  L.push('Other distances: ' + (f.otherDistances.length ? f.otherDistances.map(function(o) { return o.distance + ' ' + o.runs + ' run' + (o.runs === 1 ? '' : 's') + ', best ' + (o.best === null ? '-' : o.best); }).join('; ') : 'none') + '.');
  L.push('Going: ' + f.going.map(function(g) { return g.going + ' ' + g.runs + ' run' + (g.runs === 1 ? '' : 's') + ', ' + g.wins + ' win' + (g.wins === 1 ? '' : 's') + ', ' + g.placings + ' placing' + (g.placings === 1 ? '' : 's'); }).join('; ') + '.');
  L.push('Courses: ' + f.courses.map(function(cs) { return cs.course + ' ' + cs.positions.map(function(p) { return p.pos + ' of ' + p.ran + ' (' + p.distance + ', ' + dayMonYear(p.date) + ')'; }).join(', '); }).join('; ') + '.');
  if (f.fieldSizes) L.push('Field sizes: largest ' + f.fieldSizes.largest.size + ' (' + f.fieldSizes.largest.pos + ' of ' + f.fieldSizes.largest.size + ', ' + f.fieldSizes.largest.course + ', ' + dayMonYear(f.fieldSizes.largest.date) + '); smallest ' + f.fieldSizes.smallest.size + ' (' + f.fieldSizes.smallest.pos + ' of ' + f.fieldSizes.smallest.size + ', ' + f.fieldSizes.smallest.course + ', ' + dayMonYear(f.fieldSizes.smallest.date) + ').');
  L.push('Last 4 (newest first): ' + f.last4.map(function(r) { return dayMonYear(r.date) + ' ' + r.course + ' ' + r.distance + ' ' + r.going + ' ' + r.pos + ' of ' + r.ran; }).join('; ') + '.');
  L.push('Spells (career order, current trainer last):');
  f.spells.forEach(function(s, i) {
    L.push('  ' + (i + 1) + '. ' + s.trainer + ' — ' + (s.runs ? s.from + ' to ' + s.to + ', ' + s.runs + ' run' + (s.runs === 1 ? '' : 's') + ', ' + s.wins + ' win' + (s.wins === 1 ? '' : 's') + ', ' + s.placings + ' placing' + (s.placings === 1 ? '' : 's') +
      '; distances ' + s.distances.join(', ') + '; classes ' + (s.classes.filter(Boolean).join(', ') || 'unknown') + '; jockeys ' + (s.jockeys.filter(Boolean).join(', ') || 'unknown') : 'current trainer, no runs yet for this yard') + '.');
  });
  return L.join('\n');
}

// horse: card runner; race: { course, dist }; rows: newest-first history rows.
function buildEnvelope(horse, race, rows) {
  const raceDistF = furlongs(race.dist);
  const facts = buildFacts(rows, raceDistF, horse.trainer);
  const last12 = rows.slice(0, ROWS_IN_ENVELOPE);
  const text = [
    'RACE: ' + stripParens(race.course) + ', ' + distLabel(raceDistF) + '.',
    'HORSE: ' + horse.name + ' — age ' + (horse.age || '?') + ', ' + (horse.sex || 'sex unknown') + '. By ' + (horse.sire || 'unknown sire') + ' out of ' + (horse.dam || 'unknown dam') + (horse.damsire ? ' (damsire ' + horse.damsire + ')' : '') + '. Current trainer: ' + (horse.trainer || 'unknown') + '.',
    '',
    'LAST ' + last12.length + ' RUNS (newest first): date | course | distance | going | position of field | SP | class | trainer | jockey',
    last12.map(rowLine).join('\n'),
    '',
    'FACTS (computed from all ' + facts.career.runs + ' runs — authoritative):',
    factsText(facts)
  ].join('\n');
  return { facts: facts, raceCourse: stripParens(race.course), raceDistance: distLabel(raceDistF), raceDistF: raceDistF, rows: rows, text: text };
}

// ── The static system block (verbatim) ─────────────────────────────────────

const STATIC_PROMPT = "You write three texts about one racehorse from its record. Use ONLY the rows and computed facts provided. The facts block is authoritative for every count — never count rows yourself, never state a number that is not in the facts or rows. If the data does not support a statement, leave it out: a shorter section is correct, a filled one is a failure.\n\n" +
"SHARED RULES: Every sentence carries a number, a date, a course, a distance or a name. Finishing positions as '3rd of 7', never '3/7'. Each section opens with the pattern the record shows, proves it with the rows, and stops — no flourish, no character, no conclusion the numbers don't contain. Certainty matches the evidence: a horse with 2-3 runs gets description, not conclusions — say plainly when the record is too short to call a preference. Never reference the upcoming race's going, field size, or anything that can change before the off. The race's course and distance are fixed and may be referenced where the section rules allow. Each section owns its lens and must not repeat another section's point.\n\n" +
"TEXT 1 — FORM SUMMARY, four sections:\n" +
"RECENT FORM (30-50 words): the direction and pattern of the horse's own record — the last four runs, what changed, where placings cluster. Past field sizes are facts and may be used. Never mention the upcoming race's field size.\n" +
"GOING (30-45 words): the record by going, then ONE conditional read ('the quicker the better' / 'wants cut' / 'no clear preference'). Never the upcoming race's going.\n" +
"TRIP (40-60 words): open with the race's distance at its course ('1m2f at Epsom asks nothing new' / 'is new ground'). Then the record AT THAT DISTANCE ONLY — runs, placings with positions — and how the rest differs. Never speculate about distances the horse is not running.\n" +
"TRACK (50-70 words): open with the race's course and its character (configuration, undulation, stiffness — factual only). Then courses run with positions, the most comparable tracks in the record and how it ran there, and the pattern that matters at this course.\n\n" +
"WORKED EXAMPLE (Blue Noon, 8 runs, Epsom 1m2f) — this is the standard:\n" +
"Recent form: 'Improving through the summer — placed in three of her last four after four starts without a placing, and the one miss (5th of 12, Goodwood, 28 Aug) came in her biggest field of the year. Every placing has come in a field of nine or fewer; both runs in fields of 12 were 4th and 5th.'\n" +
"Going: 'Quick summer ground is fine, but her form sharpens as it firms — both seconds came on Gd To Firm, while she's 0-4 with two 3rds on Good. The quicker the better; untested with real cut.'\n" +
"Trip: '1m2f at Epsom asks nothing new — 7 of her 8 starts have been at the trip and all four placings came there (2nd of 5, 2nd of 3, 3rd of 9, 3rd of 11). Her only start away from it was 7f on debut, 4th of 12, and she has since been kept exclusively at 1m2f.'\n" +
"Track: 'Epsom's downhill, cambered 1m2f is the one thing her record hasn't covered — seven tracks in eight starts, none worse than 6th. She has run her best on stiff, galloping finishes (both 2nds at Sandown and Newmarket) and her two weakest on the sharper, undulating ones (Chester 6th of 10, Goodwood 5th of 12) — which is the pattern to weigh at Epsom.'\n\n" +
"TEXT 2 — TRAINER HISTORY: one paragraph per spell from the facts block's spell list, 45-70 words each, single-run spells shorter. Decision lens: what this trainer changed or chose — trips, class, courses, jockeys, spacing, what was avoided — with results only as evidence of whether it worked. Compare to the previous spell by that trainer's surname. Close each spell with a plain verdict: working / declining / too early to call. No reference to any upcoming race. No 'began her career under' openers. Never repeat the horse's name inside a paragraph.\n\n" +
"WORKED EXAMPLES:\n" +
"Current spell (Musical Angel, Dow): 'Dow's plan has been a narrowing: pitched her into a Class 2 early (too deep, 8th of 16), then abandoned experiments and committed to the Epsom 7f route — three of her last four runs at that exact course and distance. He has also upgraded the saddle each time it mattered: Bradley for the quiet runs, Marquand then Davies for the targets. The placement is working — each Epsom run has finished closer, 8th to 3rd to 2nd.'\n" +
"Past spell (Musical Angel, Balding): 'Balding built her patiently: started at 6f, kept her in Class 4-5 company where she could win (Brighton, then Lingfield placings), and only stepped her to 7f at the very end of the spell — where she immediately won at Epsom. He found her trip last, and the yard moved her on just as the penny dropped.'\n" +
"Single-run current spell (Sky Captain, O'Brien): 'One run so far, and it broke every pattern of the previous yard: dropped to 1m2f (his shortest trip), a field of 22 (his biggest by ten), a first start in eleven months. He finished 6th. Too early to read as a plan or a failure — a single prep run tells you where he was, not where he's going.'\n\n" +
"TEXT 3 — HORSE SUMMARY: one paragraph, 60-100 words, fact-led. Order: pedigree line ('By X out of Y' — nothing more about the sire), career shape (runs, span, spacing), the record with the bands it sits in (trip, going, field size), yards with run counts, the one exception if there is one, then the 'never' boundaries. No character words, no today.\n\n" +
"WORKED EXAMPLE (Sky Captain): 'By Sea The Moon out of [dam]. Just 5 runs in 15 months, never two inside a month. One win (Roscommon, 1m4f) and three seconds — all four placings between 1m4f and 1m6f, on Good or Yielding, in fields of 12 or fewer. Beaten only twice: once at 6/5 favourite, and once on his sole start outside that band, 6th of 22 at 1m2f — his first run for a new yard after eleven months with Twomey. Never past 1m6f, never on ground softer than Yielding.'\n\n" +
"OUTPUT: strict JSON only, no markdown: {\"recentForm\":\"\",\"going\":\"\",\"trip\":\"\",\"track\":\"\",\"trainerSpells\":[{\"trainer\":\"\",\"from\":\"Mon YYYY\",\"to\":\"Mon YYYY or current\",\"text\":\"\"}],\"horseSummary\":\"\"}";

function batchRequest(customId, userText) {
  return {
    custom_id: customId,
    params: {
      model: MODEL,
      max_tokens: MAX_TOKENS,
      system: [{ type: 'text', text: STATIC_PROMPT, cache_control: { type: 'ephemeral' } }],
      messages: [{ role: 'user', content: userText }]
    }
  };
}

// ── Debutant templates (no call) ──────────────────────────────────────────

function debutantTexts(horse, race) {
  const ped = 'By ' + (horse.sire || 'an unrecorded sire') + ' out of ' + (horse.dam || 'an unrecorded dam') + '.';
  const line = 'No previous runs on record — this is the first start.';
  return {
    recentForm: line, going: 'Unraced: no going record yet.', trip: distLabel(furlongs(race.dist)) + ' at ' + stripParens(race.course) + ' is the first trip tried.',
    track: stripParens(race.course) + ' is the first course tried.',
    trainerSpells: [{ trainer: horse.trainer || '', from: '', to: 'current', text: 'First start for ' + (surname(horse.trainer) || 'this yard') + ' — no runs on record yet, nothing to read until it has run.' }],
    horseSummary: ped + ' Unraced. ' + line
  };
}

// ── Handler ────────────────────────────────────────────────────────────────

exports.handler = async function(event) {
  const headers = { 'Content-Type': 'application/json' };
  const qs = (event && event.queryStringParameters) || {};
  const secret = (event.headers && event.headers['x-build-secret']) || qs.secret;
  if (secret !== process.env.BUILD_SECRET) return { statusCode: 401, headers, body: JSON.stringify({ error: 'Unauthorised' }) };
  const date = /^\d{4}-\d{2}-\d{2}$/.test(qs.date || '') ? qs.date : irishDateStr();
  const tag = '[text-engine submit ' + date + ']';

  try {
    const card = await redisGet('racecards:' + date);
    if (!card || !Array.isArray(card.meetings)) return { statusCode: 200, headers, body: JSON.stringify({ error: 'no racecards:' + date }) };

    // Distinct horses, first race each, non-runners skipped.
    const horses = []; const seen = {};
    card.meetings.forEach(function(m) { (m.races || []).forEach(function(r) { (r.runners || []).forEach(function(ru) {
      if (!ru.horse_id || seen[ru.horse_id]) return;
      if (ru.nonRunner === true || ru.price === 'NR') return;
      seen[ru.horse_id] = true;
      horses.push({ horse: ru, race: { course: m.name, dist: r.dist, time: r.t } });
    }); }); });

    const hv = await redisMGet(horses.map(function(h) { return 'form:history:' + h.horse.horse_id + ':' + date; }));
    const requests = []; const envelopes = {}; const debutants = []; const noKey = [];
    horses.forEach(function(h, i) {
      const rows = hv[i];
      if (!Array.isArray(rows)) { noKey.push(h.horse.horse_id); return; }
      if (!rows.length) { debutants.push(h); return; }
      const env = buildEnvelope(h.horse, h.race, rows);
      envelopes[h.horse.horse_id] = { horseName: h.horse.name, course: env.raceCourse, distance: env.raceDistance, text: env.text };
      requests.push(batchRequest(h.horse.horse_id, env.text));
    });

    // Debutants: fixed template to all three key families, no call.
    let debutantWrites = 0;
    for (const h of debutants) {
      const t = debutantTexts(h.horse, h.race); const now = new Date().toISOString(); const id = h.horse.horse_id;
      try {
        await redisSet('form-summary:' + id + ':' + date, { horseName: h.horse.name, summary: t.recentForm, recentForm: t.recentForm, going: t.going, trip: t.trip, track: t.track, styleVersion: 4, generatedAt: now, course: stripParens(h.race.course), distance: distLabel(furlongs(h.race.dist)), debutant: true });
        await redisSet('horse:trainer-history:' + id, { horseName: h.horse.name, spells: t.trainerSpells, generatedAt: now, source: 'text-engine', debutant: true });
        await redisSet('horse:summary:' + id, { horseName: h.horse.name, text: t.horseSummary, generatedAt: now, source: 'text-engine', debutant: true });
        debutantWrites++;
      } catch (e) { console.log(tag, 'debutant write failed', id, e.message); }
    }

    if (!requests.length) {
      await redisSet('text-engine:batch:' + date, { date: date, batchId: null, horseCount: 0, debutantCount: debutants.length, noHistoryKey: noKey.length, submittedAt: new Date().toISOString(), phase: 'nothing-to-submit' });
      return { statusCode: 200, headers, body: JSON.stringify({ date: date, batchId: null, horses: 0, debutants: debutants.length, noHistoryKey: noKey.length }) };
    }

    // One Message Batch, one request per horse, static block cached.
    const resp = await anthropic('POST', '/v1/messages/batches', { requests: requests });
    if (resp.status !== 200 || !resp.json || !resp.json.id) {
      console.log(tag, 'batch submit failed', resp.status, resp.raw.slice(0, 300));
      return { statusCode: 502, headers, body: JSON.stringify({ error: 'batch submit failed', status: resp.status, detail: (resp.json && resp.json.error) || resp.raw.slice(0, 300) }) };
    }
    const record = {
      date: date, batchId: resp.json.id, phase: 'first', model: MODEL, maxTokens: MAX_TOKENS,
      horseCount: requests.length, debutantCount: debutants.length, debutantWrites: debutantWrites, noHistoryKey: noKey.length,
      submittedAt: new Date().toISOString(), envelopes: envelopes
    };
    await redisSet('text-engine:batch:' + date, record);
    console.log(tag, 'submitted batch', resp.json.id, '| horses', requests.length, '| debutants', debutants.length, '| no history key', noKey.length);
    return { statusCode: 200, headers, body: JSON.stringify({ date: date, batchId: resp.json.id, horses: requests.length, debutants: debutants.length, debutantWrites: debutantWrites, noHistoryKey: noKey.length }) };
  } catch (e) {
    console.log(tag, 'ERROR', e.message);
    return { statusCode: 500, headers, body: JSON.stringify({ error: e.message }) };
  }
};

// Shared with text-engine-collect-background.js (validator) and local harnesses.
module.exports.STATIC_PROMPT = STATIC_PROMPT;
module.exports.buildEnvelope = buildEnvelope;
module.exports.buildFacts = buildFacts;
module.exports.debutantTexts = debutantTexts;
module.exports.helpers = { furlongs: furlongs, distLabel: distLabel, primaryGoing: primaryGoing, stripParens: stripParens, monYear: monYear, surname: surname, posNum: posNum, redisGet: redisGet, redisSet: redisSet, redisMGet: redisMGet, anthropic: anthropic, irishDateStr: irishDateStr, MODEL: MODEL, MAX_TOKENS: MAX_TOKENS };
