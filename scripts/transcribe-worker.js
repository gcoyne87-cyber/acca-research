// Racing Edge — local transcribe worker. RUNS ON THIS LAPTOP ONLY, never on
// Netlify: YouTube refuses caption requests from Netlify's servers but
// serves them to this machine. Raw captions only — no AI calls anywhere.
//
// The video feed page stars a video; netlify/functions/transcribe-youtube.js
// puts its id in the Redis list youtube:transcribe-queue. Each run of this
// script drains that queue:
//
//   for each queued id (oldest first, 3 seconds apart)
//     fetch the captions from YouTube (manual English, then auto-generated
//       English, then any other track) and flatten them to plain text
//     write   youtube:transcript:{id}   JSON { videoId, title, author, lang,
//                                              kind, fetchedAt, text }
//     append  the id to youtube:transcribed (JSON array — this is what turns
//             the card grey with a tick on the page)
//     LREM    the id from youtube:transcribe-queue
//
// So a star can never stick forever:
//   - a video that genuinely has no captions is removed from the queue at once
//   - a video that fails for any other reason is retried on later runs and
//     removed after 3 failed runs in a row
//   Both are recorded in youtube:transcribe-failed, a JSON map of
//   id -> { attempts, lastError, at, removed }. Starring the video again
//   gives it a fresh start.
//
// If YouTube refuses this machine ("sign in to confirm you're not a bot"),
// that is NOT counted against the video: the run stops at once, the video
// stays starred, and the worker makes no YouTube requests for 3 hours
// (youtube:transcribe-cooldown, which expires by itself).
//
// An empty queue exits silently. One line per video is appended to
// scripts/transcribe-worker.log (capped at 500 lines). A lock file stops two
// runs overlapping.
//
// Credentials: UPSTASH_REDIS_REST_URL and UPSTASH_REDIS_REST_TOKEN, read from
// the environment or from the repo's local .env (never committed).
//
// Run by hand:   node scripts/transcribe-worker.js
// Scheduled:     Windows Task Scheduler task "RacingEdge Transcribe Worker",
//                every 10 minutes.

const https = require('https');
const fs = require('fs');
const path = require('path');

try { require('dotenv').config({ path: path.join(__dirname, '..', '.env'), quiet: true }); } catch (e) {}

const UPSTASH_URL = process.env.UPSTASH_REDIS_REST_URL;
const UPSTASH_TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN;

const QUEUE_KEY = 'youtube:transcribe-queue';
const TRANSCRIPT_PREFIX = 'youtube:transcript:';
const TRANSCRIBED_KEY = 'youtube:transcribed';
const FAILED_KEY = 'youtube:transcribe-failed';
// Set (with an expiry) when YouTube refuses this machine with its bot check.
// While it exists the worker makes no YouTube requests at all.
const COOLDOWN_KEY = 'youtube:transcribe-cooldown';
const COOLDOWN_SECONDS = 3 * 60 * 60;
// A small index of every stored transcript (no text): JSON array of
// { videoId, title, author, lang, kind, chars, fetchedAt }, oldest first.
// The page's "Transcripts" view lists from this, so transcripts of pasted
// links and of videos that have left the 30-day feed can still be found.
const INDEX_KEY = 'youtube:transcript-index';
const INDEX_CAP = 2000;

const TRANSCRIBED_CAP = 2000;
const FAILED_CAP = 500;
const MAX_CHARS = 400000;
const MAX_FAILED_RUNS = 3;
const PAUSE_MS = 3000;

const LOG_FILE = path.join(__dirname, 'transcribe-worker.log');
const LOG_MAX_LINES = 500;
const LOCK_FILE = path.join(__dirname, 'transcribe-worker.lock');
const LOCK_STALE_MS = 30 * 60 * 1000;

const CLIENTS = [
  { clientName: 'ANDROID', clientVersion: '20.10.38', androidSdkVersion: 30, hl: 'en',
    userAgent: 'com.google.android.youtube/20.10.38 (Linux; U; Android 11) gzip' },
  { clientName: 'IOS', clientVersion: '20.10.4', deviceModel: 'iPhone16,2', hl: 'en',
    userAgent: 'com.google.ios.youtube/20.10.4 (iPhone16,2; U; CPU iOS 18_3_2 like Mac OS X)' }
];

function sleep(ms) { return new Promise(function(resolve) { setTimeout(resolve, ms); }); }
function validId(id) { return /^[A-Za-z0-9_-]{11}$/.test(String(id || '')); }

