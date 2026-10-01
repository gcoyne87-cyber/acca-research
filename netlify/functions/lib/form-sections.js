// form-sections.js — shared engine for the horse's per-section form texts.
// Going is the first section built; Trip, Track and Recent Form are added
// later as more labelled blocks under the same envelope and the same
// FORM_SECTIONS_PROMPT (extended, never replaced, so the cache stays valid).
// Not wired into text-engine-submit/collect-background.js, the old
// form-summary job, or any schedule. Supersedes the earlier trial files
// netlify/functions/going-trial.js and netlify/functions/lib/going-section.js
// (both removed in this change) — same window/scale logic, carried over and
// adjusted to this envelope format, prompt and validator signature.
//
// Reused from text-engine-submit-background.js's public helpers (unchanged):
// posNum (finishing position as a number or null), stripParens (drops a
// "(...)" course suffix). Not reused: primaryGoing() (collapses a going
// string to its first term, the opposite of what a going data block needs —
// compounds like "Standard / Slow" must survive whole). dayMonYear() isn't
// exported from that file; reimplemented here (MON) rather than add an
// export to a file this task must not touch the behaviour of.
const engineHelpers = require('../text-engine-submit-background.js').helpers;
const posNum = engineHelpers.posNum;
const stripParens = engineHelpers.stripParens;

const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
function dayMonYear(iso) {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(iso || ''));
  return m ? parseInt(m[3], 10) + ' ' + MON[parseInt(m[2], 10) - 1] + ' ' + m[1] : String(iso || '');
}

// ── A. WINDOW — shared by every future section ─────────────────────────────
// Interpretation note (disclosed): a row with no going string is excluded
// BEFORE the 8-run cap is applied, not after — a useless row should not
// consume one of the 8 slots that belongs to a usable result. Both counts
// (excludedNoGoing, limitApplied) are returned so this choice is visible.
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

// ── B. THE GOING SCALE ──────────────────────────────────────────────────────
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

// classifyGoing(): direct match -> canonical name/rank (an abbreviation is
// reported via abbreviationOf); compound (comma/slash/paren, first segment
// matches) -> the FULL raw string kept as its own name, ranked by that first
// segment; neither -> kept as its own name, rank 'unranked', never dropped.
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

// ── C. GOING DATA BLOCK ─────────────────────────────────────────────────────
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
  return code.toLowerCase() || 'unknown result';
}
function formatResult(r) {
  return posWord(r.pos) + ' of ' + (r.ran || '?') + ', ' + stripParens(r.course || '') + ', ' + dayMonYear(r.date);
}

// windowRows -> groups in display order: turf (rank asc), all-weather (rank
// asc), unranked (first-seen order).
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

// Good to Soft and Yielding (both rank 6) cover each other.
function goingNeverRun(groups) {
  const turfGroups = (groups || []).filter(function(g) { return g.surface === 'turf'; });
  if (!turfGroups.length) return { line: 'No turf runs in this window.', names: [] };
  const covered = {};
  turfGroups.forEach(function(g) { if (!g.isCompound && !g.unranked) covered[g.rank] = true; });
  const missing = GOING_SCALE.turf.filter(function(g) { return !covered[g.rank]; }).map(function(g) { return g.name; });
  return { line: missing.length ? 'Never run on (turf): ' + missing.join(', ') : null, names: missing };
}

function buildGoingBlock(groups, neverRun) {
  const lines = groups.map(function(g) {
    return '- ' + g.name + ': ' + g.runs + ' run' + (g.runs === 1 ? '' : 's') + ', ' + g.wins + ' win' + (g.wins === 1 ? '' : 's') + ', ' + g.places + ' place' + (g.places === 1 ? '' : 's') + '. Results: ' + g.results.join('; ') + '.';
  });
  if (neverRun.line) lines.push(neverRun.line);
  return lines.join('\n');
}

// ── D. ENVELOPE ──────────────────────────────────────────────────────────
// blocks: [{ heading, text }] — Going today; Trip/Track/Recent Form append
// their own {heading, text} entries here later, each under its own heading,
// none of them referencing today's race (course/distance/going/field/class/
// date never appear anywhere in this function).
function buildEnvelope(horse, windowResult, blocks) {
  const lines = [];
  lines.push('HORSE: ' + (horse && horse.name || 'Unknown') + ', ' + (horse && horse.age || '?') + 'yo ' + (horse && horse.sex || 'unknown sex') + '.');
  lines.push('WINDOW: last ' + windowResult.size + ' run' + (windowResult.size === 1 ? '' : 's') + ', ' + dayMonYear(windowResult.oldestDate) + ' to ' + dayMonYear(windowResult.newestDate) + ' (' + windowResult.limitApplied + ').');
  (blocks || []).forEach(function(b) { lines.push(''); lines.push(b.heading); lines.push(b.text); });
  return lines.join('\n');
}

