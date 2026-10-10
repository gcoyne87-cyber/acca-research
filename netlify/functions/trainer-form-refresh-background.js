const https = require('https');

// Trainer Form table refresh — rewrites trainer-form:table:{today} from live
// Racing API data twice an evening, so the Trainer Form table and the Hot
// Yard racecard tag (racecards.js enrichRunnerTags reads this key on every
// request) pick up the day's results before the next 10:30 build instead of
// running a day behind. Fired by trainer-form-refresh-evening-trigger.js
// (intent 18:30 Irish) and trainer-form-refresh-late-trigger.js (intent
// 21:30 Irish), which carry the crons and POST here with x-build-secret. No
// schedule on this file deliberately: a schedule paired directly onto a
// -background function never actually fires, and a scheduled function
// rejects external HTTP triggers with a 403 at Netlify's edge (the
// form-summary incident — see form-summary-background.js).
//
// PURE DATA REFRESH. This is the table computation from the 10:30 build's
// step 3.5 (daily-build-background.js, runDailyIntelligenceCards) lifted
// verbatim — same racecards fetch chain, same >=3-runs floor, same top-15 +
// every-elite-yard-running-today row set, same paced 7-day
// /v1/trainers/{id}/results loop, same stored row shape. It writes ONLY
// trainer-form:table:{today} and its own trainer-form-refresh-log:{today}.
// No Daily Intelligence card is regenerated, no Hot Yard card text changes,
// daily:report:{date} is never read or written, no Claude call, no email.
//
// Irish windows: both crons are UTC and the Irish offset moves by an hour at
// the clock changes, so each intent fires at two UTC minutes and this job
// runs only when Irish time is inside the slot's window — exactly one of the
// two fires lands in-window on any evening of the year:
//   evening slot — cron "30 17,18 * * *", window 18:15-19:15 Irish
//   late slot    — cron "30 20,21 * * *", window 21:15-22:15 Irish
// A once-per-slot mark (trainer-form-refresh:ran:{date}:{slot}) is belt and
// braces against a double landing. ?force=1 (manual, with the secret)
// bypasses the window and the mark.
module.exports.config = { timeout: 300 };

const RACING_AUTH = Buffer.from(
  (process.env.RACING_API_USERNAME || '') + ':' + (process.env.RACING_API_KEY || '')
).toString('base64');
const UPSTASH_URL = process.env.UPSTASH_REDIS_REST_URL;
const UPSTASH_TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN;

// Hot Yard whitelist — the same 39-name list daily-build-background.js's
// step 3.5 carries (itself a copy of racecards.js's ELITE_TRAINERS_LC and
// index.html's _buildPopularTrainers). Every elite yard running today is
// guaranteed a stored row regardless of its 14-day rank — that is what the
// Hot Yard tag needs. If a yard is added there it must be added here too.
const ELITE_TRAINERS_LC = [
  "A P O'Brien", 'W P Mullins', 'John & Thady Gosden', 'William Haggas',
  'Charlie Appleby', 'Roger Varian', 'Andrew Balding', 'K. R. Burke',
  'Richard Hannon', 'Simon & Ed Crisford', 'Ralph Beckett', 'Hugo Palmer',
  'Ed Walker', 'Clive Cox', 'George Boughey', 'Harry Eustace', 'James Tate',
  'Archie Watson', 'Ed Dunlop', 'Marco Botti', 'Gordon Elliott',
  'Henry De Bromhead', "Joseph Patrick O'Brien", 'Gavin Cromwell',
  'Mrs John Harrington', "Donnacha Aidan O'Brien", 'J P Murtagh',
  'Richard & Peter Fahey', 'Adrian McGuinness', 'Dan Skelton',
  'Nicky Henderson', 'Paul Nicholls', "Jonjo & A.J. O'Neill", 'Ben Pauling',
  "David O'Meara", 'Tim Easterby', 'Kevin Ryan', 'Julie Camacho',
  'Sir Mark Prescott Bt'
].map(function(t) { return t.toLowerCase(); });

function apiGet(hostname, path, extraHeaders) {
  return new Promise((resolve, reject) => {
    const req = https.request({
      hostname, path, method: 'GET',
      headers: { 'Accept': 'application/json', ...(extraHeaders || {}) }
    }, res => {
      let d = ''; res.on('data', c => d += c);
      res.on('end', () => { try { resolve(JSON.parse(d)); } catch(e) { reject(new Error('Parse: ' + d.slice(0, 100))); } });
    });
    req.on('error', reject); req.end();
  });
}

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

// Irish wall clock via Intl — calendar date plus hour/minute. Same
// Europe/Dublin convention as class-drop-nightly-background.js's irishNow.
function irishNow(d) {
  // year/month/day must be requested explicitly — once hour/minute options
  // are given, Intl drops the date parts from formatToParts entirely.
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Dublin', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false }).formatToParts(d || new Date());
  const get = function(type) { return (parts.find(function(p) { return p.type === type; }) || {}).value || ''; };
  let hour = parseInt(get('hour'), 10); if (hour === 24) hour = 0;
  return { date: get('year') + '-' + get('month') + '-' + get('day'), hour: hour, minute: parseInt(get('minute'), 10) };
}

