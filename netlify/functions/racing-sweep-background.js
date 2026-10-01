const https = require('https');
const { buildHistoryRow, isGBCourse } = require('./lib/history-row.js');

// racing-sweep-background.js
//
// Nightly Racing API safety sweep. Rebuilt from spec (2026-09 backfill on
// the desktop machine — scratchpad\backfill_v2.js / repair.js — are not
// present on this machine; this is a from-spec reconstruction, not a copy
// of that code, flagged per instructions rather than silently assumed
// identical).
//
// For every horse declared on every date in the card window (today through
// 7 days ahead — see WINDOW_DAYS below for why that range, not just the
// fetchers' own 1-7), this:
//   1. MISSING — no form:history:{id}:{date} key at all for the horse's
//      first declared date in the window → fetch live and write it.
//   2. STALE — a key exists, but the racecard's OWN embedded recent-form
//      snippet (runner.history, up to 6 runs, built by racecards.js's
//      mapRunner) shows a run more recent than the cached key's newest
//      entry — proof the horse has raced since the cache was written →
//      re-fetch and rewrite. This also catches a debutant marker ([])
//      that's since been outrun.
//   3. Fetched via the same live-fetch mapping horse-form.js's
//      lookupHistory() cache-miss tier uses (date/course/dist/going/pos/
//      ran/sp/or/jockey/race_class/trainer/prize/surface/type), now
//      paginated for full careers — see fetchFullCareerResults below.
//      Written with no TTL, matching the existing form:history pattern.
//      An empty result is written as [] ONLY when the card's own
//      embedded history also shows no runs for that horse (cardHasForm
//      false) — never for a horse the card says has run; that case is
//      recorded as a named failure instead (see FAILURES below).
//   4. Paced 5 horses per batch, 1s between batches — same as
//      fetch-horse-history-1/2-background.js. If the remaining work can't
//      finish inside one invocation (780s budget, under the 900s Netlify
//      background timeout), progress is persisted to Redis
//      (racing-sweep:worklist:{runKey}) and the run self-chains (hop+1,
//      capped at 8) by POSTing to itself — this function carries no
//      `schedule` of its own (only racing-sweep-trigger.js does), so it's
//      directly POSTable, the same reason fetch-horse-history-1-
//      background.js's own trigger-background twin exists.
//
// ── FLAGGED — Racing API's documented max `limit` could not be verified ────
// Outbound access to api.theracingapi.com (and its docs site) is blocked by
// this environment's egress policy — confirmed via curl (403 at the proxy)
// and WebFetch (EGRESS_BLOCKED) — and no cached API documentation exists
// anywhere in this repo. Rather than guess a bigger single-call `limit`
// value and assert it as verified, this reuses the pagination approach
// already proven elsewhere in this codebase (get-horse-profile.js,
// trainer-history-background.js: limit=50&skip=N per page), raised to 10
// pages (500 runs total) — comfortably beyond any real career. The same
// change is applied to fetch-horse-history-1/2-background.js and
// horse-form.js in this change. If the true API max is later confirmed to
// be e.g. 200 or 500 in one call, this can be simplified back to a single
// bigger `limit=` — pagination is the safe fallback, not a rejection of
// the instruction.
//
// ── FLAGGED — card window is today+0 through +7, not just the fetchers' 1-7 ─
// fetch-horse-history-1/2-background.js only ever cover days +1 through
// +7 (today's card was covered on a PRIOR night, when it was still +1..+7)
// — so a pure re-verification of "what the fetchers manage" would be days
// +1..+7 only. This sweep also includes day 0 (today) deliberately: today's
// card is what the very next form-summary run (starting ~3 hours after this
// sweep, per netlify.toml's 0 4,6,8 UTC schedule) reads from, so it's the
// single most consequential date to catch a MISSING/STALE key on before
// racing starts. Flagging this as a deliberate scope decision, not an
// assumption slipped in silently.
//
// ── FLAGGED — the racecard's own embedded history has no plain ISO date ────
// racecards.js's mapRunner() reformats each embedded past-result's date
// into {year:'2026', date:'15 Sep'} (formatRunDate) for display — the raw
// ISO string is discarded before racecards:{date} is ever cached, which is
// the only source this sweep has (it does not re-fetch racecards, same as
// the existing fetchers). cardHistoryDateToISO() below reverses that
// formatting back into 'YYYY-MM-DD' for the staleness comparison — a
// necessary reconstruction given the stored shape, not an assumption about
// a field that doesn't exist.

module.exports.config = { timeout: 900 };

const USERNAME = process.env.RACING_API_USERNAME;
const PASSWORD = process.env.RACING_API_KEY;
const RACING_AUTH = Buffer.from((USERNAME || '') + ':' + (PASSWORD || '')).toString('base64');

const UPSTASH_URL = process.env.UPSTASH_REDIS_REST_URL;
const UPSTASH_TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN;

// ── Redis + Racing API helpers — same shape as trainer-history-background.js ──

