const https = require('https');
const nodemailer = require('nodemailer');

// Scheduled build watchdog. Fires at 10:00 UTC (11:00 Irish through summer
// time, 10:00 Irish in winter — an hour early then, which is harmless), after
// the 09:30 scheduled build, the 09:40 GitHub Actions safety net, and any
// Netlify platform retry have all had their say. It does exactly two things:
// reads daily:report:{today}, and — only when the day did NOT complete — sends
// one plain alert email via the same Gmail transporter the build itself uses.
// Silence must only ever mean the day completed successfully, so a Redis that
// cannot be reached at all is itself an email, never a silent exit.
// Runs in the ordinary scheduled-function class (30s limit) — one Redis read
// plus at most one email fits with room to spare.
module.exports.config = { schedule: '0 10 * * *' };

const UPSTASH_URL = process.env.UPSTASH_REDIS_REST_URL;
const UPSTASH_TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN;

// Strict Redis GET: distinguishes "key absent" (resolves null) from "could not
// verify" (rejects) — the watchdog must never mistake an unreachable Redis for
// a completed day.
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
  const today = new Date().toISOString().slice(0, 10);
  try {
    const report = await redisGetStrict('daily:report:' + today);

    if (report && report.completedAt) {
      console.log('[build-watchdog] ' + today + ' completed at ' + report.completedAt + ' — all clear, no email.');
      return { statusCode: 200, body: JSON.stringify({ ok: true, completedAt: report.completedAt }) };
    }

    // The day did not complete — gather whatever evidence exists so the email
    // makes the failure mode obvious at a glance. The lock read is evidence,
    // not a gate: if it fails, say so and send the alert anyway.
    let lockLine = 'Lock state: could not be read';
    try {
      const lock = await redisGetStrict('build:lock:' + today);
      lockLine = (lock && lock.startedAt)
        ? 'Lock state: HELD since ' + lock.startedAt + ' (never released — build died mid-run)'
        : 'Lock state: clear';
    } catch (lockErr) { /* keep the could-not-be-read line */ }

    const lines = ['The daily build for ' + today + ' did not complete.', ''];
    if (!report) {
      lines.push('daily:report:' + today + ' does not exist at all — the build never started (scheduler and safety net both failed, or it died before its first write).');
    } else {
      lines.push('daily:report:' + today + ' exists but has no completedAt — the build started and died mid-run.');
      lines.push('startedAt: ' + (report.startedAt || 'unknown'));
      lines.push('Races analysed before it died: ' + (report.racesAnalysed || 0) + ' of ' + (report.upcomingRaces || report.totalRaces || '?'));
      lines.push('Errors recorded: ' + ((report.errors || []).length ? report.errors.join('; ').slice(0, 500) : 'none — consistent with a platform timeout kill'));
    }
    lines.push(lockLine);

    await sendAlert('BUILD WATCHDOG — build did not complete for ' + today, lines);
    console.log('[build-watchdog] Alert sent for ' + today);
    return { statusCode: 200, body: JSON.stringify({ ok: false, alerted: true }) };

  } catch (e) {
    // Redis could not be verified — that is itself an alert, never silence.
    try {
      await sendAlert('BUILD WATCHDOG — could not verify build for ' + today, [
        'The watchdog could not read Redis to check whether the daily build for ' + today + ' completed.',
        '',
        'Error: ' + e.message,
        '',
        'The build itself may be fine — but it could not be verified. Check daily:report:' + today + ' manually.'
      ]);
      console.error('[build-watchdog] Could not verify ' + today + ' (' + e.message + ') — could-not-verify alert sent.');
    } catch (mailErr) {
      console.error('[build-watchdog] TOTAL FAILURE for ' + today + ': Redis unreachable (' + e.message + ') AND alert email failed (' + mailErr.message + ').');
    }
    return { statusCode: 500, body: JSON.stringify({ ok: false, error: e.message }) };
  }
};
