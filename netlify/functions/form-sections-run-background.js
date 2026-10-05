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
// Hard cost cap for the goingtrip whole-card run — checked after every
// CONCURRENCY-sized chunk (finer-grained than the hop boundary, which only
// persists usage every ~780s), so a run can actually stop cleanly near the
// requested ceiling rather than only being observable between hops.
const GOINGTRIP_COST_CAP_USD = 9.00;
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
        list.push({ horse_id: ru.horse_id, name: ru.name || 'Unknown', age: ru.age || '?', sex: ru.sex || 'unknown sex', meeting: m.name || m.id });
      });
    });
  });
  return list;
}

// Sample-run support (cache probe / spot checks) — a random subset spread
// across every meeting present, not the first N in card order. Round-robins
// a shuffled per-meeting queue so a small n still touches every meeting it
// can before any meeting gets a second horse.
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
  description: 'Report whether every sentence in the going, trip and (when given) track paragraphs is supported by their own data block.',
  input_schema: {
    type: 'object',
    properties: {
      supported: { type: 'boolean' },
      problems: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            section: { type: 'string', enum: ['going', 'trip', 'track'] },
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
// Bug fix Fix 3 — tool_choice auto (was forced): a forced tool call makes
// the model commit its problems array as its very first output, before it
// can act on the prompt's own "re-read each problem... remove it" self-
// review instruction. Auto lets it reason in text first, then call the
// tool with its settled answer. parseGoingTripSecondCheck already scans
// the whole content array with .find(), so it finds the tool_use block
// wherever it lands (text block(s) first, tool call after) with no change
// needed there.
// Track build — trackBlockText/trackText are optional (null when this
// horse's Track window is templated, see processHorseGoingTrip): the system
// prompt already tells the model to judge only GOING/TRIP when no TRACK
// paragraph is given, so the user message simply omits that section.
async function callGoingTripSecondCheck(goingBlockText, tripBlockText, goingText, tripText, trackBlockText, trackText) {
  let content = goingBlockText + '\n\n' + tripBlockText + '\n\nGOING PARAGRAPH\n' + goingText + '\n\nTRIP PARAGRAPH\n' + tripText;
  if (trackBlockText && trackText) content += '\n\n' + trackBlockText + '\n\nTRACK PARAGRAPH\n' + trackText;
  return E.anthropic('POST', '/v1/messages', {
    model: E.MODEL,
    max_tokens: F.GOINGTRIP_SECOND_CHECK_MAX_TOKENS,
    system: [{ type: 'text', text: F.GOINGTRIP_SECOND_CHECK_PROMPT, cache_control: { type: 'ephemeral' } }],
    messages: [{ role: 'user', content: content }],
    tools: [GOINGTRIP_SECOND_CHECK_TOOL],
    tool_choice: { type: 'auto' }
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
async function storeGoingTrip(h, win, goingText, tripText, trackText) {
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
  // Track build — no trackWindow field: Track's own window (last 15 runs /
  // 24 months, wall-clock) is independent of win (Going/Trip's race-day-
  // relative 18-month window), so win's windowInfo would misdescribe it.
  if (trackText !== null && trackText !== undefined) {
    record.track = trackText;
    record.trackGeneratedAt = nowIso;
  }
  await E.redisSet('form-sections:' + h.horse_id, record);
  return record;
}

// Telemetry (Part A) — every code-check failure and every second-check
// problem from the goingtrip pipeline is appended here, independent of the
// worklist and never touched by the lock/worklist-clearing stop logic, so a
// stopped or completed run's failure detail survives for diagnosis.
// Known limitation: this is a GET-then-SET append, since the E.redisGet/
// E.redisSet helpers have no native list-push op — two horses finishing in
// the same instant (CONCURRENCY is only 3) could race and lose an entry.
// Acceptable for diagnostic data; not used for anything correctness-critical.
async function appendTelemetry(date, entries) {
  if (!entries || !entries.length) return;
  try {
    const key = 'form-sections:telemetry:' + date;
    const existing = await E.redisGet(key);
    const arr = Array.isArray(existing) ? existing : [];
    await E.redisSet(key, arr.concat(entries));
  } catch (e) {}
}
// trip:comparison-claim's fail() detail already embeds the matched field and
// extracted distance as `"<field> <value>" ...` (see validateTrip section
// (d) in lib/form-sections.js) — parsed back out here rather than touching
// that validator, since Part A is scoped to this runner file only. The full
// per-type stamina lines are attached alongside so a reviewer can judge the
// claim against the same text the validator itself compared against.
function telemetryFromFailures(h, date, section, failures, stage, staminaLinesText) {
  return (failures || []).map(function(f) {
    const entry = { date: date, ts: new Date().toISOString(), horseName: h.name, horse_id: h.horse_id, section: section, check: f.check, detail: f.detail, stage: stage };
    if (section === 'trip' && f.check === 'comparison-claim') {
      entry.staminaLines = staminaLinesText || null;
      const m = /^"([a-zA-Z]+)\s+([^"]+)"/.exec(f.detail || '');
      entry.matchedField = m ? m[1] : null;
      entry.extractedValue = m ? m[2] : null;
    }
    return entry;
  });
}
function telemetryFromProblems(h, date, problems, stage) {
  return (problems || []).map(function(p) {
    return { date: date, ts: new Date().toISOString(), horseName: h.name, horse_id: h.horse_id, section: p.section, check: 'second-check', sentence: p.sentence, detail: p.reason, stage: stage };
  });
}

// Fix 3 (30-horse probe) — the self-review instruction in
// GOINGTRIP_SECOND_CHECK_PROMPT ("you MUST NOT include that entry...")
// still leaked: 4 of 16 second-check problems in that run had reasoning
// that itself concluded the sentence was supported ("...is supported",
// "...withdrawing this entry") yet the entry stayed in the tool call's
// problems array anyway. Model instruction alone isn't reliable, so this
// filters deterministically on the parsed result, checking only the FINAL
// sentence of each problem's reason (so an earlier, exploratory "might be
// supported" elsewhere in the reasoning doesn't cause a false drop).
// Explicit filler-word allowlist, not an open character gap — "is NOT
// supported" (a genuine, negated conclusion that the problem stands) must
// never match here, so only known affirming fillers are permitted between
// "is" and "supported".
const SELF_OVERRULE_PHRASES = [/\bis\s+(?:actually\s+|in\s+fact\s+|indeed\s+|clearly\s+|still\s+)?supported\b/i, /removing\s+this/i, /withdrawing\s+this/i, /no\s+problem\s+here/i, /must\s+not\s+be\s+flagged/i];
function isSelfOverruled(reason) {
  const sentences = String(reason || '').split(/(?<=[.!?])\s+/).filter(function(s) { return s.trim(); });
  const last = sentences.length ? sentences[sentences.length - 1] : String(reason || '');
  return SELF_OVERRULE_PHRASES.some(function(re) { return re.test(last); });
}
function filterSelfOverruled(problems) {
  const kept = [], dropped = [];
  (problems || []).forEach(function(p) { (isSelfOverruled(p.reason) ? dropped : kept).push(p); });
  return { kept: kept, dropped: dropped };
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

  // Track build — win.size === 0 (no usable Going/Trip window) also gates
  // Track's own early template here, even though Track's window (24 months)
  // is wider than Going/Trip's (18 months) and could in principle still
  // have a run in that 18-24 month gap. Disclosed simplification: handling
  // that gap would need a second, Track-only model call bolted onto this
  // early-return branch (the static combined prompt always asks for all
  // three fields in one completion, so there is no cheap way to ask for
  // "just track" here) purely for a narrow case — a horse with nothing in
  // 18 months but exactly one run 18-24 months back. Track for such a horse
  // simply waits until win.size is non-zero again.
  if (!win.size) {
    await storeGoingTrip(h, win, F.NO_RUNS_TEMPLATE, F.NO_RUNS_TRIP_TEMPLATE, F.NO_RUNS_TRACK_TEMPLATE);
    return { horse_id: h.horse_id, horseName: h.name, storedGoing: true, storedTrip: true, storedTrack: true, template: true, attempt: 0, usage: usage, usage2: usage2, firstWriteUsage: usage, windowInfo: win };
  }

  const goingGroupsList = F.goingGroups(win.rows);
  const neverRun = F.goingNeverRun(goingGroupsList);
  const neverRunAW = F.goingNeverRunAW(goingGroupsList);
  const goingBlock = { groups: goingGroupsList, neverRun: neverRun, neverRunAW: neverRunAW, windowSize: win.size };
  const goingBlockText = 'GOING DATA\n' + F.buildGoingBlock(goingGroupsList, neverRun, neverRunAW, win.size);

  const tripGroupsList = F.tripGroups(win.rows, fullSorted);
  const tripData = { groups: tripGroupsList, windowSize: win.size, courses: F.courseNamesIn(win.rows) };
  const tripBlockText = 'TRIP DATA\n' + F.buildTripBlock(tripGroupsList);
  // Telemetry (Part A) — this horse's full per-type stamina lines, attached
  // to any trip:comparison-claim telemetry entry below.
  const tripStaminaLinesText = F.staminaLines(tripGroupsList).join('\n');

  // Track build — own window (last 15 runs / 24 months, wall-clock),
  // independent of win: whenever win.size > 0 it is almost always non-
  // template too, since 24 months is a superset of win's 18-month cutoff
  // (the only way it isn't is a run row carrying a position but no course
  // string, which real Racing API rows never do). trackIsTemplate true here
  // is the negligible counterpart case — handled below by skipping the
  // model call for track and storing the fixed template text unconditionally
  // alongside whatever going/trip come back as.
  const trackWindowRowsList = F.trackWindowRows(allRows);
  const trackIsTemplate = !trackWindowRowsList.length;
  let trackGroupsList = [], trackRollupsList = null, trackBlockText = null, trackData = null;
  if (!trackIsTemplate) {
    trackGroupsList = F.trackGroups(trackWindowRowsList, F.COURSE_FACTS);
    trackRollupsList = F.trackRollups(trackGroupsList);
    trackBlockText = F.buildTrackBlock(h.horse_id, allRows, F.COURSE_FACTS);
    const windowCourseSet = {};
    trackGroupsList.forEach(function(g) { windowCourseSet[g.course] = true; });
    const disallowedCourses = F.rawCourseNamesIn(allRows).filter(function(c) { return !windowCourseSet[c]; });
    trackData = { groups: trackGroupsList, rollups: trackRollupsList, windowSize: trackWindowRowsList.length, disallowedCourses: disallowedCourses };
  }

  const envelope = F.buildEnvelope(h, win, [
    { heading: 'GOING DATA', text: F.buildGoingBlock(goingGroupsList, neverRun, neverRunAW, win.size) },
    { heading: 'TRIP DATA', text: F.buildTripBlock(tripGroupsList) }
  ]) + (trackIsTemplate ? '' : '\n\n' + trackBlockText);

  async function write(userText) {
    const resp = await callModelGoingTrip(userText);
    if (resp.status !== 200 || !resp.json || !Array.isArray(resp.json.content)) return { error: 'HTTP ' + resp.status + ' ' + (resp.raw || '').slice(0, 200) };
    usage = addUsage(usage, usageFrom(resp.json));
    return { text: (resp.json.content[0] && resp.json.content[0].text) || '' };
  }
  // Bug fix Fix 3 — tool_choice is now 'auto' (see callGoingTripSecondCheck),
  // so the model may spend an entire turn on reasoning text with no tool
  // call at all. One retry (same inputs) before giving up — only then is it
  // treated as check-failed for this horse, same as before.
  // Track build — trackText is passed through untouched; callGoingTripSecondCheck
  // itself omits the TRACK block/paragraph from the message when it's null
  // (trackIsTemplate), so this horse's second check simply covers going+trip.
  async function secondCheckAttempt(goingText, tripText, trackText) {
    const resp = await callGoingTripSecondCheck(goingBlockText, tripBlockText, goingText, tripText, trackIsTemplate ? null : trackBlockText, trackText);
    if (resp.status !== 200 || !resp.json || !Array.isArray(resp.json.content)) return { httpError: 'HTTP ' + resp.status + ' ' + (resp.raw || '').slice(0, 200) };
    usage2 = addUsage(usage2, usageFrom(resp.json));
    const parsed = parseGoingTripSecondCheck(resp);
    if (!parsed) return { noToolCall: true, debug: 'content: ' + JSON.stringify(resp.json.content).slice(0, 400) + ' [stop_reason=' + resp.json.stop_reason + ']' };
    // Fix 3 — drop any problem whose own reasoning concludes the sentence
    // is supported after all; log what got dropped for audit.
    const filtered = filterSelfOverruled(parsed.problems || []);
    if (filtered.dropped.length) {
      await appendTelemetry(date, filtered.dropped.map(function(p) {
        return { date: date, ts: new Date().toISOString(), horseName: h.name, horse_id: h.horse_id, section: p.section, check: 'self-overruled-filtered', sentence: p.sentence, detail: p.reason, stage: 'secondCheck' };
      }));
    }
    return { supported: filtered.kept.length === 0, problems: filtered.kept };
  }
  async function secondCheck(goingText, tripText, trackText) {
    let r = await secondCheckAttempt(goingText, tripText, trackText);
    if (r.httpError) return { error: r.httpError };
    if (r.noToolCall) {
      r = await secondCheckAttempt(goingText, tripText, trackText);
      if (r.httpError) return { error: 'retry ' + r.httpError };
      if (r.noToolCall) return { error: 'no usable report_goingtrip_check tool call after retry — ' + r.debug };
    }
    return { supported: r.supported, problems: r.problems || [] };
  }

  // ── Pass 1: write, validate both texts, one retry (both) on a code failure ──
  let w = await write(envelope);
  if (w.error) return { horse_id: h.horse_id, horseName: h.name, storedGoing: false, storedTrip: false, storedTrack: false, attempt: 1, error: w.error, usage: usage, usage2: usage2, windowInfo: win };
  // Cache probe support — a snapshot of usage right after this one call, so
  // a caller can inspect cache_creation_input_tokens/cache_read_input_tokens
  // on this horse's FIRST write call specifically, unaffected by any retry
  // or second-check usage added later.
  const firstWriteUsage = Object.assign({}, usage);
  let vG = F.validateGoing(w.text, goingBlock);
  let vT = F.validateTrip(w.text, tripData);
  let vK = trackIsTemplate ? { ok: true, track: null } : F.validateTrack(w.text, trackData);
  let attempt = 1;
  const codeCheckFirstFailures = { going: vG.ok ? null : vG.failures, trip: vT.ok ? null : vT.failures, track: (trackIsTemplate || vK.ok) ? null : vK.failures };
  await appendTelemetry(date, []
    .concat(telemetryFromFailures(h, date, 'going', codeCheckFirstFailures.going, 'write1'))
    .concat(telemetryFromFailures(h, date, 'trip', codeCheckFirstFailures.trip, 'write1', tripStaminaLinesText))
    .concat(telemetryFromFailures(h, date, 'track', codeCheckFirstFailures.track, 'write1')));

  if (!vG.ok || !vT.ok || (!trackIsTemplate && !vK.ok)) {
    const notes = [];
    if (!vG.ok) notes.push('GOING:\n' + vG.failures.map(function(x) { return '- ' + x.check + (x.detail ? ': "' + x.detail + '"' : ''); }).join('\n'));
    if (!vT.ok) notes.push('TRIP:\n' + vT.failures.map(function(x) { return '- ' + x.check + (x.detail ? ': "' + x.detail + '"' : ''); }).join('\n'));
    if (!trackIsTemplate && !vK.ok) notes.push('TRACK:\n' + vK.failures.map(function(x) { return '- ' + x.check + (x.detail ? ': "' + x.detail + '"' : ''); }).join('\n'));
    const retryText = envelope + '\n\nPREVIOUS ATTEMPT FAILED VALIDATION — every claim is checked in code against the data above. Failures:\n' + notes.join('\n') + '\nRewrite going, trip and track (whichever are listed above) so every position, going or distance name, course and count appears in the data exactly, with no new claims, staying inside the word limit.';
    w = await write(retryText);
    attempt = 2;
    if (w.error) return { horse_id: h.horse_id, horseName: h.name, storedGoing: false, storedTrip: false, storedTrack: false, attempt: 2, codeCheckFirstFailures: codeCheckFirstFailures, error: 'retry ' + w.error, usage: usage, usage2: usage2, firstWriteUsage: firstWriteUsage, windowInfo: win };
    vG = F.validateGoing(w.text, goingBlock);
    vT = F.validateTrip(w.text, tripData);
    vK = trackIsTemplate ? { ok: true, track: null } : F.validateTrack(w.text, trackData);
    if (!vG.ok || !vT.ok || (!trackIsTemplate && !vK.ok)) {
      const codeCheckRetryFailures = { going: vG.ok ? null : vG.failures, trip: vT.ok ? null : vT.failures, track: (trackIsTemplate || vK.ok) ? null : vK.failures };
      await appendTelemetry(date, []
        .concat(telemetryFromFailures(h, date, 'going', codeCheckRetryFailures.going, 'retry'))
        .concat(telemetryFromFailures(h, date, 'trip', codeCheckRetryFailures.trip, 'retry', tripStaminaLinesText))
        .concat(telemetryFromFailures(h, date, 'track', codeCheckRetryFailures.track, 'retry')));
      return { horse_id: h.horse_id, horseName: h.name, storedGoing: false, storedTrip: false, storedTrack: false, attempt: 2, codeCheckFirstFailures: codeCheckFirstFailures, codeCheckRetryFailures: codeCheckRetryFailures, usage: usage, usage2: usage2, firstWriteUsage: firstWriteUsage, windowInfo: win };
    }
  }

  // All passed the code checker on `attempt`. Track's text is the fixed
  // template when trackIsTemplate — never model-written, never second-
  // checked, same as Going/Trip's own win.size === 0 template path.
  let goingText = vG.going, tripText = vT.trip;
  let trackText = trackIsTemplate ? F.NO_RUNS_TRACK_TEMPLATE : vK.track;

  const sc1 = await secondCheck(goingText, tripText, trackIsTemplate ? null : trackText);
  if (sc1.error) return { horse_id: h.horse_id, horseName: h.name, storedGoing: false, storedTrip: false, storedTrack: false, attempt: attempt, codeCheckFirstFailures: codeCheckFirstFailures, error: 'second check ' + sc1.error, usage: usage, usage2: usage2, firstWriteUsage: firstWriteUsage, windowInfo: win };
  if (sc1.supported) {
    await storeGoingTrip(h, win, goingText, tripText, trackText);
    return { horse_id: h.horse_id, horseName: h.name, storedGoing: true, storedTrip: true, storedTrack: true, template: false, attempt: attempt, usage: usage, usage2: usage2, firstWriteUsage: firstWriteUsage, wordCount: { going: vG.wordCount, trip: vT.wordCount, track: trackIsTemplate ? null : vK.wordCount }, cacheRead: usage.cacheRead > 0, codeCheckFirstFailures: codeCheckFirstFailures, secondCheckFirstSupported: true, windowInfo: win };
  }

  // Second check found unsupported statements — rewrite ONLY the section(s)
  // named in problems, keeping the other (already-passing) text fixed, then
  // re-check once. Whichever section still fails after that gets nothing
  // stored for it; the other is stored if it passed.
  const problems = sc1.problems || [];
  await appendTelemetry(date, telemetryFromProblems(h, date, problems, 'secondCheck1'));
  const goingProblems = problems.filter(function(p) { return p.section === 'going'; });
  const tripProblems = problems.filter(function(p) { return p.section === 'trip'; });
  // Track build — trackIsTemplate horses never had a TRACK paragraph in the
  // second check at all, so sc1.problems could never name section:'track'
  // for them; forcing trackProblems empty keeps every branch below treating
  // trackText as fixed and untouched, same as the template path throughout.
  const trackProblems = trackIsTemplate ? [] : problems.filter(function(p) { return p.section === 'track'; });

  const notes2 = [];
  if (goingProblems.length) notes2.push('GOING — unsupported: ' + goingProblems.map(function(p) { return '"' + p.sentence + '": ' + p.reason; }).join('; '));
  if (tripProblems.length) notes2.push('TRIP — unsupported: ' + tripProblems.map(function(p) { return '"' + p.sentence + '": ' + p.reason; }).join('; '));
  if (trackProblems.length) notes2.push('TRACK — unsupported: ' + trackProblems.map(function(p) { return '"' + p.sentence + '": ' + p.reason; }).join('; '));
  const keepNotes = [];
  if (!goingProblems.length) keepNotes.push('CURRENT GOING TEXT (keep this exactly, do not change it): ' + goingText);
  if (!tripProblems.length) keepNotes.push('CURRENT TRIP TEXT (keep this exactly, do not change it): ' + tripText);
  if (!trackIsTemplate && !trackProblems.length) keepNotes.push('CURRENT TRACK TEXT (keep this exactly, do not change it): ' + trackText);
  const regenText = envelope + '\n\nA checker found these unsupported statements:\n' + notes2.join('\n') + '\nRewrite only the section(s) with unsupported statements, using only what the data shows. Return the full JSON with going, trip and track.' + (keepNotes.length ? '\n\n' + keepNotes.join('\n') : '');
  const regenAttempt = attempt + 1;

  w = await write(regenText);
  if (w.error) {
    // Could not even get a rewrite — keep whichever side had no problems,
    // store nothing for the side that was unsupported. Track keeps its
    // fixed template regardless (never rewritten, never dropped).
    const finalGoing = goingProblems.length ? null : goingText;
    const finalTrip = tripProblems.length ? null : tripText;
    const finalTrack = trackIsTemplate ? trackText : (trackProblems.length ? null : trackText);
    await storeGoingTrip(h, win, finalGoing, finalTrip, finalTrack);
    return { horse_id: h.horse_id, horseName: h.name, storedGoing: !!finalGoing, storedTrip: !!finalTrip, storedTrack: !!finalTrack, attempt: regenAttempt, codeCheckFirstFailures: codeCheckFirstFailures, secondCheckFirstSupported: false, secondCheckFirstProblems: problems, error: 'regen ' + w.error, usage: usage, usage2: usage2, firstWriteUsage: firstWriteUsage, windowInfo: win };
  }

  const vG2 = F.validateGoing(w.text, goingBlock);
  const vT2 = F.validateTrip(w.text, tripData);
  const vK2 = trackIsTemplate ? { ok: true, track: null } : F.validateTrack(w.text, trackData);
  await appendTelemetry(date, []
    .concat(telemetryFromFailures(h, date, 'going', goingProblems.length && !vG2.ok ? vG2.failures : null, 'regenCodeCheck'))
    .concat(telemetryFromFailures(h, date, 'trip', tripProblems.length && !vT2.ok ? vT2.failures : null, 'regenCodeCheck', tripStaminaLinesText))
    .concat(telemetryFromFailures(h, date, 'track', (!trackIsTemplate && trackProblems.length && !vK2.ok) ? vK2.failures : null, 'regenCodeCheck')));
  // Only trust the rewrite for a section that actually had a problem; the
  // other section keeps its already-passing text regardless of what the
  // model returned for it this time. Track keeps its fixed template when
  // trackIsTemplate, same rule.
  let candidateGoing = goingProblems.length ? (vG2.ok ? vG2.going : null) : goingText;
  let candidateTrip = tripProblems.length ? (vT2.ok ? vT2.trip : null) : tripText;
  let candidateTrack = trackIsTemplate ? trackText : (trackProblems.length ? (vK2.ok ? vK2.track : null) : trackText);

  let finalGoing = candidateGoing, finalTrip = candidateTrip, finalTrack = candidateTrack;
  let sc2Supported = null, sc2Problems = null;
  if (candidateGoing && candidateTrip) {
    const trackForCheck = (!trackIsTemplate && candidateTrack) ? candidateTrack : null;
    const sc2 = await secondCheck(candidateGoing, candidateTrip, trackForCheck);
    if (sc2.error) {
      // Can't confirm the rewrite — be safe and store nothing for the
      // section(s) that were being rewritten.
      finalGoing = goingProblems.length ? null : candidateGoing;
      finalTrip = tripProblems.length ? null : candidateTrip;
      finalTrack = trackIsTemplate ? candidateTrack : (trackProblems.length ? null : candidateTrack);
    } else {
      sc2Supported = sc2.supported; sc2Problems = sc2.problems;
      await appendTelemetry(date, telemetryFromProblems(h, date, sc2Problems, 'secondCheckRegen'));
      const stillBadGoing = sc2.supported === false && sc2.problems.some(function(p) { return p.section === 'going'; });
      const stillBadTrip = sc2.supported === false && sc2.problems.some(function(p) { return p.section === 'trip'; });
      const stillBadTrack = sc2.supported === false && sc2.problems.some(function(p) { return p.section === 'track'; });
      finalGoing = stillBadGoing ? null : candidateGoing;
      finalTrip = stillBadTrip ? null : candidateTrip;
      finalTrack = trackIsTemplate ? candidateTrack : (trackForCheck ? (stillBadTrack ? null : candidateTrack) : null);
    }
  }
  // If either candidate came back null from the code check above (the
  // targeted rewrite itself failed validateGoing/validateTrip/validateTrack),
  // there is nothing to second-check for that side — it simply stores nothing.

  await storeGoingTrip(h, win, finalGoing, finalTrip, finalTrack);
  return {
    horse_id: h.horse_id, horseName: h.name, storedGoing: !!finalGoing, storedTrip: !!finalTrip, storedTrack: !!finalTrack,
    template: false, attempt: regenAttempt, usage: usage, usage2: usage2, firstWriteUsage: firstWriteUsage, cacheRead: usage.cacheRead > 0,
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
      // Probe support — ?horseIds=comma,separated,ids restricts this run to
      // exactly those horses (e.g. a pre-selected sample spread across
      // meetings), unlike ?sample=N's own random pick from every eligible
      // horse. Only applied on a fresh start (hop 0); a chained hop's
      // `remaining` already reflects it — same rule as ?sample=N below.
      if (qs.horseIds) {
        const wanted = {};
        String(qs.horseIds).split(',').map(function(s) { return s.trim(); }).filter(Boolean).forEach(function(id) { wanted[id] = true; });
        remaining = remaining.filter(function(h) { return wanted[h.horse_id]; });
      }
      // Sample-run support — ?sample=N limits this run to N horses spread
      // across every meeting, not the full card. Only applied on a fresh
      // start (hop 0); a chained hop's `remaining` already reflects it.
      if (qs.sample) remaining = sampleAcrossMeetings(remaining, parseInt(qs.sample, 10) || remaining.length);
      results = []; templated = 0; bothGenerated = 0; partialGenerated = 0; failed = [];
      usage = { input: 0, output: 0, cacheWrite: 0, cacheRead: 0 };
      usage2 = { input: 0, output: 0, cacheWrite: 0, cacheRead: 0 };
      cacheReadCount = 0; firstPassFailCount = 0; secondCheckFailCount = 0; regeneratedCount = 0; passedFirstTimeCount = 0;
      console.log('[form-sections:goingtrip]', remaining.length, 'eligible horses for', date, qs.sample ? '(sampled to ' + qs.sample + ')' : '');
    }

    // ?costCap=X overrides the default $9 hard cap for this run only.
    const costCap = qs.costCap ? (parseFloat(qs.costCap) || GOINGTRIP_COST_CAP_USD) : GOINGTRIP_COST_CAP_USD;
    const totalEligible = (state && state.totalEligible) || remaining.length + results.length;
    let timedOut = false, costCapped = false, costAtStop = 0;
    let cacheProbeChecked = false, cacheProbeFailed = false, cacheProbeDetail = null;

    while (remaining.length) {
      if (Date.now() - startTime > TIMEOUT_MS) { timedOut = true; break; }
      const chunk = remaining.slice(0, CONCURRENCY);
      const settled = await Promise.all(chunk.map(function(h) { return processHorseGoingTrip(h, date).catch(function(e) { return { horse_id: h.horse_id, horseName: h.name, storedGoing: false, storedTrip: false, error: e.message, usage: { input: 0, output: 0, cacheWrite: 0, cacheRead: 0 }, usage2: { input: 0, output: 0, cacheWrite: 0, cacheRead: 0 } }; }); }));
      settled.forEach(function(r) {
        const emptyUsage = { input: 0, output: 0, cacheWrite: 0, cacheRead: 0 };
        results.push({
          horse_id: r.horse_id, horseName: r.horseName, storedGoing: !!r.storedGoing, storedTrip: !!r.storedTrip, storedTrack: !!r.storedTrack, template: !!r.template, attempt: r.attempt,
          wordCount: r.wordCount || null, firstWriteUsage: r.firstWriteUsage || emptyUsage,
          codeCheckFirstFailures: r.codeCheckFirstFailures || null, codeCheckRetryFailures: r.codeCheckRetryFailures || null,
          secondCheckFirstSupported: r.secondCheckFirstSupported === undefined ? null : r.secondCheckFirstSupported,
          secondCheckFirstProblems: r.secondCheckFirstProblems || null,
          secondCheckSecondSupported: r.secondCheckSecondSupported === undefined ? null : r.secondCheckSecondSupported,
          secondCheckSecondProblems: r.secondCheckSecondProblems || null,
          regenerated: !!r.regenerated
        });
        usage = addUsage(usage, r.usage || emptyUsage);
        usage2 = addUsage(usage2, r.usage2 || emptyUsage);
        // Track build — bothGenerated/partialGenerated now require/count
        // storedTrack alongside storedGoing/storedTrip ("coverage ... treat
        // track exactly as the other two sections"); the field names
        // (bothGenerated, partialGenerated) are kept as-is per "the mode
        // string stays goingtrip" — only their meaning now spans all three.
        if (r.template) templated++;
        else if (r.storedGoing && r.storedTrip && r.storedTrack) {
          bothGenerated++;
          if (r.cacheRead) cacheReadCount++;
          // Fix (30-horse probe) — codeCheckFirstFailures is always a
          // truthy {going,trip,track} object (even when every sub-field is
          // null), so `!r.codeCheckFirstFailures` was always false and this
          // counter never incremented. Check the sub-fields instead.
          const hadCodeCheckFail = r.codeCheckFirstFailures && (r.codeCheckFirstFailures.going || r.codeCheckFirstFailures.trip || r.codeCheckFirstFailures.track);
          if (!hadCodeCheckFail && r.secondCheckFirstSupported) passedFirstTimeCount++;
        } else if (r.storedGoing || r.storedTrip || r.storedTrack) {
          partialGenerated++;
          if (r.cacheRead) cacheReadCount++;
        } else {
          failed.push({ horse_id: r.horse_id, horseName: r.horseName, error: r.error || null, codeCheckFirstFailures: r.codeCheckFirstFailures || null, codeCheckRetryFailures: r.codeCheckRetryFailures || null, secondCheckFirstProblems: r.secondCheckFirstProblems || null, secondCheckSecondProblems: r.secondCheckSecondProblems || null });
        }
        if (r.codeCheckFirstFailures && (r.codeCheckFirstFailures.going || r.codeCheckFirstFailures.trip || r.codeCheckFirstFailures.track)) firstPassFailCount++;
        if (r.secondCheckFirstSupported === false) secondCheckFailCount++;
        if (r.regenerated) regeneratedCount++;
      });
      remaining = remaining.slice(CONCURRENCY);

      // Cache probe (?cacheProbe=1) — CONCURRENCY is 3, so the first chunk
      // (horses 1-3) fires all 3 calls simultaneously via Promise.all: none
      // of them can read a cache the others haven't finished writing yet,
      // so only the SECOND chunk onward (horses 4+, which only starts after
      // chunk 1 fully completes) can empirically prove a cache read. Check
      // as soon as that second chunk has landed (results.length >= 6).
      if (qs.cacheProbe === '1' && !cacheProbeChecked && results.length >= 6) {
        cacheProbeChecked = true;
        const chunk2 = results.slice(3, 6);
        const anyCacheRead = chunk2.some(function(r) { return r.firstWriteUsage && r.firstWriteUsage.cacheRead > 0; });
        cacheProbeDetail = { chunk1FirstCallUsage: results[0].firstWriteUsage, chunk2Usages: chunk2.map(function(r) { return { horse_id: r.horse_id, firstWriteUsage: r.firstWriteUsage }; }) };
        if (!anyCacheRead) {
          cacheProbeFailed = true;
          break;
        }
      }

      costAtStop = costOf(usage) + costOf(usage2);
      if (costAtStop >= costCap) { costCapped = true; break; }
    }

    if (cacheProbeFailed) {
      remaining.forEach(function(h) { failed.push({ horse_id: h.horse_id, horseName: h.name, error: 'not processed — cache probe failed, run stopped' }); });
      const coverage = {
        date: date, completedAt: new Date().toISOString(), totalEligible: totalEligible,
        templated: templated, bothGenerated: bothGenerated, partialGenerated: partialGenerated,
        passedFirstTime: passedFirstTimeCount, failedCount: failed.length, failed: failed, results: results,
        usage: usage, costUSD: costOf(usage), usage2: usage2, cost2USD: costOf(usage2),
        totalCostUSD: +(costOf(usage) + costOf(usage2)).toFixed(4), hops: hop + 1, pricing: PRICE,
        cacheProbeFailed: true, cacheProbeDetail: cacheProbeDetail, remainingAtStop: remaining.length
      };
      await E.redisSet('form-sections:coverage:goingtrip:' + date, coverage);
      await E.redisSet('form-sections:goingtrip:worklist:' + date, null);
      try { await E.redisSet('form-sections:goingtrip:lock:' + date, null); } catch (ue) {}
      console.log('[form-sections:goingtrip] CACHE PROBE FAILED — stopping.', JSON.stringify(cacheProbeDetail));
      return { statusCode: 200, headers, body: JSON.stringify({ status: 'cache_probe_failed', coverage: coverage }) };
    }

    if (costCapped) {
      remaining.forEach(function(h) { failed.push({ horse_id: h.horse_id, horseName: h.name, error: 'not processed — goingtrip hard cost cap ($' + costCap.toFixed(2) + ') reached at $' + costAtStop.toFixed(4) }); });
      const coverage = {
        date: date, completedAt: new Date().toISOString(), totalEligible: totalEligible,
        templated: templated, bothGenerated: bothGenerated, partialGenerated: partialGenerated,
        passedFirstTime: passedFirstTimeCount, failedCount: failed.length, failed: failed, results: results,
        retriedCount: firstPassFailCount, secondCheckFailCount: secondCheckFailCount, regeneratedCount: regeneratedCount,
        cacheReadCalls: cacheReadCount, cacheActive: cacheReadCount > 0,
        usage: usage, costUSD: costOf(usage), usage2: usage2, cost2USD: costOf(usage2),
        totalCostUSD: +costAtStop.toFixed(4), hops: hop + 1, pricing: PRICE,
        costCapped: true, costCapUSD: costCap, remainingAtStop: remaining.length
      };
      await E.redisSet('form-sections:coverage:goingtrip:' + date, coverage);
      await E.redisSet('form-sections:goingtrip:worklist:' + date, null);
      try { await E.redisSet('form-sections:goingtrip:lock:' + date, null); } catch (ue) {}
      console.log('[form-sections:goingtrip] COST CAP REACHED', JSON.stringify({ date: date, costAtStop: costAtStop, remaining: remaining.length }));
      return { statusCode: 200, headers, body: JSON.stringify({ status: 'cost_capped', coverage: coverage }) };
    }

    if (timedOut && remaining.length) {
      if (hop < HOP_CAP) {
        await E.redisSet('form-sections:goingtrip:worklist:' + date, { remaining: remaining, results: results, templated: templated, bothGenerated: bothGenerated, partialGenerated: partialGenerated, failed: failed, usage: usage, usage2: usage2, cacheReadCount: cacheReadCount, firstPassFailCount: firstPassFailCount, secondCheckFailCount: secondCheckFailCount, regeneratedCount: regeneratedCount, passedFirstTimeCount: passedFirstTimeCount, totalEligible: totalEligible });
        try { await E.redisSet('form-sections:goingtrip:lock:' + date, null); } catch (ue) {}
        console.log('[form-sections:goingtrip] approaching timeout at hop', hop, '—', remaining.length, 'horse(s) still queued, chaining hop', hop + 1);
        await new Promise(function(resolve) {
          const req = https.request({
            hostname: HOSTNAME, path: '/.netlify/functions/form-sections-run-background?date=' + date + '&section=goingtrip&hop=' + (hop + 1) + (qs.costCap ? '&costCap=' + encodeURIComponent(qs.costCap) : '') + (qs.cacheProbe ? '&cacheProbe=' + encodeURIComponent(qs.cacheProbe) : '') + (qs.horseIds ? '&horseIds=' + encodeURIComponent(qs.horseIds) : ''),
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
