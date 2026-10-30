const https = require('https');
const nodemailer = require('nodemailer');

// Class Drop watchdog — runs at 02:30 Irish time, 30 minutes after the nightly
// job. Checks the classdrop-nightly:ran:{today} completion marker that
// class-drop-nightly-background.js writes on success. If missing, or if Redis
// is unreachable, sends an alert email — an unverifiable night is never silence.
module.exports.config = { timeout: 60 };

const UPSTASH_URL = process.env.UPSTASH_REDIS_REST_URL;
const UPSTASH_TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN;

function redisGet(key) {
  const url = new URL(UPSTASH_URL);
  return new Promise(function(resolve, reject) {
    const req = https.request({
      hostname: url.hostname, path: '/get/' + encodeURIComponent(key), method: 'GET',
      headers: { Authorization: 'Bearer ' + UPSTASH_TOKEN }
    }, function(res) {
      let d = ''; res.on('data', function(c) { d += c; });
      res.on('end', function() { try { const r = JSON.parse(d); resolve(r.result ? JSON.parse(r.result) : null); } catch (e) { resolve(null); } });
    });
    req.on('error', reject);
    req.end();
  });
}

function irishNow() {
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Dublin', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false }).formatToParts(new Date());
  const get = function(type) { return (parts.find(function(p) { return p.type === type; }) || {}).value || ''; };
  let hour = parseInt(get('hour'), 10); if (hour === 24) hour = 0;
  return { date: get('year') + '-' + get('month') + '-' + get('day'), hour: hour, minute: parseInt(get('minute'), 10) };
}

exports.handler = async function(event) {
  const headers = { 'Content-Type': 'application/json' };
  const qs = event.queryStringParameters || {};
  const isScheduled = !event.httpMethod;
  if (!isScheduled) {
    const secret = qs.secret || (event.headers && event.headers['x-build-secret']);
    if (secret !== process.env.BUILD_SECRET) {
      return { statusCode: 401, headers, body: JSON.stringify({ error: 'Unauthorised' }) };
    }
  }

  const now = irishNow();
  const inWindow = now.hour === 2 && now.minute >= 20 && now.minute < 55;
  const force = qs.force === '1';
  if (!force && !inWindow) {
    console.log('[class-drop-watchdog] skipped — ' + now.date + ' ' + now.hour + ':' + String(now.minute).padStart(2, '0') + ' Irish is outside the 02:20-02:54 window');
    return { statusCode: 200, headers, body: JSON.stringify({ skipped: true, reason: 'outside Irish 02:20-02:54 window', irishNow: now }) };
  }

  const today = now.date;
  const MONTHS_FULL_W = ['January','February','March','April','May','June','July','August','September','October','November','December'];
  const DAYS_E_W = ['Sunday','Monday','Tuesday','Wednesday','Thursday','Friday','Saturday'];
  const _n = new Date();
  const subjectDate = DAYS_E_W[_n.getDay()] + ' ' + _n.getDate() + ' ' + MONTHS_FULL_W[_n.getMonth()] + ' ' + _n.getFullYear();

  let ran = null;
  let redisError = false;
  try {
    ran = await redisGet('classdrop-nightly:ran:' + today);
  } catch (e) {
    redisError = true;
    console.log('[class-drop-watchdog] Redis error: ' + e.message);
  }

  if (!redisError && ran && ran.completedAt) {
    console.log('[class-drop-watchdog] OK — class-drop-nightly completed at ' + ran.completedAt);
    return { statusCode: 200, headers, body: JSON.stringify({ ok: true, completedAt: ran.completedAt }) };
  }

  console.log('[class-drop-watchdog] ALERT — class-drop-nightly has not completed for ' + today + (redisError ? ' (redis unreachable)' : ''));

  const subject = 'Racing Edge — Class Drop Watchdog · ' + subjectDate + ' · 02:30 check';
  const body = [
    'Class Drop nightly did not complete by 02:30.',
    '',
    'The job may have failed silently or been killed by Netlify before sending its failure email.',
    "Today's Class Drop card may be stale.",
    "Tomorrow's preview may be missing — the 09:30 build will attempt to recover it automatically.",
    'Check Netlify logs for class-drop-nightly-background.'
  ].join('\n');

  try {
    const transporter = nodemailer.createTransport({
      service: 'gmail',
      auth: { user: process.env.GMAIL_USER, pass: process.env.GMAIL_APP_PASSWORD }
    });
    await transporter.sendMail({
      from: process.env.GMAIL_USER,
      to: 'gcoyne87@gmail.com',
      subject: subject,
      text: body
    });
    console.log('[class-drop-watchdog] alert email sent');
  } catch (eEmail) {
    console.log('[class-drop-watchdog] email send failed: ' + eEmail.message);
  }

  return { statusCode: 200, headers, body: JSON.stringify({ alerted: true, today: today, redisError: redisError }) };
};
