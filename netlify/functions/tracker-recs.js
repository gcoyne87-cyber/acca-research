const https = require('https');

const UPSTASH_URL = process.env.UPSTASH_REDIS_REST_URL;
const UPSTASH_TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN;

// Single source of truth for the Results Tracker. One key holds the full
// record array (~250KB for a full season — well under limits; if it ever
// approaches 1MB the chunking lives here and only here, no client changes).
const RECS_KEY = 'tracker:recs';
const LOCK_KEY = 'tracker:recs:lock';
const MAX_BATCH = 500;        // records per POST
const MAX_BODY = 900000;      // bytes per POST
const MAX_STORED = 50000;     // abuse cap on the stored array
const RATE_LIMIT_PER_MIN = 30;

// The POST is deliberately not BUILD_SECRET-protected: this endpoint is called
// from the public tracker page, and any secret embedded there would leak the
// same secret that protects the build triggers. Protection is instead: the
// tracker's password gate, the rate limit below, strict record sanitising, and
// merge-only semantics — no request can delete or overwrite a stored result.

function redisRaw(path, method, body) {
  const url = new URL(UPSTASH_URL);
  return new Promise((resolve) => {
    const headers = { 'Authorization': 'Bearer ' + UPSTASH_TOKEN };
    let payload = null;
    if (body !== undefined) {
      payload = JSON.stringify(body);
      headers['Content-Type'] = 'application/json';
      headers['Content-Length'] = Buffer.byteLength(payload);
    }
    const req = https.request({ hostname: url.hostname, path: path, method: method || 'GET', headers }, res => {
      let d = '';
      res.on('data', c => d += c);
      res.on('end', () => { try { resolve(JSON.parse(d)); } catch (e) { resolve(null); } });
    });
    req.on('error', () => resolve(null));
    if (payload !== null) req.write(payload);
    req.end();
  });
}

async function getStoredRecords() {
  const r = await redisRaw('/get/' + RECS_KEY);
  if (!r || !r.result) return [];
  try {
    const arr = JSON.parse(r.result);
    return Array.isArray(arr) ? arr : [];
  } catch (e) { return []; }
}

function sleep(ms) { return new Promise(function(resolve) { setTimeout(resolve, ms); }); }

// ── NAP / NB record stats (tracker:stats) ─────────────────────────────────
// Recomputed after every successful merge write and served through
// get-daily-build as `records` for the homepage / Picks stat pill. Per slot
// ('NAP', 'NB'): one record per date — a settled one (result W/P/L) wins,
// the first settled if several, otherwise the first — then over the settled
// survivors: runs, wins, places, strike rate (whole %), and the mean SP as a
// decimal to 1 place. SP source: the settled `sp` field, falling back to the
// build-time `price` when sp is missing or "SP"; a record with neither is
// left out of the average only (it still counts as a run).
const STATS_KEY = 'tracker:stats';

// "6/5" -> 2.2, "EVS"/"evens"/"evs" -> 2.0, "SP"/blank/unparseable -> null
function fracToDec(s) {
  const v = String(s || '').trim().toLowerCase();
  if (!v || v === 'sp' || v === '-') return null;
  if (v === 'evs' || v === 'evens' || v === 'even') return 2.0;
  const m = v.match(/^(\d+(?:\.\d+)?)\s*\/\s*(\d+(?:\.\d+)?)$/);
  if (!m) return null;
  const num = parseFloat(m[1]), den = parseFloat(m[2]);
  if (!den) return null;
  return 1 + num / den;
}

