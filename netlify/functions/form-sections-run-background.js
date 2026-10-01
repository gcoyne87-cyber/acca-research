// form-sections-run-background.js
//
// Runner for the form-sections engine (netlify/functions/lib/form-sections.js).
// Going is the first section; Trip/Track/Recent Form are added to the same
// library and the same per-horse call later — this runner does not change
// when that happens, since it just sends whatever blocks the library builds.
//
// One DIRECT (non-Batch) Anthropic call per horse, not a Message Batch: the
// going-only trial (netlify/functions/going-trial.js, now removed) found the
// per-horse system prompt gets no automatic caching below Sonnet's ~1024
// cacheable-token floor, so there is no batch-cost discount to give up by
// calling directly, and a direct call lets this runner retry a single horse
// immediately instead of waiting on a batch round-trip.
//
// Secret-gated, unscheduled (no `module.exports.schedule`) — invoked via
// POST with x-build-secret and ?date=YYYY-MM-DD (default: Irish today).
// Self-chains on the same 780s-budget / persisted-worklist / lock-released-
// before-chaining pattern as racing-sweep-background.js, since a full card's
// worth of direct calls at 3-at-a-time will usually exceed one invocation.
//
// Writes: form-sections:{horse_id} = { going, goingWindow, generatedAt }
// (no TTL — same lifetime as form-summary:{id}:{date}), and
// form-sections:coverage:{date} once the whole day's worklist is empty.
// Does not touch form-summary:*, horse:trainer-history:*, horse:summary:*,
// the text-engine:* keys, or the old form-summary-background.js job/schedule.

module.exports.config = { timeout: 900 };

const https = require('https');
const F = require('./lib/form-sections.js');
const E = require('./text-engine-submit-background.js').helpers;

const HOSTNAME = 'superlative-flan-93dfc4.netlify.app';
const TIMEOUT_MS = 780 * 1000;
const LOCK_WINDOW_MS = 800 * 1000;
const HOP_CAP = 12;
const CONCURRENCY = 3;

// Standard (non-batch) Sonnet rates per million tokens — this runner makes
// direct /v1/messages calls, not Batch API requests, so the batch 50%
// discount used by text-engine-collect-background.js's costOf() doesn't apply.
const PRICE = { input: 3, output: 15, cacheWrite: 3.75, cacheRead: 0.3 };
function costOf(u) { return +((u.input * PRICE.input + u.output * PRICE.output + u.cacheWrite * PRICE.cacheWrite + u.cacheRead * PRICE.cacheRead) / 1e6).toFixed(4); }
function sleep(ms) { return new Promise(function(r) { setTimeout(r, ms); }); }
function addUsage(a, b) { return { input: a.input + b.input, output: a.output + b.output, cacheWrite: a.cacheWrite + b.cacheWrite, cacheRead: a.cacheRead + b.cacheRead }; }

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
        list.push({ horse_id: ru.horse_id, name: ru.name || 'Unknown', age: ru.age || '?', sex: ru.sex || 'unknown sex' });
      });
    });
  });
  return list;
}

// Trip trial — ?section=trip&races=<comma-separated "{meetingId}:{time}">.
// The stored card carries no native race id (confirmed when this trial's
// 4 races were chosen), so a race is identified the same way: meeting.id +
// ":" + the race's "t" (HH:MM) field, which is unique within one date.
async function eligibleHorsesForRaces(date, raceIds) {
  const card = await E.redisGet('racecards:' + date);
  if (!card || !Array.isArray(card.meetings)) return [];
  const wanted = {}; (raceIds || []).forEach(function(id) { wanted[id] = true; });
  const seen = {}; const list = [];
  card.meetings.forEach(function(m) {
    (m.races || []).forEach(function(race) {
      const raceId = m.id + ':' + race.t;
      if (!wanted[raceId]) return;
      (race.runners || []).forEach(function(ru) {
        if (!ru || !ru.horse_id || seen[ru.horse_id]) return;
        if (ru.nonRunner === true || ru.price === 'NR') return;
        seen[ru.horse_id] = true;
        list.push({ horse_id: ru.horse_id, name: ru.name || 'Unknown', age: ru.age || '?', sex: ru.sex || 'unknown sex' });
      });
    });
  });
  return list;
}

