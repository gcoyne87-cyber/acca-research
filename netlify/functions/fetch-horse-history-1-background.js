const https = require('https');
const nodemailer = require('nodemailer');

module.exports.config = { schedule: '30 23 * * *', timeout: 900 };

const USERNAME = process.env.RACING_API_USERNAME;
const PASSWORD = process.env.RACING_API_KEY;
const BASE_URL = 'api.theracingapi.com';
const AUTH = Buffer.from((USERNAME || '') + ':' + (PASSWORD || '')).toString('base64');

const UPSTASH_URL = process.env.UPSTASH_REDIS_REST_URL;
const UPSTASH_TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN;

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
        try { resolve(JSON.parse(data)); }
        catch(e) { reject(new Error('Parse error: ' + data.substring(0, 200))); }
      });
    });
    req.on('error', reject);
    req.end();
  });
}

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
    }, res => { let d = ''; res.on('data', c => d += c); res.on('end', () => resolve(d)); });
    req.on('error', reject); req.write(body); req.end();
  });
}

// Best-effort email notification — must never affect the function's own result.
async function sendNotification(subject, bodyText) {
  try {
    const transporter = nodemailer.createTransport({
      service: 'gmail',
      auth: { user: process.env.GMAIL_USER, pass: process.env.GMAIL_APP_PASSWORD }
    });
    await transporter.sendMail({
      from: process.env.GMAIL_USER,
      to: process.env.GMAIL_USER,
      subject: subject,
      text: bodyText
    });
  } catch (e) {
    // Swallow — email failure must not affect the job's own outcome.
  }
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function fetchAndStoreHorseHistory(horse_id, dateStrs) {
  const data = await apiGet('/v1/horses/' + encodeURIComponent(horse_id) + '/results?limit=6');
  const history = (data.results || []).map(race => {
    const runner = (race.runners || []).find(r => r.horse_id === horse_id) || {};
    return {
      date: race.date || '',
      course: race.course || '',
      dist: race.dist || '',
      going: race.going || '',
      pos: runner.position || '-',
      ran: (race.runners || []).length || 0,
      sp: runner.sp || '',
      jockey: runner.jockey || ''
    };
  });
  await Promise.all(dateStrs.map(dateStr => redisSet('form:history:' + horse_id + ':' + dateStr, history)));
  return history;
}

exports.handler = async function(event) {
  let horsesFetched = 0;
  let horsesSkippedFromCache = 0;
  let horsesFailed = 0;

  try {
    // 1-2. Calculate tomorrow, day after tomorrow, and 3 days from now as YYYY-MM-DD
    const dateStrs = [];
    const base = new Date();
    for (let i = 1; i <= 3; i++) {
      const d = new Date(base.getFullYear(), base.getMonth(), base.getDate() + i);
      const y = d.getFullYear();
      const mo = String(d.getMonth() + 1).padStart(2, '0');
      const dy = String(d.getDate()).padStart(2, '0');
      dateStrs.push(y + '-' + mo + '-' + dy);
    }

    // 3-4. Read cached racecards for each date, extract every unique horse_id,
    // and track which of the 3 dates each horse actually runs on
    const horseDates = new Map(); // horse_id -> [dateStr, ...]
    for (const dateStr of dateStrs) {
      const cached = await redisGet('racecards:' + dateStr);
      if (!cached || !cached.meetings || !cached.meetings.length) continue; // skip silently

      cached.meetings.forEach(meeting => {
        (meeting.races || []).forEach(race => {
          (race.runners || []).forEach(runner => {
            if (!runner.horse_id) return;
            if (!horseDates.has(runner.horse_id)) horseDates.set(runner.horse_id, []);
            if (horseDates.get(runner.horse_id).indexOf(dateStr) === -1) {
              horseDates.get(runner.horse_id).push(dateStr);
            }
          });
        });
      });
    }

    const uniqueHorseIds = Array.from(horseDates.keys());

    // 5. Cache check — skip horses already fetched (checked against the first date they run on)
    const horsesToFetch = [];
    for (const horse_id of uniqueHorseIds) {
      const dates = horseDates.get(horse_id);
      const existing = await redisGet('form:history:' + horse_id + ':' + dates[0]);
      if (existing) {
        horsesSkippedFromCache++;
        continue;
      }
      horsesToFetch.push(horse_id);
    }

    // 6-9. Fetch + map + store in batches of 5, 1 second delay between batches
    const BATCH = 5;
    for (let i = 0; i < horsesToFetch.length; i += BATCH) {
      const batch = horsesToFetch.slice(i, i + BATCH);
      const results = await Promise.allSettled(batch.map(horse_id =>
        fetchAndStoreHorseHistory(horse_id, horseDates.get(horse_id))
      ));
      results.forEach(r => {
        if (r.status === 'fulfilled') horsesFetched++;
        else horsesFailed++;
      });
      if (i + BATCH < horsesToFetch.length) await sleep(1000);
    }

    console.log(`[fetch-horse-history-1] Done. Fetched: ${horsesFetched}, skipped (cached): ${horsesSkippedFromCache}, failed: ${horsesFailed}, dates: ${dateStrs.join(', ')}`);

    try {
      const perDateCounts = dateStrs.map(function(d) {
        var count = 0;
        horseDates.forEach(function(dates) { if (dates.indexOf(d) !== -1) count++; });
        return d + ': ' + count + ' horses found';
      });
      await sendNotification('Horse History Batch 1', [
        'Timestamp: ' + new Date().toISOString(),
        'Dates covered: ' + dateStrs.join(', '),
        '',
        'Horses per date:',
        perDateCounts.join('\n'),
        '',
        'Totals for this run — fetched: ' + horsesFetched + ', skipped (already cached): ' + horsesSkippedFromCache + ', failed: ' + horsesFailed
      ].join('\n'));
    } catch (e) { /* notification errors are swallowed inside sendNotification itself */ }

    return {
      statusCode: 200,
      body: JSON.stringify({ ok: true, horsesFetched, horsesSkippedFromCache, horsesFailed, dates: dateStrs })
    };
  } catch(e) {
    console.log(`[fetch-horse-history-1] Error: ${e.message}. Fetched: ${horsesFetched}, skipped: ${horsesSkippedFromCache}`);

    try {
      await sendNotification('Horse History Batch 1', [
        'Timestamp: ' + new Date().toISOString(),
        'Job failed before completion.',
        'Error: ' + e.message,
        'Fetched so far: ' + horsesFetched + ', skipped (already cached): ' + horsesSkippedFromCache
      ].join('\n'));
    } catch (e2) { /* notification errors are swallowed inside sendNotification itself */ }

    return {
      statusCode: 500,
      body: JSON.stringify({ error: e.message, horsesFetched, horsesSkippedFromCache })
    };
  }
};
