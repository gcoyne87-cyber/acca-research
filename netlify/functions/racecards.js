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

// One bookmaker locked per race for the whole day (selectRaceBookmaker below
// picks it) — every runner in that race prices off that bookmaker only, so a
// price never silently switches source mid-race. lockedBookmaker omitted/null
// means the race has no lock yet (selectRaceBookmaker found nothing to lock
// to); every runner shows SP until one exists — never a different bookmaker's
// price as a fallback.
function extractPrice(oddsArr, lockedBookmaker) {
  if (!Array.isArray(oddsArr) || !oddsArr.length) return 'SP';
  if (!lockedBookmaker) return 'SP';
  // The API spells even money 'evn'; every parser downstream understands 'EVS',
  // so it is normalised here, the moment it enters the card.
  const match = oddsArr.find(function(o) {
    return (o.bookmaker || '') === lockedBookmaker && o.fractional && o.fractional !== '-';
  });
  const frac = match && match.fractional;
  return frac ? (/^evn$/i.test(frac) ? 'EVS' : frac) : 'SP';
}

// The bookmaker to lock a race to — whichever non-exchange bookmaker has a
// valid fractional price for the most runners in it. null when nobody has
// priced anything yet (every runner stays SP until one does).
function selectRaceBookmaker(runners) {
  const counts = {};
  (runners || []).forEach(function(r) {
    const oddsArr = Array.isArray(r.odds) ? r.odds : (Array.isArray(r.price) ? r.price : null);
    if (!Array.isArray(oddsArr)) return;
    oddsArr.forEach(function(o) {
      const bk = o && o.bookmaker;
      if (!bk || bk.toLowerCase().includes('exchange')) return;
      if (!o.fractional || o.fractional === '-') return;
      counts[bk] = (counts[bk] || 0) + 1;
    });
  });
  let best = null, bestCount = 0;
  Object.keys(counts).forEach(function(bk) {
    if (counts[bk] > bestCount) { bestCount = counts[bk]; best = bk; }
  });
  return best;
}

function mapRunner(r, idx, lockedBookmaker) {
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
    price: extractPrice(oddsArr, lockedBookmaker),
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
    // Bloodline + connections — identical to fetch-future-cards-background.js's
    // mapRunner so a card written by this fallback path carries the same
    // ids the chevron's bloodline panel (ancestor:stats:{id}) keys on.
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
        going: stripGoingStick(race.going || race.going_detailed || ''),
        feature: false,
        nextMins: 0,
        insights: [],
        races: []
      };
      venueOrder.push(rawId);
    }

    const rawRunners = (race.runners || []).filter(function(r) { return !r.is_non_runner && String(r.number) !== 'NR'; });
    // One bookmaker locked for the whole race — every runner below prices off
    // it and only it (see extractPrice/selectRaceBookmaker above).
    const priceBookmaker = selectRaceBookmaker(rawRunners);
    const runners = rawRunners.map(function(r, i) { return mapRunner(r, i, priceBookmaker); });

    byVenue[rawId].races.push({
      t: offDtTo24h(race.off_dt) || race.off_time || '',
      t24: offDtToMins(race.off_dt),
      _offDt: race.off_dt || '',
      r: runners.length || (race.field_size || 0),
      name: race.race_name || '',
      dist: race.distance || '',
      going: stripGoingStick(race.going || race.going_detailed || ''),
      class: race.race_class || '',
      pattern: race.pattern || '',
      rating_band: race.rating_band || '',
      prize: race.prize || '',
      type: race.type || '',
      tip: race.tip || '',
      verdict: race.verdict || '',
      priceBookmaker: priceBookmaker,
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

// Strips the clerk's GoingStick reading from a going (or race-name) string:
// any "(GoingStick: 7.7)" parenthetical and any bare "GoingStick: 7.7"
// fragment, then trailing separators. Applied at every write of going /
// going_detailed so the reading never reaches the cached card.
function stripGoingStick(s) {
  return String(s || '')
    .replace(/\s*\([^)]*going\s*stick[^)]*\)/gi, '')
    .replace(/[\s,;:\-]*\bgoing\s*stick\b[^,)]*/gi, '')
    .replace(/[\s,;:\-]+$/, '')
    .trim();
}

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

