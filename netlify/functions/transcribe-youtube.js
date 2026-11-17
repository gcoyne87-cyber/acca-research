const https = require('https');

// Transcribe one YouTube video for the private feed page — RAW CAPTIONS ONLY,
// no AI calls anywhere.
//
//   POST { videoId }   fetch the video's captions (manual or auto-generated,
//                      English preferred), flatten to plain text with no
//                      timestamps, store it in youtube:transcript:{videoId}
//                      and add the id to youtube:transcribed (which
//                      get-youtube-feed.js already returns as transcribedIds).
//                      Returns { status, chars, title }. A video that is
//                      already transcribed is returned from the store with
//                      no refetch.
//   GET ?videoId=...   return the stored transcript text.
//
// How captions are fetched: the caption-track URLs in the ordinary watch page
// now come back EMPTY without a browser-minted token, so the track list is
// taken from YouTube's app player endpoint (ANDROID client, then IOS), whose
// track URLs do return the text. YouTube sometimes refuses these requests
// from cloud servers ("sign in to confirm you're not a bot"); that is reported
// as status "blocked", distinct from a video that simply has no captions.
//
// Deliberately NO secret, like hide-youtube-video.js: the caller is a static
// page. The only thing this endpoint can do is store the public captions of a
// YouTube video id.

const UPSTASH_URL = process.env.UPSTASH_REDIS_REST_URL;
const UPSTASH_TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN;

const TRANSCRIPT_PREFIX = 'youtube:transcript:';
const TRANSCRIBED_KEY = 'youtube:transcribed';
const TRANSCRIBED_CAP = 2000;
const MAX_CHARS = 400000;

const CLIENTS = [
  { clientName: 'ANDROID', clientVersion: '20.10.38', androidSdkVersion: 30, hl: 'en',
    userAgent: 'com.google.android.youtube/20.10.38 (Linux; U; Android 11) gzip' },
  { clientName: 'IOS', clientVersion: '20.10.4', deviceModel: 'iPhone16,2', hl: 'en',
    userAgent: 'com.google.ios.youtube/20.10.4 (iPhone16,2; U; CPU iOS 18_3_2 like Mac OS X)' }
];

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
        if (res.statusCode !== 200) return reject(new Error('Redis read failed: HTTP ' + res.statusCode));
        try {
          const r = JSON.parse(d);
          resolve(r.result ? JSON.parse(r.result) : null);
        } catch(e) { reject(new Error('Redis read parse error')); }
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
      hostname: url.hostname,
      path: '/set/' + encodeURIComponent(key),
      method: 'POST',
      headers: { 'Authorization': 'Bearer ' + UPSTASH_TOKEN, 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) }
    }, res => {
      let d = '';
      res.on('data', c => d += c);
      res.on('end', () => {
        if (res.statusCode !== 200) return reject(new Error('Redis write failed: HTTP ' + res.statusCode));
        try { const p = JSON.parse(d); if (p && p.error) return reject(new Error('Redis write error: ' + p.error)); } catch(e) {}
        resolve();
      });
    });
    req.on('error', reject);
    req.write(body); req.end();
  });
}

// One HTTPS request to YouTube. Never retries. Resolves { status, body }.
function ytRequest(method, urlString, headers, body) {
  return new Promise((resolve, reject) => {
    const u = new URL(urlString);
    const h = Object.assign({}, headers || {});
    if (body) h['Content-Length'] = Buffer.byteLength(body);
    const req = https.request({ hostname: u.hostname, path: u.pathname + u.search, method: method, headers: h, timeout: 8000 }, res => {
      let d = '';
      res.on('data', c => d += c);
      res.on('end', () => resolve({ status: res.statusCode, body: d }));
    });
    req.on('error', reject);
    req.on('timeout', () => req.destroy(new Error('request timed out')));
    if (body) req.write(body);
    req.end();
  });
}

