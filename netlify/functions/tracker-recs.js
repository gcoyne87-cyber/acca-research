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
// Nothing is ever deleted. This additive rule is unchanged for legacy
// signal types (Tipster Consensus, Ground Edge, etc).
//
// The five build slots (NAP/NB/Intel 3-5) are server-authoritative, not
// first-come-first-served: for any date whose report has a FROZEN pickRank
// (see rankedPicksFrozen below — the build's own final ranking, stamped
// once, as its last step), the slot records for that date MUST be exactly
// that frozen top 5 — recomputed from the report on every write that
// touches the date, never trusted from whatever a client happened to push
// first. A prior version of this guard (commit 77b33dc) only blocked a
// different horse from stealing an already-occupied date|type slot; it had
// no notion that a horse already holds a DIFFERENT slot for that date, and
// no way to notice the report's own ranking had moved on. Both gaps let a
// horse end up duplicated across two slot types: daily:report:{date} is
// saved to Redis, and publicly readable, many times WHILE the build is
// still running (before race analysis starts, then after every 4-race
// batch) — all before pickRank is stamped — so a tracker sync mid-build can
// push a horse under whatever rank an INCOMPLETE, pickRank-less snapshot
// happened to score it, and a later sync of the FINISHED build pushes the
// same horse again under its real, frozen rank (reproduced live
// 2026-10-03: So Regal stored as both NB and Intel 5 this way). Re-deriving
// the correct slot/horse pairing from the frozen ranking on every write —
// rather than only gatekeeping NEW pushes against whatever is already
// stored — also means a future out-of-band Redis overwrite that
// reintroduces stale duplicate data can only persist until the next
// ordinary POST touches that date, at which point it self-heals back to
// the report's truth. (A full one-time cleanup of the existing historical
// duplicates sitting in tracker:recs from before this fix is a separate,
// explicit step — this change only stops new ones from forming.)
// An incoming slot-type record may still only ever fill blank result/pos/sp
// on the record the frozen ranking already says that date+type+horse
// should be — it can never establish, move or override which horse holds
// a slot, and it is never matched against a live/confidenceScore re-sort.
// Three cases, not two. Dates with NO stored report at all, and the 16
// dates that predate this ranking mechanism entirely (2026-08-12 through
// 2026-08-25, 2026-09-04/05 — LEGACY_NO_PICKRANK_DATES below), keep the
// original first-come-first-served guard untouched, since there genuinely
// is no frozen ranking to reconcile against, ever. A date with a report
// but NO pickRank yet is different — a build mid-run, not a legacy day —
// and is locked immediately: incoming slot pushes may still fill
// result/pos/sp on whatever is already stored, but can never append a new
// slot record from a snapshot that is still changing underneath them.
const BUILD_SLOTS = ['NAP', 'NB', 'Intel 3', 'Intel 4', 'Intel 5'];
function slotKey(r) { return r.date + '|' + (r.type || ''); }
function isSettled(r) { return !!r && (r.result === 'W' || r.result === 'P' || r.result === 'L'); }

// Frozen, build-time ranking ONLY — never a live/confidenceScore re-sort.
// pickRank is stamped exactly once, as the LAST step of the build
// (daily-build-background.js's 5.7 NB reorder, after every race is
// analysed and every Daily Intelligence card is generated) — but
// daily:report:{date} is saved to Redis and publicly readable via
// get-daily-build many times BEFORE that: once before race analysis
// starts, then again after every 4-race batch. Any read during that window
// has a still-growing analyses array with pickRank nowhere on it yet, so
// get-daily-build's own confidenceScore fallback sort answers with
// whatever order that INCOMPLETE snapshot happens to score — unrelated to,
// and frequently different from, the final NB-reorder-judged rank. That
// fallback is exactly what let a single horse (So Regal, 2026-10-03) get
// pushed as Intel 5 from one read mid-build and NB from a later, finished
// read of the same date — two genuinely different snapshots in time, both
// accepted since the old guard had no notion of either. The tracker must
// never reproduce that: it only ever uses the frozen pickRank the finished
// build actually stamped, never a live re-derivation. A report with no
// pickRank anywhere (checked by hasPickRank — true for every date from
// 2026-08-26 onward except 2026-09-04/05, false for 2026-08-12 through
// 2026-08-25 and 2026-09-04/05, predating this ranking mechanism) has no
// frozen ranking to use at all; the caller must leave it alone.
function hasPickRank(report) {
  return (report.analyses || []).some(function(a) { return a && a.pickRank != null; });
}
function rankedPicksFrozen(report) {
  return (report.analyses || [])
    .filter(function(a) { return a && a.pickRank != null && a.strongestSelection && a.strongestSelection.horseName && a.strongestSelection.confidenceLevel !== 'Pass'; })
    .sort(function(a, b) { return a.pickRank - b.pickRank; })
    .slice(0, 5);
}

function angleFrom(q) {
  q = String(q || '').replace(/\s+/g, ' ').trim();
  return q.length > 120 ? q.slice(0, 120) + '…' : q;
}

async function getReport(date) {
  const r = await redisRaw('/get/daily:report:' + date);
  if (!r || !r.result) return null;
  try { return JSON.parse(r.result); } catch (e) { return null; }
}

