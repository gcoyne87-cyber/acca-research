const https = require('https');

// YouTube racing-video feed — refreshes youtube:feed in Redis. Fired by
// youtube-feed-trigger.js (which carries the cron and POSTs here with
// x-build-secret). No schedule on this file deliberately — same rule as
// hotyard-nightly-background.js: a schedule paired directly onto a
// -background function never fires, and a scheduled function rejects
// external HTTP triggers at Netlify's edge. Being unscheduled, this file is
// also the manual entry point (x-build-secret header, ?force=1).
//
// Irish slots: two runs daily, at 07:00 and 16:00. The trigger's cron is UTC
// and fires at both candidate UTC hours for each slot (06:00/07:00 and
// 15:00/16:00); this job runs only when the Irish hour is one of SLOT_HOURS
// and once per slot (youtube-feed:ran), so the other fire of each pair exits
// before spending any quota.
// ?force=1 bypasses the window and the once-per-slot mark.
module.exports.config = { timeout: 300 };

// ── SEARCHES ─────────────────────────────────────────────────────────────────
// QUOTA RULE: each search.list call costs 100 units of the free 10,000-unit
// daily allowance. 16 searches = 1,600 units per run, so the hard ceiling is
// 16 searches at 6 runs/day (9,600 units). The schedule uses 2 runs x 1,600
// units = 3,200/day, leaving room for ~4 forced manual runs. NEVER add
// a search without removing one or reducing run frequency.
// The views + duration lookup (videos.list) costs 1 unit per call of up to
// 50 ids — at most 20 calls for a full 1,000-video feed, so it is negligible
// next to the searches and does not change the ceiling above.
// Favourite channels: the uploads RSS feed is free (no API, no quota).
// Resolving a channel NAME to its id costs 101 units (search.list 100 +
// channels.list 1) but happens ONCE per name — the answer, including "no
// match", is cached in youtube:channel-ids. Adding a favourite therefore
// costs 101 units on the next run only.
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
// Each one is also a SOURCE: its public uploads RSS feed is read every run,
// so its latest uploads land in the feed even when no search finds them
// (e.g. a short titled only with a horse's name). RSS videos skip the
// keep/discard filter entirely.
const FAVOURITE_CHANNELS = [
  'Sporting Life',
  'Racing TV',
  'At The Races',
  // Sky Sports Racing has no own YouTube channel — its content is on At The Races, already listed
  'ITV Racing',
  'Irish Racing',
  'Racing Post',
  'The Racing Life',
  'GJSports',
  'The Jumps Show',
  'William Hill Racing',
  'AK BETS',
  'BensBets',
  'oddschecker',
  'The Jockey Club',
  'Coral Racing Club',
  'DigiRacing',
  'GBpointing',
  'Unibet',
  'The Overround',
  // Star Sports removed: the exact-title match is the Indian cricket broadcaster, not the bookmaker — re-add only with the bookmaker's verified exact channel title
  "Racing's Inside Track tv",
  "Jockey's"
];

// ── BLOCKED CHANNELS ─────────────────────────────────────────────────────────
// Channel names (case-insensitive) whose videos are ALWAYS discarded — beats
// keep words, beats favourites, beats everything. For auto-generated junk
// channels.
const BLOCKED_CHANNELS = [
  'DAXANALYTICS',
  'Elite Racing HQ',
  'Horse Racing Stories',
  'The Cheltenham Countdown',
  'MCL Horse Racing Insights',
  'HRSE PWR'
];

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

// The discard words that apply to EVERY video, favourite channels included:
// greyhounds and other sports. A trusted multi-sport channel's football or
// NFL upload is still not wanted.
// ("Boxing Day" is exempt from 'boxing': see isDiscarded)
const FAVOURITE_DISCARD_WORDS = [
  // greyhound racing
  'greyhound', 'greyhounds', 'greyhound racing',
  // other sports
  'cricket', 'football', 'soccer', 'NFL', 'premier league', 'rugby', 'darts',
  'snooker', 'tennis', 'boxing', 'UFC', 'formula 1'
];

