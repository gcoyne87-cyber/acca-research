const https = require('https');

// The transcribe QUEUE for the private feed page. This function fetches
// nothing from YouTube: YouTube refuses caption requests from Netlify's
// servers, so the fetching is done by a worker on the owner's own PC. The
// page stars a video, the id waits here, the worker drains the queue and
// stores the transcript. No AI calls anywhere.
//
//   POST { videoId }                star: add the id to the Redis LIST
//                                   youtube:transcribe-queue (never twice).
//                                   Returns { status: 'queued' }. If a
//                                   transcript is already stored the queue is
//                                   skipped: { status: 'done', chars, title }.
//                                   Either way, a video with no card in
//                                   youtube:feed (a pasted link) is looked up
//                                   and added to the feed as a permanent
//                                   manual entry; the reply carries
//                                   feed: 'present' | 'added' | 'failed'
//                                   (+ feedEntry / feedReason).
//   POST { videoId, remove: true }  un-star: take the id back out of the
//                                   queue. Returns { status: 'removed' }.
//   POST { videoId, used: bool }    mark (true) or un-mark (false) a transcript
//                                   as used: SADD / SREM on the Redis SET
//                                   youtube:used. Returns { status: 'used' |
//                                   'unused' }. GET ?list=1 returns the set
//                                   as usedIds.
//   GET ?videoId=...                { status: 'done', ..., text } when a
//                                   transcript is stored, { status: 'pending' }
//                                   when the id is queued, else
//                                   { status: 'none' }.
//   GET (no videoId)                { status: 'queue', queuedIds: [...] } —
//                                   how the page restores its stars on load.
//   GET ?list=1                     { status: 'list', transcripts: [...] } —
//                                   every stored transcript (id, title,
//                                   author, chars, fetchedAt; no text), from
//                                   youtube:transcript-index.
//
// What the worker reads and writes:
//   youtube:transcribe-queue        Redis list of video ids, oldest first
//                                   (LRANGE 0 -1; LREM an id when it is done)
//   youtube:transcript:{videoId}    JSON { videoId, title, author, lang, kind,
//                                   fetchedAt, text }
//   youtube:transcribed             JSON array of ids with a stored transcript
//                                   (get-youtube-feed.js returns it to the page
//                                   as transcribedIds)
//
// Deliberately NO secret, like hide-youtube-video.js: the caller is a static
// page. All this endpoint can do is add or remove a YouTube video id in the
// queue and read back stored transcripts.

// The collector's YouTube GET, entry builder and feed key (shared, not copied).
const collector = require('./youtube-feed-background.js').manual;

const UPSTASH_URL = process.env.UPSTASH_REDIS_REST_URL;
const UPSTASH_TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN;

const TRANSCRIPT_PREFIX = 'youtube:transcript:';
const QUEUE_KEY = 'youtube:transcribe-queue';
const QUEUE_CAP = 200;
const INDEX_KEY = 'youtube:transcript-index';
const USED_KEY = 'youtube:used';

// One call to the Upstash REST API. `path` is '' for a single command (body
// is the command as an array) or '/multi-exec' for an atomic transaction
// (body is an array of commands). Rejects on any failure, so a Redis blip is
// never mistaken for an empty answer.
function upstash(path, body) {
  const url = new URL(UPSTASH_URL);
  const data = JSON.stringify(body);
  return new Promise((resolve, reject) => {
    const req = https.request({
      hostname: url.hostname,
      path: path || '/',
      method: 'POST',
      headers: { 'Authorization': 'Bearer ' + UPSTASH_TOKEN, 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) }
    }, res => {
      let d = '';
      res.on('data', c => d += c);
      res.on('end', () => {
        if (res.statusCode !== 200) return reject(new Error('Redis failed: HTTP ' + res.statusCode));
        let parsed;
        try { parsed = JSON.parse(d); } catch(e) { return reject(new Error('Redis parse error')); }
        const bad = Array.isArray(parsed) ? parsed.filter(function(p) { return p && p.error; })[0] : (parsed && parsed.error ? parsed : null);
        if (bad) return reject(new Error('Redis error: ' + bad.error));
        resolve(parsed);
      });
    });
    req.on('error', reject);
    req.write(data); req.end();
  });
}

function redisCmd(cmd) { return upstash('', cmd).then(function(r) { return r.result; }); }

// The stored transcript object for an id, or null.
async function getTranscript(videoId) {
  const raw = await redisCmd(['GET', TRANSCRIPT_PREFIX + videoId]);
  if (!raw) return null;
  try {
    const t = JSON.parse(raw);
    return t && typeof t.text === 'string' && t.text ? t : null;
  } catch(e) { return null; }
}

async function queuedIds() {
  const list = await redisCmd(['LRANGE', QUEUE_KEY, '0', '-1']);
  return Array.isArray(list) ? list.filter(validId) : [];
}

// Remove-then-append in one transaction: the id can never be in the list
// twice, however many times it is starred.
function enqueue(videoId) {
  return upstash('/multi-exec', [['LREM', QUEUE_KEY, '0', videoId], ['RPUSH', QUEUE_KEY, videoId]])
    .then(function(r) { return Number(r[1].result) || 0; });
}

function dequeue(videoId) {
  return redisCmd(['LREM', QUEUE_KEY, '0', videoId]).then(function(n) { return Number(n) || 0; });
}

function validId(id) { return /^[A-Za-z0-9_-]{11}$/.test(String(id || '')); }