// Proven Class Drop — parses "Class 4" -> 4. Class 1 is the highest class;
// a higher number is a lower class. Shared by provenClassDrop below.
function parseClassNum(classStr) {
  const m = /class\s*(\d+)/i.exec(String(classStr || ''));
  return m ? parseInt(m[1], 10) : null;
}

// provenClassDrop — a runner dropping exactly one class from its most
// recent class-numbered run, proven at that higher level, in form, and rated
// among today's best. Only called for GB meetings (see its call site inside
// computeRunnerTags) — Irish races never reach this function, satisfying
// "Irish races cannot qualify" without needing the meeting flag as its own
// parameter.
//
// race._offDt carries today's race date (e.g. "2026-10-01T17:00:00+01:00");
// its first 10 characters are used as the cutoff so historyRows dated on or
// after today's race are never treated as "prior" form.
//
// provenClassDropDetail holds the one and only copy of the T1-T4 rule and
// returns the qualifying detail (for the Class Drop Daily Intelligence
// card's prompt) or null; provenClassDrop is a thin boolean wrapper over it
// so the tag check and the card both run the exact same gates in the exact
// same order — nothing about who qualifies changes from before this split.
function provenClassDropDetail(runner, race, fieldRunners, historyRows) {
  const todayClassNum = parseClassNum(race && race.class);
  if (todayClassNum === null) return null;

  const raceDateStr = String((race && race._offDt) || '').slice(0, 10);
  if (!raceDateStr) return null;

  // Rows strictly before today's race, newest first. form:history rows are
  // already stored newest-first, but re-sorted defensively rather than
  // assumed, since this tag's correctness depends on "most recent run"
  // meaning the literal newest date, not just array position 0.
  const priorRows = (historyRows || [])
    .filter(function(r) { return r && r.date && r.date < raceDateStr; })
    .slice()
    .sort(function(a, b) { return String(b.date).localeCompare(String(a.date)); });
  if (!priorRows.length) return null;

  const lastRun = priorRows[0];
  const lastRunClassNum = parseClassNum(lastRun.race_class);
  if (lastRunClassNum === null) return null;

  // T1 — today's class number is exactly one higher (one class lower) than
  // the last run's. A same-class run, a rise, or a drop of 2+ classes fails.
  if (todayClassNum !== lastRunClassNum + 1) return null;

  // T2 — at least 2 top-3 finishes within the 6 most recent runs, in races
  // whose class number is equal to or lower than the last run's (i.e. the
  // level just dropped from, or a harder one). Runs with no class number
  // never count toward this, in either direction.
  const last6 = priorRows.slice(0, 6);
  const provenRuns = last6.filter(function(r) {
    const cls = parseClassNum(r.race_class);
    if (cls === null || cls > lastRunClassNum) return false;
    const pos = parseInt(r.pos, 10);
    return !isNaN(pos) && pos >= 1 && pos <= 3;
  });
  if (provenRuns.length < 2) return null;

  // T3 — ran well last time: finishing position <= field size / 2. A
  // non-finisher code (PU/F/UR/BD/RO/SU/DSQ, or anything else non-numeric)
  // and a missing/zero field size both fail via the NaN checks below.
  const lastPos = parseInt(lastRun.pos, 10);
  const lastRan = parseInt(lastRun.ran, 10);
  if (isNaN(lastPos) || isNaN(lastRan) || lastRan <= 0) return null;
  if (lastPos > lastRan / 2) return null;

  // T4 — today's official rating (stored as `or`) is among the top 3 of
  // today's declared, non-runner-excluded, rated field. Ties at 3rd-highest
  // all pass. A runner with no rating (or stored as 0, the mapper's default
  // for "no rating") fails.
  const ratedField = (fieldRunners || [])
    .filter(function(r) { return !(r.nonRunner === true || r.price === 'NR'); })
    .map(function(r) { return parseInt(r.or, 10); })
    .filter(function(n) { return !isNaN(n) && n > 0; });
  const thisRating = parseInt(runner.or, 10);
  if (isNaN(thisRating) || thisRating <= 0) return null;
  const distinctSorted = Array.from(new Set(ratedField)).sort(function(a, b) { return b - a; });
  const top3Threshold = distinctSorted.length >= 3 ? distinctSorted[2] : (distinctSorted[distinctSorted.length - 1] || 0);
  if (thisRating < top3Threshold) return null;

  return {
    todayClassNum: todayClassNum,
    lastRunClassNum: lastRunClassNum,
    qualifyingRuns: provenRuns.map(function(r) { return { pos: r.pos, ran: r.ran, race_class: r.race_class, course: r.course, date: r.date }; }),
    lastRun: { pos: lastRun.pos, ran: lastRun.ran, race_class: lastRun.race_class, course: lastRun.course, date: lastRun.date },
    ratingRank: distinctSorted.indexOf(thisRating) + 1,
    ratedFieldSize: distinctSorted.length
  };
}
function provenClassDrop(runner, race, fieldRunners, historyRows) {
  return !!provenClassDropDetail(runner, race, fieldRunners, historyRows);
}