function computeSlotStats(records, type) {
  const byDate = {};
  records.forEach(function(r) {
    if (!r || r.type !== type || !r.date) return;
    const settled = r.result === 'W' || r.result === 'P' || r.result === 'L';
    const cur = byDate[r.date];
    if (!cur) { byDate[r.date] = r; return; }
    const curSettled = cur.result === 'W' || cur.result === 'P' || cur.result === 'L';
    if (settled && !curSettled) byDate[r.date] = r;   // a settled record replaces an unsettled one; first settled stays
  });
  let runs = 0, wins = 0, places = 0, spSum = 0, spN = 0;
  Object.keys(byDate).forEach(function(d) {
    const r = byDate[d];
    if (!(r.result === 'W' || r.result === 'P' || r.result === 'L')) return;
    runs++;
    if (r.result === 'W') wins++;
    if (r.result === 'P') places++;
    let dec = fracToDec(r.sp);
    if (dec === null) dec = fracToDec(r.price);
    if (dec !== null) { spSum += dec; spN++; }
  });
  return {
    runs: runs,
    wins: wins,
    places: places,
    strikePct: runs ? Math.round(100 * wins / runs) : 0,
    avgSp: spN ? Math.round((spSum / spN) * 10) / 10 : null
  };
}

function computeTrackerStats(records) {
  return {
    nap: computeSlotStats(records, 'NAP'),
    nb: computeSlotStats(records, 'NB'),
    computedAt: new Date().toISOString()
  };
}

// Best-effort: a stats write failure must never fail the merge response.
async function writeTrackerStats(records) {
  try { await redisRaw('/set/' + STATS_KEY, 'POST', computeTrackerStats(records)); } catch (e) { /* swallow */ }
}

// SET NX EX — only one concurrent POST may run the read-merge-write cycle.
// Options go as path segments (/set/key/value/EX/15/NX), NOT query params:
// Upstash expands each query param as an ARGUMENT PAIR, so ?NX=true became
// "SET key value NX true" — ERR syntax error on every call, which read as
// lock-never-acquired and made every POST 409 (bug found 2026-08-16).
async function acquireLock() {
  for (let i = 0; i < 4; i++) {
    const r = await redisRaw('/set/' + LOCK_KEY + '/1/EX/15/NX', 'POST');
    if (r && r.result === 'OK') return true;
    await sleep(400);
  }
  return false;
}

function releaseLock() { return redisRaw('/del/' + LOCK_KEY); }

const FIELDS = ['id', 'date', 'course', 'time', 'horse', 'type', 'price', 'angle', 'sp', 'pos', 'result'];

function sanitize(r) {
  if (!r || typeof r !== 'object') return null;
  const out = {};
  FIELDS.forEach(f => {
    if (r[f] !== undefined && r[f] !== null) out[f] = String(r[f]).slice(0, 300);
  });
  if (!out.date || !/^\d{4}-\d{2}-\d{2}$/.test(out.date)) return null;
  if (!out.horse || !out.horse.trim()) return null;
  return out;
}

// Identity is date|type|normalised horse, matching the client's recKey
// exactly — normHorse is the client's normName verbatim (country suffix
// stripped, then everything but a-z0-9). NOT the raw id field, because the
// same real pick carries different id formats across eras (mkid vs
// signalPickId) and id-matching would duplicate it. The id field itself is
// preserved on every record.
function normHorse(s) { return String(s || '').toLowerCase().replace(/\s*\((ire|gb|fr|usa|ger|aus|nz|ity|spa|bel|den|swe|nor|cze|pol|hun|por|tur|chi|arg|bra|jap|hkg|uae|can|saf|ind)\)/g, '').replace(/[^a-z0-9]/g, ''); }
function recKey(r) { return r.date + '|' + (r.type || '') + '|' + normHorse(r.horse); }

// Additive merge. Rules: unknown key -> append; incoming has a result and
// stored doesn't -> incoming wins (fields overlaid, stored fields incoming
// lacks are kept); stored has a result -> stored wins. One narrow exception
// mirroring the client's own L->P migration in ptShow: a stored 'L' upgraded
// by an incoming 'P' (2nd place recheck) — an upgrade, never a loss.
// Nothing is ever deleted.
// The five build slots are single-occupancy per date: the server is
// authoritative for WHICH horse holds a slot, so a stale client re-pushing an
// earlier build's picks in the evening can never add a second NAP/NB/Intel
// record for the day or swap the stored horse. An incoming slot record is
// discarded unless the stored occupant is the same horse (normalised), and
// even then it may only fill blank settlement fields (result / pos / sp).
// Legacy signal types keep the original additive merge.
const BUILD_SLOTS = ['NAP', 'NB', 'Intel 3', 'Intel 4', 'Intel 5'];
function slotKey(r) { return r.date + '|' + (r.type || ''); }

