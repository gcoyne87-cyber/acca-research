// going-section.js — the GOING section of the per-horse text engine, built and
// trialled standalone. NOT wired into text-engine-submit/collect-background.js
// or any schedule; nothing here is read by the live engine. Trip, Track and
// Recent Form are separate modules, built later.
//
// Reused from text-engine-submit-background.js (via its module.exports.helpers,
// which is already an intentional public surface of that file — nothing there
// was changed): posNum (finishing position as a number or null) and
// stripParens (drops a "(...)" suffix from a course name, e.g. "(AW)"/"(IRE)").
// NOT reused: primaryGoing() — it strips a going string down to its first
// term (split on comma/paren only, not slash) for the daily-build tags, which
// is the opposite of what this module needs (compound goings like
// "Standard / Slow" must survive intact as their own going name). dayMonYear()
// is a two-line date formatter that isn't exported from that file; reimplemented
// here (MON below) rather than adding an export to a file this task must not
// touch the behaviour of.
const engineHelpers = require('../text-engine-submit-background.js').helpers;
const posNum = engineHelpers.posNum;
const stripParens = engineHelpers.stripParens;

const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
function dayMonYear(iso) {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(iso || ''));
  return m ? parseInt(m[3], 10) + ' ' + MON[parseInt(m[2], 10) - 1] + ' ' + m[1] : String(iso || '');
}

// ── B. THE GOING SCALE ──────────────────────────────────────────────────────
// Region tags in the brief ("(IRE)", "(GB)") label the naming convention only —
// the Racing API's own `going` field on a results row never carries a region
// suffix (only course names do), so the canonical names stored here are bare.
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

// compactKey() collapses case, spacing, hyphens and known abbreviations to one
// key so "Good To Firm" / "good-to-firm" / "Gd To Firm" all resolve alike.
// Abbreviation forms handled (whole-word only, so "goodtofirm" is untouched):
// gd->good, std->standard, yld->yielding, hvy->heavy, frm->firm.
function compactKey(s) {
  let t = String(s || '').toLowerCase();
  t = t.replace(/\bgd\b/g, 'good').replace(/\bstd\b/g, 'standard')
       .replace(/\byld\b/g, 'yielding').replace(/\bhvy\b/g, 'heavy')
       .replace(/\bfrm\b/g, 'firm');
  return t.replace(/[^a-z]/g, '');
}

const SCALE_LOOKUP = {}; // compactKey -> { name, rank, surface }
GOING_SCALE.turf.forEach(function(g) { SCALE_LOOKUP[compactKey(g.name)] = { name: g.name, rank: g.rank, surface: 'turf' }; });
GOING_SCALE.allweather.forEach(function(g) { SCALE_LOOKUP[compactKey(g.name)] = { name: g.name, rank: g.rank, surface: 'all-weather' }; });

