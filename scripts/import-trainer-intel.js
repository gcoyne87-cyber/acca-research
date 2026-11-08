// scripts/import-trainer-intel.js
// Parses trainer-intel.xlsx and publishes a live matching snapshot to Redis.
//
// Run via:  npx netlify dev:exec --context production node scripts/import-trainer-intel.js [--dry-run] [--force]
//
// --dry-run  : parse, validate, build snapshot and report — no Redis writes
// --force    : bypass the "new count < half old count" guard for deliberate reductions
'use strict';

require('dotenv').config();
const path  = require('path');
const https = require('https');
const XLSX  = require('xlsx');

const DRY_RUN   = process.argv.includes('--dry-run');
const FORCE     = process.argv.includes('--force');
const XLSX_PATH = path.resolve(__dirname, '..', 'trainer-intel.xlsx');

const UPSTASH_URL   = process.env.UPSTASH_REDIS_REST_URL;
const UPSTASH_TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN;

// ============================================================
// TRAINER ALIAS MAP
// Willie Mullins: sheet name does not appear in API racecards; API uses "W P Mullins" (trainer_id trn_13275)
// All other seven trainers: sheet name confirmed = API name by 21-day audit.
// ============================================================
const TRAINER_ALIASES = {
  'Willie Mullins': { api_name: 'W P Mullins', trainer_id: 'trn_13275' }
};

// ============================================================
// Helpers
// ============================================================

function normalizeName(str) {
  return String(str || '')
    .toLowerCase()
    .trim()
    .replace(/['‘’\-\.]/g, '') // apostrophes (straight + curly), hyphens, full stops
    .replace(/\s+/g, ' ')
    .trim();
}

function irishDateStr() {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Dublin' }).format(new Date());
}

function irishNowStr() {
  return new Date().toLocaleString('sv-SE', { timeZone: 'Europe/Dublin' }).replace(' ', 'T') + ' Irish';
}

function parseYMD(val) {
  if (val === null || val === undefined || val === '') return null;
  const s = String(val).trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return null;
  const d = new Date(s + 'T00:00:00Z');
  return isNaN(d.getTime()) ? null : s;
}

// ============================================================
// Redis
// ============================================================

function redisCmd(args) {
  const url  = new URL(UPSTASH_URL);
  const body = JSON.stringify(args);
  return new Promise((resolve, reject) => {
    const req = https.request({
      hostname: url.hostname, path: '/', method: 'POST',
      headers: { 'Authorization': 'Bearer ' + UPSTASH_TOKEN, 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) }
    }, res => {
      let d = ''; res.on('data', c => d += c);
      res.on('end', () => { try { resolve(JSON.parse(d)); } catch (e) { reject(new Error('Redis parse: ' + d.slice(0, 120))); } });
    });
    req.on('error', reject);
    req.write(body); req.end();
  });
}

function redisGet(key) {
  const url = new URL(UPSTASH_URL);
  return new Promise(resolve => {
    const req = https.request({
      hostname: url.hostname, path: '/get/' + encodeURIComponent(key), method: 'GET',
      headers: { 'Authorization': 'Bearer ' + UPSTASH_TOKEN }
    }, res => {
      let d = ''; res.on('data', c => d += c);
      res.on('end', () => { try { const r = JSON.parse(d); resolve(r.result ? JSON.parse(r.result) : null); } catch (e) { resolve(null); } });
    });
    req.on('error', () => resolve(null)); req.end();
  });
}

function redisSet(key, value) {
  const url  = new URL(UPSTASH_URL);
  const body = JSON.stringify(value);
  return new Promise((resolve, reject) => {
    const req = https.request({
      hostname: url.hostname, path: '/set/' + encodeURIComponent(key), method: 'POST',
      headers: { 'Authorization': 'Bearer ' + UPSTASH_TOKEN, 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) }
    }, res => {
      let d = ''; res.on('data', c => d += c);
      res.on('end', () => {
        if (res.statusCode !== 200) return reject(new Error('Redis write HTTP ' + res.statusCode + ': ' + d.slice(0, 120)));
        try { const p = JSON.parse(d); if (p && p.error) return reject(new Error('Redis error: ' + p.error)); } catch (e) {}
        resolve();
      });
    });
    req.on('error', reject); req.write(body); req.end();
  });
}

// ============================================================
// Step 1: Parse and validate workbook
// ============================================================

const REQUIRED_FIELDS = ['RULE_ID', 'TRAINER', 'TYPE', 'MATCH', 'TEXT', 'STATUS', 'PRIORITY'];
const VALID_TYPES     = new Set(['HORSE', 'COURSE', 'RACE']);
const VALID_STATUSES  = new Set(['APPROVED', 'REVIEW', 'ARCHIVE']);
const DATE_FIELDS     = ['SOURCE_DATE', 'CHECKED_AT', 'VALID_UNTIL'];

