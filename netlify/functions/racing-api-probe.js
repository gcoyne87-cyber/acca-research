const https = require('https');

// TEMPORARY read-only probe. Exists so a one-off field-discovery test can be
// run with the site's credentials: does the Racing API's results data
// include an in-running comment for each runner (e.g. "led 2 out, stayed
// on")? Racing API only — no Claude calls, nothing written to Redis, no
// site behaviour changes. To be deleted once the test is reported (same
// lifecycle as the earlier class/pattern/rating-band probe: create, deploy,
// call, report, delete).
//
//   GET /.netlify/functions/racing-api-probe
//   header: x-build-secret
//
// Calls:
//   a. /v1/results?start_date=2026-10-02&end_date=2026-10-02&limit=50   (one page)
//   b. /v1/horses/{id}/results?limit=50   (the same endpoint fetch-horse-history-1/2-background.js use), for 3 horse_ids pulled from (a)'s own runners
// Paced at one request every 250ms (4/sec, under the documented 5/sec ceiling).

const AUTH = Buffer.from((process.env.RACING_API_USERNAME || '') + ':' + (process.env.RACING_API_KEY || '')).toString('base64');
const PACE_MS = 250;

function sleep(ms) { return new Promise(function(r) { setTimeout(r, ms); }); }

function apiGet(path) {
  return new Promise(function(resolve) {
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

  const t0 = Date.now();
  const out = { results: null, horseResults: {}, pickedIds: [], errors: [] };

  try {
    const r = await apiGet('/v1/results?start_date=2026-10-02&end_date=2026-10-02&limit=50');
    out.results = { upstreamStatus: r.status, data: r.data };

    const ids = [];
    const races = (r.data && r.data.results) || [];
    outer:
    for (let i = 0; i < races.length; i++) {
      const runners = races[i].runners || [];
      for (let j = 0; j < runners.length; j++) {
        const hid = runners[j].horse_id;
        if (hid && ids.indexOf(hid) === -1) {
          ids.push(hid);
          if (ids.length >= 3) break outer;
        }
      }
    }
    out.pickedIds = ids;

    for (let i = 0; i < ids.length; i++) {
      await sleep(PACE_MS);
      const hr = await apiGet('/v1/horses/' + encodeURIComponent(ids[i]) + '/results?limit=50');
      out.horseResults[ids[i]] = { upstreamStatus: hr.status, data: hr.data };
    }
  } catch (e) {
    out.errors.push(e.message);
  }

  return { statusCode: 200, headers, body: JSON.stringify(Object.assign({ ms: Date.now() - t0 }, out)) };
};
