const https = require('https');
const nodemailer = require('nodemailer');

// Form-summary watchdog. Fires at 09:30 UTC, after all three scheduled
// form-summary runs (05:00 / 07:00 / 09:00) have had their say, and checks
// exactly one thing: does form-summary:complete:{today} exist and record a
// full (non-partial) completion? The job silently missed 2026-09-03 and
// 2026-09-04 entirely — no heartbeat, no completion, no email — and nothing
// noticed. Same contract as build-watchdog.js: silence must only ever mean
// the day completed, so an unreachable Redis is itself an email, never a
// silent exit.
module.exports.config = { schedule: '30 9 * * *' };

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
  // Same Europe/Dublin calendar day the form-summary job keys its
  // heartbeat/complete records by.
  const nowParts = new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Dublin' }).formatToParts(new Date());
  const today = nowParts.find(p => p.type === 'year').value + '-' + nowParts.find(p => p.type === 'month').value + '-' + nowParts.find(p => p.type === 'day').value;

  try {
    const complete = await redisGetStrict('form-summary:complete:' + today);

    if (complete && complete.status === 'complete') {
      console.log('[form-summary-watchdog] ' + today + ' completed at ' + complete.completedAt + ' (' + (complete.horsesGenerated || 0) + ' generated) — all clear, no email.');
      return { statusCode: 200, body: JSON.stringify({ ok: true, completedAt: complete.completedAt }) };
    }

    // Missing or partial — gather whatever evidence exists so the email makes
    // the failure mode obvious at a glance. The heartbeat read is evidence,
    // not a gate: if it fails, say so and send the alert anyway.
    let heartbeatLine = 'Heartbeat: could not be read';
    try {
      const hb = await redisGetStrict('form-summary:heartbeat:' + today);
      heartbeatLine = hb && hb.startedAt
        ? 'Heartbeat: last run started ' + hb.startedAt + (hb.scheduled === false ? ' (triggered via HTTP, not cron)' : '')
        : 'Heartbeat: none — no run started at all today (05:00, 07:00 and 09:00 triggers all failed to fire or reach the function)';
    } catch (hbErr) { /* keep the could-not-be-read line */ }

    const lines = ['The form summary job did not fully complete for ' + today + '.', ''];
    if (!complete) {
      lines.push('form-summary:complete:' + today + ' does not exist — no run finished today.');
    } else {
      lines.push('form-summary:complete:' + today + ' exists but is marked "' + (complete.status || 'unknown') + '".');
      lines.push('Generated: ' + (complete.horsesGenerated || 0) + ' | skipped: ' + (complete.horsesSkipped || 0) + ' | failed: ' + (complete.horsesFailed || 0) + ' | timedOut: ' + !!complete.timedOut);
      lines.push('Completed at: ' + (complete.completedAt || 'unknown'));
    }
    lines.push(heartbeatLine);
    lines.push('');
    lines.push('Impact: horses without a summary show none, and stale summaries are not refreshed until the next successful run.');
    lines.push('Check Netlify logs for form-summary-trigger, or trigger form-summary-background manually with the BUILD_SECRET.');

    await sendAlert('FORM SUMMARY WATCHDOG — job did not complete for ' + today, lines);
    console.log('[form-summary-watchdog] Alert sent for ' + today);
    return { statusCode: 200, body: JSON.stringify({ ok: false, alerted: true }) };

  } catch (e) {
    // Redis could not be verified — that is itself an alert, never silence.
    try {
      await sendAlert('FORM SUMMARY WATCHDOG — could not verify ' + today, [
        'The watchdog could not read Redis to check whether the form summary job for ' + today + ' completed.',
        '',
        'Error: ' + e.message,
        '',
        'The job itself may be fine — but it could not be verified. Check form-summary:complete:' + today + ' manually.'
      ]);
      console.error('[form-summary-watchdog] Could not verify ' + today + ' (' + e.message + ') — could-not-verify alert sent.');
    } catch (mailErr) {
      console.error('[form-summary-watchdog] TOTAL FAILURE for ' + today + ': Redis unreachable (' + e.message + ') AND alert email failed (' + mailErr.message + ').');
    }
    return { statusCode: 500, body: JSON.stringify({ ok: false, error: e.message }) };
  }
};