function buildGoingEnvelope(horse, windowResult, groups, neverRun) {
  return buildEnvelope(horse, windowResult, [{ heading: 'GOING DATA', text: buildGoingBlock(groups, neverRun) }]);
}

// ── E. EMPTY WINDOW ──────────────────────────────────────────────────────
const NO_RUNS_TEMPLATE = 'No runs in the last 18 months, so no going record to assess.';

// ── F. STATIC PROMPT — byte-identical on every call, cached ─────────────
const FORM_SECTIONS_PROMPT = "You write sections of a racehorse's form summary for a racing website. Each section describes the horse's own past record only. You never mention a future race.\n\n" +
"You are given the horse's last 8 runs within 18 months, organised into a labelled data block per section. Write each section only from its own block.\n\n" +
"Read the data and say, in your own words, what it shows: where the horse has done well, where it has not, and whether there is a real pattern. Back it with specific results. Every record is different, so every text should read differently. If the record is too thin or too mixed to show anything, say so plainly.\n\n" +
"RULES FOR EVERY SECTION\n" +
"1. Use only what is in the data block. Never state a result, count, going, course or distance that is not there.\n" +
"2. Never add runs, wins or places from different categories together. No totals, percentages, strike rates or phrases like '2 of her last 4'. Use counts exactly as given.\n" +
"3. A place is a 2nd or 3rd only. A win is never a place; a 4th or worse is never a place.\n" +
"4. Positions exactly as '3rd of 9', never '3/9' or 'third'. All numbers as digits.\n" +
"5. Never mention a future race, 'today', 'next time', or what conditions will or should suit.\n" +
"6. Never give a reason a horse ran well or badly.\n" +
"7. No betting language: never 'backed', 'value', 'each-way', 'price', 'odds', 'market', 'favourite'.\n" +
"8. Plain prose. No headings, bullets, quotation marks or markdown.\n\n" +
"SECTION: GOING (from GOING DATA)\n" +
"Say how the horse has run on different ground.\n" +
"Ground scale, fastest to slowest. Turf: Hard, Firm, Good to Firm, Good, Good to Yielding, Good to Soft, Yielding (same ground as Good to Soft), Yielding to Soft, Soft, Soft to Heavy, Heavy. All-weather: Fast, Standard to Fast, Standard, Standard to Slow, Slow.\n" +
"G1. Never compare turf with all-weather as faster or slower.\n" +
"G2. One run on a going is not a preference; describe it only.\n" +
"G3. Name goings not run on only from the 'Never run on' line.\n" +
"G4. Ground only: no courses, distances, trainers, jockeys or class, except a course named inside a result.\n" +
"G5. 30 to 45 words.\n\n" +
"OUTPUT: strict JSON only: {\"going\": \"...\"}";

const MAX_TOKENS = 200;

// ── G. VALIDATOR ──────────────────────────────────────────────────────────
// block: { groups, neverRun } — the same groups/neverRun buildGoingEnvelope
// was given, so validation checks the model's claims against exactly what it
// was sent, nothing recomputed differently.
//
// Two checks disclosed as not fully reliable (same structural limits as the
// main text engine's validator):
//   - first/second/third/fourth as position words is a blunt whole-word
//     search; it cannot tell "her third run" (banned) from "the first time"
//     (not a position at all) — it trades false positives for never missing
//     a real one.
//   - count-not-given can only confirm N is SOME going's own count, not that
//     it's THIS going's count — two goings sharing the same run/win/place
//     tally are indistinguishable to a regex check.
function words(s) { const t = String(s || '').trim(); return t ? t.split(/\s+/).length : 0; }
const ALL_SCALE_NAMES = GOING_SCALE.turf.concat(GOING_SCALE.allweather).map(function(g) { return g.name; });
const BANNED_WORDS = ['backed', 'value', 'each-way', 'each way', 'price', 'odds', 'market', 'favourite', 'today', 'tomorrow', 'next time', 'should suit', 'will suit'];
const ORDINAL_WORDS = ['first', 'second', 'third', 'fourth'];