function redisGet(key) {
  if (!UPSTASH_URL || !UPSTASH_TOKEN) return Promise.resolve(null);
  const url = new URL(UPSTASH_URL);
  return new Promise(resolve => {
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
    req.on('error', () => resolve(null));
    req.end();
  });
}

// No expiry — matches the existing form:history pattern (fetch-horse-
// history-1/2-background.js's own redisSet) and is used here for every
// control key too (heartbeat/lock/worklist/meta/failures/complete).
function redisSet(key, value) {
  if (!UPSTASH_URL || !UPSTASH_TOKEN) return Promise.resolve(null);
  const url = new URL(UPSTASH_URL);
  const body = JSON.stringify(value);
  return new Promise(resolve => {
    const req = https.request({
      hostname: url.hostname,
      path: '/set/' + encodeURIComponent(key),
      method: 'POST',
      headers: { 'Authorization': 'Bearer ' + UPSTASH_TOKEN, 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) }
    }, res => { let d = ''; res.on('data', c => d += c); res.on('end', () => resolve(d)); });
    req.on('error', () => resolve(null)); req.write(body); req.end();
  });
}

function apiGetRacing(path) {
  return new Promise((resolve, reject) => {
    const req = https.request({
      hostname: 'api.theracingapi.com', path: path, method: 'GET',
      headers: { 'Authorization': 'Basic ' + RACING_AUTH, 'Accept': 'application/json' }
    }, res => {
      let d = ''; res.on('data', c => d += c);
      res.on('end', () => { try { resolve(JSON.parse(d)); } catch(e) { reject(new Error('Parse')); } });
    });
    req.on('error', reject); req.end();
  });
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// Status-aware variant used only by the ancestor fetch loop: resolves
// { status, data } (data null when the body is not JSON) instead of hiding
// the HTTP status like apiGetRacing above, so a 429 can be recognised.
function apiGetRacingWithStatus(path) {
  return new Promise((resolve, reject) => {
    const req = https.request({
      hostname: 'api.theracingapi.com', path: path, method: 'GET',
      headers: { 'Authorization': 'Basic ' + RACING_AUTH, 'Accept': 'application/json' }
    }, res => {
      let d = ''; res.on('data', c => d += c);
      res.on('end', () => { let data = null; try { data = JSON.parse(d); } catch(e) {} resolve({ status: res.statusCode, data: data }); });
    });
    req.on('error', reject); req.end();
  });
}

// One ancestor endpoint call with a single retry after a 2s wait on HTTP
// 429, so a transient rate-limit response self-heals instead of becoming a
// named failure. A second 429, any other non-200, or an unparseable body
// throws, and the caller records that as the ancestor's failure reason.
async function apiGetAncestor(path) {
  let r = await apiGetRacingWithStatus(path);
  if (r.status === 429) { await sleep(2000); r = await apiGetRacingWithStatus(path); }
  if (r.status === 429) throw new Error('HTTP 429 after one retry');
  if (r.status !== 200) throw new Error('HTTP ' + r.status + ((r.data && r.data.detail) ? ' ' + r.data.detail : ''));
  if (!r.data) throw new Error('unparseable response');
  return r.data;
}

// Full career, paginated — identical shape and reasoning to
// fetch-horse-history-1/2-background.js's fetchFullCareerResults (see this
// file's header comment for why pagination rather than a bigger single
// `limit`). Same simple resolve-without-status-check apiGetRacing as
// horse-form.js — no retry on a bad page here either, matching "the same
// code path the backfill used".
async function fetchFullCareerResults(horse_id) {
  const PAGE = 50, MAX_PAGES = 10;
  let all = [];
  for (let pg = 0; pg < MAX_PAGES; pg++) {
    const data = await apiGetRacing('/v1/horses/' + encodeURIComponent(horse_id) + '/results?limit=' + PAGE + '&skip=' + (pg * PAGE));
    const pageResults = (data && data.results) || [];
    all = all.concat(pageResults);
    if (pageResults.length < PAGE) break; // short page — no more results
  }
  return all;
}

// Same mapping horse-form.js's lookupHistory() cache-miss tier uses — now
// the shared lib/history-row.js helper, which also adds pattern/rating_band.
function mapHistory(allResults, horse_id) {
  return allResults.map(function(race) {
    const runner = (race.runners || []).find(function(r) { return r.horse_id === horse_id; }) || {};
    return buildHistoryRow(race, runner);
  });
}

// ── Bloodline stats cache (ancestor:stats:{id}) ──────────────────────────
//
// Second phase of the sweep, run once the form-history worklist is empty.
// For every distinct sire_id / dam_id / damsire_id across the card window
// it writes ancestor:stats:{id} — the cache the horse chevron's Sire / Dam /
// Damsire panel reads via get-ancestor-stats.js. The entry shape matches
// the panel's documented expectation in index.html (_nrhBloodRender)
// field for field: { name, kind, total_runners, distances[], classes[],
// fetchedAt }, distances/classes stored exactly as the Racing API returns
// them ({dist, dist_y, dist_m, dist_f, runners, "1st","2nd","3rd","4th",
// "a/e", "win_%", "1_pl"} and the class equivalent). `comment` is left
// absent — the panel only renders the paragraph once a later job adds it.
//
// Cards stored before the card writer carried the ids have none; those
// runners are resolved through the horse pro endpoint (the same one
// get-horse-profile.js uses), reading the 24h horse:profile:v2 cache first
// so a horse whose chevron was opened today costs no API call. A horse
// whose pro record yields no ids is counted as unresolvable and skipped.
//
// State lives in racing-sweep:ancestors:{runKey} so the phase survives the
// sweep's hop chaining; both loops check the same TIMEOUT_MS budget and
// hand back done:false when it is spent.

const ANCESTOR_TTL_SEC = 45 * 86400;
const ANCESTOR_NORESULTS_TTL_SEC = 7 * 86400;   // "no progeny runs yet" markers recheck weekly
// Fetch batch is 3 ids (not the sweep's BATCH of 5): each id makes two
// sequential calls, so 3 in parallel peaks at 6 requests per ~1.5s cycle,
// about 4 per second sustained, under the endpoints' 5-per-second limit.
const ANCESTOR_FETCH_BATCH = 3;
const ANCESTOR_ENDPOINT = { sire: '/v1/sires/', dam: '/v1/dams/', damsire: '/v1/damsires/' };

// SET with expiry — Upstash REST accepts EX as a query parameter alongside
// the JSON body value. Used only for ancestor:stats entries (45 days).
function redisSetEx(key, value, seconds) {
  if (!UPSTASH_URL || !UPSTASH_TOKEN) return Promise.resolve(null);
  const url = new URL(UPSTASH_URL);
  const body = JSON.stringify(value);
  return new Promise((resolve, reject) => {
    const req = https.request({
      hostname: url.hostname,
      path: '/set/' + encodeURIComponent(key) + '?EX=' + seconds,
      method: 'POST',
      headers: { 'Authorization': 'Bearer ' + UPSTASH_TOKEN, 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) }
    }, res => {
      let d = ''; res.on('data', c => d += c);
      res.on('end', () => {
        if (res.statusCode !== 200) return reject(new Error('Redis write failed: HTTP ' + res.statusCode));
        try { const p = JSON.parse(d); if (p && p.error) return reject(new Error('Redis write error: ' + p.error)); } catch (e) {}
        resolve(d);
      });
    });
    req.on('error', reject); req.write(body); req.end();
  });
}

