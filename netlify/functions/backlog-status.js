// backlog-status — progress of the two style-2 backfills, per racing date.
//
// HTTP, x-build-secret protected (header or ?secret=). For today .. today+5
// (Europe/Dublin) it reads racecards:{date}, counts the distinct horses, and
// for each horse checks:
//   form-summary:{id}          styleVersion 2 / older summary / none
//   horse:trainer-history:{id} styleVersion 2 analysis / older analysis /
//                              too-few-runs / no-results / parse-failed / none
// plus the two completion markers, trainer-history:complete:{date} and
// form-summary-condense:complete:{date}.
//
// Returns JSON. With ?email=1 it also sends the same table as plain text
// through the Gmail transport daily-build-background.js uses. Both
// self-chaining jobs call ?email=1 when they write status 'complete', so a
// finished date lands in the inbox without anyone reading Redis.
const https = require('https');
const nodemailer = require('nodemailer');

const UPSTASH_URL = process.env.UPSTASH_REDIS_REST_URL;
const UPSTASH_TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN;

// One Redis command via the REST root endpoint (POST / with a JSON array).
function redisCmd(cmd) {
  const url = new URL(UPSTASH_URL);
  const body = JSON.stringify(cmd);
  return new Promise((resolve, reject) => {
    const req = https.request({
      hostname: url.hostname, path: '/', method: 'POST',
      headers: { 'Authorization': 'Bearer ' + UPSTASH_TOKEN, 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) }
    }, res => {
      let d = ''; res.on('data', c => d += c);
      res.on('end', () => {
        try {
          const r = JSON.parse(d);
          if (r && r.error) return reject(new Error(r.error));
          resolve(r ? r.result : null);
        } catch (e) { reject(new Error('redis parse: ' + d.slice(0, 120))); }
      });
    });
    req.on('error', reject);
    req.setTimeout(20000, function() { req.destroy(new Error('redis timeout')); });
    req.write(body); req.end();
  });
}

function parseValue(v) {
  if (v === null || v === undefined) return null;
  try { return JSON.parse(v); } catch (e) { return { _unparseable: true }; }
}

function redisGetJson(key) {
  return redisCmd(['GET', key]).then(parseValue);
}

// MGET in chunks — one round trip per 150 keys keeps each response a
// manageable size (summaries and analyses are a few KB each).
async function redisMgetJson(keys) {
  const out = [];
  for (let i = 0; i < keys.length; i += 150) {
    const chunk = keys.slice(i, i + 150);
    const vals = await redisCmd(['MGET'].concat(chunk));
    (vals || []).forEach(function(v) { out.push(parseValue(v)); });
  }
  return out;
}

function irishDate(offsetDays) {
  const d = new Date(Date.now() + (offsetDays || 0) * 86400000);
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Dublin' }).formatToParts(d);
  const g = function(t) { const p = parts.find(function(x) { return x.type === t; }); return p ? p.value : ''; };
  return g('year') + '-' + g('month') + '-' + g('day');
}

function isObj(v) { return !!v && typeof v === 'object' && !v._unparseable; }

async function dateStatus(date) {
  const row = {
    date: date, horses: 0,
    formSummary: { v2: 0, older: 0, none: 0 },
    trainerHistory: { v2: 0, older: 0, tooFewRuns: 0, noResults: 0, parseFailed: 0, missing: 0 },
    trainerHistoryRun: null, condenseRun: null, error: null
  };
  try {
    const card = await redisGetJson('racecards:' + date);
    const ids = [];
    const seen = new Set();
    if (isObj(card) && Array.isArray(card.meetings)) {
      card.meetings.forEach(function(m) { (m.races || []).forEach(function(r) { (r.runners || []).forEach(function(ru) {
        if (ru.horse_id && !seen.has(ru.horse_id)) { seen.add(ru.horse_id); ids.push(ru.horse_id); }
      }); }); });
    }
    row.horses = ids.length;

    const fs = ids.length ? await redisMgetJson(ids.map(function(id) { return 'form-summary:' + id; })) : [];
    fs.forEach(function(v) {
      if (v === null) row.formSummary.none++;
      else if (isObj(v) && v.styleVersion === 2) row.formSummary.v2++;
      else row.formSummary.older++;   // pre-style-2 object, or a legacy plain-text value
    });

    const th = ids.length ? await redisMgetJson(ids.map(function(id) { return 'horse:trainer-history:' + id; })) : [];
    th.forEach(function(v) {
      if (v === null) { row.trainerHistory.missing++; return; }
      if (!isObj(v)) { row.trainerHistory.older++; return; }
      if (v.reason === 'too-few-runs') { row.trainerHistory.tooFewRuns++; return; }
      if (v.reason === 'no-results') { row.trainerHistory.noResults++; return; }
      if (v.reason === 'parse-failed') { row.trainerHistory.parseFailed++; return; }
      // Generated analysis: v2 only when written by the change-and-verdict
      // prompt; anything without the flag is a 12/13 Sep trial paragraph.
      if (v.styleVersion === 2) row.trainerHistory.v2++; else row.trainerHistory.older++;
    });

    const thRun = await redisGetJson('trainer-history:complete:' + date);
    const cdRun = await redisGetJson('form-summary-condense:complete:' + date);
    row.trainerHistoryRun = isObj(thRun) ? { status: thRun.status || '?', completedAt: thRun.completedAt || null, hop: thRun.hop, counts: thRun.counts || null } : null;
    row.condenseRun = isObj(cdRun) ? { status: cdRun.status || '?', completedAt: cdRun.completedAt || null, hop: cdRun.hop, counts: cdRun.counts || null } : null;
  } catch (e) {
    row.error = e.message;
  }
  return row;
}