function computeRunnerTags(runner, history, meetingName, raceDist, meetingFlag, meetingGoing, hotYardTrainers, race) {
  const runs = (history || []).slice(0, 6);
  const courseKey = stripParens(meetingName);
  const distKey = milesFurlongs(raceDist);

  // C&D Winner / C&D+G — refresh-prices-background.js's hourly recheck
  // (recheckCandDGoing) already writes an exact-match isCandDGoing verdict
  // (true OR explicit false) directly onto this same runner object in
  // racecards:{date}. That verdict is strictly more trustworthy than the
  // bucket-regex approach below (going strings from the racecard endpoint and
  // the form-history endpoint are shaped differently — a loose bucket match
  // can disagree with an exact match either way). Recomputing here every
  // request was silently overwriting the persisted result with the looser
  // bucket answer on every page load — so ANY persisted verdict, true or
  // false, is kept as-is and the bucket recomputation below is skipped
  // entirely for this runner. Only a runner the hourly recheck has never
  // touched (isCandDGoing still undefined) falls through to recomputation.
  if (runner.isCandDGoing !== undefined) {
    // Mutual-exclusivity invariant — recheckCandDGoing itself guarantees this
    // on write when the verdict is true; enforced here too so a runner that
    // somehow arrived with both flags true is never served that way.
    if (runner.isCandDGoing === true) runner.isCandDWinner = false;
  } else {
    const isCandDWinner = runs.some(function(h) {
      return String(h.pos) === '1'
        && stripParens(h.course) === courseKey
        && milesFurlongs(h.dist) === distKey;
    });
    if (isCandDWinner) runner.isCandDWinner = true;

    // C&D+G — a stronger version of C&D Winner: the horse's course-and-distance
    // win came on EXACTLY today's going. Same exact primary-term comparison as
    // the hourly recheck (recheckCandDGoing) and the Ground Lover tag below —
    // previously this fallback used a loose /heavy|yield|soft/ substring test,
    // so a "Good To Soft" C&D win earned +G on a Heavy day (caught live
    // 2026-09-05). Day still gated to genuinely easy ground so the tag stays
    // rare. Takes priority over C&D Winner — a horse must never show both.
    // Only reached when no persisted exact-match verdict exists yet (see above).
    var CDG_EASY_DAY_RE = /^(yielding|soft|heavy)/i;
    var cdgPrimaryGoing = String(meetingGoing || '')
      .replace(/^[a-z]+\s*:\s*/i, '')
      .split(/[,(]/)[0].trim();
    if (CDG_EASY_DAY_RE.test(cdgPrimaryGoing)) {
      var cdgDayKey = cdgPrimaryGoing.toLowerCase();
      const isCandDGoing = runs.some(function(h) {
        if (String(h.pos) !== '1') return false;
        if (stripParens(h.course) !== courseKey) return false;
        if (milesFurlongs(h.dist) !== distKey) return false;
        var cdgWinGoing = String(h.going || '')
          .toLowerCase()
          .replace(/^[a-z]+\s*:\s*/i, '')
          .split(/[,(]/)[0].trim();
        return cdgWinGoing === cdgDayKey;
      });
      if (isCandDGoing) {
        runner.isCandDGoing = true;
        runner.isCandDWinner = false;
      }
    }
  }

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

  // Ground Lover — today is GENUINELY easy ground AND the horse has won on
  // EXACTLY today's going in its last 6 runs. Exact match, not family match:
  // a Heavy day needs a Heavy win, a Soft day a Soft win, a Yielding day a
  // Yielding win (2026-09-05: a stale Soft winner was tagged on a Heavy
  // Haydock card — accurate data, not close-ish data). Both sides compare
  // the PRIMARY going term (strip AW prefix, cut at first comma/bracket,
  // lowercase), so "Good, good to soft in places" days never fire and a
  // decorated history going can't dodge the comparison.
  var EASY_DAY_RE = /^(yielding|soft|heavy)/i;
  var primaryGoing = String(meetingGoing || '')
    .replace(/^[a-z]+\s*:\s*/i, '')   // strip AW surface prefix e.g. "TAPETA: "
    .split(/[,(]/)[0].trim();          // primary term before any ", x in places" / "(GoingStick"
  if(EASY_DAY_RE.test(primaryGoing)){
    var dayGoingKey = primaryGoing.toLowerCase();
    var hasGroundWin = runs.some(function(h){
      if (String(h.pos) !== '1') return false;
      var winPrimaryGoing = String(h.going || '')
        .toLowerCase()
        .replace(/^[a-z]+\s*:\s*/i, '')
        .split(/[,(]/)[0].trim();
      return winPrimaryGoing === dayGoingKey;
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

  // Proven Class Drop — GB meetings only; this is what makes "Irish races
  // cannot qualify" true without provenClassDrop needing the meeting flag
  // itself as a parameter.
  if (meetingFlag === 'GB' && race) {
    if (provenClassDrop(runner, race, race.runners, history)) runner.isProvenClassDrop = true;
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
          return Number(t.runners7d) >= 4
            && Number(t.winners7d) >= 4
            && Number(t.strikeRate7d) > sr14
            && Number(t.strikeRate7d) >= 30;
        }).sort(function(a, b) { return Number(b.strikeRate7d) - Number(a.strikeRate7d); })
          .slice(0, 3)
          .map(function(t) { return (t.trainerName || '').toLowerCase().trim(); });
      }
    } catch (eHY) { hotYardTrainers = []; }
    entries.forEach(function(e, i) {
      try {
        // A missing or unparseable form:history key must NOT skip tagging
        // outright — Hot Yard and Irish/GB Raider are trainer-based and don't
        // need history at all. Pass an empty history instead: the form-based
        // tags (C&D, C&D+G, Ground Lover) simply find no runs and stay off,
        // while the trainer-based tags still fire for debutants and any horse
        // whose history fetch was missed.
        const raw = results[i + 1] && results[i + 1].result;
        let history = [];
        if (raw) {
          try { const parsed = JSON.parse(raw); if (Array.isArray(parsed)) history = parsed; } catch (eH) { history = []; }
        }
        computeRunnerTags(e.r, history, e.m.name, e.race.dist, e.m.flag, e.race.going, hotYardTrainers, e.race);
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

exports.enrichRunnerTags = enrichRunnerTags;
exports.computeRunnerTags = computeRunnerTags;
exports.provenClassDropDetail = provenClassDropDetail;
