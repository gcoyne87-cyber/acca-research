const https = require('https');

// Class Drop nightly job — runs at 02:00 Irish time, fired by
// class-drop-nightly-trigger.js (which carries the cron and POSTs here with
// x-build-secret). No schedule on this file deliberately: a schedule paired
// directly onto a -background function never actually fires, and a function
// that IS scheduled rejects external HTTP triggers with a 403 at Netlify's
// edge (the form-summary incident — see form-summary-background.js).
//
// THING 1 — today's late-declaration check: today's qualifiers are
// recomputed (racecards.js's enrichRunnerTags + provenClassDropDetail, via
// the shared refreshTodayClassDrop in daily-build-background.js) and
// compared with daily:report:{today}.classDropHorses. A changed list
// regenerates today's card with the same prompt and 46-50 word rules;
// an unchanged list logs "no change" and costs nothing. Last night's
// classDropPreview for this date is promoted to today's canonical fields
// first, so the comparison is against what the site is actually showing.
//
// THING 2 — tomorrow's preview: racecards:{tomorrow} (Europe/Dublin date
// + 1) -> qualifiers -> card text in tomorrow framing -> stored onto
// daily:report:{tomorrow} as classDropPreview { text, qualifiers,
// generatedAt, lastRaceOffTime }. No racecard in Redis yet -> log, exit
// cleanly. Note: this creates daily:report:{tomorrow} when it does not exist
// yet, so get-daily-build?date={tomorrow} answers status:'done' with empty
// picks/intelligence from 02:00 — the client only reads .intelligence and
// .classDropPreview from that response, and the 10:30 build's own
// safeWriteReport guard is unaffected (zero stored items never blocks it).
//
// Irish window: the trigger's cron is UTC and the Irish offset moves by an
// hour at the clock changes, so the cron fires at both 01:00 and 02:00 UTC
// and this job runs only when Irish time is 01:45-02:59 — exactly one of
// the two fires lands in the window on any night of the year. ?force=1
// (manual, with the secret) bypasses the window and the once-a-night mark.
module.exports.config = { timeout: 300 };

const UPSTASH_URL = process.env.UPSTASH_REDIS_REST_URL;
const UPSTASH_TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN;

const { computeClassDropHorses, generateClassDropCardText, maxOffDt, refreshTodayClassDrop } = require('./daily-build-background.js');

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
// Europe/Dublin convention as racecards.js's irishTodayStr.
function irishNow(d) {
  // year/month/day must be requested explicitly — once hour/minute options
  // are given, Intl drops the date parts from formatToParts entirely.
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Dublin', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false }).formatToParts(d || new Date());
  const get = function(type) { return (parts.find(function(p) { return p.type === type; }) || {}).value || ''; };
  let hour = parseInt(get('hour'), 10); if (hour === 24) hour = 0;
  return { date: get('year') + '-' + get('month') + '-' + get('day'), hour: hour, minute: parseInt(get('minute'), 10) };
}

// Calendar arithmetic on a YYYY-MM-DD string, anchored at noon UTC so a DST
// edge can never roll the date the wrong way.
function addDays(dateStr, n) {
  const d = new Date(dateStr + 'T12:00:00Z');
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
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
  const inWindow = (now.hour === 1 && now.minute >= 45) || now.hour === 2;
  if (!force && !inWindow) {
    console.log('[class-drop-nightly] skipped — ' + now.date + ' ' + now.hour + ':' + String(now.minute).padStart(2, '0') + ' Irish is outside the 01:45-02:59 window');
    return { statusCode: 200, headers, body: JSON.stringify({ skipped: true, reason: 'outside Irish 01:45-02:59 window', irishNow: now }) };
  }

  const today = now.date;
  const tomorrow = addDays(today, 1);
  const ranKey = 'classdrop-nightly:ran:' + today;
  if (!force) {
    const already = await redisGet(ranKey);
    if (already && already.completedAt) {
      console.log('[class-drop-nightly] skipped — already ran for ' + today + ' at ' + already.completedAt);
      return { statusCode: 200, headers, body: JSON.stringify({ skipped: true, reason: 'already ran tonight', completedAt: already.completedAt }) };
    }
  }
  console.log('[class-drop-nightly] START ' + new Date().toISOString() + ' today=' + today + ' tomorrow=' + tomorrow + (force ? ' (forced)' : ''));

  const result = { date: today, tomorrow: tomorrow, todayCheck: null, tomorrowPreview: null };

  // THING 1 — today's late-declaration check.
  try {
    const stored = (await redisGet('daily:report:' + today)) || {};
    const working = JSON.parse(JSON.stringify(stored));
    const summary = await refreshTodayClassDrop(today, working, { label: 'Class Drop Intel Card (02:00 late declaration check)' });
    if (summary.changed || summary.promoted) {
      working.classDropCheckedAt = new Date().toISOString();
      await redisSet('daily:report:' + today, working);
    }
    if (summary.changed) {
      console.log('[class-drop-nightly] today ' + today + ': qualifier list changed — card ' + (summary.qualifiers ? 'regenerated' : 'cleared, no qualifiers remain'));
    } else {
      console.log('[class-drop-nightly] today ' + today + ': no change' + (summary.promoted ? ' (preview promoted to today\'s card)' : ''));
    }
    result.todayCheck = summary;
  } catch (e) {
    console.log('[class-drop-nightly] today check failed: ' + e.message);
    result.todayCheck = { error: e.message };
  }

  // THING 2 — tomorrow's preview.
  try {
    const tmRaw = await redisGet('racecards:' + tomorrow);
    const tmMeetings = (tmRaw && Array.isArray(tmRaw.meetings)) ? tmRaw.meetings : [];
    if (!tmMeetings.length) {
      console.log('[class-drop-nightly] tomorrow ' + tomorrow + ': racecard not in Redis yet — nothing to preview');
      result.tomorrowPreview = { skipped: true, reason: 'racecards:' + tomorrow + ' not fetched yet' };
    } else {
      const qualifiers = await computeClassDropHorses(tomorrow, tmMeetings);
      const preview = { text: null, qualifiers: qualifiers, generatedAt: new Date().toISOString(), lastRaceOffTime: maxOffDt(qualifiers) };
      let usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
      let warning = null;
      if (qualifiers.length) {
        const gen = await generateClassDropCardText(qualifiers, { framing: 'tomorrow' });
        preview.text = gen.text;
        usage = gen.usage; warning = gen.warning;
        if (warning) console.log('[class-drop-nightly] ' + warning);
      }
      const existing = (await redisGet('daily:report:' + tomorrow)) || {};
      existing.classDropPreview = preview;
      await redisSet('daily:report:' + tomorrow, existing);
      console.log('[class-drop-nightly] tomorrow ' + tomorrow + ': preview stored — ' + qualifiers.length + ' qualifier(s)' + (preview.text ? '' : ', no card text'));
      result.tomorrowPreview = { stored: true, qualifiers: qualifiers.length, hasText: !!preview.text, lastRaceOffTime: preview.lastRaceOffTime, usage: usage, warning: warning };
    }
  } catch (e) {
    console.log('[class-drop-nightly] tomorrow preview failed: ' + e.message);
    result.tomorrowPreview = { error: e.message };
  }

  if (!force) { try { await redisSet(ranKey, { completedAt: new Date().toISOString(), result: result }); } catch (e) {} }
  console.log('[class-drop-nightly] DONE ' + new Date().toISOString());
  return { statusCode: 200, headers, body: JSON.stringify(result) };
};