function newAncestorState() {
  return {
    resolveQueue: [],   // [{horse_id, horseName}] runners whose card carries no ancestor ids
    ancestors: {},      // id -> { name, kind }
    fetchQueue: null,   // built once resolveQueue is empty: ids still to check/fetch
    counts: { fromCards: 0, resolvedViaProfile: 0, unresolvable: 0, alreadyCached: 0, fetched: 0, failed: 0 },
    failures: []        // [{id, name, kind, reason}]
  };
}

// Record the three ancestors a runner (card runner or pro profile) names.
// Returns true when at least one id was present.
function addAncestorsFrom(state, src) {
  let any = false;
  [['sire', 'sire_id'], ['dam', 'dam_id'], ['damsire', 'damsire_id']].forEach(function(pair) {
    const id = src && src[pair[1]] ? String(src[pair[1]]) : '';
    if (!id) return;
    any = true;
    if (!state.ancestors[id]) state.ancestors[id] = { name: String(src[pair[0]] || ''), kind: pair[0] };
    else if (!state.ancestors[id].name && src[pair[0]]) state.ancestors[id].name = String(src[pair[0]]);
  });
  return any;
}

// Runs (or resumes) the resolve + fetch loops within the remaining budget.
// Mutates `state`; returns { done } — false means the budget ran out with
// work queued and the caller must persist state and chain the next hop.
async function runAncestorPhase(state, startTime) {
  const overBudget = function() { return Date.now() - startTime > TIMEOUT_MS; };

  // 1. Resolve ids for runners whose stored card predates the id fields.
  while (state.resolveQueue.length) {
    if (overBudget()) return { done: false };
    const batch = state.resolveQueue.slice(0, BATCH);
    const results = await Promise.allSettled(batch.map(async function(h) {
      const cached = await redisGet('horse:profile:v2:' + h.horse_id);
      let prof = cached && cached.profile && cached.profile.sire_id ? cached.profile : null;
      if (!prof) {
        const p = await apiGetRacing('/v1/horses/' + encodeURIComponent(h.horse_id) + '/pro');
        prof = (p && !p.detail) ? p : null;
      }
      return prof && addAncestorsFrom(state, prof);
    }));
    results.forEach(function(r) {
      if (r.status === 'fulfilled' && r.value) state.counts.resolvedViaProfile++;
      else state.counts.unresolvable++;
    });
    state.resolveQueue = state.resolveQueue.slice(BATCH);
    if (state.resolveQueue.length) await sleep(1000);
  }

  // 2. Fetch stats for every distinct id that has no cache entry.
  if (!Array.isArray(state.fetchQueue)) state.fetchQueue = Object.keys(state.ancestors);
  while (state.fetchQueue.length) {
    if (overBudget()) return { done: false };
    const batch = state.fetchQueue.slice(0, ANCESTOR_FETCH_BATCH);
    const results = await Promise.allSettled(batch.map(async function(id) {
      const known = state.ancestors[id] || { name: '', kind: '' };
      if (!ANCESTOR_ENDPOINT[known.kind]) throw new Error('unknown ancestor kind');
      const existing = await redisGet('ancestor:stats:' + id);
      if (existing && typeof existing === 'object' && Array.isArray(existing.distances)) return { cached: true };
      // Two calls per id, sequential; with ANCESTOR_FETCH_BATCH ids in
      // parallel that stays under the endpoints' 5 requests-per-second
      // limit, and apiGetAncestor retries once on a 429.
      const base = ANCESTOR_ENDPOINT[known.kind] + encodeURIComponent(id) + '/analysis/';
      const dist = await apiGetAncestor(base + 'distances');
      // "No results found" = the ancestor has no progeny runs on record yet
      // (a young mare's first foal about to run). Cache a marker so the panel
      // can say so, on a short TTL so it rechecks weekly. Any other detail /
      // non-200 (429, timeouts) still throws below and writes nothing.
      if (dist.detail && /^No results found/i.test(String(dist.detail))) {
        await redisSetEx('ancestor:stats:' + id, {
          name: known.name || '',
          kind: known.kind,
          total_runners: 0,
          noResults: true,
          distances: [],
          classes: [],
          fetchedAt: new Date().toISOString()
        }, ANCESTOR_NORESULTS_TTL_SEC);
        return { cached: false };
      }
      if (dist.detail || !Array.isArray(dist.distances)) throw new Error('distances: ' + (dist.detail || 'unexpected response'));
      const cls = await apiGetAncestor(base + 'classes');
      if (cls.detail || !Array.isArray(cls.classes)) throw new Error('classes: ' + (cls.detail || 'unexpected response'));
      const entry = {
        name: dist[known.kind] || cls[known.kind] || known.name || '',
        kind: known.kind,
        total_runners: dist.total_runners != null ? dist.total_runners : (cls.total_runners != null ? cls.total_runners : null),
        distances: dist.distances,
        classes: cls.classes,
        fetchedAt: new Date().toISOString()
      };
      await redisSetEx('ancestor:stats:' + id, entry, ANCESTOR_TTL_SEC);
      return { cached: false };
    }));
    results.forEach(function(r, i) {
      const id = batch[i];
      const known = state.ancestors[id] || { name: '', kind: '' };
      if (r.status === 'fulfilled') {
        if (r.value && r.value.cached) state.counts.alreadyCached++; else state.counts.fetched++;
      } else {
        state.counts.failed++;
        const reason = (r.reason && r.reason.message) || 'unknown fetch error';
        state.failures.push({ id: id, name: known.name, kind: known.kind, reason: reason });
        console.log('[racing-sweep] ancestor FAIL ' + known.kind + ' ' + (known.name || '?') + ' (' + id + '): ' + reason);
      }
    });
    state.fetchQueue = state.fetchQueue.slice(ANCESTOR_FETCH_BATCH);
    if (state.fetchQueue.length) await sleep(1000);
  }
  return { done: true };
}

