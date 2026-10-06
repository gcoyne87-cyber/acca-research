// form-sections-run-background.js
//
// Runner for the goingtrip form-sections engine (lib/form-sections.js): one
// DIRECT Anthropic call per horse writes GOING, TRIP and TRACK together from
// a code-built fact list, the validator checks voice rules plus number
// membership, one retry on failure, then the horse is marked failed.
//
// Redesign (post-2026-10-06 probes): the second model check, the regen loop
// and the self-overrule filter are gone — code computes every fact, the
// model only phrases them, so there is nothing left for a second model to
// adjudicate. The legacy going-only and trip-trial paths (which depended on
// the deleted prompts and validators) are gone with them: this runner now
// serves ?section=goingtrip only (the default when section is omitted).
//
// Concurrency 8 across horses — a shared queue drained by 8 workers, the
// same shape as the 10:30 build's race fan-out. Usage is accumulated in one
// shared object, updated synchronously after each response; single-threaded
// JS makes that atomic, and every worker re-checks the cost cap and the time
// budget before claiming its next horse, so the cap overshoots by at most
// the 8 calls already in flight. The first horse runs alone as a warm-up so
// the system prompt is written to the cache once before 8 concurrent reads.
//
// Secret-gated, unscheduled — invoked via POST with x-build-secret and
// ?date=YYYY-MM-DD (default: Irish today). Self-chains on the 780s-budget /
// persisted-worklist / lock-released-before-chaining pattern.
//
// Writes: form-sections:{horse_id} = { going, goingWindow, generatedAt,
// trip, tripWindow, tripGeneratedAt, track, trackGeneratedAt } (no TTL),
// form-sections:coverage:goingtrip:{date} once the worklist is empty, and
// form-sections:telemetry:{date} (append-only failure detail, never cleared
// by lock/worklist logic).

module.exports.config = { timeout: 900 };

const https = require('https');
const F = require('./lib/form-sections.js');
const E = require('./text-engine-submit-background.js').helpers;

const HOSTNAME = 'superlative-flan-93dfc4.netlify.app';
const TIMEOUT_MS = 780 * 1000;
const LOCK_WINDOW_MS = 800 * 1000;
const HOP_CAP = 12;
const CONCURRENCY = 8;

// Standard (non-batch) Sonnet rates per million tokens.
const PRICE = { input: 3, output: 15, cacheWrite: 3.75, cacheRead: 0.3 };
const GOINGTRIP_COST_CAP_USD = 9.00;
const EMPTY_USAGE = { input: 0, output: 0, cacheWrite: 0, cacheRead: 0 };
function costOf(u) { return +((u.input * PRICE.input + u.output * PRICE.output + u.cacheWrite * PRICE.cacheWrite + u.cacheRead * PRICE.cacheRead) / 1e6).toFixed(4); }
function addUsage(a, b) { return { input: a.input + b.input, output: a.output + b.output, cacheWrite: a.cacheWrite + b.cacheWrite, cacheRead: a.cacheRead + b.cacheRead }; }
function usageFrom(json) {
  const u = (json && json.usage) || {};
  return { input: u.input_tokens || 0, output: u.output_tokens || 0, cacheWrite: u.cache_creation_input_tokens || 0, cacheRead: u.cache_read_input_tokens || 0 };
}

async function eligibleHorses(date) {
  const card = await E.redisGet('racecards:' + date);
  if (!card || !Array.isArray(card.meetings)) return [];
  const seen = {}; const list = [];
  card.meetings.forEach(function(m) {
    (m.races || []).forEach(function(race) {
      (race.runners || []).forEach(function(ru) {
        if (!ru || !ru.horse_id || seen[ru.horse_id]) return;
        if (ru.nonRunner === true || ru.price === 'NR') return;
        seen[ru.horse_id] = true;
        list.push({ horse_id: ru.horse_id, name: ru.name || 'Unknown', age: ru.age || '?', sex: ru.sex || 'unknown sex', meeting: m.name || m.id });
      });
    });
  });
  return list;
}

