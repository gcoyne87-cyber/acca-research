const https = require('https');

// TEMPORARY read-only probe. Exists so a one-off field-discovery test can be
// run with the site's credentials (masked outside the deploy): which fields
// the Racing API sends for race class, grade/pattern and rating band, on
// racecards and on past results. Calls the Racing API only — no Claude
// calls, nothing written to Redis, no site behaviour changes. To be deleted
// once the test is reported (same lifecycle as the earlier sire/dam/damsire
// probe: create, deploy, call, report, delete).
//
//   GET /.netlify/functions/racing-api-probe?ids=hrs_a,hrs_b,hrs_c,hrs_d&date=2026-10-01&parts=a,b,c
//   header: x-build-secret
//
// Calls up to three things, each the same endpoint the live writers use:
//   a. /v1/racecards/pro?date={date}              (fetch-future-cards-background.js's own call; date defaults to 2026-10-01)
//   b. /v1/horses/{id}/results?limit=50           (fetch-horse-history-1/2-background.js's own call), for each of up to 4 ids in ?ids=
//   c. /v1/results?start_date=2026-09-27&end_date=2026-09-27&limit=50   (not currently called anywhere in this codebase — being probed for the first time)
// ?parts= (default a,b,c) selects which of the three to run, so a follow-up
// call for a second date's racecards doesn't re-pay the horse-results/past-
// results calls. Paced at one request per 220ms (≈4.5/sec, under the
// documented 5/sec ceiling).

const AUTH = Buffer.from((process.env.RACING_API_USERNAME || '') + ':' + (process.env.RACING_API_KEY || '')).toString('base64');
const PACE_MS = 220;

function sleep(ms) { return new Promise(function(r) { setTimeout(r, ms); }); }

function apiGet(path) {
  return new Promise(function(resolve, reject) {
    const req = https.request({
      hostname: 'api.theracingapi.com', path: path, method: 'GET',
      headers: { 'Authorization': 'Basic ' + AUTH, 'Accept': 'application/json' },
      timeout: 25000
    }, function(res) {
      let d = ''; res.on('data', function(c) { d += c; });
      res.on('end', function() {
        let parsed; try { parsed = JSON.parse(d); } catch (e) { parsed = { _raw: d.substring(0, 2000) }; }
        resolve({ status: res.statusCode, data: parsed });
      });
    });
    req.on('error', function(e) { resolve({ status: 0, error: e.message }); });
    req.on('timeout', function() { req.destroy(); resolve({ status: 0, error: 'upstream timeout' }); });
    req.end();
  });
}

exports.handler = async function(event) {
  const headers = { 'Content-Type': 'application/json' };
  if (event.httpMethod !== 'GET') return { statusCode: 405, headers, body: JSON.stringify({ error: 'GET only' }) };
  const secret = event.headers && event.headers['x-build-secret'];
  if (!secret || secret !== process.env.BUILD_SECRET) return { statusCode: 401, headers, body: JSON.stringify({ error: 'Unauthorised' }) };

  const qs = event.queryStringParameters || {};
  const ids = (qs.ids || '').split(',').map(function(s) { return s.trim(); }).filter(Boolean).slice(0, 4);
  const date = /^\d{4}-\d{2}-\d{2}$/.test(qs.date || '') ? qs.date : '2026-10-01';
  const parts = (qs.parts || 'a,b,c').split(',').map(function(s) { return s.trim(); });
  const t0 = Date.now();
  const out = { racecards: null, horseResults: {}, pastResults: null, errors: [] };

  if (parts.indexOf('a') !== -1) {
    try {
      const rc = await apiGet('/v1/racecards/pro?date=' + date);
      out.racecards = { date: date, upstreamStatus: rc.status, data: rc.data };
    } catch (e) { out.errors.push('racecards: ' + e.message); }
  }

  if (parts.indexOf('b') !== -1) {
    for (let i = 0; i < ids.length; i++) {
      await sleep(PACE_MS);
      try {
        const r = await apiGet('/v1/horses/' + encodeURIComponent(ids[i]) + '/results?limit=50');
        out.horseResults[ids[i]] = { upstreamStatus: r.status, data: r.data };
      } catch (e) { out.errors.push('horseResults ' + ids[i] + ': ' + e.message); }
    }
  }

  if (parts.indexOf('c') !== -1) {
    await sleep(PACE_MS);
    try {
      const pr = await apiGet('/v1/results?start_date=2026-09-27&end_date=2026-09-27&limit=50');
      out.pastResults = { upstreamStatus: pr.status, data: pr.data };
    } catch (e) { out.errors.push('pastResults: ' + e.message); }
  }

  return { statusCode: 200, headers, body: JSON.stringify(Object.assign({ ms: Date.now() - t0 }, out)) };
};