function parseWorkbook() {
  const wb = XLSX.readFile(XLSX_PATH);
  const allRows      = [];
  const errors       = [];
  const seenIds      = new Set();
  const archiveSkips = [];

  for (const sheetName of wb.SheetNames) {
    const ws   = wb.Sheets[sheetName];
    const rows = XLSX.utils.sheet_to_json(ws, { defval: '' });
    for (const rawRow of rows) {
      // Normalise column names to UPPER TRIM so header casing doesn't matter
      const r = { _sheet: sheetName };
      for (const [k, v] of Object.entries(rawRow)) r[k.trim().toUpperCase()] = v;
      allRows.push(r);
    }
  }

  for (const r of allRows) {
    const statusRaw = String(r.STATUS || '').trim().toUpperCase();

    // Skip ARCHIVE before validation
    if (statusRaw === 'ARCHIVE') {
      archiveSkips.push(String(r.RULE_ID || '(no id)'));
      continue;
    }

    // Required fields
    const missing = REQUIRED_FIELDS.filter(f => r[f] === undefined || r[f] === null || r[f] === '');
    if (missing.length) {
      errors.push(`RULE_ID=${r.RULE_ID || '?'} (tab:${r._sheet}): missing required fields: ${missing.join(', ')}`);
      continue;
    }

    const ruleId = String(r.RULE_ID).trim();

    // Duplicate RULE_ID
    if (seenIds.has(ruleId)) {
      errors.push(`Duplicate RULE_ID: ${ruleId} (tab:${r._sheet})`);
      continue;
    }
    seenIds.add(ruleId);

    // TYPE
    const type = String(r.TYPE).trim().toUpperCase();
    if (!VALID_TYPES.has(type)) {
      errors.push(`RULE_ID=${ruleId}: invalid TYPE "${r.TYPE}" (expected HORSE/COURSE/RACE)`);
      continue;
    }

    // STATUS
    if (!VALID_STATUSES.has(statusRaw)) {
      errors.push(`RULE_ID=${ruleId}: invalid STATUS "${r.STATUS}" (expected APPROVED/REVIEW/ARCHIVE)`);
      continue;
    }

    // Date fields — only validate when non-empty
    for (const f of DATE_FIELDS) {
      const val = r[f];
      if (val !== '' && val !== null && val !== undefined) {
        if (parseYMD(val) === null) {
          errors.push(`RULE_ID=${ruleId}: "${f}" value "${val}" is not a valid YYYY-MM-DD date`);
        }
      }
    }

    // Attach normalised fields for later steps
    r._ruleId  = ruleId;
    r._type    = type;
    r._status  = statusRaw;
  }

  if (errors.length) {
    console.error('\n=== VALIDATION ERRORS — IMPORT ABORTED ===');
    errors.forEach(e => console.error('  ' + e));
    process.exit(1);
  }

  // Return only non-archive rows that passed validation (seenIds confirms they did)
  const validated = allRows.filter(r => r._ruleId && r._status !== 'ARCHIVE');
  return { totalRead: allRows.length, archiveSkips, validated };
}

// ============================================================
// Step 2: Select active rows
// ============================================================

function selectActive(validated) {
  const todayStr     = irishDateStr();
  const reviewSkips  = [];
  const expiredSkips = [];
  const active       = [];

  for (const r of validated) {
    if (r._status === 'REVIEW') {
      reviewSkips.push(r._ruleId);
      continue;
    }
    // Only APPROVED below
    const validUntil = parseYMD(r.VALID_UNTIL);
    if (validUntil && validUntil < todayStr) {
      expiredSkips.push({ id: r._ruleId, validUntil });
      continue;
    }
    active.push(r);
  }

  return { active, reviewSkips, expiredSkips };
}

// ============================================================
// Step 3 & 4: Normalise and build snapshot
// ============================================================