async function callModel(userText) {
  return E.anthropic('POST', '/v1/messages', {
    model: E.MODEL,
    max_tokens: F.MAX_TOKENS,
    system: [{ type: 'text', text: F.FORM_SECTIONS_PROMPT, cache_control: { type: 'ephemeral' } }],
    messages: [{ role: 'user', content: userText }]
  });
}

function usageFrom(json) {
  const u = (json && json.usage) || {};
  return { input: u.input_tokens || 0, output: u.output_tokens || 0, cacheWrite: u.cache_creation_input_tokens || 0, cacheRead: u.cache_read_input_tokens || 0 };
}

async function callModelTrip(userText) {
  return E.anthropic('POST', '/v1/messages', {
    model: E.MODEL,
    max_tokens: F.TRIP_MAX_TOKENS,
    system: [{ type: 'text', text: F.TRIP_PROMPT, cache_control: { type: 'ephemeral' } }],
    messages: [{ role: 'user', content: userText }]
  });
}

async function storeGoing(h, win, goingText) {
  // Carry the outgoing going text forward as goingPrev/goingPrevAt before
  // overwriting it, so round 2's rewritten texts don't erase the only copy
  // of what was there before (needed for this round's own before/after
  // report, and useful going forward for any future before/after diffing).
  const existing = await E.redisGet('form-sections:' + h.horse_id);
  const record = {
    going: goingText,
    goingWindow: { size: win.size, limit: win.limitApplied, oldest: win.oldestDate, newest: win.newestDate, excludedNoGoing: win.excludedNoGoing },
    generatedAt: new Date().toISOString()
  };
  if (existing && existing.going) {
    record.goingPrev = existing.going;
    record.goingPrevAt = existing.generatedAt || null;
  }
  await E.redisSet('form-sections:' + h.horse_id, record);
  return record;
}

// Merges trip into the SAME form-sections:{horse_id} record Going already
// owns — reads the existing record first so going/goingWindow/generatedAt/
// goingPrev/goingPrevAt are carried through untouched (and vice versa for a
// horse that gets Going later and already has a trip merged in).
async function storeTrip(h, win, tripText) {
  const existing = await E.redisGet('form-sections:' + h.horse_id);
  const record = Object.assign({}, existing || {}, {
    trip: tripText,
    tripWindow: { size: win.size, limit: win.limitApplied, oldest: win.oldestDate, newest: win.newestDate, excludedNoGoing: win.excludedNoGoing },
    tripGeneratedAt: new Date().toISOString()
  });
  await E.redisSet('form-sections:' + h.horse_id, record);
  return record;
}

