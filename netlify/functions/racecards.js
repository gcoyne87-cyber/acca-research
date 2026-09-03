const https = require('https');
const TRAINER_LOCATIONS = require('./data/trainer-locations.json');

const USERNAME = process.env.RACING_API_USERNAME;
const PASSWORD = process.env.RACING_API_KEY;
const BASE_URL = 'api.theracingapi.com';
const AUTH = Buffer.from((USERNAME || '') + ':' + (PASSWORD || '')).toString('base64');

// Netlify functions run on UTC servers — new Date().toISOString() rolls over at UTC
// midnight, which during BST is an hour after Irish local midnight, serving stale
// "yesterday" cards to Irish users for that whole window. Use the Europe/Dublin
// calendar date instead so "today" matches what users actually see on their clock,
// and Intl handles the BST/GMT switch automatically.
function irishTodayStr() {
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Dublin' }).formatToParts(new Date());
  const y = parts.find(p => p.type === 'year').value;
  const m = parts.find(p => p.type === 'month').value;
  const d = parts.find(p => p.type === 'day').value;
  return y + '-' + m + '-' + d;
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

const UPSTASH_URL = process.env.UPSTASH_REDIS_REST_URL;
const UPSTASH_TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN;

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

// ── RUNNER TAG FLAGS ─────────────────────────────────────────────────────────
// Server-computed tag flags embedded on each runner — form history is not
// available client-side at render time, so tags must be decided here. First
// tag: isCandDWinner. To add the next tag: add its rule in computeRunnerTags()
// below and a badge check in index.html's runnerRow — nothing else changes.

function stripParens(s) {
  return (s || '').replace(/\s*\([^)]*\)/g, '').toLowerCase().trim();
}

// Hot Yard whitelist — a server-side copy of the 39-name eliteTrainers list in
// index.html's _buildPopularTrainers (the client list can't be read from here).
// If a yard is added there it must be added here too. Stored lowercase for the
// case-insensitive matches below.
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

// "2m1f111y" -> miles*8 + furlongs as an integer, yards ignored — history and
// racecard yardages differ freely for the same trip, so yards must not count.
function milesFurlongs(distStr) {
  const s = String(distStr || '');
  const miles = (s.match(/(\d+)m/) || [])[1];
  const furlongs = (s.match(/(\d+)f/) || [])[1];
  return (miles ? parseInt(miles, 10) : 0) * 8 + (furlongs ? parseInt(furlongs, 10) : 0);
}

