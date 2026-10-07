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
const B = require('./lib/batch-runner.js');

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

// Telemetry is keyed by the RUN (a timestamp id minted at hop 0 and carried
// through the chain), not by the dates — successive runs over the same dates
// must not accumulate into one key.
async function appendTelemetry(runId, entries) {
  if (!entries || !entries.length) return;
  try { const k = 'trainer-history:telemetry:' + runId; const existing = await E.redisGet(k); await E.redisSet(k, (Array.isArray(existing) ? existing : []).concat(entries)); } catch (e) {}
}

// ── Per-horse pipeline, split so the live loop and the Batch collector share
// ONE validate-and-store path:
//   prepareTrainer(h, known)     -> skip rule, no-data marker, facts, envelope
//   finishTrainer(job, first, runId) -> validation of the FIRST reply, one
//                                   LIVE retry, storage / markers, telemetry.
async function prepareTrainer(h, knownTrainerSurnames) {
  const rows = await E.redisGet('form:history:' + h.horse_id + ':' + h.date);
  const allRows = Array.isArray(rows) ? rows : [];
  const newest = allRows.filter(function(r) { return r && r.date; }).map(function(r) { return r.date; }).sort().pop() || null;
  const existing = await E.redisGet('horse:trainer-history:' + h.horse_id);
  const existingHasText = !!(existing && Array.isArray(existing.spells) && existing.spells.some(function(s) { return s && s.text; }));
  // SKIP RULE
  if (existing && existing.source === 'facts-v1' && newest && existing.lastRunDate === newest && !existing.reason) return { h: h, skip: true, newest: newest };
  const spells = F.buildTrainerSpells(allRows);
  if (!spells.length) return { h: h, noData: true, newest: newest, existingHasText: existingHasText };
  const facts = F.buildTrainerHistoryFacts(spells);
  const envelope = F.buildTrainerHistoryEnvelope(h, facts);
  const vopts = { horseName: h.name, spellTrainers: spells.map(function(s) { return s.trainer; }), knownTrainerSurnames: knownTrainerSurnames || [], courseNames: F.courseNamesForExemption(allRows) };
  return { h: h, newest: newest, existingHasText: existingHasText, spells: spells, facts: facts, envelope: envelope, vopts: vopts };
}
async function storeNoData(job) {
  if (!job.existingHasText) await E.redisSet('horse:trainer-history:' + job.h.horse_id, { horseName: job.h.name, spells: [], reason: 'no-data', generatedAt: new Date().toISOString(), lastRunDate: job.newest, source: 'facts-v1' });
  return { horse_id: job.h.horse_id, horseName: job.h.name, noData: true, usage: EMPTY_USAGE };
}
async function writeTrainer(job, userText, stage, runId, rawCaptures) {
  const resp = await callModel(userText);
  if (resp.status !== 200 || !resp.json || !Array.isArray(resp.json.content)) return { error: 'HTTP ' + resp.status + ' ' + (resp.raw || '').slice(0, 200) };
  const u = usageFrom(resp.json);
  const text = resp.json.content.map(function(c) { return c.text || ''; }).join('');
  if (resp.json.stop_reason === 'max_tokens' && rawCaptures) rawCaptures.push({ runKey: runId, ts: new Date().toISOString(), horseName: job.h.name, horse_id: job.h.horse_id, check: 'max-tokens-raw', stage: stage, outputTokens: u.output, rawHead: text.slice(0, 1500), rawTail: text.slice(-600), detail: 'stop_reason=max_tokens' });
  return { text: text, stopReason: resp.json.stop_reason, usage: u };
}
// Validate one model reply against the spells: array length must match,
// each entry's trainer must be that spell's trainer (matched by surname;
// an echoed header "Name (since Jul 2023, 32 runs)" is tolerated), and each
// text passes validateTrainerSpell against its own fact lines.
function validateTrainer(job, text) {
  const arr = F.parseJsonArray(text);
  if (!arr) return { jsonFail: 'output was not a JSON array', perSpell: null };
  if (arr.length !== job.spells.length) return { jsonFail: 'expected ' + job.spells.length + ' spell entries, got ' + arr.length, perSpell: null };
  const perSpell = arr.map(function(entry, i) {
    const r = F.validateTrainerSpell(entry && entry.text, job.facts[i].lines, job.vopts);
    const named = String((entry && entry.trainer) || '').replace(/\s*\([^)]*\)\s*$/, '').trim();
    if (!(entry && F.sameTrainerSpell(named, job.spells[i].trainer))) { r.failures.push({ check: 'spell-order', detail: 'entry ' + (i + 1) + ' names "' + (entry && entry.trainer) + '" but spell ' + (i + 1) + ' is ' + job.spells[i].trainer }); r.ok = false; }
    if (r.wordCount > 75) r.warnings = [{ words: r.wordCount, cap: 65 }];
    return r;
  });
  return { jsonFail: null, perSpell: perSpell };
}
function trainerFailures(job, v) {
  if (v.jsonFail) return [{ spell: 0, trainer: '*', check: 'json', detail: v.jsonFail }];
  const out = []; v.perSpell.forEach(function(r, i) { r.failures.forEach(function(f) { out.push({ spell: i + 1, trainer: job.spells[i].trainer, check: f.check, detail: f.detail }); }); }); return out;
}