// ?sample=N — a random subset spread across every meeting present, not the
// first N in card order.
function sampleAcrossMeetings(list, n) {
  if (!n || n >= list.length) return list;
  const byMeeting = {};
  list.forEach(function(h) { (byMeeting[h.meeting] = byMeeting[h.meeting] || []).push(h); });
  const meetings = Object.keys(byMeeting);
  meetings.forEach(function(m) {
    const arr = byMeeting[m];
    for (let i = arr.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); const t = arr[i]; arr[i] = arr[j]; arr[j] = t; }
  });
  const out = []; let idx = 0;
  while (out.length < n && meetings.some(function(m) { return byMeeting[m].length > idx; })) {
    meetings.forEach(function(m) { if (out.length < n && byMeeting[m].length > idx) out.push(byMeeting[m][idx]); });
    idx++;
  }
  return out;
}

// The single writer call. The system prompt is byte-identical on every call
// and marked ephemeral, so after the warm-up horse every call reads it from
// the cache.
async function callModelGoingTrip(userText) {
  return E.anthropic('POST', '/v1/messages', {
    model: E.MODEL,
    max_tokens: F.GOINGTRIP_MAX_TOKENS,
    system: [{ type: 'text', text: F.GOINGTRIP_PROMPT, cache_control: { type: 'ephemeral' } }],
    messages: [{ role: 'user', content: userText }]
  });
}

// Merged store — each text may independently be null (that section failed
// and nothing is written for it; the rest of the record is left untouched).
// Track carries no trackWindow: its window (last 15 runs / 24 months,
// wall-clock) is independent of win (Going/Trip's race-day 18-month window).
async function storeGoingTrip(h, win, goingText, tripText, trackText) {
  const existing = await E.redisGet('form-sections:' + h.horse_id);
  const record = Object.assign({}, existing || {});
  const nowIso = new Date().toISOString();
  const windowInfo = { size: win.size, limit: win.limitApplied, oldest: win.oldestDate, newest: win.newestDate, excludedNoGoing: win.excludedNoGoing };
  if (goingText !== null && goingText !== undefined) { record.going = goingText; record.goingWindow = windowInfo; record.generatedAt = nowIso; }
  if (tripText !== null && tripText !== undefined) { record.trip = tripText; record.tripWindow = windowInfo; record.tripGeneratedAt = nowIso; }
  if (trackText !== null && trackText !== undefined) { record.track = trackText; record.trackGeneratedAt = nowIso; }
  await E.redisSet('form-sections:' + h.horse_id, record);
  return record;
}

// Telemetry — every validator failure is appended here, independent of the
// worklist and never touched by the lock/worklist-clearing stop logic.
// GET-then-SET append (no native list push in the E helpers): with 8 workers
// two horses can finish in the same instant and one entry can be lost.
// Acceptable for diagnostic data; nothing correctness-critical reads it.
async function appendTelemetry(date, entries) {
  if (!entries || !entries.length) return;
  try {
    const key = 'form-sections:telemetry:' + date;
    const existing = await E.redisGet(key);
    const arr = Array.isArray(existing) ? existing : [];
    await E.redisSet(key, arr.concat(entries));
  } catch (e) {}
}
function telemetryFromFailures(h, date, section, failures, stage, factsText) {
  return (failures || []).map(function(f) {
    return { date: date, ts: new Date().toISOString(), horseName: h.name, horse_id: h.horse_id, section: section, check: f.check, detail: f.detail, stage: stage, facts: factsText || null };
  });
}

