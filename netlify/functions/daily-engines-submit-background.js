const https = require('https');
const nodemailer = require('nodemailer');

// Daily engines — SUBMIT. Runs once a day at 11:30 Irish time, fired by
// daily-engines-submit-trigger.js (which carries the cron and POSTs here with
// x-build-secret; a schedule on a -background function never fires — see
// form-summary-background.js).
//
// 1. newDate = today + 6 (Europe/Dublin): the date that entered the 7-day
//    window via last night's fetch-future-cards.
// 2. goingtrip batch for newDate — form-sections-run-background ?mode=batch.
// 3. trainer-history batch for the whole window (today .. today+6) —
//    trainer-history-v2-background ?mode=batch&dates=. Its skip rule means
//    only horses that have run since their record was written are
//    submitted; everything else skips free.
// 4. batch:daily:{today} records both batchIds and counts for the collector
//    (daily-engines-collect-background.js), which sends the one daily email.
//
// The engines are invoked IN-PROCESS — their exported handler is called with
// a synthetic secret-bearing event — not over HTTP. Over HTTP a -background
// function answers 202 with an empty body before it has done anything, so
// the batchId would be unobtainable; in-process the handler's real return
// value (status, batchId, submitted, templated/skipped) comes straight back.
// It is the same code path either way: the engines' own ?mode=batch branch.
//
// A submission failure (API, credit, anything) emails immediately and stops.
module.exports.config = { timeout: 900 };

const UPSTASH_URL = process.env.UPSTASH_REDIS_REST_URL;
const UPSTASH_TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN;
const EMAIL_TO = 'gcoyne87@gmail.com';

const goingTripEngine = require('./form-sections-run-background.js');
const trainerEngine = require('./trainer-history-v2-background.js');

function redisGet(key) {
  const url = new URL(UPSTASH_URL);
  return new Promise(function(resolve) {
    const req = https.request({
      hostname: url.hostname, path: '/get/' + encodeURIComponent(key), method: 'GET',
      headers: { Authorization: 'Bearer ' + UPSTASH_TOKEN }
    }, function(res) {
      let d = ''; res.on('data', function(c) { d += c; });
      res.on('end', function() { try { const r = JSON.parse(d); resolve(r.result ? JSON.parse(r.result) : null); } catch (e) { resolve(null); } });
    });
    req.on('error', function() { resolve(null); });
    req.end();
  });
}

function redisSet(key, value) {
  const url = new URL(UPSTASH_URL);
  const body = JSON.stringify(value);
  return new Promise(function(resolve, reject) {
    const req = https.request({
      hostname: url.hostname, path: '/set/' + encodeURIComponent(key), method: 'POST',
      headers: { Authorization: 'Bearer ' + UPSTASH_TOKEN, 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) }
    }, function(res) {
      let d = ''; res.on('data', function(c) { d += c; });
      res.on('end', function() {
        if (res.statusCode !== 200) return reject(new Error('Redis write failed: HTTP ' + res.statusCode + ' ' + d));
        try { const parsed = JSON.parse(d); if (parsed && parsed.error) return reject(new Error('Redis write error: ' + parsed.error)); } catch (e) {}
        resolve(d);
      });
    });
    req.on('error', reject);
    req.write(body); req.end();
  });
}

// How many of the given keys exist — one pipelined EXISTS round trip per 150
// keys. Used for the history-readiness test; a pipeline failure counts as 0
// present, which can only make a date look NOT ready (never falsely ready).
function redisExistsCount(keys) {
  const url = new URL(UPSTASH_URL);
  const chunks = []; for (let i = 0; i < keys.length; i += 150) chunks.push(keys.slice(i, i + 150));
  return chunks.reduce(function(p, chunk) {
    return p.then(function(total) {
      return new Promise(function(resolve) {
        const body = JSON.stringify(chunk.map(function(k) { return ['EXISTS', k]; }));
        const req = https.request({
          hostname: url.hostname, path: '/pipeline', method: 'POST',
          headers: { Authorization: 'Bearer ' + UPSTASH_TOKEN, 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) }
        }, function(res) {
          let d = ''; res.on('data', function(c) { d += c; });
          res.on('end', function() { try { const arr = JSON.parse(d); resolve(total + (Array.isArray(arr) ? arr.filter(function(x) { return x && x.result; }).length : 0)); } catch (e) { resolve(total); } });
        });
        req.on('error', function() { resolve(total); });
        req.write(body); req.end();
      });
    });
  }, Promise.resolve(0));
}

