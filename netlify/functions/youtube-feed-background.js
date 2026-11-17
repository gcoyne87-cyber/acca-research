const https = require('https');

// YouTube racing-video feed — refreshes youtube:feed in Redis. Fired by
// youtube-feed-trigger.js (which carries the cron and POSTs here with
// x-build-secret). No schedule on this file deliberately — same rule as
// hotyard-nightly-background.js: a schedule paired directly onto a
// -background function never fires, and a scheduled function rejects
// external HTTP triggers at Netlify's edge. Being unscheduled, this file is
// also the manual entry point (x-build-secret header, ?force=1).
//
// Irish slot: one run daily at 07:00. The trigger's cron is UTC and fires
// at both candidate UTC hours (06:00 and 07:00); this job runs only when
// the Irish hour is one of SLOT_HOURS and once per slot
// (youtube-feed:ran), so the other fire exits before spending any quota.
// ?force=1 bypasses the window and the once-per-slot mark.
module.exports.config = { timeout: 300 };

// ── SEARCHES ─────────────────────────────────────────────────────────────────
// QUOTA RULE: each search.list call costs 100 units of the free 10,000-unit
// daily allowance. 16 searches = 1,600 units per run, so the hard ceiling is
// 16 searches at 6 runs/day (9,600 units). The schedule uses 1 run x 1,600
// units = 1,600/day, leaving room for up to 5 forced manual runs. NEVER add
// a search without removing one or reducing run frequency.
// The views + duration lookup (videos.list) costs 1 unit per call of up to
// 50 ids — at most 6 calls for a full 300-video feed, so it is negligible
// next to the searches and does not change the ceiling above.
const SEARCHES = [
  'horse racing tips',
  'horse racing stable tour',
  'horse racing trainer interview',
  'irish horse racing',
  'cheltenham racing',
  'horse racing preview',
  'national hunt racing',
  'jump racing',
  'horse racing news',
  'horse racing gallops',
  'cheltenham festival',
  'horse racing results reaction',
  'punchestown racing OR leopardstown racing OR fairyhouse racing',
  'willie mullins OR gordon elliott OR nicky henderson',
  'dan skelton OR paul nicholls OR henry de bromhead',
  'ITV racing OR racing tv OR sky sports racing'
];

// ── FAVOURITE CHANNELS ───────────────────────────────────────────────────────
// Channel names (exact, case-insensitive) the user trusts — videos from these
// channels ALWAYS pass the keep filter, discard list ignored.
const FAVOURITE_CHANNELS = [];

// ── FILTER WORD LISTS ────────────────────────────────────────────────────────
// Matched as whole words/phrases (an optional trailing "s" is allowed) against
// title + channel name + description, case-insensitive, with apostrophes
// removed and other punctuation treated as spaces — so "each-way" matches
// "each way" and "O'Neill" matches "ONeill".
//
// Two-tier keep rule, and discard always wins:
//  - STRONG (KEEP_NAMES, KEEP_TERMS): one hit keeps the video on its own.
//  - WEAK (KEEP_COURSES): a course name is also a town, so it keeps the video
//    only when a RACING_CONTEXT word appears too. A course name alone let a
//    Cheltenham pizza shop and a #fairyhouse hashtag into the first live run.

const KEEP_COURSES = [
  'Cheltenham', 'Aintree', 'Punchestown', 'Leopardstown', 'Naas', 'Fairyhouse',
  'Ascot', 'Newbury', 'Kempton', 'Sandown', 'Navan', 'Gowran', 'Galway',
  'Kelso', 'Ayr', 'Wetherby', 'Exeter', 'Wincanton', 'Fontwell', 'Ludlow',
  'Uttoxeter', 'Doncaster', 'Haydock', 'Newcastle', 'Curragh', 'Down Royal',
  'Thurles', 'Clonmel', 'Limerick', 'Cork', 'Listowel'
];

const KEEP_NAMES = [
  'Mullins', 'Elliott', 'Henderson', 'Nicholls', 'Skelton', 'de Bromhead',
  'Cromwell', 'Pipe', 'Russell', 'Lavelle', 'Pauling', 'Hobbs', 'Tizzard',
  'Twiston-Davies', 'Snowden', 'Murphy', "O'Neill", "O'Brien", 'King'
];

