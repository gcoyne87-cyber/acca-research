// Unscheduled trigger twin for fetch-future-cards-background.js — same
// pattern as daily-build-test-background.js: no schedule in config, so
// Netlify allows external POST calls to it (a function carrying a `schedule`
// is blocked at the platform edge with a 403 — see daily-build-trigger.js).
// Unlike daily-build-background.js, fetch-future-cards-background.js has no
// internal x-build-secret check of its own (it was only ever meant to be
// invoked by Netlify's own scheduler) — so that check lives here instead,
// before the background handler is called.
module.exports.config = {};

exports.handler = async function(event) {
  const headers = { 'Content-Type': 'application/json' };
  const secret = event.headers && event.headers['x-build-secret'];
  if (secret !== process.env.BUILD_SECRET) {
    return { statusCode: 401, headers, body: JSON.stringify({ error: 'Unauthorised' }) };
  }
  return require('./fetch-future-cards-background.js').handler(event);
};