function mergeInto(stored, incoming) {
  const byKey = {};
  const bySlot = {};   // date|type -> the stored occupant for a build slot (first seen wins)
  stored.forEach(r => {
    byKey[recKey(r)] = r;
    if (BUILD_SLOTS.indexOf(r.type) !== -1 && !bySlot[slotKey(r)]) bySlot[slotKey(r)] = r;
  });
  let appended = 0, updated = 0, discarded = 0;
  // Fill only blank settlement fields — never the horse, never a settled result.
  function fillSettlement(ex, n) {
    let changed = false;
    if (n.result && !ex.result) { ex.result = n.result; changed = true; }
    if (n.pos && !ex.pos) { ex.pos = n.pos; changed = true; }
    if (n.sp && !ex.sp) { ex.sp = n.sp; changed = true; }
    if (ex.result === 'L' && n.result === 'P') { ex.result = 'P'; if (n.pos) ex.pos = n.pos; if (n.sp) ex.sp = n.sp; changed = true; }
    return changed;
  }
  incoming.forEach(n => {
    const k = recKey(n);
    const isSlot = BUILD_SLOTS.indexOf(n.type) !== -1;
    if (isSlot) {
      const occupant = bySlot[slotKey(n)];
      if (!occupant) {
        stored.push(n);
        byKey[k] = n;
        bySlot[slotKey(n)] = n;
        appended++;
      } else if (normHorse(occupant.horse) === normHorse(n.horse)) {
        if (fillSettlement(occupant, n)) updated++;
      } else {
        discarded++;   // slot already held by a different horse for that date
      }
      return;
    }
    const ex = byKey[k];
    if (!ex) {
      stored.push(n);
      byKey[k] = n;
      appended++;
    } else if (n.result && !ex.result) {
      Object.assign(ex, n);
      updated++;
    } else if (ex.result === 'L' && n.result === 'P') {
      ex.result = 'P';
      if (n.pos) ex.pos = n.pos;
      if (n.sp) ex.sp = n.sp;
      updated++;
    }
  });
  stored.sort((a, b) => {
    if (b.date > a.date) return 1;
    if (b.date < a.date) return -1;
    return (a.time || '').localeCompare(b.time || '');
  });
  return { records: stored, appended, updated, discarded };
}

