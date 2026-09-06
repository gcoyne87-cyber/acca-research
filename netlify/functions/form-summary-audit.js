const https = require('https');

const UPSTASH_URL = process.env.UPSTASH_REDIS_REST_URL;
const UPSTASH_TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN;

// READ-ONLY audit of form-summary coverage for one day's card. Never writes
// to Redis, never calls Claude, never calls the Racing API — it reads the
// cached racecards day plus each runner's summary and dated history key, and
// reports which summaries are fresh / stale / missing / legacy / unverifiable
// under exactly the staleness rule form-summary-background.js applies
// (generation calendar day <= latest run date => stale).

// Same Europe/Dublin calendar-day helper racecards.js uses — UTC rollover
// would report yesterday's card to Irish users between 23:00 and midnight UTC.
function irishTodayStr() {
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Dublin' }).formatToParts(new Date());
  const y = parts.find(p => p.type === 'year').value;
  const m = parts.find(p => p.type === 'month').value;
  const d = parts.find(p => p.type === 'day').value;
  return y + '-' + m + '-' + d;
}

// Single-key GET — model of get-form-summaries.js's redisGet.
function redisGet(key) {
  const url = new URL(UPSTASH_URL);
  return new Promise((resolve, reject) => {
    const req = https.request({
      hostname: url.hostname,
      path: '/get/' + encodeURIComponent(key),
      method: 'GET',
      headers: { 'Authorization': 'Bearer ' + UPSTASH_TOKEN }
    }, res => {
      let d = '';
      res.on('data', c => d += c);
      res.on('end', () => {
        try {
          const r = JSON.parse(d);
          resolve(r.result ? JSON.parse(r.result) : null);
        } catch(e) { resolve(null); }
      });
    });
    req.on('error', () => resolve(null));
    req.end();
  });
}

// Batched GETs over one /pipeline round trip — the same pattern
// enrichRunnerTags uses in racecards.js. Returns an array of parsed values
// (null per key on miss or parse failure), aligned with the input keys.
function redisPipelineGet(keys) {
  if (!keys.length) return Promise.resolve([]);
  const url = new URL(UPSTASH_URL);
  const body = JSON.stringify(keys.map(function(k) { return ['GET', k]; }));
  return new Promise((resolve) => {
    const req = https.request({
      hostname: url.hostname, path: '/pipeline', method: 'POST',
      headers: { 'Authorization': 'Bearer ' + UPSTASH_TOKEN, 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) }
    }, res => {
      let d = '';
      res.on('data', c => d += c);
      res.on('end', () => {
        try {
          const arr = JSON.parse(d);
          resolve(keys.map(function(_, i) {
            try {
              const raw = arr[i] && arr[i].result;
              return raw ? JSON.parse(raw) : null;
            } catch (e) { return null; }
          }));
        } catch (e) { resolve(keys.map(function() { return null; })); }
      });
    });
    req.on('error', () => resolve(keys.map(function() { return null; })));
    req.write(body);
    req.end();
  });
}

exports.handler = async function(event) {
  const headers = { 'Access-Control-Allow-Origin': '*', 'Content-Type': 'application/json' };

  try {
    const qs = event.queryStringParameters || {};
    const date = (qs.date && /^\d{4}-\d{2}-\d{2}$/.test(qs.date)) ? qs.date : irishTodayStr();

    // Cached racecards only — this is an audit of what the site is serving,
    // so a live-API fallback would be both a write-cost and a lie.
    const cached = await redisGet('racecards:' + date);
    if (!cached || !Array.isArray(cached.meetings) || !cached.meetings.length) {
      return { statusCode: 404, headers, body: JSON.stringify({ error: 'No cached racecards for ' + date }) };
    }

    const runners = [];
    cached.meetings.forEach(function(m) {
      (m.races || []).forEach(function(race) {
        (race.runners || []).forEach(function(r) {
          if (!r.horse_id) return;
          if (r.is_non_runner) return; // cached runners are already NR-filtered; belt and braces
          runners.push({ horse: r.name || r.horse || '', horse_id: r.horse_id, course: m.name || '', time: race.t || '' });
        });
      });
    });

    // One pipeline for all summaries, one for all dated histories — a
    // 150-runner day is two round trips, not three hundred.
    const summaryVals = await redisPipelineGet(runners.map(function(r) { return 'form-summary:' + r.horse_id; }));
    const historyVals = await redisPipelineGet(runners.map(function(r) { return 'form:history:' + r.horse_id + ':' + date; }));

    const counts = { fresh: 0, stale: 0, missing: 0, legacy: 0, nohist: 0 };
    const stale = [];
    const missing = [];

    runners.forEach(function(r, i) {
      const summary = summaryVals[i];
      const hist = historyVals[i];
      const latestRunDate = (Array.isArray(hist) && hist.length && hist[0] && hist[0].date) ? String(hist[0].date) : null;

      if (!summary) {
        counts.missing++;
        missing.push({ horse: r.horse, horse_id: r.horse_id, course: r.course, time: r.time });
        return;
      }
      const generatedAt = (typeof summary === 'object' && summary.generatedAt) ? String(summary.generatedAt) : null;
      if (!generatedAt) {
        counts.legacy++;
        return;
      }
      if (!latestRunDate) {
        counts.nohist++;
        return;
      }
      if (generatedAt.slice(0, 10) <= latestRunDate) {
        counts.stale++;
        stale.push({ horse: r.horse, horse_id: r.horse_id, course: r.course, time: r.time, generatedAt: generatedAt, latestRunDate: latestRunDate });
        return;
      }
      counts.fresh++;
    });

    const byTimeCourse = function(a, b) {
      return (a.time || '').localeCompare(b.time || '') || (a.course || '').localeCompare(b.course || '');
    };
    stale.sort(byTimeCourse);
    missing.sort(byTimeCourse);

    return {
      statusCode: 200,
      headers,
      body: JSON.stringify({ date: date, totalRunners: runners.length, counts: counts, stale: stale, missing: missing })
    };
  } catch (e) {
    return { statusCode: 500, headers, body: JSON.stringify({ error: e.message }) };
  }
};