// ── Redis (Upstash REST) ──
// One command, sent as a JSON array. Rejects on any failure, so a network
// blip can never be mistaken for an empty queue or an empty list.
function redis(cmd) {
  const url = new URL(UPSTASH_URL);
  const data = JSON.stringify(cmd);
  return new Promise(function(resolve, reject) {
    const req = https.request({
      hostname: url.hostname, path: '/', method: 'POST', timeout: 15000,
      headers: { 'Authorization': 'Bearer ' + UPSTASH_TOKEN, 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) }
    }, function(res) {
      let d = '';
      res.on('data', function(c) { d += c; });
      res.on('end', function() {
        if (res.statusCode !== 200) return reject(new Error('Redis failed: HTTP ' + res.statusCode));
        let parsed;
        try { parsed = JSON.parse(d); } catch (e) { return reject(new Error('Redis parse error')); }
        if (parsed && parsed.error) return reject(new Error('Redis error: ' + parsed.error));
        resolve(parsed.result);
      });
    });
    req.on('error', reject);
    req.on('timeout', function() { req.destroy(new Error('Redis timed out')); });
    req.write(data); req.end();
  });
}

async function getJson(key) {
  const raw = await redis(['GET', key]);
  if (raw === null || raw === undefined || raw === '') return null;
  return JSON.parse(raw);   // a corrupt value throws rather than being overwritten
}
function setJson(key, value) { return redis(['SET', key, JSON.stringify(value)]); }

// ── YouTube captions ──
// One HTTPS request. Resolves { status, body }.
function ytRequest(method, urlString, headers, body) {
  return new Promise(function(resolve, reject) {
    const u = new URL(urlString);
    const h = Object.assign({}, headers || {});
    if (body) h['Content-Length'] = Buffer.byteLength(body);
    const req = https.request({ hostname: u.hostname, path: u.pathname + u.search, method: method, headers: h, timeout: 20000 }, function(res) {
      let d = '';
      res.on('data', function(c) { d += c; });
      res.on('end', function() { resolve({ status: res.statusCode, body: d }); });
    });
    req.on('error', reject);
    req.on('timeout', function() { req.destroy(new Error('request timed out')); });
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
  try { parsed = JSON.parse(body); } catch (e) {}
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

// The track list comes from YouTube's app player endpoint (ANDROID client,
// then IOS): the caption URLs in the ordinary watch page come back empty.
// Resolves { text, lang, kind, title, author } on success, or
// { failure: 'no-captions' | 'blocked' | 'unavailable' | 'error', detail }.
// 'no-captions' means the video played fine and simply has no caption track.
async function fetchTranscript(videoId) {
  let sawPlayable = false;
  let sawNoTracks = false;
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
    } catch (e) { lastDetail = client.clientName + ' player: ' + e.message; continue; }

    const ps = player.playabilityStatus || {};
    if (ps.status !== 'OK') {
      lastDetail = client.clientName + ' playability ' + ps.status + (ps.reason ? ' - ' + ps.reason : '');
      if (ps.status === 'LOGIN_REQUIRED' || /bot|sign in/i.test(String(ps.reason || ''))) blocked = lastDetail;
      else if (ps.status === 'ERROR' || ps.status === 'UNPLAYABLE') return { failure: 'unavailable', detail: lastDetail };
      continue;
    }
    sawPlayable = true;

    const tracks = ((player.captions || {}).playerCaptionsTracklistRenderer || {}).captionTracks || [];
    const track = pickTrack(tracks);
    if (!track) { sawNoTracks = true; lastDetail = 'video has no caption tracks'; continue; }

    try {
      const u = new URL(track.baseUrl);
      u.searchParams.set('fmt', 'json3');
      const c = await ytRequest('GET', u.toString(), { 'User-Agent': ua });
      if (c.status !== 200) { lastDetail = client.clientName + ' captions HTTP ' + c.status; if (c.status === 403 || c.status === 429) blocked = lastDetail; continue; }
      const text = flattenCaptions(c.body);
      if (!text) { lastDetail = client.clientName + ' captions came back empty'; blocked = blocked || lastDetail; continue; }
      const vd = player.videoDetails || {};
      return { text: text.slice(0, MAX_CHARS), lang: track.languageCode || '', kind: track.kind === 'asr' ? 'auto' : 'manual', title: vd.title || '', author: vd.author || '' };
    } catch (e) { lastDetail = client.clientName + ' captions: ' + e.message; continue; }
  }
  if (blocked) return { failure: 'blocked', detail: blocked };
  if (sawPlayable && sawNoTracks) return { failure: 'no-captions', detail: lastDetail };
  return { failure: 'error', detail: lastDetail || 'no answer from YouTube' };
}

// ── Log ──
// "2026-11-17 05:50:12 | <id> | <outcome> | <chars> chars | <note>"
function stamp() {
  const d = new Date();
  const p = function(n) { return String(n).padStart(2, '0'); };
  return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate()) + ' ' + p(d.getHours()) + ':' + p(d.getMinutes()) + ':' + p(d.getSeconds());
}