// ── Date helpers ─────────────────────────────────────────────────────────

// Europe/Dublin calendar date, offsetDays ahead of now — same Intl-based
// pattern form-summary-background.js's readRacecards() already uses (copied
// verbatim), deliberately NOT the plain new Date() the two fetch-horse-
// history files use for their own date math (a known UTC-drift class of bug
// documented in racecards.js's own irishTodayStr() comment) — this is new
// code, built correctly from the start rather than copying that gap. The
// two existing fetcher files are outside this task's authorised scope
// (only their `limit` was to change) so they're left as they are.
function irishDateStr(offsetDays) {
  const d = new Date(Date.now() + offsetDays * 86400000);
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Dublin' }).formatToParts(d);
  const y = parts.find(p => p.type === 'year').value;
  const m = parts.find(p => p.type === 'month').value;
  const dy = parts.find(p => p.type === 'day').value;
  return y + '-' + m + '-' + dy;
}

const WINDOW_DAYS = 8; // today (0) through +7 — see header comment

const MONTHS = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];

// Reverses racecards.js's formatRunDate() ({year,date:'DD Mon'}) back into
// a plain 'YYYY-MM-DD' string so it can be string-compared against
// form:history's own stored ISO date field. Returns null if the entry is
// missing or unparseable — callers must treat that as "can't prove
// staleness from the card", not as evidence of anything.
function cardHistoryDateToISO(entry) {
  if (!entry || !entry.year || !entry.date) return null;
  const parts = String(entry.date).trim().split(/\s+/);
  if (parts.length !== 2) return null;
  const mi = MONTHS.indexOf(parts[1]);
  if (mi === -1) return null;
  return String(entry.year) + '-' + String(mi + 1).padStart(2, '0') + '-' + parts[0].padStart(2, '0');
}

