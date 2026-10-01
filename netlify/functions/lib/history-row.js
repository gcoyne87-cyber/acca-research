// Shared per-run row builder for every writer that calls the Racing API's
// /v1/horses/{id}/results endpoint: fetch-horse-history-1-background.js and
// fetch-horse-history-2-background.js (the 00:30/00:50 Irish nightly
// fetchers), racing-sweep-background.js (the 02:15 sweep) and horse-form.js
// (the live on-demand cache-miss tier). One shared function so all four
// write an identical field set from now on.
//
// Before this: the two nightly fetchers kept no `or` field at all (the
// runner's official rating was silently dropped); none of the four kept
// `pattern` or `rating_band`, even though both exist on this endpoint's race
// object — confirmed live via a temporary Racing API probe against real
// Group/Listed/Graded races (e.g. a Curragh Group 3 returned
// pattern:"Group 3", a Punchestown Grade 1 returned pattern:"Grade 1").
// `race_class` and `type` were already correct and are unchanged here.
//
// Field order matches racing-sweep-background.js's and horse-form.js's
// pre-existing object literal (which already had `or`); this only adds
// `pattern` and `rating_band`, and backfills `or` onto the two fetchers that
// never had it. No existing field name, fallback chain or semantics changes.
function buildHistoryRow(race, runner) {
  return {
    date: race.date || '',
    course: race.course || '',
    dist: race.dist || '',
    going: race.going || '',
    pos: runner.position || '-',
    ran: (race.runners || []).length || 0,
    sp: runner.sp || '',
    or: runner.or || '',
    jockey: runner.jockey || '',
    race_class: race.class || race.race_class || '',
    pattern: race.pattern || '',
    rating_band: race.rating_band || '',
    trainer: runner.trainer || '',
    prize: runner.prize || '',
    surface: race.surface || '',
    type: race.type || ''
  };
}

// Course-name heuristic for Irish courses — the stored form:history row
// carries no region field of its own (the Racing API's results endpoint
// does send race-level `region`, but it has never been kept on the row), so
// "is this a GB run" can only be read back off the course name. Same list
// used elsewhere this session for the same reason (going/form-sections work).
// A course not in this list is treated as GB — correct for this site, which
// only ever shows GB and Irish meetings.
const IRISH_COURSES = ['leopardstown', 'curragh', 'gowran park', 'fairyhouse', 'navan', 'naas', 'clonmel', 'bellewstown', 'ballinrobe', 'cork', 'limerick', 'tipperary', 'listowel', 'killarney', 'down royal', 'downpatrick', 'sligo', 'roscommon', 'wexford', 'thurles', 'tramore', 'dundalk', 'punchestown', 'galway', 'kilbeggan', 'laytown', 'tralee'];
function isGBCourse(course) {
  const stripped = String(course || '').replace(/\s*\(aw\)/i, '').trim().toLowerCase();
  if (!stripped) return false;
  return IRISH_COURSES.indexOf(stripped) === -1;
}

module.exports = { buildHistoryRow: buildHistoryRow, isGBCourse: isGBCourse };
