// form-sections.js — the goingtrip engine: code computes every fact, the
// model only phrases them.
//
// Redesign (post-2026-10-06 probes): the previous design sent the model raw
// data blocks (every result, every group line) and then policed what it
// wrote with ~20 structural regex checks plus a second model call. Five
// probes showed the checks and the writer drifting apart faster than they
// could be reconciled. Now the data layer (sections A–C below, unchanged)
// feeds three deterministic FACT ASSEMBLERS — buildGoingFacts,
// buildTripFacts, buildTrackFacts — which decide everything the text may
// say: which group leads, whether a comparison is justified, the stamina
// facts with an explicit NONE, the thin-record line, and the course
// character wording. The model's contract is phrasing only, and the
// validator is reduced to voice rules plus one structural check: every
// number token in the output must appear in that section's fact list.
//
// Reused from text-engine-submit-background.js's public helpers (unchanged):
// posNum (finishing position as a number or null), stripParens (drops a
// "(...)" course suffix).
const engineHelpers = require('../text-engine-submit-background.js').helpers;
const posNum = engineHelpers.posNum;
const stripParens = engineHelpers.stripParens;

// course-facts.json loaded once at module startup. A missing/unparseable
// file degrades to an empty object so Going/Trip keep working — every course
// then reports "(course character unknown)".
let COURSE_FACTS = {};
try { COURSE_FACTS = require('./course-facts.json'); } catch (e) { COURSE_FACTS = {}; }

const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
function dayMonYear(iso) {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(iso || ''));
  return m ? parseInt(m[3], 10) + ' ' + MON[parseInt(m[2], 10) - 1] + ' ' + m[1] : String(iso || '');
}

// ── A. WINDOW — shared by Going and Trip ─────────────────────────────────
// A row with no going string is excluded BEFORE the 8-run cap is applied —
// a useless row should not consume one of the 8 slots. Both counts
// (excludedNoGoing, limitApplied) are returned so this choice is visible.
const SECTION_WINDOW_RUNS = 8;
function sectionWindow(rows, runDate) {
  const withDate = (rows || []).filter(function(r) { return r && r.date; });
  const sorted = withDate.slice().sort(function(a, b) { return String(b.date).localeCompare(String(a.date)); });
  const raceMs = Date.parse(runDate + 'T00:00:00Z');
  const cutoffMs = raceMs - 548 * 86400000; // 18 months
  const withinRange = sorted.filter(function(r) {
    const t = Date.parse(r.date + 'T00:00:00Z');
    return !isNaN(t) && t < raceMs && t >= cutoffMs;
  });
  let excludedNoGoing = 0;
  const withGoing = [];
  withinRange.forEach(function(r) {
    if (!r.going || !String(r.going).trim()) excludedNoGoing++;
    else withGoing.push(r);
  });
  let limitApplied = null, windowRows = withGoing;
  if (withGoing.length > SECTION_WINDOW_RUNS) { windowRows = withGoing.slice(0, SECTION_WINDOW_RUNS); limitApplied = SECTION_WINDOW_RUNS + ' runs'; }
  else if (withGoing.length > 0) limitApplied = '18 months';
  return {
    rows: windowRows,
    size: windowRows.length,
    oldestDate: windowRows.length ? windowRows[windowRows.length - 1].date : null,
    newestDate: windowRows.length ? windowRows[0].date : null,
    limitApplied: limitApplied,
    excludedNoGoing: excludedNoGoing
  };
}

// ── B. THE GOING SCALE ──────────────────────────────────────────────────
const GOING_SCALE = {
  turf: [
    { name: 'Hard', rank: 1 },
    { name: 'Firm', rank: 2 },
    { name: 'Good to Firm', rank: 3 },
    { name: 'Good', rank: 4 },
    { name: 'Good to Yielding', rank: 5 },
    { name: 'Good to Soft', rank: 6 },
    { name: 'Yielding', rank: 6 },
    { name: 'Yielding to Soft', rank: 7 },
    { name: 'Soft', rank: 8 },
    { name: 'Soft to Heavy', rank: 9 },
    { name: 'Heavy', rank: 10 }
  ],
  allweather: [
    { name: 'Fast', rank: 1 },
    { name: 'Standard to Fast', rank: 2 },
    { name: 'Standard', rank: 3 },
    { name: 'Standard to Slow', rank: 4 },
    { name: 'Slow', rank: 5 }
  ]
};

// compactKey() collapses case, spacing, hyphens and abbreviations (gd/std/
// yld/hvy/frm) so "Good To Firm" / "good-to-firm" / "Gd To Firm" all match.
function compactKey(s) {
  let t = String(s || '').toLowerCase();
  t = t.replace(/\bgd\b/g, 'good').replace(/\bstd\b/g, 'standard')
       .replace(/\byld\b/g, 'yielding').replace(/\bhvy\b/g, 'heavy')
       .replace(/\bfrm\b/g, 'firm');
  return t.replace(/[^a-z]/g, '');
}

const SCALE_LOOKUP = {};
GOING_SCALE.turf.forEach(function(g) { SCALE_LOOKUP[compactKey(g.name)] = { name: g.name, rank: g.rank, surface: 'turf' }; });
GOING_SCALE.allweather.forEach(function(g) { SCALE_LOOKUP[compactKey(g.name)] = { name: g.name, rank: g.rank, surface: 'all-weather' }; });

