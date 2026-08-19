const https = require('https');
const nodemailer = require('nodemailer');

// No schedule here — deliberately. A schedule paired directly onto a
// -background function never actually fires (see form-summary-trigger.js,
// which now carries the '0 5,7,9 * * *' cron and POSTs here), and a function
// that IS scheduled rejects external HTTP triggers with a 403 at Netlify's
// edge — so the schedule must live on the trigger, not here.
module.exports.config = { timeout: 900 };

const USERNAME = process.env.RACING_API_USERNAME;
const PASSWORD = process.env.RACING_API_KEY;
const BASE_URL = 'api.theracingapi.com';
const AUTH = Buffer.from((USERNAME || '') + ':' + (PASSWORD || '')).toString('base64');

const UPSTASH_URL = process.env.UPSTASH_REDIS_REST_URL;
const UPSTASH_TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN;

const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;

function redisGet(key) {
  const url = new URL(UPSTASH_URL);
  return new Promise((resolve, reject) => {
    const req = https.request({
      hostname: url.hostname, path: '/get/' + encodeURIComponent(key), method: 'GET',
      headers: { 'Authorization': 'Bearer ' + UPSTASH_TOKEN }
    }, res => {
      let d = ''; res.on('data', c => d += c);
      res.on('end', () => {
        try { const r = JSON.parse(d); resolve(r.result ? JSON.parse(r.result) : null); }
        catch(e) { resolve(null); }
      });
    });
    req.on('error', () => resolve(null)); req.end();
  });
}

// Builds today + next 4 days (5 dates total) as Europe/Dublin calendar dates —
// using UTC-based Date methods here would drift a day off during BST, the
// same bug just fixed in racecards.js's irishTodayStr().
async function readRacecards() {
  const dates = [];
  for (let i = 0; i < 5; i++) {
    const d = new Date(Date.now() + i * 86400000);
    const parts = new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Dublin' }).formatToParts(d);
    const y = parts.find(p => p.type === 'year').value;
    const mo = parts.find(p => p.type === 'month').value;
    const dy = parts.find(p => p.type === 'day').value;
    dates.push(y + '-' + mo + '-' + dy);
  }

  const runners = [];
  const seen = new Set();

  for (const dateStr of dates) {
    const cached = await redisGet('racecards:' + dateStr);
    let countForDate = 0;

    if (cached && Array.isArray(cached.meetings)) {
      // racecards:{date} is already GB/IRE-only (mapRacecards filters by region
      // before storing), so every meeting here qualifies — no region check needed.
      cached.meetings.forEach(function(meeting) {
        (meeting.races || []).forEach(function(race) {
          (race.runners || []).forEach(function(r) {
            if (!r.horse_id) return;
            const dedupeKey = r.horse_id + '|' + dateStr;
            if (seen.has(dedupeKey)) return;
            seen.add(dedupeKey);
            runners.push({
              horse_id: r.horse_id,
              horseName: r.name || '',
              course: meeting.name || '',
              time: race.t || '',
              date: dateStr
            });
            countForDate++;
          });
        });
      });
    }

    console.log('[form-summary] readRacecards: ' + dateStr + ' -> ' + countForDate + ' runners');
  }

  return runners;
}

function apiGet(path) {
  return new Promise((resolve, reject) => {
    const options = {
      hostname: BASE_URL,
      path: path,
      method: 'GET',
      headers: {
        'Authorization': 'Basic ' + AUTH,
        'Accept': 'application/json'
      }
    };
    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try { resolve(JSON.parse(data)); }
        catch(e) { reject(new Error('Parse error: ' + data.substring(0, 200))); }
      });
    });
    req.on('error', reject);
    req.end();
  });
}

function formatFullDate(dateStr) {
  if (!dateStr) return '';
  const months = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
  const parts = String(dateStr).split('-');
  if (parts.length !== 3) return dateStr;
  const y = parts[0], m = parseInt(parts[1], 10) - 1, d = parseInt(parts[2], 10);
  return String(d).padStart(2, '0') + ' ' + (months[m] || '') + ' ' + y;
}

function compressClass(raceClass) {
  if (!raceClass) return '';
  const m = String(raceClass).match(/\d+/);
  return m ? 'C' + m[0] : String(raceClass);
}

function formatWeight(w) {
  // The API already returns this pre-formatted as "9-7" (stone-lbs) in r.weight —
  // no conversion needed. r.weight_lbs (raw lbs, e.g. "133") is a fallback only.
  if (w === undefined || w === null || w === '') return '';
  return String(w).trim();
}

