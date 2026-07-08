const https = require('https');

module.exports.config = { schedule: '0 23 * * *' };

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
        try { resolve(JSON.parse(data)); }
        catch(e) { reject(new Error('Parse error: ' + data.substring(0, 200))); }
      });
    });
    req.on('error', reject);
    req.end();
  });
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
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

const EXCLUDED_COURSES = ['bath', 'thirsk', 'musselburgh', 'clonmel', 'hexham'];

function mapRacecards(apiData) {
  const racecards = (apiData && apiData.racecards) ? apiData.racecards : [];
  const byVenue = {};
  const venueOrder = [];

  racecards.forEach(function(race) {
    const rawId = race.course_id || (race.course || '').toLowerCase().replace(/\s+/g, '-').replace(/[^a-z0-9-]/g, '');
    if (!rawId) return;
    if (EXCLUDED_COURSES.indexOf((race.course || '').toLowerCase().trim()) !== -1) return;

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
    if ((m.going || '').toLowerCase() === 'abandoned') return false;
    var name = (m.name || '').toLowerCase();
    if (name === 'newton abbot' || name === 'market rasen') return false;
    return true;
  });

  allMeetings.forEach(function(m, idx) { m.feature = idx === 0; });
  return allMeetings;
}

exports.handler = async function(event) {
  try {
    const dates = [];
    const base = new Date();
    for (var i = 1; i <= 7; i++) {
      const d = new Date(base.getFullYear(), base.getMonth(), base.getDate() + i);
      const y = d.getFullYear();
      const mo = String(d.getMonth() + 1).padStart(2, '0');
      const dy = String(d.getDate()).padStart(2, '0');
      dates.push(y + '-' + mo + '-' + dy);
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
        const data = await apiGet('/v1/racecards/pro?date=' + dateStr);
        if (!data.racecards || !data.racecards.length) {
          return { dateStr, stored: false };
        }
        const meetings = mapRacecards(data);
        await redisSet('racecards:' + dateStr, { meetings, storedAt: new Date().toISOString() });
        return { dateStr, stored: true };
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

    const stored = results.filter(function(r) { return r.stored; }).length;
    const empty = results.filter(function(r) { return !r.stored; }).length;

    return {
      statusCode: 200,
      body: JSON.stringify({ ok: true, stored, empty, dates: results })
    };
  } catch(e) {
    return {
      statusCode: 500,
      body: JSON.stringify({ error: e.message })
    };
  }
};
