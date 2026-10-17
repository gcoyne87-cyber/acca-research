// Popular Trainers — homepage carousel data. Read-only: reads the existing
// trainer-form:table:{today} (7-day form, written by the daily build) and
// racecards:{today} (today's runners) and returns one row per hardcoded
// trainer, in the order listed below. Writes nothing.
const https = require('https');

const UPSTASH_URL = process.env.UPSTASH_REDIS_REST_URL;
const UPSTASH_TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN;

// 20 trainers, fixed order — Flat first, then Jumps. `name` is the display
// name shown on the card. `id` is the Racing API trainer_id — the primary
// identity: every stored runner carries trainer_id, and the API is migrating
// name forms ("A P O'Brien" -> "Aidan O'Brien") so names can no longer be
// trusted. `match` (exact name form) and the tolerant surname rule in
// namesMatch() below survive only as fallbacks for stored rows written
// before ids were kept.
const POPULAR_TRAINERS = [
  { name: "Aidan O'Brien", id: 'trn_71802', match: "A P O'Brien" },
  { name: 'John & Thady Gosden', id: 'trn_344619' },
  { name: 'Charlie Appleby', id: 'trn_255042' },
  { name: 'William Haggas', id: 'trn_30735' },
  { name: 'Roger Varian', id: 'trn_224010' },
  { name: 'Andrew Balding', id: 'trn_140445' },
  { name: 'Richard Hannon', id: 'trn_259083' },
  { name: 'Clive Cox', id: 'trn_52767' },
  { name: 'Karl Burke', id: 'trn_45171', match: 'K. R. Burke' },
  { name: 'Simon & Ed Crisford', id: 'trn_337302' },
  { name: 'Willie Mullins', id: 'trn_13275', match: 'W P Mullins' },
  { name: 'Gordon Elliott', id: 'trn_163305' },
  { name: 'Nicky Henderson', id: 'trn_2799' },
  { name: 'Paul Nicholls', id: 'trn_51903' },
  { name: 'Dan Skelton', id: 'trn_146430' },
  { name: 'Nigel Twiston-Davies', id: 'trn_381060' },
  { name: 'Alan King', id: 'trn_125352' },
  { name: "Jonjo O'Neill", id: 'trn_372456', match: "Jonjo & A.J. O'Neill" },
  // The yard races as the "Kim Bailey & Mat Nicholls" partnership since
  // Oct 2026 — this is that partnership's id; the display name stays short.
  { name: 'Kim Bailey', id: 'trn_378207' },
  { name: 'Henry de Bromhead', id: 'trn_11241', match: 'Henry De Bromhead' }
];

// Same Europe/Dublin calendar date as racecards.js — the Netlify runtime is
// UTC, and during BST that rolls over an hour after Irish midnight.
function irishTodayStr() {
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Dublin' }).formatToParts(new Date());
  const y = parts.find(p => p.type === 'year').value;
  const m = parts.find(p => p.type === 'month').value;
  const d = parts.find(p => p.type === 'day').value;
  return y + '-' + m + '-' + d;
}

function dayBefore(dateStr) {
  const [y, m, d] = dateStr.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d - 1)).toISOString().slice(0, 10);
}

function dayAfter(dateStr) {
  const [y, m, d] = dateStr.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d + 1)).toISOString().slice(0, 10);
}

function redisGet(key) {
  const url = new URL(UPSTASH_URL);
  return new Promise((resolve) => {
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
        } catch (e) { resolve(null); }
      });
    });
    req.on('error', () => resolve(null));
    req.end();
  });
}

// Lowercase, strip punctuation, collapse whitespace.
function normName(s) {
  return String(s || '').toLowerCase().replace(/[^a-z0-9\s]/g, ' ').replace(/\s+/g, ' ').trim();
}

// Explicit match name: exact normalised equality. Otherwise tolerant: the
// surname (last token) must match AND the first token must match in full or
// on its first initial — "Dan Skelton" matches "D Skelton" or "Dan Skelton",
// "Aidan O'Brien" matches neither "J A O'Brien" nor "F O'Brien".
function namesMatch(entry, dataName) {
  const b = normName(dataName);
  if (!b) return false;
  if (entry.match) return normName(entry.match) === b;
  const a = normName(entry.name);
  const ta = a.split(' '), tb = b.split(' ');
  if (ta.length < 2 || tb.length < 2) return a === b;
  if (ta[ta.length - 1] !== tb[tb.length - 1]) return false;
  return ta[0] === tb[0] || ta[0].charAt(0) === tb[0].charAt(0);
}

// ID-first table-row match: rows written since trainerId was stored match on
// it alone; older rows (no trainerId field) fall back to the name rule.
function rowMatches(entry, row) {
  if (!row) return false;
  if (entry.id && row.trainerId) return row.trainerId === entry.id;
  return namesMatch(entry, row.trainerName);
}