exports.handler = async function(event) {
  const headers = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Content-Type': 'application/json'
  };

  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 204, headers, body: '' };
  }

  if (event.httpMethod === 'GET') {
    const records = await getStoredRecords();
    return { statusCode: 200, headers, body: JSON.stringify({ records, count: records.length }) };
  }

  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, headers, body: JSON.stringify({ error: 'Method not allowed' }) };
  }

  // Permanent removal blocklist — these records were deleted from Redis but
  // devices still hold them in localStorage, and the backfill push loop
  // re-sends whole dates on every unlock, resurrecting them (seen 2026-08-22:
  // 33 deleted records re-created within hours). The merge below both refuses
  // them from incoming pushes AND scrubs them from the stored array, so the
  // system converges to deleted no matter what any device pushes.
  const BLOCKED_IDS = [
    'ladylena20260816sig',
    'badri20260816sig',
    'sotempting20260817sig',
    'southshore20260817sig',
    'nightshining20260817sig',
    'romotoso20260818sig',
    'foinix20260818sig',
    'myoldmate20260818sig',
    'matins20260814sig',
    'hoperising20260818sig'
  ];
  const BLOCKED_TYPES_BEFORE = {
    types: ['Intel 6','Intel 7','Intel 8','Intel 9','Intel 10'],
    before: '2026-08-20'
  };
  function isBlocked(r) {
    if (BLOCKED_IDS.indexOf(r.id) !== -1) return true;
    if (BLOCKED_TYPES_BEFORE.types.indexOf(r.type) !== -1 && (r.date || '') < BLOCKED_TYPES_BEFORE.before) return true;
    return false;
  }

  if (event.body && event.body.length > MAX_BODY) {
    return { statusCode: 413, headers, body: JSON.stringify({ error: 'Payload too large' }) };
  }

  // Global rate limit: INCR a per-minute key; first hit sets its expiry.
  const rlKey = 'tracker:recs:rl:' + Math.floor(Date.now() / 60000);
  const rl = await redisRaw('/incr/' + rlKey);
  if (rl && rl.result === 1) await redisRaw('/expire/' + rlKey + '/90');
  if (rl && rl.result > RATE_LIMIT_PER_MIN) {
    return { statusCode: 429, headers, body: JSON.stringify({ error: 'Rate limited — try again shortly' }) };
  }

  let incoming;
  try {
    const parsed = JSON.parse(event.body || '{}');
    incoming = parsed.records;
  } catch (e) {
    return { statusCode: 400, headers, body: JSON.stringify({ error: 'Invalid JSON' }) };
  }
  if (!Array.isArray(incoming) || !incoming.length) {
    return { statusCode: 400, headers, body: JSON.stringify({ error: 'records array required' }) };
  }
  if (incoming.length > MAX_BATCH) {
    return { statusCode: 413, headers, body: JSON.stringify({ error: 'Max ' + MAX_BATCH + ' records per POST' }) };
  }

  const clean = incoming.map(sanitize).filter(Boolean);
  if (!clean.length) {
    return { statusCode: 400, headers, body: JSON.stringify({ error: 'No valid records in payload' }) };
  }

  // Blocklisted records are silently dropped from the push — never written.
  const allowed = clean.filter(function(r) { return !isBlocked(r); });
  const blockedCount = clean.length - allowed.length;
  if (!allowed.length) {
    // Everything in this push was blocklisted — succeed without writing so
    // clients don't log errors and retry.
    return { statusCode: 200, headers, body: JSON.stringify({ ok: true, received: 0, blocked: blockedCount, appended: 0, updated: 0 }) };
  }

  const locked = await acquireLock();
  if (!locked) {
    // Another device is mid-write. Safe to refuse: the client re-sends its
    // records on every unlock/fetch/sync, so nothing is lost by declining.
    return { statusCode: 409, headers, body: JSON.stringify({ error: 'Busy — another sync in progress, records will be retried' }) };
  }

  try {
    const stored = await getStoredRecords();
    // Stored-side scrub: if blocklisted records were resurrected before this
    // blocklist deployed, remove them here so the store self-heals on the
    // next successful push rather than needing another manual deletion.
    const beforeScrub = stored.length;
    const scrubbed = stored.filter(function(r) { return !isBlocked(r); });
    const scrubbedCount = beforeScrub - scrubbed.length;
    const result = mergeInto(scrubbed, allowed);
    if (result.records.length > MAX_STORED) {
      return { statusCode: 413, headers, body: JSON.stringify({ error: 'Stored record cap reached' }) };
    }
    if (result.appended || result.updated || scrubbedCount > 0) {
      await redisRaw('/set/' + RECS_KEY, 'POST', result.records);
      // Keep the NAP / NB stat pill's source current with every write.
      await writeTrackerStats(result.records);
    }
    return {
      statusCode: 200,
      headers,
      body: JSON.stringify({ ok: true, received: allowed.length, blocked: blockedCount, scrubbed: scrubbedCount, appended: result.appended, updated: result.updated, discarded: result.discarded, total: result.records.length })
    };
  } catch (e) {
    return { statusCode: 500, headers, body: JSON.stringify({ error: e.message }) };
  } finally {
    releaseLock();
  }
};
