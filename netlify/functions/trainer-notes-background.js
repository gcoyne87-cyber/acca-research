const https = require('https');

// Standalone one-off background function — trainer notes generation, scoped
// to a single hardcoded date (2026-09-13) only. Not part of the daily build
// pipeline; triggered manually via trainer-notes-trigger.js. No schedule
// here — same reason as form-summary-background.js: a schedule paired
// directly onto a -background function never actually fires.
module.exports.config = { timeout: 900 };

const UPSTASH_URL = process.env.UPSTASH_REDIS_REST_URL;
const UPSTASH_TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN;
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;

const TARGET_DATE = '2026-09-13';

function redisGet(key) {
  const url = new URL(UPSTASH_URL);
  return new Promise((resolve, reject) => {
    const req = https.request({
      hostname: url.hostname, path: '/get/' + encodeURIComponent(key), method: 'GET',
      headers: { 'Authorization': 'Bearer ' + UPSTASH_TOKEN }
    }, res => {
      let d = ''; res.on('data', c => d += c);
      res.on('end', () => {
        try { const r = JSON.parse(d); resolve(r.result ? JSON.parse(r.result) : null); }
        catch(e) { resolve(null); }
      });
    });
    req.on('error', () => resolve(null)); req.end();
  });
}

function redisSet(key, value) {
  const url = new URL(UPSTASH_URL);
  const body = JSON.stringify(value);
  return new Promise((resolve, reject) => {
    const req = https.request({
      hostname: url.hostname, path: '/set/' + encodeURIComponent(key), method: 'POST',
      headers: { 'Authorization': 'Bearer ' + UPSTASH_TOKEN, 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) }
    }, res => { let d = ''; res.on('data', c => d += c); res.on('end', () => { if(res.statusCode !== 200){ return reject(new Error('Redis write failed: HTTP '+res.statusCode+' '+d)); } try { const parsed=JSON.parse(d); if(parsed && parsed.error){ return reject(new Error('Redis write error: '+parsed.error)); } } catch(e){} resolve(d); }); });
    req.on('error', reject); req.write(body); req.end();
  });
}

// Same as redisSet but with an expiry — Upstash REST takes TTL as ?EX={seconds}
// on the /set/ path (same idiom as form-summary-background.js's redisSetEx).
function redisSetEx(key, value, ttlSeconds) {
  const url = new URL(UPSTASH_URL);
  const body = JSON.stringify(value);
  return new Promise((resolve, reject) => {
    const req = https.request({
      hostname: url.hostname, path: '/set/' + encodeURIComponent(key) + '?EX=' + ttlSeconds, method: 'POST',
      headers: { 'Authorization': 'Bearer ' + UPSTASH_TOKEN, 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) }
    }, res => { let d = ''; res.on('data', c => d += c); res.on('end', () => { if(res.statusCode !== 200){ return reject(new Error('Redis write failed: HTTP '+res.statusCode+' '+d)); } try { const parsed=JSON.parse(d); if(parsed && parsed.error){ return reject(new Error('Redis write error: '+parsed.error)); } } catch(e){} resolve(d); }); });
    req.on('error', reject); req.write(body); req.end();
  });
}

// SCAN for every form:history:{horse_id}:* key, any date — same idiom as
// horse-form.js's redisScanKeys. Caller sorts/reverses to try the most
// recent dated key first.
function redisScan(pattern) {
  if (!UPSTASH_URL || !UPSTASH_TOKEN) return Promise.resolve([]);
  const url = new URL(UPSTASH_URL);
  function scanPage(cursor) {
    return new Promise(resolve => {
      const req = https.request({
        hostname: url.hostname,
        path: '/scan/' + cursor + '?match=' + encodeURIComponent(pattern) + '&count=1000',
        method: 'GET',
        headers: { 'Authorization': 'Bearer ' + UPSTASH_TOKEN }
      }, res => {
        let d = '';
        res.on('data', c => d += c);
        res.on('end', () => {
          try { const r = JSON.parse(d); resolve(Array.isArray(r.result) ? r.result : ['0', []]); }
          catch(e) { resolve(['0', []]); }
        });
      });
      req.on('error', () => resolve(['0', []]));
      req.end();
    });
  }
  return (async () => {
    let cursor = '0';
    const keys = [];
    for (let i = 0; i < 60; i++) {
      const page = await scanPage(cursor);
      (page[1] || []).forEach(k => keys.push(k));
      cursor = String(page[0] || '0');
      if (cursor === '0') break;
    }
    return keys;
  })();
}

