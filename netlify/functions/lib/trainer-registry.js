// Canonical trainer registry — ONE identity per Racing API trainer_id.
//
// Redis key trainer:registry = one JSON object keyed by trainer_id:
//   { canonical, aliases: [], country, location, firstSeen, lastSeen }
// canonical is the newest card name form; aliases hold every form ever seen
// (canonical included). country/location carry over from the old
// trainer-locations.json entries, keyed by id at seed time.
//
// Maintained automatically where stored racecards land (the future-cards
// fetch): load, updateFromRacecards, save. The 2026-10-24 audit grounds the
// design: trainer_id was present on 100% of card runners over 14 days
// (5,758/5,758) and no name string appeared under two ids, so the id is the
// one identity that survives the API's name-form migrations ("A P O'Brien"
// -> "Aidan O'Brien", "Mr W. P. Mullins" / "W. P. Mullins", partnership
// renames). Nothing reads the registry yet — Builds 2-4 point the
// name-matching surfaces at getById/findByName.

const REGISTRY_KEY = 'trainer:registry';

// Lookup normalisation: lowercase, dots stripped, whitespace collapsed.
function normName(s) {
  return String(s || '').toLowerCase().replace(/\./g, '').replace(/\s+/g, ' ').trim();
}

// redisGet: the caller's own helper, (key) -> Promise<parsed value|null>.
async function loadRegistry(redisGet) {
  const r = await redisGet(REGISTRY_KEY);
  return (r && typeof r === 'object' && !Array.isArray(r)) ? r : {};
}

// redisSet: the caller's own helper, (key, value) -> Promise.
function saveRegistry(redisSet, registry) {
  return redisSet(REGISTRY_KEY, registry);
}

// meetings: a stored racecards:{date} meetings array (race.runners[] carrying
// trainer + trainer_id). seenDate: that card's YYYY-MM-DD. Mutates registry
// in place and returns the number of touches (0 = nothing to save). Rules:
// new id -> new entry; known id with an unseen form -> append alias; a form
// on a STRICTLY newer card date than lastSeen becomes canonical (equal-date
// forms never flap — the first form seen on the newest day holds). Re-running
// over an already-seen card is a no-op, so the hook is idempotent.
function updateFromRacecards(registry, meetings, seenDate) {
  const date = String(seenDate || new Date().toISOString().slice(0, 10));
  let changes = 0;
  (Array.isArray(meetings) ? meetings : []).forEach(function(m) {
    ((m && m.races) || []).forEach(function(race) {
      ((race && race.runners) || []).forEach(function(r) {
        const id = r && r.trainer_id;
        const form = r && String(r.trainer || '').trim();
        if (!id || !form) return;
        let e = registry[id];
        if (!e) {
          registry[id] = { canonical: form, aliases: [form], country: null, location: null, firstSeen: date, lastSeen: date };
          changes++;
          return;
        }
        let touched = false;
        if (!Array.isArray(e.aliases)) e.aliases = e.canonical ? [e.canonical] : [];
        if (e.aliases.indexOf(form) === -1) { e.aliases.push(form); touched = true; }
        if (date > (e.lastSeen || '')) {
          if (e.canonical !== form) e.canonical = form;
          e.lastSeen = date;
          touched = true;
        }
        if (!e.firstSeen || date < e.firstSeen) { e.firstSeen = date; touched = true; }
        if (touched) changes++;
      });
    });
  });
  return changes;
}

function getById(registry, id) {
  return (registry && id && registry[id]) || null;
}

// Normalised lookup against canonical and every alias. Returns
// { id, entry } or null. The audit saw no name under two ids; if a collision
// ever appears, the first match in key order wins.
function findByName(registry, name) {
  const n = normName(name);
  if (!n || !registry) return null;
  const ids = Object.keys(registry);
  for (let i = 0; i < ids.length; i++) {
    const e = registry[ids[i]];
    if (!e) continue;
    if (normName(e.canonical) === n) return { id: ids[i], entry: e };
    const al = Array.isArray(e.aliases) ? e.aliases : [];
    for (let k = 0; k < al.length; k++) {
      if (normName(al[k]) === n) return { id: ids[i], entry: e };
    }
  }
  return null;
}

module.exports = { REGISTRY_KEY, normName, loadRegistry, saveRegistry, updateFromRacecards, getById, findByName };