const KEEP_TERMS = [
  'NAP', 'each-way', 'Grade 1', 'novice hurdle', 'chase', 'bumper',
  'Gold Cup', 'Grand National', 'stable tour', 'declarations', 'racecard',
  'going'
];

const RACING_CONTEXT = [
  'racing', 'races', 'raceday', 'racecourse', 'racecard', 'horse', 'horses',
  'tips', 'preview', 'runners', 'declarations', 'hurdle', 'chase', 'bumper',
  'jockey', 'trainer', 'odds', 'each-way', 'NAP', 'going'
];

const DISCARD_WORDS = [
  // US / AUS / HK racing
  'Kentucky', 'Breeders Cup', 'Santa Anita', 'Churchill Downs',
  'Melbourne Cup', 'Flemington', 'Sha Tin', 'Happy Valley', 'Del Mar',
  'Saratoga',
  // harness / trotting
  'harness', 'trotting', 'trotter',
  // virtual racing
  'virtual racing', 'virtual horse racing',
  // toys / games
  'toy', 'horse game', 'racing game', 'video game', 'gameplay',
  'Minecraft', 'Roblox'
];

// ── STORAGE LIMITS ───────────────────────────────────────────────────────────
const FEED_KEY = 'youtube:feed';
const META_KEY = 'youtube:feed:meta';
const RAN_KEY = 'youtube-feed:ran';
const FEED_CAP = 300;
const MAX_AGE_DAYS = 7;
const SEARCH_WINDOW_HOURS = 48;
const DETAILS_BATCH = 50;
const SLOT_HOURS = [7];

const UPSTASH_URL = process.env.UPSTASH_REDIS_REST_URL;
const UPSTASH_TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN;
const YOUTUBE_KEY = process.env.YOUTUBE_API_KEY;

// ── REDIS — same helpers as hotyard-nightly-background.js ────────────────────

function redisGet(key) {
  const url = new URL(UPSTASH_URL);
  return new Promise(function(resolve) {
    const req = https.request({
      hostname: url.hostname, path: '/get/' + encodeURIComponent(key), method: 'GET',
      headers: { Authorization: 'Bearer ' + UPSTASH_TOKEN }
    }, function(res) {
      let d = ''; res.on('data', function(c) { d += c; });
      res.on('end', function() { try { const r = JSON.parse(d); resolve(r.result ? JSON.parse(r.result) : null); } catch (e) { resolve(null); } });
    });
    req.on('error', function() { resolve(null); });
    req.end();
  });
}

function redisSet(key, value) {
  const url = new URL(UPSTASH_URL);
  const body = JSON.stringify(value);
  return new Promise(function(resolve, reject) {
    const req = https.request({
      hostname: url.hostname, path: '/set/' + encodeURIComponent(key), method: 'POST',
      headers: { Authorization: 'Bearer ' + UPSTASH_TOKEN, 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) }
    }, function(res) {
      let d = ''; res.on('data', function(c) { d += c; });
      res.on('end', function() {
        if (res.statusCode !== 200) return reject(new Error('Redis write failed: HTTP ' + res.statusCode + ' ' + d));
        try { const parsed = JSON.parse(d); if (parsed && parsed.error) return reject(new Error('Redis write error: ' + parsed.error)); } catch (e) {}
        resolve(d);
      });
    });
    req.on('error', reject);
    req.write(body); req.end();
  });
}

function irishNow(d) {
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Dublin', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false }).formatToParts(d || new Date());
  const get = function(type) { return (parts.find(function(p) { return p.type === type; }) || {}).value || ''; };
  let hour = parseInt(get('hour'), 10); if (hour === 24) hour = 0;
  return { date: get('year') + '-' + get('month') + '-' + get('day'), hour: hour, minute: parseInt(get('minute'), 10) };
}

// ── YOUTUBE ──────────────────────────────────────────────────────────────────