exports.handler = async function() {
  const headers = { 'Access-Control-Allow-Origin': '*', 'Content-Type': 'application/json' };
  const today = irishTodayStr();

  try {
    let table = await redisGet('trainer-form:table:' + today);
    // Yesterday fallback (mirrors get-trainer-form.js): the table lands with
    // the ~10:30 daily build, so before then today's key is empty. A yard's
    // 7-day form barely moves overnight — serve yesterday's rather than zeros.
    if (!Array.isArray(table) || !table.length) {
      const ytable = await redisGet('trainer-form:table:' + dayBefore(today));
      if (Array.isArray(ytable) && ytable.length) table = ytable;
    }
    if (!Array.isArray(table)) table = [];

    const cards = await redisGet('racecards:' + today);
    const meetings = (cards && Array.isArray(cards.meetings)) ? cards.meetings : [];
    const tmCards = await redisGet('racecards:' + dayAfter(today));
    const tmMeetings = (tmCards && Array.isArray(tmCards.meetings)) ? tmCards.meetings : [];

    // One pass per day: aggregate runners by trainer_id. Every stored runner
    // has carried trainer_id since the cards were stored with ids; the
    // name-rule fallback inside the fixed-entry loop below covers any id-less
    // runner in an older payload.
    function aggregate(ms) {
      const byId = {};
      ms.forEach(function(m) {
        (m.races || []).forEach(function(race) {
          (race.runners || []).forEach(function(ru) {
            const id = ru && ru.trainer_id;
            if (!id) return;
            const a = byId[id] || (byId[id] = { name: '', count: 0, offTimes: [] });
            a.count++;
            // One "HH:MM" Irish-local off-time per runner today — the
            // frontend counts a runner as remaining until 15 min after its off.
            a.offTimes.push(String(race.t || ''));
            if (!a.name) a.name = String(ru.trainer || '').trim();
          });
        });
      });
      return byId;
    }
    const todayById = aggregate(meetings);
    const tomorrowById = aggregate(tmMeetings);

    const fixedIds = {};
    POPULAR_TRAINERS.forEach(function(e) { if (e.id) fixedIds[e.id] = 1; });

    const out = POPULAR_TRAINERS.map(function(entry) {
      const row = table.find(function(t) { return rowMatches(entry, t); });
      const todayAgg = entry.id ? todayById[entry.id] : null;
      const tmAgg = entry.id ? tomorrowById[entry.id] : null;
      let runnersToday = todayAgg ? todayAgg.count : 0;
      let runnersTomorrow = tmAgg ? tmAgg.count : 0;
      const offTimes = todayAgg ? todayAgg.offTimes.slice() : [];
      // Name-rule fallback, id-less runners only (older stored payloads).
      meetings.forEach(function(m) {
        (m.races || []).forEach(function(race) {
          (race.runners || []).forEach(function(ru) {
            if (ru && !ru.trainer_id && namesMatch(entry, ru.trainer)) {
              runnersToday++;
              offTimes.push(String(race.t || ''));
            }
          });
        });
      });
      tmMeetings.forEach(function(m) {
        (m.races || []).forEach(function(race) {
          (race.runners || []).forEach(function(ru) {
            if (ru && !ru.trainer_id && namesMatch(entry, ru.trainer)) runnersTomorrow++;
          });
        });
      });
      // The tap-through trainer filter compares raw card strings, so
      // matchName must be whatever form today's card carries for this id —
      // resolved at response time. Falls back to tomorrow's form, the form
      // table's, then the static alias only when the yard is on no card.
      const matchName = (todayAgg && todayAgg.name) || (tmAgg && tmAgg.name) || (row && row.trainerName) || entry.match || entry.name;
      return {
        name: entry.name,
        matchName: matchName,
        winners7d: row ? (Number(row.winners7d) || 0) : 0,
        runners7d: row ? (Number(row.runners7d) || 0) : 0,
        strikeRate7d: row ? (Number(row.strikeRate7d) || 0) : 0,
        runnersToday: runnersToday,
        runnersTomorrow: runnersTomorrow,
        offTimes: offTimes
      };
    });

    // Dynamic additions — any other yard with 4+ runners today, by id, so no
    // big yard with a strong hand is ever missing from the carousel. Same
    // response shape as the fixed entries; display name is the card's own
    // form. The frontend re-sorts by runners-today itself, but these are
    // appended most-runners-first anyway.
    const DYNAMIC_MIN_RUNNERS = 4;
    const dynamics = [];
    Object.keys(todayById).forEach(function(id) {
      if (fixedIds[id]) return;
      const agg = todayById[id];
      if (agg.count < DYNAMIC_MIN_RUNNERS || !agg.name) return;
      const pseudo = { id: id, name: agg.name };
      const row = table.find(function(t) { return rowMatches(pseudo, t); });
      dynamics.push({
        name: agg.name,
        matchName: agg.name,
        winners7d: row ? (Number(row.winners7d) || 0) : 0,
        runners7d: row ? (Number(row.runners7d) || 0) : 0,
        strikeRate7d: row ? (Number(row.strikeRate7d) || 0) : 0,
        runnersToday: agg.count,
        runnersTomorrow: (tomorrowById[id] || { count: 0 }).count,
        offTimes: agg.offTimes
      });
    });
    dynamics.sort(function(a, b) { return b.runnersToday - a.runnersToday || String(a.name).localeCompare(String(b.name)); });

    return { statusCode: 200, headers, body: JSON.stringify(out.concat(dynamics)) };
  } catch (e) {
    return { statusCode: 200, headers, body: JSON.stringify([]) };
  }
};