function computeRunnerTags(runner, history, meetingName, raceDist, meetingFlag, meetingGoing, hotYardTrainers) {
  const runs = (history || []).slice(0, 6);
  const courseKey = stripParens(meetingName);
  const distKey = milesFurlongs(raceDist);
  const isCandDWinner = runs.some(function(h) {
    return String(h.pos) === '1'
      && stripParens(h.course) === courseKey
      && milesFurlongs(h.dist) === distKey;
  });
  if (isCandDWinner) runner.isCandDWinner = true;

  // Irish Raider — Irish or NI trainer running
  // at a GB meeting
  // GB Raider — GB trainer running at Irish meeting
  var trainerLoc = TRAINER_LOCATIONS.find(function(t){
    return t.name === runner.trainer;
  });
  if(trainerLoc){
    if((trainerLoc.country==='Ireland'||
        trainerLoc.country==='Northern Ireland')
        && meetingFlag==='GB'){
      runner.isIrishRaider = true;
    }
    if(trainerLoc.country==='GB' &&
       meetingFlag==='IE'){
      runner.isGBRaider = true;
    }
  }

  // Ground Lover — today is GENUINELY easy ground AND the horse has
  // won on ground with cut in its last 6 runs. The day test looks at
  // the PRIMARY going term only, so "Good, good to soft in places"
  // days never fire — this tag is meant to be rare. Irish and UK
  // terms both covered: Yielding/Yielding To Soft/Soft/Soft To
  // Heavy/Heavy days qualify; Good To Soft / Good To Yielding do not.
  var EASY_DAY_RE = /^(yielding|soft|heavy)/i;
  var WIN_GROUND_RE = /heavy|yield|soft/i;
  var primaryGoing = String(meetingGoing || '')
    .replace(/^[a-z]+\s*:\s*/i, '')   // strip AW surface prefix e.g. "TAPETA: "
    .split(/[,(]/)[0].trim();          // primary term before any ", x in places" / "(GoingStick"
  if(EASY_DAY_RE.test(primaryGoing)){
    var hasGroundWin = runs.some(function(h){
      return String(h.pos) === '1' &&
             WIN_GROUND_RE.test(h.going || '');
    });
    if(hasGroundWin) runner.isGroundLover = true;
  }

  // Hot Yard — trainer is one of today's top-3 in-form elite yards, computed
  // once per enrichment pass from trainer-form:table:{date} (see
  // enrichRunnerTags). Empty list when the table is missing — tag skipped.
  if(hotYardTrainers && hotYardTrainers.length){
    var _tn = (runner.trainer || '').toLowerCase().trim();
    if(_tn && hotYardTrainers.indexOf(_tn) !== -1) runner.isHotYard = true;
  }
}

// One pipelined Redis round-trip covering every runner's
// form:history:{horse_id}:{date} — per-runner GETs would be hundreds of
// sequential round trips on the request path. Entirely best-effort: a missing
// key, a parse failure, or the whole pipeline failing just leaves runners
// untagged; the racecard response is never blocked or errored by tagging.
async function enrichRunnerTags(meetings, date) {
  try {
    const entries = [];
    (meetings || []).forEach(function(m) {
      (m.races || []).forEach(function(race) {
        (race.runners || []).forEach(function(r) {
          if (r.horse_id) entries.push({ r: r, m: m, race: race });
        });
      });
    });
    if (!entries.length) return meetings;
    const url = new URL(UPSTASH_URL);
    // First pipeline slot: today's trainer form table, for the Hot Yard tag —
    // one extra command on the existing round trip, no separate request.
    const cmds = [['GET', 'trainer-form:table:' + date]].concat(
      entries.map(function(e) { return ['GET', 'form:history:' + e.r.horse_id + ':' + date]; })
    );
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
    if (!Array.isArray(results)) return meetings;
    // Hot Yard trainers — from today's trainer form table (pipeline slot 0):
    // elite-whitelisted, 9+ runs and 4+ wins in 7 days, 7-day strike rate
    // strictly above 14-day (upward trend), top 3 by 7-day rate. A missing
    // key or bad parse leaves the list empty and the tag silently off.
    let hotYardTrainers = [];
    try {
      const tfRaw = results[0] && results[0].result;
      const tfTable = tfRaw ? JSON.parse(tfRaw) : null;
      if (Array.isArray(tfTable)) {
        hotYardTrainers = tfTable.filter(function(t) {
          const name = (t.trainerName || '').toLowerCase().trim();
          const sr14 = t.strikeRate14d != null ? Number(t.strikeRate14d) : (Number(t.strikeRate) || 0);
          return ELITE_TRAINERS_LC.indexOf(name) !== -1
            && Number(t.runners7d) >= 9
            && Number(t.winners7d) >= 4
            && Number(t.strikeRate7d) > sr14;
        }).sort(function(a, b) { return Number(b.strikeRate7d) - Number(a.strikeRate7d); })
          .slice(0, 3)
          .map(function(t) { return (t.trainerName || '').toLowerCase().trim(); });
      }
    } catch (eHY) { hotYardTrainers = []; }
    entries.forEach(function(e, i) {
      try {
        const raw = results[i + 1] && results[i + 1].result;
        if (!raw) return;
        const history = JSON.parse(raw);
        if (!Array.isArray(history)) return;
        computeRunnerTags(e.r, history, e.m.name, e.race.dist, e.m.flag, e.race.going, hotYardTrainers);
      } catch (err) { /* per-horse failure never blocks the card */ }
    });
  } catch (e) { /* enrichment is best-effort by design */ }
  return meetings;
}

exports.handler = async function(event) {
  const headers = {
    'Access-Control-Allow-Origin': '*',
    'Content-Type': 'application/json'
  };

  try {
    const datesParam = event.queryStringParameters && event.queryStringParameters.dates;

    if (datesParam) {
      // Multi-day lookup (Filter by Trainer, 5-day view) — read-only from Redis,
      // no live API calls. A missing/empty racecards:{date} key returns an empty
      // array for that date rather than erroring, so one bad date never breaks
      // the rest of the response.
      const dates = datesParam.split(',').map(function(s) { return s.trim(); }).filter(Boolean);
      const days = await Promise.all(dates.map(async function(d) {
        try {
          const cached = await redisGet('racecards:' + d);
          const meetings = (cached && Array.isArray(cached.meetings)) ? cached.meetings : [];
          // Tag enrichment for each date — without this the multi-day view
          // (trainer filter / Today's Edges) had no isCandDWinner etc. flags
          // on any future day. Best-effort like everywhere else: a failure
          // just leaves that day untagged.
          if (meetings.length) await enrichRunnerTags(meetings, d);
          meetings.forEach(function(m) { m.date = d; });
          return { date: d, meetings: meetings };
        } catch (e) {
          return { date: d, meetings: [] };
        }
      }));
      return {
        statusCode: 200,
        headers,
        body: JSON.stringify({ days: days })
      };
    }

    const dateParam = event.queryStringParameters && event.queryStringParameters.date;

    const today = irishTodayStr();
    const targetDate = dateParam || today;

    // Check Redis cache first for any date, including today — fetch-future-cards-background.js
    // already caches today's card overnight, so a live-API gap (rate limit, provider timing)
    // no longer leaves the page empty when good data is sitting right there.
    const cached = await redisGet('racecards:' + targetDate);
    if (cached && cached.meetings && cached.meetings.length) {
      await enrichRunnerTags(cached.meetings, targetDate);
      return {
        statusCode: 200,
        headers,
        body: JSON.stringify({ meetings: cached.meetings, _fromCache: true })
      };
    }

    // Pro plan — use pro endpoint for both today and future dates
    let data;
    data = await apiGet('/v1/racecards/pro?date=' + targetDate);
    if (!data.racecards || !data.racecards.length) {
      return {
        statusCode: 200,
        headers,
        body: JSON.stringify({ meetings: [], _empty: true })
      };
    }

    if (data.detail && data.detail.toLowerCase().includes('pro plan')) {
      return {
        statusCode: 200,
        headers,
        body: JSON.stringify({ meetings: [], _proRequired: true })
      };
    }

    const meetings = mapRacecards(data);

    // Write-back: this path only runs on a racecards:{date} cache miss (e.g.
    // the nightly fetch-future-cards run was missed). Without it every request
    // for the date re-paid the full live-API round trip all day — slow loads
    // and blank flicker (2026-09-03). Written BEFORE tag enrichment so the
    // stored shape matches what fetch-future-cards-background writes (tags are
    // computed at read time, never stored). Never on empty (early-returned
    // above) or error (thrown to the catch); its own failure is swallowed.
    if (meetings.length) {
      try { await redisSet('racecards:' + targetDate, { meetings: meetings, storedAt: new Date().toISOString() }); }
      catch (eWB) { /* write-back is an optimisation — never block the response */ }
    }

    await enrichRunnerTags(meetings, targetDate);

    return {
      statusCode: 200,
      headers,
      body: JSON.stringify({ meetings: meetings })
    };

  } catch(e) {
    return {
      statusCode: 500,
      headers,
      body: JSON.stringify({ error: e.message })
    };
  }
};