async function finishTrainer(job, first, runId) {
  const h = job.h; const nowIso = new Date().toISOString();
  const rawCaptures = [];
  if (first.stopReason === 'max_tokens') rawCaptures.push({ runKey: runId, ts: nowIso, horseName: h.name, horse_id: h.horse_id, check: 'max-tokens-raw', stage: 'first', outputTokens: first.usage.output, rawHead: first.text.slice(0, 1500), rawTail: first.text.slice(-600), detail: 'stop_reason=max_tokens' });
  let usage = first.usage; const firstWriteUsage = first.usage; const cacheRead = first.usage.cacheRead > 0;
  let v = validateTrainer(job, first.text); let fails = trainerFailures(job, v); let attempt = 1; let telemetry = [];
  const factsText = job.facts.map(function(f) { return f.lines.join('\n'); }).join('\n\n');
  const tel = function(stage) { return fails.map(function(f) { return { runKey: runId, ts: new Date().toISOString(), horseName: h.name, horse_id: h.horse_id, spell: f.spell, trainer: f.trainer, check: f.check, detail: f.detail, stage: stage, facts: factsText }; }); };
  if (fails.length) {
    telemetry = telemetry.concat(tel('first'));
    const notes = fails.map(function(f) { return (f.trainer === '*' ? 'WHOLE REPLY' : 'SPELL ' + f.spell + ' (' + f.trainer + ')') + ': ' + f.check + ' — ' + f.detail; }).join('\n');
    const second = await writeTrainer(job, job.envelope + '\n\nYOUR PREVIOUS ATTEMPT FAILED THESE CHECKS — rewrite using only the facts listed, every spell again, in order. Rewrite the failing sentence with different wording — returning the same sentence again fails permanently:\n' + notes, 'retry', runId, rawCaptures);
    attempt = 2;
    if (second.error) fails = [{ spell: 0, trainer: '*', check: 'http', detail: second.error }];
    else { usage = addUsage(usage, second.usage); v = validateTrainer(job, second.text); fails = trainerFailures(job, v); }
    if (fails.length) telemetry = telemetry.concat(tel('retry'));
  }
  await appendTelemetry(runId, telemetry.concat(rawCaptures));
  if (fails.length) {
    if (!job.existingHasText) await E.redisSet('horse:trainer-history:' + h.horse_id, { horseName: h.name, spells: [], reason: 'validate-failed', generatedAt: nowIso, lastRunDate: job.newest, source: 'facts-v1' });
    return { horse_id: h.horse_id, horseName: h.name, stored: false, validateFailed: true, failures: fails, attempt: attempt, usage: usage, firstWriteUsage: firstWriteUsage, cacheRead: cacheRead, keptExisting: job.existingHasText };
  }
  const record = {
    horseName: h.name,
    spells: job.spells.map(function(s, i) { return { trainer: s.trainer, from: s.from, to: s.current ? 'current' : s.to, text: v.perSpell[i].text, runs: s.runs, wins: s.wins, places: s.places }; }),
    generatedAt: nowIso, lastRunDate: job.newest, source: 'facts-v1'
  };
  await E.redisSet('horse:trainer-history:' + h.horse_id, record);
  return { horse_id: h.horse_id, horseName: h.name, stored: true, spells: job.spells.length, attempt: attempt, usage: usage, firstWriteUsage: firstWriteUsage, cacheRead: cacheRead, words: v.perSpell.map(function(r) { return r.wordCount; }), firstPassClean: attempt === 1 };
}

