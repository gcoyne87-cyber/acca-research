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

// Change C — Going + Trip combined, one call per horse. System prompt is
// SHARED_RULES + GOING_SECTION + TRIP_SECTION as one static block, same
// cache_control ephemeral pattern as every other call here.
async function callModelGoingTrip(userText) {
  return E.anthropic('POST', '/v1/messages', {
    model: E.MODEL,
    max_tokens: F.GOINGTRIP_MAX_TOKENS,
    system: [{ type: 'text', text: F.GOINGTRIP_PROMPT, cache_control: { type: 'ephemeral' } }],
    messages: [{ role: 'user', content: userText }]
  });
}

// Trip round 3, Change 6 — second, independent check run after a text
// already passes validateTrip, before it is stored. Same model as the
// writer (claude-sonnet-4-6), its own static cached system prompt, direct
// call like every other call in this runner, same max_tokens (300), same
// output shape ({supported, problems}).
//
// Observed live: without forcing, the model reasoned sentence-by-sentence
// in prose and hit max_tokens before ever emitting the JSON, on nearly
// every call. An assistant-turn prefill ("{") would normally force
// immediate JSON, but this model rejects assistant prefill ("the
// conversation must end with a user message") — so a forced tool call is
// used instead: same system prompt, same model, same max_tokens, same
// {supported, problems} shape, just delivered as a tool_use input (which
// the model must emit immediately, with no prose first) rather than a
// text block holding a JSON string.
const SECOND_CHECK_TOOL = {
  name: 'report_check',
  description: 'Report whether every sentence in the paragraph is supported by the data.',
  input_schema: {
    type: 'object',
    properties: {
      supported: { type: 'boolean' },
      problems: {
        type: 'array',
        items: { type: 'object', properties: { sentence: { type: 'string' }, reason: { type: 'string' } }, required: ['sentence', 'reason'] }
      }
    },
    required: ['supported']
  }
};
async function callSecondCheck(dataBlockText, tripText) {
  return E.anthropic('POST', '/v1/messages', {
    model: E.MODEL,
    max_tokens: F.TRIP_SECOND_CHECK_MAX_TOKENS,
    system: [{ type: 'text', text: F.TRIP_SECOND_CHECK_PROMPT, cache_control: { type: 'ephemeral' } }],
    messages: [{ role: 'user', content: 'DATA\n' + dataBlockText + '\n\nPARAGRAPH\n' + tripText }],
    tools: [SECOND_CHECK_TOOL],
    tool_choice: { type: 'tool', name: 'report_check' }
  });
}
function parseSecondCheck(resp) {
  if (resp.status !== 200 || !resp.json || !Array.isArray(resp.json.content)) return null;
  const block = resp.json.content.find(function(b) { return b.type === 'tool_use' && b.name === 'report_check'; });
  if (block && block.input && typeof block.input.supported === 'boolean') return block.input;
  return null;
}