// Which slot's window the Irish clock is in, or null. Minutes since
// midnight: evening 18:15-19:15 = 1095-1155, late 21:15-22:15 = 1275-1335.
function slotFor(now) {
  const m = now.hour * 60 + now.minute;
  if (m >= 1095 && m <= 1155) return 'evening';
  if (m >= 1275 && m <= 1335) return 'late';
  return null;
}

// Today's racecards — the 10:30 build's own fetch chain (daily-build-
// background.js step 1): pro endpoint, one 5s-paced retry, then the standard
// endpoint; GB/IRE only.
async function fetchTodayRacecards(today) {
  let data;
  try { data = await apiGet('api.theracingapi.com', '/v1/racecards/pro?date=' + today, { 'Authorization': 'Basic ' + RACING_AUTH }); } catch (e) { data = {}; }
  if (!data.racecards || !data.racecards.length) {
    await new Promise(resolve => setTimeout(resolve, 5000));
    try { data = await apiGet('api.theracingapi.com', '/v1/racecards/pro?date=' + today, { 'Authorization': 'Basic ' + RACING_AUTH }); } catch (e) { data = {}; }
  }
  if (!data.racecards || !data.racecards.length) {
    try { data = await apiGet('api.theracingapi.com', '/v1/racecards/standard', { 'Authorization': 'Basic ' + RACING_AUTH }); } catch (e) { data = {}; }
  }
  return (data.racecards || []).filter(r => {
    const reg = (r.region || '').toUpperCase();
    return reg === 'GB' || reg === 'IRE' || reg === 'IE';
  });
}

// The table itself — daily-build-background.js step 3.5, unchanged.
async function buildTrainerFormTable(racecards, today, errors) {
  const trainerTableMap = {};
  racecards.forEach(function(race) {
    (race.runners || []).filter(function(r) { return !r.is_non_runner; }).forEach(function(r) {
      const t14 = r.trainer_14_days || {};
      const runs = t14.runs || 0, wins = t14.wins || 0, pct = parseFloat(t14.percent) || 0;
      if (runs >= 3 && r.trainer && !trainerTableMap[r.trainer]) {
        trainerTableMap[r.trainer] = { trainer: r.trainer, trainer_id: r.trainer_id || '', runs: runs, wins: wins, pct: pct };
      }
    });
  });

  // Top 15 by 14-day strike rate — the homepage table's display set.
  const trainerTableTop15 = Object.values(trainerTableMap).sort(function(a, b) {
    return b.pct - a.pct;
  }).slice(0, 15);

  // Every elite trainer running today, independent of their 14-day rank —
  // built straight from today's racecards so an elite yard is included even
  // when it wouldn't crack the top 15 or the >=3-runs floor.
  const eliteTodayMap = {};
  racecards.forEach(function(race) {
    (race.runners || []).filter(function(r) { return !r.is_non_runner; }).forEach(function(r) {
      const nameLc = (r.trainer || '').toLowerCase().trim();
      if (!nameLc || !r.trainer || eliteTodayMap[r.trainer] || ELITE_TRAINERS_LC.indexOf(nameLc) === -1) return;
      const existing = trainerTableMap[r.trainer];
      if (existing) { eliteTodayMap[r.trainer] = existing; return; }
      const t14 = r.trainer_14_days || {};
      eliteTodayMap[r.trainer] = { trainer: r.trainer, trainer_id: r.trainer_id || '', runs: t14.runs || 0, wins: t14.wins || 0, pct: parseFloat(t14.percent) || 0 };
    });
  });

  // Rows to fetch 7-day stats for and store: the top-15 display set plus
  // any elite trainer running today not already in it.
  const trainerTableStoreMap = {};
  trainerTableTop15.forEach(function(e) { trainerTableStoreMap[e.trainer] = e; });
  Object.keys(eliteTodayMap).forEach(function(name) { if (!trainerTableStoreMap[name]) trainerTableStoreMap[name] = eliteTodayMap[name]; });
  const trainerTableToStore = Object.values(trainerTableStoreMap);

  // 7-day stats — the racecards only embed trainer_14_days, so the 7-day
  // window comes from the trainers results endpoint: one date-ranged call
  // per stored trainer, paced 200ms, runs/wins counted per runner by
  // trainer_id (position lives on the runner, never at the race level). A
  // failed call leaves that trainer's 7d fields at zero and is logged — the
  // table write must never fail because one trainer lookup did.
  const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
  for (const entry of trainerTableToStore) {
    entry.runs7 = 0; entry.wins7 = 0; entry.pct7 = 0;
    if (!entry.trainer_id) continue;
    try {
      const data7 = await apiGet('api.theracingapi.com',
        '/v1/trainers/' + encodeURIComponent(entry.trainer_id) + '/results?start_date=' + sevenDaysAgo + '&end_date=' + today,
        { 'Authorization': 'Basic ' + RACING_AUTH }
      );
      await new Promise(resolve => setTimeout(resolve, 200));
      const results7 = data7.results || [];
      let runs7 = 0, wins7 = 0;
      results7.forEach(function(race) {
        (race.runners || []).forEach(function(runner) {
          if ((runner.trainer_id || '') !== entry.trainer_id) return;
          runs7++;
          if (String(runner.position) === '1') wins7++;
        });
      });
      entry.runs7 = runs7;
      entry.wins7 = wins7;
      entry.pct7 = entry.runs7 > 0 ? Math.round(entry.wins7 / entry.runs7 * 100) : 0;
    } catch (e7) {
      errors.push('7d fetch failed for ' + entry.trainer + ': ' + e7.message);
    }
  }

  return trainerTableToStore.map(function(entry) {
    return {
      trainerName: entry.trainer,
      runners14d: entry.runs,
      winners14d: entry.wins,
      strikeRate: entry.pct, // kept under its original name so cached frontends still read it
      strikeRate14d: entry.pct,
      runners7d: entry.runs7,
      winners7d: entry.wins7,
      strikeRate7d: entry.pct7
    };
  });
}