// processHorseGoingTrip — build facts, write once, validate each section,
// retry once with the failure notes, store whatever passed.
async function processHorseGoingTrip(h, date) {
  const rows = await E.redisGet('form:history:' + h.horse_id + ':' + date);
  const allRows = Array.isArray(rows) ? rows : [];
  const win = F.sectionWindow(allRows, date);
  const trackRows = F.trackWindowRows(allRows);
  const trackIsTemplate = trackRows.length === 0;

  if (!win.size) {
    // Track is templated too even if its (wider) window has runs — the three
    // sections are generated together or not at all.
    await storeGoingTrip(h, win, F.NO_RUNS_TEMPLATE, F.NO_RUNS_TRIP_TEMPLATE, F.NO_RUNS_TRACK_TEMPLATE);
    return { horse_id: h.horse_id, horseName: h.name, storedGoing: true, storedTrip: true, storedTrack: true, template: true, attempt: 0, usage: EMPTY_USAGE };
  }

  const gGroups = F.goingGroups(win.rows);
  const goingFacts = F.buildGoingFacts(gGroups, F.goingNeverRun(gGroups), F.goingNeverRunAW(gGroups), win.size);
  const tGroups = F.tripGroups(win.rows);
  const tripFacts = F.buildTripFacts(tGroups, win.size);
  let trackFacts = null;
  if (!trackIsTemplate) {
    const kGroups = F.trackGroups(trackRows, F.COURSE_FACTS);
    trackFacts = F.buildTrackFacts(kGroups, F.trackRollups(kGroups), trackRows.length);
  }
  const envelope = F.buildFactsEnvelope(h, goingFacts, tripFacts, trackFacts);
  const courseNames = F.courseNamesForExemption(win.rows.concat(trackRows));

  let usage = EMPTY_USAGE; let firstWriteUsage = null; let cacheRead = false;
  // Raw-output capture on stop_reason=max_tokens — appended to telemetry so
  // a truncation can be read instead of guessed at. Permanent and cheap.
  const rawCaptures = [];

  async function write(userText) {
    const resp = await callModelGoingTrip(userText);
    if (resp.status !== 200 || !resp.json || !Array.isArray(resp.json.content)) return { error: 'HTTP ' + resp.status + ' ' + (resp.raw || '').slice(0, 200) };
    const u = usageFrom(resp.json);
    usage = addUsage(usage, u);
    if (!firstWriteUsage) { firstWriteUsage = u; cacheRead = u.cacheRead > 0; }
    const text = resp.json.content.map(function(c) { return c.text || ''; }).join('');
    if (resp.json.stop_reason === 'max_tokens') {
      rawCaptures.push({ date: date, ts: new Date().toISOString(), horseName: h.name, horse_id: h.horse_id, section: 'all', check: 'max-tokens-raw', stage: rawCaptures.length ? 'retry' : 'first', outputTokens: u.output, chars: text.length, words: F.words(text), rawHead: text.slice(0, 1500), rawTail: text.slice(-600), detail: 'stop_reason=max_tokens; raw output captured (head 1500 / tail 600 chars)' });
    }
    return { text: text, stopReason: resp.json.stop_reason };
  }
  function validateAll(text) {
    const parsed = F.parseJsonSections(text);
    if (!parsed) return { parsed: null, going: null, trip: null, track: null, jsonFail: true };
    return {
      parsed: parsed,
      going: F.validateSection('going', parsed.going, goingFacts, { courseNames: courseNames, horseName: h.name, wordCap: 65 }),
      trip: F.validateSection('trip', parsed.trip, tripFacts, { courseNames: courseNames, horseName: h.name, wordCap: 65 }),
      track: trackIsTemplate ? null : F.validateSection('track', parsed.track, trackFacts, { courseNames: courseNames, horseName: h.name, wordCap: 85 }),
      jsonFail: false
    };
  }
  function failuresOf(v) {
    const out = {};
    if (v.jsonFail) { out.going = [{ check: 'json', detail: 'output was not valid JSON' }]; out.trip = out.going; if (!trackIsTemplate) out.track = out.going; return out; }
    ['going', 'trip', 'track'].forEach(function(s) { if (v[s] && !v[s].ok) out[s] = v[s].failures; });
    return out;
  }
  function anyFail(f) { return !!(f.going || f.trip || f.track); }

  // First write.
  const first = await write(envelope);
  if (first.error) return { horse_id: h.horse_id, horseName: h.name, storedGoing: false, storedTrip: false, storedTrack: false, error: first.error, attempt: 1, usage: usage, firstWriteUsage: firstWriteUsage, cacheRead: cacheRead };
  let v = validateAll(first.text);
  let firstFailures = failuresOf(v);
  let attempt = 1;
  let telemetry = [];
  const factsText = { going: goingFacts.join('\n'), trip: tripFacts.join('\n'), track: trackFacts ? trackFacts.join('\n') : null };

  // One retry — the whole envelope again, plus the failed sections' notes.
  // Sections that passed are kept from the first pass regardless of what the
  // retry produces for them.
  let keep = { going: v.going && v.going.ok ? v.going.text : null, trip: v.trip && v.trip.ok ? v.trip.text : null, track: v.track && v.track.ok ? v.track.text : null };
  let retryFailures = null;
  if (anyFail(firstFailures)) {
    ['going', 'trip', 'track'].forEach(function(s) { if (firstFailures[s]) telemetry = telemetry.concat(telemetryFromFailures(h, date, s, firstFailures[s], 'first', factsText[s])); });
    const notes = ['going', 'trip', 'track'].filter(function(s) { return firstFailures[s]; }).map(function(s) {
      return s.toUpperCase() + ': ' + firstFailures[s].map(function(f) { return f.check + ' — ' + f.detail; }).join('; ');
    }).join('\n');
    const retryText = envelope + '\n\nYOUR PREVIOUS ATTEMPT FAILED THESE CHECKS — rewrite the named sections using only the facts listed:\n' + notes;
    const second = await write(retryText);
    attempt = 2;
    if (!second.error) {
      const v2 = validateAll(second.text);
      retryFailures = failuresOf(v2);
      ['going', 'trip', 'track'].forEach(function(s) {
        if (keep[s] === null && v2[s] && v2[s].ok) keep[s] = v2[s].text;
        if (keep[s] === null && retryFailures[s]) telemetry = telemetry.concat(telemetryFromFailures(h, date, s, retryFailures[s], 'retry', factsText[s]));
      });
    } else {
      retryFailures = { error: second.error };
    }
  }

  const goingOut = keep.going, tripOut = keep.trip;
  const trackOut = trackIsTemplate ? F.NO_RUNS_TRACK_TEMPLATE : keep.track;
  if (goingOut !== null || tripOut !== null || trackOut !== null) await storeGoingTrip(h, win, goingOut, tripOut, trackOut);
  await appendTelemetry(date, telemetry.concat(rawCaptures));

  return {
    horse_id: h.horse_id, horseName: h.name,
    storedGoing: goingOut !== null, storedTrip: tripOut !== null, storedTrack: trackOut !== null,
    template: false, attempt: attempt, usage: usage, firstWriteUsage: firstWriteUsage, cacheRead: cacheRead,
    wordCount: { going: v.going ? v.going.wordCount : null, trip: v.trip ? v.trip.wordCount : null, track: v.track ? v.track.wordCount : null },
    codeCheckFirstFailures: anyFail(firstFailures) ? firstFailures : null,
    codeCheckRetryFailures: retryFailures && (retryFailures.error || anyFail(retryFailures)) ? retryFailures : null,
    stopReason: first.stopReason
  };
}

