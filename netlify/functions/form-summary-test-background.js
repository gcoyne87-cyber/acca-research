// Unscheduled test twin of form-summary-background.
// Netlify blocks external HTTP calls to scheduled functions (403 at the platform
// edge), so the scheduled function can no longer be manually triggered. This
// unscheduled twin re-exports the exact same handler, making it HTTP-invocable
// with the x-build-secret header (plus ?date=&course= for one-meeting test runs,
// or ?condense=1&date=YYYY-MM-DD[&hop=N] to rewrite that day's stored summaries
// into the styleVersion 2 glance-level style — see runCondense()).
module.exports.config = { timeout: 900 };
module.exports.handler = require('./form-summary-background.js').handler;
