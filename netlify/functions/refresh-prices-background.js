const https = require('https');
const nodemailer = require('nodemailer');

module.exports.config = { schedule: '0 6-21 * * *', timeout: 120 };

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
        let parsed;
        try { parsed = JSON.parse(data); }
        catch(e) { reject(new Error('Parse error (status ' + res.statusCode + '): ' + data.substring(0, 200))); return; }
        // A non-2xx response with a valid JSON error body (e.g. rate-limit or
        // out-of-range-date errors) would otherwise resolve "successfully" here
        // and silently look like an empty racecard day downstream. Surface it
        // as a real error instead.
        if (res.statusCode < 200 || res.statusCode >= 300) {
          const apiMsg = (parsed && (parsed.error || parsed.message)) || JSON.stringify(parsed).substring(0, 200);
          reject(new Error('HTTP ' + res.statusCode + ': ' + apiMsg));
          return;
        }
        resolve(parsed);
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
      hostname: url.hostname,
      path: '/get/' + encodeURIComponent(key),
      method: 'GET',
      headers: { 'Authorization': 'Bearer ' + UPSTASH_TOKEN }
    }, res => {
      let d = '';
      res.on('data', c => d += c);
      res.on('end', () => {
        try { const r = JSON.parse(d); resolve(r.result ? JSON.parse(r.result) : null); }
        catch(e) { resolve(null); }
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
      hostname: url.hostname, path: '/set/' + encodeURIComponent(key), method: 'POST',
      headers: { 'Authorization': 'Bearer ' + UPSTASH_TOKEN, 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) }
    }, res => { let d = ''; res.on('data', c => d += c); res.on('end', () => resolve(d)); });
    req.on('error', reject); req.write(body); req.end();
  });
}

