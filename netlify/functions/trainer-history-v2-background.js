// trainer-history-v2-background.js
//
// TRAINER HISTORY on the fact-builder architecture (lib/form-sections.js,
// section H): code splits each horse's stored form:history into consecutive-
// trainer spells and computes every figure, change and verdict; one DIRECT
// Anthropic call per horse phrases one paragraph per spell; a validator
// checks number membership, betting/future words and trainer attribution;
// one retry with failure notes, then the horse is marked validate-failed and
// nothing partial is stored.
//
// Invocation: POST /.netlify/functions/trainer-history-v2-background
//   ?dates=YYYY-MM-DD[,YYYY-MM-DD...]   (default: Irish today)
//   &costCap=N  &horseIds=a,b,c  &hop=N
// with x-build-secret. Horses are deduplicated across the dates; each horse's
// rows come from form:history:{id}:{firstDateItRunsOn}.
//
// SKIP RULE: a horse whose stored horse:trainer-history record has
// source 'facts-v1' AND lastRunDate equal to its newest history row has not
// run since it was written — skipped, no call.
//
// Writes horse:trainer-history:{horse_id} (no TTL) =
//   { horseName, spells: [{ trainer, from, to, text, runs, wins, places }],
//     generatedAt, lastRunDate, source: 'facts-v1' }
// — the shape get-horse-profile.js / horse-form.js attach as trainerHistory
// and index.html renders by matching spells[].trainer to its own per-run
// spell list and showing spells[].text.
// Markers: { horseName, spells: [], reason: 'no-data' | 'validate-failed',
//   generatedAt, lastRunDate, source: 'facts-v1' } — validate-failed is only
// written when no earlier record with text exists, so a horse never loses a
// displayed history to a failed rewrite.
//
// Same lock / worklist / heartbeat / self-chaining pattern as
// form-sections-run-background.js: 780 s budget per hop, worker pool of 8
// over a shared queue, atomic cost-cap accounting, warm-up call so the
// cached system prompt is written once before 8 concurrent reads.

module.exports.config = { timeout: 900 };

const https = require('https');
const F = require('./lib/form-sections.js');
const E = require('./text-engine-submit-background.js').helpers;

const HOSTNAME = 'superlative-flan-93dfc4.netlify.app';
const TIMEOUT_MS = 780 * 1000;
const LOCK_WINDOW_MS = 800 * 1000;
const HOP_CAP = 12;
const CONCURRENCY = 8;
const PRICE = { input: 3, output: 15, cacheWrite: 3.75, cacheRead: 0.3 };
const DEFAULT_COST_CAP_USD = 15.00;
const EMPTY_USAGE = { input: 0, output: 0, cacheWrite: 0, cacheRead: 0 };
const KEY = 'trainer-history-v2:';
function costOf(u) { return +((u.input * PRICE.input + u.output * PRICE.output + u.cacheWrite * PRICE.cacheWrite + u.cacheRead * PRICE.cacheRead) / 1e6).toFixed(4); }
function addUsage(a, b) { return { input: a.input + b.input, output: a.output + b.output, cacheWrite: a.cacheWrite + b.cacheWrite, cacheRead: a.cacheRead + b.cacheRead }; }
function usageFrom(json) { const u = (json && json.usage) || {}; return { input: u.input_tokens || 0, output: u.output_tokens || 0, cacheWrite: u.cache_creation_input_tokens || 0, cacheRead: u.cache_read_input_tokens || 0 }; }

// Horses across the requested dates, deduplicated; each carries the first
// date it runs on (its form:history key) and the card trainer. Also returns
// every trainer surname on those cards for the attribution check.
async function eligibleHorses(dates) {
  const seen = {}; const list = []; const surnames = {};
  for (const date of dates) {
    const card = await E.redisGet('racecards:' + date);
    if (!card || !Array.isArray(card.meetings)) continue;
    card.meetings.forEach(function(m) {
      (m.races || []).forEach(function(race) {
        (race.runners || []).forEach(function(ru) {
          if (!ru || !ru.horse_id) return;
          if (ru.trainer) F.trainerSurnames(ru.trainer).forEach(function(s) { surnames[s] = true; });
          if (seen[ru.horse_id]) return;
          if (ru.nonRunner === true || ru.price === 'NR') return;
          seen[ru.horse_id] = true;
          list.push({ horse_id: ru.horse_id, name: ru.name || 'Unknown', sex: ru.sex || 'unknown sex', trainer: ru.trainer || '', date: date, meeting: m.name || m.id });
        });
      });
    });
  }
  return { horses: list, knownTrainerSurnames: Object.keys(surnames) };
}

