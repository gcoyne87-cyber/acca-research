// Unscheduled test twin of trainer-history-background.
// Netlify blocks external HTTP calls to scheduled functions (403 at the platform
// edge), so a background job is made HTTP-invocable through this twin, which
// re-exports the exact same handler. Invoke with the x-build-secret header
// (plus optional ?date=YYYY-MM-DD; defaults to the 2026-09-13 trial date).
module.exports.config = { timeout: 900 };
module.exports.handler = require('./trainer-history-background.js').handler;