// Rebuilds one date's slot records from its report. Settlement survives a
// horse moving between slots across build re-runs: carried over from ANY
// existing stored record for the same normalised horse on that date,
// whichever type it was filed under before (a settled copy wins over an
// unsettled one if more than one exists, so a stale duplicate never
// shadows a result the clean record is missing).
function reconcileSlotsForDate(stored, date, report) {
  const picks = rankedPicksFrozen(report);
  const existingByHorse = {};
  stored.forEach(function(r) {
    if (r.date !== date || BUILD_SLOTS.indexOf(r.type) === -1) return;
    const nh = normHorse(r.horse);
    const cur = existingByHorse[nh];
    if (!cur || (isSettled(r) && !isSettled(cur))) existingByHorse[nh] = r;
  });
  const authoritative = picks.map(function(a, i) {
    const type = BUILD_SLOTS[i];
    const horse = a.strongestSelection.horseName;
    const ex = existingByHorse[normHorse(horse)];
    const rp = String(a.race || '').split(' ');
    const time = rp[rp.length - 1] || '';
    const course = rp.slice(0, rp.length - 1).join(' ') || '';
    return {
      id: ex ? ex.id : (horse + date).replace(/[^a-z0-9]/gi, '').toLowerCase() + 'sig',
      date: date,
      course: (ex && ex.course) || course,
      time: (ex && ex.time) || time,
      horse: horse,
      type: type,
      price: (a.strongestSelection.odds && a.strongestSelection.odds !== '-') ? a.strongestSelection.odds : 'SP',
      angle: (ex && ex.angle) || angleFrom(a.strongestSelection.pullQuote),
      sp: ex ? (ex.sp || '') : '',
      pos: ex ? (ex.pos || '') : '',
      result: ex ? (ex.result || '') : ''
    };
  });
  const kept = stored.filter(function(r) { return r.date !== date || BUILD_SLOTS.indexOf(r.type) === -1; });
  kept.push.apply(kept, authoritative);
  return kept;
}

// The 16 dates that predate the pickRank/NB-reorder mechanism entirely
// (confirmed by direct scan of every stored report 2026-08-12 onward on
// 2026-10-03) — these never had, and never will have, a frozen ranking to
// lock to, so they keep the original first-come-first-served guard exactly
// as a date with no report at all does. Any OTHER report-backed date with
// no pickRank yet is a build still in progress, not a legacy date — it
// gets the stricter lock below (discard, never append) instead.
const LEGACY_NO_PICKRANK_DATES = (function() {
  const dates = [];
  for (let d = new Date('2026-08-12T00:00:00Z'); d <= new Date('2026-08-25T00:00:00Z'); d.setUTCDate(d.getUTCDate() + 1)) {
    dates.push(d.toISOString().slice(0, 10));
  }
  dates.push('2026-09-04', '2026-09-05');
  return dates;
})();

async function mergeInto(stored, incoming) {
  // Lock every slot-push date that has a report and isn't a legacy
  // pre-pickRank date, BEFORE processing incoming — so the match below is
  // always against the build's own truth, never a first-come occupant.
  // With a frozen pickRank: reconcile stored to that exact top 5 first, so
  // the match is against the finished build's real ranking. Without one
  // yet (report exists, build still running): skip reconciliation — there
  // is nothing authoritative to reconcile TO — but still lock the date, so
  // a mid-build push can only fill settlement on whatever is already
  // stored and can never append a new slot record from an incomplete,
  // still-changing snapshot.
  const slotDates = Array.from(new Set(incoming.filter(function(n) { return BUILD_SLOTS.indexOf(n.type) !== -1; }).map(function(n) { return n.date; })));
  const lockedDates = {};   // date -> true once locked, for any reason below
  const datesWithoutFrozenRank = [];
  for (const date of slotDates) {
    if (LEGACY_NO_PICKRANK_DATES.indexOf(date) !== -1) continue;   // keep the old guard
    const report = await getReport(date);
    if (!report) continue;   // no report at all — keep the old guard too
    lockedDates[date] = true;
    if (hasPickRank(report)) {
      stored = reconcileSlotsForDate(stored, date, report);
    } else {
      datesWithoutFrozenRank.push(date);   // build still running — locked, but nothing to reconcile against yet
    }
  }

  const byKey = {};
  const bySlot = {};   // date|type -> the stored occupant for a build slot (first seen wins) — legacy path, no-report dates only
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
      if (lockedDates[n.date]) {
        // Locked — either server-authoritative (occupant was just set by
        // reconcileSlotsForDate, straight from the frozen pickRank) or a
        // build still in progress (occupant is whatever a previous push
        // already stored, if anything). Either way: a match only fills
        // settlement, and anything else — including an apparently-empty
        // slot — is discarded outright, never appended. An empty slot on a
        // locked date means either the report has fewer than 5 ranked
        // picks, or the build hasn't produced this rank yet; neither is a
        // client push's call to make.
        if (occupant && normHorse(occupant.horse) === normHorse(n.horse)) {
          if (fillSettlement(occupant, n)) updated++;
        } else {
          discarded++;
        }
        return;
      }
      // Not locked — no report at all, or one of the 16 legacy
      // pre-pickRank dates — original first-come-first-served guard,
      // unchanged.
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
  return { records: stored, appended, updated, discarded, datesWithoutFrozenRank: datesWithoutFrozenRank };
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
    const result = await mergeInto(scrubbed, allowed);
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
      body: JSON.stringify({ ok: true, received: allowed.length, blocked: blockedCount, scrubbed: scrubbedCount, appended: result.appended, updated: result.updated, discarded: result.discarded, datesWithoutFrozenRank: result.datesWithoutFrozenRank, total: result.records.length })
    };
  } catch (e) {
    return { statusCode: 500, headers, body: JSON.stringify({ error: e.message }) };
  } finally {
    releaseLock();
  }
};
