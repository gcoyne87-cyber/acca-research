const https = require('https');
const nodemailer = require('nodemailer');

// Future-cards watchdog. Fires at 23:30 UTC, after the 23:00
// fetch-future-cards-background run should have completed, and checks exactly
// three things: does racecards:{tomorrow} exist in Redis with meetings, is its
// storedAt fresh (under 20h — the 23:00 job should have just rewritten it),
// and did tonight's run leave its debug:fetch-future-cards:{ts} record? A missed
// nightly run previously went completely silent (2026-09-02: no run, no
// record, no email) and cost a full day of live-API fallbacks — slow loads,
// blank flicker, missing tags. Same contract as build-watchdog.js: silence
// must only ever mean the check passed, so an unreachable Redis is itself an
// email, never a silent exit.
module.exports.config = { schedule: '30 23 * * *' };

const UPSTASH_URL = process.env.UPSTASH_REDIS_REST_URL;
const UPSTASH_TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN;

// Strict Redis GET: distinguishes "key absent" (resolves null) from "could not
// verify" (rejects) — the watchdog must never mistake an unreachable Redis for
// a stored card.
function redisGetStrict(key) {
  return new Promise((resolve, reject) => {
    const url = new URL(UPSTASH_URL);
    const req = https.request({
      hostname: url.hostname,
      path: '/get/' + encodeURIComponent(key),
      method: 'GET',
      headers: { 'Authorization': 'Bearer ' + UPSTASH_TOKEN }
    }, res => {
      let d = '';
      res.on('data', c => d += c);
      res.on('end', () => {
        if (res.statusCode !== 200) return reject(new Error('Upstash HTTP ' + res.statusCode + ' for ' + key));
        try {
          const r = JSON.parse(d);
          resolve(r.result ? JSON.parse(r.result) : null);
        } catch (e) { reject(new Error('Unparseable Upstash response for ' + key)); }
      });
    });
    req.on('error', e => reject(new Error('Upstash unreachable: ' + e.message)));
    req.setTimeout(8000, () => { req.destroy(); reject(new Error('Upstash timeout for ' + key)); });
    req.end();
  });
}

// Strict Redis SCAN for a key pattern — same contract as redisGetStrict: an
// unreachable Redis rejects rather than reading as "no keys".
function redisScanStrict(pattern) {
  return new Promise((resolve, reject) => {
    const url = new URL(UPSTASH_URL);
    const found = [];
    function page(cursor) {
      const req = https.request({
        hostname: url.hostname,
        path: '/scan/' + cursor + '?match=' + encodeURIComponent(pattern) + '&count=1000',
        method: 'GET',
        headers: { 'Authorization': 'Bearer ' + UPSTASH_TOKEN }
      }, res => {
        let d = '';
        res.on('data', c => d += c);
        res.on('end', () => {
          if (res.statusCode !== 200) return reject(new Error('Upstash HTTP ' + res.statusCode + ' for scan ' + pattern));
          try {
            const r = JSON.parse(d).result;
            (r[1] || []).forEach(k => found.push(k));
            if (r[0] && r[0] !== '0') page(r[0]); else resolve(found);
          } catch (e) { reject(new Error('Unparseable Upstash scan response for ' + pattern)); }
        });
      });
      req.on('error', e => reject(new Error('Upstash unreachable: ' + e.message)));
      req.setTimeout(8000, () => { req.destroy(); reject(new Error('Upstash timeout for scan ' + pattern)); });
      req.end();
    }
    page('0');
  });
}

function sendAlert(subject, bodyLines) {
  const transporter = nodemailer.createTransport({
    service: 'gmail',
    auth: { user: process.env.GMAIL_USER, pass: process.env.GMAIL_APP_PASSWORD }
  });
  return transporter.sendMail({
    from: process.env.GMAIL_USER,
    to: 'gcoyne87@gmail.com',
    subject: subject,
    text: bodyLines.join('\n')
  });
}

