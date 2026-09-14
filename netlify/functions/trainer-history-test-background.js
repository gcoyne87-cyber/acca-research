// Unscheduled test twin of trainer-history-background.
// Netlify blocks external HTTP calls to scheduled functions (403 at the platform
// edge), so a background job is made HTTP-invocable through this twin, which
// re-exports the exact same handler. Invoke with the x-build-secret header
// (?date=YYYY-MM-DD is required — no default day; optional &hop=N is the
// self-chain counter and is normally left off).
module.exports.config = { timeout: 900 };
module.exports.handler = require('./trainer-history-background.js').handler;