async function processHorseTrip(h, date) {
  const rows = await E.redisGet('form:history:' + h.horse_id + ':' + date);
  const allRows = Array.isArray(rows) ? rows : [];
  const fullSorted = allRows.filter(function(r) { return r && r.date; }).slice().sort(function(a, b) { return String(b.date).localeCompare(String(a.date)); });
  const win = F.sectionWindow(allRows, date);

  if (!win.size) {
    await storeTrip(h, win, F.NO_RUNS_TRIP_TEMPLATE);
    return { horse_id: h.horse_id, horseName: h.name, stored: true, template: true, attempt: 0, usage: { input: 0, output: 0, cacheWrite: 0, cacheRead: 0 }, windowInfo: win };
  }

  const groups = F.tripGroups(win.rows, fullSorted);
  const envelope = F.buildTripEnvelope(h, win, groups);
  const tripData = { groups: groups, windowSize: win.size };
  let usage = { input: 0, output: 0, cacheWrite: 0, cacheRead: 0 };

  let resp = await callModelTrip(envelope);
  if (resp.status !== 200 || !resp.json || !Array.isArray(resp.json.content)) {
    return { horse_id: h.horse_id, horseName: h.name, stored: false, attempt: 1, error: 'HTTP ' + resp.status + ' ' + (resp.raw || '').slice(0, 200), usage: usage, windowInfo: win };
  }
  usage = addUsage(usage, usageFrom(resp.json));
  let text = (resp.json.content[0] && resp.json.content[0].text) || '';
  let v = F.validateTrip(text, tripData);
  if (v.ok) {
    await storeTrip(h, win, v.trip);
    return { horse_id: h.horse_id, horseName: h.name, stored: true, template: false, attempt: 1, usage: usage, wordCount: v.wordCount, wordWarning: v.warnings[0] || null, cacheRead: usage.cacheRead > 0, windowInfo: win };
  }

  const firstFailures = v.failures;
  const notes = firstFailures.map(function(x) { return '- ' + x.check + (x.detail ? ': "' + x.detail + '"' : ''); }).join('\n');
  const retryText = envelope + '\n\nPREVIOUS ATTEMPT FAILED VALIDATION — every claim is checked in code against the trip data above. Failures:\n' + notes + '\nRewrite so every position, distance and count appears in the trip data exactly, with no new claims, staying inside the word limit.';
  resp = await callModelTrip(retryText);
  if (resp.status !== 200 || !resp.json || !Array.isArray(resp.json.content)) {
    return { horse_id: h.horse_id, horseName: h.name, stored: false, attempt: 2, firstFailures: firstFailures, error: 'retry HTTP ' + resp.status + ' ' + (resp.raw || '').slice(0, 200), usage: usage, windowInfo: win };
  }
  usage = addUsage(usage, usageFrom(resp.json));
  text = (resp.json.content[0] && resp.json.content[0].text) || '';
  v = F.validateTrip(text, tripData);
  if (v.ok) {
    await storeTrip(h, win, v.trip);
    return { horse_id: h.horse_id, horseName: h.name, stored: true, template: false, attempt: 2, usage: usage, wordCount: v.wordCount, wordWarning: v.warnings[0] || null, cacheRead: usage.cacheRead > 0, firstFailures: firstFailures, windowInfo: win };
  }
  return { horse_id: h.horse_id, horseName: h.name, stored: false, attempt: 2, firstFailures: firstFailures, retryFailures: v.failures, usage: usage, windowInfo: win };
}