exports.handler = async function() {
  // Same "tomorrow" the 23:00 job computes: UTC date + 1 day.
  const base = new Date();
  const t = new Date(base.getFullYear(), base.getMonth(), base.getDate() + 1);
  const tomorrow = t.getFullYear() + '-' + String(t.getMonth() + 1).padStart(2, '0') + '-' + String(t.getDate()).padStart(2, '0');
  const key = 'racecards:' + tomorrow;

  try {
    const card = await redisGetStrict(key);
    const meetingCount = (card && Array.isArray(card.meetings)) ? card.meetings.length : 0;

    // Freshness: the 23:00 job rewrites tomorrow's card every night, so a
    // storedAt older than 20h means tonight's run did not land (2026-09-14:
    // the run was triggered but wrote nothing, and every card sat two days
    // stale — Irish jockeys blank — while the existence check passed).
    const MAX_AGE_H = 20;
    const storedMs = card && card.storedAt ? Date.parse(card.storedAt) : NaN;
    const ageH = isNaN(storedMs) ? null : (Date.now() - storedMs) / 3600000;
    const stale = ageH === null || ageH > MAX_AGE_H;

    // Run record: fetch-future-cards-background writes debug:fetch-future-cards:{ISO}
    // at the end of every run. No record stamped today means the run never
    // completed, silently or not.
    const todayStr = base.getFullYear() + '-' + String(base.getMonth() + 1).padStart(2, '0') + '-' + String(base.getDate()).padStart(2, '0');
    const runRecords = await redisScanStrict('debug:fetch-future-cards:' + todayStr + '*');
    const noRunRecord = runRecords.length === 0;

    if (meetingCount > 0 && !stale && !noRunRecord) {
      console.log('[future-cards-watchdog] ' + key + ' OK — ' + meetingCount + ' meetings (storedAt ' + card.storedAt + ', ' + ageH.toFixed(1) + 'h old), run record ' + runRecords.sort().pop() + '. No email.');
      return { statusCode: 200, body: JSON.stringify({ ok: true, meetings: meetingCount, ageHours: Math.round(ageH * 10) / 10 }) };
    }

    const lines = ['Tomorrow\'s racecards failed the 23:30 check after the 23:00 fetch-future-cards run.', ''];
    if (!card) {
      lines.push(key + ' does not exist — the 23:00 job never ran or died before storing tomorrow.');
    } else if (meetingCount === 0) {
      lines.push(key + ' exists but holds no meetings (storedAt: ' + (card.storedAt || 'unknown') + ').');
    }
    if (card && meetingCount > 0 && stale) {
      lines.push(key + ' is stale: storedAt ' + (card.storedAt || 'unknown') + (ageH === null ? '' : ' (' + ageH.toFixed(1) + 'h old, limit ' + MAX_AGE_H + 'h)') + ' — tonight\'s run did not rewrite it. Jockeys declared since (Irish meetings especially) are missing.');
    }
    if (noRunRecord) {
      lines.push('No debug:fetch-future-cards:' + todayStr + '* run record exists — tonight\'s run never completed.');
    }
    lines.push('');
    lines.push('Until the key is stored, every request for that date falls back to a live Racing API call and the horse-history jobs (23:30/23:50) skip it silently — no form tables, no tags.');
    lines.push('Check debug:fetch-future-cards:* in Redis for the run record, or trigger fetch-future-cards-background manually.');

    await sendAlert('FUTURE CARDS WATCHDOG — failed for ' + tomorrow, lines);
    console.log('[future-cards-watchdog] Alert sent for ' + tomorrow);
    return { statusCode: 200, body: JSON.stringify({ ok: false, alerted: true }) };

  } catch (e) {
    // Redis could not be verified — that is itself an alert, never silence.
    try {
      await sendAlert('FUTURE CARDS WATCHDOG — could not verify ' + tomorrow, [
        'The watchdog could not read Redis to check whether ' + key + ' was stored.',
        '',
        'Error: ' + e.message,
        '',
        'The nightly fetch may be fine — but it could not be verified. Check ' + key + ' manually.'
      ]);
      console.error('[future-cards-watchdog] Could not verify ' + tomorrow + ' (' + e.message + ') — could-not-verify alert sent.');
    } catch (mailErr) {
      console.error('[future-cards-watchdog] TOTAL FAILURE for ' + tomorrow + ': Redis unreachable (' + e.message + ') AND alert email failed (' + mailErr.message + ').');
    }
    return { statusCode: 500, body: JSON.stringify({ ok: false, error: e.message }) };
  }
};
