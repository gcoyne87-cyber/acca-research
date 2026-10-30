const https = require('https');
const nodemailer = require('nodemailer');
const TR = require('./lib/trainer-registry.js');
const EC = require('./lib/enriched-cache.js');

module.exports.config = {};

const USERNAME = process.env.RACING_API_USERNAME;
const PASSWORD = process.env.RACING_API_KEY;
const BASE_URL = 'api.theracingapi.com';
const AUTH = Buffer.from((USERNAME || '') + ':' + (PASSWORD || '')).toString('base64');

const UPSTASH_URL = process.env.UPSTASH_REDIS_REST_URL;
const UPSTASH_TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN;

// Hard wall-clock ceiling on every Racing API request. Without it a hung
// request never rejected: Promise.allSettled waited on it forever, the whole
// sweep sat until Netlify killed the function, and neither the run record nor
// the "Racecards" email was ever written (2026-09-14 23:00, and again on a
// manual fire the next night). Same Promise.race pattern as the Claude calls;
// the timer also destroys the socket so an abandoned request cannot keep the
// function alive after the race has been lost.
const API_TIMEOUT_MS = 20000;
function apiGet(path) {
  let req = null, timer = null;
  const raw = new Promise((resolve, reject) => {
    const options = {
      hostname: BASE_URL,
      path: path,
      method: 'GET',
      headers: {
        'Authorization': 'Basic ' + AUTH,
        'Accept': 'application/json'
      }
    };
    req = https.request(options, (res) => {
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
  const ceiling = new Promise((_, reject) => {
    timer = setTimeout(() => {
      const err = new Error('Racing API timed out after ' + (API_TIMEOUT_MS / 1000) + 's: ' + path);
      try { if (req) req.destroy(err); } catch (e) {}
      reject(err);
    }, API_TIMEOUT_MS);
  });
  return Promise.race([raw, ceiling]).finally(() => { if (timer) clearTimeout(timer); });
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// One short-backoff retry for a date that fails on its first attempt. Cheap
// and resolves transient network blips / momentary upstream hiccups without
// adding meaningful extra load or latency to the batch.
async function apiGetWithRetry(path, retries) {
  try {
    return await apiGet(path);
  } catch (e) {
    if (retries > 0) {
      await sleep(1500);
      return apiGetWithRetry(path, retries - 1);
    }
    throw e;
  }
}

function redisSet(key, value) {
  const url = new URL(UPSTASH_URL);
  const body = JSON.stringify(value);
  return new Promise((resolve, reject) => {
    const req = https.request({
      hostname: url.hostname, path: '/set/' + encodeURIComponent(key), method: 'POST',
      headers: { 'Authorization': 'Bearer ' + UPSTASH_TOKEN, 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) }
    }, res => { let d = ''; res.on('data', c => d += c); res.on('end', () => { if(res.statusCode !== 200){ return reject(new Error('Redis write failed: HTTP '+res.statusCode+' '+d)); } try { const parsed=JSON.parse(d); if(parsed && parsed.error){ return reject(new Error('Redis write error: '+parsed.error)); } } catch(e){} resolve(d); }); });
    req.on('error', reject); req.write(body); req.end();
  });
}

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

const SILK_PALETTE = [
  {body:'#0a2a6e',sleeve:'#ffffff',cap:'#0a2a6e'},
  {body:'#c0392b',sleeve:'#ffffff',cap:'#c0392b'},
  {body:'#1a3a8f',sleeve:'#f0c040',cap:'#1a3a8f'},
  {body:'#1e6b3a',sleeve:'#ffffff',cap:'#1e6b3a'},
  {body:'#1a1a1a',sleeve:'#e07020',cap:'#1a1a1a'},
  {body:'#6a2fa0',sleeve:'#ffffff',cap:'#6a2fa0'},
  {body:'#1a5276',sleeve:'#f39c12',cap:'#1a5276'},
  {body:'#76b041',sleeve:'#ffffff',cap:'#2e4b1e'},
  {body:'#922b21',sleeve:'#f9e79f',cap:'#922b21'},
  {body:'#1f3a93',sleeve:'#ff6b6b',cap:'#1f3a93'},
  {body:'#117a65',sleeve:'#ffffff',cap:'#117a65'},
  {body:'#6e2f1a',sleeve:'#f0d87a',cap:'#6e2f1a'},
  {body:'#0d3b6e',sleeve:'#e67e22',cap:'#0d3b6e'},
  {body:'#7d3c98',sleeve:'#f8c471',cap:'#7d3c98'},
  {body:'#1b2631',sleeve:'#85c1e9',cap:'#1b2631'},
  {body:'#a93226',sleeve:'#ffffff',cap:'#1a5276'},
];

function parsePosition(pos) {
  if (!pos) return 0;
  const s = String(pos).trim();
  if (/^[0-9]+$/.test(s)) return parseInt(s, 10);
  return 0; // F, UR, P, BD, etc. — display as 0 (fell/non-finish)
}

function formatRunDate(dateStr) {
  if (!dateStr) return { year: '', date: '' };
  const months = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
  const parts = dateStr.split('-');
  if (parts.length !== 3) return { year: dateStr, date: '' };
  const y = parts[0], m = parseInt(parts[1], 10) - 1, d = parseInt(parts[2], 10);
  return { year: y, date: String(d).padStart(2, '0') + ' ' + (months[m] || '') };
}

// A price is usable only when it is actually fractional-shaped ("15/2",
// "evn"/"evs"). Exchanges such as Matchbook put DECIMAL odds ("6.6", "46")
// in the API's `fractional` field and do not say "exchange" in their name —
// without this check the non-exchange fallback below could hand a decimal
// to the card. Same rule as refresh-prices-background.js / racecards.js.
function isUsablePrice(fractional) {
  const f = String(fractional || '').trim();
  if (!f || f === '-' || f.toUpperCase() === 'SP') return false;
  return /^\d+\/\d+$/.test(f) || /^ev[ns]$/i.test(f);
}

// Standard UK/Irish board ladder. Any usable fractional is snapped to the
// nearest rung by decimal value (an exact tie takes the shorter price), so a
// bookmaker's 85/40 or 100/30 never reaches a prompt, card or record. A price
// already on the ladder passes through unchanged; evens is written 'EVS'.
// Anything that is not a usable price comes back as 'SP'.
const BOARD_LADDER = ['1/10', '1/9', '1/8', '1/7', '1/6', '1/5', '2/9', '1/4', '2/7', '3/10', '1/3', '4/11', '2/5', '4/9', '1/2', '8/15', '4/7', '8/13', '4/6', '8/11', '4/5', '5/6', '10/11', '1/1', '11/10', '6/5', '5/4', '11/8', '6/4', '13/8', '7/4', '15/8', '2/1', '9/4', '5/2', '11/4', '3/1', '10/3', '7/2', '4/1', '9/2', '5/1', '11/2', '6/1', '13/2', '7/1', '15/2', '8/1', '17/2', '9/1', '10/1', '11/1', '12/1', '14/1', '16/1', '18/1', '20/1', '22/1', '25/1', '28/1', '33/1', '40/1', '50/1', '66/1', '80/1', '100/1', '125/1', '150/1', '200/1'];
function toBoardPrice(fractional) {
  const f = String(fractional || '').trim();
  if (!isUsablePrice(f)) return 'SP';
  if (/^ev[ns]$/i.test(f)) return 'EVS';
  const m = f.match(/^(\d+)\/(\d+)$/);
  const dec = Number(m[1]) / Number(m[2]);
  let best = null, bestDiff = Infinity;
  BOARD_LADDER.forEach(function(r) {
    const p = r.split('/');
    const diff = Math.abs(Number(p[0]) / Number(p[1]) - dec);
    if (diff < bestDiff) { bestDiff = diff; best = r; }   // ladder ascends: a tie keeps the shorter price
  });
  return best === '1/1' ? 'EVS' : best;
}

function extractPrice(oddsArr, bookmaker) {
  if (!Array.isArray(oddsArr) || !oddsArr.length) return 'SP';
  const bk = (bookmaker || '').toLowerCase();
  const match = oddsArr.find(function(o) {
    return (o.bookmaker || '').toLowerCase() === bk;
  });
  if (match && isUsablePrice(match.fractional)) return toBoardPrice(match.fractional);
  // fall back to first non-exchange bookmaker with a fractional price
  const fallback = oddsArr.find(function(o) {
    return isUsablePrice(o.fractional) && !(o.bookmaker || '').toLowerCase().includes('exchange');
  });
  return fallback ? toBoardPrice(fallback.fractional) : 'SP';
}

function mapRunner(r, idx) {
  const oddsArr = Array.isArray(r.odds) ? r.odds : (Array.isArray(r.price) ? r.price : null);
  const rawResults = r.past_results_ordered || r.results || r.past_results || [];
  const history = rawResults.slice(0, 6).map(function(h) {
    const fd = formatRunDate(h.date);
    return {
      year: fd.year,
      date: fd.date,
      course: h.course || '',
      hand: '',
      dist: h.distance || h.dist || '',
      going: h.going || '',
      pos: parsePosition(h.position || h.pos),
      ran: h.ran || h.runners || 0,
      wt: h.weight || h.weight_lbs || '',
      or: h.official_rating || h.ofr || h.or || 0,
      jockey: h.jockey || '',
      sp: h.sp_dec || h.sp || '',
      winner: h.winner || ''
    };
  });

  // Headgear decode
  const hgMap = {b:'Blinkers',c:'Cheekpieces',e:'Eye Shields',h:'Hood',p:'Pacifiers',t:'Tongue Tie',v:'Visor',w:'Sheepskin Noseband'};
  const headgear = (r.headgear||'').split('').map(function(c){ return hgMap[c]||c; }).filter(Boolean).join(', ');

  // Trainer 14-day form
  const t14 = r.trainer_14_days || {};

  // Medical / wind surgery
  const windSurgery = (r.medical||[]).some(function(m){ return (m.type||'').toLowerCase().includes('wind'); });

  // Past results flags (C=course, D=distance, CD, BF=beaten fav)
  const flags = r.past_results_flags || [];

  return {
    n: r.number || (idx + 1),
    horse_id: r.horse_id || '',
    name: r.horse || 'Unknown',
    jockey: r.jockey || '',
    jockey_id: r.jockey_id || '',
    trainer: r.trainer || '',
    trainer_id: r.trainer_id || '',
    price: extractPrice(oddsArr, 'Boyle Sports'),
    pick: false,
    form: r.form || '',
    wt: r.lbs ? Math.floor(r.lbs/14)+'st '+(r.lbs%14)+'lb' : '',
    or: r.ofr || 0,
    rpr: r.rpr || 0,
    ts: r.ts || 0,
    draw: r.draw || '',
    age: r.age || '',
    sex: r.sex || '',
    sire: r.sire || '',
    dam: r.dam || '',
    // Bloodline + connections, kept exactly as the pro racecard sends them.
    // The ids key the ancestor:stats:{id} cache the chevron's bloodline
    // panel reads; prev_trainers is the API's own spell record.
    sire_id: r.sire_id || '',
    dam_id: r.dam_id || '',
    damsire: r.damsire || '',
    damsire_id: r.damsire_id || '',
    owner: r.owner || '',
    owner_id: r.owner_id || '',
    prev_trainers: Array.isArray(r.prev_trainers) ? r.prev_trainers.map(function(t) {
      return { trainer: (t && t.trainer) || '', trainer_id: (t && t.trainer_id) || '', change_date: (t && t.change_date) || '' };
    }) : [],
    headgear: headgear,
    headgearCode: r.headgear || '',
    headgearRun: r.headgear_run || '',
    windSurgery: windSurgery,
    windSurgeryRun: r.wind_surgery_run || '',
    flags: flags,
    spotlight: r.spotlight || '',
    comment: r.comment || '',
    lastRun: r.last_run || '',
    trainer14: { runs: t14.runs||0, wins: t14.wins||0, pct: t14.percent||0 },
    trainerRtf: r.trainer_rtf || '',
    silk: SILK_PALETTE[idx % SILK_PALETTE.length],
    history: history
  };
}

function calcNextMins(offDt) {
  if (!offDt) return 0;
  return Math.max(0, Math.round((new Date(offDt) - new Date()) / 60000));
}

// Extract local HH:MM minutes from an ISO datetime string like "2026-06-04T17:40:00+01:00"
function offDtToMins(offDt) {
  if (!offDt) return 0;
  const m = offDt.match(/T(\d{2}):(\d{2})/);
  return m ? parseInt(m[1], 10) * 60 + parseInt(m[2], 10) : 0;
}

// Extract 24-hour time string "HH:MM" from ISO datetime
function offDtTo24h(offDt) {
  if (!offDt) return '';
  const m = offDt.match(/T(\d{2}):(\d{2})/);
  return m ? m[1] + ':' + m[2] : '';
}

function mapRacecards(apiData) {
  const racecards = (apiData && apiData.racecards) ? apiData.racecards : [];
  const byVenue = {};
  const venueOrder = [];

  racecards.forEach(function(race) {
    const rawId = race.course_id || (race.course || '').toLowerCase().replace(/\s+/g, '-').replace(/[^a-z0-9-]/g, '');
    if (!rawId) return;
    const reg = (race.region || '').toUpperCase();
    if (reg !== 'GB' && reg !== 'IRE' && reg !== 'IE') return;

    if (!byVenue[rawId]) {
      byVenue[rawId] = {
        id: rawId,
        flag: (reg === 'IRE' || reg === 'IE') ? 'IE' : 'GB',
        name: race.course || rawId,
        hand: 'LH',
        going: race.going || race.going_detailed || '',
        feature: false,
        nextMins: 0,
        insights: [],
        races: []
      };
      venueOrder.push(rawId);
    }

    const runners = (race.runners || [])
      .filter(function(r) { return !r.is_non_runner && String(r.number) !== 'NR'; })
      .map(function(r, i) { return mapRunner(r, i); });

    byVenue[rawId].races.push({
      t: offDtTo24h(race.off_dt) || race.off_time || '',
      t24: offDtToMins(race.off_dt),
      _offDt: race.off_dt || '',
      r: runners.length || (race.field_size || 0),
      name: race.race_name || '',
      dist: race.distance || '',
      going: race.going || race.going_detailed || '',
      class: race.race_class || '',
      pattern: race.pattern || '',
      rating_band: race.rating_band || '',
      prize: race.prize || '',
      type: race.type || '',
      tip: race.tip || '',
      verdict: race.verdict || '',
      runners: runners
    });
  });

  const allMeetings = venueOrder.map(function(id) {
    const m = byVenue[id];
    m.races.sort(function(a, b) { return (a.t24 || 0) - (b.t24 || 0); });
    if (m.races.length) m.nextMins = calcNextMins(m.races[0]._offDt);
    return m;
  }).filter(function(m) {
    // Status-based only — never exclude by course name, so every course the
    // daily build can recommend is present for intelligence card CTAs.
    if ((m.going || '').toLowerCase() === 'abandoned') return false;
    return true;
  });

  allMeetings.forEach(function(m, idx) { m.feature = idx === 0; });
  return allMeetings;
}

exports.handler = async function(event) {
  const MONTHS_SHORT_FC = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
  const MONTHS_FULL_FC = ['January','February','March','April','May','June','July','August','September','October','November','December'];
  const DAYS_E_FC = ['Sunday','Monday','Tuesday','Wednesday','Thursday','Friday','Saturday'];
  const shortDt_FC = function(s) { const d = new Date(s + 'T12:00:00Z'); return d.getUTCDate() + ' ' + MONTHS_SHORT_FC[d.getUTCMonth()]; };
  const _fcNow = new Date();
  const fcHeaderDate = DAYS_E_FC[_fcNow.getDay()] + ' ' + _fcNow.getDate() + ' ' + MONTHS_FULL_FC[_fcNow.getMonth()] + ' ' + _fcNow.getFullYear();

  try {
    const dates = [];
    const base = new Date();
    // Manual single-day refetch: ?date=YYYY-MM-DD (via the trigger twin, which
    // carries the secret check) rewrites just that card — including today's,
    // which the nightly day+1..+7 sweep never touches. Absent: the sweep as before.
    const qsDate = event && event.queryStringParameters && event.queryStringParameters.date;
    if (qsDate && /^\d{4}-\d{2}-\d{2}$/.test(qsDate)) {
      dates.push(qsDate);
    } else {
    for (var i = 1; i <= 7; i++) {
      const d = new Date(base.getFullYear(), base.getMonth(), base.getDate() + i);
      const y = d.getFullYear();
      const mo = String(d.getMonth() + 1).padStart(2, '0');
      const dy = String(d.getDate()).padStart(2, '0');
      dates.push(y + '-' + mo + '-' + dy);
    }
    }

    // Fetch + store in small batches with a delay between batches, mirroring the
    // pattern in fetch-horse-history-1/2-background.js ("to avoid rate limits").
    // Two problems with firing all 7 requests at once via Promise.all:
    //  1. 7 concurrent hits on the Racing API risk tripping its rate limiting.
    //  2. Promise.all rejects on the FIRST failure and returns from the handler
    //     right away — any other date whose fetch/redis-write was still in flight
    //     gets abandoned mid-operation instead of being allowed to finish or fail
    //     on its own. Promise.allSettled isolates each date's outcome so one
    //     failure can't take down its siblings.
    const BATCH = 3;
    const results = [];
    for (var bi = 0; bi < dates.length; bi += BATCH) {
      const batch = dates.slice(bi, bi + BATCH);
      const settled = await Promise.allSettled(batch.map(async function(dateStr) {
        const data = await apiGetWithRetry('/v1/racecards/pro?date=' + dateStr, 1);
        if (!data.racecards || !data.racecards.length) {
          return { dateStr, stored: false };
        }
        const meetings = mapRacecards(data);
        await redisSet('racecards:' + dateStr, { meetings, storedAt: new Date().toISOString() });
        // meetings travel on the result for the one registry pass below,
        // then are stripped before the debug write.
        return { dateStr, stored: true, meetings };
      }));
      settled.forEach(function(r, idx) {
        if (r.status === 'fulfilled') {
          results.push(r.value);
        } else {
          results.push({ dateStr: batch[idx], stored: false, error: (r.reason && r.reason.message) || String(r.reason) });
        }
      });
      if (bi + BATCH < dates.length) await sleep(1000);
    }

    // Trainer registry maintenance (lib/trainer-registry.js): every stored
    // card keeps trainer:registry current — new ids become entries, unseen
    // name forms become aliases, the newest card form becomes canonical.
    // One load/save AFTER the batches (per-date saves inside Promise.allSettled
    // would race each other), idempotent, and never allowed to fail the fetch.
    try {
      const storedCards = results.filter(function(r) { return r.stored && r.meetings; });
      if (storedCards.length) {
        const registry = await TR.loadRegistry(redisGet);
        let regChanges = 0;
        storedCards.forEach(function(r) { regChanges += TR.updateFromRacecards(registry, r.meetings, r.dateStr); });
        if (regChanges) await TR.saveRegistry(redisSet, registry);
        console.log('[fetch-future-cards] trainer registry: ' + regChanges + ' touch(es), ' + Object.keys(registry).length + ' trainers');
      }
    } catch (eReg) {
      console.log('[fetch-future-cards] trainer registry update failed: ' + eReg.message);
    }
    // Fresh cards and (possibly) a fresh registry are both in — drop the
    // enriched cache for every stored date AFTER the registry pass, so the
    // next read rebuilds with both. Best-effort like everything above.
    try { await EC.invalidate(results.filter(function(r) { return r.stored; }).map(function(r) { return r.dateStr; })); } catch (eInv) {}
    // Capture per-date summary BEFORE deleting meetings from results.
    const perDateSummary = results.map(function(r) {
      if (!r.stored || !r.meetings) return { dateStr: r.dateStr, stored: false, error: r.error };
      let raceCount = 0, horseCount = 0;
      const courseSet = new Set();
      r.meetings.forEach(function(m) {
        (m.races || []).forEach(function(race) {
          raceCount++;
          horseCount += (race.runners || []).length;
        });
        if (m.name) courseSet.add((m.name).replace(/ \([A-Z]{2,4}\)$/i, ''));
      });
      return { dateStr: r.dateStr, stored: true, raceCount: raceCount, horseCount: horseCount, courses: Array.from(courseSet) };
    });

    results.forEach(function(r) { delete r.meetings; });

    const stored = results.filter(function(r) { return r.stored; }).length;
    const empty = results.filter(function(r) { return !r.stored; }).length;

    // Background Functions discard the handler's return value, so this is the
    // only way to inspect the real per-date results (including error messages)
    // after the run without access to live Netlify function logs.
    try {
      await redisSet('debug:fetch-future-cards:' + new Date().toISOString(), results);
    } catch (e) {
      // Don't let a debug-write failure mask the real run outcome.
    }

    // Racecard Fetch completion email
    try {
      const fetchSubject = 'Racing Edge — Racecard Fetch · ' + fcHeaderDate + ' · 23:00 run';
      const isFullSweep = !qsDate && dates.length === 7;
      const fetchLines = [fetchSubject, '', 'Days fetched: ' + dates.length + (isFullSweep ? ' (today+1 through today+7)' : '')];
      perDateSummary.forEach(function(s) {
        if (s.stored) {
          fetchLines.push(shortDt_FC(s.dateStr) + ': ' + s.raceCount + ' races · ' + s.horseCount + ' horses — ' + s.courses.join(' · '));
        } else {
          fetchLines.push(shortDt_FC(s.dateStr) + ': failed — ' + (s.error || 'empty response'));
        }
      });
      const failedList = perDateSummary.filter(function(s) { return !s.stored; });
      fetchLines.push('', 'Failed: ' + (failedList.length ? failedList.map(function(s) { return shortDt_FC(s.dateStr) + ' (' + (s.error || 'empty') + ')'; }).join(' · ') : 'None'));
      await sendNotification(fetchSubject, fetchLines.join('\n'));
    } catch (e) { /* notification errors are swallowed inside sendNotification itself */ }

    // Tomorrow's Daily Intelligence readiness check — only send when ready.
    // Not Ready case is covered by the Future Cards Watchdog at 23:30.
    try {
      const tmrBase = new Date();
      const td = new Date(tmrBase.getFullYear(), tmrBase.getMonth(), tmrBase.getDate() + 1);
      const tomorrowDate = td.getFullYear() + '-' + String(td.getMonth() + 1).padStart(2, '0') + '-' + String(td.getDate()).padStart(2, '0');

      const tomorrowIntel = await redisGet('intelligence:' + tomorrowDate);
      const tomorrowItems = (tomorrowIntel && tomorrowIntel.items) || [];
      const ready = tomorrowItems.length > 0;

      if (ready) {
        const tmrWeekday = DAYS_E_FC[td.getDay()];
        const tmrHuman = tmrWeekday + ' ' + td.getDate() + ' ' + MONTHS_FULL_FC[td.getMonth()] + ' ' + td.getFullYear();
        const tmrSummary = perDateSummary.find(function(s) { return s.dateStr === tomorrowDate; });
        const tmrCourses = (tmrSummary && tmrSummary.courses) || [];
        const tmrRaces = tmrSummary ? tmrSummary.raceCount : '?';
        const signalNames = tomorrowItems.map(function(item) { return item.signalType || 'Unknown'; }).join(', ');
        const readySubject = 'Racing Edge — Tomorrow Ready · ' + fcHeaderDate + ' · 23:00 run';
        const readyBody = [
          readySubject,
          '',
          tmrHuman + ' — ' + tmrRaces + ' races across ' + tmrCourses.length + ' courses',
          'Courses: ' + (tmrCourses.length ? tmrCourses.join(' · ') : 'none'),
          '',
          'Signals: ' + (tomorrowItems.length ? signalNames : 'No signals')
        ].join('\n');
        const readyTransporter = nodemailer.createTransport({
          service: 'gmail',
          auth: { user: process.env.GMAIL_USER, pass: process.env.GMAIL_APP_PASSWORD }
        });
        await readyTransporter.sendMail({
          from: process.env.GMAIL_USER,
          to: 'gcoyne87@gmail.com',
          subject: readySubject,
          text: readyBody
        });
      }
    } catch (e) {
      // Swallow — this email must never affect the job's own outcome or the email above.
    }

    return {
      statusCode: 200,
      body: JSON.stringify({ ok: true, stored, empty, dates: results })
    };
  } catch(e) {
    try {
      await sendNotification('Racing Edge — Racecard Fetch · ' + fcHeaderDate + ' · 23:00 run', [
        'Timestamp: ' + new Date().toISOString(),
        'Job failed before completion.',
        'Error: ' + e.message
      ].join('\n'));
    } catch (e2) { /* notification errors are swallowed inside sendNotification itself */ }

    return {
      statusCode: 500,
      body: JSON.stringify({ error: e.message })
    };
  }
};