async function callModel(userText) {
  return E.anthropic('POST', '/v1/messages', {
    model: E.MODEL,
    max_tokens: F.TRAINER_HISTORY_MAX_TOKENS,
    system: [{ type: 'text', text: F.TRAINER_HISTORY_PROMPT, cache_control: { type: 'ephemeral' } }],
    messages: [{ role: 'user', content: userText }]
  });
}

async function appendTelemetry(runKey, entries) {
  if (!entries || !entries.length) return;
  try { const k = 'trainer-history:telemetry:' + runKey; const existing = await E.redisGet(k); await E.redisSet(k, (Array.isArray(existing) ? existing : []).concat(entries)); } catch (e) {}
}

async function processHorse(h, runKey, knownTrainerSurnames) {
  const rows = await E.redisGet('form:history:' + h.horse_id + ':' + h.date);
  const allRows = Array.isArray(rows) ? rows : [];
  const newest = allRows.filter(function(r) { return r && r.date; }).map(function(r) { return r.date; }).sort().pop() || null;
  const existing = await E.redisGet('horse:trainer-history:' + h.horse_id);
  const existingHasText = !!(existing && Array.isArray(existing.spells) && existing.spells.some(function(s) { return s && s.text; }));
  const nowIso = new Date().toISOString();

  // SKIP RULE
  if (existing && existing.source === 'facts-v1' && newest && existing.lastRunDate === newest && !existing.reason) {
    return { horse_id: h.horse_id, horseName: h.name, skipped: true, usage: EMPTY_USAGE };
  }

  const spells = F.buildTrainerSpells(allRows);
  if (!spells.length) {
    if (!existingHasText) await E.redisSet('horse:trainer-history:' + h.horse_id, { horseName: h.name, spells: [], reason: 'no-data', generatedAt: nowIso, lastRunDate: newest, source: 'facts-v1' });
    return { horse_id: h.horse_id, horseName: h.name, noData: true, usage: EMPTY_USAGE };
  }
  const facts = F.buildTrainerHistoryFacts(spells);
  const envelope = F.buildTrainerHistoryEnvelope(h, facts);
  const spellTrainers = spells.map(function(s) { return s.trainer; });
  const vopts = { horseName: h.name, spellTrainers: spellTrainers, knownTrainerSurnames: knownTrainerSurnames };
  let usage = EMPTY_USAGE; let firstWriteUsage = null; let cacheRead = false; const rawCaptures = [];

  async function write(userText) {
    const resp = await callModel(userText);
    if (resp.status !== 200 || !resp.json || !Array.isArray(resp.json.content)) return { error: 'HTTP ' + resp.status + ' ' + (resp.raw || '').slice(0, 200) };
    const u = usageFrom(resp.json); usage = addUsage(usage, u);
    if (!firstWriteUsage) { firstWriteUsage = u; cacheRead = u.cacheRead > 0; }
    const text = resp.json.content.map(function(c) { return c.text || ''; }).join('');
    if (resp.json.stop_reason === 'max_tokens') rawCaptures.push({ runKey: runKey, ts: new Date().toISOString(), horseName: h.name, horse_id: h.horse_id, check: 'max-tokens-raw', stage: rawCaptures.length ? 'retry' : 'first', outputTokens: u.output, rawHead: text.slice(0, 1500), rawTail: text.slice(-600), detail: 'stop_reason=max_tokens' });
    return { text: text, stopReason: resp.json.stop_reason };
  }
  // Validate one model reply against the spells: array length must match,
  // each entry's trainer must be that spell's trainer (matched by surname),
  // and each text passes validateTrainerSpell against its own fact lines.
  function validateAll(text) {
    const arr = F.parseJsonArray(text);
    if (!arr) return { jsonFail: 'output was not a JSON array', perSpell: null };
    if (arr.length !== spells.length) return { jsonFail: 'expected ' + spells.length + ' spell entries, got ' + arr.length, perSpell: null };
    const perSpell = arr.map(function(entry, i) {
      const r = F.validateTrainerSpell(entry && entry.text, facts[i].lines, vopts);
      // An echoed header ("Name (since Jul 2023, 32 runs)") is tolerated: any
      // trailing parenthetical is stripped before the surname comparison.
      const named = String((entry && entry.trainer) || '').replace(/\s*\([^)]*\)\s*$/, '').trim();
      if (!(entry && F.sameTrainerSpell(named, spells[i].trainer))) r.failures.push({ check: 'spell-order', detail: 'entry ' + (i + 1) + ' names "' + (entry && entry.trainer) + '" but spell ' + (i + 1) + ' is ' + spells[i].trainer }), r.ok = false;
      if (r.wordCount > 75) r.warnings = [{ words: r.wordCount, cap: 65 }];
      return r;
    });
    return { jsonFail: null, perSpell: perSpell };
  }
  const failuresOf = function(v) {
    if (v.jsonFail) return [{ spell: 0, trainer: '*', check: 'json', detail: v.jsonFail }];
    const out = []; v.perSpell.forEach(function(r, i) { r.failures.forEach(function(f) { out.push({ spell: i + 1, trainer: spells[i].trainer, check: f.check, detail: f.detail }); }); }); return out;
  };

  const first = await write(envelope);
  if (first.error) return { horse_id: h.horse_id, horseName: h.name, stored: false, error: first.error, attempt: 1, usage: usage, firstWriteUsage: firstWriteUsage, cacheRead: cacheRead };
  let v = validateAll(first.text); let fails = failuresOf(v); let attempt = 1; let telemetry = [];
  const factsText = facts.map(function(f) { return f.lines.join('\n'); }).join('\n\n');
  if (fails.length) {
    telemetry = telemetry.concat(fails.map(function(f) { return { runKey: runKey, ts: new Date().toISOString(), horseName: h.name, horse_id: h.horse_id, spell: f.spell, trainer: f.trainer, check: f.check, detail: f.detail, stage: 'first', facts: factsText }; }));
    const notes = fails.map(function(f) { return (f.trainer === '*' ? 'WHOLE REPLY' : 'SPELL ' + f.spell + ' (' + f.trainer + ')') + ': ' + f.check + ' — ' + f.detail; }).join('\n');
    const second = await write(envelope + '\n\nYOUR PREVIOUS ATTEMPT FAILED THESE CHECKS — rewrite using only the facts listed, every spell again, in order:\n' + notes);
    attempt = 2;
    if (second.error) fails = [{ spell: 0, trainer: '*', check: 'http', detail: second.error }];
    else { v = validateAll(second.text); fails = failuresOf(v); }
    if (fails.length) telemetry = telemetry.concat(fails.map(function(f) { return { runKey: runKey, ts: new Date().toISOString(), horseName: h.name, horse_id: h.horse_id, spell: f.spell, trainer: f.trainer, check: f.check, detail: f.detail, stage: 'retry', facts: factsText }; }));
  }
  await appendTelemetry(runKey, telemetry.concat(rawCaptures));

  if (fails.length) {
    if (!existingHasText) await E.redisSet('horse:trainer-history:' + h.horse_id, { horseName: h.name, spells: [], reason: 'validate-failed', generatedAt: nowIso, lastRunDate: newest, source: 'facts-v1' });
    return { horse_id: h.horse_id, horseName: h.name, stored: false, validateFailed: true, failures: fails, attempt: attempt, usage: usage, firstWriteUsage: firstWriteUsage, cacheRead: cacheRead, keptExisting: existingHasText };
  }
  const record = {
    horseName: h.name,
    spells: spells.map(function(s, i) { return { trainer: s.trainer, from: s.from, to: s.current ? 'current' : s.to, text: v.perSpell[i].text, runs: s.runs, wins: s.wins, places: s.places }; }),
    generatedAt: nowIso, lastRunDate: newest, source: 'facts-v1'
  };
  await E.redisSet('horse:trainer-history:' + h.horse_id, record);
  return { horse_id: h.horse_id, horseName: h.name, stored: true, spells: spells.length, attempt: attempt, usage: usage, firstWriteUsage: firstWriteUsage, cacheRead: cacheRead, words: v.perSpell.map(function(r) { return r.wordCount; }), firstPassClean: attempt === 1 };
}