function formatOR(o) {
  // Confirmed field name is "or", but it comes back as the literal string "–"
  // (en dash) when a horse has no official rating yet (young horses, maidens) —
  // that must render as blank, not "OR–". official_rating/ofr don't exist on
  // this endpoint at all, so there's no fallback chain needed here anymore.
  if (o === undefined || o === null || o === '') return '';
  const s = String(o).trim();
  if (!/^\d+$/.test(s)) return '';
  return 'OR' + s;
}

function compressLine(entry) {
  const pos = (entry.pos !== undefined && entry.pos !== null && entry.pos !== '') ? entry.pos : '-';
  return [
    formatFullDate(entry.date),
    entry.course || '',
    entry.dist || '',
    entry.going || '',
    compressClass(entry.class),
    pos + '/' + (entry.ran || 0),
    entry.wt || '',
    entry.or || ''
  ].join(' | ');
}

// Accepts one runner ({ horse_id, horseName, course, time, date }) from
// readRacecards()'s output. Cache-hit and live-fetch both return the same
// compressed-string shape so callClaude() never has to branch on it.
async function getFormHistory(runner) {
  const cacheKey = 'form:history:' + runner.horse_id + ':' + runner.date;
  const cached = await redisGet(cacheKey);
  if (cached && Array.isArray(cached) && cached.length) {
    // Cached shape is whatever fetch-horse-history-1/2-background.js already
    // wrote overnight — { date, course, dist, going, pos, ran, sp, jockey,
    // race_class }. That mapping never captured weight or official rating, AND
    // used the wrong field name race_class (the API's real field is "class"),
    // so class/weight/OR all come out blank on a cache hit. This is a
    // pre-existing bug in those older files, not introduced here — flagged to
    // fix separately, not touched in this change.
    return cached.map(compressLine).join('\n');
  }

  let data;
  try {
    data = await apiGet('/v1/horses/' + encodeURIComponent(runner.horse_id) + '/results?limit=6');
  } catch (e) {
    return null;
  }

  const results = (data && data.results) || [];
  if (!results.length) return null;

  const lines = results.map(function(race) {
    const r = (race.runners || []).find(function(x) { return x.horse_id === runner.horse_id; }) || {};
    return compressLine({
      date: race.date || '',
      course: race.course || '',
      dist: race.dist || '',
      going: race.going || '',
      class: race.class || '',
      pos: r.position || '-',
      ran: (race.runners || []).length || 0,
      wt: formatWeight(r.weight || r.weight_lbs),
      or: formatOR(r.or)
    });
  });

  return lines.join('\n');
}

function apiPost(hostname, path, headers, body) {
  const b = JSON.stringify(body);
  return new Promise((resolve, reject) => {
    const req = https.request({
      hostname, path, method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(b), ...headers }
    }, res => {
      let d = ''; res.on('data', c => d += c);
      res.on('end', () => {
        if (res.statusCode === 429) {
          reject(new Error('429: rate limited by ' + hostname + path));
          return;
        }
        try { resolve(JSON.parse(d)); } catch(e) { reject(new Error('Parse')); }
      });
    });
    req.on('error', reject); req.setTimeout(290000); req.write(b); req.end();
  });
}

