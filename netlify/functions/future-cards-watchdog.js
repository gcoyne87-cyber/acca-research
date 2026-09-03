const https = require('https');
const nodemailer = require('nodemailer');

// Future-cards watchdog. Fires at 23:30 UTC, after the 23:00
// fetch-future-cards-background run should have completed, and checks exactly
// one thing: does racecards:{tomorrow} exist in Redis with meetings? A missed
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

    if (meetingCount > 0) {
      console.log('[future-cards-watchdog] ' + key + ' OK — ' + meetingCount + ' meetings (storedAt ' + (card.storedAt || 'unknown') + '). No email.');
      return { statusCode: 200, body: JSON.stringify({ ok: true, meetings: meetingCount }) };
    }

    const lines = ['Tomorrow\'s racecards are not in Redis after the 23:00 fetch-future-cards run.', ''];
    if (!card) {
      lines.push(key + ' does not exist — the 23:00 job never ran or died before storing tomorrow.');
    } else {
      lines.push(key + ' exists but holds no meetings (storedAt: ' + (card.storedAt || 'unknown') + ').');
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