function log(id, outcome, chars, note) {
  const line = [stamp(), id, outcome, (chars || 0) + ' chars', String(note || '').replace(/\s+/g, ' ').slice(0, 160)].join(' | ').replace(/ \| $/, '');
  try {
    let lines = [];
    try { lines = fs.readFileSync(LOG_FILE, 'utf8').split(/\r?\n/).filter(Boolean); } catch (e) {}
    lines.push(line);
    fs.writeFileSync(LOG_FILE, lines.slice(-LOG_MAX_LINES).join('\n') + '\n');
  } catch (e) {}
  if (process.stdout.isTTY) console.log(line);
}

// ── Lock ──
// Created exclusively, so two runs can never both hold it. A lock older than
// 30 minutes is from a run that died and is taken over.
function acquireLock() {
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      fs.writeFileSync(LOCK_FILE, JSON.stringify({ pid: process.pid, at: new Date().toISOString() }), { flag: 'wx' });
      return true;
    } catch (e) {
      if (e.code !== 'EEXIST') throw e;
      let age = Infinity;
      try { age = Date.now() - fs.statSync(LOCK_FILE).mtimeMs; } catch (e2) { continue; }
      if (age < LOCK_STALE_MS) return false;
      try { fs.unlinkSync(LOCK_FILE); } catch (e2) {}
    }
  }
  return false;
}
function releaseLock() { try { fs.unlinkSync(LOCK_FILE); } catch (e) {} }

// ── One video ──
// Returns nothing; every outcome is logged. `failed` is the in-memory copy
// of youtube:transcribe-failed and is saved by the caller's helper.
async function processVideo(videoId, failed, saveFailed) {
  // Already transcribed (e.g. an earlier run stored it but could not finish):
  // just make sure it is listed and take it out of the queue.
  const existingRaw = await redis(['GET', TRANSCRIPT_PREFIX + videoId]);
  let t = null;
  if (existingRaw) { try { const ex = JSON.parse(existingRaw); if (ex && typeof ex.text === 'string' && ex.text) t = { text: ex.text, stored: true, title: ex.title || '', author: ex.author || '', lang: ex.lang || '', kind: ex.kind || '', fetchedAt: ex.fetchedAt }; } catch (e) {} }

  if (!t) {
    const r = await fetchTranscript(videoId);
    // A bot-check refusal is about this machine, not this video: it is not a
    // strike against the video. The caller stops the run and starts a pause.
    if (r.failure === 'blocked') {
      log(videoId, 'YOUTUBE REFUSED THIS MACHINE - run stopped, video stays starred', 0, r.detail);
      return 'blocked';
    }
    if (r.failure) {
      const prev = failed[videoId] && !failed[videoId].removed ? failed[videoId] : { attempts: 0 };
      const attempts = (Number(prev.attempts) || 0) + 1;
      const final = r.failure === 'no-captions' || attempts >= MAX_FAILED_RUNS;
      failed[videoId] = { attempts: attempts, lastError: r.failure + (r.detail ? ': ' + r.detail : ''), at: new Date().toISOString(), removed: final };
      await saveFailed();
      if (final) {
        await redis(['LREM', QUEUE_KEY, '0', videoId]);
        log(videoId, r.failure === 'no-captions' ? 'NO CAPTIONS - removed from queue' : 'FAILED ' + attempts + ' runs - removed from queue', 0, r.failure + (r.detail ? ': ' + r.detail : ''));
      } else {
        log(videoId, 'failed (run ' + attempts + ' of ' + MAX_FAILED_RUNS + ') - will retry', 0, r.failure + (r.detail ? ': ' + r.detail : ''));
      }
      return;
    }
    t = r;
    t.fetchedAt = new Date().toISOString();
    await setJson(TRANSCRIPT_PREFIX + videoId, { videoId: videoId, title: t.title, author: t.author, lang: t.lang, kind: t.kind, fetchedAt: t.fetchedAt, text: t.text });
  }

  // List it in the transcript index (replacing any older entry for this id).
  const indexRaw = await getJson(INDEX_KEY);
  const index = (Array.isArray(indexRaw) ? indexRaw : []).filter(function(e) { return e && e.videoId !== videoId; });
  index.push({ videoId: videoId, title: t.title || '', author: t.author || '', lang: t.lang || '', kind: t.kind || '', chars: t.text.length, fetchedAt: t.fetchedAt || new Date().toISOString() });
  await setJson(INDEX_KEY, index.slice(-INDEX_CAP));

  const list = await getJson(TRANSCRIBED_KEY);
  const ids = Array.isArray(list) ? list : [];
  if (ids.indexOf(videoId) === -1) {
    ids.push(videoId);
    await setJson(TRANSCRIBED_KEY, ids.slice(-TRANSCRIBED_CAP));
  }
  await redis(['LREM', QUEUE_KEY, '0', videoId]);
  if (failed[videoId]) { delete failed[videoId]; await saveFailed(); }
  log(videoId, t.stored ? 'already stored - marked done' : 'transcribed', t.text.length, t.stored ? '' : (t.lang + ' ' + t.kind + (t.title ? ' - ' + t.title : '')));
}