// Accepts up to 10 runners ({ horse_id, horseName, course, time, date,
// formHistory }) from getFormHistory()'s output. Runners with no form history
// are skipped before the call — sending an empty/absent history section would
// just invite the model to invent facts, which rule 1 explicitly forbids.
async function callClaude(runners) {
  const usable = (runners || []).filter(function(r) {
    if (!r.formHistory) {
      console.log('[form-summary] callClaude: skipping ' + (r.horseName || r.horse_id) + ' — no form history');
      return false;
    }
    return true;
  });

  if (!usable.length) {
    return { summaries: [], inputTokens: 0, outputTokens: 0 };
  }

  const systemPrompt = 'You are an expert horse racing analyst.';

  const horseBlocks = usable.map(function(r) {
    return 'HORSE: ' + r.horseName + ' | ' + r.course + ' ' + r.time + ' ' + r.date + '\n' + r.formHistory;
  }).join('\n\n');

  const userMessage = 'For each horse below, write one paragraph of form analysis based ' +
    'solely on its race history. Do not reference today\'s going or today\'s race — describe ' +
    'what the horse\'s form tells us about its preferences and profile.\n\n' +
    'Rules — every paragraph must follow all four:\n' +
    '1. Cite at least 2 specific facts from the horse\'s actual form — a specific date, course ' +
    'name, going description, finishing position, or official rating. Invented or vague facts ' +
    'are not acceptable.\n' +
    '2. Never use these phrases: should go close, respected, one to watch, cannot be discounted, ' +
    'each-way claims, if in the mood, hard to assess, eye-catching, promising, interesting, ' +
    'capable of better.\n' +
    '3. The opening three words of each paragraph must be different from every other paragraph ' +
    'in this batch.\n' +
    '4. If the form genuinely says little — few runs, no clear pattern — say so honestly in 2-3 ' +
    'sentences. Never pad.\n\n' +
    'Return in this exact format for each horse, nothing else:\n' +
    'HORSE: [horse name]\n' +
    'SUMMARY: [one paragraph]\n\n' +
    'Horses:\n' + horseBlocks;

  const resp = await apiPost('api.anthropic.com', '/v1/messages', {
    'x-api-key': ANTHROPIC_API_KEY,
    'anthropic-version': '2023-06-01'
  }, {
    model: 'claude-sonnet-4-6',
    max_tokens: 4000,
    system: systemPrompt,
    messages: [{ role: 'user', content: userMessage }]
  });

  const usage = resp.usage || {};
  const content = resp.content || [];
  const text = content.filter(function(b) { return b.type === 'text'; }).map(function(b) { return b.text; }).join('\n');

  // Matches "HORSE: <name>\nSUMMARY: <paragraph>" blocks, each summary running
  // until the next HORSE: marker or end of text.
  const summaries = [];
  const blockRe = /HORSE:\s*(.+?)\s*\nSUMMARY:\s*([\s\S]*?)(?=\nHORSE:|$)/g;
  let match;
  while ((match = blockRe.exec(text)) !== null) {
    const parsedName = match[1].trim();
    const summary = match[2].trim();
    const runner = usable.find(function(r) { return (r.horseName || '').trim().toLowerCase() === parsedName.toLowerCase(); });
    if (!runner) {
      console.log('[form-summary] callClaude: could not match parsed horse "' + parsedName + '" back to a runner — skipping');
      continue;
    }
    summaries.push({ horse_id: runner.horse_id, horseName: runner.horseName, summary: summary });
  }

  return {
    summaries: summaries,
    inputTokens: usage.input_tokens || 0,
    outputTokens: usage.output_tokens || 0
  };
}

function redisSet(key, value) {
  const url = new URL(UPSTASH_URL);
  const body = JSON.stringify(value);
  return new Promise((resolve, reject) => {
    const req = https.request({
      hostname: url.hostname, path: '/set/' + encodeURIComponent(key), method: 'POST',
      headers: { 'Authorization': 'Bearer ' + UPSTASH_TOKEN, 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) }
    }, res => { let d = ''; res.on('data', c => d += c); res.on('end', () => resolve(d)); });
    req.on('error', reject); req.write(body); req.end();
  });
}

// Same as redisSet but with an expiry — Upstash REST takes TTL as ?EX={seconds}
// on the /set/ path. Used only for the nohistory negative markers below, which
// must age out (a debutant eventually gets a first run on the books).
function redisSetEx(key, value, ttlSeconds) {
  const url = new URL(UPSTASH_URL);
  const body = JSON.stringify(value);
  return new Promise((resolve, reject) => {
    const req = https.request({
      hostname: url.hostname, path: '/set/' + encodeURIComponent(key) + '?EX=' + ttlSeconds, method: 'POST',
      headers: { 'Authorization': 'Bearer ' + UPSTASH_TOKEN, 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) }
    }, res => { let d = ''; res.on('data', c => d += c); res.on('end', () => resolve(d)); });
    req.on('error', reject); req.write(body); req.end();
  });
}

// Accepts callClaude()'s summaries array ({ horse_id, horseName, summary }).
// No expiry on form-summary:{horse_id} — form analysis doesn't depend on
// today's going/course, so it stays valid until the horse runs again and a
// future call overwrites it. Sequential by design (point 4) rather than
// Promise.all, so one slow/failing write can't be blamed on concurrency.
async function storeResults(summaries) {
  let stored = 0;
  let failed = 0;
  const errors = [];

  for (const item of (summaries || [])) {
    try {
      await redisSet('form-summary:' + item.horse_id, {
        horseName: item.horseName,
        summary: item.summary,
        generatedAt: new Date().toISOString()
      });
      stored++;
    } catch (e) {
      failed++;
      const msg = 'form-summary:' + item.horse_id + ': ' + e.message;
      console.log('[form-summary] storeResults: ' + msg);
      errors.push(msg);
    }
  }

  return { stored, failed, errors };
}