async function processHorse(h, date) {
  const rows = await E.redisGet('form:history:' + h.horse_id + ':' + date);
  const win = F.sectionWindow(Array.isArray(rows) ? rows : [], date);

  if (!win.size) {
    const rec = await storeGoing(h, win, F.NO_RUNS_TEMPLATE);
    return { horse_id: h.horse_id, horseName: h.name, stored: true, template: true, attempt: 0, usage: { input: 0, output: 0, cacheWrite: 0, cacheRead: 0 }, windowInfo: win, hadPrev: !!rec.goingPrev };
  }

  const groups = F.goingGroups(win.rows);
  const neverRun = F.goingNeverRun(groups);
  const neverRunAW = F.goingNeverRunAW(groups);
  const envelope = F.buildGoingEnvelope(h, win, groups, neverRun, neverRunAW);
  const block = { groups: groups, neverRun: neverRun, neverRunAW: neverRunAW };
  let usage = { input: 0, output: 0, cacheWrite: 0, cacheRead: 0 };

  let resp = await callModel(envelope);
  if (resp.status !== 200 || !resp.json || !Array.isArray(resp.json.content)) {
    return { horse_id: h.horse_id, horseName: h.name, stored: false, attempt: 1, error: 'HTTP ' + resp.status + ' ' + (resp.raw || '').slice(0, 200), usage: usage, windowInfo: win };
  }
  usage = addUsage(usage, usageFrom(resp.json));
  let text = (resp.json.content[0] && resp.json.content[0].text) || '';
  let v = F.validateGoing(text, block);
  if (v.ok) {
    const rec = await storeGoing(h, win, v.going);
    return { horse_id: h.horse_id, horseName: h.name, stored: true, template: false, attempt: 1, usage: usage, wordCount: v.wordCount, wordWarning: v.warnings[0] || null, cacheRead: usage.cacheRead > 0, windowInfo: win, hadPrev: !!rec.goingPrev };
  }

  // One retry, failure notes appended — same pattern as the main text
  // engine's retry (text-engine-collect-background.js): list every failed
  // check with its offending text, ask for a corrected rewrite.
  const firstFailures = v.failures;
  const notes = firstFailures.map(function(x) { return '- ' + x.check + (x.detail ? ': "' + x.detail + '"' : ''); }).join('\n');
  const retryText = envelope + '\n\nPREVIOUS ATTEMPT FAILED VALIDATION — every claim is checked in code against the going data above. Failures:\n' + notes + '\nRewrite so every position, going name and count appears in the going data exactly, with no new claims, staying inside the word limit.';
  resp = await callModel(retryText);
  if (resp.status !== 200 || !resp.json || !Array.isArray(resp.json.content)) {
    return { horse_id: h.horse_id, horseName: h.name, stored: false, attempt: 2, firstFailures: firstFailures, error: 'retry HTTP ' + resp.status + ' ' + (resp.raw || '').slice(0, 200), usage: usage, windowInfo: win };
  }
  usage = addUsage(usage, usageFrom(resp.json));
  text = (resp.json.content[0] && resp.json.content[0].text) || '';
  v = F.validateGoing(text, block);
  if (v.ok) {
    const rec = await storeGoing(h, win, v.going);
    return { horse_id: h.horse_id, horseName: h.name, stored: true, template: false, attempt: 2, usage: usage, wordCount: v.wordCount, wordWarning: v.warnings[0] || null, cacheRead: usage.cacheRead > 0, firstFailures: firstFailures, windowInfo: win, hadPrev: !!rec.goingPrev };
  }
  return { horse_id: h.horse_id, horseName: h.name, stored: false, attempt: 2, firstFailures: firstFailures, retryFailures: v.failures, usage: usage, windowInfo: win };
}

