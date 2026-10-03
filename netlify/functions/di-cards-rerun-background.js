const https = require('https');

// Secret-gated, unscheduled — no netlify.toml entry, no trigger shim, never
// called by anything else. Manual-only, via POST with x-build-secret.
//
// Rebuilds ONLY the Daily Intelligence card fields of today's already-stored
// daily:report:{date} — Hot Yard, Big Race (today/tomorrow), C&D+G, Ground
// Lover and Class Drop — using the exact same shared implementation the
// 10:30 build itself uses (runDailyIntelligenceCards, exported from
// daily-build-background.js). Everything else on the report (picks, NAP,
// NB, Intel picks, analyses, cost totals, callLog, errors/warnings from the
// original run) is left exactly as it was. Sends no email. Never touches
// trainer-form:table:{date} (the site's own Trainer Form table) — that is
// main-build-only, gated off here via updateTrainerFormTable:false.
//
// `today` uses the same plain UTC-date convention daily-build-background.js
// itself uses for its own `today` (new Date().toISOString().slice(0,10)) —
// not a separate Europe/Dublin computation — so this always reads/writes
// the exact same daily:report:{date} key the morning build wrote.
module.exports.config = { timeout: 300 };

const UPSTASH_URL = process.env.UPSTASH_REDIS_REST_URL;
const UPSTASH_TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN;

const { runDailyIntelligenceCards } = require('./daily-build-background.js');

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

// The only fields this job is allowed to touch on daily:report:{date}.
const CARD_FIELDS = [
  'hotYard', 'hotYardCard', 'hotYards',
  'bigRace', 'bigRaceTomorrow',
  'candgHorses', 'candgCard',
  'groundLoverHorses', 'groundLoverCard',
  'classDropHorses', 'classDropCard'
];

exports.handler = async function(event) {
  const headers = { 'Content-Type': 'application/json' };
  const secret = event.headers && event.headers['x-build-secret'];
  if (!secret || secret !== process.env.BUILD_SECRET) {
    return { statusCode: 401, headers, body: JSON.stringify({ error: 'Unauthorised' }) };
  }

  const today = new Date().toISOString().slice(0, 10);

  try {
    const existingReport = await redisGet('daily:report:' + today);
    if (!existingReport) {
      return { statusCode: 404, headers, body: JSON.stringify({ error: 'no daily:report:' + today + ' to rebuild cards for' }) };
    }

    // Backup first, before anything is touched.
    await redisSet('daily:report:backup-cards:' + today, existingReport);

    const raw = await redisGet('daily-build:raw-racecards:' + today);
    const racecards = (raw && Array.isArray(raw.racecards)) ? raw.racecards : [];

    // Work on a deep copy so runDailyIntelligenceCards (which reads
    // report.analyses for Big Race Today and writes several report.* fields
    // directly) can never mutate the real, already-stored report in place —
    // only the explicit CARD_FIELDS copy-back below does that.
    const working = JSON.parse(JSON.stringify(existingReport));
    working.warnings = working.warnings || [];
    working.errors = working.errors || [];

    await runDailyIntelligenceCards(today, racecards, working, { updateTrainerFormTable: false });

    const updated = JSON.parse(JSON.stringify(existingReport));
    CARD_FIELDS.forEach(function(f) { updated[f] = working[f]; });

    await redisSet('daily:report:' + today, updated);

    // Confirm the diff: every top-level key that actually changed, and
    // whether that set is a subset of CARD_FIELDS.
    const allKeys = Array.from(new Set(Object.keys(existingReport).concat(Object.keys(updated))));
    const changedFields = allKeys.filter(function(k) { return JSON.stringify(existingReport[k]) !== JSON.stringify(updated[k]); });
    const onlyCardFieldsChanged = changedFields.every(function(k) { return CARD_FIELDS.indexOf(k) !== -1; });

    return {
      statusCode: 200,
      headers,
      body: JSON.stringify({
        ok: true,
        date: today,
        changedFields: changedFields,
        onlyCardFieldsChanged: onlyCardFieldsChanged,
        cardRewriteWarnings: working.warnings.filter(function(w) { return existingReport.warnings ? existingReport.warnings.indexOf(w) === -1 : true; }),
        cards: {
          hotYardCard: updated.hotYardCard,
          bigRace: updated.bigRace && updated.bigRace.raceIntelligence,
          bigRaceTomorrow: updated.bigRaceTomorrow && updated.bigRaceTomorrow.raceIntelligence,
          candgCard: updated.candgCard,
          groundLoverCard: updated.groundLoverCard,
          classDropCard: updated.classDropCard
        }
      })
    };
  } catch (e) {
    return { statusCode: 500, headers, body: JSON.stringify({ error: e.message }) };
  }
};
