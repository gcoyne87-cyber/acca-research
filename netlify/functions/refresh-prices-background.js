const https = require('https');
const nodemailer = require('nodemailer');

module.exports.config = { schedule: '0 6-21 * * *', timeout: 120 };

const USERNAME = process.env.RACING_API_USERNAME;
const PASSWORD = process.env.RACING_API_KEY;
const BASE_URL = 'api.theracingapi.com';
const AUTH = Buffer.from((USERNAME || '') + ':' + (PASSWORD || '')).toString('base64');

const UPSTASH_URL = process.env.UPSTASH_REDIS_REST_URL;
const UPSTASH_TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN;

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
        let parsed;
        try { parsed = JSON.parse(data); }
        catch(e) { reject(new Error('Parse error (status ' + res.statusCode + '): ' + data.substring(0, 200))); return; }
        // A non-2xx response with a valid JSON error body (e.g. rate-limit or
        // out-of-range-date errors) would otherwise resolve "successfully" here
        // and silently look like an empty racecard day downstream. Surface it
        // as a real error instead.
        if (res.statusCode < 200 || res.statusCode >= 300) {
          const apiMsg = (parsed && (parsed.error || parsed.message)) || JSON.stringify(parsed).substring(0, 200);
          reject(new Error('HTTP ' + res.statusCode + ': ' + apiMsg));
          return;
        }
        resolve(parsed);
      });
    });
    req.on('error', reject);
    req.end();
  });
}

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
        try { const r = JSON.parse(d); resolve(r.result ? JSON.parse(r.result) : null); }
        catch(e) { resolve(null); }
      });
    });
    req.on('error', reject);
    req.end();
  });
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

function redisDel(key) {
  const url = new URL(UPSTASH_URL);
  return new Promise((resolve, reject) => {
    const req = https.request({
      hostname: url.hostname, path: '/del/' + encodeURIComponent(key), method: 'POST',
      headers: { 'Authorization': 'Bearer ' + UPSTASH_TOKEN }
    }, res => { let d = ''; res.on('data', c => d += c); res.on('end', () => resolve(d)); });
    req.on('error', reject); req.end();
  });
}

function redisExpire(key, seconds) {
  const url = new URL(UPSTASH_URL);
  return new Promise((resolve, reject) => {
    const req = https.request({
      hostname: url.hostname, path: '/expire/' + encodeURIComponent(key) + '/' + seconds, method: 'POST',
      headers: { 'Authorization': 'Bearer ' + UPSTASH_TOKEN }
    }, res => { let d = ''; res.on('data', c => d += c); res.on('end', () => resolve(d)); });
    req.on('error', reject); req.end();
  });
}

// ── C&D+G HOURLY RECHECK ─────────────────────────────────────────────────────
// racecards.js computes isCandDWinner / isCandDGoing at request time only —
// racecards:{date} in Redis never carries those flags, so there is nothing to
// "recheck" there yet. These two helpers and recheckCandDGoing() below are a
// self-contained copy of racecards.js's own C&D-winner match (stripParens /
// milesFurlongs), plus a stricter going comparison for C&D+G: racecard going
// and form-history going come from two different Racing API endpoints and are
// shaped differently, so instead of racecards.js's regex-bucket test this
// normalises both sides to their primary going term and requires an exact
// string match.
function stripParens(s) {
  return (s || '').replace(/\s*\([^)]*\)/g, '').toLowerCase().trim();
}

// "2m1f111y" -> miles*8 + furlongs as an integer, yards ignored — same rule
// racecards.js uses, since history and racecard yardages differ freely for
// the same trip.
function milesFurlongs(distStr) {
  const s = String(distStr || '');
  const miles = (s.match(/(\d+)m/) || [])[1];
  const furlongs = (s.match(/(\d+)f/) || [])[1];
  return (miles ? parseInt(miles, 10) : 0) * 8 + (furlongs ? parseInt(furlongs, 10) : 0);
}