// A starred or pasted video that has no card in youtube:feed is looked up
// once (YouTube Data API videos.list, 1 quota unit) and added to the feed as
// a full entry with manual: true. Manual entries skip the collector's filter
// and never age out (see youtube-feed-background.js); they leave only via
// the Hide ✕. Never throws: a failure here must not stop the queueing.
// Returns { feed: 'present' | 'added' | 'failed', feedEntry?, feedReason? }.
async function addToFeedIfMissing(videoId) {
  try {
    const raw = await redisCmd(['GET', collector.FEED_KEY]);
    let feed = [];
    if (raw) { feed = JSON.parse(raw); if (!Array.isArray(feed)) throw new Error('stored feed is not a list'); }
    const present = feed.filter(function(v) { return v && v.videoId === videoId; })[0];
    if (present) return { feed: 'present' };

    if (!process.env.YOUTUBE_API_KEY) return { feed: 'failed', feedReason: 'YOUTUBE_API_KEY not set' };
    const r = await collector.youtubeGet('/youtube/v3/videos?part=snippet,statistics,contentDetails&id=' + encodeURIComponent(videoId));
    if (r.error) return { feed: 'failed', feedReason: 'YouTube lookup failed: ' + (r.error.reason || 'HTTP ' + r.error.status) };
    const item = r.items.filter(function(it) { return it && it.id === videoId; })[0];
    if (!item) return { feed: 'failed', feedReason: 'not found on YouTube' };

    const entry = collector.manualEntryFromItem(item);
    feed.push(entry);
    feed.sort(function(a, b) { return (Date.parse(b.publishedAt) || 0) - (Date.parse(a.publishedAt) || 0); });
    await redisCmd(['SET', collector.FEED_KEY, JSON.stringify(feed)]);
    return { feed: 'added', feedEntry: entry };
  } catch(e) {
    return { feed: 'failed', feedReason: e.message };
  }
}

exports.handler = async function(event) {
  const headers = { 'Access-Control-Allow-Origin': '*', 'Content-Type': 'application/json', 'Cache-Control': 'no-store' };
  const reply = function(code, obj) { return { statusCode: code, headers: headers, body: JSON.stringify(obj) }; };

  try {
    if (event.httpMethod === 'GET') {
      const raw = (event.queryStringParameters || {}).videoId;
      // ?list=1 — every stored transcript (no text), for the page's
      // "Transcripts" view. The index is maintained by the laptop worker.
      if ((event.queryStringParameters || {}).list) {
        let index = [];
        try { const rawIndex = await redisCmd(['GET', INDEX_KEY]); const parsed = rawIndex ? JSON.parse(rawIndex) : []; if (Array.isArray(parsed)) index = parsed; } catch(e) {}
        let usedIds = [];
        try { const members = await redisCmd(['SMEMBERS', USED_KEY]); if (Array.isArray(members)) usedIds = members.filter(validId); } catch(e) {}
        return reply(200, { status: 'list', transcripts: index.filter(function(e) { return e && validId(e.videoId); }), usedIds: usedIds });
      }
      if (raw === undefined || raw === null || raw === '') {
        return reply(200, { status: 'queue', queuedIds: await queuedIds() });
      }
      const videoId = String(raw);
      if (!validId(videoId)) return reply(400, { status: 'error', error: 'Invalid videoId' });
      const stored = await getTranscript(videoId);
      if (stored) {
        return reply(200, { status: 'done', videoId: videoId, title: stored.title || '', lang: stored.lang || '', kind: stored.kind || '', chars: stored.text.length, fetchedAt: stored.fetchedAt || null, text: stored.text });
      }
      const pos = await redisCmd(['LPOS', QUEUE_KEY, videoId]);
      return reply(200, { status: pos === null || pos === undefined ? 'none' : 'pending', videoId: videoId });
    }

    if (event.httpMethod !== 'POST') return reply(405, { status: 'error', error: 'GET or POST only' });

    let body = {};
    try { body = JSON.parse(event.body || '{}') || {}; } catch(e) {}
    const videoId = String(body.videoId || '');
    if (!validId(videoId)) return reply(400, { status: 'error', error: 'Invalid videoId' });

    // Mark / un-mark a transcript as used. Touches nothing but the used set.
    if (typeof body.used === 'boolean') {
      await redisCmd([body.used ? 'SADD' : 'SREM', USED_KEY, videoId]);
      return reply(200, { status: body.used ? 'used' : 'unused', videoId: videoId });
    }

    if (body.remove === true) {
      const removed = await dequeue(videoId);
      return reply(200, { status: 'removed', videoId: videoId, wasQueued: removed > 0 });
    }

    // No card in the feed yet (a pasted link): add one. Queueing below is
    // unchanged whatever happens here.
    const fed = await addToFeedIfMissing(videoId);

    // Already transcribed: return it and leave the queue alone.
    const existing = await getTranscript(videoId);
    if (existing) {
      return reply(200, Object.assign({ status: 'done', cached: true, videoId: videoId, chars: existing.text.length, title: existing.title || '' }, fed));
    }

    const length = await redisCmd(['LLEN', QUEUE_KEY]);
    if (Number(length) >= QUEUE_CAP) {
      const pos = await redisCmd(['LPOS', QUEUE_KEY, videoId]);
      if (pos === null || pos === undefined) return reply(429, { status: 'error', error: 'The queue is full (' + QUEUE_CAP + ') — let the laptop catch up first' });
    }
    const queueLength = await enqueue(videoId);
    return reply(200, Object.assign({ status: 'queued', videoId: videoId, queueLength: queueLength }, fed));
  } catch(e) {
    return reply(500, { status: 'error', error: e.message });
  }
};

module.exports._test = { validId: validId, queuedIds: queuedIds, enqueue: enqueue, dequeue: dequeue, getTranscript: getTranscript, QUEUE_KEY: QUEUE_KEY };