exports.handler = async function(event) {
  const headers = { 'Content-Type': 'application/json' };
  const qs = event.queryStringParameters || {};
  const isScheduled = !event.httpMethod;
  if (!isScheduled) {
    const secret = qs.secret || (event.headers && event.headers['x-build-secret']);
    if (secret !== process.env.BUILD_SECRET) {
      return { statusCode: 401, headers, body: JSON.stringify({ error: 'Unauthorised' }) };
    }
  }
  const force = qs.force === '1';

  const now = irishNow();
  const slot = slotFor(now) || (force ? 'forced' : null);
  const stamp = now.date + ' ' + now.hour + ':' + String(now.minute).padStart(2, '0') + ' Irish';
  if (!slot) {
    console.log('[trainer-form-refresh] skipped — ' + stamp + ' is outside both windows (18:15-19:15, 21:15-22:15)');
    return { statusCode: 200, headers, body: JSON.stringify({ skipped: true, reason: 'outside Irish windows', irishNow: now }) };
  }

  // The 10:30 build keys the table by UTC date; at 18:15-22:15 Irish the UTC
  // and Irish dates coincide all year (the offset is never more than +1h),
  // so the Irish date here is the same key the build wrote this morning.
  const today = now.date;
  const ranKey = 'trainer-form-refresh:ran:' + today + ':' + slot;
  if (!force) {
    const already = await redisGet(ranKey);
    if (already && already.completedAt) {
      console.log('[trainer-form-refresh] skipped — ' + slot + ' slot already ran for ' + today + ' at ' + already.completedAt);
      return { statusCode: 200, headers, body: JSON.stringify({ skipped: true, reason: 'already ran this slot', completedAt: already.completedAt }) };
    }
  }

  const startedAt = new Date().toISOString();
  console.log('[trainer-form-refresh] START ' + startedAt + ' slot=' + slot + ' (' + stamp + ')' + (force ? ' (forced)' : ''));
  const errors = [];
  const logEntry = { slot: slot, startedAt: startedAt, completedAt: null, irishTime: stamp, racecards: 0, trainerCount: 0, written: false, errors: errors };

  try {
    const racecards = await fetchTodayRacecards(today);
    logEntry.racecards = racecards.length;
    if (!racecards.length) {
      errors.push('Racing API returned zero GB/IRE racecards for ' + today + ' — table left as-is');
    } else {
      const table = await buildTrainerFormTable(racecards, today, errors);
      logEntry.trainerCount = table.length;
      if (table.length) {
        await redisSet('trainer-form:table:' + today, table);
        logEntry.written = true;
        console.log('[trainer-form-refresh] wrote trainer-form:table:' + today + ' — ' + table.length + ' rows' + (errors.length ? ', ' + errors.length + ' 7d lookup error(s)' : ''));
      } else {
        errors.push('No stored rows produced for ' + today + ' — table left as-is');
      }
    }
  } catch (e) {
    errors.push('refresh failed: ' + e.message);
    console.log('[trainer-form-refresh] FAILED: ' + e.message);
  }

  logEntry.completedAt = new Date().toISOString();
  // Run log — one entry appended per run, so an evening's two slots (and
  // any forced reruns) sit side by side under the date.
  try {
    const log = (await redisGet('trainer-form-refresh-log:' + today)) || [];
    (Array.isArray(log) ? log : []).push(logEntry);
    await redisSet('trainer-form-refresh-log:' + today, Array.isArray(log) ? log : [logEntry]);
  } catch (eLog) {
    console.log('[trainer-form-refresh] log write failed: ' + eLog.message);
  }
  if (!force && logEntry.written) {
    try { await redisSet(ranKey, { completedAt: logEntry.completedAt }); } catch (eMark) { console.log('[trainer-form-refresh] ran-mark write failed: ' + eMark.message); }
  }

  console.log('[trainer-form-refresh] DONE ' + logEntry.completedAt + ' slot=' + slot + ' trainers=' + logEntry.trainerCount + ' written=' + logEntry.written + ' errors=' + errors.length);
  return { statusCode: 200, headers, body: JSON.stringify(logEntry) };
};
