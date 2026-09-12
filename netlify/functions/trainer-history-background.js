const https = require('https');

// trainer-history-background.js
//
// Trial job (2026-09-13 only unless ?date= is passed). For every declared
// runner on the target date's cached racecard this:
//   1. pre-builds the horse profile cache (horse:profile:v2:{horse_id}) using
//      exactly the same fetch + cache logic as get-horse-profile.js, so the
//      profile panel on the site is instant for every runner that day;
//   2. splits the horse's full results history into trainer "spells" (a new
//      spell whenever the trainer name changes), computes per-spell stats,
//      and asks Claude for one short factual paragraph per spell;
//   3. stores the result under horse:trainer-history:{horse_id} (7-day TTL).
//
// Nothing on the site triggers this. It is only ever invoked as a background
// job — manually via trainer-history-test-background.js with the
// x-build-secret header. Same lock / heartbeat / complete / time-budget
// semantics as form-summary-background.js.

module.exports.config = { timeout: 900 };

const UPSTASH_URL = process.env.UPSTASH_REDIS_REST_URL;
const UPSTASH_TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN;
const RACING_AUTH = Buffer.from(
  (process.env.RACING_API_USERNAME || '') + ':' + (process.env.RACING_API_KEY || '')
).toString('base64');
const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY;

// ── Redis + Racing API helpers — copied verbatim from get-horse-profile.js ──

function redisGet(key) {
  if (!UPSTASH_URL || !UPSTASH_TOKEN) return Promise.resolve(null);
  const url = new URL(UPSTASH_URL);
  return new Promise(resolve => {
    const req = https.request({
      hostname: url.hostname,
      path: '/get/' + encodeURIComponent(key),
      method: 'GET',
      headers: { 'Authorization': 'Bearer ' + UPSTASH_TOKEN }
    }, res => {
      let d = '';
      res.on('data', c => d += c);
      res.on('end', () => {
        try { const r = JSON.parse(d); resolve(r.result ? JSON.parse(r.result) : null); }
        catch(e) { resolve(null); }
      });
    });
    req.on('error', () => resolve(null));
    req.end();
  });
}

// Set with expiry — Upstash REST takes TTL as ?EX={seconds} on the /set/
// path (the same established-safe pattern get-results.js and
// form-summary-background.js use; only NX-style params are the historic
// footgun here).
function redisSetEx(key, value, ttlSeconds) {
  if (!UPSTASH_URL || !UPSTASH_TOKEN) return Promise.resolve(null);
  const url = new URL(UPSTASH_URL);
  const body = JSON.stringify(value);
  return new Promise(resolve => {
    const req = https.request({
      hostname: url.hostname,
      path: '/set/' + encodeURIComponent(key) + '?EX=' + ttlSeconds,
      method: 'POST',
      headers: { 'Authorization': 'Bearer ' + UPSTASH_TOKEN, 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) }
    }, res => { let d = ''; res.on('data', c => d += c); res.on('end', () => resolve(d)); });
    req.on('error', () => resolve(null)); req.write(body); req.end();
  });
}

// Set with no TTL — for the heartbeat / lock / complete markers. Same https
// pattern as redisSetEx, minus the ?EX segment.
function redisSet(key, value) {
  if (!UPSTASH_URL || !UPSTASH_TOKEN) return Promise.resolve(null);
  const url = new URL(UPSTASH_URL);
  const body = JSON.stringify(value);
  return new Promise(resolve => {
    const req = https.request({
      hostname: url.hostname,
      path: '/set/' + encodeURIComponent(key),
      method: 'POST',
      headers: { 'Authorization': 'Bearer ' + UPSTASH_TOKEN, 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) }
    }, res => { let d = ''; res.on('data', c => d += c); res.on('end', () => resolve(d)); });
    req.on('error', () => resolve(null)); req.write(body); req.end();
  });
}