function parseJsonGoing(text) {
  let t = String(text || '').trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
  const a = t.indexOf('{'), b = t.lastIndexOf('}');
  if (a > 0 || (b >= 0 && b < t.length - 1)) t = t.slice(a, b + 1);
  try { return JSON.parse(t); } catch (e) { return null; }
}

function validateGoing(text, block) {
  const failures = []; const warnings = [];
  const fail = function(check, detail) { failures.push({ check: check, detail: detail }); };

  const parsed = parseJsonGoing(text);
  if (!parsed || typeof parsed !== 'object' || typeof parsed.going !== 'string' || !parsed.going.trim()) {
    fail('json', 'invalid JSON or missing "going" field');
    return { ok: false, failures: failures, warnings: warnings, wordCount: 0, going: null };
  }
  const t = parsed.going;
  const wc = words(t);
  if (wc > 45) warnings.push({ section: 'going', words: wc, cap: 45, over: wc - 45 }); // warning only, never blocks storage

  const groups = (block && block.groups) || [];
  const neverRun = (block && block.neverRun) || { names: [] };

  // position-not-in-record
  const pairs = {};
  groups.forEach(function(g) { g.results.forEach(function(r) { const m = /^(\d+)(?:st|nd|rd|th) of (\d+)/.exec(r); if (m) pairs[m[1] + '|' + m[2]] = true; }); });
  let m;
  const reNth = /\b(\d+)(?:st|nd|rd|th)\s+of\s+(\d+)\b/g;
  while ((m = reNth.exec(t)) !== null) { if (!pairs[m[1] + '|' + m[2]]) fail('position-not-in-record', m[0]); }

  // going-not-in-record: any canonical scale name mentioned must be in the block or the never-run line.
  const allowed = {};
  groups.forEach(function(g) { allowed[g.name.toLowerCase()] = true; });
  neverRun.names.forEach(function(n) { allowed[n.toLowerCase()] = true; });
  ALL_SCALE_NAMES.slice().sort(function(a, b) { return b.length - a.length; }).forEach(function(name) {
    const re = new RegExp('\\b' + name.replace(/ /g, '\\s+') + '\\b', 'gi'); let mm;
    while ((mm = re.exec(t)) !== null) { if (!allowed[name.toLowerCase()]) fail('going-not-in-record', mm[0]); }
  });

  // count-not-given
  const counts = { run: {}, win: {}, place: {} };
  groups.forEach(function(g) { counts.run[g.runs] = true; counts.win[g.wins] = true; counts.place[g.places] = true; });
  const NUM_WORDS = { one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10 };
  const reCount = /\b(\d+|one|two|three|four|five|six|seven|eight|nine|ten)\s+(runs?|wins?|places?)\b/gi;
  while ((m = reCount.exec(t)) !== null) {
    const n = /^\d+$/.test(m[1]) ? parseInt(m[1], 10) : NUM_WORDS[m[1].toLowerCase()];
    const kind = /^run/i.test(m[2]) ? 'run' : /^win/i.test(m[2]) ? 'win' : 'place';
    if (!counts[kind][n]) fail('count-not-given', m[0]);
  }

  // banned-format: N/M shorthand, ordinal words as positions
  const reSlash = /\b\d+\/\d+\b/g;
  while ((m = reSlash.exec(t)) !== null) fail('banned-format', m[0] + ' (N/M position)');
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

  return { ok: failures.length === 0, failures: failures, warnings: warnings, wordCount: wc, going: t };
}

module.exports = {
  GOING_SCALE: GOING_SCALE,
  sectionWindow: sectionWindow,
  classifyGoing: classifyGoing,
  goingGroups: goingGroups,
  goingNeverRun: goingNeverRun,
  buildGoingBlock: buildGoingBlock,
  buildEnvelope: buildEnvelope,
  buildGoingEnvelope: buildGoingEnvelope,
  NO_RUNS_TEMPLATE: NO_RUNS_TEMPLATE,
  FORM_SECTIONS_PROMPT: FORM_SECTIONS_PROMPT,
  MAX_TOKENS: MAX_TOKENS,
  validateGoing: validateGoing,
  parseJsonGoing: parseJsonGoing,
  compactKey: compactKey
};