function sleep(ms) {
  return new Promise(function(resolve) { setTimeout(resolve, ms); });
}

// Accepts { dates, horsesGenerated, horsesSkipped, horsesFailed, errors,
// inputTokens, outputTokens, isTest } from the handler. Best-effort — matches
// the sendNotification pattern used elsewhere in this codebase (e.g.
// fetch-horse-history-1-background.js): a mail failure must never affect the
// job's own success/failure result, so errors are swallowed here.
async function sendEmail(summary) {
  const cost = ((summary.inputTokens || 0) * 3 / 1000000 + (summary.outputTokens || 0) * 15 / 1000000).toFixed(4);
  const dateLabel = (summary.dates && summary.dates.length) ? summary.dates.join(', ') : 'None';
  const hasErrors = (summary.errors || []).length > 0;
  const todayLabel = (summary.dates && summary.dates.length) ? summary.dates[0] : new Date().toISOString().slice(0, 10);

  let subject;
  if (summary.timedOut) {
    subject = 'Form Summary Partial - ' + todayLabel + ' - rerunning tomorrow';
  } else {
    subject = hasErrors
      ? 'Form Summary Complete (with errors) - ' + todayLabel
      : 'Form Summary Complete - ' + todayLabel;
  }
  if (summary.isTest) subject = 'TEST: ' + subject;

  const bodyLines = [
    'Dates covered: ' + dateLabel,
    'Horses summarised: ' + (summary.horsesGenerated || 0),
    'Horses skipped (already cached): ' + (summary.horsesSkipped || 0),
    'Horses failed: ' + (summary.horsesFailed || 0),
    'Errors: ' + (hasErrors ? summary.errors.join('; ') : 'None'),
    'Total Cost: $' + cost
  ];

  try {
    const transporter = nodemailer.createTransport({
      service: 'gmail',
      auth: { user: process.env.GMAIL_USER, pass: process.env.GMAIL_APP_PASSWORD }
    });
    await transporter.sendMail({
      from: process.env.GMAIL_USER,
      to: process.env.GMAIL_USER,
      subject: subject,
      text: bodyLines.join('\n')
    });
  } catch (e) {
    console.log('[form-summary] sendEmail failed: ' + e.message);
  }
}