function apiGetRacing(path) {
  return new Promise((resolve, reject) => {
    const req = https.request({
      hostname: 'api.theracingapi.com', path: path, method: 'GET',
      headers: { 'Authorization': 'Basic ' + RACING_AUTH, 'Accept': 'application/json' }
    }, res => {
      let d = ''; res.on('data', c => d += c);
      res.on('end', () => { try { const parsed = JSON.parse(d); parsed._httpStatus = res.statusCode; resolve(parsed); } catch(e) { reject(new Error('Parse error')); } });
    });
    req.on('error', reject); req.end();
  });
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function fetchAllResults(horseId) {
  const PAGE = 50, MAX_PAGES = 4;
  let all = [], first = null;
  for (let pg = 0; pg < MAX_PAGES; pg++) {
    let body;
    try {
      body = await apiGetRacing('/v1/horses/' + encodeURIComponent(horseId)
        + '/results?limit=' + PAGE + '&skip=' + (pg * PAGE));
    } catch (e) { body = null; }
    if (!body || body.detail || !Array.isArray(body.results)) {
      if (pg === 0) return null;
      break;
    }
    if (pg === 0) first = body;
    all = all.concat(body.results);
    if (body.results.length < PAGE) break;
  }
  return Object.assign({}, first, { results: all, total: all.length, limit: all.length, skip: 0 });
}

// ── Claude — minimal, no tools, modelled on daily-build-background.js ────────

function apiPost(hostname, path, headers, body) {
  const b = JSON.stringify(body);
  return new Promise((resolve, reject) => {
    const req = https.request({
      hostname, path, method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(b), ...headers }
    }, res => {
      let d = ''; res.on('data', c => d += c);
      res.on('end', () => { try { const parsed = JSON.parse(d); if (parsed && typeof parsed === 'object' && res.statusCode !== 200) parsed.__httpStatus = res.statusCode; resolve(parsed); } catch(e) { reject(new Error('Parse')); } });
    });
    req.on('error', reject); req.setTimeout(290000); req.write(b); req.end();
  });
}

async function callClaude(systemPrompt, userMessage, maxTokens) {
  const body = {
    model: 'claude-sonnet-4-6',
    max_tokens: maxTokens || 900,
    system: systemPrompt,
    messages: [{ role: 'user', content: userMessage }]
  };
  const resp = await apiPost('api.anthropic.com', '/v1/messages', {
    'x-api-key': ANTHROPIC_KEY,
    'anthropic-version': '2023-06-01'
  }, body);
  const usage = (resp && resp.usage) || {};
  const content = (resp && resp.content) || [];
  const text = content.filter(b => b.type === 'text').map(b => b.text).join('\n');
  return {
    text,
    inputTokens: usage.input_tokens || 0,
    outputTokens: usage.output_tokens || 0,
    apiError: resp && resp.type === 'error'
      ? 'API ' + (resp.__httpStatus || '?') + ': ' + ((resp.error && (resp.error.message || resp.error.type)) || 'unknown error')
      : null
  };
}

// ── Spell computation ────────────────────────────────────────────────────────

function normTrainer(s) {
  return String(s || '').toLowerCase().replace(/[^a-z0-9]/g, '');
}

function daysBetween(a, b) {
  const da = new Date(a), db = new Date(b);
  if (isNaN(da.getTime()) || isNaN(db.getTime())) return null;
  return Math.round((db.getTime() - da.getTime()) / 86400000);
}

// "2m4f" → 20, "7f" → 7, "1m110y" → 8.5, "2m4½f" → 20.5. null if unparseable.
function distStrToF(s) {
  s = String(s || '').toLowerCase().replace(/\s+/g, '');
  if (!s) return null;
  let f = 0, ok = false;
  const m = s.match(/(\d+(?:\.\d+)?)m/);
  if (m) { f += parseFloat(m[1]) * 8; ok = true; }
  const fu = s.match(/(\d+(?:\.\d+)?)(?:½)?f/);
  if (fu) { f += parseFloat(fu[1]); if (/½f/.test(s)) f += 0.5; ok = true; }
  const y = s.match(/(\d+)y/);
  if (y) { f += parseInt(y[1], 10) / 220; ok = true; }
  return ok ? Math.round(f * 10) / 10 : null;
}