// ── Handler ──────────────────────────────────────────────────────────────

const HOSTNAME = 'superlative-flan-93dfc4.netlify.app';
const LOCK_WINDOW_MS = 800 * 1000;
const TIMEOUT_MS = 780 * 1000;
const HOP_CAP = 16;
const BATCH = 5;

exports.handler = async function(event) {
  const startTime = Date.now();
  const headers = { 'Content-Type': 'application/json' };
  const isScheduled = !event.httpMethod;
  const qs = (event && event.queryStringParameters) || {};
  const hop = Math.max(0, parseInt(qs.hop, 10) || 0);

  console.log('[racing-sweep] START', new Date().toISOString(), 'hop:', hop, 'scheduled:', isScheduled);

  if (!isScheduled) {
    const secret = (event.headers && event.headers['x-build-secret']) || qs.secret;
    if (secret !== process.env.BUILD_SECRET) {
      return { statusCode: 401, headers, body: JSON.stringify({ error: 'Unauthorised' }) };
    }
  }

  // runKey — the Irish date this sweep run started on. Distinct from the
  // card dates it inspects (sweep:coverage:{date} below is keyed by card
  // date, not runKey); runKey only scopes this run's own control keys so a
  // hop-chain from tonight never collides with tomorrow night's run.
  const runKey = irishDateStr(0);

  try {
    redisSet('racing-sweep:heartbeat:' + runKey, { startedAt: new Date().toISOString(), scheduled: isScheduled, hop: hop }).catch(function() {});
  } catch (hbErr) {}

  const now = new Date();
  try {
    const existingLock = await redisGet('racing-sweep:lock:' + runKey);
    if (existingLock && existingLock.startedAt) {
      const lockAgeMs = now.getTime() - new Date(existingLock.startedAt).getTime();
      if (lockAgeMs >= 0 && lockAgeMs < LOCK_WINDOW_MS) {
        console.log('[racing-sweep] already in progress (started ' + Math.round(lockAgeMs / 1000) + 's ago) — standing down.');
        return { statusCode: 200, headers, body: JSON.stringify({ skipped: true, reason: 'racing-sweep already in progress', lockStartedAt: existingLock.startedAt }) };
      }
    }
    await redisSet('racing-sweep:lock:' + runKey, { startedAt: now.toISOString(), scheduled: isScheduled });
  } catch (lockErr) { /* lock check/write failure must never block the run itself */ }

  try {
    const dates = [];
    for (let i = 0; i < WINDOW_DAYS; i++) dates.push(irishDateStr(i));

    let worklist, meta, failures, ancestorState;

    if (hop === 0) {
      // ── Build phase — scan every date's racecard once, dedupe by horse,
      // decide MISSING/STALE per horse (checked against its first declared
      // date, matching fetch-horse-history-1/2-background.js's own "check
      // against the first date" pattern — a horse's live history doesn't
      // depend on which of its declared dates we're looking from).
      const horseInfo = new Map(); // horse_id -> { horseName, dates:[...], cardHasForm, cardNewestISO }
      const perDateHorseIds = {};
      ancestorState = newAncestorState();
      const ancestorSeenHorses = new Set();

      for (const dateStr of dates) {
        perDateHorseIds[dateStr] = [];
        const card = await redisGet('racecards:' + dateStr);
        if (!card || !Array.isArray(card.meetings)) continue;
        card.meetings.forEach(function(m) {
          (m.races || []).forEach(function(race) {
            (race.runners || []).forEach(function(r) {
              if (!r.horse_id) return;
              perDateHorseIds[dateStr].push(r.horse_id);
              // Bloodline ids straight off the card when the writer carried
              // them; otherwise the horse is queued for pro-endpoint resolution.
              if (!ancestorSeenHorses.has(r.horse_id)) {
                ancestorSeenHorses.add(r.horse_id);
                if (addAncestorsFrom(ancestorState, r)) ancestorState.counts.fromCards++;
                else ancestorState.resolveQueue.push({ horse_id: r.horse_id, horseName: r.name || '' });
              }
              if (!horseInfo.has(r.horse_id)) {
                const hasForm = Array.isArray(r.history) && r.history.length > 0;
                horseInfo.set(r.horse_id, {
                  horseName: r.name || '',
                  dates: [dateStr],
                  cardHasForm: hasForm,
                  cardNewestISO: hasForm ? cardHistoryDateToISO(r.history[0]) : null
                });
              } else if (horseInfo.get(r.horse_id).dates.indexOf(dateStr) === -1) {
                horseInfo.get(r.horse_id).dates.push(dateStr);
              }
            });
          });
        });
      }

      // Three additional staleness checks (Proven Class Drop build): a horse
      // can have a cached history that's current by the two checks above
      // (right length, newest date matches the card) and still be useless
      // for class-drop purposes because it predates the race_class/pattern/
      // rating_band/or fix just made to the four history writers, or because
      // it's capped at exactly 50 rows (the Racing API's page size — a
      // horse with a longer career is silently truncated), or because a GB
      // row in its most recent 6 has no class recorded at all. Counted
      // separately from the two checks above (and from each other) so the
      // coverage log can report how many horses fall under each condition on
      // its own, not just how many are newly caught by it.
      const staleCounts = { blankClassGB: 0, fiftyRows: 0, noPatternField: 0 };

      const built = [];
      for (const [horse_id, info] of horseInfo) {
        const repDate = info.dates[0];
        const existing = await redisGet('form:history:' + horse_id + ':' + repDate);
        let needsFetch = false, reason = null;

        if (existing === null || existing === undefined) {
          needsFetch = true; reason = 'missing';
        } else if (Array.isArray(existing)) {
          if (existing.length === 0) {
            if (info.cardHasForm) { needsFetch = true; reason = 'stale (debutant marker outrun)'; }
          } else {
            const cachedNewest = existing[0] && existing[0].date;
            if (info.cardNewestISO && cachedNewest && info.cardNewestISO > cachedNewest) {
              needsFetch = true; reason = 'stale (card shows a newer run)';
            }

            const last6 = existing.slice(0, 6);
            const hitBlankClassGB = last6.some(function(r) { return r && isGBCourse(r.course) && !r.race_class; });
            const hitFiftyRows = existing.length === 50;
            const hitNoPatternField = !Object.prototype.hasOwnProperty.call(existing[0] || {}, 'pattern');
            if (hitBlankClassGB) staleCounts.blankClassGB++;
            if (hitFiftyRows) staleCounts.fiftyRows++;
            if (hitNoPatternField) staleCounts.noPatternField++;
            if (!needsFetch && (hitBlankClassGB || hitFiftyRows || hitNoPatternField)) {
              needsFetch = true;
              reason = hitBlankClassGB ? 'stale (blank GB class in last 6)' : hitFiftyRows ? 'stale (exactly 50 rows — may be truncated)' : 'stale (pre-fix row, no pattern field)';
            }
          }
        } else {
          // Unexpected shape (not array, not null) — treat conservatively
          // as needing a fresh fetch rather than trusting it.
          needsFetch = true; reason = 'missing (unexpected cached shape)';
        }

        if (needsFetch) {
          built.push({ horse_id: horse_id, horseName: info.horseName, dates: info.dates, cardHasForm: info.cardHasForm, reason: reason });
        }
      }

      worklist = built;
      meta = { dates: dates, perDateHorseIds: perDateHorseIds, staleCounts: staleCounts };
      failures = [];

      await redisSet('racing-sweep:meta:' + runKey, meta);
      await redisSet('racing-sweep:ancestors:' + runKey, ancestorState);
      console.log('[racing-sweep] built worklist: ' + worklist.length + ' horse(s) need fetching across ' + dates.join(', '));
      console.log('[racing-sweep] stale breakdown — blank GB class in last 6: ' + staleCounts.blankClassGB + ' | exactly 50 rows: ' + staleCounts.fiftyRows + ' | no pattern field (pre-fix): ' + staleCounts.noPatternField);
      console.log('[racing-sweep] ancestors: ' + Object.keys(ancestorState.ancestors).length + ' distinct id(s) from ' + ancestorState.counts.fromCards + ' runner(s) with ids on the card; ' + ancestorState.resolveQueue.length + ' runner(s) queued for pro-endpoint id resolution');
    } else {
      meta = await redisGet('racing-sweep:meta:' + runKey);
      worklist = await redisGet('racing-sweep:worklist:' + runKey);
      failures = await redisGet('racing-sweep:failures:' + runKey);
      if (!meta || !Array.isArray(worklist)) {
        console.log('[racing-sweep] hop ' + hop + ' but no persisted meta/worklist found — nothing to continue, standing down.');
        try { await redisSet('racing-sweep:lock:' + runKey, null); } catch (ue) {}
        return { statusCode: 200, headers, body: JSON.stringify({ skipped: true, reason: 'no persisted worklist for this runKey' }) };
      }
      if (!Array.isArray(failures)) failures = [];
      ancestorState = await redisGet('racing-sweep:ancestors:' + runKey);
      if (!ancestorState || typeof ancestorState !== 'object' || !ancestorState.ancestors) ancestorState = newAncestorState();
      console.log('[racing-sweep] resumed hop ' + hop + ' with ' + worklist.length + ' remaining; ancestors: ' + ancestorState.resolveQueue.length + ' to resolve, ' + (Array.isArray(ancestorState.fetchQueue) ? ancestorState.fetchQueue.length : Object.keys(ancestorState.ancestors).length) + ' to check/fetch');
    }

    // ── Fetch phase — batches of 5, 1s apart, time-budgeted ──
    let fetched = 0, skippedAsGenuineDebutant = 0;
    let timedOut = false;
    let remaining = worklist.slice();

    while (remaining.length) {
      if (Date.now() - startTime > TIMEOUT_MS) { timedOut = true; break; }
      const batch = remaining.slice(0, BATCH);

      const results = await Promise.allSettled(batch.map(async function(item) {
        const allResults = await fetchFullCareerResults(item.horse_id);
        const history = mapHistory(allResults, item.horse_id);
        if (history.length === 0) {
          if (item.cardHasForm) {
            throw new Error('card shows prior form but live fetch returned zero results — possible API/data mismatch, left untouched');
          }
          // Genuine debutant — card agrees there's no form. Write [] to
          // every declared date, no TTL, same as a real history write.
          await Promise.all(item.dates.map(function(d) { return redisSet('form:history:' + item.horse_id + ':' + d, []); }));
          return { genuineDebutant: true };
        }
        await Promise.all(item.dates.map(function(d) { return redisSet('form:history:' + item.horse_id + ':' + d, history); }));
        return { genuineDebutant: false };
      }));

      results.forEach(function(r, i) {
        const item = batch[i];
        if (r.status === 'fulfilled') {
          fetched++;
          if (r.value.genuineDebutant) skippedAsGenuineDebutant++;
        } else {
          failures.push({ horse_id: item.horse_id, horseName: item.horseName, dates: item.dates, reason: (r.reason && r.reason.message) || 'unknown fetch error' });
        }
      });

      remaining = remaining.slice(BATCH);
      if (remaining.length) await sleep(1000);
    }

    // Self-chain: persist whatever is outstanding (history worklist and/or
    // ancestor state) and POST the next hop. Shared by both phases.
    const chainNextHop = async function(label) {
      await redisSet('racing-sweep:worklist:' + runKey, remaining);
      await redisSet('racing-sweep:failures:' + runKey, failures);
      await redisSet('racing-sweep:ancestors:' + runKey, ancestorState);
      // Release the run lock BEFORE posting the next hop: the next invocation
      // arrives ~3-10s after this hop's 780s budget, inside the 800s lock
      // window, and would otherwise stand down against this hop's own lock.
      // Continuity is carried by the persisted worklist/ancestor state, and
      // the next hop re-acquires the lock at its own start.
      try { await redisSet('racing-sweep:lock:' + runKey, null); } catch (ue) {}
      console.log('[racing-sweep] approaching 900s timeout (' + Math.round((Date.now() - startTime) / 1000) + 's elapsed) — ' + label + '; persisted for the next hop, lock released');
      try {
        await new Promise(function(resolve) {
          const req = https.request({
            hostname: HOSTNAME,
            path: '/.netlify/functions/racing-sweep-background?hop=' + (hop + 1),
            method: 'POST',
            headers: { 'x-build-secret': process.env.BUILD_SECRET || '', 'Content-Length': 0 }
          }, function(res) { res.resume(); res.on('end', resolve); });
          req.on('error', function() { resolve(); });
          req.setTimeout(10000, function() { req.destroy(); resolve(); });
          req.end();
        });
        console.log('[racing-sweep] partial — self-chained hop ' + (hop + 1));
      } catch (e) {}
    };

    if (timedOut && remaining.length) {
      if (hop < HOP_CAP) {
        await chainNextHop(remaining.length + ' horse(s) still queued');
        return { statusCode: 200, headers, body: JSON.stringify({ status: 'partial', hop: hop, remaining: remaining.length, fetched: fetched }) };
      }

      // Hop cap reached with work still outstanding — every horse left in
      // the worklist is named as a failure (never silently dropped) before
      // the coverage report below is written from whatever is now known.
      remaining.forEach(function(item) {
        failures.push({ horse_id: item.horse_id, horseName: item.horseName, dates: item.dates, reason: 'not processed — racing-sweep exceeded its ' + HOP_CAP + '-hop cap for the night' });
      });
      remaining = [];
      console.log('[racing-sweep] hop cap reached with ' + failures.length + ' failure(s) recorded — writing coverage now.');
    }

    // ── Ancestor phase — bloodline stats cache, only once the history
    // worklist is empty. Same budget, same chaining. At the hop cap any
    // outstanding ancestor work is counted and named, never silently dropped.
    const ancestorResult = await runAncestorPhase(ancestorState, startTime);
    if (!ancestorResult.done) {
      const outstanding = ancestorState.resolveQueue.length + (Array.isArray(ancestorState.fetchQueue) ? ancestorState.fetchQueue.length : Object.keys(ancestorState.ancestors).length);
      if (hop < HOP_CAP) {
        await chainNextHop('ancestors: ' + outstanding + ' still queued');
        return { statusCode: 200, headers, body: JSON.stringify({ status: 'partial', hop: hop, remaining: 0, ancestorsOutstanding: outstanding, fetched: fetched }) };
      }
      ancestorState.counts.unresolvable += ancestorState.resolveQueue.length;
      (ancestorState.fetchQueue || []).forEach(function(id) {
        const known = ancestorState.ancestors[id] || { name: '', kind: '' };
        ancestorState.counts.failed++;
        ancestorState.failures.push({ id: id, name: known.name, kind: known.kind, reason: 'not processed — racing-sweep exceeded its ' + HOP_CAP + '-hop cap for the night' });
      });
      ancestorState.resolveQueue = [];
      ancestorState.fetchQueue = [];
      console.log('[racing-sweep] hop cap reached with ' + outstanding + ' ancestor item(s) unprocessed — recorded, writing coverage now.');
    }

    // ── Report phase — every date gets a coverage line + a named failure
    // list, even a date with zero failures (an explicit empty array, not an
    // absent key, so "no report" is never confused with "clean").
    const failedIdsByDate = {};
    meta.dates.forEach(function(d) { failedIdsByDate[d] = new Set(); });
    failures.forEach(function(f) {
      (f.dates || []).forEach(function(d) { if (failedIdsByDate[d]) failedIdsByDate[d].add(f.horse_id); });
    });

    for (const d of meta.dates) {
      const totalIds = (meta.perDateHorseIds && meta.perDateHorseIds[d]) || [];
      const uniqueTotal = new Set(totalIds).size;
      const withoutCount = failedIdsByDate[d] ? failedIdsByDate[d].size : 0;
      const withCount = Math.max(0, uniqueTotal - withoutCount);
      await redisSet('sweep:coverage:' + d, withCount + ' with form-history, ' + withoutCount + ' without (' + uniqueTotal + ' total declared)');

      const dateFailures = failures.filter(function(f) { return (f.dates || []).indexOf(d) !== -1; })
        .map(function(f) { return { horse_id: f.horse_id, horseName: f.horseName, reason: f.reason }; });
      await redisSet('sweep:failures:' + d, dateFailures);
    }

    // Ancestor coverage — one line in the log plus a checkable key holding
    // the counts and every individual fetch failure by name and id.
    const ancestorReport = {
      distinctAncestors: Object.keys(ancestorState.ancestors).length,
      runnersWithIdsOnCard: ancestorState.counts.fromCards,
      runnersResolvedViaProfile: ancestorState.counts.resolvedViaProfile,
      runnersUnresolvable: ancestorState.counts.unresolvable,
      fetchedTonight: ancestorState.counts.fetched,
      alreadyCached: ancestorState.counts.alreadyCached,
      failed: ancestorState.counts.failed,
      failures: ancestorState.failures,
      completedAt: new Date().toISOString()
    };
    await redisSet('sweep:ancestors:' + runKey, ancestorReport);
    console.log('[racing-sweep] ancestors: ' + ancestorReport.distinctAncestors + ' distinct | fetched tonight ' + ancestorReport.fetchedTonight + ' | already cached ' + ancestorReport.alreadyCached + ' | failed ' + ancestorReport.failed + ' | runners with ids on card ' + ancestorReport.runnersWithIdsOnCard + ', resolved via profile ' + ancestorReport.runnersResolvedViaProfile + ', unresolvable ' + ancestorReport.runnersUnresolvable);
    ancestorState.failures.forEach(function(f) { console.log('[racing-sweep] ancestor failure: ' + f.kind + ' ' + (f.name || '?') + ' (' + f.id + ') — ' + f.reason); });

    await redisSet('racing-sweep:worklist:' + runKey, []);
    await redisSet('racing-sweep:failures:' + runKey, []);
    await redisSet('racing-sweep:ancestors:' + runKey, null);
    const summary = {
      status: 'complete',
      runKey: runKey,
      dates: meta.dates,
      completedAt: new Date().toISOString(),
      fetched: fetched,
      genuineDebutants: skippedAsGenuineDebutant,
      failed: failures.length,
      staleBreakdown: meta.staleCounts || { blankClassGB: 0, fiftyRows: 0, noPatternField: 0 },
      ancestors: {
        distinct: ancestorReport.distinctAncestors,
        fetchedTonight: ancestorReport.fetchedTonight,
        alreadyCached: ancestorReport.alreadyCached,
        failed: ancestorReport.failed,
        runnersUnresolvable: ancestorReport.runnersUnresolvable
      },
      elapsedSec: Math.round((Date.now() - startTime) / 1000),
      hop: hop
    };
    await redisSet('racing-sweep:complete:' + runKey, summary);
    console.log('[racing-sweep] DONE', JSON.stringify(summary));
    try { await redisSet('racing-sweep:lock:' + runKey, null); } catch (ue) {}
    return { statusCode: 200, headers, body: JSON.stringify(summary) };
  } catch (e) {
    console.log('[racing-sweep] ERROR', e.message);
    try { await redisSet('racing-sweep:lock:' + runKey, null); } catch (ue) {}
    return { statusCode: 500, headers, body: JSON.stringify({ error: e.message, elapsedSec: Math.round((Date.now() - startTime) / 1000) }) };
  }
};
