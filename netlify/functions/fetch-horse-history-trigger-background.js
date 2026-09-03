// Unscheduled trigger twin for fetch-horse-history-1-background.js — same
// pattern as daily-build-test-background.js: no schedule in config, so
// Netlify allows external POST calls to it (a function carrying a `schedule`
// is blocked at the platform edge with a 403 — see daily-build-trigger.js).
// fetch-horse-history-1-background.js has no internal x-build-secret check of
// its own (only ever meant to be invoked by Netlify's own scheduler), so that
// check lives here instead, before the background handler is called.
module.exports.config = { timeout: 900 };

exports.handler = async function(event) {
  const headers = { 'Content-Type': 'application/json' };
  const secret = event.headers && event.headers['x-build-secret'];
  if (secret !== process.env.BUILD_SECRET) {
    return { statusCode: 401, headers, body: JSON.stringify({ error: 'Unauthorised' }) };
  }
  return require('./fetch-horse-history-1-background.js').handler(event);
};