// race.dist_f is the API's furlong string (e.g. "23f"); fall back to race.dist.
function parseDistF(race) {
  if (race.dist_f != null && race.dist_f !== '') {
    const n = parseFloat(String(race.dist_f));
    if (!isNaN(n)) return n;
  }
  return distStrToF(race.dist);
}

function round1(n) { return Math.round(n * 10) / 10; }

function computeSpells(results, horseId) {
  const races = ((results && results.results) || [])
    .filter(function(r) { return r && r.date; })
    .slice()
    .sort(function(a, b) { return String(a.date).localeCompare(String(b.date)); });

  const spells = [];
  let cur = null;
  races.forEach(function(race) {
    const runner = (race.runners || []).find(function(r) { return r.horse_id === horseId; }) || {};
    const trainer = runner.trainer || '';
    const key = normTrainer(trainer);
    if (!cur || cur.key !== key) {
      cur = { key: key, trainer: trainer || 'Unknown', from: race.date, to: race.date,
              runs: 0, wins: 0, places: 0, dists: [], goings: {}, classes: [], gaps: [],
              positions: [], courseSet: {}, lastDate: null };
      spells.push(cur);
    }
    const pos = String(runner.position || '').trim();
    cur.runs++;
    if (pos === '1') cur.wins++;
    if (pos === '2' || pos === '3') cur.places++;
    cur.to = race.date;
    const df = parseDistF(race);
    if (df != null) cur.dists.push(df);
    const going = String(race.going || '').trim() || 'Unknown';
    cur.goings[going] = (cur.goings[going] || 0) + 1;
    // Results endpoint returns the class under `class` (see daily-build-
    // background.js fetchHorseHistory); race_class kept as a fallback.
    const cls = race.class || race.race_class || '';
    if (cls && cur.classes.indexOf(cls) === -1) cur.classes.push(cls);
    cur.positions.push(pos || '-');
    if (race.course) cur.courseSet[race.course] = true;
    if (cur.lastDate) {
      const gap = daysBetween(cur.lastDate, race.date);
      if (gap != null) cur.gaps.push(gap);
    }
    cur.lastDate = race.date;
  });

  return spells.map(function(s) {
    const spanDays = daysBetween(s.from, s.to) || 0;
    // Months spanned, floored at one month so a single-run spell reads as
    // "1 run/month" rather than dividing by zero.
    const months = Math.max(spanDays / 30.44, 1);
    const avgGap = s.gaps.length ? round1(s.gaps.reduce(function(a, b) { return a + b; }, 0) / s.gaps.length) : null;
    return {
      trainer: s.trainer,
      from: s.from,
      to: s.to,
      runs: s.runs,
      wins: s.wins,
      places: s.places,
      minDistF: s.dists.length ? Math.min.apply(null, s.dists) : null,
      maxDistF: s.dists.length ? Math.max.apply(null, s.dists) : null,
      goings: s.goings,
      classes: s.classes,
      avgGapDays: avgGap,
      maxGapDays: s.gaps.length ? Math.max.apply(null, s.gaps) : null,
      positions: s.positions,
      courses: Object.keys(s.courseSet).length,
      runsPerMonth: round1(s.runs / months)
    };
  });
}

// ── Prompt build + parse ─────────────────────────────────────────────────────

const SYSTEM_PROMPT = 'You are an expert horse racing form analyst writing for Racing Edge. Output strictly valid JSON.';

const INSTRUCTION =
  'Write one paragraph per trainer spell, 45-70 words each, in plain factual prose, third person. ' +
  'Describe what that trainer did with the horse — trip range, ground, spacing between runs, class — ' +
  'and what the results were under them. For spells after the first, say what changed versus the ' +
  'previous trainer and whether results improved, held or fell away. For a spell with fewer than 3 runs, ' +
  'be honest that it is too early to call a pattern. No opinions about the future, no tips, no prices. ' +
  'No markdown. Return ONLY a JSON array, one object per spell in the same order, each ' +
  '{"trainer":"<name>","text":"<paragraph>"}.';

