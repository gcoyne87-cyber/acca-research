// Popular Trainers — homepage carousel data. Read-only: reads the existing
// trainer-form:table:{today} (7-day form, written by the daily build) and
// the day's meetings (today's runners) and returns one row per hardcoded
// trainer, in the order listed below. Writes nothing except populating the
// shared enriched-racecard cache on a miss (lib/enriched-cache.js) — the
// aggregation below reads only trainer_id/trainer/race.t, which enriched and
// raw meetings carry identically.
const https = require('https');
const EC = require('./lib/enriched-cache.js');
const racecardsMod = require('./racecards.js');

const UPSTASH_URL = process.env.UPSTASH_REDIS_REST_URL;
const UPSTASH_TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN;

// 26 trainers, fixed order — the 16 Flat yards first, then the 10 Jumps
// yards. List order IS the response order IS the display order; nothing is
// appended dynamically. `name` is the display name shown on the card.
// `section` groups the carousel. `id` is the Racing API trainer_id — the
// primary identity: every stored runner carries trainer_id, and the API is
// migrating name forms ("A P O'Brien" -> "Aidan O'Brien") so names can no
// longer be trusted. `match` (exact name form) and the tolerant surname rule
// in namesMatch() below survive only as fallbacks for stored rows written
// before ids were kept.
const POPULAR_TRAINERS = [
  // ---- Flat ----
  { name: 'Charlie Appleby', id: 'trn_255042', section: 'flat' },
  { name: "Aidan O'Brien", id: 'trn_71802', section: 'flat', match: "A P O'Brien" },
  { name: 'John & Thady Gosden', id: 'trn_344619', section: 'flat' },
  { name: 'William Haggas', id: 'trn_30735', section: 'flat' },
  // Card form "Joseph Patrick O'Brien"
  { name: "Joseph O'Brien", id: 'trn_289305', section: 'flat' },
  { name: 'Andrew Balding', id: 'trn_140445', section: 'flat' },
  { name: 'Roger Varian', id: 'trn_224010', section: 'flat' },
  // Card form "D K Weld"
  { name: 'Dermot Weld', id: 'trn_9090', section: 'flat' },
  { name: 'Richard Hannon', id: 'trn_259083', section: 'flat' },
  // Card form "Mrs J. Harrington" — surname rule can't bridge "Jessica"/"Mrs",
  // so the explicit match stays as the id-less fallback.
  { name: 'Jessica Harrington', id: 'trn_11565', section: 'flat', match: 'Mrs J. Harrington' },
  { name: 'Karl Burke', id: 'trn_45171', section: 'flat', match: 'K. R. Burke' },
  // Card form "G. M. Lyons"
  { name: 'Ger Lyons', id: 'trn_77103', section: 'flat' },
  { name: 'Simon & Ed Crisford', id: 'trn_337302', section: 'flat' },
  // Card form "J. P. Murtagh"
  { name: 'Johnny Murtagh', id: 'trn_253620', section: 'flat' },
  { name: 'Clive Cox', id: 'trn_52767', section: 'flat' },
  // Card form "P. Twomey"
  { name: 'Paddy Twomey', id: 'trn_238923', section: 'flat' },
  // ---- Jumps ----
  { name: 'Willie Mullins', id: 'trn_13275', section: 'jumps', match: 'W P Mullins' },
  { name: 'Gordon Elliott', id: 'trn_163305', section: 'jumps' },
  { name: 'Nicky Henderson', id: 'trn_2799', section: 'jumps' },
  { name: 'Paul Nicholls', id: 'trn_51903', section: 'jumps' },
  { name: 'Dan Skelton', id: 'trn_146430', section: 'jumps' },
  { name: 'Nigel Twiston-Davies', id: 'trn_381060', section: 'jumps' },
  { name: 'Alan King', id: 'trn_125352', section: 'jumps' },
  { name: "Jonjo O'Neill", id: 'trn_372456', section: 'jumps', match: "Jonjo & A.J. O'Neill" },
  // The yard races as the "Kim Bailey & Mat Nicholls" partnership since
  // Oct 2026 — this is that partnership's id; the display name stays short.
  { name: 'Kim Bailey', id: 'trn_378207', section: 'jumps' },
  { name: 'Henry de Bromhead', id: 'trn_11241', section: 'jumps', match: 'Henry De Bromhead' }
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

    // One source of truth with racecards/get-results: the shared enriched
    // cache first; on a miss, read the raw card, enrich and populate the
    // cache so the next reader (whichever endpoint it is) gets the hit.
    async function loadDayMeetings(d) {
      try {
        const ec = await EC.getEnriched(d);
        if (ec && ec.length) return ec;
        const cards = await redisGet('racecards:' + d);
        const ms = (cards && Array.isArray(cards.meetings)) ? cards.meetings : [];
        if (ms.length) {
          try {
            await racecardsMod.enrichRunnerTags(ms, d);
            await EC.setEnriched(d, ms);
          } catch (eTag) { /* enrichment is additive — counting works either way */ }
        }
        return ms;
      } catch (e) { return []; }
    }
    const meetings = await loadDayMeetings(today);
    const tmMeetings = await loadDayMeetings(dayAfter(today));

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
        section: entry.section,
        order: POPULAR_TRAINERS.indexOf(entry) + 1,
        matchName: matchName,
        winners7d: row ? (Number(row.winners7d) || 0) : 0,
        runners7d: row ? (Number(row.runners7d) || 0) : 0,
        strikeRate7d: row ? (Number(row.strikeRate7d) || 0) : 0,
        runnersToday: runnersToday,
        runnersTomorrow: runnersTomorrow,
        offTimes: offTimes
      };
    });

    return { statusCode: 200, headers, body: JSON.stringify(out) };
  } catch (e) {
    return { statusCode: 200, headers, body: JSON.stringify([]) };
  }
};
