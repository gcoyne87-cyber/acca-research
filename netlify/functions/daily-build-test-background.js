// TEMPORARY diagnostic twin of daily-build-background.
// Netlify blocks external HTTP calls to scheduled functions (403 at the platform
// edge), so the scheduled function can no longer be manually triggered. This
// unscheduled twin re-exports the exact same handler, making it HTTP-invocable
// with the x-build-secret header for manual runs and diagnosis.
module.exports.config = { timeout: 900 };
module.exports.handler = require('./daily-build-background.js').handler;