function decodeEntities(s) {
  return String(s || '')
    .replace(/&#(\d+);/g, function(m, n) { return String.fromCharCode(parseInt(n, 10)); })
    .replace(/&#x([0-9a-f]+);/gi, function(m, n) { return String.fromCharCode(parseInt(n, 16)); })
    .replace(/&quot;/g, '"').replace(/&apos;/g, "'")
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&');
}

// The best caption track: a manual English track, then auto-generated
// English, then any other English variant, then whatever comes first.
function pickTrack(tracks) {
  const list = (tracks || []).filter(function(t) { return t && t.baseUrl; });
  const isEn = function(t) { return /^en(-|$)/i.test(String(t.languageCode || '')); };
  return list.filter(function(t) { return isEn(t) && t.kind !== 'asr'; })[0]
    || list.filter(isEn)[0]
    || list[0]
    || null;
}

// A caption file as plain text with no timestamps. Handles YouTube's JSON
// ("json3") format and its XML formats; cue text is joined with spaces.
function flattenCaptions(raw) {
  const body = String(raw || '');
  let parts = [];
  let parsed = null;
  try { parsed = JSON.parse(body); } catch(e) {}
  if (parsed && Array.isArray(parsed.events)) {
    parts = parsed.events.map(function(ev) {
      return (ev.segs || []).map(function(s) { return s.utf8 || ''; }).join('');
    });
  } else {
    const re = /<(?:text|p)\b[^>]*>([\s\S]*?)<\/(?:text|p)>/g;
    let m;
    while ((m = re.exec(body))) parts.push(decodeEntities(m[1].replace(/<[^>]+>/g, '')));
  }
  // Auto-captions arrive doubly escaped in the XML formats ("&amp;#39;").
  return decodeEntities(parts.join(' ')).replace(/\s+/g, ' ').trim();
}

// Resolves { text, lang, kind, title, author } on success, or
// { failure: 'no-captions' | 'blocked' | 'unavailable' | 'error', detail }.
async function fetchTranscript(videoId) {
  let sawPlayable = false;
  let blocked = null;
  let lastDetail = '';
  for (let i = 0; i < CLIENTS.length; i++) {
    const client = Object.assign({}, CLIENTS[i]);
    const ua = client.userAgent;
    let player;
    try {
      const r = await ytRequest('POST', 'https://www.youtube.com/youtubei/v1/player?prettyPrint=false',
        { 'Content-Type': 'application/json', 'User-Agent': ua }, JSON.stringify({ context: { client: client }, videoId: videoId }));
      if (r.status !== 200) { lastDetail = client.clientName + ' player HTTP ' + r.status; if (r.status === 403 || r.status === 429) blocked = lastDetail; continue; }
      player = JSON.parse(r.body);
    } catch(e) { lastDetail = client.clientName + ' player: ' + e.message; continue; }

    const ps = player.playabilityStatus || {};
    if (ps.status !== 'OK') {
      lastDetail = client.clientName + ' playability ' + ps.status + (ps.reason ? ' — ' + ps.reason : '');
      if (ps.status === 'LOGIN_REQUIRED' || /bot|sign in/i.test(String(ps.reason || ''))) blocked = lastDetail;
      else if (ps.status === 'ERROR' || ps.status === 'UNPLAYABLE') return { failure: 'unavailable', detail: lastDetail };
      continue;
    }
    sawPlayable = true;

    const tracks = ((player.captions || {}).playerCaptionsTracklistRenderer || {}).captionTracks || [];
    const track = pickTrack(tracks);
    if (!track) { lastDetail = client.clientName + ': video has no caption tracks'; continue; }

    try {
      const u = new URL(track.baseUrl);
      u.searchParams.set('fmt', 'json3');
      const c = await ytRequest('GET', u.toString(), { 'User-Agent': ua });
      if (c.status !== 200) { lastDetail = client.clientName + ' captions HTTP ' + c.status; if (c.status === 403 || c.status === 429) blocked = lastDetail; continue; }
      const text = flattenCaptions(c.body);
      if (!text) { lastDetail = client.clientName + ' captions came back empty'; blocked = blocked || lastDetail; continue; }
      const vd = player.videoDetails || {};
      return { text: text.slice(0, MAX_CHARS), lang: track.languageCode || '', kind: track.kind === 'asr' ? 'auto' : 'manual', title: vd.title || '', author: vd.author || '' };
    } catch(e) { lastDetail = client.clientName + ' captions: ' + e.message; continue; }
  }
  if (blocked) return { failure: 'blocked', detail: blocked };
  if (sawPlayable) return { failure: 'no-captions', detail: lastDetail };
  return { failure: 'error', detail: lastDetail };
}

// Retries for YouTube's bot-block refusal ONLY: up to 3 more tries after
// waits of 2s, 4s and 8s. "no-captions", "unavailable" and "error" are final
// on the first answer and are never retried. A retry is skipped when the
// function would not have RETRY_RESERVE_MS left after the wait, so the
// handler always answers before the platform's time limit kills it.
const RETRY_WAITS_MS = [2000, 4000, 8000];
const RETRY_RESERVE_MS = 4000;
const FALLBACK_BUDGET_MS = 9000;   // used only if the platform does not report time left

function sleep(ms) { return new Promise(function(resolve) { setTimeout(resolve, ms); }); }

// fetchTranscript plus the retries. The result always carries `attempts`
// (1 = first try worked or failed for good) and, when a retry was skipped
// for lack of time, `outOfTime: true`.
async function fetchTranscriptWithRetries(videoId, remainingMs, fetchOnce, waits) {
  const fetchFn = fetchOnce || fetchTranscript;
  const waitList = waits || RETRY_WAITS_MS;
  let attempts = 0;
  let outOfTime = false;
  let t;
  for (;;) {
    attempts++;
    t = await fetchFn(videoId);
    if (t.failure !== 'blocked') break;
    const wait = waitList[attempts - 1];
    if (wait === undefined) break;
    if (remainingMs() < wait + RETRY_RESERVE_MS) { outOfTime = true; break; }
    await sleep(wait);
  }
  t.attempts = attempts;
  if (outOfTime) t.outOfTime = true;
  return t;
}

const FAILURE_MESSAGES = {
  'no-captions': 'No captions available for this video',
  'blocked': 'YouTube refused the caption request from the server',
  'unavailable': 'This video is unavailable',
  'error': 'Could not fetch captions for this video'
};

function validId(id) { return /^[A-Za-z0-9_-]{11}$/.test(String(id || '')); }

exports.handler = async function(event, context) {
  const started = Date.now();
  const remainingMs = function() {
    if (context && typeof context.getRemainingTimeInMillis === 'function') return context.getRemainingTimeInMillis();
    return FALLBACK_BUDGET_MS - (Date.now() - started);
  };
  const headers = { 'Access-Control-Allow-Origin': '*', 'Content-Type': 'application/json' };
  const reply = function(code, obj) { return { statusCode: code, headers: headers, body: JSON.stringify(obj) }; };

  try {
    if (event.httpMethod === 'GET') {
      const videoId = String((event.queryStringParameters || {}).videoId || '');
      if (!validId(videoId)) return reply(400, { status: 'error', error: 'Invalid videoId' });
      const stored = await redisGet(TRANSCRIPT_PREFIX + videoId);
      if (!stored || typeof stored.text !== 'string') return reply(404, { status: 'not-found', error: 'No transcript stored for this video' });
      return reply(200, { status: 'done', videoId: videoId, title: stored.title || '', lang: stored.lang || '', kind: stored.kind || '', chars: stored.text.length, fetchedAt: stored.fetchedAt || null, text: stored.text });
    }

    if (event.httpMethod !== 'POST') return reply(405, { status: 'error', error: 'GET or POST only' });

    let videoId = '';
    try { videoId = String((JSON.parse(event.body || '{}') || {}).videoId || ''); } catch(e) {}
    if (!validId(videoId)) return reply(400, { status: 'error', error: 'Invalid videoId' });

    // Already transcribed: return the stored one, no refetch.
    const existing = await redisGet(TRANSCRIPT_PREFIX + videoId);
    if (existing && typeof existing.text === 'string' && existing.text) {
      return reply(200, { status: 'done', cached: true, videoId: videoId, chars: existing.text.length, title: existing.title || '' });
    }

    const t = await fetchTranscriptWithRetries(videoId, remainingMs);
    if (t.failure) {
      console.error('[transcribe-youtube] ' + videoId + ' ' + t.failure + ' after ' + t.attempts + ' attempt(s)' + (t.outOfTime ? ', out of time' : '') + ': ' + t.detail);
      return reply(t.failure === 'no-captions' || t.failure === 'unavailable' ? 404 : 502, { status: t.failure, error: FAILURE_MESSAGES[t.failure], detail: t.detail, attempts: t.attempts, outOfTime: !!t.outOfTime });
    }

    await redisSet(TRANSCRIPT_PREFIX + videoId, { videoId: videoId, title: t.title, author: t.author, lang: t.lang, kind: t.kind, fetchedAt: new Date().toISOString(), text: t.text });

    // A failed read rejects rather than resolving null, so a Redis blip can
    // never be mistaken for an empty list and wipe the transcribed ids.
    const list = await redisGet(TRANSCRIBED_KEY);
    const ids = Array.isArray(list) ? list : [];
    if (ids.indexOf(videoId) === -1) {
      ids.push(videoId);
      await redisSet(TRANSCRIBED_KEY, ids.slice(-TRANSCRIBED_CAP));
    }

    console.log('[transcribe-youtube] stored ' + videoId + ' — ' + t.text.length + ' chars, ' + t.lang + ' ' + t.kind + ', ' + t.attempts + ' attempt(s)');
    return reply(200, { status: 'done', cached: false, videoId: videoId, chars: t.text.length, title: t.title, attempts: t.attempts });
  } catch(e) {
    return reply(500, { status: 'error', error: e.message });
  }
};

module.exports._test = { pickTrack: pickTrack, flattenCaptions: flattenCaptions, fetchTranscript: fetchTranscript, fetchTranscriptWithRetries: fetchTranscriptWithRetries, RETRY_WAITS_MS: RETRY_WAITS_MS, validId: validId };