function apiPost(hostname, path, headers, body) {
  const b = JSON.stringify(body);
  return new Promise((resolve, reject) => {
    const req = https.request({
      hostname, path, method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(b), ...headers }
    }, res => {
      let d = ''; res.on('data', c => d += c);
      res.on('end', () => {
        if (res.statusCode === 429) {
          reject(new Error('429: rate limited by ' + hostname + path));
          return;
        }
        try { resolve(JSON.parse(d)); } catch(e) { reject(new Error('Parse')); }
      });
    });
    req.on('error', reject); req.setTimeout(290000); req.write(b); req.end();
  });
}

function sleep(ms) {
  return new Promise(function(resolve) { setTimeout(resolve, ms); });
}

// Strip dots, collapse whitespace, lowercase — grouping/comparison only.
// Display always uses the first-seen original-cased spelling for the group
// (same normalisation index.html's Trainer History IIFE uses client-side).
function normTrainer(t) {
  return (t || '').replace(/\./g, '').replace(/\s+/g, ' ').trim().toLowerCase();
}

// Fetch tomorrow's (2026-09-13) declared runners from racecards:{date} — same
// pattern as form-summary-background.js's readRacecards(), narrowed to this
// one hardcoded date since this is a standalone one-off run.
async function readRunners() {
  const runners = [];
  const cached = await redisGet('racecards:' + TARGET_DATE);
  if (cached && Array.isArray(cached.meetings)) {
    cached.meetings.forEach(function(meeting) {
      (meeting.races || []).forEach(function(race) {
        (race.runners || []).forEach(function(r) {
          if (!r.horse_id) return;
          runners.push({ horse_id: r.horse_id, horseName: r.name || r.horse || 'Unknown' });
        });
      });
    });
  }
  return runners;
}

// Most recent form:history:{horse_id}:* entry for this horse, any date —
// dated-key suffixes (YYYY-MM-DD) sort chronologically as strings, so a
// reverse sort tries the newest key first.
async function getMostRecentHistory(horse_id) {
  const keys = await redisScan('form:history:' + horse_id + ':*');
  if (!keys.length) return null;
  keys.sort().reverse();
  for (const key of keys) {
    const hist = await redisGet(key);
    if (Array.isArray(hist) && hist.length) return hist;
  }
  return null;
}

// Groups history entries by normalised trainer name, preserving first-seen
// original casing for display; each group's runs sorted oldest-to-newest.
function groupByTrainer(history) {
  const order = [];
  const groups = {};
  history.forEach(function(h) {
    const trainerRaw = (h.trainer || '').trim();
    if (!trainerRaw) return;
    const key = normTrainer(trainerRaw);
    if (!groups[key]) {
      groups[key] = { name: trainerRaw, runs: [] };
      order.push(key);
    }
    groups[key].runs.push(h);
  });
  order.forEach(function(key) {
    groups[key].runs.sort(function(a, b) {
      return String(a.date) < String(b.date) ? -1 : String(a.date) > String(b.date) ? 1 : 0;
    });
  });
  return order.map(function(key) { return groups[key]; });
}

