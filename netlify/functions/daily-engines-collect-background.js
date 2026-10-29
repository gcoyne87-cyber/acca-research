const https = require('https');
const nodemailer = require('nodemailer');

// Daily engines — COLLECT. Ticks every 15 minutes (daily-engines-collect-
// trigger.js carries the cron and POSTs here with x-build-secret), runs only
// 11:45-15:05 Irish, and is SILENT unless it finishes or fails.
//
// Reads batch:daily:{today} written by daily-engines-submit-background.js.
// For each batch not yet collected it calls that engine's own ?collect=
// path in-process (the exported handler with a synthetic secret-bearing
// event — over HTTP a -background function answers 202 with no body, so the
// result would be unobtainable). The engine's collect is resumable and
// self-continues over HTTP when it runs out of time ('partial'), so this
// job never re-enters a batch another collector is still working on: it
// checks the batch:job record first and only calls collect for a batch that
// is 'submitted' or 'in_progress'.
//
// Both batches collected -> status 'complete' and THE ONE email of the day.
// A real collection error -> status 'failed' and an immediate failure email.
// 15:00 Irish with a batch still processing -> ONE "still processing" email
// and status 'stalled', after which nothing else fires for the day.
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

// Same transport and recipient as the daily-build report email.
async function sendEmail(subject, text) {
  try {
    const transporter = nodemailer.createTransport({ service: 'gmail', auth: { user: process.env.GMAIL_USER, pass: process.env.GMAIL_APP_PASSWORD } });
    await transporter.sendMail({ from: process.env.GMAIL_USER, to: EMAIL_TO, subject: subject, text: text });
    return true;
  } catch (e) {
    console.log('[daily-engines-collect] email failed: ' + e.message);
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

async function callEngine(handler, query) {
  try {
    const r = await handler({ httpMethod: 'POST', headers: { 'x-build-secret': process.env.BUILD_SECRET || '' }, queryStringParameters: query });
    let body = null; try { body = JSON.parse(r && r.body || 'null'); } catch (e) { body = { error: 'unparseable engine response: ' + String(r && r.body || '').slice(0, 200) }; }
    return { statusCode: (r && r.statusCode) || 0, body: body || {} };
  } catch (e) {
    return { statusCode: 0, body: { error: e.message } };
  }
}

// One batch -> 'complete' | 'pending' | throws on a real error.
async function collectOne(engineName, handler, batchId) {
  const job = await redisGet('batch:job:' + engineName + ':' + batchId);
  if (!job) throw new Error(engineName + ': no job record at batch:job:' + engineName + ':' + batchId);
  if (job.status === 'complete') return 'complete';
  // The engine's own continuation chain is mid-flight — do not run a second
  // collector over the same job; the next tick re-reads the record.
  if (job.status === 'partial') return 'pending';
  const r = await callEngine(handler, { collect: batchId });
  const b = r.body || {};
  if (b.error) throw new Error(engineName + ' collect: ' + b.error);
  if (b.status === 'complete') return 'complete';
  return 'pending'; // in_progress (Anthropic still processing) or partial (engine continues itself)
}

function money(v) { return '$' + (Number(v) || 0).toFixed(2); }
function nameOf(job, id) { const h = job && job.horses && job.horses[id]; return (h && h.name) || id; }
function failedNames(job) {
  return (job && job.results || []).filter(function(r) { return !r.stored && !r.skipped; }).map(function(r) { return nameOf(job, r.horse_id); });
}
// Failed: {n} ({names}) — names only when 10 or fewer failed; above 10 the
// first 10 plus "and {n} more".
function failedLabel(n, names) {
  if (!n) return '0';
  if (!names.length) return String(n);
  if (n <= 10) return n + ' (' + names.join(', ') + ')';
  return n + ' (' + names.slice(0, 10).join(', ') + ' and ' + (n - 10) + ' more)';
}
function fmtN(n) { return (Number(n) || 0).toLocaleString('en-GB'); }
const MONTHS_SHORT = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
// '2026-10-28' -> '28 Oct'
function shortDate(iso) {
  const p = String(iso || '').split('-');
  return p.length === 3 ? parseInt(p[2], 10) + ' ' + (MONTHS_SHORT[parseInt(p[1], 10) - 1] || '') : String(iso || '');
}
// '2026-10-28' -> 'Wednesday 28 October 2026'
function humanDate(iso) {
  const d = new Date(String(iso) + 'T12:00:00Z');
  if (isNaN(d.getTime())) return String(iso || '');
  const DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
  const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
  return DAYS[d.getUTCDay()] + ' ' + d.getUTCDate() + ' ' + MONTHS[d.getUTCMonth()] + ' ' + d.getUTCFullYear();
}

// The one completion email, built from the daily record plus both job records.
// gtJobs: one batch:job record per goingtrip batch the sweep submitted
// (array; may be empty on a quiet day). Totals are summed across them.
// Body format rewritten 2026-10-28: short human dates, per-date "current"
// counts in place of the standalone skipped lines, thousands commas,
// conditional Resubmitted/Cleaned lines from the staleness counters.
function completionBody(rec, gtJobs, trJob) {
  gtJobs = (Array.isArray(gtJobs) ? gtJobs : [gtJobs]).filter(Boolean);
  const gtResults = gtJobs.reduce(function(a, j) { return a.concat(j.results || []); }, []);
  const gtClean = gtResults.filter(function(r) { return r.stored && !(r.attempt > 1); }).length;
  const gtRecovered = gtResults.filter(function(r) { return r.stored && r.attempt > 1; }).length;
  const gtFailedNames = gtJobs.reduce(function(a, j) { return a.concat(failedNames(j)); }, []);
  const gtFailed = gtJobs.reduce(function(n, j) { return n + ((j.counts && j.counts.failed) || 0) + ((j.counts && j.counts.errored) || 0); }, 0);
  const gtCost = gtJobs.reduce(function(n, j) { return n + (j.totalCostUSD || 0); }, 0);
  const windowLabel = ((rec.windowDates && rec.windowDates.length) ? rec.windowDates : (rec.goingtripDates || [])).map(shortDate).join(' · ');
  const trWindowLabel = (rec.trainerDates && rec.trainerDates.length) ? rec.trainerDates.map(shortDate).join(' · ') : windowLabel;
  // One line per date that had work (the sweep only records a batch when a
  // date had something to submit or template); the skipped count shows as
  // "current" — records that exist and passed the staleness check.
  const gtPerDate = (rec.goingtripBatches || []).map(function(b) {
    return '  ' + shortDate(b.date) + ': ' + fmtN(b.eligible) + ' runners, ' + fmtN(b.skipped) + ' current, ' + fmtN(b.submitted) + ' submitted' + (b.templated ? ', ' + fmtN(b.templated) + ' templated' : '');
  });

  const trFailedNames = failedNames(trJob);
  const trFailed = trJob ? ((trJob.counts && trJob.counts.failed) || 0) + ((trJob.counts && trJob.counts.errored) || 0) : 0;
  const trChecked = (trJob && trJob.submission && trJob.submission.eligible) || (rec.trainerSubmitted + rec.trainerSkipped + rec.trainerNoData);
  const trRegenerated = trJob ? ((trJob.counts && trJob.counts.stored) || 0) : 0;
  const trCost = trJob ? (trJob.totalCostUSD || 0) : 0;

  // Staleness-check resubmits (commit a7d69e5): goingtripResubmits holds the
  // per-reason counts the submit recorded; 'missing' is the ordinary
  // new/late-declaration path and is already visible in Submitted, so the
  // Resubmitted line sums only the three stale reasons and shows only when
  // non-zero. The cleanup line appears only when the one-off
  // CLEANUP_STALE_FORMS path actually deleted records. A record from before
  // a7d69e5 has neither field — both read as 0 and neither line appears.
  const gtRe = rec.goingtripResubmits || {};
  const gtStale = (gtRe['ran-since-written'] || 0) + (gtRe['empty-husk'] || 0) + (gtRe['template-outgrown'] || 0);

  const lines = [
    'Racing Edge engines — ' + humanDate(rec.date),
    '',
    'FORM SUMMARIES — today + 3 days (' + windowLabel + ')',
    ''
  ].concat(gtPerDate.length ? gtPerDate.concat(['']) : []).concat([
    'Checked: ' + fmtN(rec.goingtripEligible != null ? rec.goingtripEligible : rec.goingtripSubmitted) + ' | Submitted: ' + fmtN(rec.goingtripSubmitted) + ' | Stored clean: ' + fmtN(gtClean),
    'Recovered: ' + fmtN(gtRecovered) + ' | Templated: ' + fmtN(rec.goingtripTemplated) + ' | Failed: ' + failedLabel(gtFailed, gtFailedNames)
  ]).concat(gtStale ? ['Resubmitted (stale): ' + fmtN(gtStale)] : [])
    .concat(rec.goingtripCleanupDeleted ? ['Cleaned up (deleted): ' + fmtN(rec.goingtripCleanupDeleted)] : [])
    .concat([
      '',
      'Total cost: ' + money(gtCost),
      '',
      'TRAINER HISTORY — today + 3 days (' + trWindowLabel + ')',
      '',
      'Checked: ' + fmtN(trChecked) + ' | Regenerated: ' + fmtN(trRegenerated),
      'Failed: ' + failedLabel(trFailed, trFailedNames),
      'No data (debutants/point-to-point): ' + fmtN(rec.trainerNoData || 0),
      '',
      'Total cost: ' + money(trCost),
      '',
      'TOTAL TODAY: ' + money(gtCost + trCost) + ' — everything live on site.'
    ]);
  return lines.join('\n');
}

// Every goingtrip batchId on the daily record — the sweep's per-date list,
// or the pre-sweep single goingtripBatchId as a one-item list.
function goingtripBatchIds(rec) {
  const list = Array.isArray(rec.goingtripBatches) ? rec.goingtripBatches : [{ batchId: rec.goingtripBatchId }];
  return list.map(function(b) { return b && b.batchId; }).filter(Boolean);
}
function idsLine(rec) {
  const gt = Array.isArray(rec.goingtripBatches) && rec.goingtripBatches.length
    ? rec.goingtripBatches.filter(function(b) { return b.batchId; }).map(function(b) { return b.date + ' ' + b.batchId; }).join(', ')
    : rec.goingtripBatchId;
  return 'goingtrip batchId(s): ' + (gt || 'none (nothing to submit)') + '\n'
    + 'trainer-history batchId: ' + (rec.trainerBatchId || 'none (nothing to submit)');
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

  // Window guard — 11:45-15:05 Irish; the cron only supplies ticks.
  const now = irishNow();
  const inWindow = (now.hour === 11 && now.minute >= 45) || now.hour === 12 || now.hour === 13 || now.hour === 14 || (now.hour === 15 && now.minute <= 5);
  if (!force && !inWindow) return { statusCode: 200, headers, body: JSON.stringify({ skipped: true, reason: 'outside Irish 11:45-15:05 window' }) };

  const today = qs.date && /^\d{4}-\d{2}-\d{2}$/.test(qs.date) ? qs.date : now.date;
  const key = 'batch:daily:' + today;
  const rec = await redisGet(key);
  if (!rec || rec.status === 'complete' || rec.status === 'failed' || rec.status === 'stalled') {
    return { statusCode: 200, headers, body: JSON.stringify({ skipped: true, reason: rec ? 'status ' + rec.status : 'no batch:daily record' }) };
  }
  if (rec.status !== 'submitted') return { statusCode: 200, headers, body: JSON.stringify({ skipped: true, reason: 'status ' + rec.status + ' — submit still running' }) };

  rec.collected = rec.collected || { goingtrip: false, trainer: false };
  // goingtrip is a sweep — one batch per swept date that had uncovered
  // horses (rec.goingtripBatches). Its flag flips only once EVERY batch is
  // complete, tracked per batchId in rec.goingtripCollected. A record from
  // before the sweep (single goingtripBatchId, no goingtripBatches) goes
  // through the same path as a one-item list.
  rec.goingtripCollected = rec.goingtripCollected || {};
  const gtBatchIds = goingtripBatchIds(rec);
  const engines = gtBatchIds.map(function(id) { return { name: 'goingtrip', handler: goingTripEngine.handler, batchId: id, flag: 'goingtrip' }; })
    .concat([{ name: 'trainer-history', handler: trainerEngine.handler, batchId: rec.trainerBatchId, flag: 'trainer' }]);
  if (!gtBatchIds.length) rec.collected.goingtrip = true;

  for (const eng of engines) {
    if (rec.collected[eng.flag]) continue;
    if (eng.flag === 'goingtrip' && rec.goingtripCollected[eng.batchId]) continue;
    if (!eng.batchId) { rec.collected[eng.flag] = true; continue; }
    try {
      const state = await collectOne(eng.name, eng.handler, eng.batchId);
      if (state === 'complete') {
        console.log('[daily-engines-collect] ' + eng.name + ' ' + eng.batchId + ' collected');
        if (eng.flag === 'goingtrip') {
          rec.goingtripCollected[eng.batchId] = true;
          if (gtBatchIds.every(function(id) { return rec.goingtripCollected[id]; })) rec.collected.goingtrip = true;
        } else {
          rec.collected[eng.flag] = true;
        }
      }
    } catch (e) {
      rec.status = 'failed'; rec.error = e.message; rec.failedAt = new Date().toISOString();
      try { await redisSet(key, rec); } catch (we) {}
      const body = [
        'Racing Edge daily engines — ' + today,
        '',
        'COLLECTION FAILED — ' + eng.name,
        'Error: ' + e.message,
        '',
        idsLine(rec),
        '',
        'No further automatic collection will run today. Collect manually with the engine\'s ?collect={batchId} once the cause is fixed.'
      ].join('\n');
      const sent = await sendEmail('Racing Edge daily engines FAILED — ' + today, body);
      console.log('[daily-engines-collect] FAILED ' + eng.name + ': ' + e.message + ' (email ' + (sent ? 'sent' : 'NOT sent') + ')');
      return { statusCode: 500, headers, body: JSON.stringify(rec) };
    }
  }

  if (rec.collected.goingtrip && rec.collected.trainer) {
    const gtJobs = [];
    for (const id of goingtripBatchIds(rec)) { const j = await redisGet('batch:job:goingtrip:' + id); if (j) gtJobs.push(j); }
    const trJob = rec.trainerBatchId ? await redisGet('batch:job:trainer-history:' + rec.trainerBatchId) : null;
    rec.status = 'complete'; rec.completedAt = new Date().toISOString();
    rec.goingtripCostUSD = +gtJobs.reduce(function(n, j) { return n + (j.totalCostUSD || 0); }, 0).toFixed(4);
    rec.trainerCostUSD = trJob ? (trJob.totalCostUSD || 0) : 0;
    rec.totalCostUSD = +(rec.goingtripCostUSD + rec.trainerCostUSD).toFixed(4);
    const body = completionBody(rec, gtJobs, trJob);
    rec.emailBody = body;
    await redisSet(key, rec);
    const sent = await sendEmail('Racing Edge daily engines complete — ' + today, body);
    console.log('[daily-engines-collect] COMPLETE ' + today + ' total ' + money(rec.totalCostUSD) + ' (email ' + (sent ? 'sent' : 'NOT sent') + ')');
    return { statusCode: 200, headers, body: JSON.stringify(rec) };
  }

  // Still processing. Persist progress; at 15:00 Irish send the one stall
  // notice and stop for the day.
  if (now.hour === 15 || (now.hour === 14 && now.minute >= 59)) {
    rec.status = 'stalled'; rec.stalledAt = new Date().toISOString();
    await redisSet(key, rec);
    const pending = engines.filter(function(e) { return !rec.collected[e.flag]; }).map(function(e) { return e.name; }).join(', ');
    const body = [
      'Racing Edge daily engines — ' + today,
      '',
      'STILL PROCESSING at 15:00 Irish — ' + pending,
      'The batch has not ended on Anthropic\'s side yet. No further automatic collection will run today.',
      '',
      idsLine(rec),
      '',
      'Manual collection once it ends: form-sections-run-background?collect={goingtrip batchId} / trainer-history-v2-background?collect={trainer-history batchId}.'
    ].join('\n');
    const sent = await sendEmail('Racing Edge daily engines still processing — ' + today, body);
    console.log('[daily-engines-collect] STALLED ' + today + ' pending ' + pending + ' (email ' + (sent ? 'sent' : 'NOT sent') + ')');
    return { statusCode: 200, headers, body: JSON.stringify(rec) };
  }
  await redisSet(key, rec);
  return { statusCode: 200, headers, body: JSON.stringify({ pending: true, collected: rec.collected }) };
};
