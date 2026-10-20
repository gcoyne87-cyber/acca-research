const https = require('https');

// Tomorrow's Hot Yard preview — Part 1: generation and storage. Runs at
// 22:00 Irish time, fired by hotyard-nightly-trigger.js (which carries the
// cron and POSTs here with x-build-secret). No schedule on this file
// deliberately: a schedule paired directly onto a -background function never
// actually fires, and a function that IS scheduled rejects external HTTP
// triggers with a 403 at Netlify's edge (the form-summary incident — see
// form-summary-background.js).
//
// The job: read TODAY's trainer-form:table:{today} (written fresh by the
// 21:30 Irish refresh — trainer-form-refresh-background.js — minutes before
// this runs; if today's table is missing, log and stop: NEVER fall back to
// an older table or generate from stale data), compute tomorrow's Hot Yard
// qualifiers with the 10:30 build's exact rule (daily-build-background.js
// step 3.6: runners7d >= 5 AND winners7d >= 3 AND rounded strikeRate7d >= 30,
// sorted best 7-day rate first then winners then runners, max 2), drop any
// qualifier with no runner on tomorrow's card (racecards:{tomorrow}, matched
// by trainer_id), and store the preview onto daily:report:{tomorrow} as
// hotYardPreview { text, yards, generatedAt, lastRaceOffTime } — exactly the
// classDropPreview storage pattern (class-drop-nightly-background.js lines
// 166-168), creating the report if needed. No survivor means an empty
// preview is stored (text null, yards [], no Claude call — Class Drop's
// empty-shell pattern). Card text uses the build's own Hot Yard prompt,
// style, 46-50 word cap, no-tip/no-price rules and fixCardLength path,
// phrased in tomorrow framing. The build's internal helpers are not
// exported, so the prompt and the length-fix path are carried here verbatim
// (same rule as the elite list in trainer-form-refresh-background.js: if the
// build's Hot Yard prompt or fixCardLength changes, change it here too).
//
// Irish window: the trigger's cron is UTC and the Irish offset moves by an
// hour at the clock changes, so the cron fires at both 21:00 and 22:00 UTC
// and this job runs only when Irish time is 21:45-22:59 — exactly one of
// the two fires lands in the window on any night of the year. ?force=1
// (manual, with the secret) bypasses the window and the once-a-night mark
// (hotyard-nightly:ran:{date}).
module.exports.config = { timeout: 300 };

const UPSTASH_URL = process.env.UPSTASH_REDIS_REST_URL;
const UPSTASH_TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN;
const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY;

const { maxOffDt } = require('./daily-build-background.js');

function apiPost(hostname, path, headers, body) {
  const b = JSON.stringify(body);
  return new Promise((resolve, reject) => {
    const req = https.request({
      hostname, path, method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(b), ...headers }
    }, res => {
      let d = ''; res.on('data', c => d += c);
      res.on('end', () => { try { const parsed = JSON.parse(d); if (parsed && typeof parsed === 'object' && res.statusCode !== 200) parsed.__httpStatus = res.statusCode; resolve(parsed); } catch(e) { reject(new Error('Parse')); } });
    });
    req.on('error', reject); req.setTimeout(290000); req.write(b); req.end();
  });
}

// Same signature and return shape as daily-build-background.js's callClaude,
// minus web search — every Hot Yard call there passes noSearch=true, so the
// tool block and the debug:websearch logging can never be reached from this
// job and are left out.
async function callClaude(systemPrompt, userMessage, tokens, noSearch) {
  const body = {
    model: 'claude-sonnet-4-6',
    max_tokens: tokens || 6000,
    system: systemPrompt ? [{ type: 'text', text: systemPrompt, cache_control: { type: 'ephemeral' } }] : systemPrompt,
    messages: [{ role: 'user', content: userMessage }]
  };
  const resp = await apiPost('api.anthropic.com', '/v1/messages', {
    'x-api-key': ANTHROPIC_KEY,
    'anthropic-version': '2023-06-01'
  }, body);
  const usage = resp.usage || {};
  const content = resp.content || [];
  const text = content.filter(b => b.type === 'text').map(b => b.text).join('\n');
  return {
    text,
    inputTokens: usage.input_tokens || 0,
    outputTokens: usage.output_tokens || 0,
    cacheReadTokens: usage.cache_read_input_tokens || 0,
    cacheWriteTokens: usage.cache_creation_input_tokens || 0,
    apiError: resp && resp.type === 'error'
      ? 'API ' + (resp.__httpStatus || '?') + ': ' + ((resp.error && (resp.error.message || resp.error.type)) || 'unknown error')
      : null
  };
}

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