async function main() {
  if (!UPSTASH_URL || !UPSTASH_TOKEN) {
    console.error('transcribe-worker: UPSTASH_REDIS_REST_URL / UPSTASH_REDIS_REST_TOKEN not set (expected in the repo .env)');
    process.exitCode = 1;
    return;
  }
  if (!acquireLock()) return;   // another run is in progress: skip silently
  try {
    const raw = await redis(['LRANGE', QUEUE_KEY, '0', '-1']);
    const queue = (Array.isArray(raw) ? raw : []).filter(function(id, i, a) { return a.indexOf(id) === i; });
    if (!queue.length) return;  // nothing starred: exit silently

    // Paused after a refusal from YouTube: make no requests until it expires.
    if (await redis(['GET', COOLDOWN_KEY])) return;

    const failedRaw = await getJson(FAILED_KEY);
    const failed = failedRaw && typeof failedRaw === 'object' && !Array.isArray(failedRaw) ? failedRaw : {};
    const saveFailed = function() {
      // Keep the map bounded: drop the oldest entries beyond the cap.
      const keys = Object.keys(failed);
      if (keys.length > FAILED_CAP) {
        keys.sort(function(a, b) { return String(failed[a].at).localeCompare(String(failed[b].at)); })
          .slice(0, keys.length - FAILED_CAP).forEach(function(k) { delete failed[k]; });
      }
      return setJson(FAILED_KEY, failed);
    };

    for (let i = 0; i < queue.length; i++) {
      const id = queue[i];
      if (i > 0) await sleep(PAUSE_MS);
      if (!validId(id)) { await redis(['LREM', QUEUE_KEY, '0', id]); log(String(id).slice(0, 20), 'INVALID ID - removed from queue', 0, ''); continue; }
      // Starred again after being given up on: a fresh start.
      if (failed[id] && failed[id].removed) delete failed[id];
      let outcome;
      try { outcome = await processVideo(id, failed, saveFailed); }
      catch (e) { log(id, 'worker error - left in queue', 0, e.message); }
      if (outcome === 'blocked') {
        // Stop at the first refusal and stay quiet for a while; the key
        // expires by itself and the next run after that tries again.
        await redis(['SET', COOLDOWN_KEY, new Date().toISOString(), 'EX', String(COOLDOWN_SECONDS)]);
        break;
      }
    }
  } finally {
    releaseLock();
  }
}

if (require.main === module) {
  main().catch(function(e) {
    // Redis unreachable (laptop offline, etc.): nothing was changed. Not
    // logged, so an offline spell cannot push real entries out of the log.
    if (process.stdout.isTTY) console.error('transcribe-worker: ' + e.message);
    process.exitCode = 1;
  });
}

module.exports._test = { pickTrack: pickTrack, flattenCaptions: flattenCaptions, fetchTranscript: fetchTranscript, validId: validId };