// LIVE path (default): prepare -> one direct call -> finish.
async function processHorse(h, runId, knownTrainerSurnames) {
  const job = await prepareTrainer(h, knownTrainerSurnames);
  if (job.skip) return { horse_id: h.horse_id, horseName: h.name, skipped: true, usage: EMPTY_USAGE };
  if (job.noData) return storeNoData(job);
  const first = await writeTrainer(job, job.envelope, 'first', runId, null);
  if (first.error) return { horse_id: h.horse_id, horseName: h.name, stored: false, error: first.error, attempt: 1, usage: EMPTY_USAGE, firstWriteUsage: null, cacheRead: false };
  return finishTrainer(job, first, runId);
}

// BATCH path: request body per horse (same model, prompt, cache block and
// envelope as callModel) and the collector adapter whose finish() is
// finishTrainer — the same function the live path calls.
function trainerBatchRequest(job) {
  return { custom_id: job.h.horse_id, params: { model: E.MODEL, max_tokens: F.TRAINER_HISTORY_MAX_TOKENS, system: [{ type: 'text', text: F.TRAINER_HISTORY_PROMPT, cache_control: { type: 'ephemeral' } }], messages: [{ role: 'user', content: job.envelope }] } };
}
function trainerBatchAdapter() {
  return {
    engine: 'trainer-history',
    finish: async function(customId, text, usage, stopReason, batchJob) {
      const h = batchJob.horses && batchJob.horses[customId];
      if (!h) return { horse_id: customId, stored: false, error: 'horse not in batch job record', usage: EMPTY_USAGE };
      const job = await prepareTrainer(h, batchJob.knownTrainerSurnames || []);
      if (job.skip) return { horse_id: customId, horseName: h.name, skipped: true, usage: EMPTY_USAGE };
      if (job.noData) return storeNoData(job);
      return finishTrainer(job, { text: text, stopReason: stopReason, usage: usage }, batchJob.runId || batchJob.batchId);
    }
  };
}