function buildUserMessage(horseName, trainerGroups) {
  const blocks = trainerGroups.map(function(g) {
    const first = g.runs[0].date || '';
    const last = g.runs[g.runs.length - 1].date || '';
    const lines = g.runs.map(function(h) {
      return (h.date || '') + ' | ' + (h.course || '') + ' | ' + (h.dist || '') + ' | ' + (h.going || '') +
        ' | Pos: ' + (h.pos !== undefined && h.pos !== null && h.pos !== '' ? h.pos : '-') + '/' + (h.ran || 0) +
        ' | SP: ' + (h.sp || '');
    }).join('\n');
    return 'Trainer: ' + g.name + ', Runs: ' + g.runs.length + ', Spell: ' + first + ' to ' + last + '\n' + lines;
  }).join('\n\n');

  return 'Horse: ' + horseName + '\n\n' +
    'Trainer spells (oldest first within each spell):\n' + blocks + '\n\n' +
    'Rules:\n' +
    '- Write one paragraph per trainer with 3+ runs\n' +
    '- Trainers with fewer than 3 runs: return empty string for that trainer\n' +
    '- Sequence the paragraph chronologically through that trainer\'s spell\n' +
    '- Cover: trip used, going used, frequency of runs, whether form improved/declined/stayed flat, any turning point\n' +
    '- Be honest — poor form gets described plainly\n' +
    '- One paragraph only per trainer, 3-5 sentences, no bullet points\n\n' +
    'Respond with this exact JSON:\n' +
    '{"trainerNotes":{"Trainer Name":"paragraph or empty string","Trainer Name 2":"paragraph or empty string"}}';
}

const SYSTEM_PROMPT = 'You are an expert horse racing analyst writing for a premium racing intelligence platform. ' +
  'Write a short analytical paragraph for each trainer who has handled this horse. Base everything strictly on ' +
  'the form data provided — do not invent, pad or generalise. Be specific and honest. If form was poor say so. ' +
  'If nothing changed say so. The paragraph should read chronologically — what the trainer did from first run to ' +
  'last, what changed or did not change, and whether the form responded. Never use phrases like \'the data shows\' ' +
  'or \'the record indicates\' — write as a knowledgeable analyst who watched these races. Respond only with valid ' +
  'JSON, no markdown, no preamble.';

async function callClaudeForHorse(horseName, trainerGroups) {
  const userMessage = buildUserMessage(horseName, trainerGroups);
  const resp = await apiPost('api.anthropic.com', '/v1/messages', {
    'x-api-key': ANTHROPIC_API_KEY,
    'anthropic-version': '2023-06-01'
  }, {
    model: 'claude-sonnet-4-6',
    max_tokens: 800,
    system: SYSTEM_PROMPT,
    messages: [{ role: 'user', content: userMessage }]
  });

  const usage = resp.usage || {};
  const content = resp.content || [];
  const text = content.filter(function(b) { return b.type === 'text'; }).map(function(b) { return b.text; }).join('\n');

  let parsed = null;
  try {
    const jsonMatch = text.match(/\{[\s\S]*\}/);
    parsed = jsonMatch ? JSON.parse(jsonMatch[0]) : JSON.parse(text);
  } catch (e) {
    throw new Error('Claude response was not valid JSON: ' + e.message);
  }

  return {
    trainerNotes: (parsed && parsed.trainerNotes) || {},
    inputTokens: usage.input_tokens || 0,
    outputTokens: usage.output_tokens || 0
  };
}

// Combines Claude's paragraphs (for 3+-run trainers) with a locally-built
// "name and date range only" fallback for lighter trainers. Claude is
// instructed to return an empty string for those, but the stored value
// should still be useful on its own, so anything blank (or missing from
// Claude's response) is replaced with a plain spell summary computed
// directly from the grouped history rather than left empty.
function buildFinalNotes(trainerGroups, claudeNotes) {
  const final = {};
  trainerGroups.forEach(function(g) {
    const claudeText = (claudeNotes && claudeNotes[g.name]) || '';
    if (g.runs.length >= 3 && claudeText && claudeText.trim()) {
      final[g.name] = claudeText.trim();
    } else {
      const first = g.runs[0].date || '';
      const last = g.runs[g.runs.length - 1].date || '';
      final[g.name] = g.runs.length > 1 ? (first + ' to ' + last + ' (' + g.runs.length + ' runs)') : (first || 'no dated runs');
    }
  });
  return final;
}