function buildSnapshot(active) {
  const warnings      = [];
  const byHorse       = {};
  const byTrainerCourse = {};
  const byTrainerRace = [];
  const perTrainer    = {};
  const perType       = { HORSE: 0, COURSE: 0, RACE: 0 };
  let horseWithId     = 0;

  for (const r of active) {
    const sheetTrainer = String(r.TRAINER || '').trim();
    const alias        = TRAINER_ALIASES[sheetTrainer];
    const apiName      = alias ? alias.api_name : sheetTrainer;
    const trainerId    = alias ? alias.trainer_id : (String(r.TRAINER_ID || '').trim() || '');
    const tKey         = normalizeName(apiName);

    perTrainer[apiName] = (perTrainer[apiName] || 0) + 1;
    perType[r._type]++;

    const stored = {
      rule_id:         r._ruleId,
      trainer_display: apiName,
      trainer_id:      trainerId,
      type:            r._type,
      match_display:   String(r.MATCH || '').trim(),
      text:            String(r.TEXT || '').trim(),
      source_type:     String(r.SOURCE_TYPE || '').trim(),
      priority:        Number(r.PRIORITY) || 0,
      source_date:     parseYMD(r.SOURCE_DATE),
      month:           r.MONTH ? String(r.MONTH).trim() : null,
      valid_until:     parseYMD(r.VALID_UNTIL),
    };

    if (r._type === 'HORSE') {
      const hid = String(r.HORSE_ID || '').trim();
      if (hid) { stored.horse_id = hid; horseWithId++; }
    }

    const matchNorm = normalizeName(r.MATCH);
    if (!matchNorm) {
      warnings.push(`RULE_ID=${r._ruleId} (${r._type}): MATCH "${r.MATCH}" normalises to empty — row skipped`);
      perTrainer[apiName]--;
      perType[r._type]--;
      continue;
    }

    if (r._type === 'HORSE') {
      if (!byHorse[matchNorm]) byHorse[matchNorm] = [];
      byHorse[matchNorm].push(stored);

    } else if (r._type === 'COURSE') {
      const key = tKey + '|' + matchNorm;
      if (!byTrainerCourse[key]) byTrainerCourse[key] = [];
      byTrainerCourse[key].push(stored);

    } else if (r._type === 'RACE') {
      const courseNorm = r.COURSE ? normalizeName(String(r.COURSE)) : null;
      byTrainerRace.push({
        trainerKey: tKey,
        keyword:    matchNorm,
        ...(courseNorm ? { course: courseNorm } : {}),
        row:        stored
      });
    }
  }

  const totalActive = Object.keys(perTrainer).reduce(
    (sum, k) => sum + perTrainer[k], 0
  );

  return {
    warnings,
    horseWithId,
    snapshot: {
      meta: {
        imported_at:  irishNowStr(),
        source_file:  'trainer-intel.xlsx',
        total_active: totalActive,
        per_trainer:  perTrainer,
        per_type:     perType
      },
      byHorse,
      byTrainerCourse,
      byTrainerRace
    }
  };
}

// ============================================================
// Diff helpers
// ============================================================

function flattenSnapshot(snap) {
  const rows = {};
  if (!snap) return rows;
  for (const list of Object.values(snap.byHorse || {}))
    for (const r of list) rows[r.rule_id] = r;
  for (const list of Object.values(snap.byTrainerCourse || {}))
    for (const r of list) rows[r.rule_id] = r;
  for (const entry of snap.byTrainerRace || [])
    rows[entry.row.rule_id] = entry.row;
  return rows;
}

function diffSnapshots(prevSnap, newSnap) {
  const prev  = flattenSnapshot(prevSnap);
  const next  = flattenSnapshot(newSnap);
  const added   = Object.keys(next).filter(id => !prev[id]);
  const removed = Object.keys(prev).filter(id => !next[id]);
  const changed = Object.keys(next).filter(id =>
    prev[id] && (prev[id].text !== next[id].text || prev[id].priority !== next[id].priority)
  );
  return { added, removed, changed };
}

// ============================================================
// Main
// ============================================================