// Irish wall clock via Intl — calendar date plus hour/minute. Same
// Europe/Dublin convention as class-drop-nightly-background.js's irishNow.
function irishNow(d) {
  // year/month/day must be requested explicitly — once hour/minute options
  // are given, Intl drops the date parts from formatToParts entirely.
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Dublin', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false }).formatToParts(d || new Date());
  const get = function(type) { return (parts.find(function(p) { return p.type === type; }) || {}).value || ''; };
  let hour = parseInt(get('hour'), 10); if (hour === 24) hour = 0;
  return { date: get('year') + '-' + get('month') + '-' + get('day'), hour: hour, minute: parseInt(get('minute'), 10) };
}

// Calendar arithmetic on a YYYY-MM-DD string, anchored at noon UTC so a DST
// edge can never roll the date the wrong way.
function addDays(dateStr, n) {
  const d = new Date(dateStr + 'T12:00:00Z');
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

// ── CARD TEXT HELPERS — carried verbatim from daily-build-background.js ─────
// (NO_SITE_CTA, stripSiteCta, pullQuoteWordCount, trimPullQuoteToSentence,
// missingFactLabels, fixCardLength). The build does not export them and may
// not be touched by this job, so the copies live here; keep them in step
// with the originals.

const NO_SITE_CTA = ' The reader is already on Racing Edge: never mention Racing Edge, the site, the app, a racecard, a runner list, or where anything can be viewed, and never close with a pointer or call to action. Every sentence must be about the named horses, the trainer or the race itself.';
function stripSiteCta(text) {
  const t = String(text || '').trim();
  if (!t) return t;
  const sentences = t.match(/[^.!?]*[.!?]+(?:['")\]]*)?/g) || [t];
  const kept = sentences.filter(function(s) {
    return !/racing edge|view (?:the )?full|full (?:race ?card|runner list|list of)|head over|available (?:to view|on)|view (?:now|it|them)|check (?:the|out)/i.test(s);
  });
  const out = kept.join(' ').replace(/\s+/g, ' ').trim();
  return out || t;
}

function pullQuoteWordCount(s) { return String(s || '').trim().split(/\s+/).filter(Boolean).length; }

function trimPullQuoteToSentence(q, maxWords) {
  const cap = maxWords || 110;
  const sentences = String(q || '').trim().match(/[^.!?]*[.!?]+(?:['")\]]*)?/g) || [String(q || '').trim()];
  let out = '', words = 0;
  for (const s of sentences) {
    const w = pullQuoteWordCount(s);
    if (words + w > cap) break;
    out += (out ? ' ' : '') + s.trim();
    words += w;
  }
  return out || String(q || '').trim().split(/\s+/).slice(0, cap).join(' ');
}

function missingFactLabels(text, facts) {
  if (!facts || !facts.length) return [];
  const lower = text.toLowerCase();
  const seen = {}; const missing = [];
  facts.forEach(function(f) {
    const kws = f.keywords || [];
    if (!kws.length) return;
    const found = f.mode === 'all'
      ? kws.every(function(k) { return lower.indexOf(String(k).toLowerCase()) !== -1; })
      : kws.some(function(k) { return lower.indexOf(String(k).toLowerCase()) !== -1; });
    if (!found && !seen[f.label]) { seen[f.label] = true; missing.push(f.label); }
  });
  return missing;
}

async function fixCardLength(label, prompt, rawText, timeoutMs, splitOn, factsOpt, boundsOpt) {
  const MAX = (boundsOpt && boundsOpt.max) || 50;
  const FLOOR_TRIGGER = (boundsOpt && boundsOpt.floorTrigger) || 44;
  const FLOOR_MIN = (boundsOpt && boundsOpt.floorMin) || 46;
  const FLOOR_MAX = (boundsOpt && boundsOpt.floorMax) || MAX;
  const text = stripSiteCta(rawText);
  const wc = pullQuoteWordCount(text);
  const usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
  if (wc <= MAX && wc >= 40) return { text: text, usage: usage, warning: null };

  const wasUnder40 = wc < 40;
  const factsList = (factsOpt && factsOpt.list) || [];
  const noHorseLine = factsOpt && factsOpt.omitNoHorseLine ? '' : ' Do not name any horse.';
  const attempts = [{ text: text, wc: wc }];

  function pickBest() {
    const inRange = attempts.filter(function(a) { return a.wc >= 40 && a.wc <= MAX; });
    if (inRange.length) {
      inRange.sort(function(a, b) { return Math.abs(a.wc - 47) - Math.abs(b.wc - 47); });
      return inRange[0];
    }
    function distToRange(w) { return w < 40 ? (40 - w) : (w - MAX); }
    return attempts.slice().sort(function(a, b) { return distToRange(a.wc) - distToRange(b.wc); })[0];
  }

  function buildInstruction(currentText, currentWc) {
    if (currentWc > MAX) return ' Your text was ' + currentWc + ' words. Rewrite it in 45 to ' + MAX + ' words, in complete sentences, keeping the same facts.';
    const missing = missingFactLabels(currentText, factsList);
    const useFacts = missing.length ? ' Use these facts as well: ' + missing.join(', ') + '.' : '';
    return ' Your text was ' + currentWc + ' words, which is too short. Write 45 to ' + MAX + ' words in complete sentences.' + useFacts + noHorseLine;
  }

  async function oneRewriteWithInstruction(instruction) {
    let rewriteTimer = null;
    const resp = await Promise.race([
      callClaude('', prompt + instruction, 400, true),
      new Promise(function(_, reject) {
        rewriteTimer = setTimeout(function() { reject(new Error('timed out after ' + ((timeoutMs || 25000) / 1000) + 's')); }, timeoutMs || 25000);
      })
    ]).finally(function() { if (rewriteTimer) clearTimeout(rewriteTimer); });
    usage.input += resp.inputTokens || 0; usage.output += resp.outputTokens || 0;
    usage.cacheRead += resp.cacheReadTokens || 0; usage.cacheWrite += resp.cacheWriteTokens || 0;
    if (!resp.text || !resp.text.trim()) return null;
    let rewriteRaw = resp.text;
    if (splitOn) {
      const parts = rewriteRaw.split(/^\s*={3,}\s*$/m).map(function(p) { return p.trim(); }).filter(Boolean);
      rewriteRaw = parts.length === splitOn.count ? parts[splitOn.index] : rewriteRaw;
    }
    return stripSiteCta(rewriteRaw);
  }
  async function oneRewrite(currentText, currentWc) {
    return oneRewriteWithInstruction(buildInstruction(currentText, currentWc));
  }

  try {
    let rewritten = await oneRewrite(text, wc);
    if (rewritten === null) return { text: pickBest().text, usage: usage, warning: label + ': rewrite call returned nothing — kept original (' + wc + ' words)' };
    let rewrittenWc = pullQuoteWordCount(rewritten);
    attempts.push({ text: rewritten, wc: rewrittenWc });

    if (wasUnder40 && rewrittenWc < 40) {
      const second = await oneRewrite(rewritten, rewrittenWc);
      if (second !== null) {
        const secondWc = pullQuoteWordCount(second);
        attempts.push({ text: second, wc: secondWc });
        rewritten = second; rewrittenWc = secondWc;
      }
    }

    if (rewrittenWc > MAX) {
      const trimmed = trimPullQuoteToSentence(rewritten, MAX);
      const trimmedWc = pullQuoteWordCount(trimmed);
      if (trimmedWc < FLOOR_TRIGGER) {
        const floorFix = await oneRewriteWithInstruction(' Your previous answer was ' + rewrittenWc + ' words and the limit is ' + MAX + '. Rewrite to between ' + FLOOR_MIN + ' and ' + FLOOR_MAX + ' words exactly — do not go under ' + FLOOR_MIN + ' or over ' + FLOOR_MAX + '.');
        const floorFixWc = floorFix === null ? null : pullQuoteWordCount(floorFix);
        if (floorFixWc !== null && floorFixWc >= FLOOR_MIN && floorFixWc <= FLOOR_MAX) {
          return { text: floorFix, usage: usage, warning: label + ': rewrite still over ' + MAX + ' words (' + rewrittenWc + '), trimmed to ' + trimmedWc + ' words — a floor rewrite recovered it to ' + floorFixWc + ' words' };
        }
        return { text: trimmed, usage: usage, warning: label + ': rewrite still over ' + MAX + ' words (' + rewrittenWc + '), trimmed to ' + trimmedWc + ' words — floor rewrite also failed, kept the trimmed sentence boundary as a last resort' };
      }
      return { text: trimmed, usage: usage, warning: label + ': rewrite still over ' + MAX + ' words (' + rewrittenWc + ') — trimmed to a sentence boundary as a last resort' };
    }

    const best = pickBest();
    if (best.wc < 40 || best.wc > MAX) {
      const attemptCount = attempts.length - 1;
      return { text: best.text, usage: usage, warning: label + ': still outside 40-' + MAX + ' words after ' + attemptCount + ' rewrite attempt' + (attemptCount === 1 ? '' : 's') + ' (best: ' + best.wc + ' words) — kept the closest available text' };
    }
    return { text: best.text, usage: usage, warning: null };
  } catch (e) {
    const best = pickBest();
    return { text: best.text, usage: usage, warning: label + ': rewrite call failed (' + e.message + ') — kept ' + (best === attempts[0] ? 'original' : 'best attempt') + ' (' + best.wc + ' words)' };
  }
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
  const inWindow = (now.hour === 21 && now.minute >= 45) || now.hour === 22;
  if (!force && !inWindow) {
    console.log('[hotyard-nightly] skipped — ' + now.date + ' ' + now.hour + ':' + String(now.minute).padStart(2, '0') + ' Irish is outside the 21:45-22:59 window');
    return { statusCode: 200, headers, body: JSON.stringify({ skipped: true, reason: 'outside Irish 21:45-22:59 window', irishNow: now }) };
  }

  const today = now.date;
  const tomorrow = addDays(today, 1);
  const ranKey = 'hotyard-nightly:ran:' + today;
  if (!force) {
    const already = await redisGet(ranKey);
    if (already && already.completedAt) {
      console.log('[hotyard-nightly] skipped — already ran for ' + today + ' at ' + already.completedAt);
      return { statusCode: 200, headers, body: JSON.stringify({ skipped: true, reason: 'already ran tonight', completedAt: already.completedAt }) };
    }
  }
  console.log('[hotyard-nightly] START ' + new Date().toISOString() + ' today=' + today + ' tomorrow=' + tomorrow + (force ? ' (forced)' : ''));

  const result = { date: today, tomorrow: tomorrow, qualifiers: 0, survivors: 0, stored: false, hasText: false };
  const finish = async function(statusCode) {
    if (!force) { try { await redisSet(ranKey, { completedAt: new Date().toISOString(), result: result }); } catch (e) {} }
    console.log('[hotyard-nightly] DONE ' + new Date().toISOString());
    return { statusCode: statusCode, headers, body: JSON.stringify(result) };
  };

  try {
    // 1. Today's trainer-form table — the 21:30 refresh's rows. Missing
    // means tonight's figures don't exist; an older table is yesterday's
    // form wearing today's date, so there is deliberately no fallback.
    const table = await redisGet('trainer-form:table:' + today);
    if (!Array.isArray(table) || !table.length) {
      console.log('[hotyard-nightly] trainer-form:table:' + today + ' is missing — stopping, no fallback to older tables');
      result.skipped = 'trainer-form:table:' + today + ' missing';
      return await finish(200);
    }

    // 2. Tomorrow's qualifiers — the build's exact Hot Yard rule
    // (daily-build-background.js step 3.6): rates rounded exactly as the
    // table rounds them, best 7-day rate first, up to two, never a fallback
    // below the bar.
    const hyRound = function(v) { return Math.round(Number(v) || 0); };
    const qualifiers = table.filter(function(t) {
      return Number(t.runners7d) >= 5 && Number(t.winners7d) >= 3 && hyRound(t.strikeRate7d) >= 30;
    }).sort(function(a, b) {
      return (hyRound(b.strikeRate7d) - hyRound(a.strikeRate7d))
        || (Number(b.winners7d) - Number(a.winners7d))
        || (Number(b.runners7d) - Number(a.runners7d));
    }).slice(0, 2);
    result.qualifiers = qualifiers.length;

    // 3. Tomorrow's card — a qualifier with nothing declared tomorrow is
    // dropped. No racecard in Redis yet means the filter cannot be applied,
    // so nothing is stored (class-drop-nightly's no-racecard exit).
    const tmRaw = await redisGet('racecards:' + tomorrow);
    const tmMeetings = (tmRaw && Array.isArray(tmRaw.meetings)) ? tmRaw.meetings : [];
    if (!tmMeetings.length) {
      console.log('[hotyard-nightly] tomorrow ' + tomorrow + ': racecard not in Redis yet — nothing to preview');
      result.skipped = 'racecards:' + tomorrow + ' not fetched yet';
      return await finish(200);
    }
    const tomorrowByTrainer = {};
    tmMeetings.forEach(function(m) {
      (m.races || []).forEach(function(race) {
        (race.runners || []).forEach(function(r) {
          if (r.is_non_runner || r.nonRunner === true || r.price === 'NR') return;
          const tid = r.trainer_id || '';
          if (!tid) return;
          const entry = tomorrowByTrainer[tid] = tomorrowByTrainer[tid] || { count: 0, offDts: [] };
          entry.count++;
          if (race._offDt) entry.offDts.push(race._offDt);
        });
      });
    });
    const survivors = qualifiers.filter(function(t) {
      return (tomorrowByTrainer[t.trainerId] || { count: 0 }).count > 0;
    });
    result.survivors = survivors.length;

    // 4. The preview object — classDropPreview's shape and storage pattern.
    // lastRaceOffTime is the latest off time among the surviving yards'
    // runners tomorrow (the expiry handle for Part 2's display), via the
    // build's own maxOffDt.
    const offDtList = [];
    survivors.forEach(function(t) {
      (tomorrowByTrainer[t.trainerId].offDts || []).forEach(function(o) { offDtList.push({ offDt: o }); });
    });
    const preview = {
      text: null,
      yards: survivors.map(function(t) {
        return {
          trainerId: t.trainerId,
          name: t.trainerName,
          winners7d: Number(t.winners7d) || 0,
          runners7d: Number(t.runners7d) || 0,
          strikeRate7d: hyRound(t.strikeRate7d),
          runnersTomorrow: tomorrowByTrainer[t.trainerId].count
        };
      }),
      generatedAt: new Date().toISOString(),
      lastRaceOffTime: maxOffDt(offDtList)
    };

    // 5. Card text — only when a yard survived (the empty shell stores with
    // text null and no Claude call). Same prompt, style, word cap, no-tip
    // and no-price rules as the build's Hot Yard card, phrased in tomorrow
    // framing; the stored table carries no winning-venue data, so the
    // venue clause is replaced by tomorrow's declared runner count.
    let usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
    const warnings = [];
    if (survivors.length) {
      const yardBlocks = survivors.map(function(t, i) {
        return 'Yard ' + (i + 1) + (i === 0 ? ' (best)' : '') + ': ' + t.trainerName + '.'
          + ' Last 7 days: ' + t.runners7d + ' runners, ' + t.winners7d + ' winners, ' + hyRound(t.strikeRate7d) + '% strike rate'
          + ' (14-day rate ' + hyRound(t.strikeRate14d) + '%).'
          + ' Declared runners tomorrow: ' + tomorrowByTrainer[t.trainerId].count + '.';
      });
      const hotYardPrompt = 'You are an expert horse racing analyst writing a Hot Yard' +
        ' preview card for Racing Edge, previewing tomorrow\'s racing. Plain text only — no asterisks, no' +
        ' markdown, no bold, no headers. Do not begin with a' +
        ' trainer name, a label, or any heading — start directly' +
        ' with the first sentence of the card.' +
        ' Write 46 to 50 words. Never fewer than 46 and never more than 50 — count your words before answering. Do not name, rank or recommend any individual horse.' +
        ' No opinions, no predictions. No prices or odds.' +
        (survivors.length === 2
          ? ' Two yards qualify for tomorrow: write a separate card text for each yard, the best yard first, each text covering only its own yard and following the length rule on its own. Put a line containing only === between the two texts and write nothing else.'
          : ' One yard qualifies for tomorrow.') +
        ' For each yard cover its recent form stats.' +
        ' Cover the yard\'s 7-day strike rate against its 14-day rate and how many runners it has declared tomorrow, without naming any horse. Frame everything as tomorrow: the yard runs tomorrow, not today.' +
        NO_SITE_CTA +
        ' The data: ' + yardBlocks.join(' ');

      // Hard 25s ceiling per call, exactly as the build runs this prompt:
      // apiPost's socket timeout only emits an event, so a hung Anthropic
      // call would otherwise stall the job. On timeout the preview stores
      // with text null and the yards intact.
      const HOT_YARD_CALL_TIMEOUT_MS = 25000;
      let hyTimer = null;
      try {
        const hyResp = await Promise.race([
          callClaude('', hotYardPrompt, 400, true),
          new Promise(function(_, reject) {
            hyTimer = setTimeout(function() { reject(new Error('timed out after ' + (HOT_YARD_CALL_TIMEOUT_MS / 1000) + 's — skipped')); }, HOT_YARD_CALL_TIMEOUT_MS);
          })
        ]);
        usage.input += hyResp.inputTokens || 0; usage.output += hyResp.outputTokens || 0;
        usage.cacheRead += hyResp.cacheReadTokens || 0; usage.cacheWrite += hyResp.cacheWriteTokens || 0;
        if (hyResp.apiError) throw new Error(hyResp.apiError);
        if (hyResp.text && hyResp.text.trim()) {
          // Same facts list the build checks a too-short rewrite against,
          // minus the winning venues the stored table doesn't carry.
          const hotYardFacts = function(y) {
            return { list: [
              { label: 'the 7-day strike rate', keywords: [hyRound(y.strikeRate7d) + '%', hyRound(y.strikeRate7d) + ' percent'] },
              { label: 'the 14-day rate', keywords: [hyRound(y.strikeRate14d) + '%', hyRound(y.strikeRate14d) + ' percent'] }
            ] };
          };
          const hyCap = function(t, splitOn, yardIndex) { return fixCardLength('Hot Yard preview card', hotYardPrompt, t, HOT_YARD_CALL_TIMEOUT_MS, splitOn, hotYardFacts(survivors[yardIndex])); };
          if (survivors.length === 2) {
            // Two yards: the response holds both texts split by a lone "==="
            // line. Each part is length-fixed on its own (the rewrite resends
            // the full two-yard prompt and pulls its own part back out — the
            // build's splitOn mechanism) and the preview stores them rejoined
            // with the same separator for Part 2 to split. A missing
            // separator means the texts cannot be told apart, so no text is
            // stored rather than a merged one — the yards list still is.
            const hyParts = hyResp.text.split(/^\s*={3,}\s*$/m).map(function(p) { return p.trim(); }).filter(Boolean);
            if (hyParts.length === 2) {
              const hy0 = await hyCap(hyParts[0], { index: 0, count: 2 }, 0);
              const hy1 = await hyCap(hyParts[1], { index: 1, count: 2 }, 1);
              preview.text = hy0.text + '\n===\n' + hy1.text;
              [hy0, hy1].forEach(function(r) {
                usage.input += r.usage.input; usage.output += r.usage.output;
                usage.cacheRead += r.usage.cacheRead; usage.cacheWrite += r.usage.cacheWrite;
                if (r.warning) warnings.push(r.warning);
              });
            } else {
              warnings.push('hotYardPreview: expected 2 yard texts, got ' + hyParts.length + ' — preview stored without text');
            }
          } else {
            const hy0 = await hyCap(hyResp.text, null, 0);
            preview.text = hy0.text;
            usage.input += hy0.usage.input; usage.output += hy0.usage.output;
            usage.cacheRead += hy0.usage.cacheRead; usage.cacheWrite += hy0.usage.cacheWrite;
            if (hy0.warning) warnings.push(hy0.warning);
          }
        }
      } catch (eHYC) {
        warnings.push('hotYardPreview text call failed: ' + eHYC.message + ' — preview stored without text');
      } finally {
        if (hyTimer) clearTimeout(hyTimer);
      }
      warnings.forEach(function(w) { console.log('[hotyard-nightly] ' + w); });
    }

    // 6. Store — exactly the classDropPreview pattern: read-modify-write of
    // daily:report:{tomorrow}, creating it when it does not exist yet.
    const existing = (await redisGet('daily:report:' + tomorrow)) || {};
    existing.hotYardPreview = preview;
    await redisSet('daily:report:' + tomorrow, existing);
    result.stored = true;
    result.hasText = !!preview.text;
    result.yards = preview.yards.map(function(y) { return y.name; });
    result.lastRaceOffTime = preview.lastRaceOffTime;
    result.usage = usage;
    if (warnings.length) result.warnings = warnings;
    console.log('[hotyard-nightly] tomorrow ' + tomorrow + ': preview stored — ' + result.qualifiers + ' qualifier(s), ' + result.survivors + ' with runners tomorrow' + (preview.text ? '' : ', no card text'));
  } catch (e) {
    console.log('[hotyard-nightly] failed: ' + e.message);
    result.error = e.message;
  }

  return await finish(200);
};
