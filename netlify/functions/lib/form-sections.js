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

// "Best" ordering: lowest finishing position wins; a tie goes to the bigger
// field (harder to achieve the same position in a bigger field); a further
// tie goes to the more recent run. Non-finishers (no numeric position) are
// never a candidate — a pulled-up run can't be anyone's "best" result.
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
    // "In the top half": position <= field size / 2. Non-finishers (no
    // numeric position) and a missing/zero field size never count.
    const topHalf = g.rows.filter(function(r) {
      const p = posNum(r.pos); const ran = parseInt(r.ran, 10);
      return p !== null && ran > 0 && p <= ran / 2;
    }).length;
    const bestRow = g.rows.slice().sort(compareForBest)[0];
    const best = (bestRow && posNum(bestRow.pos) !== null) ? formatResult(bestRow) : null;
    return {
      name: g.name, rank: g.rank, surface: g.surface, isCompound: g.isCompound, unranked: g.unranked,
      runs: g.rows.length, wins: wins, places: places, topHalf: topHalf, best: best,
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

// All-weather equivalent — only produced at all when the horse has at least
// one all-weather run in the window (a horse with zero AW runs gets no
// all-weather never-run line at all, same as the turf function's own "no
// turf runs" case, just silent instead of a placeholder sentence, since a
// pure-turf horse's all-weather record isn't a meaningful thing to list).
function goingNeverRunAW(groups) {
  const awGroups = (groups || []).filter(function(g) { return g.surface === 'all-weather'; });
  if (!awGroups.length) return { line: null, names: [] };
  const covered = {};
  awGroups.forEach(function(g) { if (!g.isCompound && !g.unranked) covered[g.rank] = true; });
  const missing = GOING_SCALE.allweather.filter(function(g) { return !covered[g.rank]; }).map(function(g) { return g.name; });
  return { line: missing.length ? 'Never run on (all-weather): ' + missing.join(', ') : null, names: missing };
}

function buildGoingBlock(groups, neverRun, neverRunAW) {
  const lines = groups.map(function(g) {
    const bestClause = g.best ? ' Best: ' + g.best + '.' : '';
    return '- ' + g.name + ': ' + g.runs + ' run' + (g.runs === 1 ? '' : 's') + ', ' + g.wins + ' win' + (g.wins === 1 ? '' : 's') + ', ' + g.places + ' place' + (g.places === 1 ? '' : 's') + ', ' + g.topHalf + ' in the top half.' + bestClause + ' Results: ' + g.results.join('; ') + '.';
  });
  if (neverRun && neverRun.line) lines.push(neverRun.line);
  if (neverRunAW && neverRunAW.line) lines.push(neverRunAW.line);
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

function buildGoingEnvelope(horse, windowResult, groups, neverRun, neverRunAW) {
  return buildEnvelope(horse, windowResult, [{ heading: 'GOING DATA', text: buildGoingBlock(groups, neverRun, neverRunAW) }]);
}

// ── E. EMPTY WINDOW ──────────────────────────────────────────────────────
const NO_RUNS_TEMPLATE = 'No runs in the last 18 months, so no going record to assess.';

// ── F. STATIC PROMPT — byte-identical on every call, cached ─────────────
const FORM_SECTIONS_PROMPT = "You write sections of a racehorse's form summary for a racing website. Each section is about the horse's own past record. Never refer to any future race.\n\n" +
"The reader can already see every result in the form table. Your job is the next step: tell them what those results mean. The counting and comparing is done for you in the data block, so use those figures. Lead with what the record says about this horse, and back it with one or two results. Do not walk through every result.\n\n" +
"A good read is specific to the horse: what it handles, what it doesn't, where its best runs come from. If the record shows nothing clear, that is the read: say so plainly and say why (results are poor whatever the ground, or there are too few runs to judge). Every horse is different, so every text should sound different. Do not open with a stock phrase.\n\n" +
"RULES FOR EVERY SECTION\n" +
"1. Use only what is in the data block. No outside knowledge of horses, courses or people.\n" +
"2. Use figures exactly as given. Never add figures from different categories together or work out totals or percentages yourself.\n" +
"3. A place is a 2nd or 3rd. A win is not a place; 4th or worse is not a place.\n" +
"4. Write positions as '3rd of 9'. All numbers as digits.\n" +
"5. Never mention a future race, today, or what will suit.\n" +
"6. Never give a reason for a run: no injury, trip, draw, pace or fitness.\n" +
"7. No betting words: backed, value, each-way, price, odds, market, favourite.\n" +
"8. Plain prose. No headings, bullets or quotation marks.\n\n" +
"GOING (from GOING DATA): how the horse has run on different ground.\n" +
"Ground from fastest to slowest. Turf: Hard, Firm, Good to Firm, Good, Good to Yielding, Good to Soft or Yielding (the same ground), Yielding to Soft, Soft, Soft to Heavy, Heavy. All-weather: Fast, Standard to Fast, Standard, Standard to Slow, Slow. Never compare turf with all-weather.\n" +
"'In the top half' means the horse finished in the top half of the field. Use it to judge where it runs well.\n" +
"One run on a going is not enough to call a preference.\n" +
"Name goings it has not run on only from the 'Never run on' lines.\n" +
"Ground only: no courses, distances, trainers, jockeys or class, except a course inside a result.\n" +
"30 to 45 words.\n\n" +
"OUTPUT: strict JSON only: {\"going\": \"...\"}";

const MAX_TOKENS = 200;

// ── G. VALIDATOR ──────────────────────────────────────────────────────────
// block: { groups, neverRun, neverRunAW } — the same groups/neverRun(AW)
// buildGoingEnvelope was given, so validation checks the model's claims
// against exactly what it was sent, nothing recomputed differently.
//
// One check disclosed as not fully reliable (same structural limit as the
// main text engine's validator): count-not-given can only confirm a number
// is SOME going's own figure, not that it's THIS going's figure — two
// goings sharing the same run/win/place/top-half tally are indistinguishable
// to a regex check. The "N of M" check below is stricter (both numbers must
// belong to the same going), but a bare "N runs" still isn't tied to a
// specific going.
function words(s) { const t = String(s || '').trim(); return t ? t.split(/\s+/).length : 0; }
const ALL_SCALE_NAMES = GOING_SCALE.turf.concat(GOING_SCALE.allweather).map(function(g) { return g.name; });
const BANNED_WORDS = ['backed', 'value', 'each-way', 'each way', 'price', 'odds', 'market', 'favourite', 'today', 'tomorrow', 'next time', 'should suit', 'will suit'];
const NUM_WORDS = { one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10 };
function numFrom(s) { return /^\d+$/.test(s) ? parseInt(s, 10) : NUM_WORDS[String(s || '').toLowerCase()]; }
const NUM_WORD_ALT = 'one|two|three|four|five|six|seven|eight|nine|ten';

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
  const neverRunAW = (block && block.neverRunAW) || { names: [] };

  // position-not-in-record (also covers positions inside a "Best:" clause,
  // since a going's best result is always one of its own listed results).
  const pairs = {};
  groups.forEach(function(g) { g.results.forEach(function(r) { const m = /^(\d+)(?:st|nd|rd|th) of (\d+)/.exec(r); if (m) pairs[m[1] + '|' + m[2]] = true; }); });
  let m;
  const reNth = /\b(\d+)(?:st|nd|rd|th)\s+of\s+(\d+)\b/g;
  while ((m = reNth.exec(t)) !== null) { if (!pairs[m[1] + '|' + m[2]]) fail('position-not-in-record', m[0]); }

  // going-not-in-record: any canonical scale name mentioned must be in the
  // block or EITHER never-run line (turf or all-weather) — fix (a).
  const allowed = {};
  groups.forEach(function(g) { allowed[g.name.toLowerCase()] = true; });
  neverRun.names.forEach(function(n) { allowed[n.toLowerCase()] = true; });
  neverRunAW.names.forEach(function(n) { allowed[n.toLowerCase()] = true; });
  ALL_SCALE_NAMES.slice().sort(function(a, b) { return b.length - a.length; }).forEach(function(name) {
    const re = new RegExp('\\b' + name.replace(/ /g, '\\s+') + '\\b', 'gi'); let mm;
    while ((mm = re.exec(t)) !== null) { if (!allowed[name.toLowerCase()]) fail('going-not-in-record', mm[0]); }
  });

  // count-not-given — fix (b). Four parts: (1) "N runs/wins/places" and
  // "N in the top half", each checked against that one figure's own set of
  // values across goings; (2) "N of M runs/outings/starts/races" valid only
  // when some single going has runs === M and one of its other figures
  // (wins/places/topHalf/runs itself) === N; (3) a standalone "N
  // outings/starts/races" (a synonym for "N runs" not already part of an
  // "of" fraction) checked against any going's own figure; (4) hidden
  // totals — "all N", bare "both" (implies 2), "other N" — checked the same
  // loose way, since these words don't name which figure they mean.
  const counts = { run: {}, win: {}, place: {}, topHalf: {} };
  groups.forEach(function(g) { counts.run[g.runs] = true; counts.win[g.wins] = true; counts.place[g.places] = true; counts.topHalf[g.topHalf] = true; });
  function matchesAnyGoingFigure(n) { return groups.some(function(g) { return g.runs === n || g.wins === n || g.places === n || g.topHalf === n; }); }

  const reCount = new RegExp('\\b(\\d+|' + NUM_WORD_ALT + ')\\s+(runs?|wins?|places?)\\b', 'gi');
  while ((m = reCount.exec(t)) !== null) {
    const n = numFrom(m[1]);
    const kind = /^run/i.test(m[2]) ? 'run' : /^win/i.test(m[2]) ? 'win' : 'place';
    if (!counts[kind][n]) fail('count-not-given', m[0]);
  }
  const reTopHalf = new RegExp('\\b(\\d+|' + NUM_WORD_ALT + ')\\s+in the top half\\b', 'gi');
  while ((m = reTopHalf.exec(t)) !== null) { const n = numFrom(m[1]); if (!counts.topHalf[n]) fail('count-not-given', m[0]); }

  const reOfRuns = new RegExp('\\b(\\d+|' + NUM_WORD_ALT + ')\\s+of\\s+(?:her|his|its|their)?\\s*(\\d+|' + NUM_WORD_ALT + ')\\s+(runs?|outings|starts|races)\\b', 'gi');
  while ((m = reOfRuns.exec(t)) !== null) {
    const n = numFrom(m[1]), total = numFrom(m[2]);
    const sameGoing = groups.some(function(g) { return g.runs === total && (g.runs === n || g.wins === n || g.places === n || g.topHalf === n); });
    if (!sameGoing) fail('count-not-given', m[0] + ' (N and M not from the same going)');
  }

  const reStandaloneTotal = new RegExp('\\b(\\d+|' + NUM_WORD_ALT + ')\\s+(outings|starts|races)\\b', 'gi');
  while ((m = reStandaloneTotal.exec(t)) !== null) { const n = numFrom(m[1]); if (!counts.run[n]) fail('count-not-given', m[0]); }

  const reAll = new RegExp('\\ball\\s+(\\d+|' + NUM_WORD_ALT + ')\\b', 'gi');
  while ((m = reAll.exec(t)) !== null) { const n = numFrom(m[1]); if (!matchesAnyGoingFigure(n)) fail('count-not-given', m[0] + ' (hidden total)'); }
  if (/\bboth\b/i.test(t) && !matchesAnyGoingFigure(2)) fail('count-not-given', 'both (hidden total)');
  const reOther = new RegExp('\\bother\\s+(\\d+|' + NUM_WORD_ALT + ')\\b', 'gi');
  while ((m = reOther.exec(t)) !== null) { const n = numFrom(m[1]); if (!matchesAnyGoingFigure(n)) fail('count-not-given', m[0] + ' (hidden total)'); }

  // banned-format: N/M shorthand
  const reSlash = /\b\d+\/\d+\b/g;
  while ((m = reSlash.exec(t)) !== null) fail('banned-format', m[0] + ' (N/M position)');

  // ordinal words as a finishing position only — fix (c). Fails only when an
  // ordinal is preceded by a position-indicating word (finished/was/came/
  // ran/placed/a/an) AND not immediately followed by a noun that shows it's
  // describing WHICH run/attempt rather than a placing (run/start/time/
  // attempt/outing/try, or "of" as in "a third of her runs"). "her third
  // run" is never flagged (no trigger word precedes "third"); "finished
  // second" / "was third" / "a fourth" are. Disclosed trade-off: a
  // sentence-initial, trigger-less ordinal used as a position (rare) could
  // be missed — deliberately traded for not flagging descriptive ordinals,
  // per this round's explicit instruction.
  const reOrdinalPosition = /\b(?:finished|was|came|ran|placed|a|an)\s+(first|second|third|fourth)\b(?!\s+(?:runs?|starts?|times?|attempts?|outings?|tries?|of)\b)/gi;
  while ((m = reOrdinalPosition.exec(t)) !== null) fail('banned-format', m[0] + ' (ordinal word as position)');

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
  goingNeverRunAW: goingNeverRunAW,
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