// The full discard list, for everything that is NOT from a favourite channel:
// the words below plus FAVOURITE_DISCARD_WORDS. The words below do NOT apply
// to favourites — a trusted channel's bloodstock or US-coverage video stays.
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
].concat(FAVOURITE_DISCARD_WORDS);

// ── STORAGE LIMITS ───────────────────────────────────────────────────────────
const FEED_KEY = 'youtube:feed';
const META_KEY = 'youtube:feed:meta';
const RAN_KEY = 'youtube-feed:ran';
const HIDDEN_KEY = 'youtube:hidden';
// Rolling 30-day archive: each run takes in anything published in the last
// 7 days (searches and favourite-channel RSS alike), and stored videos are
// kept for 30 days, newest first, up to 1,000.
const FEED_CAP = 1000;
const MAX_AGE_DAYS = 30;
const SEARCH_WINDOW_HOURS = 7 * 24;
const DETAILS_BATCH = 50;
const CHANNEL_IDS_KEY = 'youtube:channel-ids';
const SHORT_MAX_SECONDS = 70;
const SLOT_HOURS = [7, 16];

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

// Resolve a favourite channel NAME to a channel id: one search.list
// type=channel (100 units) plus one channels.list for subscriber counts
// (1 unit). ONLY a channel whose title equals the name exactly
// (case-insensitive) is accepted; if several share that exact title, the
// one with the most subscribers. There is deliberately no fallback to a
// near match: favourite channels bypass the keep/discard filter, so a wrong
// guess injects a whole unrelated channel ("Sky Sports Racing" once resolved
// to Sky Sports F1 this way). Resolves { channelId, title, subscribers,
// exact: true }, { none: true, candidates } when nothing matches exactly,
// or { error }. A no-match is fixed by hand in youtube:channel-ids.
async function resolveChannel(name) {
  const s = await youtubeGet('/youtube/v3/search?part=snippet&type=channel&maxResults=5&q=' + encodeURIComponent(name));
  if (s.error) return { error: s.error };
  const candidates = s.items.map(function(it) {
    const sn = (it && it.snippet) || {};
    return { channelId: (it && it.id && it.id.channelId) || sn.channelId, title: decodeEntities(sn.channelTitle || sn.title), subscribers: 0 };
  }).filter(function(c) { return c.channelId; });
  const wanted = name.trim().toLowerCase();
  const exact = candidates.filter(function(c) { return String(c.title || '').trim().toLowerCase() === wanted; });
  if (!exact.length) return { none: true, candidates: candidates.map(function(c) { return c.title; }) };
  const st = await youtubeGet('/youtube/v3/channels?part=statistics&maxResults=50&id=' + encodeURIComponent(exact.map(function(c) { return c.channelId; }).join(',')));
  if (!st.error) {
    const subs = {};
    st.items.forEach(function(it) { if (it && it.id) subs[it.id] = Number(it.statistics && it.statistics.subscriberCount) || 0; });
    exact.forEach(function(c) { c.subscribers = subs[c.channelId] || 0; });
  }
  const best = exact.slice().sort(function(a, b) { return b.subscribers - a.subscribers; })[0];
  return { channelId: best.channelId, title: best.title, subscribers: best.subscribers, exact: true };
}

// A channel's public uploads RSS feed — free, no API key, no quota. Resolves
// { xml } or { error: message }. Never retries.
function fetchChannelRss(channelId) {
  return new Promise(function(resolve) {
    const req = https.request({
      hostname: 'www.youtube.com', path: '/feeds/videos.xml?channel_id=' + encodeURIComponent(channelId), method: 'GET',
      headers: { Accept: 'application/atom+xml, application/xml' }, timeout: 15000
    }, function(res) {
      let d = ''; res.on('data', function(c) { d += c; });
      res.on('end', function() { resolve(res.statusCode === 200 ? { xml: d } : { error: 'HTTP ' + res.statusCode }); });
    });
    req.on('error', function(e) { resolve({ error: e.message }); });
    req.on('timeout', function() { req.destroy(new Error('request timed out')); });
    req.end();
  });
}