async function run(dates, qs, hop, startTime, headers) {
  const runKey = dates.join('+');
  const runId = (qs.run && /^[\w-]{8,40}$/.test(qs.run)) ? qs.run : new Date().toISOString().replace(/[:.]/g, '-');
  console.log('[trainer-history-v2] START', new Date().toISOString(), 'dates:', runKey, 'run:', runId, 'hop:', hop);
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
    async function safe(h) { try { return await processHorse(h, runId, knownTrainerSurnames); } catch (e) { return { horse_id: h.horse_id, horseName: h.name, stored: false, error: e.message, usage: EMPTY_USAGE }; } }
    function mayContinue() { if (Date.now() - startTime > TIMEOUT_MS) { timedOut = true; return false; } if (costOf(acct.usage) >= costCap) { costCapped = true; return false; } return true; }
    // BATCH MODE (?mode=batch): same worklist, same dedupe, same skip rule and
    // no-data marker as live (applied here, before submission); every
    // remaining horse's request goes into ONE Message Batch; job recorded at
    // batch:job:trainer-history:{batchId}; lock released; stop. Collect with
    // ?collect={batchId}.
    if (qs.mode === 'batch' && hop === 0 && !state) {
      const requests = []; const horsesById = {};
      for (const h of remaining) {
        const job = await prepareTrainer(h, knownTrainerSurnames);
        if (job.skip) { record({ horse_id: h.horse_id, horseName: h.name, skipped: true, usage: EMPTY_USAGE }); continue; }
        if (job.noData) { record(await storeNoData(job)); continue; }
        requests.push(trainerBatchRequest(job));
        horsesById[h.horse_id] = { horse_id: h.horse_id, name: h.name, sex: h.sex, trainer: h.trainer, date: h.date, meeting: h.meeting };
      }
      let submitted = null, submitError = null;
      if (requests.length) { try { submitted = await B.submitBatch(requests, { engine: 'trainer-history', dates: dates, horses: horsesById, knownTrainerSurnames: knownTrainerSurnames, runId: runId, costCap: costCap, submission: { eligible: counts.total, skipped: counts.skipped, noData: counts.noData, requests: requests.length } }); } catch (e) { submitError = e.message; } }
      try { await E.redisSet(KEY + 'lock:' + runKey, null); } catch (e) {}
      console.log('[trainer-history-v2] BATCH', submitted ? submitted.batchId : ('NOT SUBMITTED ' + (submitError || 'no requests')), 'requests', requests.length, JSON.stringify(counts));
      return { statusCode: submitError ? 500 : 200, headers, body: JSON.stringify({ status: submitError ? 'batch_submit_failed' : (requests.length ? 'batch_submitted' : 'nothing_to_submit'), dates: dates, batchId: submitted ? submitted.batchId : null, submitted: requests.length, skipped: counts.skipped, noData: counts.noData, error: submitError }) };
    }

    if (remaining.length && hop === 0 && !state && mayContinue()) record(await safe(remaining.shift()));   // warm-up: cache written once
    async function worker() { while (remaining.length && mayContinue()) record(await safe(remaining.shift())); }
    const workers = []; for (let i = 0; i < CONCURRENCY && remaining.length; i++) workers.push(worker());
    await Promise.all(workers);

    const cost = costOf(acct.usage);
    const finish = async function(status, extra) {
      const coverage = Object.assign({ runKey: runKey, runId: runId, telemetryKey: 'trainer-history:telemetry:' + runId, dates: dates, completedAt: new Date().toISOString(), counts: counts, results: results, usage: acct.usage, costUSD: cost, hops: hop + 1, concurrency: CONCURRENCY, pricing: PRICE }, extra || {});
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
          const req = https.request({ hostname: HOSTNAME, path: '/.netlify/functions/trainer-history-v2-background?dates=' + encodeURIComponent(dates.join(',')) + '&run=' + encodeURIComponent(runId) + '&hop=' + (hop + 1) + (qs.costCap ? '&costCap=' + encodeURIComponent(qs.costCap) : '') + (qs.horseIds ? '&horseIds=' + encodeURIComponent(qs.horseIds) : ''), method: 'POST', headers: { 'x-build-secret': process.env.BUILD_SECRET || '', 'Content-Length': 0 } }, function(res) { res.resume(); res.on('end', resolve); });
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

// ?collect={batchId}: every succeeded batch result goes through finishTrainer
// via the adapter — the same validation and storage as live. Resumable and
// self-chaining when the time budget runs out.
async function collectTrainer(qs, startTime, headers) {
  const batchId = String(qs.collect);
  try {
    const r = await B.collectBatch(batchId, trainerBatchAdapter(), { budgetMs: TIMEOUT_MS - (Date.now() - startTime), concurrency: CONCURRENCY });
    const j = r.job;
    if (r.status === 'partial') {
      await new Promise(function(resolve) {
        const req = https.request({ hostname: HOSTNAME, path: '/.netlify/functions/trainer-history-v2-background?collect=' + encodeURIComponent(batchId), method: 'POST', headers: { 'x-build-secret': process.env.BUILD_SECRET || '', 'Content-Length': 0 } }, function(res) { res.resume(); res.on('end', resolve); });
        req.on('error', function() { resolve(); }); req.setTimeout(10000, function() { req.destroy(); resolve(); }); req.end();
      });
    }
    console.log('[trainer-history-v2] COLLECT', batchId, r.status, JSON.stringify(j.counts), 'cost', j.totalCostUSD);
    return { statusCode: 200, headers, body: JSON.stringify({ status: r.status, batchId: batchId, processing_status: j.processing_status, request_counts: j.request_counts, counts: j.counts, batchCostUSD: j.costUSD, liveRetryCostUSD: j.liveRetryCostUSD, totalCostUSD: j.totalCostUSD, remaining: j.remaining }) };
  } catch (err) {
    console.log('[trainer-history-v2] COLLECT ERROR', err && err.stack || err);
    return { statusCode: 500, headers, body: JSON.stringify({ error: (err && err.message) || String(err) }) };
  }
}

exports.handler = async function(event) {
  const startTime = Date.now();
  const headers = { 'Content-Type': 'application/json' };
  const qs = (event && event.queryStringParameters) || {};
  const secret = (event.headers && event.headers['x-build-secret']) || qs.secret;
  if (secret !== process.env.BUILD_SECRET) return { statusCode: 401, headers, body: JSON.stringify({ error: 'Unauthorised' }) };
  if (qs.collect) return collectTrainer(qs, startTime, headers);
  const hop = Math.max(0, parseInt(qs.hop, 10) || 0);
  const dates = String(qs.dates || qs.date || '').split(',').map(function(s) { return s.trim(); }).filter(function(s) { return /^\d{4}-\d{2}-\d{2}$/.test(s); });
  if (!dates.length) dates.push(E.irishDateStr());
  return run(Array.from(new Set(dates)).sort(), qs, hop, startTime, headers);
};