// Change C — combined second check, one per horse, covering both the going
// and trip texts against both data blocks. Same forced-tool-call pattern as
// SECOND_CHECK_TOOL above; each problem names which section ('going' or
// 'trip') it belongs to, so the runner knows which text to rewrite.
// Change B.2 — "problems" is always required (not just when supported is
// false) and must hold at least one entry: the schema can't conditionally
// require a field only when supported===false, so this is enforced here by
// requiring it unconditionally, and the model is told in the prompt that an
// empty/missing problems array is only valid when supported is true.
const GOINGTRIP_SECOND_CHECK_TOOL = {
  name: 'report_goingtrip_check',
  description: 'Report whether every sentence in both the going and trip paragraphs is supported by their own data block.',
  input_schema: {
    type: 'object',
    properties: {
      supported: { type: 'boolean' },
      problems: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            section: { type: 'string', enum: ['going', 'trip'] },
            sentence: { type: 'string' },
            reason: { type: 'string' }
          },
          required: ['section', 'sentence', 'reason']
        }
      }
    },
    required: ['supported', 'problems']
  }
};
async function callGoingTripSecondCheck(goingBlockText, tripBlockText, goingText, tripText) {
  return E.anthropic('POST', '/v1/messages', {
    model: E.MODEL,
    max_tokens: F.GOINGTRIP_SECOND_CHECK_MAX_TOKENS,
    system: [{ type: 'text', text: F.GOINGTRIP_SECOND_CHECK_PROMPT, cache_control: { type: 'ephemeral' } }],
    messages: [{ role: 'user', content: goingBlockText + '\n\n' + tripBlockText + '\n\nGOING PARAGRAPH\n' + goingText + '\n\nTRIP PARAGRAPH\n' + tripText }],
    tools: [GOINGTRIP_SECOND_CHECK_TOOL],
    tool_choice: { type: 'tool', name: 'report_goingtrip_check' }
  });
}
function parseGoingTripSecondCheck(resp) {
  if (resp.status !== 200 || !resp.json || !Array.isArray(resp.json.content)) return null;
  const block = resp.json.content.find(function(b) { return b.type === 'tool_use' && b.name === 'report_goingtrip_check'; });
  if (!block || !block.input || typeof block.input.supported !== 'boolean') return null;
  // Change B.2 safety net — if the model reports unsupported with no
  // problems listed, treat the response as unusable (same as a malformed
  // tool call) rather than silently accepting "unsupported, no reason".
  if (block.input.supported === false && (!Array.isArray(block.input.problems) || !block.input.problems.length)) return null;
  return block.input;
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

// Change C — combined store. goingText/tripText may each independently be
// null (that text failed and nothing is written for it — the other field,
// and anything else already in the record such as a Track value some other
// job wrote, is left untouched). Same field names/shape as storeGoing's
// going/goingWindow/generatedAt and storeTrip's trip/tripWindow/
// tripGeneratedAt, just merged in one write instead of two.
async function storeGoingTrip(h, win, goingText, tripText) {
  const existing = await E.redisGet('form-sections:' + h.horse_id);
  const record = Object.assign({}, existing || {});
  const nowIso = new Date().toISOString();
  const windowInfo = { size: win.size, limit: win.limitApplied, oldest: win.oldestDate, newest: win.newestDate, excludedNoGoing: win.excludedNoGoing };
  if (goingText !== null && goingText !== undefined) {
    record.going = goingText;
    record.goingWindow = windowInfo;
    record.generatedAt = nowIso;
  }
  if (tripText !== null && tripText !== undefined) {
    record.trip = tripText;
    record.tripWindow = windowInfo;
    record.tripGeneratedAt = nowIso;
  }
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
    return { horse_id: h.horse_id, horseName: h.name, stored: true, template: true, attempt: 0, usage: { input: 0, output: 0, cacheWrite: 0, cacheRead: 0 }, usage2: { input: 0, output: 0, cacheWrite: 0, cacheRead: 0 }, windowInfo: win };
  }

  const groups = F.tripGroups(win.rows, fullSorted);
  const envelope = F.buildTripEnvelope(h, win, groups);
  const tripData = { groups: groups, windowSize: win.size, courses: F.courseNamesIn(win.rows) };
  const dataBlockText = 'TRIP DATA\n' + F.buildTripBlock(groups);
  let usage = { input: 0, output: 0, cacheWrite: 0, cacheRead: 0 };
  let usage2 = { input: 0, output: 0, cacheWrite: 0, cacheRead: 0 };

  async function write(userText) {
    const resp = await callModelTrip(userText);
    if (resp.status !== 200 || !resp.json || !Array.isArray(resp.json.content)) return { error: 'HTTP ' + resp.status + ' ' + (resp.raw || '').slice(0, 200) };
    usage = addUsage(usage, usageFrom(resp.json));
    return { text: (resp.json.content[0] && resp.json.content[0].text) || '' };
  }
  // Trip round 3, Change 6 — second check, run only once a text has already
  // passed validateTrip. Tokens/cost tracked separately (usage2).
  async function secondCheck(tripText) {
    const resp = await callSecondCheck(dataBlockText, tripText);
    if (resp.status !== 200 || !resp.json || !Array.isArray(resp.json.content)) return { error: 'HTTP ' + resp.status + ' ' + (resp.raw || '').slice(0, 200) };
    usage2 = addUsage(usage2, usageFrom(resp.json));
    const parsed = parseSecondCheck(resp);
    if (!parsed) {
      return { error: 'no usable report_check tool call — content: ' + JSON.stringify(resp.json.content).slice(0, 400) + ' [stop_reason=' + resp.json.stop_reason + ']' };
    }
    return { supported: parsed.supported, problems: parsed.problems || [] };
  }

  // ── Pass 1: write, then the existing one-retry-on-code-failure cycle ──
  let w = await write(envelope);
  if (w.error) return { horse_id: h.horse_id, horseName: h.name, stored: false, attempt: 1, error: w.error, usage: usage, usage2: usage2, windowInfo: win };
  let v = F.validateTrip(w.text, tripData);
  let codeCheckFirstFailures = null, codeCheckRetryFailures = null;
  let attempt = 1;

  if (!v.ok) {
    codeCheckFirstFailures = v.failures;
    const notes = v.failures.map(function(x) { return '- ' + x.check + (x.detail ? ': "' + x.detail + '"' : ''); }).join('\n');
    const retryText = envelope + '\n\nPREVIOUS ATTEMPT FAILED VALIDATION — every claim is checked in code against the trip data above. Failures:\n' + notes + '\nRewrite so every position, distance and count appears in the trip data exactly, with no new claims, staying inside the word limit.';
    w = await write(retryText);
    attempt = 2;
    if (w.error) return { horse_id: h.horse_id, horseName: h.name, stored: false, attempt: 2, codeCheckFirstFailures: codeCheckFirstFailures, error: 'retry ' + w.error, usage: usage, usage2: usage2, windowInfo: win };
    v = F.validateTrip(w.text, tripData);
    if (!v.ok) {
      codeCheckRetryFailures = v.failures;
      return { horse_id: h.horse_id, horseName: h.name, stored: false, attempt: 2, codeCheckFirstFailures: codeCheckFirstFailures, codeCheckRetryFailures: codeCheckRetryFailures, usage: usage, usage2: usage2, windowInfo: win };
    }
  }

  // v.ok is true here — candidateText passed the code checker on `attempt`.
  let candidateText = v.trip, wordCount = v.wordCount, wordWarning = v.warnings[0] || null;

  const sc1 = await secondCheck(candidateText);
  if (sc1.error) return { horse_id: h.horse_id, horseName: h.name, stored: false, attempt: attempt, codeCheckFirstFailures: codeCheckFirstFailures, error: 'second check ' + sc1.error, usage: usage, usage2: usage2, windowInfo: win };
  if (sc1.supported) {
    await storeTrip(h, win, candidateText);
    return { horse_id: h.horse_id, horseName: h.name, stored: true, template: false, attempt: attempt, usage: usage, usage2: usage2, wordCount: wordCount, wordWarning: wordWarning, cacheRead: usage.cacheRead > 0, codeCheckFirstFailures: codeCheckFirstFailures, secondCheckFirstSupported: true, windowInfo: win };
  }

  // Second check found unsupported statements — regenerate ONCE with the
  // problems appended, then run both checks again.
  const problemsList = sc1.problems.map(function(p) { return '- "' + p.sentence + '": ' + p.reason; }).join('\n');
  const regenText = envelope + '\n\nA checker found these unsupported statements: ' + problemsList + '. Rewrite using only what the data shows.';
  w = await write(regenText);
  const regenAttempt = attempt + 1;
  if (w.error) return { horse_id: h.horse_id, horseName: h.name, stored: false, attempt: regenAttempt, codeCheckFirstFailures: codeCheckFirstFailures, secondCheckFirstSupported: false, secondCheckFirstProblems: sc1.problems, error: 'regen ' + w.error, usage: usage, usage2: usage2, windowInfo: win };
  const v2 = F.validateTrip(w.text, tripData);
  if (!v2.ok) {
    return { horse_id: h.horse_id, horseName: h.name, stored: false, attempt: regenAttempt, codeCheckFirstFailures: codeCheckFirstFailures, secondCheckFirstSupported: false, secondCheckFirstProblems: sc1.problems, codeCheckRetryFailures: v2.failures, usage: usage, usage2: usage2, windowInfo: win };
  }
  const sc2 = await secondCheck(v2.trip);
  if (sc2.error) return { horse_id: h.horse_id, horseName: h.name, stored: false, attempt: regenAttempt, codeCheckFirstFailures: codeCheckFirstFailures, secondCheckFirstSupported: false, secondCheckFirstProblems: sc1.problems, error: 'second check (regen) ' + sc2.error, usage: usage, usage2: usage2, windowInfo: win };
  if (!sc2.supported) {
    return { horse_id: h.horse_id, horseName: h.name, stored: false, attempt: regenAttempt, codeCheckFirstFailures: codeCheckFirstFailures, secondCheckFirstSupported: false, secondCheckFirstProblems: sc1.problems, secondCheckSecondSupported: false, secondCheckSecondProblems: sc2.problems, usage: usage, usage2: usage2, windowInfo: win };
  }
  await storeTrip(h, win, v2.trip);
  return { horse_id: h.horse_id, horseName: h.name, stored: true, template: false, attempt: regenAttempt, usage: usage, usage2: usage2, wordCount: v2.wordCount, wordWarning: v2.warnings[0] || null, cacheRead: usage.cacheRead > 0, codeCheckFirstFailures: codeCheckFirstFailures, secondCheckFirstSupported: false, secondCheckFirstProblems: sc1.problems, secondCheckSecondSupported: true, regenerated: true, windowInfo: win };
}