function redisDel(key) {
  const url = new URL(UPSTASH_URL);
  return new Promise((resolve, reject) => {
    const req = https.request({
      hostname: url.hostname, path: '/del/' + encodeURIComponent(key), method: 'POST',
      headers: { 'Authorization': 'Bearer ' + UPSTASH_TOKEN }
    }, res => { let d = ''; res.on('data', c => d += c); res.on('end', () => resolve(d)); });
    req.on('error', reject); req.end();
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

function extractPrice(oddsArr, bookmaker) {
  if (!Array.isArray(oddsArr) || !oddsArr.length) return 'SP';
  const bk = (bookmaker || '').toLowerCase();
  const match = oddsArr.find(function(o) {
    return (o.bookmaker || '').toLowerCase() === bk;
  });
  if (match && match.fractional) return match.fractional;
  // fall back to first non-exchange bookmaker
  const fallback = oddsArr.find(function(o) {
    return o.fractional && !(o.bookmaker || '').toLowerCase().includes('exchange');
  });
  return (fallback && fallback.fractional) || 'SP';
}

async function sendErrorEmail(dateLabel, err) {
  try {
    const transporter = nodemailer.createTransport({
      service: 'gmail',
      auth: { user: process.env.GMAIL_USER, pass: process.env.GMAIL_APP_PASSWORD }
    });
    await transporter.sendMail({
      from: process.env.GMAIL_USER,
      to: 'gcoyne87@gmail.com',
      subject: 'Price Refresh ERROR',
      text: 'Date failed: ' + dateLabel + '\nError: ' + err.message + '\nTimestamp: ' + new Date().toISOString()
    });
  } catch (e) {
    // Swallow — email failure must not affect the job's own outcome.
  }
}

exports.handler = async function(event) {
  console.log('[refresh-prices-background] started');

  const now = new Date();
  const today = now.getFullYear() + '-' + String(now.getMonth() + 1).padStart(2, '0') + '-' + String(now.getDate()).padStart(2, '0');

  let todayUpdated = 0;
  let todayError = null;

  try {
    const freshData = await apiGet('/v1/racecards/pro?date=' + today);
    const cached = await redisGet('racecards:' + today);

    if (!cached || !cached.meetings) {
      console.log('No cached racecard for today');
    } else if (freshData && freshData.racecards && freshData.racecards.length) {
      // Build a horse_id -> fresh price lookup from the raw Racing API response
      const freshPriceMap = {};
      freshData.racecards.forEach(function(race) {
        (race.runners || []).forEach(function(r) {
          if (!r.horse_id) return;
          const oddsArr = Array.isArray(r.odds) ? r.odds : (Array.isArray(r.price) ? r.price : null);
          freshPriceMap[r.horse_id] = extractPrice(oddsArr, 'Boyle Sports');
        });
      });

      // Walk the existing cached (mapped) meetings structure and update only the price field
      (cached.meetings || []).forEach(function(m) {
        (m.races || []).forEach(function(race) {
          (race.runners || []).forEach(function(ru) {
            if (ru.horse_id && freshPriceMap.hasOwnProperty(ru.horse_id)) {
              ru.price = freshPriceMap[ru.horse_id];
              todayUpdated++;
            }
          });
        });
      });

      await redisSet('racecards:' + today, cached);
    }
  } catch (e) {
    console.log('[refresh-prices-background] today error:', e.message);
    todayError = e.message;
    await sendErrorEmail('today (' + today + ')', e);
  }

  console.log('[refresh-prices-background] todayUpdated:', todayUpdated);

  await new Promise(resolve => setTimeout(resolve, 200));

  const tmrw = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1);
  const tomorrow = tmrw.getFullYear() + '-' + String(tmrw.getMonth() + 1).padStart(2, '0') + '-' + String(tmrw.getDate()).padStart(2, '0');

  let tomorrowUpdated = 0;
  let tomorrowError = null;

  try {
    const freshDataTomorrow = await apiGet('/v1/racecards/pro?date=' + tomorrow);
    const cachedTomorrow = await redisGet('racecards:' + tomorrow);

    if (!cachedTomorrow || !cachedTomorrow.meetings) {
      console.log('No cached racecard for tomorrow');
    } else if (freshDataTomorrow && freshDataTomorrow.racecards && freshDataTomorrow.racecards.length) {
      // Build a horse_id -> fresh price lookup from the raw Racing API response
      const freshPriceMapTomorrow = {};
      freshDataTomorrow.racecards.forEach(function(race) {
        (race.runners || []).forEach(function(r) {
          if (!r.horse_id) return;
          const oddsArr = Array.isArray(r.odds) ? r.odds : (Array.isArray(r.price) ? r.price : null);
          freshPriceMapTomorrow[r.horse_id] = extractPrice(oddsArr, 'Boyle Sports');
        });
      });

      // Walk the existing cached (mapped) meetings structure and update only the price field
      (cachedTomorrow.meetings || []).forEach(function(m) {
        (m.races || []).forEach(function(race) {
          (race.runners || []).forEach(function(ru) {
            if (ru.horse_id && freshPriceMapTomorrow.hasOwnProperty(ru.horse_id)) {
              ru.price = freshPriceMapTomorrow[ru.horse_id];
              tomorrowUpdated++;
            }
          });
        });
      });

      await redisSet('racecards:' + tomorrow, cachedTomorrow);
    }
  } catch (e) {
    console.log('[refresh-prices-background] tomorrow error:', e.message);
    tomorrowError = e.message;
    await sendErrorEmail('tomorrow (' + tomorrow + ')', e);
  }

  console.log('[refresh-prices-background] tomorrowUpdated:', tomorrowUpdated);

  const logKey = 'price-refresh-log:' + today + ':' + new Date().getUTCHours();
  await redisSet(logKey, {
    todayUpdated: todayUpdated,
    tomorrowUpdated: tomorrowUpdated,
    timestamp: new Date().toISOString(),
    errors: [todayError, tomorrowError].filter(Boolean)
  });

  // 21:00 UTC = 10pm Irish time (summer) — compile and send the daily summary, then clear today's log entries
  if (now.getUTCHours() === 21) {
    const summaryHours = [];
    for (let h = 6; h <= 21; h++) { summaryHours.push(h); }

    const summaryEntries = [];
    for (const h of summaryHours) {
      const entry = await redisGet('price-refresh-log:' + today + ':' + h);
      if (entry) summaryEntries.push({ hour: h, data: entry });
    }

    let summaryText = 'Price Refresh Daily Summary for ' + today + '\n\n';
    if (!summaryEntries.length) {
      summaryText += 'No hourly runs recorded for today.\n';
    } else {
      summaryEntries.forEach(function(entry) {
        summaryText += 'Hour ' + entry.hour + ':00 UTC — todayUpdated: ' + entry.data.todayUpdated + ', tomorrowUpdated: ' + entry.data.tomorrowUpdated;
        if (entry.data.errors && entry.data.errors.length) {
          summaryText += ', errors: ' + entry.data.errors.join('; ');
        }
        summaryText += '\n';
      });
    }

    try {
      const transporter = nodemailer.createTransport({
        service: 'gmail',
        auth: { user: process.env.GMAIL_USER, pass: process.env.GMAIL_APP_PASSWORD }
      });
      await transporter.sendMail({
        from: process.env.GMAIL_USER,
        to: 'gcoyne87@gmail.com',
        subject: 'Price Refresh Daily Summary - ' + today,
        text: summaryText
      });
    } catch (e) {
      // Swallow — email failure must not affect the job's own outcome.
    }

    for (const h of summaryHours) {
      await redisDel('price-refresh-log:' + today + ':' + h);
    }
  }

  return {
    statusCode: 200,
    body: JSON.stringify({ todayUpdated: todayUpdated, tomorrowUpdated: tomorrowUpdated })
  };
};