exports.handler = async function(event) {
  const startTime = Date.now();
  console.log('[trainer-notes] START', new Date().toISOString(), 'target date:', TARGET_DATE);

  const headers = { 'Access-Control-Allow-Origin': '*', 'Content-Type': 'application/json' };

  const isScheduled = !event.httpMethod;
  if (!isScheduled) {
    const secret = (event.queryStringParameters && event.queryStringParameters.secret) || (event.headers && event.headers['x-build-secret']);
    if (secret !== process.env.BUILD_SECRET) {
      return { statusCode: 401, headers, body: JSON.stringify({ error: 'Unauthorised' }) };
    }
  }

  try {
    const runners = await readRunners();
    console.log('[trainer-notes] ' + runners.length + ' declared runner(s) with horse_id for ' + TARGET_DATE);

    let processed = 0;
    let generated = 0;
    let skipped = 0;
    let failed = 0;
    let totalInputTokens = 0;
    let totalOutputTokens = 0;
    const errors = [];

    const BATCH = 5;
    for (let i = 0; i < runners.length; i += BATCH) {
      const batch = runners.slice(i, i + BATCH);
      await Promise.all(batch.map(async function(runner) {
        processed++;
        try {
          const existing = await redisGet('trainer-notes:' + runner.horse_id + ':' + TARGET_DATE);
          if (existing) {
            skipped++;
            console.log('[trainer-notes] ' + runner.horseName + ' — already has notes, skipped');
            return;
          }

          const history = await getMostRecentHistory(runner.horse_id);
          if (!history) {
            skipped++;
            console.log('[trainer-notes] ' + runner.horseName + ' — no form history found, skipped');
            return;
          }

          const trainerGroups = groupByTrainer(history);
          if (!trainerGroups.length) {
            skipped++;
            console.log('[trainer-notes] ' + runner.horseName + ' — no trainer field on any run, skipped');
            return;
          }

          const hasQualifyingTrainer = trainerGroups.some(function(g) { return g.runs.length >= 3; });
          if (!hasQualifyingTrainer) {
            skipped++;
            console.log('[trainer-notes] ' + runner.horseName + ' — trainers: ' + trainerGroups.map(function(g){return g.name+' ('+g.runs.length+')';}).join(', ') + ' — none with 3+ runs, skipped');
            return;
          }

          console.log('[trainer-notes] ' + runner.horseName + ' — trainers: ' + trainerGroups.map(function(g){return g.name+' ('+g.runs.length+')';}).join(', ') + ' — generating');

          let claudeResult;
          try {
            claudeResult = await callClaudeForHorse(runner.horseName, trainerGroups);
          } catch (e) {
            if (e.message && e.message.indexOf('429') !== -1) {
              await sleep(5000);
              claudeResult = await callClaudeForHorse(runner.horseName, trainerGroups);
            } else {
              throw e;
            }
          }

          totalInputTokens += claudeResult.inputTokens || 0;
          totalOutputTokens += claudeResult.outputTokens || 0;

          const finalNotes = buildFinalNotes(trainerGroups, claudeResult.trainerNotes);

          await redisSetEx('trainer-notes:' + runner.horse_id + ':' + TARGET_DATE, finalNotes, 86400);
          generated++;
          console.log('[trainer-notes] ' + runner.horseName + ' — notes generated for ' + Object.keys(finalNotes).length + ' trainer(s)');
        } catch (e) {
          failed++;
          const msg = runner.horseName + ' (' + runner.horse_id + '): ' + e.message;
          errors.push(msg);
          console.log('[trainer-notes] FAILED — ' + msg);
        }
      }));

      if (i + BATCH < runners.length) await sleep(2000);
    }

    const summary = {
      totalProcessed: processed,
      totalGenerated: generated,
      totalSkipped: skipped,
      totalFailed: failed,
      inputTokens: totalInputTokens,
      outputTokens: totalOutputTokens,
      errors: errors,
      elapsedMs: Date.now() - startTime
    };
    console.log('[trainer-notes] DONE', new Date().toISOString(), JSON.stringify(summary));

    return { statusCode: 200, headers, body: JSON.stringify({ ok: true, summary: summary }) };
  } catch (e) {
    console.log('[trainer-notes] ERROR', e.message);
    return { statusCode: 500, headers, body: JSON.stringify({ error: e.message }) };
  }
};
