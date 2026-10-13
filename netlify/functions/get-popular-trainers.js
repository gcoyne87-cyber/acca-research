// Popular Trainers — homepage carousel data. Read-only: reads the existing
// trainer-form:table:{today} (7-day form, written by the daily build) and
// racecards:{today} (today's runners) and returns one row per hardcoded
// trainer, in the order listed below. Writes nothing.
const https = require('https');

const UPSTASH_URL = process.env.UPSTASH_REDIS_REST_URL;
const UPSTASH_TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN;

// 20 trainers, fixed order — Flat first, then Jumps. `name` is the display
// name shown on the card. `match`, where present, is the exact Racing API
// name form the data carries for that yard; entries without `match` use the
// tolerant surname + first-name/initial rule in namesMatch() below.
const POPULAR_TRAINERS = [
  { name: "Aidan O'Brien", match: "A P O'Brien" },
  { name: 'John & Thady Gosden' },
  { name: 'Charlie Appleby' },
  { name: 'William Haggas' },
  { name: 'Roger Varian' },
  { name: 'Andrew Balding' },
  { name: 'Richard Hannon' },
  { name: 'Clive Cox' },
  { name: 'Karl Burke', match: 'K. R. Burke' },
  { name: 'Simon & Ed Crisford' },
  { name: 'Willie Mullins', match: 'W P Mullins' },
  { name: 'Gordon Elliott' },
  { name: 'Nicky Henderson' },
  { name: 'Paul Nicholls' },
  { name: 'Dan Skelton' },
  { name: 'Nigel Twiston-Davies' },
  { name: 'Alan King' },
  { name: "Jonjo O'Neill", match: "Jonjo & A.J. O'Neill" },
  { name: 'Kim Bailey' },
  { name: 'Henry de Bromhead', match: 'Henry De Bromhead' }
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

    const out = POPULAR_TRAINERS.map(function(entry) {
      const row = table.find(function(t) { return namesMatch(entry, t && t.trainerName); });
      let runnersToday = 0;
      let dataName = row ? row.trainerName : '';
      meetings.forEach(function(m) {
        (m.races || []).forEach(function(race) {
          (race.runners || []).forEach(function(ru) {
            const t = ru && ru.trainer;
            if (!namesMatch(entry, t)) return;
            runnersToday++;
            if (!dataName) dataName = String(t).trim();
          });
        });
      });
      return {
        name: entry.name,
        matchName: dataName || entry.match || entry.name,
        winners7d: row ? (Number(row.winners7d) || 0) : 0,
        runners7d: row ? (Number(row.runners7d) || 0) : 0,
        strikeRate7d: row ? (Number(row.strikeRate7d) || 0) : 0,
        runnersToday: runnersToday
      };
    });

    return { statusCode: 200, headers, body: JSON.stringify(out) };
  } catch (e) {
    return { statusCode: 200, headers, body: JSON.stringify([]) };
  }
};