// One search.list call (100 quota units).
function youtubeSearch(query, publishedAfter) {
  return youtubeGet('/youtube/v3/search?part=snippet&type=video&order=date&maxResults=25'
    + '&publishedAfter=' + encodeURIComponent(publishedAfter)
    + '&q=' + encodeURIComponent(query));
}

// One videos.list call (1 quota unit) for up to DETAILS_BATCH video ids.
function youtubeVideoDetails(ids) {
  return youtubeGet('/youtube/v3/videos?part=statistics,contentDetails&maxResults=50'
    + '&id=' + encodeURIComponent(ids.join(',')));
}

// One YouTube Data API GET. Never retries. Resolves { items } on success or
// { error: { status, reason, message } } on any failure.
function youtubeGet(pathNoKey) {
  const path = pathNoKey + '&key=' + encodeURIComponent(YOUTUBE_KEY);
  return new Promise(function(resolve) {
    const req = https.request({
      hostname: 'www.googleapis.com', path: path, method: 'GET',
      headers: { Accept: 'application/json' }, timeout: 15000
    }, function(res) {
      let d = ''; res.on('data', function(c) { d += c; });
      res.on('end', function() {
        let parsed = null;
        try { parsed = JSON.parse(d); } catch (e) {}
        if (res.statusCode === 200 && parsed) return resolve({ items: parsed.items || [] });
        const err = (parsed && parsed.error) || {};
        const first = (err.errors && err.errors[0]) || {};
        resolve({ error: { status: res.statusCode, reason: first.reason || '', message: err.message || d.slice(0, 200) } });
      });
    });
    req.on('error', function(e) { resolve({ error: { status: 0, reason: 'network', message: e.message } }); });
    req.on('timeout', function() { req.destroy(new Error('request timed out')); });
    req.end();
  });
}