function pct(n, d) { return d ? Math.round((n / d) * 100) : 0; }
function fmtF(v) { return v == null ? '?' : (v + 'f'); }
function fmtDelta(n, unit) { if (n == null) return 'n/a'; return (n > 0 ? '+' : '') + n + unit; }

function buildUserMessage(horseName, spells) {
  const lines = ['Horse: ' + horseName, ''];
  spells.forEach(function(s, i) {
    const goingStr = Object.keys(s.goings).map(function(g) { return g + ' ' + s.goings[g]; }).join(', ') || 'unknown';
    lines.push('Spell ' + (i + 1) + ': ' + s.trainer);
    lines.push('  Period: ' + s.from + ' to ' + s.to);
    lines.push('  Runs: ' + s.runs + ' | Wins: ' + s.wins + ' | Places (2nd/3rd): ' + s.places
      + ' | Win rate: ' + pct(s.wins, s.runs) + '% | Win-or-place rate: ' + pct(s.wins + s.places, s.runs) + '%');
    lines.push('  Trip range: ' + fmtF(s.minDistF) + ' to ' + fmtF(s.maxDistF));
    lines.push('  Going (runs): ' + goingStr);
    lines.push('  Classes: ' + (s.classes.length ? s.classes.join(', ') : 'unknown'));
    lines.push('  Spacing: avg gap ' + (s.avgGapDays == null ? 'n/a' : s.avgGapDays + ' days')
      + ', max gap ' + (s.maxGapDays == null ? 'n/a' : s.maxGapDays + ' days')
      + ', ' + s.runsPerMonth + ' runs per month');
    lines.push('  Distinct courses: ' + s.courses);
    lines.push('  Finishing positions in order: ' + s.positions.join(', '));
    if (i > 0) {
      const p = spells[i - 1];
      const dMin = (s.minDistF != null && p.minDistF != null) ? round1(s.minDistF - p.minDistF) : null;
      const dMax = (s.maxDistF != null && p.maxDistF != null) ? round1(s.maxDistF - p.maxDistF) : null;
      const dGap = (s.avgGapDays != null && p.avgGapDays != null) ? round1(s.avgGapDays - p.avgGapDays) : null;
      lines.push('  Versus previous spell: min trip ' + fmtDelta(dMin, 'f') + ', max trip ' + fmtDelta(dMax, 'f')
        + ', avg gap ' + fmtDelta(dGap, ' days')
        + ', win rate ' + pct(p.wins, p.runs) + '% -> ' + pct(s.wins, s.runs) + '%'
        + ', win-or-place rate ' + pct(p.wins + p.places, p.runs) + '% -> ' + pct(s.wins + s.places, s.runs) + '%');
    }
    lines.push('');
  });
  lines.push(INSTRUCTION);
  return lines.join('\n');
}

// First '[' to last ']' — tolerates any preamble or trailing text. Returns the
// parsed array or null.
function parseSpellArray(text) {
  try {
    const s = String(text || '');
    const a = s.indexOf('['), b = s.lastIndexOf(']');
    if (a === -1 || b === -1 || b <= a) return null;
    const arr = JSON.parse(s.slice(a, b + 1));
    return Array.isArray(arr) ? arr : null;
  } catch (e) { return null; }
}

function statsOnly(spells) {
  return spells.map(function(s) {
    return { trainer: s.trainer, from: s.from, to: s.to, runs: s.runs, wins: s.wins, places: s.places,
             minDistF: s.minDistF, maxDistF: s.maxDistF, avgGapDays: s.avgGapDays, classes: s.classes };
  });
}

// ── Profile fetch (mirrors get-horse-profile.js, sequential + paced) ─────────