// classifyGoing(): direct match -> canonical name/rank; a slash written for
// "to" ("Standard / Slow") is canonicalised before the compound split;
// compound (comma/slash/paren, first segment matches) -> the FULL raw string
// kept as its own name, ranked by that first segment; neither -> kept as its
// own name, rank 'unranked', never dropped.
function classifyGoing(raw) {
  const trimmed = String(raw || '').trim();
  if (!trimmed) return null;
  const direct = SCALE_LOOKUP[compactKey(trimmed)];
  if (direct) {
    const isAbbrev = compactKey(trimmed) === compactKey(direct.name) && trimmed !== direct.name;
    return { name: direct.name, rank: direct.rank, surface: direct.surface, raw: trimmed, isCompound: false, unranked: false, abbreviationOf: isAbbrev ? trimmed : null };
  }
  const slashAsTo = trimmed.replace(/\s*\/\s*/g, ' to ');
  if (slashAsTo !== trimmed) {
    const viaSlash = SCALE_LOOKUP[compactKey(slashAsTo)];
    if (viaSlash) return { name: viaSlash.name, rank: viaSlash.rank, surface: viaSlash.surface, raw: trimmed, isCompound: false, unranked: false, abbreviationOf: null };
  }
  const parts = trimmed.split(/[,/(]/);
  if (parts.length > 1) {
    const first = parts[0].trim();
    const firstMatch = SCALE_LOOKUP[compactKey(first)];
    if (firstMatch) return { name: trimmed, rank: firstMatch.rank, surface: firstMatch.surface, raw: trimmed, isCompound: true, unranked: false, abbreviationOf: null };
  }
  return { name: trimmed, rank: 'unranked', surface: 'unknown', raw: trimmed, isCompound: false, unranked: true, abbreviationOf: null };
}

// ── C. RESULTS, GROUPS AND STATS ─────────────────────────────────────────
const NON_FINISH_WORDS = { PU: 'pulled up', F: 'fell', UR: 'unseated rider', BD: 'brought down', RO: 'ran out', SU: 'slipped up', DSQ: 'disqualified', RR: 'refused to race' };
function ordinal(n) {
  n = Number(n);
  const r100 = n % 100;
  if (r100 >= 11 && r100 <= 13) return n + 'th';
  switch (n % 10) { case 1: return n + 'st'; case 2: return n + 'nd'; case 3: return n + 'rd'; default: return n + 'th'; }
}
function posWord(pos) {
  const n = posNum(pos);
  if (n !== null) return ordinal(n);
  const code = String(pos || '').trim().toUpperCase();
  if (NON_FINISH_WORDS[code]) return NON_FINISH_WORDS[code];
  return code.toLowerCase() || 'unknown result';
}
// "2nd of 9 at Brighton on 28 Sep 2026" — the prose form every fact line
// uses, so the model can copy it straight into the text. withCourse=false
// for a Track course line, where the course is already the line's subject.
function formatResultProse(r, withCourse) {
  const where = withCourse === false ? '' : ' at ' + stripParens(r.course || '');
  return posWord(r.pos) + ' of ' + (r.ran || '?') + where + ' on ' + dayMonYear(r.date);
}

// "Best" ordering: lowest finishing position wins; a tie goes to the bigger
// field; a further tie goes to the more recent run. Non-finishers are never
// a candidate.
function compareForBest(a, b) {
  const pa = posNum(a.pos), pb = posNum(b.pos);
  if (pa === null && pb === null) return 0;
  if (pa === null) return 1;
  if (pb === null) return -1;
  if (pa !== pb) return pa - pb;
  const ra = parseInt(a.ran, 10) || 0, rb = parseInt(b.ran, 10) || 0;
  if (ra !== rb) return rb - ra;
  return String(b.date).localeCompare(String(a.date));
}
function statsOf(rows) {
  const wins = rows.filter(function(r) { return posNum(r.pos) === 1; }).length;
  const places = rows.filter(function(r) { const p = posNum(r.pos); return p === 2 || p === 3; }).length;
  const bestRow = rows.slice().sort(compareForBest)[0];
  // rows kept newest-first so an unplaced group can print its actual positions.
  const newestFirst = rows.slice().sort(function(a, b) { return String(b.date).localeCompare(String(a.date)); });
  return { runs: rows.length, wins: wins, places: places, topThree: wins + places, bestRow: (bestRow && posNum(bestRow.pos) !== null) ? bestRow : null, rows: newestFirst };
}

// Going groups in scale order: turf (rank asc), all-weather (rank asc),
// unranked (first-seen order).
function goingGroups(windowRows) {
  const byName = {}; const order = [];
  (windowRows || []).forEach(function(r) {
    const c = classifyGoing(r.going);
    if (!c) return;
    if (!byName[c.name]) { byName[c.name] = { name: c.name, rank: c.rank, surface: c.surface, isCompound: c.isCompound, unranked: c.unranked, rows: [] }; order.push(c.name); }
    byName[c.name].rows.push(r);
  });
  const groups = order.map(function(name) {
    const g = byName[name];
    const s = statsOf(g.rows);
    return { name: g.name, rank: g.rank, surface: g.surface, isCompound: g.isCompound, unranked: g.unranked, runs: s.runs, wins: s.wins, places: s.places, topThree: s.topThree, bestRow: s.bestRow, rows: s.rows };
  });
  const turf = groups.filter(function(g) { return g.surface === 'turf'; }).sort(function(a, b) { return a.rank - b.rank; });
  const aw = groups.filter(function(g) { return g.surface === 'all-weather'; }).sort(function(a, b) { return a.rank - b.rank; });
  const unranked = groups.filter(function(g) { return g.unranked; });
  return turf.concat(aw, unranked);
}

// Good to Soft and Yielding (both rank 6) cover each other.
function goingNeverRun(groups) {
  const turfGroups = (groups || []).filter(function(g) { return g.surface === 'turf'; });
  if (!turfGroups.length) return { names: [] };
  const covered = {};
  turfGroups.forEach(function(g) { if (!g.isCompound && !g.unranked) covered[g.rank] = true; });
  return { names: GOING_SCALE.turf.filter(function(g) { return !covered[g.rank]; }).map(function(g) { return g.name; }) };
}
// Only produced when the horse has at least one all-weather run.
function goingNeverRunAW(groups) {
  const awGroups = (groups || []).filter(function(g) { return g.surface === 'all-weather'; });
  if (!awGroups.length) return { names: [] };
  const covered = {};
  awGroups.forEach(function(g) { if (!g.isCompound && !g.unranked) covered[g.rank] = true; });
  return { names: GOING_SCALE.allweather.filter(function(g) { return !covered[g.rank]; }).map(function(g) { return g.name; }) };
}

function sumFigures(arr) {
  return {
    runs: arr.reduce(function(s, g) { return s + g.runs; }, 0),
    wins: arr.reduce(function(s, g) { return s + g.wins; }, 0),
    places: arr.reduce(function(s, g) { return s + g.places; }, 0),
    topThree: arr.reduce(function(s, g) { return s + g.topThree; }, 0)
  };
}

// ── TRIP ───────────────────────────────────────────────────────────────
// Distance — miles*8 + furlongs + ½ for a "½" + yards/220, rounded to the
// nearest whole furlong with exact .5 rounding DOWN. "2m4½f" -> "2m4f";
// "1m1f201y" -> "1m2f"; "7f6y" -> "7f"; "5f7y" -> "5f".
function parseDistanceFurlongs(distStr) {
  const s = String(distStr || '');
  const mi = (s.match(/(\d+)m/) || [])[1];
  const fm = s.match(/(\d+)(½)?f/);
  const y = (s.match(/(\d+)y/) || [])[1];
  if (!mi && !fm && !y) return null;
  const total = (mi ? parseInt(mi, 10) : 0) * 8 + (fm ? parseInt(fm[1], 10) : 0) + (fm && fm[2] ? 0.5 : 0) + (y ? parseInt(y, 10) / 220 : 0);
  return Math.ceil(total - 0.5);
}
function furlongsLabel(totalF) {
  if (totalF === null || totalF === undefined || isNaN(totalF)) return '(distance unknown)';
  const m = Math.floor(totalF / 8), f = totalF % 8;
  if (!m) return f + 'f';
  return m + 'm' + (f ? f + 'f' : '');
}

const TRIP_TYPE_ORDER = ['Flat', 'NH Flat', 'Hurdle', 'Chase'];
function tripTypeOf(row) { return (row && row.type && String(row.type).trim()) || '(type unknown)'; }
function typeRank(type) { const i = TRIP_TYPE_ORDER.indexOf(type); return i === -1 ? TRIP_TYPE_ORDER.length : i; }

// Groups ordered by race type (Flat, NH Flat, Hurdle, Chase, then others
// first-seen), shortest to longest within a type.
function tripGroups(windowRows) {
  const byKey = {}; const order = [];
  (windowRows || []).forEach(function(r) {
    const type = tripTypeOf(r);
    const f = parseDistanceFurlongs(r.dist);
    const label = furlongsLabel(f);
    const key = type + '|' + label;
    if (!byKey[key]) { byKey[key] = { type: type, label: label, furlongs: f, rows: [] }; order.push(key); }
    byKey[key].rows.push(r);
  });
  const groups = order.map(function(key) {
    const g = byKey[key];
    const s = statsOf(g.rows);
    return { name: g.label + ' (' + g.type + ')', type: g.type, distanceLabel: g.label, furlongs: g.furlongs, runs: s.runs, wins: s.wins, places: s.places, topThree: s.topThree, bestRow: s.bestRow, rows: s.rows };
  });
  return groups.sort(function(a, b) {
    const ra = typeRank(a.type), rb = typeRank(b.type);
    if (ra !== rb) return ra - rb;
    if (ra === TRIP_TYPE_ORDER.length && a.type !== b.type) return order.indexOf(a.type + '|' + a.distanceLabel) - order.indexOf(b.type + '|' + b.distanceLabel);
    const fa = a.furlongs === null ? Infinity : a.furlongs, fb = b.furlongs === null ? Infinity : b.furlongs;
    return fa - fb;
  });
}

// One set of four stamina facts per race type present. A field with nothing
// behind it (no wins / no places at any trip) is the string 'none'.
function staminaFacts(groups) {
  const byType = {};
  groups.forEach(function(g) { if (!byType[g.type]) byType[g.type] = []; byType[g.type].push(g); });
  const types = Object.keys(byType).sort(function(a, b) { return typeRank(a) - typeRank(b); });
  return types.map(function(type) {
    const tGroups = byType[type];
    const totals = sumFigures(tGroups);
    const wonGroups = tGroups.filter(function(g) { return g.wins > 0; });
    const placedGroups = tGroups.filter(function(g) { return g.places > 0; });
    const longestOf = function(arr) { return arr.length ? furlongsLabel(Math.max.apply(null, arr.map(function(g) { return g.furlongs === null ? -1 : g.furlongs; }))) : 'none'; };
    const shortestTried = furlongsLabel(Math.min.apply(null, tGroups.map(function(g) { return g.furlongs === null ? Infinity : g.furlongs; })));
    return { type: type, totalRuns: totals.runs, totalWins: totals.wins, totalPlaces: totals.places, longestWon: longestOf(wonGroups), longestPlaced: longestOf(placedGroups), longestTried: longestOf(tGroups), shortestTried: shortestTried };
  });
}

// ── TRACK ──────────────────────────────────────────────────────────────
// Window: last 15 runs, none older than 24 months, wall-clock (not race-day
// relative like sectionWindow). Grouped by course name with a trailing
// " (IRE)" stripped so "Roscommon" and "Roscommon (IRE)" are one course;
// every other suffix, notably (AW), is kept — those are different tracks.
const TRACK_WINDOW_RUNS = 15;
const TRACK_WINDOW_MS = 730 * 86400000;

function trackWindowRows(formHistory) {
  const withCourse = (formHistory || []).filter(function(r) { return r && r.date && r.course; });
  const sorted = withCourse.slice().sort(function(a, b) { return String(b.date).localeCompare(String(a.date)); });
  const nowMs = Date.now();
  const cutoffMs = nowMs - TRACK_WINDOW_MS;
  const withinRange = sorted.filter(function(r) {
    const t = Date.parse(r.date + 'T00:00:00Z');
    return !isNaN(t) && t <= nowMs && t >= cutoffMs;
  });
  return withinRange.slice(0, TRACK_WINDOW_RUNS);
}

// Distinct raw course-name strings in a rows array, plus their stripParens'd
// forms — used only to exempt a banned word that sits inside a course name
// (e.g. "market" in "Market Rasen").
function courseNamesForExemption(rows) {
  const seen = {}; const list = [];
  (rows || []).forEach(function(r) {
    const raw = (r && r.course) || '';
    [raw, stripParens(raw)].forEach(function(c) { if (c && !seen[c]) { seen[c] = true; list.push(c); } });
  });
  return list;
}

function stripIreSuffix(name) { return String(name || '').replace(/\s*\(IRE\)\s*$/i, ''); }
// Courses the results feed names two ways for one track — grouped as one in
// Track, under the full name, with one character line from course-facts.json.
const COURSE_MERGE = { 'Epsom': 'Epsom Downs' };
function normalizeTrackCourse(name) { const s = stripIreSuffix(name); return COURSE_MERGE[s] || s; }

function trackCharacter(fact) {
  if (!fact) return null;
  const parts = [fact.direction, fact.speed];
  if (fact.contour && fact.contour !== 'Flat') parts.push(fact.contour);
  return parts.filter(Boolean).join(', ');
}

function trackGroups(windowRows, courseFacts) {
  const byCourse = {}; const order = [];
  (windowRows || []).forEach(function(r) {
    const normalized = normalizeTrackCourse(r.course);
    if (!byCourse[normalized]) { byCourse[normalized] = { rows: [], rawNames: [] }; order.push(normalized); }
    byCourse[normalized].rows.push(r);
    if (byCourse[normalized].rawNames.indexOf(r.course) === -1) byCourse[normalized].rawNames.push(r.course);
  });
  return order.map(function(course) {
    const entry = byCourse[course];
    const s = statsOf(entry.rows);
    let fact = (courseFacts && courseFacts[course]) || null;
    if (!fact) entry.rawNames.some(function(raw) { const f = courseFacts && courseFacts[raw]; if (f) { fact = f; return true; } return false; });
    return { course: course, runs: s.runs, wins: s.wins, places: s.places, topThree: s.topThree, bestRow: s.bestRow, rows: s.rows, fact: fact, character: trackCharacter(fact) };
  });
}

// Rollups by direction and speed, each only from courses with a known
// character. A merged "A / B" facet value credits every named value.
// "Both directions" matches no direction bucket.
const TRACK_DIRECTION_BUCKETS = ['Left-handed', 'Right-handed', 'Straight', 'Figure-of-eight'];
const TRACK_SPEED_BUCKETS = ['Tight', 'Galloping'];
function splitFacetValues(v) { return String(v || '').split('/').map(function(s) { return s.trim(); }).filter(Boolean); }
function trackRollups(groups) {
  const mk = function(names) { const o = {}; names.forEach(function(n) { o[n] = { runs: 0, wins: 0, places: 0, topThree: 0 }; }); return o; };
  const direction = mk(TRACK_DIRECTION_BUCKETS), speed = mk(TRACK_SPEED_BUCKETS);
  const add = function(b, g) { b.runs += g.runs; b.wins += g.wins; b.places += g.places; b.topThree += g.topThree; };
  (groups || []).forEach(function(g) {
    if (!g.fact) return;
    splitFacetValues(g.fact.direction).forEach(function(v) { if (direction[v]) add(direction[v], g); });
    splitFacetValues(g.fact.speed).forEach(function(v) { if (speed[v]) add(speed[v], g); });
  });
  return { direction: direction, speed: speed };
}

// ── D. FACT ASSEMBLERS ──────────────────────────────────────────────────
// Every decision the text may reflect is made here, in code:
//  • LEAD — the first group line is the lead: most runs, then most top-three
//    finishes, then most wins (then scale rank / shortest trip / name).
//  • THIN — "Too few runs to show a pattern" when the section has fewer than
//    3 runs, or no group has 2 or more runs (Track: and no rollup bucket has
//    3 or more). No comparison is offered for a thin section.
//  • CLEAR SPLIT — the only comparison the text may draw. A beats B only
//    when both have 2+ runs, A's top-three strike rate is at least 25
//    percentage points higher, A has at least as many wins, and A has more
//    top-three finishes. (36% against 33% is not a split; 75% against 0% is.) Going compares the two biggest groups on the lead
//    group's own surface (never turf against all-weather); Trip compares the
//    two biggest groups within the lead race type; Track compares tight v
//    galloping and left- v right-handed.
//  • BEST — every group with a top-three finish gives its best result, a
//    single-run place included, so no section ever has to borrow a result
//    (or a course name) from another section's facts. Unplaced groups give
//    their actual positions instead.
//  • NONE — a stamina field with nothing behind it prints as NONE with its
//    meaning spelled out, never as a bare word.
function plural(n, word) { return n + ' ' + word + (n === 1 ? '' : 's'); }
function countClause(g) { return plural(g.runs, 'run') + ', ' + plural(g.wins, 'win') + ', ' + plural(g.places, 'place'); }
// "9th of 14" for a finisher, "pulled up" for a non-finisher — no course or
// date, so an unplaced run adds only its own two numbers to the fact list.
function posClause(r) { const n = posNum(r.pos); return n !== null ? ordinal(n) + ' of ' + (r.ran || '?') : posWord(r.pos); }
// Unplaced groups print where the horse actually finished: 1-2 runs list
// every position, 3+ runs give the best actual position. Every group with a
// top-three finish gives its best result, in all three sections.
function groupLine(label, g, bestText) {
  if (g.topThree === 0) {
    if (g.runs <= 2) return '- ' + label + ': ' + plural(g.runs, 'run') + ', ' + (g.rows || []).map(posClause).join(' and ') + '.';
    return '- ' + label + ': ' + plural(g.runs, 'run') + ', no top-three finish' + (g.bestRow ? '; best ' + posClause(g.bestRow) : '') + '.';
  }
  let line = '- ' + label + ': ' + countClause(g);
  if (bestText) line += '; best ' + bestText;
  return line + '.';
}
function leadCompare(tiebreak) {
  return function(a, b) {
    if (a.runs !== b.runs) return b.runs - a.runs;
    if (a.topThree !== b.topThree) return b.topThree - a.topThree;
    if (a.wins !== b.wins) return b.wins - a.wins;
    return tiebreak ? tiebreak(a, b) : 0;
  };
}
function rate(g) { return g.runs ? g.topThree / g.runs : 0; }
const SPLIT_MARGIN = 0.25; // strike-rate gap, in percentage points, that makes a split "clear"
// Both sides need 3 runs and the stronger side 3 top-three finishes before a
// split is "clear" — 2 from 3 against 0 from 3 is noise, not a pattern.
const SPLIT_MIN_RUNS = 3;
const SPLIT_MIN_TOP_THREE = 3;
function clearlyBeats(a, b) {
  if (!a || !b || a.runs < SPLIT_MIN_RUNS || b.runs < SPLIT_MIN_RUNS) return false;
  if (a.topThree < SPLIT_MIN_TOP_THREE) return false;
  if (!(rate(a) - rate(b) >= SPLIT_MARGIN)) return false;
  if (a.wins < b.wins) return false;
  return a.topThree > b.topThree;
}
function isThin(groups, total, rollupBuckets) {
  if (total < 3) return true;
  if (groups.some(function(g) { return g.runs >= 2; })) return false;
  if (rollupBuckets && rollupBuckets.some(function(b) { return b.runs >= 3; })) return false;
  return true;
}
const THIN_LINE = '- Too few runs to show a pattern.';
function splitLine(a, labelA, b, labelB) {
  return '- Clear split: ' + a.topThree + ' in the top three from ' + plural(a.runs, 'run') + ' on ' + labelA + ' against ' + b.topThree + ' from ' + b.runs + ' on ' + labelB + '.';
}
function splitFor(a, labelA, b, labelB) {
  if (clearlyBeats(a, b)) return splitLine(a, labelA, b, labelB);
  if (clearlyBeats(b, a)) return splitLine(b, labelB, a, labelA);
  return null;
}

// buildGoingFacts(groups, neverRun, neverRunAW, windowSize) -> string[]
function buildGoingFacts(groups, neverRun, neverRunAW, windowSize) {
  const lines = [];
  const ordered = groups.slice().sort(leadCompare(function(a, b) { return (a.rank === 'unranked' ? 99 : a.rank) - (b.rank === 'unranked' ? 99 : b.rank); }));
  ordered.forEach(function(g) { lines.push(groupLine(g.name, g, g.bestRow ? formatResultProse(g.bestRow) : null)); });
  const turf = groups.filter(function(g) { return g.surface === 'turf'; });
  const aw = groups.filter(function(g) { return g.surface === 'all-weather'; });
  if (turf.length && aw.length) {
    lines.push('- Turf: ' + countClause(sumFigures(turf)) + '.');
    lines.push('- All-weather: ' + countClause(sumFigures(aw)) + '.');
  }
  const all = sumFigures(groups); all.runs = typeof windowSize === 'number' ? windowSize : all.runs;
  lines.push('- Window: last ' + plural(Math.min(SECTION_WINDOW_RUNS, all.runs), 'run') + ' — ' + countClause(all) + '.');
  if (neverRun && neverRun.names && neverRun.names.length) lines.push('- Never run on (turf): ' + neverRun.names.join(', ') + '.');
  if (neverRunAW && neverRunAW.names && neverRunAW.names.length) lines.push('- Never run on (all-weather): ' + neverRunAW.names.join(', ') + '.');
  if (isThin(groups, all.runs)) { lines.push(THIN_LINE); return lines; }
  const lead = ordered[0];
  const sameSurface = ordered.filter(function(g) { return g.surface === lead.surface; });
  if (sameSurface.length >= 2) {
    const s = splitFor(sameSurface[0], sameSurface[0].name, sameSurface[1], sameSurface[1].name);
    if (s) lines.push(s);
  }
  return lines;
}

// buildTripFacts(groups, windowSize) -> string[] — windowSize is the shared
// Going/Trip window's row count, so both Window lines quote the same number.
function buildTripFacts(groups, windowSize) {
  const lines = [];
  const ordered = groups.slice().sort(leadCompare(function(a, b) {
    const ra = typeRank(a.type), rb = typeRank(b.type);
    if (ra !== rb) return ra - rb;
    return (a.furlongs === null ? Infinity : a.furlongs) - (b.furlongs === null ? Infinity : b.furlongs);
  }));
  ordered.forEach(function(g) { lines.push(groupLine(g.name, g, g.bestRow ? formatResultProse(g.bestRow) : null)); });
  const facts = staminaFacts(groups);
  facts.forEach(function(f) {
    lines.push('- ' + f.type + ' total: ' + countClause({ runs: f.totalRuns, wins: f.totalWins, places: f.totalPlaces }) + '.');
    const won = f.longestWon === 'none' ? 'NONE (no wins at any trip)' : f.longestWon;
    const placed = f.longestPlaced === 'none' ? 'NONE (no places at any trip)' : f.longestPlaced;
    lines.push('- ' + f.type + ' stamina: longest won ' + won + '; longest placed ' + placed + '; longest tried ' + f.longestTried + '; shortest tried ' + f.shortestTried + '.');
  });
  const all = sumFigures(groups); all.runs = typeof windowSize === 'number' ? windowSize : all.runs;
  const total = all.runs;
  lines.push('- Window: last ' + plural(Math.min(SECTION_WINDOW_RUNS, total), 'run') + ' — ' + countClause(all) + '.');
  if (isThin(groups, total)) { lines.push(THIN_LINE); return lines; }
  const lead = ordered[0];
  const sameType = ordered.filter(function(g) { return g.type === lead.type; });
  if (sameType.length >= 2) {
    const s = splitFor(sameType[0], sameType[0].name, sameType[1], sameType[1].name);
    if (s) lines.push(s);
  }
  return lines;
}

// buildTrackFacts(groups, rollups, windowSize) -> string[]
function buildTrackFacts(groups, rollups, windowSize) {
  const lines = [];
  const ordered = groups.slice().sort(leadCompare(function(a, b) { return a.course.localeCompare(b.course); }));
  ordered.forEach(function(g) {
    const label = g.course + ' (' + (g.character || 'course character unknown') + ')';
    lines.push(groupLine(label, g, g.bestRow ? formatResultProse(g.bestRow, false) : null));
  });
  const buckets = [];
  TRACK_DIRECTION_BUCKETS.concat(TRACK_SPEED_BUCKETS).forEach(function(name) {
    const b = rollups.direction[name] || rollups.speed[name];
    if (b && b.runs > 0) { buckets.push(b); lines.push('- ' + name + ' courses: ' + countClause(b) + '.'); }
  });
  lines.push('- Window: last ' + plural(Math.min(TRACK_WINDOW_RUNS, windowSize), 'run') + ' — ' + plural(windowSize, 'run') + ' in total.');
  if (isThin(groups, windowSize, buckets)) { lines.push(THIN_LINE); return lines; }
  const sp = splitFor(rollups.speed['Tight'], 'tight courses', rollups.speed['Galloping'], 'galloping courses');
  if (sp) lines.push(sp);
  const di = splitFor(rollups.direction['Left-handed'], 'left-handed courses', rollups.direction['Right-handed'], 'right-handed courses');
  if (di) lines.push(di);
  return lines;
}

// The user message: horse header (name and sex only — no age, so the model
// has a pronoun but no number that isn't a fact) and the three fact lists.
// trackFacts === null means the Track window is empty: the runner stores the
// template for that section and ignores whatever the model writes for it.
function buildFactsEnvelope(horse, goingFacts, tripFacts, trackFacts) {
  const lines = ['HORSE: ' + (horse && horse.name || 'Unknown') + ' (' + (horse && horse.sex || 'sex unknown') + ').', ''];
  lines.push('GOING FACTS:'); lines.push(goingFacts.join('\n')); lines.push('');
  lines.push('TRIP FACTS:'); lines.push(tripFacts.join('\n')); lines.push('');
  lines.push('TRACK FACTS:');
  lines.push(trackFacts ? trackFacts.join('\n') : '- No runs in the track window; write exactly: No track record to assess in the recent window.');
  return lines.join('\n');
}

// ── E. EMPTY WINDOW ──────────────────────────────────────────────────────
const NO_RUNS_TEMPLATE = 'No runs in the last 18 months, so no going record to assess.';
const NO_RUNS_TRIP_TEMPLATE = 'No runs in the last 18 months, so no trip record to assess.';
const NO_RUNS_TRACK_TEMPLATE = 'No track record to assess in the recent window.';

// ── F. THE WRITER PROMPT — byte-identical on every call, cached ─────────
// Over the ~1,024-token caching floor (see the runner's cache_control). The
// three worked examples are not padding: a phrasing contract is learned far
// better from one fact list and its matching text than from rules alone.
const FACT_CONTRACT =
"You write three short sections of a racehorse's form summary for a racing website: GOING, TRIP and TRACK. Every fact you may use is listed for you under that section's heading. The code has already done all the counting, comparing and ranking; your job is only to phrase those facts well.\n\n" +
"THE CONTRACT\n" +
"Write each section as 2-4 flowing sentences using ONLY the facts listed for it. Every number, name and date must be copied from a fact line. Do not add, combine, rank or compute anything not stated. You may reorder and connect facts for readability; you may drop a minor fact to fit the length; you may not introduce one. Never state how many courses, distances, goings or groups appear in the facts — no '7 courses tried', no '5 distances', no 'across 4 going types'. Those counts are not facts in the list; describe the groups themselves instead.\n" +
"LENGTH: GOING and TRIP: 65 words maximum. TRACK: 85 words maximum. Keep within these limits by cutting connective detail — a course character can be a few words. Never cut numbers or results to fit. A section that runs over is rejected and rewritten.\n" +
"The fact lines are listed with the leading group first — open with it. A 'Clear split' line is the only comparison you may draw; where there is none, draw none. A 'Too few runs to show a pattern' line means the honest read is that there is no pattern: say so plainly in a sentence and stop. Where a stamina fact says NONE, say the horse has not won (or not placed) at any trip in the last N runs; never give that field a distance. A 'Never run on' line may be mentioned only if it matters to the read.\n" +
"THE WINDOW: each section's Window line names the runs it covers — 'last 8 runs' for GOING and TRIP, 'last 15 runs' for TRACK (fewer when the horse has fewer). Wherever you refer to the period, write 'in the last 8 runs' or 'in the last 15 runs', copying the number from that section's own Window line. Never write 'in this window', 'in the window', 'recently' or 'of late'. GOING and TRIP cover fewer runs than TRACK, so a win can appear in TRACK and not in GOING; that is correct — never reconcile or mention the other sections.";

const VOICE_RULES =
"VOICE\n" +
"Plain punter language, no hedging, no stock openers; every horse should sound different. Lead with what the record says, then back it with the result the fact line gives you. Write positions exactly as given ('2nd of 9'), every number as digits, dates as given. Say 'in the top three', never 'top 3'. A place is a 2nd or 3rd; a win is not a place.\n" +
"Never refer to today, any future race, or what the horse will, should or might do. Never give a reason for a run (no injury, pace, draw, fitness, 'too sharp', 'didn't stay'). No jockeys, trainers, owners, race class or prize money. No betting words (backed, value, each-way, price, odds, market, favourite). Never describe the horse's career, 'so far', 'to date' or 'ever' — these facts cover recent runs only. Never call anything the worst, weakest or poorest. Plain prose: no headings, bullets or quotation marks.";

const GOING_NOTES =
"GOING\n" +
"How the horse has run on different ground. Name each going exactly as its fact line spells it, letter for letter.";

const TRIP_NOTES =
"TRIP\n" +
"What distance the horse's record favours and how far it is proven. Write every distance exactly as its fact line spells it (2m4f, 1m2f, 7f), never in words. Distances are grouped by race type (Flat, NH Flat, Hurdle, Chase) and never compared across types. The only longest/shortest claims you may make are the stamina line's own four facts, each kept with its own value.";

const TRACK_NOTES =
"TRACK\n" +
"The horse's record read through the character of the courses it has run at. Each course line gives its character in brackets; turn that into plain punter language — 'a big, galloping track where horses can stride out', 'a tight, turning course that keeps asking questions', 'a stiff uphill finish that sorts out stayers' — never a bare label like 'left-handed galloping track'. A course marked (course character unknown) gets its figures only.";

const EXAMPLES =
"EXAMPLES\n" +
"GOING facts:\n- Good to Firm: 5 runs, 0 wins, 3 places; best 2nd of 9 at Brighton on 28 Sep 2026.\n- Good: 1 run, 0 wins, 1 place; best 3rd of 7 at Bath on 2 May 2026.\n- Firm: 1 run, 9th of 14.\n- Window: last 7 runs — 7 runs, 0 wins, 4 places.\n" +
"GOING text: Good to Firm is where the record sits, with 3 places from 5 runs and the pick of them a 2nd of 9 at Brighton on 28 Sep 2026. The 1 run on Good also brought a place, a 3rd of 7 at Bath on 2 May 2026, while the single outing on Firm ended 9th of 14.\n\n" +
"TRIP facts:\n- 2m (Hurdle): 3 runs, 0 wins, 1 place; best 3rd of 8 at Wexford on 17 Mar 2026.\n- 2m4f (Hurdle): 2 runs, 7th of 10 and 11th of 12.\n- Hurdle total: 5 runs, 0 wins, 1 place.\n- Hurdle stamina: longest won NONE (no wins at any trip); longest placed 2m; longest tried 2m4f; shortest tried 2m.\n- Window: last 5 runs — 5 runs, 0 wins, 1 place.\n" +
"TRIP text: The only place over hurdles came at 2m, a 3rd of 8 at Wexford on 17 Mar 2026, from 3 runs at the trip. Stepped up to 2m4f the horse finished 7th of 10 and 11th of 12, and it has not won at any trip in the last 5 runs.\n\n" +
"TRACK facts:\n- Wolverhampton (AW) (Left-handed, Tight): 4 runs, 1 win, 2 places; best 1st of 9 on 2 Feb 2026.\n- Doncaster (Left-handed, Galloping): 3 runs, no top-three finish; best 6th of 12.\n- Left-handed courses: 7 runs, 1 win, 2 places.\n- Tight courses: 4 runs, 1 win, 2 places.\n- Galloping courses: 3 runs, 0 wins, 0 places.\n- Window: last 7 runs — 7 runs in total.\n- Clear split: 3 in the top three from 4 runs on tight courses against 0 from 3 on galloping courses.\n" +
"TRACK text: Wolverhampton's tight, turning circuit has suited this horse best: 1 win and 2 places from 4 runs, the win a 1st of 9 on 2 Feb 2026. Doncaster's big, galloping track brought nothing better than a 6th of 12 from 3 runs — a clear split of 3 in the top three from 4 runs on tight courses against 0 from 3 on galloping ones in the last 7 runs.\n\n" +
"GOING facts (with a split):\n- Soft: 4 runs, 2 wins, 1 place; best 1st of 11 at Haydock on 14 Feb 2026.\n- Good: 3 runs, no top-three finish; best 5th of 9.\n- Window: last 7 runs — 7 runs, 2 wins, 1 place.\n- Never run on (turf): Hard, Firm, Good to Firm, Good to Yielding, Good to Soft, Yielding, Yielding to Soft, Soft to Heavy, Heavy.\n- Clear split: 3 in the top three from 4 runs on Soft against 0 from 3 on Good.\n" +
"GOING text: Soft ground is where this horse has done its winning in the last 7 runs, 2 wins and a place from 4 runs, the best of them a 1st of 11 at Haydock on 14 Feb 2026. On Good the story is different: 3 runs without a top-three finish and nothing better than a 5th of 9, a clear split against the Soft record.\n\n" +
"TRIP facts (thin record):\n- 1m2f (Flat): 1 run, 7th of 11.\n- 1m4f (Flat): 1 run, 0 wins, 1 place; best 2nd of 10 at Newbury on 3 Jul 2026.\n- Flat total: 2 runs, 0 wins, 1 place.\n- Flat stamina: longest won NONE (no wins at any trip); longest placed 1m4f; longest tried 1m4f; shortest tried 1m2f.\n- Window: last 2 runs — 2 runs, 0 wins, 1 place.\n- Too few runs to show a pattern.\n" +
"TRIP text: Only 2 runs to go on, a 7th of 11 at 1m2f and a 2nd of 10 at Newbury on 3 Jul 2026 at 1m4f, so there is no trip pattern to read yet. The horse has not won at any trip in the last 2 runs.";

const OUTPUT_LINE = "OUTPUT: strict JSON only: {\"going\": \"...\", \"trip\": \"...\", \"track\": \"...\"}. Your reply must begin with { and end with } — the JSON object and nothing else. No reasoning, no planning, no word counts, no notes, no commentary before or after it. Do not write anything that is not one of the three section texts.";

const GOINGTRIP_PROMPT = FACT_CONTRACT + "\n\n" + VOICE_RULES + "\n\n" + GOING_NOTES + "\n\n" + TRIP_NOTES + "\n\n" + TRACK_NOTES + "\n\n" + EXAMPLES + "\n\n" + OUTPUT_LINE;
const GOINGTRIP_MAX_TOKENS = 1600;

// ── G. VALIDATOR ──────────────────────────────────────────────────────────
// Kept: JSON validity, banned (betting) words, today/future words, banned
// format, career-claim phrases, and one structural check — every number
// token in the output must appear in that section's fact list (pure string
// membership on digit runs, no parsing). Everything the old validators
// inferred from the data (counts, positions, goings, distances, courses,
// comparisons) is now impossible by construction: the model has nothing to
// copy from but the fact lines. Word caps are warnings, never failures.
function words(s) { const t = String(s || '').trim(); return t ? t.split(/\s+/).length : 0; }
const BETTING_WORDS = ['backed', 'value', 'each-way', 'each way', 'price', 'odds', 'market', 'favourite'];
const FUTURE_WORDS = ['today', 'this afternoon', 'tomorrow', 'next time', 'should', 'ought', 'will suit', 'will appreciate', 'looks ideal', 'expect', 'going forward', 'will stay', "won't stay", 'likely to stay', 'unlikely to stay', 'will get', "won't get"];
const CAREER_PHRASES = ['career', 'so far', 'to date', 'has ever', 'never ever', 'lifetime'];
const REASON_PHRASES = ['too sharp', "didn't stay", 'did not stay', 'outpaced', 'found it too far', 'found it too short'];

function parseJsonSections(text) {
  let t = String(text || '').trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
  const a = t.indexOf('{'), b = t.lastIndexOf('}');
  if (a > 0 || (b >= 0 && b < t.length - 1)) t = t.slice(a, b + 1);
  try { return JSON.parse(t); } catch (e) { return null; }
}

// Every fail embeds the sentence it judged, so a probe can classify failures
// without the surrounding claim being invisible.
function sentenceOffsets(t) {
  const parts = String(t || '').split(/(?<=[.!?])\s+/).filter(function(s) { return s; });
  let pos = 0;
  return parts.map(function(s) {
    const idx = t.indexOf(s, pos);
    const start = idx === -1 ? pos : idx;
    pos = start + s.length;
    return { text: s, start: start, end: start + s.length };
  });
}
function sentenceAt(offsets, idx) {
  for (let i = 0; i < offsets.length; i++) {
    if (idx >= offsets[i].start && idx < offsets[i].end) return offsets[i].text.trim();
  }
  return offsets.length ? offsets[offsets.length - 1].text.trim() : '';
}
function numberTokens(s) { return String(s || '').match(/\d+/g) || []; }
function phraseRegex(phrase) { return new RegExp('\\b' + phrase.replace(/'/g, "['’]?").replace(/[- ]/g, '[- ]') + '\\b', 'i'); }

// Cross-section name leak check. Every course name and every going name in
// a section's text must appear in THAT section's fact list — the same
// string-membership idea as the number check, applied to names.
// Course list: every key in course-facts.json plus its suffix-stripped form
// (plus the horse's own history courses, passed by the runner). Matching is
// word-boundary and longest-name-first with consumption, so "Lingfield (AW)"
// in a text is one token and never a false match for bare "Lingfield"; and
// case-sensitive, so the English "yielding" never matches the going
// "Yielding". A bare course token in the text is allowed against a suffixed
// fact ("Wolverhampton" for "Wolverhampton (AW)") — the texts drop the
// suffix routinely — but never the reverse.
function escapeRe(s) { return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }
function nameTokens(text, names) {
  let t = String(text || ''); const found = [];
  names.forEach(function(n) {
    const re = new RegExp('(?<![A-Za-z])' + escapeRe(n) + '(?![A-Za-z])', 'g'); let m;
    while ((m = re.exec(t)) !== null) {
      found.push({ name: n, index: m.index });
      t = t.slice(0, m.index) + ' '.repeat(m[0].length) + t.slice(m.index + m[0].length); // consume
    }
  });
  return found;
}
function longestFirst(list) { return list.slice().sort(function(a, b) { return b.length - a.length || a.localeCompare(b); }); }
const COURSE_NAME_LIST = longestFirst(Object.keys(COURSE_FACTS).reduce(function(acc, k) {
  if (k && acc.indexOf(k) === -1) acc.push(k);
  const bare = stripParens(k); if (bare && acc.indexOf(bare) === -1) acc.push(bare);
  return acc;
}, []));
const GOING_NAME_LIST = longestFirst(GOING_SCALE.turf.concat(GOING_SCALE.allweather).map(function(g) { return g.name; }));
// A shortened course name in a text passes against the full name in the
// facts: "Epsom" for "Epsom Downs", "Chelmsford" for "Chelmsford City (AW)"
// (compared suffix-stripped, so the alias target is the bare name).
const COURSE_ALIASES = { 'Epsom': 'Epsom Downs', 'Epsom Downs': 'Epsom', 'Chelmsford': 'Chelmsford City' };

// validateSection(section, text, factLines, opts) — text is the section's
// own string (already parsed out of the JSON). opts.courseNames and
// opts.horseName exempt a banned word that sits inside a course name or the
// horse's own name ("Beat The Odds"); opts.wordCap sets the warning cap.
function validateSection(section, text, factLines, opts) {
  const failures = []; const warnings = [];
  const t = String(text || '');
  const offsets = sentenceOffsets(t);
  const fail = function(check, detail, idx) {
    failures.push({ check: check, detail: detail + (idx !== undefined && idx !== null ? ' | sentence: "' + sentenceAt(offsets, idx) + '"' : '') });
  };
  if (!t.trim()) { fail('json', 'missing or empty "' + section + '" field'); return { ok: false, failures: failures, warnings: warnings, wordCount: 0, text: null }; }
  const wc = words(t);
  // Word cap is a warning only, at every length — the model does not shorten
  // reliably on instruction (the 2026-10-06 v3 run lost 79 sections trying).
  const cap = (opts && opts.wordCap) || 65;
  if (wc > cap) warnings.push({ section: section, words: wc, cap: cap, over: wc - cap });

  // number-not-in-facts — the one structural check.
  const allowed = {};
  numberTokens((factLines || []).join('\n')).forEach(function(n) { allowed[n] = true; });
  const reNum = /\d+/g; let m;
  while ((m = reNum.exec(t)) !== null) { if (!allowed[m[0]]) fail('number-not-in-facts', m[0], m.index); }

  // Exemption spans: the horse's course names and its own name.
  const spans = [];
  const exemptNames = ((opts && opts.courseNames) || []).concat(opts && opts.horseName ? [opts.horseName] : []);
  exemptNames.forEach(function(c) {
    if (!c) return;
    const re = new RegExp(escapeRe(c), 'gi'); let cm;
    while ((cm = re.exec(t)) !== null) spans.push([cm.index, cm.index + cm[0].length]);
  });
  const insideExempt = function(idx, len) { return spans.some(function(sp) { return idx >= sp[0] && idx + len <= sp[1]; }); };

  // course-not-in-facts / going-not-in-facts — name membership. The horse's
  // own name is blanked first so a horse called after a course or a going
  // is not read as one.
  let tNames = t;
  if (opts && opts.horseName) { const hre = new RegExp(escapeRe(opts.horseName), 'g'); tNames = tNames.replace(hre, function(mm) { return ' '.repeat(mm.length); }); }
  const factsText = (factLines || []).join('\n');
  const courseList = longestFirst(COURSE_NAME_LIST.concat(((opts && opts.courseNames) || []).filter(function(c) { return c && COURSE_NAME_LIST.indexOf(c) === -1; })));
  const factCourses = nameTokens(factsText, courseList).map(function(x) { return x.name; });
  // COURSE_ALIASES: course-facts.json carries both "Epsom" and "Epsom Downs"
  // for the one track, and the texts shorten the latter routinely.
  const courseOk = function(name) { const alias = COURSE_ALIASES[name]; return factCourses.some(function(fc) { return fc === name || stripParens(fc) === name || (alias && (fc === alias || stripParens(fc) === alias)); }); };
  nameTokens(tNames, courseList).forEach(function(x) { if (!courseOk(x.name)) fail('course-not-in-facts', x.name, x.index); });
  const factGoings = nameTokens(factsText, GOING_NAME_LIST).map(function(x) { return x.name; });
  nameTokens(tNames, GOING_NAME_LIST).forEach(function(x) { if (factGoings.indexOf(x.name) === -1) fail('going-not-in-facts', x.name, x.index); });

  // banned (betting) words — exempt inside a course name or the horse's name.
  BETTING_WORDS.forEach(function(w) {
    const re = new RegExp(phraseRegex(w).source, 'gi'); let wm;
    while ((wm = re.exec(t)) !== null) { if (!insideExempt(wm.index, wm[0].length)) { fail('banned-words', w, wm.index); break; } }
  });

  // today / future words
  FUTURE_WORDS.forEach(function(w) { const i = t.search(phraseRegex(w)); if (i !== -1) fail('future-words', w, i); });

  // career-claim phrases
  CAREER_PHRASES.forEach(function(p) { const i = t.search(phraseRegex(p)); if (i !== -1) fail('career-claim', p, i); });

  // reasons for a run
  REASON_PHRASES.forEach(function(p) { const i = t.search(phraseRegex(p)); if (i !== -1) fail('reason-given', p, i); });

  // banned-format: N/M shorthand, malformed positions, worst/weakest/poorest,
  // an ordinal word used as a position, percentages.
  const reSlash = /\b\d+\/\d+\b/g;
  while ((m = reSlash.exec(t)) !== null) fail('banned-format', m[0] + ' (N/M position)', m.index);
  // "finished 3" / "won of 9" read as malformed positions; "finish in 3 runs"
  // is a run count and is not a position — a following count noun exempts it.
  const reBadPosition = /\b(wins?|won|place[sd]?|finish(?:ed)?|pulled up|fell|unseated(?: rider)?|brought down|ran out|slipped up|refused(?: to race)?)\s+(?:of|in)\s+\d+\b(?!\s+(?:runs?|starts?|outings?|attempts?|tries|races?|visits?|goes|appearances?|efforts?|spins?)\b)/gi;
  while ((m = reBadPosition.exec(t)) !== null) fail('banned-format', m[0] + ' (not a valid position — use "Nth of M")', m.index);
  // "finished 3" — a bare number as a position with no "of M" ("3rd" is not
  // matched: the word boundary after the digits fails on "rd").
  const reBarePosition = /\b(finished|finishing|came|placed|ended)\s+\d+\b(?!\s+(?:of|runs?|starts?|outings?|attempts?|tries|races?|visits?|times?|lengths?|wins?|places?|from)\b)/gi;
  while ((m = reBarePosition.exec(t)) !== null) fail('banned-format', m[0] + ' (bare number as position — use "Nth of M")', m.index);
  ['worst', 'weakest', 'poorest'].forEach(function(w) { const i = t.search(phraseRegex(w)); if (i !== -1) fail('banned-format', w, i); });
  // Ordinal words count only after a finishing verb ("came second", "finished
  // third"); "a second clear split" / "a first win" are ordinary adjectives.
  const reOrdinalPosition = /\b(?:finished|finishing|was|came|coming|ran|running|placed|ended|ending)\s+(first|second|third|fourth)\b(?!\s+(?:runs?|starts?|times?|attempts?|outings?|tries?|of|clear|win|wins|place|places|split|spell|visit|season|time)\b)/gi;
  while ((m = reOrdinalPosition.exec(t)) !== null) fail('banned-format', m[0] + ' (ordinal word as position)', m.index);
  const pct = t.search(/%|per\s*cent|percent/i);
  if (pct !== -1) fail('banned-format', 'percentage language', pct);

  return { ok: failures.length === 0, failures: failures, warnings: warnings, wordCount: wc, text: t };
}

module.exports = {
  // data layer
  GOING_SCALE: GOING_SCALE,
  sectionWindow: sectionWindow,
  classifyGoing: classifyGoing,
  compactKey: compactKey,
  goingGroups: goingGroups,
  goingNeverRun: goingNeverRun,
  goingNeverRunAW: goingNeverRunAW,
  sumFigures: sumFigures,
  parseDistanceFurlongs: parseDistanceFurlongs,
  furlongsLabel: furlongsLabel,
  tripGroups: tripGroups,
  staminaFacts: staminaFacts,
  COURSE_FACTS: COURSE_FACTS,
  trackWindowRows: trackWindowRows,
  courseNamesForExemption: courseNamesForExemption,
  stripIreSuffix: stripIreSuffix,
  trackGroups: trackGroups,
  trackRollups: trackRollups,
  // fact assemblers
  buildGoingFacts: buildGoingFacts,
  buildTripFacts: buildTripFacts,
  buildTrackFacts: buildTrackFacts,
  buildFactsEnvelope: buildFactsEnvelope,
  clearlyBeats: clearlyBeats,
  isThin: isThin,
  // templates
  NO_RUNS_TEMPLATE: NO_RUNS_TEMPLATE,
  NO_RUNS_TRIP_TEMPLATE: NO_RUNS_TRIP_TEMPLATE,
  NO_RUNS_TRACK_TEMPLATE: NO_RUNS_TRACK_TEMPLATE,
  // prompt
  GOINGTRIP_PROMPT: GOINGTRIP_PROMPT,
  GOINGTRIP_MAX_TOKENS: GOINGTRIP_MAX_TOKENS,
  // validator
  parseJsonSections: parseJsonSections,
  validateSection: validateSection,
  numberTokens: numberTokens,
  nameTokens: nameTokens,
  COURSE_NAME_LIST: COURSE_NAME_LIST,
  GOING_NAME_LIST: GOING_NAME_LIST,
  words: words
};