// search.list returns HTML-escaped titles and descriptions.
function decodeEntities(s) {
  return String(s || '')
    .replace(/&#(\d+);/g, function(m, n) { return String.fromCharCode(parseInt(n, 10)); })
    .replace(/&quot;/g, '"').replace(/&apos;/g, "'")
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&');
}

// The API's ISO 8601 duration ("PT4M5S", "PT1H2M3S") as "mm:ss" or "h:mm:ss".
// null when it is missing, unparseable or zero (a live or upcoming stream).
function formatDuration(iso) {
  const m = /^P(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?)?$/.exec(String(iso || ''));
  if (!m) return null;
  const total = (+m[1] || 0) * 86400 + (+m[2] || 0) * 3600 + (+m[3] || 0) * 60 + (+m[4] || 0);
  if (!total) return null;
  const h = Math.floor(total / 3600);
  const mm = String(Math.floor((total % 3600) / 60)).padStart(2, '0');
  const ss = String(total % 60).padStart(2, '0');
  return h ? h + ':' + mm + ':' + ss : mm + ':' + ss;
}

// ── FILTER ───────────────────────────────────────────────────────────────────

function normalise(s) {
  return String(s || '').toLowerCase()
    .replace(/['‘’`]/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

const STRONG_NORM = [].concat(KEEP_NAMES, KEEP_TERMS).map(normalise);
const WEAK_NORM = KEEP_COURSES.map(normalise);
const CONTEXT_NORM = RACING_CONTEXT.map(normalise);
const DISCARD_NORM = DISCARD_WORDS.map(normalise);
const FAVOURITE_LOWER = FAVOURITE_CHANNELS.map(function(c) { return String(c).trim().toLowerCase(); });

function hitsAny(paddedText, terms) {
  for (let i = 0; i < terms.length; i++) {
    if (paddedText.indexOf(' ' + terms[i] + ' ') !== -1 || paddedText.indexOf(' ' + terms[i] + 's ') !== -1) return true;
  }
  return false;
}

function isRacingVideo(title, channelTitle, description) {
  if (FAVOURITE_LOWER.indexOf(String(channelTitle || '').trim().toLowerCase()) !== -1) return true;
  const text = ' ' + normalise(title + ' ' + channelTitle + ' ' + description) + ' ';
  if (hitsAny(text, DISCARD_NORM)) return false;
  if (hitsAny(text, STRONG_NORM)) return true;
  return hitsAny(text, WEAK_NORM) && hitsAny(text, CONTEXT_NORM);
}

function categorise(title) {
  const t = ' ' + normalise(title) + ' ';
  if (hitsAny(t, ['stable tour'])) return 'stable-tour';
  if (hitsAny(t, ['interview'])) return 'interview';
  if (hitsAny(t, ['tip', 'nap', 'selection', 'best bet'])) return 'tips';
  return 'other';
}

// ── THE JOB ──────────────────────────────────────────────────────────────────

exports.handler = async function(event) {
  const headers = { 'Content-Type': 'application/json' };
  const qs = event.queryStringParameters || {};
  const isScheduled = !event.httpMethod;
  if (!isScheduled) {
    const secret = qs.secret || (event.headers && event.headers['x-build-secret']);
    if (secret !== process.env.BUILD_SECRET) {
      return { statusCode: 401, headers, body: JSON.stringify({ error: 'Unauthorised' }) };
    }
  }
  const force = qs.force === '1';

  const now = irishNow();
  if (!force && SLOT_HOURS.indexOf(now.hour) === -1) {
    console.log('[youtube-feed] skipped — ' + now.hour + ':' + String(now.minute).padStart(2, '0') + ' Irish is not a run slot');
    return { statusCode: 200, headers, body: JSON.stringify({ skipped: true, reason: 'not an Irish run slot', irishNow: now }) };
  }

  // Marked at the START of the run, not the end: a run that dies half-way
  // has already spent quota, so its slot must not be run again.
  const slot = now.date + ':' + now.hour;
  if (!force) {
    const ran = await redisGet(RAN_KEY);
    if (ran && ran.slot === slot) {
      console.log('[youtube-feed] skipped — slot ' + slot + ' already ran at ' + ran.startedAt);
      return { statusCode: 200, headers, body: JSON.stringify({ skipped: true, reason: 'slot already ran', slot: slot }) };
    }
    await redisSet(RAN_KEY, { slot: slot, startedAt: new Date().toISOString() });
  }

  if (!YOUTUBE_KEY) {
    console.error('[youtube-feed] YOUTUBE_API_KEY is not set — stopping');
    return { statusCode: 500, headers, body: JSON.stringify({ error: 'YOUTUBE_API_KEY not set' }) };
  }

  console.log('[youtube-feed] START ' + new Date().toISOString() + (force ? ' (forced)' : ' slot=' + slot));

  const publishedAfter = new Date(Date.now() - SEARCH_WINDOW_HOURS * 3600 * 1000).toISOString();
  const found = {};
  const meta = {
    lastRunAt: new Date().toISOString(),
    forced: force,
    searchesPlanned: SEARCHES.length,
    searchesRun: 0,
    searchesFailed: 0,
    resultsSeen: 0,
    kept: 0,
    discarded: 0,
    newVideos: 0,
    feedSize: 0,
    detailCalls: 0,
    detailsFetched: 0,
    detailsError: null,
    stoppedEarly: null
  };

  for (let i = 0; i < SEARCHES.length; i++) {
    const q = SEARCHES[i];
    const r = await youtubeSearch(q, publishedAfter);
    if (r.error) {
      console.error('[youtube-feed] search "' + q + '" failed: HTTP ' + r.error.status + ' ' + r.error.reason + ' — ' + r.error.message);
      meta.searchesFailed++;
      // Quota exhausted, or a key/config rejection that every remaining
      // search would hit too: stop the run here. No retry, no loop.
      if (r.error.status === 403 || r.error.status === 400 || r.error.status === 401 || /quota|limitExceeded/i.test(r.error.reason)) {
        meta.stoppedEarly = r.error.reason || ('HTTP ' + r.error.status);
        console.error('[youtube-feed] stopping run after ' + meta.searchesRun + ' completed searches: ' + meta.stoppedEarly);
        break;
      }
      continue;
    }
    meta.searchesRun++;
    for (const item of r.items) {
      const videoId = item && item.id && item.id.videoId;
      const sn = item && item.snippet;
      if (!videoId || !sn) continue;
      meta.resultsSeen++;
      const title = decodeEntities(sn.title);
      const channelTitle = decodeEntities(sn.channelTitle);
      if (!isRacingVideo(title, channelTitle, decodeEntities(sn.description))) { meta.discarded++; continue; }
      meta.kept++;
      if (found[videoId]) continue;
      const thumbs = sn.thumbnails || {};
      found[videoId] = {
        videoId: videoId,
        title: title,
        channelTitle: channelTitle,
        publishedAt: sn.publishedAt,
        thumbnail: (thumbs.medium && thumbs.medium.url) || (thumbs.default && thumbs.default.url) || null,
        category: categorise(title)
      };
    }
  }

  try {
    const existing = await redisGet(FEED_KEY);
    const byId = {};
    (Array.isArray(existing) ? existing : []).forEach(function(v) { if (v && v.videoId) byId[v.videoId] = v; });
    Object.keys(found).forEach(function(id) { if (!byId[id]) { byId[id] = found[id]; meta.newVideos++; } });

    const cutoff = Date.now() - MAX_AGE_DAYS * 24 * 3600 * 1000;
    const feed = Object.keys(byId).map(function(id) { return byId[id]; })
      .filter(function(v) { const t = Date.parse(v.publishedAt); return !isNaN(t) && t >= cutoff; })
      .sort(function(a, b) { return Date.parse(b.publishedAt) - Date.parse(a.publishedAt); })
      .slice(0, FEED_CAP);
    meta.feedSize = feed.length;

    // Views + duration for every entry that has never had them (duration
    // undefined): this run's new videos, plus any an earlier failed lookup
    // left bare. Entries that already carry values keep them untouched. A
    // video the API no longer returns gets nulls so it is never asked for
    // again. Skipped when the searches stopped early — the same quota or key
    // problem would fail this call too, and the next run picks them up.
    if (!meta.stoppedEarly) {
      const need = feed.filter(function(v) { return v.duration === undefined; });
      for (let i = 0; i < need.length; i += DETAILS_BATCH) {
        const chunk = need.slice(i, i + DETAILS_BATCH);
        const r = await youtubeVideoDetails(chunk.map(function(v) { return v.videoId; }));
        meta.detailCalls++;
        if (r.error) {
          meta.detailsError = r.error.reason || ('HTTP ' + r.error.status);
          console.error('[youtube-feed] videos.list failed: HTTP ' + r.error.status + ' ' + r.error.reason + ' — ' + r.error.message);
          break;
        }
        const details = {};
        r.items.forEach(function(it) { if (it && it.id) details[it.id] = it; });
        chunk.forEach(function(v) {
          const it = details[v.videoId];
          const views = it && it.statistics && it.statistics.viewCount;
          v.viewCount = (views !== undefined && views !== null && !isNaN(Number(views))) ? Number(views) : null;
          v.duration = it ? formatDuration(it.contentDetails && it.contentDetails.duration) : null;
          if (it) meta.detailsFetched++;
        });
      }
    }

    await redisSet(FEED_KEY, feed);
    await redisSet(META_KEY, meta);
  } catch (e) {
    console.error('[youtube-feed] storage failed: ' + e.message);
    return { statusCode: 500, headers, body: JSON.stringify({ error: e.message, meta: meta }) };
  }

  console.log('[youtube-feed] DONE ' + new Date().toISOString() + ' ' + JSON.stringify(meta));
  return { statusCode: 200, headers, body: JSON.stringify(meta) };
};

module.exports._test = { formatDuration: formatDuration, FAVOURITE_CHANNELS: FAVOURITE_CHANNELS, isRacingVideo: isRacingVideo, categorise: categorise, normalise: normalise, decodeEntities: decodeEntities, KEEP_COURSES: KEEP_COURSES, KEEP_NAMES: KEEP_NAMES, KEEP_TERMS: KEEP_TERMS, RACING_CONTEXT: RACING_CONTEXT, DISCARD_WORDS: DISCARD_WORDS, SEARCHES: SEARCHES };