// Change C — Going + Trip combined, one call per horse. Both texts share the
// one window/envelope (sectionWindow is the same function Going and Trip
// already each called separately with identical inputs, so it is computed
// once here). validateGoing/validateTrip each parse the SAME combined JSON
// text and read only their own field, so no change to either validator's
// parse step was needed for this.
async function processHorseGoingTrip(h, date) {
  const rows = await E.redisGet('form:history:' + h.horse_id + ':' + date);
  const allRows = Array.isArray(rows) ? rows : [];
  const fullSorted = allRows.filter(function(r) { return r && r.date; }).slice().sort(function(a, b) { return String(b.date).localeCompare(String(a.date)); });
  const win = F.sectionWindow(allRows, date);

  let usage = { input: 0, output: 0, cacheWrite: 0, cacheRead: 0 };
  let usage2 = { input: 0, output: 0, cacheWrite: 0, cacheRead: 0 };

  if (!win.size) {
    await storeGoingTrip(h, win, F.NO_RUNS_TEMPLATE, F.NO_RUNS_TRIP_TEMPLATE);
    return { horse_id: h.horse_id, horseName: h.name, storedGoing: true, storedTrip: true, template: true, attempt: 0, usage: usage, usage2: usage2, windowInfo: win };
  }

  const goingGroupsList = F.goingGroups(win.rows);
  const neverRun = F.goingNeverRun(goingGroupsList);
  const neverRunAW = F.goingNeverRunAW(goingGroupsList);
  const goingBlock = { groups: goingGroupsList, neverRun: neverRun, neverRunAW: neverRunAW, windowSize: win.size };
  const goingBlockText = 'GOING DATA\n' + F.buildGoingBlock(goingGroupsList, neverRun, neverRunAW);

  const tripGroupsList = F.tripGroups(win.rows, fullSorted);
  const tripData = { groups: tripGroupsList, windowSize: win.size, courses: F.courseNamesIn(win.rows) };
  const tripBlockText = 'TRIP DATA\n' + F.buildTripBlock(tripGroupsList);

  const envelope = F.buildEnvelope(h, win, [
    { heading: 'GOING DATA', text: F.buildGoingBlock(goingGroupsList, neverRun, neverRunAW) },
    { heading: 'TRIP DATA', text: F.buildTripBlock(tripGroupsList) }
  ]);

  async function write(userText) {
    const resp = await callModelGoingTrip(userText);
    if (resp.status !== 200 || !resp.json || !Array.isArray(resp.json.content)) return { error: 'HTTP ' + resp.status + ' ' + (resp.raw || '').slice(0, 200) };
    usage = addUsage(usage, usageFrom(resp.json));
    return { text: (resp.json.content[0] && resp.json.content[0].text) || '' };
  }
  async function secondCheck(goingText, tripText) {
    const resp = await callGoingTripSecondCheck(goingBlockText, tripBlockText, goingText, tripText);
    if (resp.status !== 200 || !resp.json || !Array.isArray(resp.json.content)) return { error: 'HTTP ' + resp.status + ' ' + (resp.raw || '').slice(0, 200) };
    usage2 = addUsage(usage2, usageFrom(resp.json));
    const parsed = parseGoingTripSecondCheck(resp);
    if (!parsed) return { error: 'no usable report_goingtrip_check tool call — content: ' + JSON.stringify(resp.json.content).slice(0, 400) + ' [stop_reason=' + resp.json.stop_reason + ']' };
    return { supported: parsed.supported, problems: parsed.problems || [] };
  }

  // ── Pass 1: write, validate both texts, one retry (both) on a code failure ──
  let w = await write(envelope);
  if (w.error) return { horse_id: h.horse_id, horseName: h.name, storedGoing: false, storedTrip: false, attempt: 1, error: w.error, usage: usage, usage2: usage2, windowInfo: win };
  let vG = F.validateGoing(w.text, goingBlock);
  let vT = F.validateTrip(w.text, tripData);
  let attempt = 1;
  const codeCheckFirstFailures = { going: vG.ok ? null : vG.failures, trip: vT.ok ? null : vT.failures };

  if (!vG.ok || !vT.ok) {
    const notes = [];
    if (!vG.ok) notes.push('GOING:\n' + vG.failures.map(function(x) { return '- ' + x.check + (x.detail ? ': "' + x.detail + '"' : ''); }).join('\n'));
    if (!vT.ok) notes.push('TRIP:\n' + vT.failures.map(function(x) { return '- ' + x.check + (x.detail ? ': "' + x.detail + '"' : ''); }).join('\n'));
    const retryText = envelope + '\n\nPREVIOUS ATTEMPT FAILED VALIDATION — every claim is checked in code against the data above. Failures:\n' + notes.join('\n') + '\nRewrite both going and trip so every position, going or distance name and count appears in the data exactly, with no new claims, staying inside the word limit.';
    w = await write(retryText);
    attempt = 2;
    if (w.error) return { horse_id: h.horse_id, horseName: h.name, storedGoing: false, storedTrip: false, attempt: 2, codeCheckFirstFailures: codeCheckFirstFailures, error: 'retry ' + w.error, usage: usage, usage2: usage2, windowInfo: win };
    vG = F.validateGoing(w.text, goingBlock);
    vT = F.validateTrip(w.text, tripData);
    if (!vG.ok || !vT.ok) {
      return { horse_id: h.horse_id, horseName: h.name, storedGoing: false, storedTrip: false, attempt: 2, codeCheckFirstFailures: codeCheckFirstFailures, codeCheckRetryFailures: { going: vG.ok ? null : vG.failures, trip: vT.ok ? null : vT.failures }, usage: usage, usage2: usage2, windowInfo: win };
    }
  }

  // Both passed the code checker on `attempt`.
  let goingText = vG.going, tripText = vT.trip;

  const sc1 = await secondCheck(goingText, tripText);
  if (sc1.error) return { horse_id: h.horse_id, horseName: h.name, storedGoing: false, storedTrip: false, attempt: attempt, codeCheckFirstFailures: codeCheckFirstFailures, error: 'second check ' + sc1.error, usage: usage, usage2: usage2, windowInfo: win };
  if (sc1.supported) {
    await storeGoingTrip(h, win, goingText, tripText);
    return { horse_id: h.horse_id, horseName: h.name, storedGoing: true, storedTrip: true, template: false, attempt: attempt, usage: usage, usage2: usage2, wordCount: { going: vG.wordCount, trip: vT.wordCount }, cacheRead: usage.cacheRead > 0, codeCheckFirstFailures: codeCheckFirstFailures, secondCheckFirstSupported: true, windowInfo: win };
  }

  // Second check found unsupported statements — rewrite ONLY the section(s)
  // named in problems, keeping the other (already-passing) text fixed, then
  // re-check once. Whichever section still fails after that gets nothing
  // stored for it; the other is stored if it passed.
  const problems = sc1.problems || [];
  const goingProblems = problems.filter(function(p) { return p.section === 'going'; });
  const tripProblems = problems.filter(function(p) { return p.section === 'trip'; });

  const notes2 = [];
  if (goingProblems.length) notes2.push('GOING — unsupported: ' + goingProblems.map(function(p) { return '"' + p.sentence + '": ' + p.reason; }).join('; '));
  if (tripProblems.length) notes2.push('TRIP — unsupported: ' + tripProblems.map(function(p) { return '"' + p.sentence + '": ' + p.reason; }).join('; '));
  const keepNotes = [];
  if (!goingProblems.length) keepNotes.push('CURRENT GOING TEXT (keep this exactly, do not change it): ' + goingText);
  if (!tripProblems.length) keepNotes.push('CURRENT TRIP TEXT (keep this exactly, do not change it): ' + tripText);
  const regenText = envelope + '\n\nA checker found these unsupported statements:\n' + notes2.join('\n') + '\nRewrite only the section(s) with unsupported statements, using only what the data shows. Return the full JSON with both going and trip.' + (keepNotes.length ? '\n\n' + keepNotes.join('\n') : '');
  const regenAttempt = attempt + 1;

  w = await write(regenText);
  if (w.error) {
    // Could not even get a rewrite — keep whichever side had no problems,
    // store nothing for the side that was unsupported.
    const finalGoing = goingProblems.length ? null : goingText;
    const finalTrip = tripProblems.length ? null : tripText;
    await storeGoingTrip(h, win, finalGoing, finalTrip);
    return { horse_id: h.horse_id, horseName: h.name, storedGoing: !!finalGoing, storedTrip: !!finalTrip, attempt: regenAttempt, codeCheckFirstFailures: codeCheckFirstFailures, secondCheckFirstSupported: false, secondCheckFirstProblems: problems, error: 'regen ' + w.error, usage: usage, usage2: usage2, windowInfo: win };
  }

  const vG2 = F.validateGoing(w.text, goingBlock);
  const vT2 = F.validateTrip(w.text, tripData);
  // Only trust the rewrite for a section that actually had a problem; the
  // other section keeps its already-passing text regardless of what the
  // model returned for it this time.
  let candidateGoing = goingProblems.length ? (vG2.ok ? vG2.going : null) : goingText;
  let candidateTrip = tripProblems.length ? (vT2.ok ? vT2.trip : null) : tripText;

  let finalGoing = candidateGoing, finalTrip = candidateTrip;
  let sc2Supported = null, sc2Problems = null;
  if (candidateGoing && candidateTrip) {
    const sc2 = await secondCheck(candidateGoing, candidateTrip);
    if (sc2.error) {
      // Can't confirm the rewrite — be safe and store nothing for the
      // section(s) that were being rewritten.
      finalGoing = goingProblems.length ? null : candidateGoing;
      finalTrip = tripProblems.length ? null : candidateTrip;
    } else {
      sc2Supported = sc2.supported; sc2Problems = sc2.problems;
      const stillBadGoing = sc2.supported === false && sc2.problems.some(function(p) { return p.section === 'going'; });
      const stillBadTrip = sc2.supported === false && sc2.problems.some(function(p) { return p.section === 'trip'; });
      finalGoing = stillBadGoing ? null : candidateGoing;
      finalTrip = stillBadTrip ? null : candidateTrip;
    }
  }
  // If either candidate came back null from the code check above (the
  // targeted rewrite itself failed validateGoing/validateTrip), there is
  // nothing to second-check for that side — it simply stores nothing.

  await storeGoingTrip(h, win, finalGoing, finalTrip);
  return {
    horse_id: h.horse_id, horseName: h.name, storedGoing: !!finalGoing, storedTrip: !!finalTrip,
    template: false, attempt: regenAttempt, usage: usage, usage2: usage2, cacheRead: usage.cacheRead > 0,
    codeCheckFirstFailures: codeCheckFirstFailures, secondCheckFirstSupported: false, secondCheckFirstProblems: problems,
    secondCheckSecondSupported: sc2Supported, secondCheckSecondProblems: sc2Problems, regenerated: true, windowInfo: win
  };
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
  const block = { groups: groups, neverRun: neverRun, neverRunAW: neverRunAW, windowSize: win.size };
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
    let remaining, results, templated, generated, failed, usage, usage2, cacheReadCount, firstPassFailCount, secondCheckFailCount, regeneratedCount, passedFirstTimeCount, raceIdsUsed;

    if (state) {
      remaining = state.remaining; results = state.results; templated = state.templated;
      generated = state.generated; failed = state.failed; usage = state.usage; usage2 = state.usage2 || { input: 0, output: 0, cacheWrite: 0, cacheRead: 0 };
      cacheReadCount = state.cacheReadCount; firstPassFailCount = state.firstPassFailCount;
      secondCheckFailCount = state.secondCheckFailCount || 0; regeneratedCount = state.regeneratedCount || 0; passedFirstTimeCount = state.passedFirstTimeCount || 0;
      raceIdsUsed = state.raceIdsUsed || raceIds;
    } else {
      remaining = await eligibleHorsesForRaces(date, raceIds);
      results = []; templated = 0; generated = 0; failed = [];
      usage = { input: 0, output: 0, cacheWrite: 0, cacheRead: 0 };
      usage2 = { input: 0, output: 0, cacheWrite: 0, cacheRead: 0 };
      cacheReadCount = 0; firstPassFailCount = 0; secondCheckFailCount = 0; regeneratedCount = 0; passedFirstTimeCount = 0; raceIdsUsed = raceIds;
      console.log('[form-sections:trip]', remaining.length, 'eligible horses across', raceIds.length, 'race(s) for', date);
    }

    const totalEligible = (state && state.totalEligible) || remaining.length + results.length;
    let timedOut = false;

    while (remaining.length) {
      if (Date.now() - startTime > TIMEOUT_MS) { timedOut = true; break; }
      const chunk = remaining.slice(0, CONCURRENCY);
      const settled = await Promise.all(chunk.map(function(h) { return processHorseTrip(h, date).catch(function(e) { return { horse_id: h.horse_id, horseName: h.name, stored: false, error: e.message, usage: { input: 0, output: 0, cacheWrite: 0, cacheRead: 0 }, usage2: { input: 0, output: 0, cacheWrite: 0, cacheRead: 0 } }; }); }));
      settled.forEach(function(r) {
        const emptyUsage = { input: 0, output: 0, cacheWrite: 0, cacheRead: 0 };
        results.push({
          horse_id: r.horse_id, horseName: r.horseName, stored: r.stored, template: !!r.template, attempt: r.attempt,
          wordCount: r.wordCount || null,
          codeCheckFirstFailures: r.codeCheckFirstFailures || null, codeCheckRetryFailures: r.codeCheckRetryFailures || null,
          secondCheckFirstSupported: r.secondCheckFirstSupported === undefined ? null : r.secondCheckFirstSupported,
          secondCheckFirstProblems: r.secondCheckFirstProblems || null,
          secondCheckSecondSupported: r.secondCheckSecondSupported === undefined ? null : r.secondCheckSecondSupported,
          secondCheckSecondProblems: r.secondCheckSecondProblems || null,
          regenerated: !!r.regenerated
        });
        usage = addUsage(usage, r.usage || emptyUsage);
        usage2 = addUsage(usage2, r.usage2 || emptyUsage);
        if (r.template) templated++;
        else if (r.stored) {
          generated++;
          if (r.cacheRead) cacheReadCount++;
          if (!r.codeCheckFirstFailures && r.secondCheckFirstSupported) passedFirstTimeCount++;
        } else {
          failed.push({ horse_id: r.horse_id, horseName: r.horseName, error: r.error || null, codeCheckFirstFailures: r.codeCheckFirstFailures || null, codeCheckRetryFailures: r.codeCheckRetryFailures || null, secondCheckFirstProblems: r.secondCheckFirstProblems || null, secondCheckSecondProblems: r.secondCheckSecondProblems || null });
        }
        if (r.codeCheckFirstFailures && r.codeCheckFirstFailures.length) firstPassFailCount++;
        if (r.secondCheckFirstSupported === false) secondCheckFailCount++;
        if (r.regenerated) regeneratedCount++;
      });
      remaining = remaining.slice(CONCURRENCY);
    }

    if (timedOut && remaining.length) {
      if (hop < HOP_CAP) {
        await E.redisSet('form-sections:trip:worklist:' + date, { remaining: remaining, results: results, templated: templated, generated: generated, failed: failed, usage: usage, usage2: usage2, cacheReadCount: cacheReadCount, firstPassFailCount: firstPassFailCount, secondCheckFailCount: secondCheckFailCount, regeneratedCount: regeneratedCount, passedFirstTimeCount: passedFirstTimeCount, raceIdsUsed: raceIdsUsed, totalEligible: totalEligible });
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
      passedFirstTime: passedFirstTimeCount,
      failedCount: failed.length,
      failed: failed,
      results: results,
      retriedCount: firstPassFailCount,
      secondCheckFailCount: secondCheckFailCount,
      regeneratedCount: regeneratedCount,
      cacheReadCalls: cacheReadCount,
      cacheActive: cacheReadCount > 0,
      usage: usage,
      costUSD: costOf(usage),
      usage2: usage2,
      cost2USD: costOf(usage2),
      totalCostUSD: +(costOf(usage) + costOf(usage2)).toFixed(4),
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

// Change C — Going + Trip combined, whole card (eligibleHorses(date), same
// scope as the default Going-only path, not race-scoped like the Trip
// trial). Own lock/worklist/heartbeat/coverage keys (namespaced
// ":goingtrip:") so this can never collide with a concurrent plain Going or
// Trip-trial run on the same date.
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
    let remaining, results, templated, bothGenerated, partialGenerated, failed, usage, usage2, cacheReadCount, firstPassFailCount, secondCheckFailCount, regeneratedCount, passedFirstTimeCount;

    if (state) {
      remaining = state.remaining; results = state.results; templated = state.templated;
      bothGenerated = state.bothGenerated; partialGenerated = state.partialGenerated; failed = state.failed; usage = state.usage; usage2 = state.usage2 || { input: 0, output: 0, cacheWrite: 0, cacheRead: 0 };
      cacheReadCount = state.cacheReadCount; firstPassFailCount = state.firstPassFailCount;
      secondCheckFailCount = state.secondCheckFailCount || 0; regeneratedCount = state.regeneratedCount || 0; passedFirstTimeCount = state.passedFirstTimeCount || 0;
    } else {
      remaining = await eligibleHorses(date);
      results = []; templated = 0; bothGenerated = 0; partialGenerated = 0; failed = [];
      usage = { input: 0, output: 0, cacheWrite: 0, cacheRead: 0 };
      usage2 = { input: 0, output: 0, cacheWrite: 0, cacheRead: 0 };
      cacheReadCount = 0; firstPassFailCount = 0; secondCheckFailCount = 0; regeneratedCount = 0; passedFirstTimeCount = 0;
      console.log('[form-sections:goingtrip]', remaining.length, 'eligible horses for', date);
    }

    const totalEligible = (state && state.totalEligible) || remaining.length + results.length;
    let timedOut = false;

    while (remaining.length) {
      if (Date.now() - startTime > TIMEOUT_MS) { timedOut = true; break; }
      const chunk = remaining.slice(0, CONCURRENCY);
      const settled = await Promise.all(chunk.map(function(h) { return processHorseGoingTrip(h, date).catch(function(e) { return { horse_id: h.horse_id, horseName: h.name, storedGoing: false, storedTrip: false, error: e.message, usage: { input: 0, output: 0, cacheWrite: 0, cacheRead: 0 }, usage2: { input: 0, output: 0, cacheWrite: 0, cacheRead: 0 } }; }); }));
      settled.forEach(function(r) {
        const emptyUsage = { input: 0, output: 0, cacheWrite: 0, cacheRead: 0 };
        results.push({
          horse_id: r.horse_id, horseName: r.horseName, storedGoing: !!r.storedGoing, storedTrip: !!r.storedTrip, template: !!r.template, attempt: r.attempt,
          wordCount: r.wordCount || null,
          codeCheckFirstFailures: r.codeCheckFirstFailures || null, codeCheckRetryFailures: r.codeCheckRetryFailures || null,
          secondCheckFirstSupported: r.secondCheckFirstSupported === undefined ? null : r.secondCheckFirstSupported,
          secondCheckFirstProblems: r.secondCheckFirstProblems || null,
          secondCheckSecondSupported: r.secondCheckSecondSupported === undefined ? null : r.secondCheckSecondSupported,
          secondCheckSecondProblems: r.secondCheckSecondProblems || null,
          regenerated: !!r.regenerated
        });
        usage = addUsage(usage, r.usage || emptyUsage);
        usage2 = addUsage(usage2, r.usage2 || emptyUsage);
        if (r.template) templated++;
        else if (r.storedGoing && r.storedTrip) {
          bothGenerated++;
          if (r.cacheRead) cacheReadCount++;
          if (!r.codeCheckFirstFailures && r.secondCheckFirstSupported) passedFirstTimeCount++;
        } else if (r.storedGoing || r.storedTrip) {
          partialGenerated++;
          if (r.cacheRead) cacheReadCount++;
        } else {
          failed.push({ horse_id: r.horse_id, horseName: r.horseName, error: r.error || null, codeCheckFirstFailures: r.codeCheckFirstFailures || null, codeCheckRetryFailures: r.codeCheckRetryFailures || null, secondCheckFirstProblems: r.secondCheckFirstProblems || null, secondCheckSecondProblems: r.secondCheckSecondProblems || null });
        }
        if (r.codeCheckFirstFailures && (r.codeCheckFirstFailures.going || r.codeCheckFirstFailures.trip)) firstPassFailCount++;
        if (r.secondCheckFirstSupported === false) secondCheckFailCount++;
        if (r.regenerated) regeneratedCount++;
      });
      remaining = remaining.slice(CONCURRENCY);
    }

    if (timedOut && remaining.length) {
      if (hop < HOP_CAP) {
        await E.redisSet('form-sections:goingtrip:worklist:' + date, { remaining: remaining, results: results, templated: templated, bothGenerated: bothGenerated, partialGenerated: partialGenerated, failed: failed, usage: usage, usage2: usage2, cacheReadCount: cacheReadCount, firstPassFailCount: firstPassFailCount, secondCheckFailCount: secondCheckFailCount, regeneratedCount: regeneratedCount, passedFirstTimeCount: passedFirstTimeCount, totalEligible: totalEligible });
        try { await E.redisSet('form-sections:goingtrip:lock:' + date, null); } catch (ue) {}
        console.log('[form-sections:goingtrip] approaching timeout at hop', hop, '—', remaining.length, 'horse(s) still queued, chaining hop', hop + 1);
        await new Promise(function(resolve) {
          const req = https.request({
            hostname: HOSTNAME, path: '/.netlify/functions/form-sections-run-background?date=' + date + '&section=goingtrip&hop=' + (hop + 1),
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
      date: date,
      completedAt: new Date().toISOString(),
      totalEligible: totalEligible,
      templated: templated,
      bothGenerated: bothGenerated,
      partialGenerated: partialGenerated,
      passedFirstTime: passedFirstTimeCount,
      failedCount: failed.length,
      failed: failed,
      results: results,
      retriedCount: firstPassFailCount,
      secondCheckFailCount: secondCheckFailCount,
      regeneratedCount: regeneratedCount,
      cacheReadCalls: cacheReadCount,
      cacheActive: cacheReadCount > 0,
      usage: usage,
      costUSD: costOf(usage),
      usage2: usage2,
      cost2USD: costOf(usage2),
      totalCostUSD: +(costOf(usage) + costOf(usage2)).toFixed(4),
      hops: hop + 1,
      pricing: PRICE
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

  // Trip trial — entirely separate lock/worklist/heartbeat/coverage keys
  // (namespaced ":trip:") so it can never collide with a concurrent Going
  // run on the same date. Going's own path below is unchanged.
  if (qs.section === 'trip') {
    return runTripSection(date, qs, hop, startTime, headers);
  }

  // Change C — Going + Trip combined, one call per horse, whole card. Own
  // ":goingtrip:" keys, same as the Trip trial's own isolation from Going.
  if (qs.section === 'goingtrip') {
    return runGoingTripSection(date, qs, hop, startTime, headers);
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