exports.handler = async function(event) {
  const startTime = Date.now();
  console.log('[form-summary] START', new Date().toISOString(), 'scheduled:', !event.httpMethod);

  const headers = { 'Access-Control-Allow-Origin': '*', 'Content-Type': 'application/json' };

  const isScheduled = !event.httpMethod;
  const hasTestFilters = !!(event.queryStringParameters && (event.queryStringParameters.date || event.queryStringParameters.course));
  const isTest = !isScheduled && hasTestFilters;

  const nowParts = new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Dublin' }).formatToParts(new Date());
  const todayStr = nowParts.find(p => p.type === 'year').value + '-' + nowParts.find(p => p.type === 'month').value + '-' + nowParts.find(p => p.type === 'day').value;

  // Heartbeat: fire-and-forget first write so even an invocation killed early
  // (e.g. hitting the 900s timeout mid-run, as happened on 2026-08-05) leaves
  // evidence in Redis — mirrors debug:build-heartbeat:{date} in
  // daily-build-background.js. Keyed per Europe/Dublin calendar day, same as
  // readRacecards(), so it lines up with the dates this run actually covers.
  try {
    if (UPSTASH_URL && UPSTASH_TOKEN) {
      redisSet('form-summary:heartbeat:' + todayStr, {
        startedAt: new Date().toISOString(),
        scheduled: isScheduled,
        isTest: isTest
      }).catch(function() {});
    }
  } catch (hbErr) {}

  if (!isScheduled) {
    const secret = (event.queryStringParameters && event.queryStringParameters.secret) || (event.headers && event.headers['x-build-secret']);
    if (secret !== process.env.BUILD_SECRET) {
      return { statusCode: 401, headers, body: JSON.stringify({ error: 'Unauthorised' }) };
    }
  }

  // In-progress lock — without this, re-triggering (manually, or a scheduled
  // run overlapping a still-running one) starts a second, fully independent
  // invocation racing the first over the same runners and Redis keys. That's
  // exactly what happened on 2026-08-05: several overlapping runs, all making
  // real progress (form-summary:* climbed past 800 keys), none ever reaching
  // sendEmail(). Mirrors build:lock:{date} in daily-build-background.js, with
  // the window set just under the function's own 900s timeout so a lock left
  // behind by a run that really did time out doesn't block the next one forever.
  const LOCK_WINDOW_MS = 800 * 1000;
  const now = new Date();
  try {
    const existingLock = await redisGet('form-summary:lock:' + todayStr);
    if (existingLock && existingLock.startedAt) {
      const lockAgeMs = now.getTime() - new Date(existingLock.startedAt).getTime();
      if (lockAgeMs >= 0 && lockAgeMs < LOCK_WINDOW_MS) {
        console.log('[form-summary] already in progress (started ' + Math.round(lockAgeMs / 1000) + 's ago) — standing down.');
        return { statusCode: 200, headers, body: JSON.stringify({ skipped: true, reason: 'form-summary already in progress', lockStartedAt: existingLock.startedAt }) };
      }
    }
    await redisSet('form-summary:lock:' + todayStr, { startedAt: now.toISOString(), scheduled: isScheduled, isTest: isTest });
  } catch (lockErr) { /* lock check/write failure must never block the run itself */ }

  try {
    let runners = await readRacecards();

    // Manual test mode — a scheduled run always processes every runner across
    // all 5 dates; a manual HTTP trigger can optionally narrow that down to
    // one meeting via ?date=&course=, so a test run doesn't burn a full-scale
    // Claude bill just to check the pipeline works.
    if (isTest) {
      const dateParam = event.queryStringParameters && event.queryStringParameters.date;
      const courseParam = event.queryStringParameters && event.queryStringParameters.course;
      if (dateParam) runners = runners.filter(function(r) { return r.date === dateParam; });
      if (courseParam) runners = runners.filter(function(r) { return (r.course || '').toLowerCase() === courseParam.toLowerCase(); });
      console.log('[form-summary] test mode — date filter: ' + (dateParam || '(none)') + ', course filter: ' + (courseParam || '(none)') + ' -> ' + runners.length + ' runner(s)');
    }

    const dates = Array.from(new Set(runners.map(function(r) { return r.date; }))).sort();

    // Today's runners first — same today-first rule as the toProcess sort below,
    // applied here so the pre-filter's time budget is spent on today's horses
    // before any future date's.
    runners.sort(function(a,b){
      return (a.date===todayStr?0:1)-(b.date===todayStr?0:1);
    });

    let horsesSkipped = 0;
    let horsesFailed = 0;
    let horsesGenerated = 0;
    let totalInputTokens = 0;
    let totalOutputTokens = 0;
    const errors = [];

    // Declared before the pre-filter (not the batch loop) so both loops share
    // the same clock — the pre-filter's per-runner Redis reads and live-API
    // history fetches are the run's dominant cost and must respect the same
    // budget, or the function gets hard-killed at 900s with no email and no
    // completion evidence (exactly what has happened since 2026-08-07).
    const TIMEOUT_MS = 780 * 1000;
    let timedOut = false;

    // Interleaved scan + generate — the 2026-08-19 root-cause fix. The old
    // two-phase flow scanned ALL ~5 days of runners (sequential Redis checks
    // plus a live history fetch for every unsummarised horse) before making a
    // single Claude call. That scan consumed most of the 780s budget every
    // run, generation got the scraps (50/run, timedOut daily), and coverage
    // fell further behind every day — the York 13:50 feature race had 18/22
    // runners with no summary. Now each batch fires to Claude the moment it
    // fills: generation starts seconds into the run, history fetches are only
    // paid for horses actually generated this run, and the today-first runner
    // order means today's card completes before future days are touched.
    const BATCH = 10;
    let pending = [];
    let batchNum = 0;

    async function generateBatch() {
      if (!pending.length) return;
      const batch = pending;
      pending = [];
      batchNum++;

      let result;
      try {
        result = await callClaude(batch);
      } catch (e) {
        if (e.message && e.message.indexOf('429') !== -1) {
          console.log('[form-summary] batch ' + batchNum + ': 429 from Claude — waiting 5s and retrying once');
          await sleep(5000);
          try {
            result = await callClaude(batch);
          } catch (e2) {
            console.log('[form-summary] batch ' + batchNum + ': retry failed — ' + e2.message);
            errors.push('batch ' + batchNum + ': ' + e2.message);
            horsesFailed += batch.length;
            return;
          }
        } else {
          console.log('[form-summary] batch ' + batchNum + ': ' + e.message);
          errors.push('batch ' + batchNum + ': ' + e.message);
          horsesFailed += batch.length;
          return;
        }
      }

      totalInputTokens += result.inputTokens || 0;
      totalOutputTokens += result.outputTokens || 0;

      const summarisedIds = new Set(result.summaries.map(function(s) { return s.horse_id; }));
      batch.forEach(function(r) {
        if (!summarisedIds.has(r.horse_id)) {
          horsesFailed++;
          console.log('[form-summary] ' + r.horseName + ' sent to Claude but no summary came back — failed');
        }
      });

      const storeResult = await storeResults(result.summaries);
      horsesGenerated += storeResult.stored;
      horsesFailed += storeResult.failed;
      if (storeResult.errors.length) errors.push.apply(errors, storeResult.errors);

      await sleep(1000);
    }

    for (const runner of runners) {
      if (Date.now() - startTime > TIMEOUT_MS) {
        timedOut = true;
        console.log('[form-summary] approaching 900s timeout (' + Math.round((Date.now() - startTime) / 1000) + 's elapsed) — stopping with ' + horsesGenerated + ' generated so far; next scheduled run continues from here');
        break;
      }
      // Negative marker: this horse recently proved to have no fetchable form
      // history (typically a debutant) — skip it instantly instead of burning
      // ~4s of retry budget on it every single run. The marker self-expires
      // after 7 days so a horse that has since raced gets re-checked.
      const noHistoryMarker = await redisGet('form-summary:nohistory:' + runner.horse_id);
      if (noHistoryMarker) {
        horsesSkipped++;
        continue;
      }
      const existingSummary = await redisGet('form-summary:' + runner.horse_id);
      if (existingSummary) {
        horsesSkipped++;
        continue;
      }
      let formHistory = await getFormHistory(runner);
      if (!formHistory) {
        // Transient API errors (timeouts, brief rate limits) can make a single
        // attempt fail even though the horse genuinely has history — one retry
        // after a short pause catches those without permanently skipping the horse.
        await sleep(2000);
        formHistory = await getFormHistory(runner);
      }
      if (!formHistory) {
        horsesFailed++;
        console.log('[form-summary] no form history for ' + runner.horseName + ' (' + runner.horse_id + ') — failed after retry');
        try { await redisSetEx('form-summary:nohistory:' + runner.horse_id, 1, 604800); } catch (nhErr) {}
        continue;
      }
      pending.push(Object.assign({}, runner, { formHistory: formHistory }));
      if (pending.length >= BATCH) await generateBatch();
    }

    // Flush the final partial batch if budget remains — a sub-10 group at the
    // end of the scan must not be silently dropped.
    if (!timedOut && pending.length && Date.now() - startTime <= TIMEOUT_MS) {
      await generateBatch();
    }

    const summary = {
      dates: dates,
      horsesGenerated: horsesGenerated,
      horsesSkipped: horsesSkipped,
      horsesFailed: horsesFailed,
      errors: errors,
      inputTokens: totalInputTokens,
      outputTokens: totalOutputTokens,
      isTest: isTest,
      timedOut: timedOut
    };

    try {
      await redisSet('form-summary:complete:' + todayStr, {
        completedAt: new Date().toISOString(),
        status: timedOut ? 'partial' : 'complete',
        horsesGenerated: horsesGenerated,
        horsesSkipped: horsesSkipped,
        horsesFailed: horsesFailed,
        timedOut: timedOut
      });
    } catch (ce) {}

    await sendEmail(summary);

    console.log('[form-summary] DONE', new Date().toISOString(), JSON.stringify(summary));

    try { await redisSet('form-summary:lock:' + todayStr, null); } catch (ue) {}
    return {
      statusCode: 200,
      headers,
      body: JSON.stringify({ ok: true, summary: summary })
    };
  } catch (e) {
    console.log('[form-summary] ERROR', e.message);

    try { await redisSet('form-summary:lock:' + todayStr, null); } catch (ue) {}
    return {
      statusCode: 500,
      headers,
      body: JSON.stringify({ error: e.message })
    };
  }
};