// classifyGoing(): returns { name, rank, surface, isCompound, unranked, abbreviationOf }
// for one raw going string.
//   - Direct match (after abbreviation/case/space/hyphen normalisation): the
//     canonical scale name and rank are used as the group's name — this is
//     the "abbreviation mapping" the brief asks to be reported.
//   - Compound (contains a comma, slash or "(" and the FIRST segment matches
//     the scale): the FULL raw string is kept as its own going name, ranked
//     by that first segment.
//   - Neither: kept as its own name, rank 'unranked'.
function classifyGoing(raw) {
  const trimmed = String(raw || '').trim();
  if (!trimmed) return null;
  const direct = SCALE_LOOKUP[compactKey(trimmed)];
  if (direct) {
    const isAbbrev = compactKey(trimmed) === compactKey(direct.name) && trimmed !== direct.name;
    return { name: direct.name, rank: direct.rank, surface: direct.surface, raw: trimmed, isCompound: false, unranked: false, abbreviationOf: isAbbrev ? trimmed : null };
  }
  const parts = trimmed.split(/[,/(]/);
  if (parts.length > 1) {
    const first = parts[0].trim();
    const firstMatch = SCALE_LOOKUP[compactKey(first)];
    if (firstMatch) return { name: trimmed, rank: firstMatch.rank, surface: firstMatch.surface, raw: trimmed, isCompound: true, unranked: false, abbreviationOf: null };
  }
  return { name: trimmed, rank: 'unranked', surface: 'unknown', raw: trimmed, isCompound: false, unranked: true, abbreviationOf: null };
}

// ── A. THE WINDOW ────────────────────────────────────────────────────────
// Interpretation note (disclosed, not silently assumed): the brief's sentence
// order lists the no-going exclusion after the 8-run cap, but a row with no
// going string is not part of a "going window" at all — excluding it first,
// then capping at 8 of what remains, is what makes the 8-run limit mean
// "8 runs with a usable going", not "8 rows, some possibly useless". Both
// filters are report clearly (excludedNoGoing, limitApplied) so this choice
// is visible and reversible if a different order was intended.
function goingWindow(rows, raceDate) {
  const withDate = (rows || []).filter(function(r) { return r && r.date; });
  const sorted = withDate.slice().sort(function(a, b) { return String(b.date).localeCompare(String(a.date)); }); // newest first
  const raceMs = Date.parse(raceDate + 'T00:00:00Z');
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
  if (withGoing.length > 8) { windowRows = withGoing.slice(0, 8); limitApplied = '8 runs'; }
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

// ── C. GROUPING ──────────────────────────────────────────────────────────
const NON_FINISH_WORDS = { PU: 'pulled up', F: 'fell', UR: 'unseated rider', BD: 'brought down', RO: 'ran out', SU: 'slipped up', DSQ: 'disqualified' };
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
  return code.toLowerCase() || 'unknown result'; // unrecognised code — see Part 4 report for any real occurrence
}
function formatResult(r) {
  return posWord(r.pos) + ' of ' + (r.ran || '?') + ', ' + stripParens(r.course || '') + ', ' + dayMonYear(r.date);
}

// windowRows: rows already restricted to the window by goingWindow(). Returns
// groups in scale order: turf (rank asc), then all-weather (rank asc), then
// unranked (first-seen order) — per the brief's display ordering.
function goingGroups(windowRows) {
  const byName = {}; // name -> { name, rank, surface, isCompound, unranked, rows:[] }
  const order = [];
  (windowRows || []).forEach(function(r) {
    const c = classifyGoing(r.going);
    if (!c) return;
    if (!byName[c.name]) { byName[c.name] = { name: c.name, rank: c.rank, surface: c.surface, isCompound: c.isCompound, unranked: c.unranked, rows: [] }; order.push(c.name); }
    byName[c.name].rows.push(r);
  });
  const groups = order.map(function(name) {
    const g = byName[name];
    const wins = g.rows.filter(function(r) { return posNum(r.pos) === 1; }).length;
    const places = g.rows.filter(function(r) { const p = posNum(r.pos); return p === 2 || p === 3; }).length;
    return {
      name: g.name, rank: g.rank, surface: g.surface, isCompound: g.isCompound, unranked: g.unranked,
      runs: g.rows.length, wins: wins, places: places,
      results: g.rows.slice().sort(function(a, b) { return String(b.date).localeCompare(String(a.date)); }).map(formatResult)
    };
  });
  const turf = groups.filter(function(g) { return g.surface === 'turf'; }).sort(function(a, b) { return a.rank - b.rank; });
  const aw = groups.filter(function(g) { return g.surface === 'all-weather'; }).sort(function(a, b) { return a.rank - b.rank; });
  const unranked = groups.filter(function(g) { return g.unranked; });
  return turf.concat(aw, unranked);
}

// ── D. NEVER-RUN LINE ────────────────────────────────────────────────────
// Good to Soft and Yielding (both rank 6) count as covering each other.
function goingNeverRun(groups) {
  const turfGroups = (groups || []).filter(function(g) { return g.surface === 'turf'; });
  if (!turfGroups.length) return { line: 'No turf runs in this window.', names: [] };
  const covered = {};
  turfGroups.forEach(function(g) { if (!g.isCompound && !g.unranked) covered[g.rank] = true; });
  const missing = GOING_SCALE.turf.filter(function(g) { return !covered[g.rank]; }).map(function(g) { return g.name; });
  // De-dupe the rank-6 pair: if neither Good to Soft nor Yielding is covered,
  // list both names (both are genuinely unrun); if the pair is covered, the
  // covered[] check above already removed both from `missing`.
  return { line: missing.length ? missing.join(', ') : null, names: missing };
}

// ── E. THE ENVELOPE TEXT ─────────────────────────────────────────────────
// The upcoming race's going, field size, class and date never appear here —
// horse/race objects are only read for name, age and sex.
function goingEnvelope(horse, race, windowResult, groups, neverRun) {
  const lines = [];
  lines.push('HORSE: ' + (horse && horse.name || 'Unknown') + ', ' + (horse && horse.age || '?') + 'yo ' + (horse && horse.sex || 'unknown sex') + '.');
  lines.push('WINDOW: last ' + windowResult.size + ' run' + (windowResult.size === 1 ? '' : 's') + ', ' + dayMonYear(windowResult.oldestDate) + ' to ' + dayMonYear(windowResult.newestDate) + ' (' + windowResult.limitApplied + ').');
  lines.push('GOING RECORD (fastest to slowest):');
  groups.forEach(function(g) {
    lines.push('- ' + g.name + ': ' + g.runs + ' run' + (g.runs === 1 ? '' : 's') + ', ' + g.wins + ' win' + (g.wins === 1 ? '' : 's') + ', ' + g.places + ' place' + (g.places === 1 ? '' : 's') + '. Results: ' + g.results.join('; ') + '.');
  });
  if (neverRun.line) lines.push('NEVER RUN ON (turf, this window): ' + neverRun.line);
  return lines.join('\n');
}

// ── F. EMPTY CASES ───────────────────────────────────────────────────────
const NO_RUNS_TEMPLATE = 'No runs in the last 18 months, so no going record to assess.';

// ── PART 2 — THE MODEL PROMPT (static, cached) ──────────────────────────
const GOING_SYSTEM_PROMPT = "You write the GOING section of a racehorse's form summary on a racing website. The reader wants to know how this horse has performed on different ground. You are given the horse's recent record, already grouped by going, with every result listed under the going it happened on, and a list of goings it has not run on.\n\n" +
"THE GROUND SCALE, fastest to slowest.\n" +
"Turf: Hard, Firm, Good to Firm, Good, Good to Yielding (Irish), Good to Soft (British) which is the same ground as Yielding (Irish), Yielding to Soft (Irish), Soft, Soft to Heavy (Irish), Heavy.\n" +
"All-weather: Fast, Standard to Fast, Standard, Standard to Slow, Slow.\n" +
"All-weather and turf are different surfaces. Never compare a turf going with an all-weather going as faster or slower.\n\n" +
"YOUR JOB. Read the going record and tell the reader, in your own words, what it shows about this horse on different ground. Interpret the results: where it has run well, where it has not, and whether the record shows a real pattern. Use the specific results as evidence. Write naturally; each horse's record is different, so each text should read differently. If the record is too thin or too mixed to show anything, say that plainly rather than forcing a conclusion.\n\n" +
"HARD RULES. Breaking any of these is a failure.\n" +
"1. Use only the goings, counts and results given in the GOING RECORD. Never state a result, count or going that is not listed.\n" +
"2. Never add runs, wins or places from different goings together. Never calculate a total, a percentage, a strike rate, or a phrase like '2 of her last 4'. You may only use the counts exactly as given for each single going.\n" +
"3. A place is a 2nd or 3rd only. Never call a win a place, and never call a 4th or worse a place.\n" +
"4. Write every finishing position exactly as '3rd of 9'. Never '3/9', never 'third', never 'placed third'.\n" +
"5. Write all numbers as digits.\n" +
"6. One run on a going is not a preference. You may describe a single run, but never claim the horse likes or dislikes a going on one run.\n" +
"7. Never mention, predict or hint at the going for the horse's next race or 'today'. Never say the ground 'should suit' or 'will suit'. Describe the record only.\n" +
"8. Never mention the size of any upcoming field, the upcoming course, the upcoming distance, or the race itself.\n" +
"9. This section is about ground only. Never describe courses, track shapes, distances, trainers, jockeys, class, prices or breeding. You may name a course only as part of a result, as given.\n" +
"10. Never give a reason why the horse ran well or badly (injury, draw, pace, trip, fitness). Only the results are known.\n" +
"11. When you mention a going the horse has not run on, use only the NEVER RUN ON list.\n" +
"12. Treat Good to Soft and Yielding as the same ground when interpreting, but always write each result with the going name exactly as given.\n" +
"13. No betting language: no 'backed', 'value', 'each-way', 'price', 'odds', 'market'.\n" +
"14. Length: 30 to 45 words. Never more than 45.\n\n" +
"OUTPUT: return only the Going text as plain prose. No heading, no quotation marks, no bullet points, no markdown.";

const GOING_MAX_TOKENS = 150;

// ── PART 3 — GOING VALIDATOR ─────────────────────────────────────────────
// Checks made reliable, and two disclosed as not fully reliable:
//   - banned-format's ordinal-word detection ("first"/"second"/"third"/
//     "fourth") is a blunt whole-word search — it cannot distinguish "her
//     third run on Soft" (a position claim, correctly banned) from "for the
//     first time" (not a position at all). It will over-flag prose that uses
//     these words in a non-position sense; there is no reliable way to tell
//     the two apart by regex alone, so this check trades false positives for
//     never missing a real violation.
//   - count-not-given cannot tell a genuine single-going count from a number
//     that coincidentally equals a DIFFERENT going's count (e.g. two goings
//     both happen to have "2 wins") — it can only check "is N a valid count
//     for SOME going", not "is N THIS going's count", the same structural
//     limit the main text engine's validator has for its count check.
function words(s) { const t = String(s || '').trim(); return t ? t.split(/\s+/).length : 0; }
const ALL_SCALE_NAMES = GOING_SCALE.turf.concat(GOING_SCALE.allweather).map(function(g) { return g.name; });
const BANNED_WORDS = ['backed', 'value', 'each-way', 'each way', 'price', 'odds', 'market', 'today', 'tomorrow', 'should suit', 'will suit', 'next time out'];
const ORDINAL_WORDS = ['first', 'second', 'third', 'fourth'];

function validateGoing(text, groups, neverRun) {
  const failures = [];
  const fail = function(check, detail) { failures.push({ check: check, detail: detail }); };
  const t = String(text || '');
  const wc = words(t);

  if (wc > 45) fail('words-over', wc + ' words');

  // position-not-in-record: every numeric "Nth of M" must be a real result.
  const pairs = {};
  (groups || []).forEach(function(g) { g.results.forEach(function(r) { const m = /^(\d+)(?:st|nd|rd|th) of (\d+)/.exec(r); if (m) pairs[m[1] + '|' + m[2]] = true; }); });
  let m;
  const reNth = /\b(\d+)(?:st|nd|rd|th)\s+of\s+(\d+)\b/g;
  while ((m = reNth.exec(t)) !== null) { if (!pairs[m[1] + '|' + m[2]]) fail('position-not-in-record', m[0]); }

  // going-not-in-record: any canonical scale name mentioned must be a going
  // present in the groups (by name) or in the never-run list.
  const allowed = {};
  (groups || []).forEach(function(g) { allowed[g.name.toLowerCase()] = true; });
  (neverRun && neverRun.names || []).forEach(function(n) { allowed[n.toLowerCase()] = true; });
  ALL_SCALE_NAMES.slice().sort(function(a, b) { return b.length - a.length; }).forEach(function(name) {
    const re = new RegExp('\\b' + name.replace(/ /g, '\\s+') + '\\b', 'gi');
    let mm;
    while ((mm = re.exec(t)) !== null) { if (!allowed[name.toLowerCase()]) fail('going-not-in-record', mm[0]); }
  });

  // count-not-given: every "N run(s)/win(s)/place(s)" must equal some going's own count.
  const counts = { run: {}, win: {}, place: {} };
  (groups || []).forEach(function(g) { counts.run[g.runs] = true; counts.win[g.wins] = true; counts.place[g.places] = true; });
  const NUM_WORDS = { one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10 };
  const reCount = /\b(\d+|one|two|three|four|five|six|seven|eight|nine|ten)\s+(runs?|wins?|places?)\b/gi;
  while ((m = reCount.exec(t)) !== null) {
    const n = /^\d+$/.test(m[1]) ? parseInt(m[1], 10) : NUM_WORDS[m[1].toLowerCase()];
    const kind = /^run/i.test(m[2]) ? 'run' : /^win/i.test(m[2]) ? 'win' : 'place';
    if (!counts[kind][n]) fail('count-not-given', m[0]);
  }

  // banned-format: "N/M" position shorthand, or ordinal words as positions.
  const reSlash = /\b\d+\/\d+\b/g;
  while ((m = reSlash.exec(t)) !== null) fail('banned-format', m[0] + ' (N/M position shorthand)');
  ORDINAL_WORDS.forEach(function(w) {
    const re = new RegExp('\\b' + w + '\\b', 'gi'); let mm;
    while ((mm = re.exec(t)) !== null) fail('banned-format', mm[0] + ' (ordinal word)');
  });

  // banned-words
  BANNED_WORDS.forEach(function(w) {
    const re = new RegExp('\\b' + w.replace(/[- ]/g, '[- ]') + '\\b', 'gi');
    if (re.test(t)) fail('banned-words', w);
  });

  // percent
  if (/%|per\s*cent|percent/i.test(t)) fail('percent', 'percentage language found');

  return { ok: failures.length === 0, failures: failures, wordCount: wc };
}

module.exports = {
  GOING_SCALE: GOING_SCALE,
  goingWindow: goingWindow,
  goingGroups: goingGroups,
  goingNeverRun: goingNeverRun,
  goingEnvelope: goingEnvelope,
  NO_RUNS_TEMPLATE: NO_RUNS_TEMPLATE,
  GOING_SYSTEM_PROMPT: GOING_SYSTEM_PROMPT,
  GOING_MAX_TOKENS: GOING_MAX_TOKENS,
  validateGoing: validateGoing,
  // exposed for the local Part 4 self-test / real-data scan
  classifyGoing: classifyGoing,
  compactKey: compactKey
};