// Distinct non-NR horse_ids on a stored racecard — the same eligibility the
// engines' own eligibleHorses() applies.
function cardHorseIds(card) {
  const seen = {}; const ids = [];
  (card && Array.isArray(card.meetings) ? card.meetings : []).forEach(function(m) {
    (m.races || []).forEach(function(race) {
      (race.runners || []).forEach(function(ru) {
        if (!ru || !ru.horse_id || seen[ru.horse_id]) return;
        if (ru.nonRunner === true || ru.price === 'NR') return;
        seen[ru.horse_id] = true; ids.push(ru.horse_id);
      });
    });
  });
  return ids;
}

// Same transport and recipient as the daily-build report email.
async function sendEmail(subject, text) {
  try {
    const transporter = nodemailer.createTransport({ service: 'gmail', auth: { user: process.env.GMAIL_USER, pass: process.env.GMAIL_APP_PASSWORD } });
    await transporter.sendMail({ from: process.env.GMAIL_USER, to: EMAIL_TO, subject: subject, text: text });
    return true;
  } catch (e) {
    console.log('[daily-engines-submit] email failed: ' + e.message);
    return false;
  }
}

function irishNow(d) {
  // year/month/day must be requested explicitly — once hour/minute options
  // are given, Intl drops the date parts from formatToParts entirely.
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Dublin', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false }).formatToParts(d || new Date());
  const get = function(type) { return (parts.find(function(p) { return p.type === type; }) || {}).value || ''; };
  let hour = parseInt(get('hour'), 10); if (hour === 24) hour = 0;
  return { date: get('year') + '-' + get('month') + '-' + get('day'), hour: hour, minute: parseInt(get('minute'), 10) };
}
function addDays(dateStr, n) {
  const d = new Date(dateStr + 'T12:00:00Z');
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

// In-process call of an engine handler. Returns { statusCode, body } with
// body already parsed; a thrown error is folded into the same shape.
async function callEngine(handler, query) {
  try {
    const r = await handler({ httpMethod: 'POST', headers: { 'x-build-secret': process.env.BUILD_SECRET || '' }, queryStringParameters: query });
    let body = null; try { body = JSON.parse(r && r.body || 'null'); } catch (e) { body = { error: 'unparseable engine response: ' + String(r && r.body || '').slice(0, 200) }; }
    return { statusCode: (r && r.statusCode) || 0, body: body || {} };
  } catch (e) {
    return { statusCode: 0, body: { error: e.message } };
  }
}

// One engine submission -> { batchId, submitted, extra } or throws the
// engine's own error text. nothing_to_submit (no racing / all skipped) is
// a clean zero, not an error.
async function submitEngine(label, handler, query, worklistKey) {
  const stale = await redisGet(worklistKey);
  if (stale) throw new Error(label + ': a worklist is already present at ' + worklistKey + ' — a live run is in progress or was left mid-flight; refusing to submit');
  const r = await callEngine(handler, query);
  const b = r.body || {};
  if (b.status === 'batch_submitted') return { batchId: b.batchId, submitted: b.submitted || 0, status: 'submitted', templated: b.templated || 0, skipped: b.skipped || 0, noData: b.noData || 0 };
  if (b.status === 'nothing_to_submit') return { batchId: null, submitted: 0, status: 'nothing_to_submit', templated: b.templated || 0, skipped: b.skipped || 0, noData: b.noData || 0 };
  throw new Error(label + ': ' + (b.error || b.reason || ('unexpected engine response HTTP ' + r.statusCode + ' ' + JSON.stringify(b).slice(0, 300))));
}

function failureBody(date, newDate, failedEngine, error, goingtrip) {
  const lines = [
    'Racing Edge daily engines — ' + date,
    '',
    'SUBMISSION FAILED — ' + failedEngine,
    'Error: ' + error,
    ''
  ];
  if (failedEngine === 'goingtrip') {
    lines.push('Nothing was submitted. The goingtrip batch for ' + newDate + ' was not created and the trainer history batch was not attempted.');
  } else if (goingtrip && goingtrip.batchId) {
    lines.push('The trainer history batch was not created.');
    lines.push('The goingtrip batch for ' + newDate + ' WAS submitted before this failure — batchId ' + goingtrip.batchId + ' (' + goingtrip.submitted + ' horses). Collect it manually with form-sections-run-background?collect=' + goingtrip.batchId + ' — the collector will not run for today because batch:daily is marked failed.');
  } else {
    lines.push('Nothing was submitted: the goingtrip batch had no eligible horses and the trainer history batch was not created.');
  }
  return lines.join('\n');
}

exports.handler = async function(event) {
  const headers = { 'Content-Type': 'application/json' };
  const qs = (event && event.queryStringParameters) || {};
  const isScheduled = !event.httpMethod;
  if (!isScheduled) {
    const secret = qs.secret || (event.headers && event.headers['x-build-secret']);
    if (secret !== process.env.BUILD_SECRET) return { statusCode: 401, headers, body: JSON.stringify({ error: 'Unauthorised' }) };
  }
  const force = qs.force === '1';

  // Window guard — 11:15-12:15 Irish. The trigger's cron is UTC and fires at
  // both 10:30 and 11:30 UTC so one fire lands here in summer (IST) and the
  // other in winter (GMT); the one outside the window exits.
  const now = irishNow();
  const inWindow = (now.hour === 11 && now.minute >= 15) || (now.hour === 12 && now.minute <= 15);
  if (!force && !inWindow) {
    console.log('[daily-engines-submit] skipped — ' + now.date + ' ' + now.hour + ':' + String(now.minute).padStart(2, '0') + ' Irish is outside 11:15-12:15');
    return { statusCode: 200, headers, body: JSON.stringify({ skipped: true, reason: 'outside Irish 11:15-12:15 window', irishNow: now }) };
  }

  const today = now.date;
  const windowDates = []; for (let i = 0; i <= 6; i++) windowDates.push(addDays(today, i));
  const key = 'batch:daily:' + today;

  const existing = await redisGet(key);
  if (existing && !force) {
    console.log('[daily-engines-submit] skipped — ' + key + ' already exists (status ' + existing.status + ')');
    return { statusCode: 200, headers, body: JSON.stringify({ skipped: true, reason: 'already submitted today', status: existing.status }) };
  }

  // 1. The new card date — resolved from the data, not assumed. Both engines
  // read form:history:{horse}:{date}; a horse with no history rows is
  // TEMPLATED by goingtrip and given a no-data marker by trainer history, so
  // a date whose history has not been pre-warmed yet would be written up as
  // "no recent runs" for every runner. fetch-horse-history warms today+1..+3
  // each night, while racecards reach ~today+5, so the furthest date that is
  // safe to generate is the furthest window date that (a) has a racecard,
  // (b) is history-ready — at least 90% of its runners have a form:history
  // key — and (c) has not had a goingtrip run yet: neither this job's own
  // marker (batch:daily:goingtrip-date:{date}) nor a live run's coverage
  // key. Normally exactly one date qualifies; a missed day self-heals the
  // next morning. None -> nothing to submit. The same readiness test picks
  // the dates the trainer sweep is allowed to cover.
  const readiness = {}; // date -> { horses, withHistory, ready }
  for (const d of windowDates) {
    const card = await redisGet('racecards:' + d);
    const ids = cardHorseIds(card);
    const withHistory = ids.length ? await redisExistsCount(ids.map(function(id) { return 'form:history:' + id + ':' + d; })) : 0;
    readiness[d] = { horses: ids.length, withHistory: withHistory, ready: ids.length > 0 && withHistory / ids.length >= 0.9 };
  }
  const trainerDates = windowDates.filter(function(d) { return readiness[d].ready; });
  let newDate = null;
  for (let i = 6; i >= 0; i--) {
    const d = windowDates[i];
    if (!readiness[d].ready) continue;
    const marker = await redisGet('batch:daily:goingtrip-date:' + d);
    const coverage = await redisGet('form-sections:coverage:goingtrip:' + d);
    if (marker || coverage) continue;
    newDate = d; break;
  }
  console.log('[daily-engines-submit] START ' + new Date().toISOString() + ' today=' + today + ' newDate=' + (newDate || 'none') + ' trainerDates=' + (trainerDates.join(',') || 'none') + (force ? ' (forced)' : ''));
  console.log('[daily-engines-submit] history readiness ' + JSON.stringify(readiness));

  const record = {
    date: today, newDate: newDate, windowDates: windowDates, trainerDates: trainerDates, historyReadiness: readiness, submittedAt: null, status: 'submitting',
    goingtripBatchId: null, trainerBatchId: null, goingtripSubmitted: 0, trainerSubmitted: 0,
    goingtripTemplated: 0, trainerSkipped: 0, trainerNoData: 0,
    goingtripStatus: null, trainerStatus: null, collected: { goingtrip: false, trainer: false }, error: null
  };

  // 2. goingtrip for the new date (no new date -> clean zero, no error).
  let gt;
  try {
    if (!newDate) {
      gt = { batchId: null, submitted: 0, status: 'nothing_to_submit', templated: 0, skipped: 0, noData: 0 };
      console.log('[daily-engines-submit] goingtrip: no window date without a goingtrip run — nothing to submit');
    } else {
      gt = await submitEngine('goingtrip', goingTripEngine.handler, { mode: 'batch', date: newDate }, 'form-sections:goingtrip:worklist:' + newDate);
      await redisSet('batch:daily:goingtrip-date:' + newDate, { submittedAt: new Date().toISOString(), batchId: gt.batchId, status: gt.status, submitted: gt.submitted, templated: gt.templated, dailyKey: key });
    }
  } catch (e) {
    record.status = 'failed'; record.error = 'goingtrip: ' + e.message; record.submittedAt = new Date().toISOString();
    try { await redisSet(key, record); } catch (we) {}
    const sent = await sendEmail('Racing Edge daily engines FAILED — ' + today, failureBody(today, newDate, 'goingtrip', e.message, null));
    console.log('[daily-engines-submit] FAILED goingtrip: ' + e.message + ' (email ' + (sent ? 'sent' : 'NOT sent') + ')');
    return { statusCode: 500, headers, body: JSON.stringify(record) };
  }
  record.goingtripBatchId = gt.batchId; record.goingtripSubmitted = gt.submitted; record.goingtripTemplated = gt.templated; record.goingtripStatus = gt.status;
  if (gt.status === 'nothing_to_submit') record.collected.goingtrip = true;
  console.log('[daily-engines-submit] goingtrip ' + newDate + ': ' + gt.status + (gt.batchId ? ' ' + gt.batchId : '') + ' submitted=' + gt.submitted + ' templated=' + gt.templated);

  // 3. trainer history across the window — the history-ready dates only (a
  // horse's history is read from form:history:{horse}:{its date}; an
  // un-warmed date would hand every runner a no-data marker). The skip
  // rule then leaves everything already up to date untouched.
  let tr;
  try {
    if (!trainerDates.length) {
      tr = { batchId: null, submitted: 0, status: 'nothing_to_submit', templated: 0, skipped: 0, noData: 0 };
      console.log('[daily-engines-submit] trainer-history: no history-ready dates in the window — nothing to submit');
    } else {
      tr = await submitEngine('trainer-history', trainerEngine.handler, { mode: 'batch', dates: trainerDates.join(',') }, 'trainer-history-v2:worklist:' + trainerDates.join('+'));
    }
  } catch (e) {
    record.status = 'failed'; record.error = 'trainer-history: ' + e.message; record.submittedAt = new Date().toISOString();
    try { await redisSet(key, record); } catch (we) {}
    const sent = await sendEmail('Racing Edge daily engines FAILED — ' + today, failureBody(today, newDate, 'trainer-history', e.message, gt));
    console.log('[daily-engines-submit] FAILED trainer-history: ' + e.message + ' (email ' + (sent ? 'sent' : 'NOT sent') + ')');
    return { statusCode: 500, headers, body: JSON.stringify(record) };
  }
  record.trainerBatchId = tr.batchId; record.trainerSubmitted = tr.submitted; record.trainerSkipped = tr.skipped; record.trainerNoData = tr.noData; record.trainerStatus = tr.status;
  if (tr.status === 'nothing_to_submit') record.collected.trainer = true;
  console.log('[daily-engines-submit] trainer-history [' + trainerDates.join(',') + ']: ' + tr.status + (tr.batchId ? ' ' + tr.batchId : '') + ' submitted=' + tr.submitted + ' skipped=' + tr.skipped + ' noData=' + tr.noData);

  // 4. Record for the collector. Both engines with nothing to submit is a
  // valid quiet day — the collector sends the (all-zero) completion email.
  record.submittedAt = new Date().toISOString();
  record.status = 'submitted';
  await redisSet(key, record);
  console.log('[daily-engines-submit] DONE ' + new Date().toISOString());
  return { statusCode: 200, headers, body: JSON.stringify(record) };
};
