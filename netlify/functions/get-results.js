const https = require('https');

const USERNAME = process.env.RACING_API_USERNAME;
const PASSWORD = process.env.RACING_API_KEY;
const BASE_URL = 'api.theracingapi.com';
const AUTH = Buffer.from((USERNAME || '') + ':' + (PASSWORD || '')).toString('base64');

function apiGet(path) {
  return new Promise((resolve, reject) => {
    const options = {
      hostname: BASE_URL,
      path: path,
      method: 'GET',
      headers: {
        'Authorization': 'Basic ' + AUTH,
        'Accept': 'application/json'
      }
    };
    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try { resolve({ status: res.statusCode, body: JSON.parse(data) }); }
        catch(e) { reject(new Error('Parse error: ' + data.substring(0, 300))); }
      });
    });
    req.on('error', reject);
    req.end();
  });
}

function normaliseName(s) {
  return (s || '').toLowerCase()
    .replace(/\s*\((ire|gb|fr|usa|ger|aus|nz|ity|spa|bel|den|swe|nor|cze|pol|hun|por|tur|chi|arg|bra|jap|hkg|uae|can|saf|ind)\)/g, '')
    .replace(/[^a-z0-9]/g, '');
}

function normaliseCourse(s) {
  return (s || '').toLowerCase().replace(/[^a-z]/g, '');
}

function courseFlag(region) {
  const r = (region || '').toUpperCase();
  if (r === 'IRE' || r === 'IE') return '🇮🇪';
  return '🇬🇧';
}

function isGbIre(region) {
  const r = (region || '').toUpperCase();
  return r === 'GB' || r === 'IRE' || r === 'IE' || r === 'UK' || r === '';
}