async function run(dates, qs, hop, startTime, headers) {
  const runKey = dates.join('+');
  console.log('[trainer-history-v2] START', new Date().toISOString(), 'dates:', runKey, 'hop:', hop);
  try { await E.redisSet(KEY + 'heartbeat:' + runKey, { startedAt: new Date().toISOString(), hop: hop }); } catch (e) {}
  try {
    const lock = await E.redisGet(KEY + 'lock:' + runKey);
    if (lock && lock.startedAt) { const age = Date.now() - new Date(lock.startedAt).getTime(); if (age >= 0 && age < LOCK_WINDOW_MS) return { statusCode: 200, headers, body: JSON.stringify({ skipped: true, reason: 'already in progress', lockStartedAt: lock.startedAt }) }; }
    await E.redisSet(KEY + 'lock:' + runKey, { startedAt: new Date().toISOString() });
  } catch (e) {}

  try {
    let state = hop > 0 ? await E.redisGet(KEY + 'worklist:' + runKey) : null;
    let remaining, results, knownTrainerSurnames; const acct = { usage: EMPTY_USAGE };
    let counts;
    if (state) { remaining = state.remaining; results = state.results; counts = state.counts; acct.usage = state.usage || EMPTY_USAGE; knownTrainerSurnames = state.knownTrainerSurnames || []; }
    else {
      const el = await eligibleHorses(dates);
      remaining = el.horses; knownTrainerSurnames = el.knownTrainerSurnames;
      if (qs.horseIds) { const wanted = {}; String(qs.horseIds).split(',').map(function(s) { return s.trim(); }).filter(Boolean).forEach(function(id) { wanted[id] = true; }); remaining = remaining.filter(function(h) { return wanted[h.horse_id]; }); }
      results = []; counts = { total: remaining.length, stored: 0, skipped: 0, noData: 0, validateFailed: 0, errors: 0, firstPassClean: 0, retried: 0, cacheReadCalls: 0 };
      console.log('[trainer-history-v2]', remaining.length, 'horses across', dates.length, 'date(s)');
    }
    const costCap = qs.costCap ? (parseFloat(qs.costCap) || DEFAULT_COST_CAP_USD) : DEFAULT_COST_CAP_USD;
    let timedOut = false, costCapped = false;
    function record(r) {
      results.push({ horse_id: r.horse_id, horseName: r.horseName, stored: !!r.stored, skipped: !!r.skipped, noData: !!r.noData, validateFailed: !!r.validateFailed, error: r.error || null, attempt: r.attempt || 0, spells: r.spells || 0, words: r.words || null, failures: r.failures || null, keptExisting: !!r.keptExisting });
      acct.usage = addUsage(acct.usage, r.usage || EMPTY_USAGE);
      if (r.skipped) counts.skipped++; else if (r.noData) counts.noData++; else if (r.stored) { counts.stored++; if (r.firstPassClean) counts.firstPassClean++; else counts.retried++; if (r.cacheRead) counts.cacheReadCalls++; } else if (r.validateFailed) { counts.validateFailed++; counts.retried++; } else counts.errors++;
    }
    async function safe(h) { try { return await processHorse(h, runKey, knownTrainerSurnames); } catch (e) { return { horse_id: h.horse_id, horseName: h.name, stored: false, error: e.message, usage: EMPTY_USAGE }; } }
    function mayContinue() { if (Date.now() - startTime > TIMEOUT_MS) { timedOut = true; return false; } if (costOf(acct.usage) >= costCap) { costCapped = true; return false; } return true; }
    if (remaining.length && hop === 0 && !state && mayContinue()) record(await safe(remaining.shift()));   // warm-up: cache written once
    async function worker() { while (remaining.length && mayContinue()) record(await safe(remaining.shift())); }
    const workers = []; for (let i = 0; i < CONCURRENCY && remaining.length; i++) workers.push(worker());
    await Promise.all(workers);

    const cost = costOf(acct.usage);
    const finish = async function(status, extra) {
      const coverage = Object.assign({ runKey: runKey, dates: dates, completedAt: new Date().toISOString(), counts: counts, results: results, usage: acct.usage, costUSD: cost, hops: hop + 1, concurrency: CONCURRENCY, pricing: PRICE }, extra || {});
      await E.redisSet(KEY + 'coverage:' + runKey, coverage);
      await E.redisSet(KEY + 'worklist:' + runKey, null);
      try { await E.redisSet(KEY + 'lock:' + runKey, null); } catch (e) {}
      console.log('[trainer-history-v2] ' + status.toUpperCase(), JSON.stringify(counts), 'cost', cost);
      return { statusCode: 200, headers, body: JSON.stringify({ status: status, coverage: coverage }) };
    };
    if (costCapped) { remaining.forEach(function(h) { results.push({ horse_id: h.horse_id, horseName: h.name, stored: false, error: 'not processed — cost cap $' + costCap.toFixed(2) + ' reached at $' + cost.toFixed(4) }); }); return finish('cost_capped', { costCapped: true, costCapUSD: costCap, remainingAtStop: remaining.length }); }
    if (timedOut && remaining.length) {
      if (hop < HOP_CAP) {
        await E.redisSet(KEY + 'worklist:' + runKey, { remaining: remaining, results: results, counts: counts, usage: acct.usage, knownTrainerSurnames: knownTrainerSurnames });
        try { await E.redisSet(KEY + 'lock:' + runKey, null); } catch (e) {}
        await new Promise(function(resolve) {
          const req = https.request({ hostname: HOSTNAME, path: '/.netlify/functions/trainer-history-v2-background?dates=' + encodeURIComponent(dates.join(',')) + '&hop=' + (hop + 1) + (qs.costCap ? '&costCap=' + encodeURIComponent(qs.costCap) : '') + (qs.horseIds ? '&horseIds=' + encodeURIComponent(qs.horseIds) : ''), method: 'POST', headers: { 'x-build-secret': process.env.BUILD_SECRET || '', 'Content-Length': 0 } }, function(res) { res.resume(); res.on('end', resolve); });
          req.on('error', function() { resolve(); }); req.setTimeout(10000, function() { req.destroy(); resolve(); }); req.end();
        });
        console.log('[trainer-history-v2] chaining hop', hop + 1, 'with', remaining.length, 'horse(s) left');
        return { statusCode: 200, headers, body: JSON.stringify({ status: 'partial', hop: hop, remaining: remaining.length, counts: counts }) };
      }
      remaining.forEach(function(h) { results.push({ horse_id: h.horse_id, horseName: h.name, stored: false, error: 'not processed — hop cap' }); });
    }
    return finish('done');
  } catch (err) {
    try { await E.redisSet(KEY + 'lock:' + runKey, null); } catch (e) {}
    console.log('[trainer-history-v2] ERROR', err && err.stack || err);
    return { statusCode: 500, headers, body: JSON.stringify({ error: (err && err.message) || String(err) }) };
  }
}

exports.handler = async function(event) {
  const startTime = Date.now();
  const headers = { 'Content-Type': 'application/json' };
  const qs = (event && event.queryStringParameters) || {};
  const secret = (event.headers && event.headers['x-build-secret']) || qs.secret;
  if (secret !== process.env.BUILD_SECRET) return { statusCode: 401, headers, body: JSON.stringify({ error: 'Unauthorised' }) };
  const hop = Math.max(0, parseInt(qs.hop, 10) || 0);
  const dates = String(qs.dates || qs.date || '').split(',').map(function(s) { return s.trim(); }).filter(function(s) { return /^\d{4}-\d{2}-\d{2}$/.test(s); });
  if (!dates.length) dates.push(E.irishDateStr());
  return run(Array.from(new Set(dates)).sort(), qs, hop, startTime, headers);
};