function pad(s, w, right) {
  s = String(s);
  if (s.length >= w) return s;
  const fill = new Array(w - s.length + 1).join(' ');
  return right ? fill + s : s + fill;
}

// Plain-text table, one row per date. FS = form summary, TH = trainer history.
function renderTable(rows) {
  const cols = [
    ['Date', 10, false], ['Horses', 6, true],
    ['FS v2', 6, true], ['FS old', 6, true], ['FS none', 7, true],
    ['TH v2', 6, true], ['TH old', 6, true], ['too-few', 7, true], ['no-res', 6, true], ['parse-f', 7, true], ['TH none', 7, true],
    ['TH run', 9, false], ['Condense', 9, false]
  ];
  const lines = [];
  lines.push(cols.map(function(c) { return pad(c[0], c[1], c[2]); }).join('  '));
  lines.push(cols.map(function(c) { return new Array(c[1] + 1).join('-'); }).join('  '));
  const tot = { horses: 0, fv2: 0, fold: 0, fnone: 0, tv2: 0, told: 0, tfew: 0, tnr: 0, tpf: 0, tmiss: 0 };
  rows.forEach(function(r) {
    const f = r.formSummary, t = r.trainerHistory;
    tot.horses += r.horses; tot.fv2 += f.v2; tot.fold += f.older; tot.fnone += f.none;
    tot.tv2 += t.v2; tot.told += t.older; tot.tfew += t.tooFewRuns; tot.tnr += t.noResults; tot.tpf += t.parseFailed; tot.tmiss += t.missing;
    const vals = [
      r.date, r.horses, f.v2, f.older, f.none,
      t.v2, t.older, t.tooFewRuns, t.noResults, t.parseFailed, t.missing,
      r.trainerHistoryRun ? r.trainerHistoryRun.status : '-',
      r.condenseRun ? r.condenseRun.status : '-'
    ];
    lines.push(cols.map(function(c, i) { return pad(vals[i], c[1], c[2]); }).join('  ') + (r.error ? '  ERROR: ' + r.error : ''));
  });
  const totals = ['TOTAL', tot.horses, tot.fv2, tot.fold, tot.fnone, tot.tv2, tot.told, tot.tfew, tot.tnr, tot.tpf, tot.tmiss, '', ''];
  lines.push(cols.map(function(c) { return new Array(c[1] + 1).join('-'); }).join('  '));
  lines.push(cols.map(function(c, i) { return pad(totals[i], c[1], c[2]); }).join('  '));
  lines.push('');
  lines.push('FS = form-summary:{id}: v2 = glance-level style (styleVersion 2), old = earlier summary, none = no summary.');
  lines.push('TH = horse:trainer-history:{id}: v2 = change-and-verdict analysis, old = 12/13 Sep trial analysis, too-few / no-res / parse-f = markers, none = no entry.');
  lines.push('TH run / Condense = trainer-history:complete:{date} and form-summary-condense:complete:{date} status (complete, partial, no-card, or - when never run).');
  return lines.join('\n');
}

exports.handler = async function(event) {
  const headers = { 'Access-Control-Allow-Origin': '*', 'Content-Type': 'application/json' };
  const qs = (event && event.queryStringParameters) || {};
  const secret = qs.secret || (event.headers && event.headers['x-build-secret']);
  if (secret !== process.env.BUILD_SECRET) {
    return { statusCode: 401, headers, body: JSON.stringify({ error: 'Unauthorised' }) };
  }
  if (!UPSTASH_URL || !UPSTASH_TOKEN) {
    return { statusCode: 500, headers, body: JSON.stringify({ error: 'Redis not configured' }) };
  }

  const dates = [];
  for (let i = 0; i <= 5; i++) dates.push(irishDate(i));

  const startedAt = Date.now();
  const rows = await Promise.all(dates.map(dateStatus));
  const table = renderTable(rows);

  let emailed = false, emailError = null;
  if (qs.email === '1') {
    try {
      const transporter = nodemailer.createTransport({
        service: 'gmail',
        auth: { user: process.env.GMAIL_USER, pass: process.env.GMAIL_APP_PASSWORD }
      });
      await transporter.sendMail({
        from: process.env.GMAIL_USER,
        to: 'gcoyne87@gmail.com',
        subject: 'Racing Edge backlog status',
        text: 'Backlog status at ' + new Date().toISOString() + ' (Irish dates, today to today+5)\n\n' + table + '\n'
      });
      emailed = true;
    } catch (e) {
      emailError = e.message;
    }
  }

  return {
    statusCode: 200,
    headers,
    body: JSON.stringify({
      generatedAt: new Date().toISOString(),
      elapsedMs: Date.now() - startedAt,
      dates: rows,
      table: table,
      emailed: emailed,
      emailError: emailError
    })
  };
};