// Normalises a going string down to its primary going term: lowercase, strip
// an AW surface prefix ("Tapeta: "), cut at the first comma or bracket (drops
// ", soft in places" / "(GoingStick 6.2)" qualifiers), then strip the
// remaining "in places" / "goingstick" / "aw" noise words that can appear
// without a comma. Two going strings are treated as the same ground only when
// their normalised forms match exactly.
function normaliseGoing(str) {
  return String(str || '')
    .toLowerCase()
    .replace(/^[a-z]+\s*:\s*/, '')
    .split(/[,(]/)[0]
    .replace(/\bin places\b/g, '')
    .replace(/\bgoingstick\b/g, '')
    .replace(/\baw\b/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

// Rechecks C&D+G for every runner with a horse_id on the given cached
// racecard object, mutating runners in place. Reads form:history:{horse_id}:
// {dateStr} from Redis only — one pipelined round trip, zero Racing API
// calls. Best-effort throughout: a missing UPSTASH config, a failed pipeline,
// or a missing/unreadable history for one horse just leaves that runner's
// existing flags untouched — this never throws and never blocks the price
// refresh or its Redis write.
async function recheckCandDGoing(cached, dateStr) {
  try {
    const entries = [];
    (cached.meetings || []).forEach(function(m) {
      (m.races || []).forEach(function(race) {
        (race.runners || []).forEach(function(ru) {
          if (ru.horse_id) entries.push({ ru: ru, m: m, race: race });
        });
      });
    });
    if (!entries.length) return;

    const url = new URL(UPSTASH_URL);
    const cmds = entries.map(function(e) { return ['GET', 'form:history:' + e.ru.horse_id + ':' + dateStr]; });
    const body = JSON.stringify(cmds);
    const results = await new Promise(function(resolve) {
      const req = https.request({
        hostname: url.hostname, path: '/pipeline', method: 'POST',
        headers: { 'Authorization': 'Bearer ' + UPSTASH_TOKEN, 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) }
      }, function(res) {
        let d = '';
        res.on('data', function(c) { d += c; });
        res.on('end', function() { try { resolve(JSON.parse(d)); } catch (e) { resolve(null); } });
      });
      req.on('error', function() { resolve(null); });
      req.write(body);
      req.end();
    });
    if (!Array.isArray(results)) return;

    entries.forEach(function(e, i) {
      try {
        const raw = results[i] && results[i].result;
        if (!raw) return;
        const history = JSON.parse(raw);
        if (!Array.isArray(history)) return;
        const runs = history.slice(0, 6);
        const courseKey = stripParens(e.m.name);
        const distKey = milesFurlongs(e.race.dist);
        const winRun = runs.find(function(h) {
          return String(h.pos) === '1'
            && stripParens(h.course) === courseKey
            && milesFurlongs(h.dist) === distKey;
        });
        if (!winRun) return;
        e.ru.isCandDWinner = true;
        const todayGoing = normaliseGoing(e.race.going);
        if (todayGoing && normaliseGoing(winRun.going) === todayGoing) {
          e.ru.isCandDGoing = true;
          e.ru.isCandDWinner = false;
          // Raw (un-normalised) going and date of the matching win, so a
          // C&D+G horse can be reported downstream without a second Redis
          // read of this same history.
          e.ru.cdgWinGoing = winRun.going || '';
          e.ru.cdgWinDate = winRun.date || '';
        } else {
          e.ru.isCandDGoing = false;
        }
      } catch (eRunner) {
        // leave this runner's flags untouched
      }
    });
  } catch (eOuter) {
    // best-effort — never blocks the price refresh
  }
}

function fracToDec(s) {
  if (!s || s === 'SP') return 0;
  const p = String(s).trim();
  if (/^evs$|^evens$/i.test(p)) return 2;
  const q = p.split('/');
  if (q.length === 2) {
    const n = parseFloat(q[0]), d = parseFloat(q[1]);
    if (!isNaN(n) && !isNaN(d) && d > 0) return n / d + 1;
  }
  const f = parseFloat(p);
  return (!isNaN(f) && f > 1) ? f : 0;
}

// Price-movement flags vs the day's anchor price. The anchor is the FIRST
// price seen for the horse that day, held in one per-date map key
// (price:anchors:{date} = { horse_id: { anchor, drift, short } }) rather than
// one Redis key per horse — a single GET+SET per refresh instead of hundreds.
// Thresholds in decimal-odds terms: current >= anchor x 1.40 -> isDrifting;
// current <= anchor x 0.70 -> isShortening. Flags are STICKY for the day —
// once recorded in the anchor entry they never clear, even if the price moves
// back — so a cache rebuild can't lose them (they re-apply from the map every
// refresh). A horse with no readable current price (SP / suspended market /
// non-runner) is skipped entirely: no anchor created, no flag set, and any
// flags already written onto the cached runner are left untouched.
function applyPriceMovement(ru, currentPrice, anchors) {
  const curDec = fracToDec(currentPrice);
  if (!curDec) return false;
  let changed = false;
  let a = anchors[ru.horse_id];
  if (!a || !a.anchor) {
    a = anchors[ru.horse_id] = { anchor: currentPrice };
    changed = true;
  }
  const anchorDec = fracToDec(a.anchor);
  if (anchorDec) {
    if (!a.drift && curDec >= anchorDec * 1.40) { a.drift = true; changed = true; }
    if (!a.short && curDec <= anchorDec * 0.70) { a.short = true; changed = true; }
  }
  if (a.drift) { ru.isDrifting = true; ru.anchorPrice = a.anchor; ru.currentPrice = currentPrice; }
  if (a.short) { ru.isShortening = true; ru.anchorPrice = a.anchor; ru.currentPrice = currentPrice; }
  return changed;
}

// Best-effort email notification — must never affect the function's own result.
async function sendNotification(subject, bodyText) {
  try {
    const transporter = nodemailer.createTransport({
      service: 'gmail',
      auth: { user: process.env.GMAIL_USER, pass: process.env.GMAIL_APP_PASSWORD }
    });
    await transporter.sendMail({
      from: process.env.GMAIL_USER,
      to: process.env.GMAIL_USER,
      subject: subject,
      text: bodyText
    });
  } catch (e) {
    // Swallow — email failure must not affect the job's own outcome.
  }
}

function extractPrice(oddsArr, bookmaker) {
  if (!Array.isArray(oddsArr) || !oddsArr.length) return 'SP';
  const bk = (bookmaker || '').toLowerCase();
  const match = oddsArr.find(function(o) {
    return (o.bookmaker || '').toLowerCase() === bk;
  });
  if (match && match.fractional) return match.fractional;
  // fall back to first non-exchange bookmaker
  const fallback = oddsArr.find(function(o) {
    return o.fractional && !(o.bookmaker || '').toLowerCase().includes('exchange');
  });
  return (fallback && fallback.fractional) || 'SP';
}

async function sendErrorEmail(dateLabel, err) {
  try {
    const transporter = nodemailer.createTransport({
      service: 'gmail',
      auth: { user: process.env.GMAIL_USER, pass: process.env.GMAIL_APP_PASSWORD }
    });
    await transporter.sendMail({
      from: process.env.GMAIL_USER,
      to: 'gcoyne87@gmail.com',
      subject: 'Price Refresh ERROR',
      text: 'Date failed: ' + dateLabel + '\nError: ' + err.message + '\nTimestamp: ' + new Date().toISOString()
    });
  } catch (e) {
    // Swallow — email failure must not affect the job's own outcome.
  }
}

exports.handler = async function(event) {
  console.log('[refresh-prices-background] started');

  const now = new Date();
  const today = now.getFullYear() + '-' + String(now.getMonth() + 1).padStart(2, '0') + '-' + String(now.getDate()).padStart(2, '0');

  let todayUpdated = 0;
  let todayError = null;

  try {
    const freshData = await apiGet('/v1/racecards/pro?date=' + today);
    const cached = await redisGet('racecards:' + today);

    if (!cached || !cached.meetings) {
      console.log('No cached racecard for today');
    } else if (freshData && freshData.racecards && freshData.racecards.length) {
      // Build a horse_id -> fresh price lookup from the raw Racing API response
      const freshPriceMap = {};
      freshData.racecards.forEach(function(race) {
        (race.runners || []).forEach(function(r) {
          if (!r.horse_id) return;
          const oddsArr = Array.isArray(r.odds) ? r.odds : (Array.isArray(r.price) ? r.price : null);
          freshPriceMap[r.horse_id] = extractPrice(oddsArr, 'Boyle Sports');
        });
      });

      // Fresh going lookups — the clerk revises going through the morning
      // (rain, watering, inspections) but racecards:{date} is built at 23:00
      // the night before and nothing else ever updated it, so the site showed
      // stale going all day. going_detailed is preferred as the display value
      // (GoingStick readings, "in places" qualifiers), falling back to plain
      // going when it's empty. Meeting id matches the cache's own rawId rule
      // (course_id, else slugged course name); races match on HH:MM off time,
      // derived from off_dt exactly as the cache builder derives race.t.
      const freshGoingByMeeting = {};
      const freshGoingByRace = {};
      freshData.racecards.forEach(function(race) {
        const mid = race.course_id || (race.course || '').toLowerCase().replace(/\s+/g, '-').replace(/[^a-z0-9-]/g, '');
        if (!mid) return;
        const tm = (race.off_dt || '').match(/T(\d{2}):(\d{2})/);
        const t = tm ? tm[1] + ':' + tm[2] : (race.off_time || '');
        const display = race.going_detailed || race.going || '';
        if (display && !freshGoingByMeeting[mid]) freshGoingByMeeting[mid] = display;
        if (display) freshGoingByRace[mid + '|' + t] = { going: display, going_detailed: race.going_detailed || '' };
      });

      // Day's anchor prices — first price seen per horse, plus sticky
      // drift/shorten flags (see applyPriceMovement above).
      const anchors = (await redisGet('price:anchors:' + today)) || {};
      let anchorsDirty = false;

      // Walk the existing cached (mapped) meetings structure and update the
      // price field, the price-movement flags, and the going fields — all in
      // the same single Redis write below.
      (cached.meetings || []).forEach(function(m) {
        if (freshGoingByMeeting[m.id]) m.going = freshGoingByMeeting[m.id];
        (m.races || []).forEach(function(race) {
          const fg = freshGoingByRace[m.id + '|' + (race.t || '')];
          if (fg) { race.going = fg.going; race.going_detailed = fg.going_detailed; }
          (race.runners || []).forEach(function(ru) {
            if (ru.horse_id && freshPriceMap.hasOwnProperty(ru.horse_id)) {
              ru.price = freshPriceMap[ru.horse_id];
              if (applyPriceMovement(ru, freshPriceMap[ru.horse_id], anchors)) anchorsDirty = true;
              todayUpdated++;
            }
          });
        });
      });

      if (todayUpdated === 0) {
        // Cache and fresh API data were both non-empty but nothing matched —
        // likely a cache shape/ID mismatch. Never let this fail silently.
        todayError = 'Today racecard and fresh API data both non-empty but 0 runners updated (possible cache shape or horse_id mismatch)';
        await sendErrorEmail('today (' + today + ')', new Error(todayError));
      }

      await recheckCandDGoing(cached, today);

      await redisSet('racecards:' + today, cached);
      if (anchorsDirty) {
        await redisSet('price:anchors:' + today, anchors);
        await redisExpire('price:anchors:' + today, 172800);
      }
    }
  } catch (e) {
    console.log('[refresh-prices-background] today error:', e.message);
    todayError = e.message;
    await sendErrorEmail('today (' + today + ')', e);
  }

  console.log('[refresh-prices-background] todayUpdated:', todayUpdated);

  await new Promise(resolve => setTimeout(resolve, 200));

  const tmrw = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1);
  const tomorrow = tmrw.getFullYear() + '-' + String(tmrw.getMonth() + 1).padStart(2, '0') + '-' + String(tmrw.getDate()).padStart(2, '0');

  let tomorrowUpdated = 0;
  let tomorrowError = null;

  try {
    const freshDataTomorrow = await apiGet('/v1/racecards/pro?date=' + tomorrow);
    const cachedTomorrow = await redisGet('racecards:' + tomorrow);

    if (!cachedTomorrow || !cachedTomorrow.meetings) {
      console.log('No cached racecard for tomorrow');
    } else if (freshDataTomorrow && freshDataTomorrow.racecards && freshDataTomorrow.racecards.length) {
      // Build a horse_id -> fresh price lookup from the raw Racing API response
      const freshPriceMapTomorrow = {};
      freshDataTomorrow.racecards.forEach(function(race) {
        (race.runners || []).forEach(function(r) {
          if (!r.horse_id) return;
          const oddsArr = Array.isArray(r.odds) ? r.odds : (Array.isArray(r.price) ? r.price : null);
          freshPriceMapTomorrow[r.horse_id] = extractPrice(oddsArr, 'Boyle Sports');
        });
      });

      // Fresh going lookups for tomorrow — same rules as today's block above.
      const freshGoingByMeetingTomorrow = {};
      const freshGoingByRaceTomorrow = {};
      freshDataTomorrow.racecards.forEach(function(race) {
        const mid = race.course_id || (race.course || '').toLowerCase().replace(/\s+/g, '-').replace(/[^a-z0-9-]/g, '');
        if (!mid) return;
        const tm = (race.off_dt || '').match(/T(\d{2}):(\d{2})/);
        const t = tm ? tm[1] + ':' + tm[2] : (race.off_time || '');
        const display = race.going_detailed || race.going || '';
        if (display && !freshGoingByMeetingTomorrow[mid]) freshGoingByMeetingTomorrow[mid] = display;
        if (display) freshGoingByRaceTomorrow[mid + '|' + t] = { going: display, going_detailed: race.going_detailed || '' };
      });

      // Tomorrow gets its own anchor map under its own date key — "the day"
      // for anchoring purposes is the racing date, not the calendar day the
      // refresh happens to run on.
      const anchorsTomorrow = (await redisGet('price:anchors:' + tomorrow)) || {};
      let anchorsTomorrowDirty = false;

      // Walk the existing cached (mapped) meetings structure and update the
      // price field, the price-movement flags, and the going fields — all in
      // the same single Redis write below.
      (cachedTomorrow.meetings || []).forEach(function(m) {
        if (freshGoingByMeetingTomorrow[m.id]) m.going = freshGoingByMeetingTomorrow[m.id];
        (m.races || []).forEach(function(race) {
          const fg = freshGoingByRaceTomorrow[m.id + '|' + (race.t || '')];
          if (fg) { race.going = fg.going; race.going_detailed = fg.going_detailed; }
          (race.runners || []).forEach(function(ru) {
            if (ru.horse_id && freshPriceMapTomorrow.hasOwnProperty(ru.horse_id)) {
              ru.price = freshPriceMapTomorrow[ru.horse_id];
              if (applyPriceMovement(ru, freshPriceMapTomorrow[ru.horse_id], anchorsTomorrow)) anchorsTomorrowDirty = true;
              tomorrowUpdated++;
            }
          });
        });
      });

      await recheckCandDGoing(cachedTomorrow, tomorrow);

      await redisSet('racecards:' + tomorrow, cachedTomorrow);
      if (anchorsTomorrowDirty) {
        await redisSet('price:anchors:' + tomorrow, anchorsTomorrow);
        await redisExpire('price:anchors:' + tomorrow, 172800);
      }
    }
  } catch (e) {
    console.log('[refresh-prices-background] tomorrow error:', e.message);
    tomorrowError = e.message;
    await sendErrorEmail('tomorrow (' + tomorrow + ')', e);
  }

  console.log('[refresh-prices-background] tomorrowUpdated:', tomorrowUpdated);

  const logKey = 'price-refresh-log:' + today + ':' + new Date().getUTCHours();
  await redisSet(logKey, {
    todayUpdated: todayUpdated,
    tomorrowUpdated: tomorrowUpdated,
    timestamp: new Date().toISOString(),
    errors: [todayError, tomorrowError].filter(Boolean)
  });

  // 21:00 UTC = 10pm Irish time (summer) — compile and send the daily summary, then clear today's log entries
  if (now.getUTCHours() === 21) {
    const summaryHours = [];
    for (let h = 6; h <= 21; h++) { summaryHours.push(h); }

    const summaryEntries = [];
    for (const h of summaryHours) {
      const entry = await redisGet('price-refresh-log:' + today + ':' + h);
      if (entry) summaryEntries.push({ hour: h, data: entry });
    }

    let summaryText = 'Price Refresh Daily Summary for ' + today + '\n\n';
    if (!summaryEntries.length) {
      summaryText += 'No hourly runs recorded for today.\n';
    } else {
      summaryEntries.forEach(function(entry) {
        summaryText += 'Hour ' + entry.hour + ':00 UTC — todayUpdated: ' + entry.data.todayUpdated + ', tomorrowUpdated: ' + entry.data.tomorrowUpdated;
        if (entry.data.errors && entry.data.errors.length) {
          summaryText += ', errors: ' + entry.data.errors.join('; ');
        }
        summaryText += '\n';
      });
    }

    try {
      const transporter = nodemailer.createTransport({
        service: 'gmail',
        auth: { user: process.env.GMAIL_USER, pass: process.env.GMAIL_APP_PASSWORD }
      });
      await transporter.sendMail({
        from: process.env.GMAIL_USER,
        to: 'gcoyne87@gmail.com',
        subject: 'Price Refresh Daily Summary - ' + today,
        text: summaryText
      });
    } catch (e) {
      // Swallow — email failure must not affect the job's own outcome.
    }

    for (const h of summaryHours) {
      await redisDel('price-refresh-log:' + today + ':' + h);
    }
  }

  return {
    statusCode: 200,
    body: JSON.stringify({ todayUpdated: todayUpdated, tomorrowUpdated: tomorrowUpdated })
  };
};