// Trip trial run — mirrors the Going path's self-chain/lock/coverage pattern
// exactly, against its own ":trip:" key namespace and ?races= worklist.
async function runTripSection(date, qs, hop, startTime, headers) {
  const raceIds = String(qs.races || '').split(',').map(function(s) { return s.trim(); }).filter(Boolean);
  console.log('[form-sections:trip] START', new Date().toISOString(), 'date:', date, 'hop:', hop, 'races:', raceIds.join(', '));

  try { await E.redisSet('form-sections:trip:heartbeat:' + date, { startedAt: new Date().toISOString(), hop: hop, races: raceIds }); } catch (e) {}

  try {
    const existingLock = await E.redisGet('form-sections:trip:lock:' + date);
    if (existingLock && existingLock.startedAt) {
      const lockAgeMs = Date.now() - new Date(existingLock.startedAt).getTime();
      if (lockAgeMs >= 0 && lockAgeMs < LOCK_WINDOW_MS) {
        console.log('[form-sections:trip] already in progress — standing down.');
        return { statusCode: 200, headers, body: JSON.stringify({ skipped: true, reason: 'form-sections trip already in progress', lockStartedAt: existingLock.startedAt }) };
      }
    }
    await E.redisSet('form-sections:trip:lock:' + date, { startedAt: new Date().toISOString() });
  } catch (lockErr) {}

  try {
    let state = hop > 0 ? await E.redisGet('form-sections:trip:worklist:' + date) : null;
    let remaining, results, templated, generated, failed, usage, cacheReadCount, firstPassFailCount, raceIdsUsed;

    if (state) {
      remaining = state.remaining; results = state.results; templated = state.templated;
      generated = state.generated; failed = state.failed; usage = state.usage;
      cacheReadCount = state.cacheReadCount; firstPassFailCount = state.firstPassFailCount;
      raceIdsUsed = state.raceIdsUsed || raceIds;
    } else {
      remaining = await eligibleHorsesForRaces(date, raceIds);
      results = []; templated = 0; generated = 0; failed = [];
      usage = { input: 0, output: 0, cacheWrite: 0, cacheRead: 0 };
      cacheReadCount = 0; firstPassFailCount = 0; raceIdsUsed = raceIds;
      console.log('[form-sections:trip]', remaining.length, 'eligible horses across', raceIds.length, 'race(s) for', date);
    }

    const totalEligible = (state && state.totalEligible) || remaining.length + results.length;
    let timedOut = false;

    while (remaining.length) {
      if (Date.now() - startTime > TIMEOUT_MS) { timedOut = true; break; }
      const chunk = remaining.slice(0, CONCURRENCY);
      const settled = await Promise.all(chunk.map(function(h) { return processHorseTrip(h, date).catch(function(e) { return { horse_id: h.horse_id, horseName: h.name, stored: false, error: e.message }; }); }));
      settled.forEach(function(r) {
        results.push({ horse_id: r.horse_id, horseName: r.horseName, stored: r.stored, template: !!r.template, attempt: r.attempt });
        usage = addUsage(usage, r.usage || { input: 0, output: 0, cacheWrite: 0, cacheRead: 0 });
        if (r.template) templated++;
        else if (r.stored) { generated++; if (r.cacheRead) cacheReadCount++; }
        else failed.push({ horse_id: r.horse_id, horseName: r.horseName, error: r.error || null, firstFailures: r.firstFailures || null, retryFailures: r.retryFailures || null });
        if (r.firstFailures && r.firstFailures.length) firstPassFailCount++;
      });
      remaining = remaining.slice(CONCURRENCY);
    }

    if (timedOut && remaining.length) {
      if (hop < HOP_CAP) {
        await E.redisSet('form-sections:trip:worklist:' + date, { remaining: remaining, results: results, templated: templated, generated: generated, failed: failed, usage: usage, cacheReadCount: cacheReadCount, firstPassFailCount: firstPassFailCount, raceIdsUsed: raceIdsUsed, totalEligible: totalEligible });
        try { await E.redisSet('form-sections:trip:lock:' + date, null); } catch (ue) {}
        console.log('[form-sections:trip] approaching timeout at hop', hop, '—', remaining.length, 'horse(s) still queued, chaining hop', hop + 1);
        await new Promise(function(resolve) {
          const req = https.request({
            hostname: HOSTNAME, path: '/.netlify/functions/form-sections-run-background?date=' + date + '&section=trip&races=' + encodeURIComponent(raceIdsUsed.join(',')) + '&hop=' + (hop + 1),
            method: 'POST', headers: { 'x-build-secret': process.env.BUILD_SECRET || '', 'Content-Length': 0 }
          }, function(res) { res.resume(); res.on('end', resolve); });
          req.on('error', function() { resolve(); });
          req.setTimeout(10000, function() { req.destroy(); resolve(); });
          req.end();
        });
        return { statusCode: 200, headers, body: JSON.stringify({ status: 'partial', date: date, hop: hop, remaining: remaining.length, generated: generated, templated: templated }) };
      }
      remaining.forEach(function(h) { failed.push({ horse_id: h.horse_id, horseName: h.name, error: 'not processed — form-sections trip exceeded its ' + HOP_CAP + '-hop cap for the day' }); });
      remaining = [];
      console.log('[form-sections:trip] hop cap reached with', failed.length, 'failure(s) recorded.');
    }

    const coverage = {
      date: date,
      raceIds: raceIdsUsed,
      completedAt: new Date().toISOString(),
      totalEligible: totalEligible,
      templated: templated,
      generated: generated,
      failedCount: failed.length,
      failed: failed,
      retriedCount: firstPassFailCount,
      cacheReadCalls: cacheReadCount,
      cacheActive: cacheReadCount > 0,
      usage: usage,
      costUSD: costOf(usage),
      hops: hop + 1,
      pricing: PRICE
    };
    await E.redisSet('form-sections:coverage:trip:' + date, coverage);
    await E.redisSet('form-sections:trip:worklist:' + date, null);
    try { await E.redisSet('form-sections:trip:lock:' + date, null); } catch (ue) {}
    console.log('[form-sections:trip] DONE', JSON.stringify({ date: date, templated: templated, generated: generated, failed: failed.length, cost: coverage.costUSD, cacheActive: coverage.cacheActive }));
    return { statusCode: 200, headers, body: JSON.stringify({ status: 'done', coverage: coverage }) };
  } catch (err) {
    try { await E.redisSet('form-sections:trip:lock:' + date, null); } catch (ue) {}
    console.log('[form-sections:trip] ERROR', err && err.stack || err);
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

  // Trip trial — entirely separate lock/worklist/heartbeat/coverage keys
  // (namespaced ":trip:") so it can never collide with a concurrent Going
  // run on the same date. Going's own path below is unchanged.
  if (qs.section === 'trip') {
    return runTripSection(date, qs, hop, startTime, headers);
  }

  console.log('[form-sections] START', new Date().toISOString(), 'date:', date, 'hop:', hop);

  try { await E.redisSet('form-sections:heartbeat:' + date, { startedAt: new Date().toISOString(), hop: hop }); } catch (e) {}

  try {
    const existingLock = await E.redisGet('form-sections:lock:' + date);
    if (existingLock && existingLock.startedAt) {
      const lockAgeMs = Date.now() - new Date(existingLock.startedAt).getTime();
      if (lockAgeMs >= 0 && lockAgeMs < LOCK_WINDOW_MS) {
        console.log('[form-sections] already in progress — standing down.');
        return { statusCode: 200, headers, body: JSON.stringify({ skipped: true, reason: 'form-sections already in progress', lockStartedAt: existingLock.startedAt }) };
      }
    }
    await E.redisSet('form-sections:lock:' + date, { startedAt: new Date().toISOString() });
  } catch (lockErr) {}

  try {
    let state = hop > 0 ? await E.redisGet('form-sections:worklist:' + date) : null;
    let remaining, results, templated, generated, failed, usage, cacheReadCount, firstPassFailCount, hadPrevCount;

    if (state) {
      remaining = state.remaining; results = state.results; templated = state.templated;
      generated = state.generated; failed = state.failed; usage = state.usage;
      cacheReadCount = state.cacheReadCount; firstPassFailCount = state.firstPassFailCount;
      hadPrevCount = state.hadPrevCount || 0;
    } else {
      remaining = await eligibleHorses(date);
      results = []; templated = 0; generated = 0; failed = [];
      usage = { input: 0, output: 0, cacheWrite: 0, cacheRead: 0 };
      cacheReadCount = 0; firstPassFailCount = 0; hadPrevCount = 0;
      console.log('[form-sections]', remaining.length, 'eligible horses for', date);
    }

    const totalEligible = (state && state.totalEligible) || remaining.length + results.length;
    let timedOut = false;

    while (remaining.length) {
      if (Date.now() - startTime > TIMEOUT_MS) { timedOut = true; break; }
      const chunk = remaining.slice(0, CONCURRENCY);
      const settled = await Promise.all(chunk.map(function(h) { return processHorse(h, date).catch(function(e) { return { horse_id: h.horse_id, horseName: h.name, stored: false, error: e.message }; }); }));
      settled.forEach(function(r) {
        results.push({ horse_id: r.horse_id, horseName: r.horseName, stored: r.stored, template: !!r.template, attempt: r.attempt });
        usage = addUsage(usage, r.usage || { input: 0, output: 0, cacheWrite: 0, cacheRead: 0 });
        if (r.template) templated++;
        else if (r.stored) { generated++; if (r.cacheRead) cacheReadCount++; }
        else failed.push({ horse_id: r.horse_id, horseName: r.horseName, error: r.error || null, firstFailures: r.firstFailures || null, retryFailures: r.retryFailures || null });
        if (r.firstFailures && r.firstFailures.length) firstPassFailCount++;
        if (r.hadPrev) hadPrevCount++;
      });
      remaining = remaining.slice(CONCURRENCY);
    }

    if (timedOut && remaining.length) {
      if (hop < HOP_CAP) {
        await E.redisSet('form-sections:worklist:' + date, { remaining: remaining, results: results, templated: templated, generated: generated, failed: failed, usage: usage, cacheReadCount: cacheReadCount, firstPassFailCount: firstPassFailCount, hadPrevCount: hadPrevCount, totalEligible: totalEligible });
        // Lock released BEFORE the self-chain POST — same reasoning as
        // racing-sweep-background.js's chainNextHop: the next hop arrives
        // inside this lock's own window and would stand down against it.
        try { await E.redisSet('form-sections:lock:' + date, null); } catch (ue) {}
        console.log('[form-sections] approaching timeout at hop', hop, '—', remaining.length, 'horse(s) still queued, chaining hop', hop + 1);
        await new Promise(function(resolve) {
          const req = https.request({
            hostname: HOSTNAME, path: '/.netlify/functions/form-sections-run-background?date=' + date + '&hop=' + (hop + 1),
            method: 'POST', headers: { 'x-build-secret': process.env.BUILD_SECRET || '', 'Content-Length': 0 }
          }, function(res) { res.resume(); res.on('end', resolve); });
          req.on('error', function() { resolve(); });
          req.setTimeout(10000, function() { req.destroy(); resolve(); });
          req.end();
        });
        return { statusCode: 200, headers, body: JSON.stringify({ status: 'partial', date: date, hop: hop, remaining: remaining.length, generated: generated, templated: templated }) };
      }
      remaining.forEach(function(h) { failed.push({ horse_id: h.horse_id, horseName: h.name, error: 'not processed — form-sections exceeded its ' + HOP_CAP + '-hop cap for the day' }); });
      remaining = [];
      console.log('[form-sections] hop cap reached with', failed.length, 'failure(s) recorded.');
    }

    // Done — write coverage and clear the worklist/lock.
    const coverage = {
      date: date,
      completedAt: new Date().toISOString(),
      totalEligible: totalEligible,
      templated: templated,
      generated: generated,
      failedCount: failed.length,
      failed: failed,
      retriedCount: firstPassFailCount,
      hadPrevCount: hadPrevCount,
      cacheReadCalls: cacheReadCount,
      cacheActive: cacheReadCount > 0,
      usage: usage,
      costUSD: costOf(usage),
      hops: hop + 1,
      pricing: PRICE
    };
    await E.redisSet('form-sections:coverage:' + date, coverage);
    await E.redisSet('form-sections:worklist:' + date, null);
    try { await E.redisSet('form-sections:lock:' + date, null); } catch (ue) {}
    console.log('[form-sections] DONE', JSON.stringify({ date: date, templated: templated, generated: generated, failed: failed.length, cost: coverage.costUSD, cacheActive: coverage.cacheActive }));
    return { statusCode: 200, headers, body: JSON.stringify({ status: 'done', coverage: coverage }) };
  } catch (err) {
    try { await E.redisSet('form-sections:lock:' + date, null); } catch (ue) {}
    console.log('[form-sections] ERROR', err && err.stack || err);
    return { statusCode: 500, headers, body: JSON.stringify({ error: (err && err.message) || String(err) }) };
  }
};