async function runGoingTripSection(date, qs, hop, startTime, headers) {
  console.log('[form-sections:goingtrip] START', new Date().toISOString(), 'date:', date, 'hop:', hop);

  try { await E.redisSet('form-sections:goingtrip:heartbeat:' + date, { startedAt: new Date().toISOString(), hop: hop }); } catch (e) {}

  try {
    const existingLock = await E.redisGet('form-sections:goingtrip:lock:' + date);
    if (existingLock && existingLock.startedAt) {
      const lockAgeMs = Date.now() - new Date(existingLock.startedAt).getTime();
      if (lockAgeMs >= 0 && lockAgeMs < LOCK_WINDOW_MS) {
        console.log('[form-sections:goingtrip] already in progress — standing down.');
        return { statusCode: 200, headers, body: JSON.stringify({ skipped: true, reason: 'form-sections goingtrip already in progress', lockStartedAt: existingLock.startedAt }) };
      }
    }
    await E.redisSet('form-sections:goingtrip:lock:' + date, { startedAt: new Date().toISOString() });
  } catch (lockErr) {}

  try {
    let state = hop > 0 ? await E.redisGet('form-sections:goingtrip:worklist:' + date) : null;
    let remaining, results, templated, bothGenerated, partialGenerated, failed, cacheReadCount, firstPassFailCount, passedFirstTimeCount;
    // Shared accounting object — every worker adds to acct.usage synchronously
    // after its response lands, so costOf(acct.usage) is always exact for the
    // calls that have completed.
    const acct = { usage: EMPTY_USAGE };

    if (state) {
      remaining = state.remaining; results = state.results; templated = state.templated;
      bothGenerated = state.bothGenerated; partialGenerated = state.partialGenerated; failed = state.failed; acct.usage = state.usage || EMPTY_USAGE;
      cacheReadCount = state.cacheReadCount; firstPassFailCount = state.firstPassFailCount; passedFirstTimeCount = state.passedFirstTimeCount || 0;
    } else {
      remaining = await eligibleHorses(date);
      // ?horseIds=a,b,c restricts a fresh start to exactly those horses;
      // ?sample=N takes N spread across meetings. A chained hop's `remaining`
      // already reflects either.
      if (qs.horseIds) {
        const wanted = {};
        String(qs.horseIds).split(',').map(function(s) { return s.trim(); }).filter(Boolean).forEach(function(id) { wanted[id] = true; });
        remaining = remaining.filter(function(h) { return wanted[h.horse_id]; });
      }
      if (qs.sample) remaining = sampleAcrossMeetings(remaining, parseInt(qs.sample, 10) || remaining.length);
      results = []; templated = 0; bothGenerated = 0; partialGenerated = 0; failed = [];
      cacheReadCount = 0; firstPassFailCount = 0; passedFirstTimeCount = 0;
      console.log('[form-sections:goingtrip]', remaining.length, 'eligible horses for', date, qs.sample ? '(sampled to ' + qs.sample + ')' : '');
    }

    const costCap = qs.costCap ? (parseFloat(qs.costCap) || GOINGTRIP_COST_CAP_USD) : GOINGTRIP_COST_CAP_USD;
    const totalEligible = (state && state.totalEligible) || remaining.length + results.length;
    let timedOut = false, costCapped = false;

    function record(r) {
      results.push({
        horse_id: r.horse_id, horseName: r.horseName, storedGoing: !!r.storedGoing, storedTrip: !!r.storedTrip, storedTrack: !!r.storedTrack, template: !!r.template, attempt: r.attempt,
        wordCount: r.wordCount || null, firstWriteUsage: r.firstWriteUsage || EMPTY_USAGE, stopReason: r.stopReason || null,
        codeCheckFirstFailures: r.codeCheckFirstFailures || null, codeCheckRetryFailures: r.codeCheckRetryFailures || null, error: r.error || null
      });
      acct.usage = addUsage(acct.usage, r.usage || EMPTY_USAGE);
      if (r.template) templated++;
      else if (r.storedGoing && r.storedTrip && r.storedTrack) {
        bothGenerated++;
        if (r.cacheRead) cacheReadCount++;
        if (!r.codeCheckFirstFailures) passedFirstTimeCount++;
      } else if (r.storedGoing || r.storedTrip || r.storedTrack) {
        partialGenerated++;
        if (r.cacheRead) cacheReadCount++;
      } else {
        failed.push({ horse_id: r.horse_id, horseName: r.horseName, error: r.error || null, codeCheckFirstFailures: r.codeCheckFirstFailures || null, codeCheckRetryFailures: r.codeCheckRetryFailures || null });
      }
      if (r.codeCheckFirstFailures) firstPassFailCount++;
    }
    async function processSafe(h) {
      try { return await processHorseGoingTrip(h, date); }
      catch (e) { return { horse_id: h.horse_id, horseName: h.name, storedGoing: false, storedTrip: false, storedTrack: false, error: e.message, usage: EMPTY_USAGE }; }
    }
    // A worker may claim another horse only while there is time and money.
    function mayContinue() {
      if (Date.now() - startTime > TIMEOUT_MS) { timedOut = true; return false; }
      if (costOf(acct.usage) >= costCap) { costCapped = true; return false; }
      return true;
    }

    // Warm-up: the first horse alone, so the system prompt is written to the
    // cache once before the pool starts reading it.
    if (remaining.length && hop === 0 && !state && mayContinue()) {
      const h = remaining.shift();
      record(await processSafe(h));
    }

    // Worker pool over the shared queue.
    async function worker() {
      while (remaining.length && mayContinue()) {
        const h = remaining.shift();
        record(await processSafe(h));
      }
    }
    const workers = [];
    for (let i = 0; i < CONCURRENCY && remaining.length; i++) workers.push(worker());
    await Promise.all(workers);

    const costNow = costOf(acct.usage);
    if (costCapped) {
      remaining.forEach(function(h) { failed.push({ horse_id: h.horse_id, horseName: h.name, error: 'not processed — goingtrip hard cost cap ($' + costCap.toFixed(2) + ') reached at $' + costNow.toFixed(4) }); });
      const coverage = {
        date: date, completedAt: new Date().toISOString(), totalEligible: totalEligible,
        templated: templated, bothGenerated: bothGenerated, partialGenerated: partialGenerated,
        passedFirstTime: passedFirstTimeCount, failedCount: failed.length, failed: failed, results: results,
        retriedCount: firstPassFailCount, cacheReadCalls: cacheReadCount, cacheActive: cacheReadCount > 0,
        usage: acct.usage, costUSD: costNow, totalCostUSD: costNow, hops: hop + 1, pricing: PRICE, concurrency: CONCURRENCY,
        costCapped: true, costCapUSD: costCap, remainingAtStop: remaining.length
      };
      await E.redisSet('form-sections:coverage:goingtrip:' + date, coverage);
      await E.redisSet('form-sections:goingtrip:worklist:' + date, null);
      try { await E.redisSet('form-sections:goingtrip:lock:' + date, null); } catch (ue) {}
      console.log('[form-sections:goingtrip] COST CAP REACHED', JSON.stringify({ date: date, costAtStop: costNow, remaining: remaining.length }));
      return { statusCode: 200, headers, body: JSON.stringify({ status: 'cost_capped', coverage: coverage }) };
    }

    if (timedOut && remaining.length) {
      if (hop < HOP_CAP) {
        await E.redisSet('form-sections:goingtrip:worklist:' + date, { remaining: remaining, results: results, templated: templated, bothGenerated: bothGenerated, partialGenerated: partialGenerated, failed: failed, usage: acct.usage, cacheReadCount: cacheReadCount, firstPassFailCount: firstPassFailCount, passedFirstTimeCount: passedFirstTimeCount, totalEligible: totalEligible });
        try { await E.redisSet('form-sections:goingtrip:lock:' + date, null); } catch (ue) {}
        console.log('[form-sections:goingtrip] approaching timeout at hop', hop, '—', remaining.length, 'horse(s) still queued, chaining hop', hop + 1);
        await new Promise(function(resolve) {
          const req = https.request({
            hostname: HOSTNAME, path: '/.netlify/functions/form-sections-run-background?date=' + date + '&section=goingtrip&hop=' + (hop + 1) + (qs.costCap ? '&costCap=' + encodeURIComponent(qs.costCap) : '') + (qs.horseIds ? '&horseIds=' + encodeURIComponent(qs.horseIds) : '') + (qs.sample ? '&sample=' + encodeURIComponent(qs.sample) : ''),
            method: 'POST', headers: { 'x-build-secret': process.env.BUILD_SECRET || '', 'Content-Length': 0 }
          }, function(res) { res.resume(); res.on('end', resolve); });
          req.on('error', function() { resolve(); });
          req.setTimeout(10000, function() { req.destroy(); resolve(); });
          req.end();
        });
        return { statusCode: 200, headers, body: JSON.stringify({ status: 'partial', date: date, hop: hop, remaining: remaining.length, bothGenerated: bothGenerated, partialGenerated: partialGenerated, templated: templated }) };
      }
      remaining.forEach(function(h) { failed.push({ horse_id: h.horse_id, horseName: h.name, error: 'not processed — form-sections goingtrip exceeded its ' + HOP_CAP + '-hop cap for the day' }); });
      remaining = [];
      console.log('[form-sections:goingtrip] hop cap reached with', failed.length, 'failure(s) recorded.');
    }

    const coverage = {
      date: date, completedAt: new Date().toISOString(), totalEligible: totalEligible,
      templated: templated, bothGenerated: bothGenerated, partialGenerated: partialGenerated,
      passedFirstTime: passedFirstTimeCount, failedCount: failed.length, failed: failed, results: results,
      retriedCount: firstPassFailCount, cacheReadCalls: cacheReadCount, cacheActive: cacheReadCount > 0,
      usage: acct.usage, costUSD: costNow, totalCostUSD: costNow, hops: hop + 1, pricing: PRICE, concurrency: CONCURRENCY
    };
    await E.redisSet('form-sections:coverage:goingtrip:' + date, coverage);
    await E.redisSet('form-sections:goingtrip:worklist:' + date, null);
    try { await E.redisSet('form-sections:goingtrip:lock:' + date, null); } catch (ue) {}
    console.log('[form-sections:goingtrip] DONE', JSON.stringify({ date: date, templated: templated, bothGenerated: bothGenerated, partialGenerated: partialGenerated, failed: failed.length, cost: coverage.costUSD, cacheActive: coverage.cacheActive }));
    return { statusCode: 200, headers, body: JSON.stringify({ status: 'done', coverage: coverage }) };
  } catch (err) {
    try { await E.redisSet('form-sections:goingtrip:lock:' + date, null); } catch (ue) {}
    console.log('[form-sections:goingtrip] ERROR', err && err.stack || err);
    return { statusCode: 500, headers, body: JSON.stringify({ error: (err && err.message) || String(err) }) };
  }
}

exports.handler = async function(event) {
  const startTime = Date.now();
  const headers = { 'Content-Type': 'application/json' };
  const qs = (event && event.queryStringParameters) || {};
  const hop = Math.max(0, parseInt(qs.hop, 10) || 0);

  const secret = (event.headers && event.headers['x-build-secret']) || qs.secret;
  if (secret !== process.env.BUILD_SECRET) {
    return { statusCode: 401, headers, body: JSON.stringify({ error: 'Unauthorised' }) };
  }

  const date = /^\d{4}-\d{2}-\d{2}$/.test(qs.date || '') ? qs.date : E.irishDateStr();

  if (!qs.section || qs.section === 'goingtrip') {
    return runGoingTripSection(date, qs, hop, startTime, headers);
  }
  return { statusCode: 400, headers, body: JSON.stringify({ error: 'unknown section "' + qs.section + '" — this runner serves section=goingtrip only' }) };
};