const RACING_PACE_MS = 250; // ~4 req/s, under the API's 5 req/s limit

async function fetchProfileAndResults(horseId) {
  await sleep(RACING_PACE_MS);
  let profile = null;
  try {
    profile = await apiGetRacing('/v1/horses/' + encodeURIComponent(horseId) + '/pro');
    if (profile && profile._httpStatus === 429) {
      await sleep(3000);
      try { profile = await apiGetRacing('/v1/horses/' + encodeURIComponent(horseId) + '/pro'); } catch (e) {}
    }
  } catch (e) { profile = null; }
  if (profile && profile.detail) profile = null;

  await sleep(RACING_PACE_MS);
  let results = null;
  try {
    results = await fetchAllResults(horseId);
    if (results && results._httpStatus === 429) {
      await sleep(3000);
      try { results = await fetchAllResults(horseId); } catch (e) {}
    }
  } catch (e) { results = null; }

  if (profile) delete profile._httpStatus;
  if (results) delete results._httpStatus;
  return { profile: profile, results: results };
}

// ── Handler ──────────────────────────────────────────────────────────────────

exports.handler = async function(event) {
  const startTime = Date.now();
  const headers = { 'Access-Control-Allow-Origin': '*', 'Content-Type': 'application/json' };
  const isScheduled = !event.httpMethod;
  const qs = (event && event.queryStringParameters) || {};
  const DATE = (qs.date && /^\d{4}-\d{2}-\d{2}$/.test(qs.date)) ? qs.date : '2026-09-13';
  // Self-chain hop counter — a partial run re-invokes itself via the test twin
  // with hop+1 until the day is complete or the cap (8) is reached.
  const hop = Math.max(0, parseInt(qs.hop, 10) || 0);

  console.log('[trainer-history] START', new Date().toISOString(), 'date:', DATE, 'hop:', hop, 'scheduled:', isScheduled);

  // Heartbeat — fire-and-forget first write so an invocation killed early
  // still leaves evidence in Redis.
  try {
    if (UPSTASH_URL && UPSTASH_TOKEN) {
      redisSet('trainer-history:heartbeat:' + DATE, {
        startedAt: new Date().toISOString(),
        scheduled: isScheduled
      }).catch(function() {});
    }
  } catch (hbErr) {}

  if (!isScheduled) {
    const secret = (event.queryStringParameters && event.queryStringParameters.secret) || (event.headers && event.headers['x-build-secret']);
    if (secret !== process.env.BUILD_SECRET) {
      return { statusCode: 401, headers, body: JSON.stringify({ error: 'Unauthorised' }) };
    }
  }

  // In-progress lock — 800s window, just under the 900s function timeout so
  // a lock left behind by a hard-killed run never blocks the next one.
  const LOCK_WINDOW_MS = 800 * 1000;
  const now = new Date();
  try {
    const existingLock = await redisGet('trainer-history:lock:' + DATE);
    if (existingLock && existingLock.startedAt) {
      const lockAgeMs = now.getTime() - new Date(existingLock.startedAt).getTime();
      if (lockAgeMs >= 0 && lockAgeMs < LOCK_WINDOW_MS) {
        console.log('[trainer-history] already in progress (started ' + Math.round(lockAgeMs / 1000) + 's ago) — standing down.');
        return { statusCode: 200, headers, body: JSON.stringify({ skipped: true, reason: 'trainer-history already in progress', lockStartedAt: existingLock.startedAt }) };
      }
    }
    await redisSet('trainer-history:lock:' + DATE, { startedAt: now.toISOString(), scheduled: isScheduled });
  } catch (lockErr) { /* lock check/write failure must never block the run itself */ }

  const TIMEOUT_MS = 780 * 1000;
  let timedOut = false;
  const counts = { total: 0, generated: 0, skipped: 0, noResults: 0, tooFew: 0, parseFailed: 0, errors: 0 };
  const tokens = { input: 0, output: 0 };

  try {
    // ── Runners for the target date ──
    const card = await redisGet('racecards:' + DATE);
    const runners = [];
    const seen = new Set();
    if (card && Array.isArray(card.meetings)) {
      card.meetings.forEach(function(m) {
        (m.races || []).forEach(function(race) {
          (race.runners || []).forEach(function(r) {
            if (!r.horse_id || seen.has(r.horse_id)) return;
            seen.add(r.horse_id);
            runners.push({ horse_id: r.horse_id, name: r.name || '' });
          });
        });
      });
    }
    counts.total = runners.length;

    if (!runners.length) {
      console.log('[trainer-history] no racecard / no runners with horse_id for', DATE);
      const marker = { status: 'no-card', date: DATE, completedAt: new Date().toISOString(), counts: counts, tokens: tokens,
                       elapsedSec: Math.round((Date.now() - startTime) / 1000), timedOut: false };
      try { await redisSet('trainer-history:complete:' + DATE, marker); } catch (ce) {}
      try { await redisSet('trainer-history:lock:' + DATE, null); } catch (ue) {}
      return { statusCode: 200, headers, body: JSON.stringify(marker) };
    }
    console.log('[trainer-history] ' + runners.length + ' runners to process for ' + DATE);

    // ── Per-runner loop, time-budgeted ──
    for (const runner of runners) {
      if (Date.now() - startTime > TIMEOUT_MS) {
        timedOut = true;
        console.log('[trainer-history] approaching 900s timeout (' + Math.round((Date.now() - startTime) / 1000) + 's elapsed) — stopping with ' + counts.generated + ' generated so far; a re-run continues from here');
        break;
      }
      const id = runner.horse_id;
      const horseName = runner.name;
      const thKey = 'horse:trainer-history:' + id;
      const profileKey = 'horse:profile:v2:' + id;

      try {
        // Skip if already generated within the last 7 days.
        const existing = await redisGet(thKey);
        if (existing && existing.generatedAt) {
          const ageMs = Date.now() - new Date(existing.generatedAt).getTime();
          if (ageMs >= 0 && ageMs < 7 * 86400000) {
            counts.skipped++;
            continue;
          }
        }

        // Profile — reuse the 24h cache when it already holds results,
        // otherwise fetch both halves and cache them exactly as
        // get-horse-profile.js would.
        let results = null;
        const cached = await redisGet(profileKey);
        if (cached && cached.results) {
          results = cached.results;
        } else {
          const fetched = await fetchProfileAndResults(id);
          if (fetched.profile && fetched.results) {
            try { await redisSetEx(profileKey, { profile: fetched.profile, results: fetched.results }, 86400); } catch (e) {}
          }
          results = fetched.results;
        }

        if (!results || !Array.isArray(results.results)) {
          counts.noResults++;
          console.log('[trainer-history] ' + horseName + ' (' + id + '): no results — stored no-results marker');
          await redisSetEx(thKey, { horseName: horseName, spells: [], reason: 'no-results', generatedAt: new Date().toISOString(), date: DATE }, 604800);
          continue;
        }

        // Spells + gate on total runs.
        const spells = computeSpells(results, id);
        const totalRuns = spells.reduce(function(a, s) { return a + s.runs; }, 0);
        if (totalRuns < 3) {
          counts.tooFew++;
          console.log('[trainer-history] ' + horseName + ' (' + id + '): ' + totalRuns + ' run(s) — too few, stats only');
          await redisSetEx(thKey, { horseName: horseName, spells: statsOnly(spells), reason: 'too-few-runs', generatedAt: new Date().toISOString(), date: DATE }, 604800);
          continue;
        }

        // Claude — one call, one retry on a bad parse or length mismatch.
        const userMessage = buildUserMessage(horseName, spells);
        let parsed = null, lastErr = null;
        for (let attempt = 0; attempt < 2 && !parsed; attempt++) {
          if (Date.now() - startTime > TIMEOUT_MS) break;
          const resp = await callClaude(SYSTEM_PROMPT, userMessage, 900);
          tokens.input += resp.inputTokens;
          tokens.output += resp.outputTokens;
          if (resp.apiError) { lastErr = resp.apiError; console.log('[trainer-history] ' + horseName + ': ' + resp.apiError + (attempt === 0 ? ' — retrying once' : '')); continue; }
          const arr = parseSpellArray(resp.text);
          if (arr && arr.length === spells.length) { parsed = arr; }
          else { lastErr = 'parse-failed (got ' + (arr ? arr.length : 'no array') + ', expected ' + spells.length + ')'; console.log('[trainer-history] ' + horseName + ': ' + lastErr + (attempt === 0 ? ' — retrying once' : '')); }
        }

        if (!parsed) {
          counts.parseFailed++;
          await redisSetEx(thKey, { horseName: horseName, spells: statsOnly(spells), reason: 'parse-failed', error: lastErr || null, generatedAt: new Date().toISOString(), date: DATE }, 604800);
          continue;
        }

        const stored = {
          horseName: horseName,
          generatedAt: new Date().toISOString(),
          date: DATE,
          spells: spells.map(function(s, i) {
            const p = parsed[i] || {};
            return { trainer: s.trainer, from: s.from, to: s.to, runs: s.runs, wins: s.wins, places: s.places,
                     minDistF: s.minDistF, maxDistF: s.maxDistF, avgGapDays: s.avgGapDays, classes: s.classes,
                     text: String(p.text || '').trim() };
          })
        };
        await redisSetEx(thKey, stored, 604800);
        counts.generated++;
        console.log('[trainer-history] ' + horseName + ' (' + id + '): ' + spells.length + ' spell(s), ' + totalRuns + ' runs — generated');
      } catch (perHorseErr) {
        counts.errors++;
        console.log('[trainer-history] ' + horseName + ' (' + id + '): ERROR ' + (perHorseErr && perHorseErr.message));
      }
    }

    const summary = {
      status: timedOut ? 'partial' : 'complete',
      date: DATE,
      completedAt: new Date().toISOString(),
      counts: counts,
      tokens: tokens,
      elapsedSec: Math.round((Date.now() - startTime) / 1000),
      timedOut: timedOut,
      hop: hop
    };
    try { await redisSet('trainer-history:complete:' + DATE, summary); } catch (ce) {}
    console.log('[trainer-history] DONE', JSON.stringify(summary));
    try { await redisSet('trainer-history:lock:' + DATE, null); } catch (ue) {}
    // Self-chain: a partial run hands the remaining runners to a fresh
    // invocation (the lock is already released above, so the next hop starts
    // straight away). Capped at 8 hops so a stuck day can never loop forever.
    if (timedOut && hop < 8) {
      try {
        await new Promise(function(resolve){
          const req = https.request({
            hostname: 'superlative-flan-93dfc4.netlify.app',
            path: '/.netlify/functions/trainer-history-test-background?date=' + DATE + '&hop=' + (hop + 1),
            method: 'POST',
            headers: { 'x-build-secret': process.env.BUILD_SECRET || '', 'Content-Length': 0 }
          }, function(res){ res.resume(); res.on('end', resolve); });
          req.on('error', function(){ resolve(); });
          req.setTimeout(10000, function(){ req.destroy(); resolve(); });
          req.end();
        });
        console.log('[trainer-history] partial — self-chained hop ' + (hop + 1));
      } catch (e) {}
    } else if (timedOut) {
      console.log('[trainer-history] hop cap reached — not chaining');
    }
    return { statusCode: 200, headers, body: JSON.stringify(summary) };
  } catch (e) {
    console.log('[trainer-history] ERROR', e.message);
    try { await redisSet('trainer-history:lock:' + DATE, null); } catch (ue) {}
    return { statusCode: 500, headers, body: JSON.stringify({ error: e.message, date: DATE, counts: counts, tokens: tokens, elapsedSec: Math.round((Date.now() - startTime) / 1000) }) };
  }
};