async function main() {
  if (!UPSTASH_URL || !UPSTASH_TOKEN) {
    console.error('ERROR: UPSTASH_REDIS_REST_URL or UPSTASH_REDIS_REST_TOKEN not set.');
    console.error('       Run via: npx netlify dev:exec --context production node scripts/import-trainer-intel.js');
    process.exit(1);
  }

  console.log('=== Trainer Intel Importer' + (DRY_RUN ? ' [DRY RUN]' : '') + (FORCE ? ' [--force]' : '') + ' ===');
  console.log('Irish time: ' + irishNowStr());
  console.log('');

  // Step 1: Parse and validate
  console.log('Step 1  Parsing ' + XLSX_PATH + ' ...');
  const { totalRead, archiveSkips, validated } = parseWorkbook();
  console.log('        ' + totalRead + ' rows read, ' + archiveSkips.length + ' archived (skipped before validation), ' + validated.length + ' passed validation');

  // Step 2: Select active
  console.log('Step 2  Selecting active rows...');
  const { active, reviewSkips, expiredSkips } = selectActive(validated);
  if (expiredSkips.length) {
    expiredSkips.forEach(e => console.log('        Expired/skipped: ' + e.id + ' (VALID_UNTIL ' + e.validUntil + ')'));
  }
  console.log('        ' + reviewSkips.length + ' REVIEW skipped, ' + expiredSkips.length + ' expired skipped, ' + active.length + ' APPROVED active');

  // Steps 3-4: Build snapshot
  console.log('Step 3-4  Building snapshot...');
  const { warnings, horseWithId, snapshot } = buildSnapshot(active);
  warnings.forEach(w => console.warn('        WARN: ' + w));
  console.log('        ' + snapshot.meta.total_active + ' rows in snapshot (' +
    Object.entries(snapshot.meta.per_type).map(([t, n]) => n + ' ' + t).join(', ') + ')');
  console.log('        HORSE rows with horse_id: ' + horseWithId);

  // Step 5: Guards and publish
  console.log('Step 5  Loading existing trainer-intel:live for guard check...');
  const prevSnap = await redisGet('trainer-intel:live');
  const prevFlat = flattenSnapshot(prevSnap);
  const prevCount = Object.keys(prevFlat).length;
  console.log('        Previous: ' + (prevSnap ? prevCount + ' rows' : 'none'));

  if (snapshot.meta.total_active === 0) {
    console.error('ABORT: 0 active rows in new snapshot — refusing to publish.');
    process.exit(1);
  }

  if (prevSnap && !FORCE && snapshot.meta.total_active < prevCount / 2) {
    console.error(
      'ABORT: new count (' + snapshot.meta.total_active + ') is less than half of previous (' + prevCount + ').' +
      ' Use --force to override.'
    );
    process.exit(1);
  }

  if (!DRY_RUN) {
    console.log('        Writing trainer-intel:next ...');
    await redisSet('trainer-intel:next', snapshot);

    if (prevSnap) {
      console.log('        Saving trainer-intel:prev (rollback copy) ...');
      await redisSet('trainer-intel:prev', prevSnap);
    }

    console.log('        Renaming trainer-intel:next → trainer-intel:live ...');
    let renamed = false;
    try {
      const r = await redisCmd(['RENAME', 'trainer-intel:next', 'trainer-intel:live']);
      if (r && r.result === 'OK') {
        renamed = true;
        console.log('        RENAME OK (atomic)');
      } else {
        console.log('        RENAME returned ' + JSON.stringify(r) + ' — falling back to direct SET');
      }
    } catch (e) {
      console.log('        RENAME threw: ' + e.message + ' — falling back to direct SET');
    }

    if (!renamed) {
      await redisSet('trainer-intel:live', snapshot);
      await redisCmd(['DEL', 'trainer-intel:next']).catch(() => {});
      console.log('        SET trainer-intel:live (direct)');
    }
  } else {
    console.log('        [DRY RUN] Skipping Redis writes');
  }

  // ============================================================
  // Report
  // ============================================================
  const diff = diffSnapshots(prevSnap, snapshot);

  console.log('\n=== IMPORT REPORT ===');
  console.log('Rows read          : ' + totalRead);
  console.log('Archived skipped   : ' + archiveSkips.length);
  console.log('Review skipped     : ' + reviewSkips.length);
  console.log('Expired skipped    : ' + expiredSkips.length);
  console.log('Imported (active)  : ' + snapshot.meta.total_active + (DRY_RUN ? ' (dry run — not written)' : ''));

  console.log('\nPer-trainer imported:');
  for (const [name, count] of Object.entries(snapshot.meta.per_trainer)) {
    console.log('  ' + name + ': ' + count);
  }

  console.log('\nPer-type imported:');
  for (const [type, count] of Object.entries(snapshot.meta.per_type)) {
    console.log('  ' + type + ': ' + count);
  }

  if (prevSnap) {
    console.log('\nDiff vs previous snapshot:');
    console.log('  Added   : ' + diff.added.length + (diff.added.length ? '  ' + diff.added.join(', ') : ''));
    console.log('  Changed : ' + diff.changed.length + (diff.changed.length ? '  ' + diff.changed.join(', ') : ''));
    console.log('  Removed : ' + diff.removed.length + (diff.removed.length ? '  ' + diff.removed.join(', ') : ''));
  } else {
    console.log('\nDiff: no previous snapshot (first import)');
  }

  if (warnings.length) {
    console.log('\nMalformed match warnings:');
    warnings.forEach(w => console.log('  ' + w));
  }

  console.log('');
  if (!DRY_RUN) {
    console.log('trainer-intel:live published successfully.');
  } else {
    console.log('DRY RUN complete — no changes made to Redis.');
  }
}

main().catch(e => { console.error('\nFATAL: ' + e.message); process.exit(1); });