// The <entry> blocks of an uploads feed as { videoId, title, channelTitle,
// publishedAt }. The feed's own shape is fixed, so a regex read is enough.
function parseRssEntries(xml) {
  const out = [];
  const pick = function(re, s) { const m = re.exec(s); return m ? m[1].trim() : ''; };
  const entryRe = /<entry>([\s\S]*?)<\/entry>/g;
  let m;
  while ((m = entryRe.exec(String(xml || '')))) {
    const e = m[1];
    const videoId = pick(/<yt:videoId>([^<]+)<\/yt:videoId>/, e);
    const t = Date.parse(pick(/<published>([^<]+)<\/published>/, e));
    if (!videoId || isNaN(t)) continue;
    out.push({
      videoId: videoId,
      title: decodeEntities(pick(/<title>([\s\S]*?)<\/title>/, e)),
      channelTitle: decodeEntities(pick(/<author>[\s\S]*?<name>([\s\S]*?)<\/name>/, e)),
      publishedAt: new Date(t).toISOString()
    });
  }
  return out;
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
    .replace(/&#x([0-9a-f]+);/gi, function(m, n) { return String.fromCharCode(parseInt(n, 16)); })
    .replace(/&quot;/g, '"').replace(/&apos;/g, "'")
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&');
}

// hqdefault (480px) exists for every video, so it can be built from the id
// alone — used for RSS videos and to upgrade older stored entries.
function hqThumbnail(videoId) {
  return 'https://i.ytimg.com/vi/' + videoId + '/hqdefault.jpg';
}

// The sharpest thumbnail the API response offers: maxres, then standard,
// then high, then medium. Falls back to the built hqdefault URL.
function bestThumbnail(thumbs, videoId) {
  const t = thumbs || {};
  const sizes = ['maxres', 'standard', 'high', 'medium'];
  for (let i = 0; i < sizes.length; i++) {
    if (t[sizes[i]] && t[sizes[i]].url) return t[sizes[i]].url;
  }
  return hqThumbnail(videoId);
}

// The API's ISO 8601 duration ("PT4M5S", "PT1H2M3S") in seconds. null when
// it is missing, unparseable or zero (a live or upcoming stream).
function durationSeconds(iso) {
  const m = /^P(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?)?$/.exec(String(iso || ''));
  if (!m) return null;
  const total = (+m[1] || 0) * 86400 + (+m[2] || 0) * 3600 + (+m[3] || 0) * 60 + (+m[4] || 0);
  return total || null;
}

// Seconds as "mm:ss" or "h:mm:ss"; null stays null.
function formatDuration(total) {
  if (!total) return null;
  const h = Math.floor(total / 3600);
  const mm = String(Math.floor((total % 3600) / 60)).padStart(2, '0');
  const ss = String(total % 60).padStart(2, '0');
  return h ? h + ':' + mm + ':' + ss : mm + ':' + ss;
}

// A full feed entry for a link the user pasted, built from one videos.list
// item (part=snippet,statistics,contentDetails). Used by transcribe-youtube.js.
// manual: true keeps it out of the keep/discard filter, the 30-day retention
// and the cap for good — see the merge in the handler.
function manualEntryFromItem(item) {
  const sn = item.snippet || {};
  const views = item.statistics && item.statistics.viewCount;
  const secs = durationSeconds(item.contentDetails && item.contentDetails.duration);
  const title = String(sn.title || '');
  return {
    videoId: item.id,
    title: title,
    channelTitle: String(sn.channelTitle || ''),
    publishedAt: sn.publishedAt || new Date().toISOString(),
    thumbnail: bestThumbnail(sn.thumbnails, item.id),
    category: categorise(title),
    viewCount: (views !== undefined && views !== null && !isNaN(Number(views))) ? Number(views) : null,
    duration: formatDuration(secs),
    isShort: secs !== null && secs <= SHORT_MAX_SECONDS,
    manual: true,
    addedAt: new Date().toISOString()
  };
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
const FAVOURITE_DISCARD_NORM = FAVOURITE_DISCARD_WORDS.map(normalise);
const FAVOURITE_LOWER = FAVOURITE_CHANNELS.map(function(c) { return String(c).trim().toLowerCase(); });

function hitsAny(paddedText, terms) {
  for (let i = 0; i < terms.length; i++) {
    if (paddedText.indexOf(' ' + terms[i] + ' ') !== -1 || paddedText.indexOf(' ' + terms[i] + 's ') !== -1) return true;
  }
  return false;
}

const BLOCKED_LOWER = BLOCKED_CHANNELS.map(function(c) { return String(c).trim().toLowerCase(); });

function isBlockedChannel(channelTitle) {
  return BLOCKED_LOWER.indexOf(String(channelTitle || '').trim().toLowerCase()) !== -1;
}

function isFavouriteChannel(channelTitle) {
  return FAVOURITE_LOWER.indexOf(String(channelTitle || '').trim().toLowerCase()) !== -1;
}

// True when a video must be thrown away whatever else is true of it: it is
// from a blocked channel, or its title/channel/description hits the discard
// list. A favourite channel is checked against the greyhound and other-sport
// words only (FAVOURITE_DISCARD_WORDS); everything else against the full
// list. "Boxing Day" is taken out first so the 'boxing' discard word cannot
// remove the Christmas racing (King George, Leopardstown) coverage.
function isDiscarded(title, channelTitle, description) {
  if (isBlockedChannel(channelTitle)) return true;
  const text = (' ' + normalise((title || '') + ' ' + (channelTitle || '') + ' ' + (description || '')) + ' ').replace(/ boxing day /g, ' ');
  return hitsAny(text, isFavouriteChannel(channelTitle) ? FAVOURITE_DISCARD_NORM : DISCARD_NORM);
}

// Order: blocked channel / discard list first (beats everything), then
// favourite channels (which skip the KEEP requirement — their purpose is
// titles that are just a horse's name — and the US-racing and other general
// discard words), then the keep words.
function isRacingVideo(title, channelTitle, description) {
  if (isDiscarded(title, channelTitle, description)) return false;
  if (isFavouriteChannel(channelTitle)) return true;
  const text = ' ' + normalise(title + ' ' + channelTitle + ' ' + description) + ' ';
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
    hiddenDropped: 0,
    blockedDropped: 0,
    discardDropped: 0,
    rssDiscarded: 0,
    rssChannels: 0,
    rssFetched: 0,
    rssFailed: 0,
    channelsUnresolved: [],
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
      found[videoId] = {
        videoId: videoId,
        title: title,
        channelTitle: channelTitle,
        publishedAt: sn.publishedAt,
        thumbnail: bestThumbnail(sn.thumbnails, videoId),
        category: categorise(title)
      };
    }
  }

  // Favourite channels as a source. A problem here is logged and counted,
  // never thrown: the searches' results must still be stored.
  try {
    const cached = await redisGet(CHANNEL_IDS_KEY);
    const channelIds = (cached && typeof cached === 'object' && !Array.isArray(cached)) ? cached : {};
    let mapChanged = false;

    // 1. Resolve any name not yet in the cache — once ever per name. Skipped
    // when the searches stopped early (the same quota/key problem applies).
    for (let i = 0; i < FAVOURITE_CHANNELS.length && !meta.stoppedEarly; i++) {
      const name = FAVOURITE_CHANNELS[i];
      const key = name.trim().toLowerCase();
      if (Object.prototype.hasOwnProperty.call(channelIds, key)) continue;
      const r = await resolveChannel(name);
      if (r.error) {
        console.error('[youtube-feed] could not resolve channel "' + name + '": HTTP ' + r.error.status + ' ' + r.error.reason + ' — ' + r.error.message + ' (will retry next run)');
        break;
      }
      if (r.none) {
        console.error('[youtube-feed] no channel titled exactly "' + name + '" (search offered: ' + ((r.candidates || []).join(', ') || 'nothing') + ') — cached as unresolved, nothing fetched for it; set the entry by hand in ' + CHANNEL_IDS_KEY + ' or delete it to retry');
        channelIds[key] = null;
      } else {
        console.log('[youtube-feed] resolved "' + name + '" -> ' + r.channelId + ' "' + r.title + '" (' + r.subscribers + ' subscribers, exact title match)');
        channelIds[key] = { channelId: r.channelId, title: r.title, subscribers: r.subscribers, exact: r.exact, resolvedAt: new Date().toISOString() };
      }
      mapChanged = true;
    }
    if (mapChanged) await redisSet(CHANNEL_IDS_KEY, channelIds);

    // 2. Read each resolved channel's uploads RSS (free) and add anything
    // inside the same 7-day intake window the searches use. No KEEP words are
    // required, but blocked channels and the discard list still apply.
    const windowStart = Date.parse(publishedAfter);
    for (let i = 0; i < FAVOURITE_CHANNELS.length; i++) {
      const name = FAVOURITE_CHANNELS[i];
      const entry = channelIds[name.trim().toLowerCase()];
      // No entry, a cached no-match, or an older non-exact guess that was
      // never verified by hand: unresolved, and nothing is fetched for it.
      if (!entry || !entry.channelId || (entry.exact === false && !entry.manuallyVerified)) { meta.channelsUnresolved.push(name); continue; }
      const rss = await fetchChannelRss(entry.channelId);
      if (rss.error) {
        meta.rssFailed++;
        console.error('[youtube-feed] RSS for "' + name + '" (' + entry.channelId + ') failed: ' + rss.error);
        continue;
      }
      meta.rssChannels++;
      parseRssEntries(rss.xml).forEach(function(e) {
        if (Date.parse(e.publishedAt) < windowStart) return;
        meta.rssFetched++;
        if (found[e.videoId]) return;
        if (isDiscarded(e.title, e.channelTitle || entry.title || name, '')) { meta.rssDiscarded++; return; }
        found[e.videoId] = {
          videoId: e.videoId,
          title: e.title,
          channelTitle: e.channelTitle || entry.title || name,
          publishedAt: e.publishedAt,
          thumbnail: hqThumbnail(e.videoId),
          category: categorise(e.title)
        };
      });
    }
    if (meta.channelsUnresolved.length) console.error('[youtube-feed] favourite channels with no channel id: ' + meta.channelsUnresolved.join(', '));
  } catch (e) {
    console.error('[youtube-feed] favourite-channel RSS step failed: ' + e.message);
  }

  try {
    const existing = await redisGet(FEED_KEY);
    const byId = {};
    // Videos the user hid on the page (youtube:hidden, written by
    // hide-youtube-video.js) are dropped here — stored ones are removed and
    // newly found ones never enter — so they never come back.
    const hiddenList = await redisGet(HIDDEN_KEY);
    const hidden = {};
    (Array.isArray(hiddenList) ? hiddenList : []).forEach(function(id) { hidden[id] = true; });
    (Array.isArray(existing) ? existing : []).forEach(function(v) {
      if (!v || !v.videoId) return;
      if (hidden[v.videoId]) { meta.hiddenDropped++; return; }
      // Manual entries (links the user pasted; added by transcribe-youtube.js
      // with manual: true) were chosen by hand: they skip the blocked-channel
      // and discard checks, and below they skip the 30-day cutoff and the
      // cap. They leave only via the Hide ✕.
      if (v.manual === true) { byId[v.videoId] = v; return; }
      // Already-stored videos from a blocked channel are removed, so adding
      // a name to BLOCKED_CHANNELS clears that channel out on the next run.
      if (isBlockedChannel(v.channelTitle)) { meta.blockedDropped++; return; }
      // Likewise for the discard list: a stored video that now fails it
      // (a new discard word, or a favourite's off-topic upload) leaves.
      if (isDiscarded(v.title, v.channelTitle, '')) { meta.discardDropped++; return; }
      byId[v.videoId] = v;
    });
    Object.keys(found).forEach(function(id) {
      if (hidden[id]) { meta.hiddenDropped++; return; }
      // Also covers the favourite-channel RSS path, which skips isRacingVideo.
      if (isBlockedChannel(found[id].channelTitle)) { meta.blockedDropped++; return; }
      if (!byId[id]) { byId[id] = found[id]; meta.newVideos++; }
    });

    // Older stored entries carry the blurry 320px (mqdefault) or 120px
    // thumbnail: upgrade them to hqdefault, built from the id, no API call.
    Object.keys(byId).forEach(function(id) {
      const v = byId[id];
      if (!v.thumbnail || /\/(mqdefault|default)\.jpg/.test(v.thumbnail)) v.thumbnail = hqThumbnail(id);
    });

    const cutoff = Date.now() - MAX_AGE_DAYS * 24 * 3600 * 1000;
    const newestFirst = function(a, b) { return (Date.parse(b.publishedAt) || 0) - (Date.parse(a.publishedAt) || 0); };
    const everything = Object.keys(byId).map(function(id) { return byId[id]; });
    // Retention (30 days) and the cap apply to collected videos only; manual
    // entries are added back afterwards, whatever their age.
    const collected = everything
      .filter(function(v) { return v.manual !== true; })
      .filter(function(v) { const t = Date.parse(v.publishedAt); return !isNaN(t) && t >= cutoff; })
      .sort(newestFirst)
      .slice(0, FEED_CAP);
    const manualKept = everything.filter(function(v) { return v.manual === true; });
    const feed = collected.concat(manualKept).sort(newestFirst);
    meta.feedSize = feed.length;
    meta.manualKept = manualKept.length;

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
          const secs = it ? durationSeconds(it.contentDetails && it.contentDetails.duration) : null;
          v.duration = formatDuration(secs);
          v.isShort = secs !== null && secs <= SHORT_MAX_SECONDS;
          if (it) meta.detailsFetched++;
        });
      }
    }

    // isShort for entries stored before the flag existed: derived from the
    // stored "mm:ss" / "h:mm:ss". Entries still waiting on the lookup
    // (duration undefined) are left alone and get it when the lookup fills.
    feed.forEach(function(v) {
      if (v.isShort !== undefined || v.duration === undefined) return;
      const secs = typeof v.duration === 'string' ? v.duration.split(':').reduce(function(t, p) { return t * 60 + (+p || 0); }, 0) : 0;
      v.isShort = secs > 0 && secs <= SHORT_MAX_SECONDS;
    });

    await redisSet(FEED_KEY, feed);
    await redisSet(META_KEY, meta);
  } catch (e) {
    console.error('[youtube-feed] storage failed: ' + e.message);
    return { statusCode: 500, headers, body: JSON.stringify({ error: e.message, meta: meta }) };
  }

  console.log('[youtube-feed] DONE ' + new Date().toISOString() + ' ' + JSON.stringify(meta));
  return { statusCode: 200, headers, body: JSON.stringify(meta) };
};

// Shared with transcribe-youtube.js (pasted links become manual feed entries).
module.exports.manual = { youtubeGet: youtubeGet, manualEntryFromItem: manualEntryFromItem, FEED_KEY: FEED_KEY, HIDDEN_KEY: HIDDEN_KEY };

module.exports._test = { manualEntryFromItem: manualEntryFromItem, BLOCKED_CHANNELS: BLOCKED_CHANNELS, isBlockedChannel: isBlockedChannel, isDiscarded: isDiscarded, bestThumbnail: bestThumbnail, hqThumbnail: hqThumbnail, durationSeconds: durationSeconds, parseRssEntries: parseRssEntries, fetchChannelRss: fetchChannelRss, formatDuration: formatDuration, FAVOURITE_CHANNELS: FAVOURITE_CHANNELS, isRacingVideo: isRacingVideo, categorise: categorise, normalise: normalise, decodeEntities: decodeEntities, KEEP_COURSES: KEEP_COURSES, KEEP_NAMES: KEEP_NAMES, KEEP_TERMS: KEEP_TERMS, RACING_CONTEXT: RACING_CONTEXT, DISCARD_WORDS: DISCARD_WORDS, SEARCHES: SEARCHES };