exports.handler = async function(event) {
  const headers = {
    'Access-Control-Allow-Origin': '*',
    'Content-Type': 'application/json'
  };

  try {
    const qs = event.queryStringParameters || {};
    const date = qs.date || '';
    const view = qs.view || '';

    if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
      return { statusCode: 400, headers, body: JSON.stringify({ error: 'date param required (YYYY-MM-DD)' }) };
    }

    // Paginated fetch — /v1/results caps each response at one page (~50 races
    // worldwide; top-level total/limit/skip fields), and foreign races count
    // against the cap before the GB/IRE filter below runs. The old single
    // un-paginated call silently dropped every race beyond page 1, which
    // surfaced as ran-horses wrongly showing NR in the tracker (2026-08-14/15).
    const PAGE_LIMIT = 50;
    const resp = await apiGet('/v1/results?start_date=' + date + '&end_date=' + date + '&limit=' + PAGE_LIMIT + '&skip=0');

    // Raw debug mode — call with ?raw=1 to see exactly what the API returns
    if (qs.raw === '1') {
      return {
        statusCode: 200,
        headers,
        body: JSON.stringify({
          apiStatus: resp.status,
          topKeys: Object.keys(resp.body || {}),
          sample: JSON.stringify(resp.body).substring(0, 3000)
        })
      };
    }

    // Surface API errors clearly
    if (resp.status !== 200 || resp.body.detail) {
      return {
        statusCode: 200,
        headers,
        body: JSON.stringify({ date, error: resp.body.detail || ('API status ' + resp.status), venues: [], lookup: {} })
      };
    }

    const data = resp.body;
    // Try all known field names the API might use
    const results = data.results || data.races || data.data || (Array.isArray(data) ? data : []);

    // Remaining pages — keep fetching until every result is held. A failed or
    // empty page stops the loop with what was collected so far (partial
    // coverage still beats page-1-only); the page cap is a runaway guard.
    // The Racing API enforces 5 requests/second — a 250ms gap between page
    // fetches caps us at 4/second, and a 429 gets one retry (after a 1s
    // backoff) instead of silently truncating results (found 2026-08-19:
    // rate-limit hits mid-pagination were quietly returning partial result
    // sets, which the tracker read as genuine NRs for horses that had run).
    const total = typeof data.total === 'number' ? data.total : results.length;
    let skip = PAGE_LIMIT;
    let pagesFetched = 0;
    while (results.length < total && pagesFetched < 20) {
      try {
        await new Promise(function(r) { setTimeout(r, 250); });
        let pageResp = await apiGet('/v1/results?start_date=' + date + '&end_date=' + date + '&limit=' + PAGE_LIMIT + '&skip=' + skip);
        if (pageResp.status === 429) {
          await new Promise(function(r) { setTimeout(r, 1000); });
          pageResp = await apiGet('/v1/results?start_date=' + date + '&end_date=' + date + '&limit=' + PAGE_LIMIT + '&skip=' + skip);
        }
        if (pageResp.status !== 200 || pageResp.body.detail) break;
        const pageResults = pageResp.body.results || [];
        if (!pageResults.length) break;
        results.push.apply(results, pageResults);
      } catch (pageErr) { break; }
      skip += PAGE_LIMIT;
      pagesFetched++;
    }

    // Filter to GB / IRE only
    const filtered = results.filter(function(race) {
      const reg = (race.region || race.country_code || race.country || '').toUpperCase();
      // If no region field present, include everything (let the racecard match handle it)
      return !reg || reg === 'GB' || reg === 'IRE' || reg === 'IE' || reg === 'UK';
    });

    // ── PAGE VIEW ─── structured data for the Results page UI
    if (view === 'page') {
      const venueMap = {};
      const venueOrder = [];

      filtered.forEach(function(race) {
        const course = race.course || race.venue || race.meeting || '';
        const courseId = normaliseCourse(course);
        const rawTime = race.off_time || race.off_dt || race.time || '';
        // Normalise to HH:MM so it matches RC_MEETINGS racecard times
        const timeMatch = rawTime.match(/(\d{1,2}):(\d{2})/);
        const time = timeMatch ? (timeMatch[1].length === 1 ? '0' + timeMatch[1] : timeMatch[1]) + ':' + timeMatch[2] : rawTime;
        const region = race.region || race.country_code || race.country || 'GB';

        if (!courseId) return;

        if (!venueMap[courseId]) {
          venueMap[courseId] = {
            courseId: courseId,
            course: course,
            flag: courseFlag(region),
            races: []
          };
          venueOrder.push(courseId);
        }

        const runners = (race.runners || [])
          .map(function(r) {
            const pos = String(r.position || r.pos || '');
            const sp = r.sp_dec ? fractionalFromDecimal(parseFloat(r.sp_dec)) : (r.sp || r.sp_fractional || '');
            return {
              pos: pos,
              horse: r.horse || r.horse_name || r.name || '',
              draw: r.draw !== undefined && r.draw !== null ? String(r.draw) : '',
              jockey: r.jockey || r.jockey_name || '',
              trainer: r.trainer || r.trainer_name || '',
              sp: sp,
              btn: r.btn !== undefined ? String(r.btn) : ''
            };
          })
          .filter(function(r) { return r.horse; })
          .sort(function(a, b) {
            const pa = parseInt(a.pos) || 99;
            const pb = parseInt(b.pos) || 99;
            return pa - pb;
          });

        // Build distances string from btn fields (2nd onwards)
        const distances = runners.slice(1, 5).map(function(r) { return r.btn; }).filter(Boolean).join(', ');

        const cls = race.race_class || race.class || '';
        const prize = race.prize || race.total_prize_money || race.prize_money || '';
        const winningTime = race.winning_time || race.time_description || '';
        const totalSp = race.total_sp_pct ? Math.round(race.total_sp_pct) + '%'
          : (race.total_sp ? String(race.total_sp) : '');

        venueMap[courseId].races.push({
          time: time,
          name: race.race_name || race.name || race.title || '',
          dist: race.distance || race.dist || '',
          cls: cls ? 'Class ' + cls : '',
          prize: prize,
          going: race.going || race.ground || '',
          ran: (race.runners || []).length,
          winning_time: winningTime,
          total_sp: totalSp,
          distances: distances,
          runners: runners
        });
      });

      venueOrder.forEach(function(id) {
        venueMap[id].races.sort(function(a, b) {
          return (a.time || '').localeCompare(b.time || '');
        });
      });

      return {
        statusCode: 200,
        headers,
        body: JSON.stringify({ date, venues: venueOrder.map(function(id) { return venueMap[id]; }) })
      };
    }

    // ── LOOKUP VIEW (default) ── for Winners tracker sync
    const lookup = {};
    filtered.forEach(function(race) {
      const course = race.course || race.venue || '';
      const time = race.off_time || race.off_dt || race.time || '';
      (race.runners || []).forEach(function(r) {
        const key = normaliseName(r.horse || r.horse_name || r.name || '');
        if (!key) return;
        const pos = String(r.position || r.pos || '');
        const sp = r.sp_dec ? fractionalFromDecimal(parseFloat(r.sp_dec)) : (r.sp || r.sp_fractional || '');
        lookup[key] = { sp, pos, course, courseNorm: normaliseCourse(course), time, ran: (race.runners || []).length };
      });
    });

    return {
      statusCode: 200,
      headers,
      body: JSON.stringify({ date, lookup })
    };

  } catch(e) {
    return {
      statusCode: 500,
      headers,
      body: JSON.stringify({ error: e.message })
    };
  }
};

function fractionalFromDecimal(dec) {
  if (!dec || dec <= 1) return 'SP';
  const n = dec - 1;
  const common = [
    [1,5],[2,9],[1,4],[2,7],[3,10],[1,3],[4,11],[2,5],[4,9],[1,2],
    [4,7],[8,13],[4,6],[8,11],[4,5],[5,6],[10,11],[1,1],[6,5],[5,4],
    [11,8],[6,4],[13,8],[7,4],[15,8],[2,1],[9,4],[5,2],[11,4],[3,1],
    [10,3],[7,2],[4,1],[9,2],[5,1],[11,2],[6,1],[13,2],[7,1],[8,1],
    [9,1],[10,1],[11,1],[12,1],[14,1],[16,1],[20,1],[25,1],[33,1],[50,1],[66,1],[100,1]
  ];
  let best = null, bestDiff = 999;
  common.forEach(function(f) {
    const diff = Math.abs(f[0]/f[1] - n);
    if (diff < bestDiff) { bestDiff = diff; best = f; }
  });
  if (best && bestDiff < 0.05) return best[0] + '/' + best[1];
  return Math.round(n) + '/1';
}
