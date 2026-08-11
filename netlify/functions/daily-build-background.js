const https = require('https');
const nodemailer = require('nodemailer');

module.exports.config = { timeout: 900 };

const RACING_AUTH = Buffer.from(
  (process.env.RACING_API_USERNAME || '') + ':' + (process.env.RACING_API_KEY || '')
).toString('base64');
const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY;
const UPSTASH_URL = process.env.UPSTASH_REDIS_REST_URL;
const UPSTASH_TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN;

// Sonnet 4.6 pricing (all calls use Sonnet)
const PRICE_IN          = 3    / 1_000_000;  // $3/M input tokens
const PRICE_OUT         = 15   / 1_000_000;  // $15/M output tokens
const PRICE_CACHE_WRITE = 3.75 / 1_000_000;  // $3.75/M cache write tokens
const PRICE_CACHE_READ  = 0.30 / 1_000_000;  // $0.30/M cache read tokens
const PRICE_WEB_SEARCH  = 0.10;               // $0.10 per search (actual Anthropic billing)

// ── HELPERS ───────────────────────────────────────────────────────────────────

function apiGet(hostname, path, extraHeaders) {
  return new Promise((resolve, reject) => {
    const req = https.request({
      hostname, path, method: 'GET',
      headers: { 'Accept': 'application/json', ...(extraHeaders || {}) }
    }, res => {
      let d = ''; res.on('data', c => d += c);
      res.on('end', () => { try { resolve(JSON.parse(d)); } catch(e) { reject(new Error('Parse: ' + d.slice(0, 100))); } });
    });
    req.on('error', reject); req.end();
  });
}

function apiPost(hostname, path, headers, body) {
  const b = JSON.stringify(body);
  return new Promise((resolve, reject) => {
    const req = https.request({
      hostname, path, method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(b), ...headers }
    }, res => {
      let d = ''; res.on('data', c => d += c);
      res.on('end', () => { try { resolve(JSON.parse(d)); } catch(e) { reject(new Error('Parse')); } });
    });
    req.on('error', reject); req.setTimeout(290000); req.write(b); req.end();
  });
}

function redisSet(key, value) {
  const url = new URL(UPSTASH_URL);
  const body = JSON.stringify(value);
  return new Promise((resolve, reject) => {
    const req = https.request({
      hostname: url.hostname, path: '/set/' + encodeURIComponent(key), method: 'POST',
      headers: { 'Authorization': 'Bearer ' + UPSTASH_TOKEN, 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) }
    }, res => { let d = ''; res.on('data', c => d += c); res.on('end', () => resolve(d)); });
    req.on('error', reject); req.write(body); req.end();
  });
}

function redisGet(key) {
  const url = new URL(UPSTASH_URL);
  return new Promise((resolve, reject) => {
    const req = https.request({
      hostname: url.hostname, path: '/get/' + encodeURIComponent(key), method: 'GET',
      headers: { 'Authorization': 'Bearer ' + UPSTASH_TOKEN }
    }, res => {
      let d = ''; res.on('data', c => d += c);
      res.on('end', () => {
        try { const r = JSON.parse(d); resolve(r.result ? JSON.parse(r.result) : null); }
        catch(e) { resolve(null); }
      });
    });
    req.on('error', () => resolve(null)); req.end();
  });
}

// Guard against a failed/zero-card run silently erasing a good same-day report
// (AUDIT-DAILY-INTELLIGENCE.md, finding C1 — this happened for real once already:
// a parse failure wrote intelligenceItems:0 over a good 5-card report and wiped
// the live site's carousel). If a report already exists for this date with cards,
// and the report we're about to write has zero cards AND at least one error,
// something went wrong mid-build — keep the existing cards and fold the new
// error(s) in, rather than replacing a working day with an empty one.
async function safeWriteReport(dateKey, newReport) {
  try {
    const existing = await redisGet('daily:report:' + dateKey);
    const existingItems = existing && Array.isArray(existing.intelligence) ? existing.intelligence.length : 0;
    const newItems = Array.isArray(newReport.intelligence) ? newReport.intelligence.length : 0;
    const newHasErrors = Array.isArray(newReport.errors) && newReport.errors.length > 0;
    if (existing && existingItems > 0 && newItems === 0 && newHasErrors) {
      const mergedErrors = (existing.errors || []).concat(newReport.errors);
      const merged = Object.assign({}, existing, {
        errors: mergedErrors.filter(function(e, i) { return mergedErrors.indexOf(e) === i; }),
        warnings: (existing.warnings || []).concat(newReport.warnings || []),
        preservedFromPriorRun: true,
        lastFailedAttempt: { at: new Date().toISOString(), errors: newReport.errors }
      });
      await redisSet('daily:report:' + dateKey, merged);
      return;
    }
  } catch (e) { /* guard check itself failed — fall through and write the new report rather than losing the run entirely */ }
  await redisSet('daily:report:' + dateKey, newReport);
}

const _horseHistoryCache = new Map();

async function fetchHorseHistory(horse_id) {
  if (_horseHistoryCache.has(horse_id)) return _horseHistoryCache.get(horse_id);
  // Check Redis cache — populated by the morning build so re-runs don't need Racing API calls
  try {
    const today = new Date().toISOString().slice(0, 10);
    const cached = await redisGet('form:history:' + horse_id + ':' + today);
    if (cached && Array.isArray(cached) && cached.length > 0) {
      _horseHistoryCache.set(horse_id, cached);
      return cached;
    }
  } catch(e) {}
  try {
    const data = await apiGet('api.theracingapi.com',
      '/v1/horses/' + encodeURIComponent(horse_id) + '/results?limit=6',
      { 'Authorization': 'Basic ' + RACING_AUTH }
    );
    const history = (data.results || []).map(race => {
      const runner = (race.runners || []).find(r => r.horse_id === horse_id) || {};
      return {
        date: race.date || '',
        course: race.course || '',
        dist: race.dist || '',
        going: race.going || '',
        pos: runner.position || '-',
        ran: (race.runners || []).length || 0,
        sp: runner.sp || '',
        jockey: runner.jockey || '',
        // AUDIT-DAILY-INTELLIGENCE.md, item 3: the Racing API results endpoint returns
        // the class under `class`, not `race_class` — this field was always empty
        // (100% of sampled historical results), starving Class Drop's Pool 1. Confirmed
        // via a live raw API call: {"class":"Class 1", ...}. Keep race_class as a
        // fallback in case a future response shape reintroduces that name.
        race_class: race.class || race.race_class || ''
      };
    });
    _horseHistoryCache.set(horse_id, history);
    return history;
  } catch(e) {
    return [];
  }
}

function isJumps(raceName, raceType) {
  const s = ((raceName || '') + ' ' + (raceType || '')).toLowerCase();
  return /hurdle|chase|bumper|steeplechase|national hunt|hrd/.test(s);
}

// AUDIT-DAILY-INTELLIGENCE.md, finding S3: this used to do the same naive
// indexOf('{')/lastIndexOf('}') extraction that broke the (now-hardened)
// Intelligence array parse twice in production. Delegates to the shared
// balanced-scanner (extractBalancedJson, defined below) instead.
function parseJson(text) {
  try { return extractBalancedJson(text, '{', '}'); } catch (e) { return null; }
}

// ── SYSTEM PROMPTS ────────────────────────────────────────────────────────────

const NH_PROMPT = `You are a specialist National Hunt race analyst for RacingEdge. Return ONLY a valid JSON object, no text before or after.

HOW TO USE THIS PROMPT — READ FIRST

The list of angles below is a research guide, not a checklist. Use only the angles that are actually relevant to this specific race. Prioritise depth on what matters over breadth across all categories. If three angles tell the strongest story, lead with those. If data on a point isn't available, skip it. Do not invent or pad. Let the race itself dictate which angles matter most.

If you don't love your strongest selection, say so. If the race is unanalysable, say so. If the best advice is to pass, recommend a pass. Never produce a default-confident pick when the case is fragile.

---
INTERNAL CALIBRATION — do this first, before writing anything

Privately assess your confidence:
- High — genuine strong case. The angles converge. You'd back this yourself.
- Medium — there is a selection but the case has holes.
- Low — selection by elimination. Conviction is thin. Be honest.
- Pass — race is genuinely unanalysable or data isn't there.

This is not shown to the user. Let it govern the tone of everything you write.

---
CRITICAL — HOW TO SCORE CONFIDENCE (confidenceScore: one decimal place, e.g. 6.8, 7.3, 8.1):
Your confidence score measures one thing only: how clearly your selection stands apart from its rivals in THIS race. Nothing to do with the prestige or media coverage of the race.

Score HIGH (7.0–10.0): one horse has a clear provable advantage — superior form, right ground, right trip, right weight, market agrees, money coming.
Score LOW (3.0–5.0): field is evenly matched, picking by elimination, no genuine standout.
Score PASS: genuinely unanalysable.

A Grade 1 with 8 evenly-matched top-class horses is LOW — score 3.0–4.0. A Class 5 handicap where one horse is 7lb clear on form and the trainer is targeting it specifically is HIGH — score 8.0+. The prestige of the race does NOT increase your score. Only the gap between your selection and its rivals.

DECIMAL PRECISION IS MANDATORY: Use one decimal place. Do I have 3 strong factors but one concern? Score 6.8, not 7. Do I have form, market, trainer AND jockey all aligned? Score 7.6, not 7. Total standout, no genuine dangers? Score 8.3, not 8. A round number means you did not think hard enough.

DEBUTANTS (no past results): if your leading selection has no race history, cap confidenceScore at 6.0 maximum regardless of market or trainer signals. You cannot verify the horse's ability and the market always backs its own. State clearly in pullQuote that the horse is unproven.

---
WEB SEARCH — run exactly 1 search:
1. "[name of your leading selection] [current year]" — recent news, health concerns, trainer quotes, notable absences or fitness questions about this specific horse. This search exists to surface what the form data cannot tell you: illness history, time off, stable confidence, trainer interview quotes.

DO NOT search for: tipster picks, market moves, form figures, going definitions, OR ratings, distance info, jockey bookings — all in the data provided. This search is specifically for horse-level news and health that the racecard cannot provide.

---
NH-SPECIFIC ANGLES TO LOOK FOR:

FORM & CAMPAIGN:
1. ★ Proven at today's exact trip — hurdles or fences, this distance specifically
2. Chase/hurdle switch — first time over fences is a significant unknown; first time back hurdling after chasing
3. Bounce risk — hard race last time, NH horses fade quickly on short turnarounds
4. ★ Prep race targeting — last run clearly a lead-in, trainer pointing at this for weeks
5. Weight drop or claim — carrying significantly less than last time

GOING & GROUND:
6. ★ Proven going preference — clear pattern of wins on specific ground (soft vs good)
7. Going change — significant shift from last run, positive or negative
8. Course configuration — sharp track vs galloping track, does this horse's style suit?

TRAINER & JOCKEY:
9. ★ Trainer course and festival record — some NH trainers target specific meetings every season
10. ★ Jockey booking significance — champion or conditional jockey booked, retained or outside engagement?
11. Jockey claim value — 3lb or 5lb allowance in a competitive handicap is a genuine edge
12. Conditional/amateur switch — notable step up or step down in jockey quality

WEIGHT & CLASS:
13. Penalty assessment — recent winner carrying extra, size depends on race type
14. Handicap mark — is this horse weighted to win? Has the mark dropped since last win?
15. Class drop — stepping back down after a run at higher level, often a positive sign

PACE & JUMPING:
16. ★ Pace scenario — front-runners in NH races dictate everything; who goes on?
17. Jumping ability — known safe jumper vs known sketchy jumper at this trip
18. ★ Last fence/hurdle tendencies — horses who idle in front are vulnerable; closers who peak late are valuable

NH INTELLIGENCE & EDGE SIGNALS:
19. ★ Race depth — identify the true number of genuine contenders; flag weak fields explicitly
20. Festival form — Cheltenham/Aintree/Punchestown form is worth a premium
21. ★ Seasonal timing — NH horses improve through the season; early season form vs late season peak
22. Stable in-form signal — yard running hot, multiple winners recently
23. ★ AGE & HEALTH QUESTIONS — NH horses aged 9+ rarely win at the top level; horses aged 8+ who have had significant health concerns, lengthy absences, or are returning from illness or injury carry serious question marks regardless of their form profile. If your leading selection is 8+ and the second web search surfaces ANY health concern, absence, intensive care, or stable worry — state this explicitly in the analysis, flag it in pullQuote, and reduce confidence accordingly. Do not pick an ageing horse with health questions over a younger, improving rival without explicitly acknowledging the risk to the user.

---
OUTPUT RULES:
- raceIntelligence: 3-4 sentences of sharp pre-race briefing — the things a serious punter knows that a casual one doesn't. How many genuine contenders? Where is the form concentrated? Key filter (going, class, trip). Do NOT lead with who other tipsters picked. Do NOT mention your selection.
- pullQuote: 3-4 sentences in your own voice explaining the case for your selection — jockey, going, form, trainer angle. Tell the full story so the user understands the pick. Do NOT name-drop publications or attribute to other tipsters.
- factors: exactly 4 entries — the 4 most compelling reasons, each starting with the category label: JOCKEY, GOING, FORM, TRAINER, CLASS, WEIGHT, COURSE, MARKET, TRIP — pick whichever 4 are most relevant
- horsesToWatch: 0–2 entries only, never padded
- runnerAnalysis: cover EVERY runner — 2-3 sentences for selection, 1-2 for watches, 1-2 honest sentences for the rest

Return this exact JSON:
{
  "raceIntelligence": "string — 3-4 sentences, your own sharp briefing",
  "confidenceScore": 7.3,
  "strongestSelection": {
    "horseName": "string",
    "odds": "string",
    "jockey": "string",
    "trainer": "string",
    "formFigures": "string",
    "confidenceLevel": "High | Medium | Low | Pass",
    "pullQuote": "string — 3-4 sentences in your own voice, the full case for this horse",
    "factors": ["CATEGORY label then explanation", "CATEGORY label then explanation", "CATEGORY label then explanation", "CATEGORY label then explanation"]
  },
  "horsesToWatch": [{"horseName":"string","odds":"string","jockey":"string","trainer":"string","formFigures":"string","excerpt":"1-2 sentences","factors":["f1","f2"]}],
  "runnerAnalysis": [{"horseName":"string","analysis":"1-3 sentences"}]
}`;

const FLAT_PROMPT = `You are a specialist flat race analyst for RacingEdge. Return ONLY a valid JSON object, no text before or after.

HOW TO USE THIS PROMPT — READ FIRST

The list of angles below is a research guide, not a checklist. You are not required to cover every point or label every section. Use only the angles that are actually relevant to this specific race. Prioritise depth on what matters over breadth across all categories. If three angles tell the strongest story, lead with those and ignore the rest.

If data on a point isn't available or you can't find it with confidence, skip it. Do not invent, infer or pad. Honest gaps are better than weak coverage. Let the race itself dictate which angles matter most.

If you don't love your strongest selection, say so. If the race is unanalysable, say so. If the best advice is to pass, recommend a pass. The user trusts honesty more than confidence. Never produce a default-confident pick when the case is fragile.

---
INTERNAL CALIBRATION — do this first, before writing anything

Before you write a single word of output, privately assess your confidence:
- High — you have a genuine strong case. The angles converge. You'd back this yourself.
- Medium — there is a selection but the case has holes. Worth noting but not piling on.
- Low — you have a selection by process of elimination but conviction is thin. Be honest.
- Pass — the race is genuinely unanalysable, too open, or data simply isn't there.

This is not shown to the user. Let it govern the tone of everything you write.

---
CRITICAL — HOW TO SCORE CONFIDENCE (confidenceScore: one decimal place, e.g. 6.8, 7.3, 8.1):
Your confidence score measures one thing only: how clearly your selection stands apart from its rivals in THIS race. It has nothing to do with the profile, prestige or media coverage of the race.

Score HIGH (7.0–10.0) when:
- One horse has a clear, provable advantage — superior OR, right going, right trip, proven at the course, jockey retained
- The market agrees and money has come
- The form gives you genuine conviction — not just process of elimination

Score LOW (3.0–5.0) when:
- The field is evenly matched — multiple horses with realistic winning chances
- You are picking the least-worst option rather than a genuine standout
- Wide-open race regardless of how high-profile it is

Score PASS when genuinely unanalysable.

IMPORTANT: A Group 1 with 10 evenly-matched top-class fillies is LOW — score 3.0–4.0. A Class 4 handicap where one horse is on a career-low OR, trainer in red-hot form, jockey retained, money coming — score 8.0–9.0. The prestige of the race, the volume of media coverage, or the quality of the field has NO bearing on confidenceScore. Only how far ahead your selection is from its rivals.

DECIMAL PRECISION IS MANDATORY: Use one decimal place. 3 strong factors but one concern? Score 6.8, not 7. Tipster signal AND market move AND trainer quote AND form all aligned? Score 7.6, not 7. Total standout — one horse the rest cannot live with? Score 8.3, not 8. A round number means you did not think hard enough. The decimal is where your genuine assessment lives.

DEBUTANTS (no past results): if your leading selection has no race history, cap confidenceScore at 6.0 maximum regardless of market or trainer signals. You cannot verify the horse's ability and the market always backs its own. State clearly in pullQuote that the horse is unproven.

---
WEB SEARCH — run exactly 1 search:
1. "[name of your leading selection] [current year]" — recent news, health concerns, trainer quotes, notable absences or fitness questions about this specific horse. This search exists to surface what the form data cannot tell you: illness history, time off, stable confidence, trainer interview quotes.

DO NOT search for: tipster picks, market moves, form figures, going definitions, OR ratings, distance info, jockey bookings — all in the data provided. This search is specifically for horse-level news and health that the racecard cannot provide.

---
FLAT-SPECIFIC ANGLES TO LOOK FOR:

FORM & CAMPAIGN:
1. ★ Proven at today's exact distance — win/place record at this trip specifically
2. Trip change — stepping up or dropping back, does form and pedigree back it?
3. Bounce risk — hard race or career-best last time, flat horses fade on quick turnaround
4. ★ Prep race targeting — last run clearly a lead-in, trainer pointing at this for weeks
5. Weight drop — carrying significantly less than last time in a similar race

GOING & GROUND:
6. ★ Proven going preference — clear pattern of wins on specific ground
7. Going change from last run — significant positive or negative shift
8. All-weather vs turf switch — untested on this surface, flag either way

TRAINER & JOCKEY:
9. ★ Trainer course and meeting record — some trainers target specific tracks every season
10. Trainer 2yo debut record — some excel first time out, others need a run
11. ★ Jockey booking significance — champion or top jockey booked for what looks a spare, retainer vs outside booking
12. Jockey wasting — declared significantly below their normal riding weight

WEIGHT & CLASS:
13. Penalty assessment — recent winner carrying a penalty, size depends on type of race won
14. Handicap debut — first time off an official rating, form hard to weigh
15. Conditions stakes — set weights often written to suit one horse, identify who

PEDIGREE & AGE:
16. ★ Sire's distance and going profile — bred for sprint or staying, what do offspring tell you?
17. Maternal stamina line — dam's sire distance profile, does the family get better with age and further?
18. First-time-out sire record — sharp enough to win on debut or clearly needs a run?
19. 2yo to 3yo improvement — sire or dam known for significant seasonal jump?
20. ★ Classic entries context — still in Guineas/Derby/Oaks entries, tells you exactly how connections rate them
21. ★ AGE CONCERN IN STAYING RACES — for any race over 1m2f, if your leading selection is aged 7+ while 4 or 5yo rivals with improving profiles are in the field, this is a significant red flag. Older stayers decline; young progressive horses have the advantage at staying trips and often represent a generational shift. If the second web search surfaces ANY health concern, absence, or question over the older horse's wellbeing — state this explicitly in pullQuote and raceIntelligence, and lower confidence accordingly. Never pick a 7+ year old over a younger improving rival without explicitly telling the user what the questions are.

FLAT INTELLIGENCE & EDGE SIGNALS:
21. ★ Race depth — identify the true number of genuine contenders, flag weak fields and unanalysable races explicitly
22. Weak maiden flag — pedigree narrows a 12-runner maiden to 2-3 genuine chances
23. ★ Godolphin and Coolmore targeting — their number one jockey on a specific horse is never accidental
24. Seasonal pattern repeat — trainer won this exact race last year with a similar profile horse

PACE:
25. ★ Pace scenario — how many confirmed front-runners declared? Natural leader or fight for the lead?
26. Horse's pace profile — front-runner, hold-up, or come-from-behind
27. Pace collapse risk — multiple front-runners likely to set a suicidal pace

---
OUTPUT RULES:
- raceIntelligence: 3-4 sentences of sharp pre-race briefing — the things a serious punter knows that a casual one doesn't. Cover: how many runners have a genuine winning chance; where the form is concentrated; any meaningful trainer or market pattern; one sentence on the key filter today (ground, class, trip). Do NOT lead with who other tipsters picked. Do NOT mention your selection.
- pullQuote: 3-4 sentences in your own voice — the full case for your selection. Cover jockey booking, going, form, trainer angle. Tell the full story so the user understands the pick without needing to expand anything. Do NOT name-drop publications or attribute to other tipsters.
- factors: exactly 4 entries — choose the 4 most compelling reasons. Each must start with the category label: JOCKEY, GOING, FORM, TRAINER, CLASS, DISTANCE, COURSE, MARKET, WEIGHT — pick whichever 4 are most relevant
- horsesToWatch: 0–2 entries only, never padded
- runnerAnalysis: cover EVERY runner — 2-3 sentences for selection, 1-2 for watches, 1-2 honest sentences for the rest

Return this exact JSON:
{
  "raceIntelligence": "string — 3-4 sentences, your own sharp briefing, no tipster attribution",
  "confidenceScore": 7.3,
  "strongestSelection": {
    "horseName": "string",
    "odds": "string",
    "jockey": "string",
    "trainer": "string",
    "formFigures": "string",
    "confidenceLevel": "High | Medium | Low | Pass",
    "pullQuote": "string — 3-4 sentences in your own voice, the full case for this horse, no publication name-drops",
    "factors": ["CATEGORY label then explanation", "CATEGORY label then explanation", "CATEGORY label then explanation", "CATEGORY label then explanation"]
  },
  "horsesToWatch": [{"horseName":"string","odds":"string","jockey":"string","trainer":"string","formFigures":"string","excerpt":"1-2 sentences","factors":["f1","f2"]}],
  "runnerAnalysis": [{"horseName":"string","analysis":"1-3 sentences"}]
}`;

const INTELLIGENCE_PROMPT = `You are RacingEdge AI — a daily racing intelligence analyst. Surface the sharpest intelligence items across today's card. These are the nuggets a serious punter would pay for — things NOT obvious from the form alone.

You will receive pre-computed data candidates built from the Racing API. Use these as your primary source.

WEB SEARCH RULES — follow exactly:
- USE web search for: TIPSTER CONSENSUS (always search), INTELLIGENCE (as needed for additional research)
- DO NOT use web search for: GROUND EDGE, COURSE AND DISTANCE, CLASS DROP, HOT YARD — the data for these is pre-computed from the Racing API and provided to you. Do not search for anything to validate or enrich these signals. Use only what is in the data provided.

There are 5 possible signal types. Return items based on genuine quality — never pad. Some days have no Ground Edge, Course and Distance or Hot Yard. Never force a signal that isn't there.

━━━ SPECIFIC HORSE CARDS (horseName = the horse, price and race time in header) ━━━

1. TIPSTER CONSENSUS
Always search for this. Search for today's NAP selections and top tips across the major free racing publications and tipster sources. Include in your search: Templegate, Newsboy, Robin Goodfellow, Sporting Life, Timeform, Racing Post free NAPs and community tips, At The Races, Racing TV, The Times racing tips, The Guardian racing tips, The Irish Times, IrishRacing.com, Paddypower NAPs table, HorseRacing.net, OLBG. From everything you find identify which horse has the strongest genuine consensus support today. Use your own judgement to assess credibility and weight of each source. Do not select a horse priced shorter than 1/2 as the consensus pick — if the strongest consensus is on a horse shorter than 1/2 identify the next most supported horse at a better price instead. Never mention any publication website tipster name or external source in the card output. The output must read as original Racing Edge intelligence only. Standard horse card — name, price, race time, CTA to that race.

2. GROUND EDGE
This signal is for Heavy or Yielding going jumps races only. If the user message shows 'GROUND EDGE: No qualifying ground specialists today' do not produce this card.
Do NOT use web search — all data is pre-computed from the Racing API and provided in the GROUND EDGE CANDIDATES section of this message.
Step 1 — QUALIFY: Read the GROUND EDGE CANDIDATES data — you will be given up to 3 candidates. For each candidate check their Heavy/Yielding strike rate versus their Good/Firm strike rate. The Heavy/Yielding strike rate must be meaningfully higher than Good/Firm. Include placed form not just wins — if wins are low check if the horse consistently finishes close on this ground.
Step 2 — RANK: For each candidate check if their Heavy/Yielding form includes runs at today's distance. If yes this strengthens the signal significantly. Weight runs from the last 12 months more heavily than older form.
Step 3 — SELECT: Using the GROUND EDGE CANDIDATES data and your full reasoning, compare the candidates against each other and select the single most compelling one in the context of today's specific race — the field they face, today's distance, today's conditions. If none of the candidates represent a genuine edge do not produce this card.
Do not select a horse priced shorter than 1/2. Standard horse card — name, price, race time, CTA to that race.

3. COURSE AND DISTANCE
Do NOT use web search — all data is pre-computed.
You have been given Course and Distance candidates with
their course record, recent form history, and full race
field for today.
Use everything — course record strength, how recent the
form is, recent overall form, race field, price — to judge
whether any candidate genuinely stands out in the context
of their specific race today.
If the horse has strong course form but poor recent form
overall, or is clearly outclassed by the field, do not card it.
Producing no card is always better than a weak card.
Do not select a horse priced shorter than 1/2.
If one candidate genuinely stands out, produce a standard
horse card with the specific course and distance edge stated.
intelligenceText: state why this horse stands out at this
course today, in context of the race. Grounded in data.

4. CLASS DROP
Do NOT use web search — all data is pre-computed.
You have been given Class Drop and OR Gap candidates with
their recent form and full race field.
Use everything — class drop size, OR advantage, recent form,
race field, price — to judge whether any candidate genuinely
stands out in the context of their specific race today.
If a candidate has poor recent form or is clearly outclassed
despite the signal, do not card it.
Producing no card is always better than a weak card.
If one candidate genuinely stands out, produce a standard
horse card with the specific edge stated clearly.
Do not select a horse priced shorter than 1/2. Empty slot
better than weak card.
intelligenceText: state the specific edge clearly — class
drop details or rating advantage or both. One sentence on
what this means in today's specific race context. Grounded
in data. No generic observations.

━━━ INFO/EMPOWERMENT CARDS (no specific pick in the header — give users the intelligence to decide) ━━━

5. HOT YARD
Do not produce Hot Yard cards in this response. Hot Yard cards are generated by a separate dedicated analysis call outside this prompt. Never return an item with signalType 'Hot Yard'. The IN-FORM TRAINER CANDIDATES section, if present in this message, is context only.

6. INTELLIGENCE
Use the FREE REIN INTELLIGENCE race card data in the user message. Find up to 3 horses not already covered by signals 1-5 with a genuine strong chance of winning today for any reason. No restrictions. Web search available. If nothing compelling produce no cards. signalType must be exactly Intelligence. Standard horse card format.

━━━ PRESENTATION RULES ━━━
- Venue prestige is not a factor. A feature meeting at a big track carries no more weight than a small evening card — judge every candidate purely on the strength of its own data. Do not let a meeting's profile, field size or media coverage influence which candidates you select.
- Never include Market Move as a signal type
- Never name publications — say "professional tipsters", "the tipster consensus", "the morning market"
- Every item must be grounded in a real, verifiable signal — no generic observations
- sigColor values: Tipster Consensus=#f97316, Ground Edge=#0ea5e9, Course and Distance=#6366f1, Class Drop=#f59e0b, Hot Yard=#10b981, Intelligence=#8b5cf6
- ctaDestination format: "race:{course}:{time}" — course must be the lowercase course name with spaces replaced by hyphens, time must be the HH:MM off time of the race. Example: "race:haydock:14:30" or "race:ascot:15:45". Exception: Hot Yard uses trainer:{trainer name} format instead. Intelligence signal cards must use the same race:{course}:{time} format as all other horse cards.
- CRITICAL — NO DUPLICATE HORSES: each horse may appear in ONE signal only. If a horse is your Tipster Consensus pick, that same horse cannot appear under any other type. Before returning, check every horseName — if any horse appears more than once, replace the duplicate with a different horse or a different signal type entirely.

Produce the best 3-6 cards from the combined pool of candidates across signals 1-6. Judge every candidate purely on genuine chance of winning today — regardless of which signal found the horse. Return ONLY a valid JSON array:
[
  {
    "signalType": "Tipster Consensus | Ground Edge | Course and Distance | Class Drop | Hot Yard | Intelligence",
    "sigColor": "#hex",
    "horseName": "Horse Name or Trainer Name or Venue — Going",
    "price": "odds e.g. 5/2 or empty string",
    "meta": "HH:MM Course · details or X runners today or X ground specialists",
    "intelligenceText": "2-3 sentences — specific, actionable, no publication names. intelligenceText for every signal must not exceed 80 words. This applies to all 6 signal types without exception. Count carefully — stop at 80 words. Do not mention any price or odds in intelligenceText. This applies to all 6 signal types: Tipster Consensus, Ground Edge, Course and Distance, Class Drop, Hot Yard and Intelligence. Prices change and must never appear in any card text.",
    "ctaLabel": "Analyse [Course] [HH:MM]",
    "ctaDestination": "race:{course}:{time}"
  }
]`;


const HORSE_FORM_PROMPT = `You are a horse racing form analyst for RacingEdge. Translate a horse's recent form into a specific, data-driven reading for a bettor — always in the context of TODAY's exact race conditions.

Return ONLY this JSON:
{
  "groundFit": "X wins from Y on [today going] — [plain English take on fit]",
  "distanceFit": "X runs at [today distance] — [plain English take on fit]",
  "courseHandedness": "[course wins/runs and left/right hand preference if detectable from data]",
  "formTrend": "[1 sentence on recent form direction — improving, declining, consistent]",
  "keyAngle": "[single most important thing about this horse for today's specific conditions]",
  "fitRating": "Ideal",
  "formParagraph": "100-150 word analyst reading written specifically for today's race. Open with the horse's overall profile in context of today (course, going, distance). Work through ground record (exact counts), distance record (exact counts), course record or handedness pattern, recent form direction, and close with the single sharpest angle for today. Weave it into flowing prose — not a list. Every sentence must be specific to this horse and today. No verdict language."
}

fitRating values: "Ideal" (ground+distance+course all align) | "Suits" (most factors positive) | "Neutral" (mixed picture) | "Question" (limited evidence) | "Concern" (negative patterns for today)

Rules:
- Use ONLY the data provided — no invention
- groundFit and distanceFit MUST include actual counts ("2 from 4 on Good" not "runs well on Good")
- If fewer than 2 runs on today's going: "Only X run(s) on [going] — limited evidence"
- courseHandedness: if no course runs, say "No previous run at [course]"
- Keep each individual field (groundFit, distanceFit, courseHandedness, formTrend, keyAngle) under 20 words
- formParagraph: 100-150 words, flowing prose, always names today's course, going, and distance with specific numbers throughout
- No outcome language ("will win", "should win", "suits", "ideal") in any field — facts and patterns only`;

const RACE_FORM_PROMPT = `You are a horse racing form analyst for RacingEdge. Given form profiles for all runners, write a race form overview for users who want to know which horses have the strongest form credentials for today's specific conditions.

Return ONLY this JSON:
{
  "formSummary": "2-3 sentences — which horses have best form fit for today and why. Focus on ground, distance, course — not just recent wins.",
  "topFormHorses": ["horse1", "horse2"],
  "keyAngles": ["angle 1 — specific and factual", "angle 2", "angle 3"]
}

Rules:
- topFormHorses: 1-2 horses max whose form FITS TODAY's conditions best (ground + distance + course)
- keyAngles: specific facts not generalities ("Only 2 runners proven on Soft" not "ground is key today")
- formSummary: write for a bettor — clear, direct, no waffle
- Do not name horses not in the provided data`;

async function generateHorseFormSummary(runner, raceContext, history) {
  const historyText = history.map(h =>
    `${h.date} | ${h.course} | ${h.dist} | ${h.going} | Pos: ${h.pos}/${h.ran} | SP: ${h.sp} | Jockey: ${h.jockey}`
  ).join('\n');

  const msg = `Horse: ${runner.horse || runner.name || 'Unknown'}
Today's race: ${raceContext.course} | ${raceContext.distance} | Going: ${raceContext.going} | Type: ${raceContext.type}

Last ${history.length} runs (most recent first):
${historyText}

Translate this horse's form for today's conditions.`;

  try {
    const { result, inputTokens, outputTokens, cacheReadTokens, cacheWriteTokens } = await callClaudeSimple(HORSE_FORM_PROMPT, msg, 700);
    return result ? { ...result, _tokens: { input: inputTokens, output: outputTokens, cacheRead: cacheReadTokens, cacheWrite: cacheWriteTokens } }
                  : { _failed: true, _tokens: { input: inputTokens, output: outputTokens, cacheRead: cacheReadTokens, cacheWrite: cacheWriteTokens } };
  } catch(e) { return null; }
}

async function generateRaceFormSummary(race, raceContext, horseSummaries) {
  const summaryText = horseSummaries.map(({ horseName, summary }) =>
    `${horseName}: Ground=${summary.groundFit || '-'} | Dist=${summary.distanceFit || '-'} | Fit=${summary.fitRating || '-'} | Key=${summary.keyAngle || '-'}`
  ).join('\n');

  const msg = `Race: ${raceContext.course} ${race.off_time || ''} | ${raceContext.distance} | Going: ${raceContext.going} | Type: ${raceContext.type}

Runner form profiles:
${summaryText}

Write the race form overview.`;

  try {
    const { result, inputTokens, outputTokens, cacheReadTokens, cacheWriteTokens } = await callClaudeSimple(RACE_FORM_PROMPT, msg, 400);
    if (result) return { ...result, _tokens: { input: inputTokens, output: outputTokens, cacheRead: cacheReadTokens, cacheWrite: cacheWriteTokens } };
    return null;
  } catch(e) { return null; }
}

// ── ANALYSIS CALLS ────────────────────────────────────────────────────────────

async function callClaude(systemPrompt, userMessage, tokens, noSearch, maxSearches) {
  const body = {
    model: 'claude-sonnet-4-6',
    max_tokens: tokens || 6000,
    system: systemPrompt,
    messages: [{ role: 'user', content: userMessage }]
  };
  if (!noSearch) body.tools = [{ type: 'web_search_20250305', name: 'web_search', max_uses: maxSearches || 2 }];
  const resp = await apiPost('api.anthropic.com', '/v1/messages', {
    'x-api-key': ANTHROPIC_KEY,
    'anthropic-version': '2023-06-01',
    'anthropic-beta': 'web-search-2025-03-05'
  }, body);

  const usage = resp.usage || {};
  const content = resp.content || [];
  const text = content.filter(b => b.type === 'text').map(b => b.text).join('\n');
  const webSearchCount = content.filter(b => (b.type === 'tool_use' || b.type === 'server_tool_use') && b.name === 'web_search').length;
  const searchQueries = content
    .filter(b => (b.type === 'tool_use' || b.type === 'server_tool_use') && b.name === 'web_search')
    .map(b => (b.input && b.input.query) || '');
  const searchResultBlocks = content.filter(b => b.type === 'web_search_tool_result');
  if (searchResultBlocks.length) {
    const today = new Date().toISOString().slice(0, 10);
    redisSet('debug:websearch:' + today + ':' + Date.now(), {
      queries: searchQueries,
      results: searchResultBlocks.map(b => ({ type: b.type, content: b.content }))
    }).catch(() => {});
  }
  return {
    text,
    inputTokens: usage.input_tokens || 0,
    outputTokens: usage.output_tokens || 0,
    cacheReadTokens: usage.cache_read_input_tokens || 0,
    cacheWriteTokens: usage.cache_creation_input_tokens || 0,
    webSearchCount,
    searchQueries
  };
}

function normaliseHorseName(s) {
  return (s || '').toLowerCase().replace(/[^a-z0-9]/g, '');
}

// A naive indexOf/lastIndexOf extraction breaks whenever the model appends any
// trailing content after the JSON value (seen live: "Unexpected non-whitespace
// character after JSON" — broke the Intelligence parse and wiped the day's cards
// twice before this was written). Scans for the first top-level balanced value
// starting at openChar instead, correctly ignoring open/close chars inside string
// literals, and stops at the true matching closeChar regardless of what follows.
// Shared by extractJsonArray (arrays) and parseJson (objects) — AUDIT-DAILY-INTELLIGENCE.md,
// finding S3 flagged parseJson and callClaudeSimple as still using the old naive
// pattern after only the array case was hardened.
function extractBalancedJson(text, openChar, closeChar) {
  const clean = (text || '').replace(/```json\s*/gi, '').replace(/```\s*/gi, '').trim();
  const start = clean.indexOf(openChar);
  if (start === -1) return null;
  let depth = 0, inStr = false, esc = false;
  for (let i = start; i < clean.length; i++) {
    const c = clean[i];
    if (inStr) {
      if (esc) { esc = false; }
      else if (c === '\\') { esc = true; }
      else if (c === '"') { inStr = false; }
      continue;
    }
    if (c === '"') { inStr = true; continue; }
    if (c === openChar) depth++;
    else if (c === closeChar) {
      depth--;
      if (depth === 0) return JSON.parse(clean.substring(start, i + 1));
    }
  }
  return null;
}

function extractJsonArray(text) {
  return extractBalancedJson(text, '[', ']');
}

// Data-verified signals (concrete computed evidence) outrank the free-rein
// Intelligence catch-all when two cards collide on the same race or meeting.
const SIGNAL_STRENGTH_PRIORITY = { 'Tipster Consensus': 1, 'Course and Distance': 2, 'Class Drop': 3, 'Ground Edge': 4, 'Hot Yard': 5, 'Intelligence': 6 };

function raceKeyAndCourse(item) {
  const dest = item.ctaDestination || '';
  if (dest.indexOf('race:') !== 0) return null;
  const parts = dest.substring('race:'.length).split(':');
  const course = parts[0] || '';
  return { raceKey: course + ':' + parts.slice(1).join(':'), course: course };
}

// Product rules applied identically to today's and tomorrow's card sets:
// 1. One card per race — on collision, keep the stronger (data-verified) signal.
// 2. Max 3 cards per meeting when qualifying candidates exist at other meetings.
// Both drops are logged into warningsOut so they surface in the build report.
function dedupeRaceCollisionsAndCapPerMeeting(items, warningsOut) {
  if (!items || !items.length) return items;

  const byRace = {};
  let deduped = [];
  items.forEach(function(item) {
    const info = raceKeyAndCourse(item);
    if (!info) { deduped.push(item); return; }
    const existing = byRace[info.raceKey];
    if (!existing) { byRace[info.raceKey] = item; deduped.push(item); return; }
    const existingP = SIGNAL_STRENGTH_PRIORITY[existing.signalType] || 99;
    const newP = SIGNAL_STRENGTH_PRIORITY[item.signalType] || 99;
    if (newP < existingP) {
      deduped = deduped.filter(function(x) { return x !== existing; });
      warningsOut.push('Dropped duplicate-race card: ' + existing.horseName + ' (' + existing.signalType + ') at ' + info.raceKey + ' — kept ' + item.horseName + ' (' + item.signalType + ')');
      byRace[info.raceKey] = item;
      deduped.push(item);
    } else {
      warningsOut.push('Dropped duplicate-race card: ' + item.horseName + ' (' + item.signalType + ') at ' + info.raceKey + ' — kept ' + existing.horseName + ' (' + existing.signalType + ')');
    }
  });

  const byCourse = {};
  deduped.forEach(function(item) {
    const info = raceKeyAndCourse(item);
    if (!info) return;
    if (!byCourse[info.course]) byCourse[info.course] = [];
    byCourse[info.course].push(item);
  });
  const coursesWithCards = Object.keys(byCourse);
  if (coursesWithCards.length > 1) {
    const toDrop = new Set();
    coursesWithCards.forEach(function(course) {
      const list = byCourse[course];
      if (list.length <= 3) return;
      list.slice().sort(function(a, b) {
        return (SIGNAL_STRENGTH_PRIORITY[a.signalType] || 99) - (SIGNAL_STRENGTH_PRIORITY[b.signalType] || 99);
      }).slice(3).forEach(function(item) {
        toDrop.add(item);
        warningsOut.push('Dropped card over 3-per-meeting cap: ' + item.horseName + ' (' + item.signalType + ') at ' + course);
      });
    });
    if (toDrop.size) deduped = deduped.filter(function(item) { return !toDrop.has(item); });
  }

  return deduped;
}

// Validates and repairs race:{course}:{time} ctaDestinations against the real
// racecard data before cards are saved (AUDIT-DAILY-INTELLIGENCE.md, finding C3
// — the model is otherwise trusted to copy the time correctly with nothing
// checking it, which produced real off-by-a-few-minutes cards like 17:20 vs the
// actual 17:25). Matches primarily by horseName — a horse runs in exactly one
// real race that day, so this is the most reliable anchor — and repairs the
// course/time to match. Falls back to course + nearest real off-time if the
// horse name can't be matched (formatting mismatch, trainer-style cards, etc).
// A card that matches no real race at all is dropped rather than saved with an
// unverified destination; the drop is logged to warningsOut either way.
function raceTime(race) {
  if (!race.off_dt) return race.off_time || '';
  const m = race.off_dt.match(/T(\d{2}):(\d{2})/);
  return m ? m[1] + ':' + m[2] : race.off_time || '';
}

function validateAndRepairCtaDestinations(items, flatRaces, warningsOut) {
  if (!items || !items.length) return items;

  function normCourse(n) {
    return (n || '').toLowerCase().replace(/\([^)]*\)/g, ' ').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  }
  function normHorse(n) {
    return (n || '').toLowerCase().replace(/[^a-z0-9]/g, '');
  }
  function timeToMinutes(t) {
    const m = (t || '').match(/^(\d{1,2}):(\d{2})$/);
    return m ? parseInt(m[1], 10) * 60 + parseInt(m[2], 10) : null;
  }

  const horseToRace = {};
  const racesByCourse = {};
  (flatRaces || []).forEach(function(race) {
    const course = race.course || '';
    const time = raceTime(race);
    if (!course || !time) return;
    const cKey = normCourse(course);
    if (!racesByCourse[cKey]) racesByCourse[cKey] = [];
    racesByCourse[cKey].push({ course: course, time: time });
    (race.runners || []).forEach(function(r) {
      const hName = r.horse || r.name || '';
      if (hName) horseToRace[normHorse(hName)] = { course: course, time: time };
    });
  });

  const kept = [];
  items.forEach(function(item) {
    const dest = item.ctaDestination || '';
    if (dest.indexOf('race:') !== 0) { kept.push(item); return; } // trainer: cards etc — nothing to validate

    const parts = dest.substring('race:'.length).split(':');
    const destCourse = parts[0] || '';
    const destTime = parts.slice(1).join(':');

    const byHorse = horseToRace[normHorse(item.horseName)];
    if (byHorse) {
      const correctDest = 'race:' + normCourse(byHorse.course) + ':' + byHorse.time;
      if (correctDest !== dest) {
        warningsOut.push('Repaired ctaDestination for ' + item.horseName + ': ' + dest + ' -> ' + correctDest);
        item.ctaDestination = correctDest;
      }
      // ctaLabel is written independently by the model and never checked against
      // real race data — it can carry a different time than ctaDestination even
      // when the destination itself is already correct. Always resync it here so
      // the button text can never diverge from where it actually navigates.
      item.ctaLabel = 'Analyse ' + byHorse.course + ' ' + byHorse.time;
      kept.push(item);
      return;
    }

    const candidates = racesByCourse[normCourse(destCourse)];
    if (candidates && candidates.length) {
      const wantMin = timeToMinutes(destTime);
      let best = candidates[0], bestDiff = Infinity;
      candidates.forEach(function(c) {
        const cMin = timeToMinutes(c.time);
        const diff = (wantMin !== null && cMin !== null) ? Math.abs(cMin - wantMin) : Infinity;
        if (diff < bestDiff) { bestDiff = diff; best = c; }
      });
      const correctDest = 'race:' + normCourse(best.course) + ':' + best.time;
      if (correctDest !== dest) {
        warningsOut.push('Repaired ctaDestination by course+nearest-time for ' + item.horseName + ': ' + dest + ' -> ' + correctDest);
        item.ctaDestination = correctDest;
      }
      item.ctaLabel = 'Analyse ' + best.course + ' ' + best.time;
      kept.push(item);
      return;
    }

    warningsOut.push('Dropped card with unverifiable ctaDestination: ' + item.horseName + ' (' + item.signalType + ') — ' + dest + ' does not match any real race today');
  });

  return kept;
}

async function callClaudeSimple(systemPrompt, userMessage, maxTokens) {
  const resp = await apiPost('api.anthropic.com', '/v1/messages', {
    'x-api-key': ANTHROPIC_KEY,
    'anthropic-version': '2023-06-01'
  }, {
    model: 'claude-sonnet-4-6',
    max_tokens: maxTokens,
    system: systemPrompt,
    messages: [{ role: 'user', content: userMessage }]
  });
  const usage = resp.usage || {};
  const text = (resp.content || []).filter(b => b.type === 'text').map(b => b.text).join('\n');
  const result = extractBalancedJson(text, '{', '}');
  return {
    result,
    inputTokens: usage.input_tokens || 0,
    outputTokens: usage.output_tokens || 0,
    cacheReadTokens: usage.cache_read_input_tokens || 0,
    cacheWriteTokens: usage.cache_creation_input_tokens || 0
  };
}


async function analyseRace(race, NH, tipsterContext) {
  const raceRunners = (race.runners || []).filter(r => !r.is_non_runner);
  const date = new Date().toISOString().slice(0, 10);

  // Fetch form history for all runners in parallel (Racing API Pro horses endpoint)
  const formResults = await Promise.allSettled(
    raceRunners.map(r => r.horse_id
      ? fetchHorseHistory(r.horse_id).then(h => ({ id: r.horse_id, name: r.horse || r.name || 'Unknown', history: h }))
      : Promise.resolve({ id: null, name: r.horse || r.name || 'Unknown', history: [] })
    )
  );
  const formByName = {};
  formResults.filter(r => r.status === 'fulfilled').forEach(r => { formByName[r.value.name] = r.value.history; });

  const runners = raceRunners.map(r => {
    const name = r.horse || r.name || 'Unknown';
    const oddsArr = Array.isArray(r.odds) ? r.odds : (Array.isArray(r.price) ? r.price : null);
    const price = oddsArr ? (oddsArr.find(o => o.fractional && !(o.bookmaker||'').toLowerCase().includes('exchange')) || oddsArr[0] || {}).fractional || 'SP' : (r.odds && typeof r.odds === 'string' ? r.odds : 'SP');

    const history = formByName[name] || [];
    const historyText = history.length
      ? history.slice(0, 4).map(h => `  ${h.date} | ${h.course} | ${h.dist} | ${h.going} | Pos: ${h.pos}/${h.ran} | SP: ${h.sp} | Jockey: ${h.jockey}`).join('\n')
      : '  No past results available';

    return `${name} | J: ${r.jockey||''} | T: ${r.trainer||''} | Odds: ${price} | Form: ${r.form||'-'} | OR: ${r.ofr||r.official_rating||'-'} | Age: ${r.age||'-'}\n${historyText}`;
  }).join('\n\n');

  const tipsterSection = tipsterContext
    ? `\nTIPSTER CONSENSUS (from morning intelligence sweep):\n${tipsterContext}\n`
    : '';

  const msg = `Analyse this ${NH ? 'National Hunt' : 'flat'} race. Full Racing API form history is provided for each runner. You MUST run your 1 web search for horse-level news on your leading selection only — search "[name of leading selection] [current year]" for recent news, health concerns or trainer quotes.

Meeting: ${race.course}
Date: ${date}
Race: ${race.race_name} (${race.off_time})
Going: ${race.going || 'Good'}
Distance: ${race.distance || ''}
Prize: ${race.prize || ''}
Class: ${race.race_class || ''}
${tipsterSection}
RUNNERS (live form history from Racing API):
${runners}

Return ONLY the JSON object.`;

  const { text, inputTokens, outputTokens, cacheReadTokens, cacheWriteTokens, webSearchCount } = await callClaude(NH ? NH_PROMPT : FLAT_PROMPT, msg, 6000, false, 1);
  return { result: parseJson(text), inputTokens, outputTokens, cacheReadTokens, cacheWriteTokens, webSearchCount };
}

async function generateIntelligence(racecards) {
  const date = new Date().toISOString().slice(0, 10);
  const SOFT_RE = /soft|heavy|yield|slow/i;

  function extractPrice(r) {
    const oddsArr = Array.isArray(r.odds) ? r.odds : [];
    return (oddsArr.find(function(o) { return o.fractional && !(o.bookmaker||'').toLowerCase().includes('exchange'); }) || oddsArr[0] || {}).fractional || 'SP';
  }

  function milesFurlongs(distStr) {
    const s = String(distStr || '');
    const miles = (s.match(/(\d+)m/) || [])[1];
    const furlongs = (s.match(/(\d+)f/) || [])[1];
    return (miles ? parseInt(miles, 10) : 0) * 8 + (furlongs ? parseInt(furlongs, 10) : 0);
  }

  // Pre-compute in-form trainer candidates (25%+ SR, min 5 runs last 14 days)
  const trainerFormMap = {};
  racecards.forEach(function(race) {
    const t = raceTime(race);
    (race.runners || []).filter(function(r) { return !r.is_non_runner; }).forEach(function(r) {
      const t14 = r.trainer_14_days || {};
      const runs = t14.runs || 0, wins = t14.wins || 0, pct = parseFloat(t14.percent) || 0;
      if (runs >= 5 && pct >= 25 && r.trainer) {
        if (!trainerFormMap[r.trainer]) trainerFormMap[r.trainer] = { trainer: r.trainer, trainer_id: r.trainer_id || '', runs: runs, wins: wins, pct: pct, horses: [] };
        trainerFormMap[r.trainer].horses.push({
          name: r.horse || r.name || 'Unknown',
          horse_id: r.horse_id || '',
          course: race.course,
          time: t,
          jockey: r.jockey || '?',
          price: extractPrice(r),
          or: r.ofr || r.official_rating || '-',
          field: (race.runners || []).filter(function(x) { return !x.is_non_runner && x !== r; }).map(function(x) {
            return (x.horse || x.name || 'Unknown') + ' ' + extractPrice(x) + ' OR' + (x.ofr || x.official_rating || '-');
          }).join(', ')
        });
      }
    });
  });
  // 60-day baseline comparison — a trainer only counts as HOT if their current 14-day
  // strike rate is a genuine spike (25%+ AND at least 50% above their 60-day norm),
  // not a small-sample blip. One Racing API call per candidate trainer; a failed
  // call skips that trainer only — the build continues regardless.
  const sixtyDaysAgo = new Date(Date.now() - 60 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
  const trainersToRemove = [];
  const hotYardBaselineErrors = [];
  for (const trainerName of Object.keys(trainerFormMap)) {
    const entry = trainerFormMap[trainerName];
    if (!entry.trainer_id) {
      delete trainerFormMap[trainerName];
      continue;
    }
    try {
      const data = await apiGet('api.theracingapi.com',
        '/v1/trainers/' + encodeURIComponent(entry.trainer_id) + '/results?start_date=' + sixtyDaysAgo + '&end_date=' + date,
        { 'Authorization': 'Basic ' + RACING_AUTH }
      );
      await new Promise(resolve => setTimeout(resolve, 200));
      // Trainer results endpoint returns a flat list — one entry per race result,
      // position at the top level (not race objects with a nested runners array).
      const results = data.results || [];
      const baselineRuns = results.length;
      const baselineWins = results.filter(function(result) { return String(result.position) === '1'; }).length;
      const baseline60 = baselineRuns > 0 ? Math.round(baselineWins / baselineRuns * 100) : 0;
      entry.baseline60 = baseline60;

      // No results or a zero baseline just means the spike can't be validated —
      // keep the trainer (isHot below only requires pct >= 25) with baseline60 = 0.
      if (!baselineRuns || !baseline60) {
        entry.baseline60 = 0;
        continue;
      }

      const isHot = entry.pct >= 25;
      if (!isHot) trainersToRemove.push(trainerName);
    } catch (e) {
      // Baseline could not be fetched — trainer cannot be assessed, remove entirely.
      console.log('[daily-build] Hot Yard baseline fetch failed for trainer ' + trainerName + ': ' + e.message);
      hotYardBaselineErrors.push('Hot Yard baseline fetch failed for trainer ' + trainerName + ': ' + e.message);
      trainersToRemove.push(trainerName);
    }
  }
  trainersToRemove.forEach(function(trainerName) { delete trainerFormMap[trainerName]; });

  const trainerFormCandidates = Object.values(trainerFormMap).sort(function(a, b) {
    const ratioA = a.baseline60 ? a.pct / a.baseline60 : 0;
    const ratioB = b.baseline60 ? b.pct / b.baseline60 : 0;
    return ratioB - ratioA;
  }).slice(0, 5);

  // Pre-compute ground edge candidates: Heavy/Yielding jumps meetings only, grouped by venue
  const GROUND_RE = /heavy|yield/i;
  const groundEdgeByVenue = {};
  const heavyMeetings = racecards.filter(function(race) {
    return GROUND_RE.test(race.going || '') && isJumps(race.race_name, race.type);
  });

  let groundEdgeSkippedCount = 0;
  for (let mi = 0; mi < Math.min(heavyMeetings.length, 12); mi++) {
    const race = heavyMeetings[mi];
    const venue = race.course || 'Unknown';
    const runners = (race.runners || []).filter(function(r) { return !r.is_non_runner && r.horse_id; });
    for (let ri = 0; ri < Math.min(runners.length, 15); ri++) {
      const runner = runners[ri];
      const history = await fetchHorseHistory(runner.horse_id);
      if (!history.length) { groundEdgeSkippedCount++; continue; }

      const groundRuns = history.filter(function(h) { return GROUND_RE.test(h.going || ''); });
      const goodRuns = history.filter(function(h) { return !GROUND_RE.test(h.going || '') && (h.going || '').trim(); });
      const groundWins = groundRuns.filter(function(h) { return String(h.pos) === '1'; }).length;
      const goodWins = goodRuns.filter(function(h) { return String(h.pos) === '1'; }).length;

      // Quality bar: must have won on heavy/yielding, and either 2+ wins or 33%+ SR
      if (groundRuns.length >= 2 && groundWins >= 1) {
        const groundSR = Math.round(groundWins / groundRuns.length * 100);
        const goodSR = goodRuns.length ? Math.round(goodWins / goodRuns.length * 100) : 0;
        if (groundWins >= 2 || groundSR >= 33) {
          if (!groundEdgeByVenue[venue]) groundEdgeByVenue[venue] = { venue: venue, going: race.going, horses: [] };
          groundEdgeByVenue[venue].horses.push({
            horse: runner.horse || runner.name || 'Unknown',
            price: extractPrice(runner),
            time: raceTime(race),
            raceName: race.race_name || '',
            groundSR: groundSR,
            groundWins: groundWins,
            groundRuns: groundRuns.length,
            groundRecord: groundWins + ' wins from ' + groundRuns.length + ' on heavy/yielding (' + groundSR + '% SR)',
            goodRecord: goodRuns.length ? (goodWins + ' wins from ' + goodRuns.length + ' on good/firm (' + goodSR + '% SR)') : 'No runs on good/firm'
          });
        }
      }
    }
  }

  // Ground Edge: top 3 horses across all venues (ranked by groundWins, then groundSR)
  const _groundEdgeAll = [];
  Object.values(groundEdgeByVenue).forEach(function(v) {
    v.horses.forEach(function(h) {
      _groundEdgeAll.push(Object.assign({}, h, { venue: v.venue, going: v.going }));
    });
  });
  _groundEdgeAll.sort(function(a, b) {
    if (b.groundWins !== a.groundWins) return b.groundWins - a.groundWins;
    return b.groundSR - a.groundSR;
  });
  const groundEdgeCandidates = _groundEdgeAll.slice(0, 3);

  // Pre-compute course & distance candidates: 2+ wins at today's specific course, 33%+ course win rate
  const courseDistanceCandidates = [];
  for (let mi = 0; mi < racecards.length; mi++) {
    const race = racecards[mi];
    const course = race.course || '';
    const runners = (race.runners || []).filter(function(r) { return !r.is_non_runner && r.horse_id; });
    for (let ri = 0; ri < runners.length; ri++) {
      const runner = runners[ri];
      const history = await fetchHorseHistory(runner.horse_id);
      if (!history.length) continue;

      const courseRuns = history.filter(function(h) { return (h.course || '').toLowerCase().trim().replace(/\s*\([^)]*\)/g, '').trim() === (course || '').toLowerCase().trim().replace(/\s*\([^)]*\)/g, '').trim(); });
      const courseTopTwo = courseRuns.filter(function(h) { return String(h.pos) === '1' || String(h.pos) === '2'; });
      const courseTopTwoRate = courseRuns.length ? Math.round(courseTopTwo.length / courseRuns.length * 100) : 0;
      const meetsTopTwoRule = courseTopTwo.length >= 2 && courseTopTwoRate >= 33;

      const courseWins = courseRuns.filter(function(h) { return String(h.pos) === '1'; });
      const meetsAnyWinRule = courseWins.length >= 1;

      if (!meetsTopTwoRule && !meetsAnyWinRule) continue;

      const winAtTodaysDistance = courseTopTwo.some(function(h) { return milesFurlongs(h.dist) === milesFurlongs(race.distance); });
      const topTwoGoings = courseTopTwo.reduce(function(acc, h) {
        if (h.going && acc.indexOf(h.going) === -1) acc.push(h.going);
        return acc;
      }, []);

      courseDistanceCandidates.push({
        horse: runner.horse || runner.name || 'Unknown',
        horse_id: runner.horse_id,
        price: extractPrice(runner),
        time: raceTime(race),
        course: course,
        courseTopTwo: courseTopTwo.length,
        courseRuns: courseRuns.length,
        courseTopTwoRate: courseTopTwoRate,
        topTwoDates: courseTopTwo.map(function(h) { return h.date; }).join(', '),
        winAtTodaysDistance: winAtTodaysDistance,
        topTwoGoings: topTwoGoings,
        field: (race.runners||[]).filter(function(x){
          return !x.is_non_runner && x!==runner;
        }).map(function(x){
          return (x.horse||x.name||'Unknown')+' '+extractPrice(x)+' OR'+(x.ofr||x.official_rating||'-');
        }).join(', ')
      });
    }
  }
  courseDistanceCandidates.sort(function(a, b) {
    if (b.courseTopTwo !== a.courseTopTwo) return b.courseTopTwo - a.courseTopTwo;
    return b.courseTopTwoRate - a.courseTopTwoRate;
  });

  // Pre-compute class drop candidates: horse racing today at least 2 classes lower
  // (numerically higher class number) than their most recent class-recorded run
  const classDropCandidates = [];
  let classDropSkippedCount = 0;
  function parseClassNum(classStr) {
    if (!classStr || !String(classStr).startsWith('Class')) return null;
    const n = parseInt(String(classStr).slice(-1), 10);
    return isNaN(n) ? null : n;
  }
  for (let mi = 0; mi < racecards.length; mi++) {
    const race = racecards[mi];
    const todayClassNum = parseClassNum(race.race_class);
    if (todayClassNum === null) continue;

    const runners = (race.runners || []).filter(function(r) { return !r.is_non_runner && r.horse_id; });
    for (let ri = 0; ri < runners.length; ri++) {
      const runner = runners[ri];
      const history = await fetchHorseHistory(runner.horse_id);
      const validClassRuns = history.filter(function(h) { return parseClassNum(h.race_class) !== null; });
      if (validClassRuns.length === 0 && history.length > 0) {
        classDropSkippedCount++;
      }
      if (validClassRuns.length < 2) continue;

      const lastClassRun = history.find(function(h) { return parseClassNum(h.race_class) !== null; });
      if (!lastClassRun) continue;

      const lastRunClassNum = parseClassNum(lastClassRun.race_class);
      if (lastRunClassNum === null) continue;
      if (lastRunClassNum > 3) continue;

      const classDrop = todayClassNum - lastRunClassNum;
      if (classDrop < 1) continue;

      classDropCandidates.push({
        horse: runner.horse || runner.name || 'Unknown',
        horse_id: runner.horse_id,
        trainer: runner.trainer || '',
        price: extractPrice(runner),
        time: raceTime(race),
        course: race.course || '',
        todayClass: String(race.race_class),
        lastRunClass: String(lastClassRun.race_class),
        classDrop: classDrop,
        field: (race.runners||[]).filter(function(x){
          return !x.is_non_runner && x!==runner;
        }).map(function(x){
          return (x.horse||x.name||'Unknown')+' '+extractPrice(x)+' OR'+(x.ofr||x.official_rating||'-');
        }).join(', ')
      });
    }
  }
  classDropCandidates.sort(function(a, b) { return b.classDrop - a.classDrop; });

  // Pre-compute OR gap candidates: top-rated horse with a significant official rating advantage over the second-best in the race
  const orGapCandidates = [];
  for (let mi = 0; mi < racecards.length; mi++) {
    const race = racecards[mi];
    const runners = (race.runners || []).filter(function(r) { return !r.is_non_runner && r.horse_id; });

    const ratedRunners = runners.map(function(r) {
      return { runner: r, orValue: parseFloat(r.ofr || r.official_rating || 0) };
    }).filter(function(x) { return x.orValue > 0; });

    if (ratedRunners.length < 2) continue;

    ratedRunners.sort(function(a, b) { return b.orValue - a.orValue; });

    const firstOR = ratedRunners[0].orValue;
    const secondOR = ratedRunners[1].orValue;
    const orGap = firstOR - secondOR;

    if (orGap >= 8) {
      const runner = ratedRunners[0].runner;
      orGapCandidates.push({
        horse: runner.horse || runner.name || 'Unknown',
        horse_id: runner.horse_id,
        trainer: runner.trainer || '',
        price: extractPrice(runner),
        time: raceTime(race),
        course: race.course || '',
        or: firstOR,
        secondOr: secondOR,
        orGap: orGap,
        field: (race.runners||[]).filter(function(x){
          return !x.is_non_runner && x!==runner;
        }).map(function(x){
          return (x.horse||x.name||'Unknown')+' '+extractPrice(x)+' OR'+(x.ofr||x.official_rating||'-');
        }).join(', ')
      });
    }
  }
  orGapCandidates.sort(function(a, b) { return b.orGap - a.orGap; });
  orGapCandidates.splice(5);

  // Build structured message
  const meetingsSummary = racecards.map(function(r) {
    return r.course + ' ' + raceTime(r) + ' — ' + (r.race_name || '') + ' (' + (r.distance || '') + ') Going: ' + (r.going || 'Good');
  }).join('\n');

  const freeReinSummary = racecards.map(function(race) {
    const header = raceTime(race) + ' ' + race.course + ' ' + (race.distance || '') + ' ' + (race.going || '') + ' ' + (race.race_class || '');
    const runnerLines = (race.runners || []).filter(function(r) { return !r.is_non_runner; }).map(function(r) {
      return '  ' + r.horse + ' | J: ' + (r.jockey || '') + ' | T: ' + (r.trainer || '') + ' | Form: ' + (r.form || '-') + ' | OR: ' + (r.ofr || '-') + ' | Price: ' + extractPrice(r);
    });
    return [header].concat(runnerLines).join('\n');
  }).join('\n');

  let msg = 'Today is ' + date + '.\n\nTODAY\'S RACES:\n' + meetingsSummary + '\n\n';

  if (groundEdgeCandidates.length) {
    msg += 'GROUND EDGE CANDIDATES (high conviction individual ground specialists):\n';
    groundEdgeCandidates.forEach(function(h) {
      msg += '\n• ' + h.horse + ' | ' + h.venue + ' ' + h.time + ' | Going: ' + h.going + ' | Price: ' + h.price + '\n';
      msg += '  Ground record: ' + h.groundRecord + '\n';
      msg += '  Good/firm record: ' + h.goodRecord + '\n';
    });
    msg += '\n';
  } else {
    msg += 'GROUND EDGE: No qualifying ground specialists today. Do NOT produce a Ground Edge signal.\n\n';
  }

  const CD_MONTHS = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
  if (courseDistanceCandidates.length) {
    msg += 'COURSE AND DISTANCE CANDIDATES (2+ top 2 finishes at today\'s course, 33%+ course win rate):\n';
    for (const c of courseDistanceCandidates.slice(0, 5)) {
      msg += '\n• ' + c.horse + ' | ' + c.course + ' ' + c.time + ' | Price: ' + c.price + '\n';
      msg += '  Course record: ' + c.courseTopTwo + ' top 2 finishes from ' + c.courseRuns + ' at ' + c.course + ' (' + c.courseTopTwoRate + '% SR) | Top 2 dates: ' + c.topTwoDates + '\n';
      msg += '  Top 2 finish at today\'s exact distance: ' + (c.winAtTodaysDistance ? 'Yes' : 'No') + '\n';
      msg += '  Going on course form: ' + (c.topTwoGoings.length ? c.topTwoGoings.join(', ') : 'Unknown') + '\n';
      msg += '  Field: ' + (c.field || 'unavailable') + '\n';
      if (c.horse_id) {
        try {
          const hist = await redisGet('form:history:' + c.horse_id + ':' + date);
          if (Array.isArray(hist) && hist.length) {
            msg += '  Last 6 runs:\n' + hist.slice(0, 6).map(function(run) {
              const p = String(run.date || '').split('-');
              const runDate = p.length === 3 ? (p[2] + ' ' + (CD_MONTHS[parseInt(p[1], 10) - 1] || p[1]) + ' ' + p[0]) : (run.date || '');
              return '    ' + runDate + ' | ' + (run.course || '') + ' | ' + (run.dist || '') + ' | ' + (run.going || '') + ' | ' + (run.pos || '-') + '/' + (run.ran || 0) + ' | ' + (run.sp || '');
            }).join('\n') + '\n';
          }
        } catch (ce) { /* missing history is skipped silently — never errors */ }
      }
    }
    msg += '\n';
  } else {
    msg += 'COURSE AND DISTANCE: No qualifying horses today. Do NOT produce this signal.\n\n';
  }

  if (classDropCandidates.length) {
    msg += 'CLASS DROP CANDIDATES (horses from Class 1, 2 or 3 dropping at least 1 class today):\n';
    for (const c of classDropCandidates.slice(0, 5)) {
      msg += '\n• ' + c.horse + ' | ' + c.trainer + ' | ' + c.course + ' ' + c.time + ' | Price: ' + c.price + '\n';
      msg += '  Last run: ' + c.lastRunClass + ' → Today: ' + c.todayClass + ' (drop of ' + c.classDrop + ' classes)\n';
      msg += '  Field: ' + (c.field || 'unavailable') + '\n';
      if (c.horse_id) {
        try {
          const hist = await redisGet('form:history:' + c.horse_id + ':' + date);
          if (Array.isArray(hist) && hist.length) {
            msg += '  Last 6 runs:\n' + hist.slice(0, 6).map(function(run) {
              const p = String(run.date || '').split('-');
              const runDate = p.length === 3 ? (p[2] + ' ' + (CD_MONTHS[parseInt(p[1], 10) - 1] || p[1]) + ' ' + p[0]) : (run.date || '');
              return '    ' + runDate + ' | ' + (run.course || '') + ' | ' + (run.dist || '') + ' | ' + (run.going || '') + ' | ' + (run.pos || '-') + '/' + (run.ran || 0) + ' | ' + (run.sp || '');
            }).join('\n') + '\n';
          }
        } catch (ce) { /* missing history is skipped silently — never errors */ }
      }
    }
    msg += '\n';
  } else {
    msg += 'CLASS DROP: No horses dropping from Class 1, 2 or 3 today. Do NOT produce a Class Drop signal.\n\n';
  }

  if (orGapCandidates.length) {
    msg += 'OR GAP CANDIDATES (horses rated 8+ points above second highest rated horse in their race):\n';
    for (const c of orGapCandidates) {
      msg += '\n• ' + c.horse + ' | ' + c.trainer + ' | ' + c.course + ' ' + c.time + ' | Price: ' + c.price + '\n';
      msg += '  OR: ' + c.or + ' | Second highest OR: ' + c.secondOr + ' | Gap: ' + c.orGap + ' points\n';
      msg += '  Field: ' + (c.field || 'unavailable') + '\n';
      if (c.horse_id) {
        try {
          const hist = await redisGet('form:history:' + c.horse_id + ':' + date);
          if (Array.isArray(hist) && hist.length) {
            msg += '  Last 6 runs:\n' + hist.slice(0, 6).map(function(run) {
              const p = String(run.date || '').split('-');
              const runDate = p.length === 3 ? (p[2] + ' ' + (CD_MONTHS[parseInt(p[1], 10) - 1] || p[1]) + ' ' + p[0]) : (run.date || '');
              return '    ' + runDate + ' | ' + (run.course || '') + ' | ' + (run.dist || '') + ' | ' + (run.going || '') + ' | ' + (run.pos || '-') + '/' + (run.ran || 0) + ' | ' + (run.sp || '');
            }).join('\n') + '\n';
          }
        } catch (ce) { /* missing history is skipped silently — never errors */ }
      }
    }
    msg += '\n';
  } else {
    msg += 'OR GAP: No horses rated 8+ points above second highest rated in their race today.\n\n';
  }

  if (trainerFormCandidates.length) {
    msg += 'IN-FORM TRAINER CANDIDATES (25%+ strike rate last 14 days, min 5 runs, running at least 50% above their 60 day baseline):\n';
    trainerFormCandidates.forEach(function(c) {
      msg += '\n• ' + c.trainer + ' — ' + c.wins + '/' + c.runs + ' last 14 days (' + c.pct + '% SR) vs ' + c.baseline60 + '% SR over the trailing 60 days\n';
      c.horses.forEach(function(h) { msg += '  - ' + h.name + ' | ' + h.course + ' ' + h.time + ' | Jockey: ' + h.jockey + ' | Price: ' + h.price + '\n'; });
    });
    msg += '\n';
  }

  msg += 'FREE REIN INTELLIGENCE:\n';
  msg += 'Below is today\'s complete race card. You have full freedom to identify any horses not already in the structured candidate pools above that you consider have a genuine strong chance of winning their race today — for any reason. Consider form, going, class, trainer intent, jockey booking, price, race setup or anything else relevant. Web search is available if you want additional research. Add up to 3 selections from this analysis with signalType: \'Intelligence\'.\n\n';
  msg += freeReinSummary + '\n\n';

  msg += 'You may use web search for tipster consensus and for any additional research needed for the Intelligence signal. Return ONLY a valid JSON array with 3-6 items. Quality over quantity. Empty slot better than weak card.';

  const { text, inputTokens, outputTokens, cacheReadTokens, cacheWriteTokens, webSearchCount } = await callClaude(INTELLIGENCE_PROMPT, msg, 12000);

  let items = null;
  let parseError = null;
  if (!text) {
    parseError = 'Intelligence call returned no result';
  } else {
  try {
    items = extractJsonArray(text);
  } catch(e) {
    console.error('[daily-build] Intelligence JSON parse failed:', e.message, '| Raw text:', (text || '').slice(0, 500));
    parseError = e.message;
  }
  }

  if (items && items.length) {
    const sigColorMap = {'Tipster Consensus':'#f97316','Ground Edge':'#0ea5e9','Course and Distance':'#6366f1','Class Drop':'#f59e0b','Hot Yard':'#10b981','Intelligence':'#8b5cf6'};
    items.forEach(function(item) { item.sigColor = sigColorMap[item.signalType] || '#6b7280'; });
  }

  // Deduplicate by horseName — keep first occurrence only
  if (items && items.length) {
    const seen = new Set();
    items = items.filter(item => {
      const key = (item.horseName || '').toLowerCase().trim();
      if (!key) return true;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  }

  // Hot Yard — standalone per-trainer Claude call. The combined prompt's section 5
  // now explicitly defers to this: each qualifying trainer gets its own call with
  // the full race field and cached form history for every runner, and the model may
  // decline with NO_CARD. Kept: at most the 2 highest-strike-rate trainers that
  // return a card. Uses only callClaude/redisGet already defined in this file.
  const HOT_YARD_PROMPT = 'You are an expert horse racing analyst.\n\nThe trainer below is currently in strong form. You have been given every horse they have running today, the full race field for each horse, and each horse\'s last 6 runs.\n\nWrite a card in the same style and length as the other Daily Intelligence cards on this platform — flowing prose, 4-6 lines, specific and confident. Include the trainer\'s current form stats, name the most interesting runner(s) today with specific race context, and give a genuine reason to follow this yard today.\n\nIf none of their runners look genuinely interesting in context of their races, return exactly: NO_CARD and nothing else.\n\nYour response must not exceed 80 words. Count carefully — stop at 80 words. No exceptions.\n\nDo not mention any price or odds anywhere in your response. Prices change and must never appear in the card text.';
  const HY_MONTHS = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
  let hyInputTokens = 0, hyOutputTokens = 0, hyCacheRead = 0, hyCacheWrite = 0;
  const hotYardCards = [];
  const hotYardOrdered = trainerFormCandidates.slice().sort(function(a, b) { return b.pct - a.pct; });
  for (const cand of hotYardOrdered) {
    if (hotYardCards.length >= 1) break;
    try {
      let hyMsg = 'Trainer: ' + cand.trainer + ' — ' + cand.wins + ' winners from ' + cand.runs + ' runners in last 14 days (' + cand.pct + '% strike rate)\n\nToday\'s runners:\n';
      for (const h of cand.horses) {
        hyMsg += '\n' + h.name + ' | ' + h.course + ' ' + h.time + ' | Jockey: ' + h.jockey + ' | Price: ' + h.price + ' | OR: ' + h.or + '\n';
        hyMsg += 'Field: ' + (h.field || 'unavailable') + '\n';
        if (h.horse_id) {
          try {
            const hist = await redisGet('form:history:' + h.horse_id + ':' + date);
            if (Array.isArray(hist) && hist.length) {
              hyMsg += 'Last 6 runs:\n' + hist.slice(0, 6).map(function(run) {
                const p = String(run.date || '').split('-');
                const runDate = p.length === 3 ? (p[2] + ' ' + (HY_MONTHS[parseInt(p[1], 10) - 1] || p[1]) + ' ' + p[0]) : (run.date || '');
                return runDate + ' | ' + (run.course || '') + ' | ' + (run.dist || '') + ' | ' + (run.going || '') + ' | ' + (run.pos || '-') + '/' + (run.ran || 0) + ' | ' + (run.sp || '');
              }).join('\n') + '\n';
            }
          } catch (he) { /* a missing history must never stop the rest of the envelope */ }
        }
      }
      const hyResp = await callClaude(HOT_YARD_PROMPT, hyMsg, 1000, true);
      hyInputTokens += hyResp.inputTokens || 0;
      hyOutputTokens += hyResp.outputTokens || 0;
      hyCacheRead += hyResp.cacheReadTokens || 0;
      hyCacheWrite += hyResp.cacheWriteTokens || 0;
      const cardText = (hyResp.text || '').trim();
      if (!cardText || cardText.indexOf('NO_CARD') === 0) continue;
      hotYardCards.push({
        signalType: 'Hot Yard',
        sigColor: '#10b981',
        horseName: cand.trainer,
        price: '',
        meta: cand.horses.length + ' runners today',
        intelligenceText: cardText,
        ctaLabel: 'View ' + cand.trainer + ' Runners',
        ctaDestination: 'trainer:' + cand.trainer
      });
    } catch (hyErr) {
      console.log('[daily-build] Hot Yard call failed for ' + cand.trainer + ': ' + hyErr.message);
    }
  }
  if (hotYardCards.length) items = (items || []).concat(hotYardCards);

  const ctaValidationDrops = [];
  items = validateAndRepairCtaDestinations(items, racecards, ctaValidationDrops);

  const duplicateRaceDrops = [];
  items = dedupeRaceCollisionsAndCapPerMeeting(items, duplicateRaceDrops);

  return { items, inputTokens: inputTokens + hyInputTokens, outputTokens: outputTokens + hyOutputTokens, cacheReadTokens: cacheReadTokens + hyCacheRead, cacheWriteTokens: cacheWriteTokens + hyCacheWrite, webSearchCount, parseError, groundEdgeSkippedCount, classDropSkippedCount, hotYardBaselineErrors, duplicateRaceDrops, ctaValidationDrops };
}

// ── MAIN ──────────────────────────────────────────────────────────────────────

exports.handler = async function(event) {
  console.log('[BUILD START]', new Date().toISOString(), 'ctx:', process.env.CONTEXT, 'scheduled:', !event.httpMethod);
  // Heartbeat: fire-and-forget first write so even an invocation killed early leaves evidence in Redis
  try {
    if (UPSTASH_URL && UPSTASH_TOKEN) {
      redisSet('debug:build-heartbeat:' + new Date().toISOString().slice(0, 10), {
        startedAt: new Date().toISOString(),
        scheduled: !event.httpMethod,
        ctx: process.env.CONTEXT || ''
      }).catch(function() {});
    }
  } catch (hbErr) {}
  const RUN_FULL_BUILD = false;
  const headers = { 'Access-Control-Allow-Origin': '*', 'Content-Type': 'application/json' };

  const isScheduled = !event.httpMethod;
  if (!isScheduled) {
    const secret = (event.queryStringParameters && event.queryStringParameters.secret) || (event.headers && event.headers['x-build-secret']);
    if (secret !== process.env.BUILD_SECRET) {
      return { statusCode: 401, headers, body: JSON.stringify({ error: 'Unauthorised' }) };
    }
  }

  const today = new Date().toISOString().slice(0, 10);
  const now = new Date();

  // Build-in-progress lock (AUDIT-DAILY-INTELLIGENCE.md, finding C2). If Netlify's
  // scheduler and the GitHub Actions safety net both fire — or the safety net fires
  // while a slow scheduled run is still mid-flight — this stops a second, fully
  // redundant build from running concurrently with the first (which would otherwise
  // double the Anthropic spend and send two separate emails for the same day).
  const LOCK_WINDOW_MS = 30 * 60 * 1000;
  try {
    const existingLock = await redisGet('build:lock:' + today);
    if (existingLock && existingLock.startedAt) {
      const lockAgeMs = now.getTime() - new Date(existingLock.startedAt).getTime();
      if (lockAgeMs >= 0 && lockAgeMs < LOCK_WINDOW_MS) {
        console.log('[daily-build] Build already in progress (started ' + Math.round(lockAgeMs / 1000) + 's ago) — standing down.');
        return { statusCode: 200, headers, body: JSON.stringify({ skipped: true, reason: 'build already in progress', lockStartedAt: existingLock.startedAt }) };
      }
    }
    await redisSet('build:lock:' + today, { startedAt: now.toISOString(), scheduled: isScheduled });
  } catch (lockErr) { /* lock check/write failure must never block the build itself */ }

  const report = {
    date: today,
    startedAt: now.toISOString(),
    meetings: 0,
    totalRaces: 0,
    upcomingRaces: 0,
    totalHorses: 0,
    racesAnalysed: 0,
    intelligenceItems: 0,
    inputTokens: 0,
    outputTokens: 0,
    costUSD: '0.0000',
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    webSearchCount: 0,
    redisOk: false,
    errors: [],
    warnings: [],
    raceBreakdown: [],
    callLog: [],
    analyses: [],
    intelligence: []
  };

  const REQUIRED_ENV_VARS = {
    RACING_API_USERNAME: process.env.RACING_API_USERNAME,
    RACING_API_KEY: process.env.RACING_API_KEY,
    UPSTASH_REDIS_REST_URL: process.env.UPSTASH_REDIS_REST_URL,
    UPSTASH_REDIS_REST_TOKEN: process.env.UPSTASH_REDIS_REST_TOKEN,
    ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY
  };
  const missingEnvVars = Object.keys(REQUIRED_ENV_VARS).filter(function(key) { return !REQUIRED_ENV_VARS[key]; });
  if (missingEnvVars.length) {
    const presentEnvVars = Object.keys(REQUIRED_ENV_VARS).filter(function(key) { return !!REQUIRED_ENV_VARS[key]; });
    console.error('[ENV CHECK FAILED] missing:', missingEnvVars.join(', '), '| present:', presentEnvVars.join(', ') || 'none');
    report.errors.push('Missing required environment variables: ' + missingEnvVars.join(', '));
    // Leave evidence in Redis even on a failed run — only possible if the Upstash vars themselves are present
    try {
      if (UPSTASH_URL && UPSTASH_TOKEN) await safeWriteReport(today, report);
    } catch (re) {}
    try { await redisSet('build:lock:' + today, null); } catch (ue) {}
    return { statusCode: 500, headers, body: JSON.stringify(report, null, 2) };
  }

  try {
    // 1. Fetch racecards
    console.log('[daily-build] Fetching racecards...');
    let data;
    try {
      data = await apiGet('api.theracingapi.com', '/v1/racecards/pro?date=' + today, {
        'Authorization': 'Basic ' + RACING_AUTH
      });
    } catch (e) {
      data = {};
    }
    if (!data.racecards || !data.racecards.length) {
      console.log('[daily-build] Racecards fetch empty or failed — retrying in 5 seconds...');
      await new Promise(resolve => setTimeout(resolve, 5000));
      try {
        data = await apiGet('api.theracingapi.com', '/v1/racecards/pro?date=' + today, {
          'Authorization': 'Basic ' + RACING_AUTH
        });
      } catch (e) {
        data = {};
      }
    }
    if (!data.racecards || !data.racecards.length) {
      try {
        data = await apiGet('api.theracingapi.com', '/v1/racecards/standard', {
          'Authorization': 'Basic ' + RACING_AUTH
        });
      } catch (e) {
        data = {};
      }
    }

    const allRacecards = (data.racecards || []).filter(r => {
      const reg = (r.region || '').toUpperCase();
      if (reg !== 'GB' && reg !== 'IRE' && reg !== 'IE') return false;
      return true;
    });

    if (allRacecards.length === 0) {
      report.errors.push('Racing API returned zero race cards for ' + today + ' — Intelligence skipped');
    }

    // Analyse all of today's races — Redis cache prevents re-calling Claude for already-analysed races
    const racecards = allRacecards;

    const meetings = {};
    allRacecards.forEach(r => {
      const id = r.course_id || r.course;
      if (!meetings[id]) meetings[id] = { name: r.course, going: r.going, races: [] };
      meetings[id].races.push(r);
    });

    report.meetings = Object.keys(meetings).length;
    report.totalRaces = allRacecards.length;
    report.upcomingRaces = racecards.length;
    report.totalHorses = racecards.reduce((s, r) => s + (r.runners || []).length, 0);

    console.log(`[daily-build] ${report.upcomingRaces} upcoming races (${report.totalRaces} total today)`);

    // 2. Store raw racecards in Redis — only overwrite if new data has more runners
    // (protects the morning's full runner data from being replaced by empty-runner re-runs later in the day)
    // Uses a private key (not 'racecards:<date>') because that key is the shared
    // { meetings: [...] } cache written by fetch-future-cards-background.js and
    // updated by refresh-prices-background.js — writing the raw { racecards: [...] }
    // shape there clobbers it and silently breaks today's price refresh.
    try {
      const existingCards = await redisGet('daily-build:raw-racecards:' + today);
      const existingRunners = existingCards && Array.isArray(existingCards.racecards)
        ? existingCards.racecards.reduce((s, r) => s + (r.runners || []).length, 0) : 0;
      const newRunners = allRacecards.reduce((s, r) => s + (r.runners || []).length, 0);
      if (newRunners >= existingRunners) {
        await redisSet('daily-build:raw-racecards:' + today, { racecards: allRacecards, storedAt: new Date().toISOString() });
      }
      report.redisOk = true;
    } catch(e) {
      report.errors.push('redis-store: ' + e.message);
    }

    // 2.5 Seed report.analyses with prior stored analyses for races that already ran today
    try {
      const priorReport = await redisGet('daily:report:' + today);
      if (priorReport && priorReport.analyses) {
        const upcomingLabels = new Set(racecards.map(r => {
          const t24 = (function(offDt){ if(!offDt) return r.off_time||''; var m=offDt.match(/T(\d{2}):(\d{2})/); return m?m[1]+':'+m[2]:r.off_time||''; })(r.off_dt);
          return r.course + ' ' + t24;
        }));
        priorReport.analyses.forEach(function(a) {
          if (!upcomingLabels.has(a.race)) report.analyses.push(a);
        });
      }
    } catch(e) {}

    // 3. Generate daily intelligence FIRST — tipster consensus is passed into each race analysis
    // Check Redis cache first — if intelligence already ran today, reuse it (prevents second builds wiping morning signals)
    console.log('[daily-build] Generating daily intelligence...');
    let tipsterConsensusText = '';
    let tomorrowInputTokens = 0, tomorrowOutputTokens = 0, tomorrowCacheReadTokens = 0, tomorrowCacheWriteTokens = 0, tomorrowWebSearchCount = 0;
    try {
      let items = null, intIT = 0, intOT = 0, intCR = 0, intCW = 0, intWS = 0;
      const cachedIntel = await redisGet('intelligence:' + today);
      // A cached value under intelligence:{today} might actually be yesterday's tomorrow
      // preview (4 signals, no Tipster Consensus, every item flagged isTomorrow:true) —
      // that is not a valid stand-in for today's real build, so treat it as no cache at all.
      const cachedIsTomorrowPreview = !!(cachedIntel && cachedIntel.items && cachedIntel.items.some(function(item) { return item.isTomorrow === true; }));
      if (cachedIntel && cachedIntel.items && cachedIntel.items.length && !cachedIsTomorrowPreview) {
        console.log('[daily-build] Intelligence already cached today — reusing');
        items = cachedIntel.items;
        report.callLog.push({ type: 'intelligence', label: 'Daily Intelligence [CACHED]', inputTokens: 0, outputTokens: 0, webSearch: false, webSearchCount: 0 });
      } else {
        const r = await generateIntelligence(racecards);
        items = r.items; intIT = r.inputTokens; intOT = r.outputTokens;
        intCR = r.cacheReadTokens || 0; intCW = r.cacheWriteTokens || 0; intWS = r.webSearchCount || 0;
        if (r.parseError) report.errors.push('Intelligence parse failed: ' + r.parseError);
        if (r.groundEdgeSkippedCount > 5) {
          report.warnings.push('Ground Edge: ' + r.groundEdgeSkippedCount + ' horses had no cached form history');
        }
        if (r.classDropSkippedCount > 5) {
          report.warnings.push('Class Drop: ' + r.classDropSkippedCount + ' horses had runs but no valid class data');
        }
        if (r.hotYardBaselineErrors && r.hotYardBaselineErrors.length) {
          r.hotYardBaselineErrors.forEach(function(msg) { report.warnings.push(msg); });
        }
        if (r.duplicateRaceDrops && r.duplicateRaceDrops.length) {
          r.duplicateRaceDrops.forEach(function(msg) { report.warnings.push(msg); });
        }
        if (r.ctaValidationDrops && r.ctaValidationDrops.length) {
          r.ctaValidationDrops.forEach(function(msg) { report.warnings.push(msg); });
        }
        if (items && items.length) {
          items.forEach(function(item) { item.date = today; });
          try { await redisSet('intelligence:' + today, { items, generatedAt: new Date().toISOString() }); } catch(re) { report.errors.push('redis-write intelligence:' + today + ': ' + re.message); }
        }

        if (allRacecards.length) {
        const tomorrowDate = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
        const tomorrowCards = await redisGet('racecards:' + tomorrowDate);
        if (tomorrowCards && Array.isArray(tomorrowCards.meetings) && tomorrowCards.meetings.length > 0) {
          console.log(`[daily-build] Tomorrow (${tomorrowDate}): ${tomorrowCards.meetings.length} meeting(s) found`);

          const tomorrowRaceTime = function(race) {
            if (!race.off_dt) return race.off_time || '';
            const m = race.off_dt.match(/T(\d{2}):(\d{2})/);
            return m ? m[1] + ':' + m[2] : race.off_time || '';
          };

          const tomorrowExtractPrice = function(r) {
            const oddsArr = Array.isArray(r.odds) ? r.odds : [];
            return (oddsArr.find(function(o) { return o.fractional && !(o.bookmaker||'').toLowerCase().includes('exchange'); }) || oddsArr[0] || {}).fractional || 'SP';
          };

          const tomorrowMilesFurlongs = function(distStr) {
            const s = String(distStr || '');
            const miles = (s.match(/(\d+)m/) || [])[1];
            const furlongs = (s.match(/(\d+)f/) || [])[1];
            return (miles ? parseInt(miles, 10) : 0) * 8 + (furlongs ? parseInt(furlongs, 10) : 0);
          };

          // Flatten tomorrowCards.meetings (meeting objects with a nested races array) into a
          // flat array of race objects shaped like today's racecards, so the precompute loops
          // below — written to expect flat race objects — actually get the fields they read.
          const tomorrowRacecards = [];
          tomorrowCards.meetings.forEach(function(m) {
            (m.races || []).forEach(function(race) {
              tomorrowRacecards.push({
                course: m.name,
                going: race.going || m.going || '',
                race_name: race.name || '',
                distance: race.dist || '',
                race_class: race.class || '',
                runners: race.runners || [],
                off_time: race.t || ''
              });
            });
          });

          // TODO(S1, AUDIT-DAILY-INTELLIGENCE.md): everything from here to the tomorrow
          // message assembly below is a near-complete line-for-line duplicate of the
          // "today" pre-computation block above (Ground Edge / Course & Distance / Class
          // Drop / OR Gap / Hot Yard), independently maintained with tomorrow-prefixed
          // names instead of a shared, day-parameterized function. This duplication is
          // the root cause of at least 3 confirmed bugs (Unknown horse names, the
          // tomorrow-CTA render bug, Intelligence leaking into tomorrow) — a fix applied
          // to one side has to be remembered and reapplied to the other by hand. Flagged
          // per the audit; deliberately NOT restructured in this pass so the fixes above
          // stay easy to review — collapsing today/tomorrow into one shared code path is
          // the next real piece of work here, ideally before any more signals are added.

          // Pre-compute ground edge candidates for tomorrow: Heavy/Yielding jumps meetings only, grouped by venue
          const tomorrowGroundRe = /heavy|yield/i;
          const tomorrowGroundEdgeByVenue = {};
          const tomorrowHeavyMeetings = tomorrowRacecards.filter(function(race) {
            return tomorrowGroundRe.test(race.going || '') && isJumps(race.race_name, race.type);
          });

          let tomorrowGroundEdgeSkippedCount = 0;
          for (let mi = 0; mi < Math.min(tomorrowHeavyMeetings.length, 12); mi++) {
            const race = tomorrowHeavyMeetings[mi];
            const venue = race.course || 'Unknown';
            const runners = (race.runners || []).filter(function(r) { return !r.is_non_runner && r.horse_id; });
            for (let ri = 0; ri < Math.min(runners.length, 15); ri++) {
              const runner = runners[ri];
              const history = await fetchHorseHistory(runner.horse_id);
              if (!history.length) { tomorrowGroundEdgeSkippedCount++; continue; }

              const groundRuns = history.filter(function(h) { return tomorrowGroundRe.test(h.going || ''); });
              const goodRuns = history.filter(function(h) { return !tomorrowGroundRe.test(h.going || '') && (h.going || '').trim(); });
              const groundWins = groundRuns.filter(function(h) { return String(h.pos) === '1'; }).length;
              const goodWins = goodRuns.filter(function(h) { return String(h.pos) === '1'; }).length;

              // Quality bar: must have won on heavy/yielding, and either 2+ wins or 33%+ SR
              if (groundRuns.length >= 2 && groundWins >= 1) {
                const groundSR = Math.round(groundWins / groundRuns.length * 100);
                const goodSR = goodRuns.length ? Math.round(goodWins / goodRuns.length * 100) : 0;
                if (groundWins >= 2 || groundSR >= 33) {
                  if (!tomorrowGroundEdgeByVenue[venue]) tomorrowGroundEdgeByVenue[venue] = { venue: venue, going: race.going, horses: [] };
                  tomorrowGroundEdgeByVenue[venue].horses.push({
                    horse: runner.horse || runner.name || 'Unknown',
                    price: tomorrowExtractPrice(runner),
                    time: tomorrowRaceTime(race),
                    raceName: race.race_name || '',
                    groundSR: groundSR,
                    groundWins: groundWins,
                    groundRuns: groundRuns.length,
                    groundRecord: groundWins + ' wins from ' + groundRuns.length + ' on heavy/yielding (' + groundSR + '% SR)',
                    goodRecord: goodRuns.length ? (goodWins + ' wins from ' + goodRuns.length + ' on good/firm (' + goodSR + '% SR)') : 'No runs on good/firm'
                  });
                }
              }
            }
          }
          if (tomorrowGroundEdgeSkippedCount > 5) {
            report.warnings.push('Tomorrow Ground Edge: ' + tomorrowGroundEdgeSkippedCount + ' horses had no cached form history');
          }

          // Ground Edge for tomorrow: top 3 horses across all venues (ranked by groundWins, then groundSR)
          const _tomorrowGroundEdgeAll = [];
          Object.values(tomorrowGroundEdgeByVenue).forEach(function(v) {
            v.horses.forEach(function(h) {
              _tomorrowGroundEdgeAll.push(Object.assign({}, h, { venue: v.venue, going: v.going }));
            });
          });
          _tomorrowGroundEdgeAll.sort(function(a, b) {
            if (b.groundWins !== a.groundWins) return b.groundWins - a.groundWins;
            return b.groundSR - a.groundSR;
          });
          const tomorrowGroundEdgeCandidates = _tomorrowGroundEdgeAll.slice(0, 3);

          // Pre-compute course & distance candidates for tomorrow: 2+ wins at tomorrow's specific course, 33%+ course win rate
          const tomorrowCourseDistanceCandidates = [];
          for (let mi = 0; mi < tomorrowRacecards.length; mi++) {
            const race = tomorrowRacecards[mi];
            const course = race.course || '';
            const runners = (race.runners || []).filter(function(r) { return !r.is_non_runner && r.horse_id; });
            for (let ri = 0; ri < runners.length; ri++) {
              const runner = runners[ri];
              const history = await fetchHorseHistory(runner.horse_id);
              if (!history.length) continue;

              const courseRuns = history.filter(function(h) { return (h.course || '').toLowerCase().trim().replace(/\s*\([^)]*\)/g, '').trim() === (course || '').toLowerCase().trim().replace(/\s*\([^)]*\)/g, '').trim(); });
              const courseTopTwo = courseRuns.filter(function(h) { return String(h.pos) === '1' || String(h.pos) === '2'; });
              const courseTopTwoRate = courseRuns.length ? Math.round(courseTopTwo.length / courseRuns.length * 100) : 0;
              const meetsTopTwoRule = courseTopTwo.length >= 2 && courseTopTwoRate >= 33;

              const courseWins = courseRuns.filter(function(h) { return String(h.pos) === '1'; });
              const meetsAnyWinRule = courseWins.length >= 1;

              if (!meetsTopTwoRule && !meetsAnyWinRule) continue;

              const winAtTodaysDistance = courseTopTwo.some(function(h) { return tomorrowMilesFurlongs(h.dist) === tomorrowMilesFurlongs(race.distance); });
              const topTwoGoings = courseTopTwo.reduce(function(acc, h) {
                if (h.going && acc.indexOf(h.going) === -1) acc.push(h.going);
                return acc;
              }, []);

              tomorrowCourseDistanceCandidates.push({
                horse: runner.horse || runner.name || 'Unknown',
                price: tomorrowExtractPrice(runner),
                time: tomorrowRaceTime(race),
                course: course,
                courseTopTwo: courseTopTwo.length,
                courseRuns: courseRuns.length,
                courseTopTwoRate: courseTopTwoRate,
                topTwoDates: courseTopTwo.map(function(h) { return h.date; }).join(', '),
                winAtTodaysDistance: winAtTodaysDistance,
                topTwoGoings: topTwoGoings
              });
            }
          }
          tomorrowCourseDistanceCandidates.sort(function(a, b) {
            if (b.courseTopTwo !== a.courseTopTwo) return b.courseTopTwo - a.courseTopTwo;
            return b.courseTopTwoRate - a.courseTopTwoRate;
          });

          // Pre-compute class drop candidates for tomorrow: horse racing tomorrow at least 1 class lower
          // (numerically higher class number) than their most recent class-recorded run, last classed run Class 1-3
          const tomorrowClassDropCandidates = [];
          let tomorrowClassDropSkippedCount = 0;
          function tomorrowParseClassNum(classStr) {
            if (!classStr || !String(classStr).startsWith('Class')) return null;
            const n = parseInt(String(classStr).slice(-1), 10);
            return isNaN(n) ? null : n;
          }
          for (let mi = 0; mi < tomorrowRacecards.length; mi++) {
            const race = tomorrowRacecards[mi];
            const todayClassNum = tomorrowParseClassNum(race.race_class);
            if (todayClassNum === null) continue;

            const runners = (race.runners || []).filter(function(r) { return !r.is_non_runner && r.horse_id; });
            for (let ri = 0; ri < runners.length; ri++) {
              const runner = runners[ri];
              const history = await fetchHorseHistory(runner.horse_id);
              const validClassRuns = history.filter(function(h) { return tomorrowParseClassNum(h.race_class) !== null; });
              if (validClassRuns.length === 0 && history.length > 0) {
                tomorrowClassDropSkippedCount++;
              }
              if (validClassRuns.length < 2) continue;

              const lastClassRun = history.find(function(h) { return tomorrowParseClassNum(h.race_class) !== null; });
              if (!lastClassRun) continue;

              const lastRunClassNum = tomorrowParseClassNum(lastClassRun.race_class);
              if (lastRunClassNum === null) continue;
              if (lastRunClassNum > 3) continue;

              const classDrop = todayClassNum - lastRunClassNum;
              if (classDrop < 1) continue;

              tomorrowClassDropCandidates.push({
                horse: runner.horse || runner.name || 'Unknown',
                trainer: runner.trainer || '',
                price: tomorrowExtractPrice(runner),
                time: tomorrowRaceTime(race),
                course: race.course || '',
                todayClass: String(race.race_class),
                lastRunClass: String(lastClassRun.race_class),
                classDrop: classDrop
              });
            }
          }
          tomorrowClassDropCandidates.sort(function(a, b) { return b.classDrop - a.classDrop; });
          if (tomorrowClassDropSkippedCount > 5) {
            report.warnings.push('Tomorrow Class Drop: ' + tomorrowClassDropSkippedCount + ' horses had runs but no valid class data');
          }

          // Pre-compute OR gap candidates for tomorrow: top-rated horse with a significant official rating advantage over the second-best in the race
          const tomorrowOrGapCandidates = [];
          for (let mi = 0; mi < tomorrowRacecards.length; mi++) {
            const race = tomorrowRacecards[mi];
            const runners = (race.runners || []).filter(function(r) { return !r.is_non_runner && r.horse_id; });

            const ratedRunners = runners.map(function(r) {
              return { runner: r, orValue: parseFloat(r.ofr || r.official_rating || 0) };
            }).filter(function(x) { return x.orValue > 0; });

            if (ratedRunners.length < 2) continue;

            ratedRunners.sort(function(a, b) { return b.orValue - a.orValue; });

            const firstOR = ratedRunners[0].orValue;
            const secondOR = ratedRunners[1].orValue;
            const orGap = firstOR - secondOR;

            if (orGap >= 8) {
              const runner = ratedRunners[0].runner;
              tomorrowOrGapCandidates.push({
                horse: runner.horse || runner.name || 'Unknown',
                trainer: runner.trainer || '',
                price: tomorrowExtractPrice(runner),
                time: tomorrowRaceTime(race),
                course: race.course || '',
                or: firstOR,
                secondOr: secondOR,
                orGap: orGap
              });
            }
          }
          tomorrowOrGapCandidates.sort(function(a, b) { return b.orGap - a.orGap; });
          tomorrowOrGapCandidates.splice(5);

          // Pre-compute in-form trainer candidates for tomorrow (25%+ SR, min 5 runs last 14 days)
          const tomorrowTrainerFormMap = {};
          tomorrowRacecards.forEach(function(race) {
            const t = tomorrowRaceTime(race);
            (race.runners || []).filter(function(r) { return !r.is_non_runner; }).forEach(function(r) {
              const t14 = r.trainer14 || {};
              const runs = t14.runs || 0, wins = t14.wins || 0, pct = parseFloat(t14.pct) || 0;
              if (runs >= 5 && pct >= 25 && r.trainer) {
                if (!tomorrowTrainerFormMap[r.trainer]) tomorrowTrainerFormMap[r.trainer] = { trainer: r.trainer, trainer_id: r.trainer_id || '', runs: runs, wins: wins, pct: pct, horses: [] };
                tomorrowTrainerFormMap[r.trainer].horses.push((r.horse || r.name || 'Unknown') + ' | ' + race.course + ' ' + t + ' | Jockey: ' + (r.jockey || '?') + ' | Price: ' + tomorrowExtractPrice(r));
              }
            });
          });
          const tomorrowSixtyDaysAgo = new Date(Date.now() - 60 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
          const tomorrowTrainersToRemove = [];
          for (const trainerName of Object.keys(tomorrowTrainerFormMap)) {
            const entry = tomorrowTrainerFormMap[trainerName];
            if (!entry.trainer_id) {
              delete tomorrowTrainerFormMap[trainerName];
              continue;
            }
            try {
              const data = await apiGet('api.theracingapi.com',
                '/v1/trainers/' + encodeURIComponent(entry.trainer_id) + '/results?start_date=' + tomorrowSixtyDaysAgo + '&end_date=' + today,
                { 'Authorization': 'Basic ' + RACING_AUTH }
              );
              await new Promise(resolve => setTimeout(resolve, 200));
              const results = data.results || [];
              const baselineRuns = results.length;
              const baselineWins = results.filter(function(result) { return String(result.position) === '1'; }).length;
              const baseline60 = baselineRuns > 0 ? Math.round(baselineWins / baselineRuns * 100) : 0;
              entry.baseline60 = baseline60;

              if (!baselineRuns || !baseline60) {
                tomorrowTrainersToRemove.push(trainerName);
                continue;
              }

              const isHot = entry.pct >= 25 && entry.pct >= baseline60 * 1.5;
              if (!isHot) tomorrowTrainersToRemove.push(trainerName);
            } catch (e) {
              console.log('[daily-build] Tomorrow Hot Yard baseline fetch failed for trainer ' + trainerName + ': ' + e.message);
              report.warnings.push('Tomorrow Hot Yard baseline fetch failed for trainer ' + trainerName + ': ' + e.message);
              tomorrowTrainersToRemove.push(trainerName);
            }
          }
          tomorrowTrainersToRemove.forEach(function(trainerName) { delete tomorrowTrainerFormMap[trainerName]; });

          const tomorrowTrainerFormCandidates = Object.values(tomorrowTrainerFormMap).sort(function(a, b) {
            const ratioA = a.baseline60 ? a.pct / a.baseline60 : 0;
            const ratioB = b.baseline60 ? b.pct / b.baseline60 : 0;
            return ratioB - ratioA;
          }).slice(0, 5);

          // Build tomorrow's structured message
          const tomorrowMeetingsSummary = tomorrowCards.meetings.reduce(function(acc, m) {
            (m.races || []).forEach(function(race) {
              acc.push(m.name + ' ' + race.t + ' — ' + (race.name || '') + ' (' + (race.dist || '') + ') Going: ' + (race.going || m.going || 'Good'));
            });
            return acc;
          }, []).join('\n');

          // TEMPORARY DIAGNOSTIC — captures full candidate pools before AI selection, to audit
          // why a recent run produced Goodwood-only cards despite 6 meetings racing tomorrow.
          try {
            const _courseCounts = {};
            tomorrowRacecards.forEach(function(r){ _courseCounts[r.course] = (_courseCounts[r.course]||0) + 1; });
            await redisSet('debug:tomorrow-candidates:' + tomorrowDate, {
              generatedAt: new Date().toISOString(),
              meetingsInput: tomorrowCards.meetings.map(function(m){ return { course: m.name, raceCount: (m.races||[]).length }; }),
              racesByCourseFlattened: _courseCounts,
              meetingsSummaryTotalRaces: tomorrowRacecards.length,
              meetingsSummaryLinesShown: tomorrowMeetingsSummary.split('\n').length,
              groundEdgeCandidates_ALL: _tomorrowGroundEdgeAll,
              courseDistanceCandidates_ALL: tomorrowCourseDistanceCandidates,
              classDropCandidates_ALL: tomorrowClassDropCandidates,
              orGapCandidates_ALL: tomorrowOrGapCandidates,
              trainerFormCandidates_ALL: Object.values(tomorrowTrainerFormMap)
            });
          } catch(e) {}

          let tomorrowMsg = 'These are TOMORROW\'s race cards for ' + tomorrowDate + '. Apply the same signal logic but these races are for tomorrow not today.'
            + '\n\nTOMORROW\'S RACES:\n' + tomorrowMeetingsSummary + '\n\n';

          if (tomorrowGroundEdgeCandidates.length) {
            tomorrowMsg += 'GROUND EDGE CANDIDATES (high conviction individual ground specialists):\n';
            tomorrowGroundEdgeCandidates.forEach(function(h) {
              tomorrowMsg += '\n• ' + h.horse + ' | ' + h.venue + ' ' + h.time + ' | Going: ' + h.going + ' | Price: ' + h.price + '\n';
              tomorrowMsg += '  Ground record: ' + h.groundRecord + '\n';
              tomorrowMsg += '  Good/firm record: ' + h.goodRecord + '\n';
            });
            tomorrowMsg += '\n';
          } else {
            tomorrowMsg += 'GROUND EDGE: No qualifying ground specialists today. Do NOT produce a Ground Edge signal.\n\n';
          }

          if (tomorrowCourseDistanceCandidates.length) {
            tomorrowMsg += 'COURSE AND DISTANCE CANDIDATES (2+ top 2 finishes at today\'s course, 33%+ course win rate):\n';
            tomorrowCourseDistanceCandidates.slice(0, 5).forEach(function(c) {
              tomorrowMsg += '\n• ' + c.horse + ' | ' + c.course + ' ' + c.time + ' | Price: ' + c.price + '\n';
              tomorrowMsg += '  Course record: ' + c.courseTopTwo + ' top 2 finishes from ' + c.courseRuns + ' at ' + c.course + ' (' + c.courseTopTwoRate + '% SR) | Top 2 dates: ' + c.topTwoDates + '\n';
              tomorrowMsg += '  Top 2 finish at today\'s exact distance: ' + (c.winAtTodaysDistance ? 'Yes' : 'No') + '\n';
              tomorrowMsg += '  Going on course form: ' + (c.topTwoGoings.length ? c.topTwoGoings.join(', ') : 'Unknown') + '\n';
            });
            tomorrowMsg += '\n';
          } else {
            tomorrowMsg += 'COURSE AND DISTANCE: No qualifying horses today. Do NOT produce this signal.\n\n';
          }

          if (tomorrowClassDropCandidates.length) {
            tomorrowMsg += 'CLASS DROP CANDIDATES (horses from Class 1, 2 or 3 dropping at least 1 class today):\n';
            tomorrowClassDropCandidates.slice(0, 5).forEach(function(c) {
              tomorrowMsg += '\n• ' + c.horse + ' | ' + c.trainer + ' | ' + c.course + ' ' + c.time + ' | Price: ' + c.price + '\n';
              tomorrowMsg += '  Last run: ' + c.lastRunClass + ' → Today: ' + c.todayClass + ' (drop of ' + c.classDrop + ' classes)\n';
            });
            tomorrowMsg += '\n';
          } else {
            tomorrowMsg += 'CLASS DROP: No horses dropping from Class 1, 2 or 3 today. Do NOT produce a Class Drop signal.\n\n';
          }

          if (tomorrowOrGapCandidates.length) {
            tomorrowMsg += 'OR GAP CANDIDATES (horses rated 8+ points above second highest rated horse in their race):\n';
            tomorrowOrGapCandidates.forEach(function(c) {
              tomorrowMsg += '\n• ' + c.horse + ' | ' + c.trainer + ' | ' + c.course + ' ' + c.time + ' | Price: ' + c.price + '\n';
              tomorrowMsg += '  OR: ' + c.or + ' | Second highest OR: ' + c.secondOr + ' | Gap: ' + c.orGap + ' points\n';
            });
            tomorrowMsg += '\n';
          } else {
            tomorrowMsg += 'OR GAP: No horses rated 8+ points above second highest rated in their race today.\n\n';
          }

          if (tomorrowTrainerFormCandidates.length) {
            tomorrowMsg += 'IN-FORM TRAINER CANDIDATES (25%+ strike rate last 14 days, min 5 runs, running at least 50% above their 60 day baseline):\n';
            tomorrowTrainerFormCandidates.forEach(function(c) {
              tomorrowMsg += '\n• ' + c.trainer + ' — ' + c.wins + '/' + c.runs + ' last 14 days (' + c.pct + '% SR) vs ' + c.baseline60 + '% SR over the trailing 60 days\n';
              c.horses.forEach(function(h) { tomorrowMsg += '  - ' + h + '\n'; });
            });
            tomorrowMsg += '\n';
          }

          tomorrowMsg += 'Do not produce Tipster Consensus cards for tomorrow. Do not produce Intelligence cards for tomorrow either — there is no FREE REIN INTELLIGENCE section in this message, so any Intelligence-type card would not be grounded in real data. Ground Edge, Course and Distance, Class Drop and Hot Yard cards may be produced if qualifying candidates exist. Return ONLY a valid JSON array.';

          const tomorrowResult = await callClaude(INTELLIGENCE_PROMPT, tomorrowMsg, 12000);
          tomorrowInputTokens = tomorrowResult.inputTokens || 0;
          tomorrowOutputTokens = tomorrowResult.outputTokens || 0;
          tomorrowCacheReadTokens = tomorrowResult.cacheReadTokens || 0;
          tomorrowCacheWriteTokens = tomorrowResult.cacheWriteTokens || 0;
          tomorrowWebSearchCount = tomorrowResult.webSearchCount || 0;
          report.callLog.push({ type: 'intelligence-tomorrow', label: 'Daily Intelligence (Tomorrow)', inputTokens: tomorrowInputTokens, outputTokens: tomorrowOutputTokens, cacheReadTokens: tomorrowCacheReadTokens, cacheWriteTokens: tomorrowCacheWriteTokens, webSearch: tomorrowWebSearchCount > 0, webSearchCount: tomorrowWebSearchCount });

          let tomorrowItems = null;
          let tomorrowParseError = null;
          if (!tomorrowResult.text) {
            tomorrowParseError = 'Tomorrow intelligence call returned no result';
          } else {
          try {
            tomorrowItems = extractJsonArray(tomorrowResult.text);
          } catch(e) {
            console.error('[daily-build] Tomorrow intelligence JSON parse failed:', e.message, '| Raw text:', (tomorrowResult.text || '').slice(0, 500));
            tomorrowParseError = e.message;
          }
          }

          if (tomorrowParseError) {
            report.errors.push('Tomorrow intelligence parse failed: ' + tomorrowParseError);
          } else if (!tomorrowItems) {
            report.errors.push('Tomorrow intelligence parse failed: no JSON array found in response');
          } else if (!tomorrowItems.length) {
            report.warnings.push('Tomorrow intelligence returned zero cards');
          }

          if (tomorrowItems && tomorrowItems.length) {
            // Code-level backstop for the prompt instruction above (AUDIT-DAILY-INTELLIGENCE.md,
            // finding S5): Intelligence is a today-only signal — tomorrow's message never
            // includes the FREE REIN INTELLIGENCE data section it's meant to draw from, but
            // a real run still produced an Intelligence-type card for tomorrow once. Drop any
            // that slip through regardless of whether the prompt instruction was followed.
            const _preIntelDropCount = tomorrowItems.length;
            tomorrowItems = tomorrowItems.filter(function(item) { return item.signalType !== 'Intelligence'; });
            if (tomorrowItems.length < _preIntelDropCount) {
              report.warnings.push('Dropped ' + (_preIntelDropCount - tomorrowItems.length) + ' Intelligence-type card(s) from tomorrow output — Intelligence is today-only');
            }
            tomorrowItems = validateAndRepairCtaDestinations(tomorrowItems, tomorrowRacecards, report.warnings);
            tomorrowItems = dedupeRaceCollisionsAndCapPerMeeting(tomorrowItems, report.warnings);
            tomorrowItems.forEach(function(item) { item.isTomorrow = true; item.date = tomorrowDate; });
            try { await redisSet('intelligence:' + tomorrowDate, { items: tomorrowItems, generatedAt: new Date().toISOString() }); } catch(re) {}
            try {
              await new Promise((resolve, reject) => {
                const url = new URL(UPSTASH_URL);
                const req = https.request({
                  hostname: url.hostname,
                  path: '/expire/' + encodeURIComponent('intelligence:' + tomorrowDate) + '/172800',
                  method: 'POST',
                  headers: { 'Authorization': 'Bearer ' + UPSTASH_TOKEN }
                }, res => { let d = ''; res.on('data', c => d += c); res.on('end', () => resolve(d)); });
                req.on('error', reject); req.end();
              });
            } catch(re) {}
            try { await safeWriteReport(tomorrowDate, { intelligence: tomorrowItems, generatedAt: new Date().toISOString() }); } catch(re) {}
            try {
              await new Promise((resolve, reject) => {
                const url = new URL(UPSTASH_URL);
                const req = https.request({
                  hostname: url.hostname,
                  path: '/expire/' + encodeURIComponent('daily:report:' + tomorrowDate) + '/172800',
                  method: 'POST',
                  headers: { 'Authorization': 'Bearer ' + UPSTASH_TOKEN }
                }, res => { let d = ''; res.on('data', c => d += c); res.on('end', () => resolve(d)); });
                req.on('error', reject); req.end();
              });
            } catch(re) {}
          }
        } else {
          console.log(`[daily-build] No race cards found for tomorrow (${tomorrowDate}) — tomorrow intelligence will be skipped`);
        }
        } else {
          report.errors.push('Tomorrow intelligence skipped — today\'s race cards were empty');
        }

        report.callLog.push({ type: 'intelligence', label: 'Daily Intelligence', inputTokens: intIT, outputTokens: intOT, cacheReadTokens: intCR, cacheWriteTokens: intCW, webSearch: intWS > 0, webSearchCount: intWS });
      }
      if (items && items.length) {
        report.intelligenceItems = items.length;
        report.intelligence = items;
        const tipsterItem = items.find(i => i.signalType === 'Tipster Consensus');
        if (tipsterItem) tipsterConsensusText = tipsterItem.intelligenceText || '';
      }
      report.inputTokens += intIT;
      report.outputTokens += intOT;
      report.cacheReadTokens += intCR;
      report.cacheWriteTokens += intCW;
      report.webSearchCount += intWS;
    } catch(e) {
      report.errors.push('intelligence: ' + e.message);
    }
    try { await safeWriteReport(today, report); } catch(re) { report.errors.push('redis-write daily:report:' + today + ': ' + re.message); }

    // 3.5 Trainer form table — a full leaderboard of today's trainers by 14-day strike
    // rate. Placed here, outside the cache-check above, so it runs unconditionally on
    // every build regardless of whether Daily Intelligence (and therefore the Hot Yard
    // signal, which only runs inside generateIntelligence()) was served from cache or
    // regenerated — Hot Yard's own trainerFormMap/trainerFormCandidates are local to
    // that function and never computed at all on a cache hit, so this does its own
    // independent pass over racecards instead of depending on that data.
    try {
      const trainerTableMap = {};
      racecards.forEach(function(race) {
        (race.runners || []).filter(function(r) { return !r.is_non_runner; }).forEach(function(r) {
          const t14 = r.trainer_14_days || {};
          const runs = t14.runs || 0, wins = t14.wins || 0, pct = parseFloat(t14.percent) || 0;
          if (runs >= 3 && r.trainer && !trainerTableMap[r.trainer]) {
            trainerTableMap[r.trainer] = { trainer: r.trainer, trainer_id: r.trainer_id || '', runs: runs, wins: wins, pct: pct };
          }
        });
      });

      const trainerTableTop30 = Object.values(trainerTableMap).sort(function(a, b) {
        return b.pct - a.pct;
      }).slice(0, 30);

      const trainerFormTable = trainerTableTop30.map(function(entry) {
        return {
          trainerName: entry.trainer,
          runners14d: entry.runs,
          winners14d: entry.wins,
          strikeRate: entry.pct
        };
      });

      await redisSet('trainer-form:table:' + today, trainerFormTable);
    } catch (e) {
      console.log('[daily-build] trainer-form:table write failed: ' + e.message);
    }

    // 4. Analyse each upcoming race — tipster consensus from intelligence passed in, 1 web search per race
    if (RUN_FULL_BUILD) {
    const BATCH = 4;
    for (let i = 0; i < racecards.length; i += BATCH) {
      const batch = racecards.slice(i, i + BATCH);
      const results = await Promise.allSettled(batch.map(async race => {
        const NH = isJumps(race.race_name, race.type);
        const raceKey = `analysis:race:${today}:${race.course_id || race.course}:${race.off_time}`;
        const t24 = (function(offDt){ if(!offDt) return race.off_time||''; var m=offDt.match(/T(\d{2}):(\d{2})/); return m?m[1]+':'+m[2]:race.off_time||''; })(race.off_dt);
        const label = `${race.course} ${t24}`;

        try {
          // Skip if already analysed today — prevents double-billing on re-runs
          const existing = await redisGet(raceKey);
          if (existing && existing.result) {
            return { label, ok: true, inputTokens: 0, outputTokens: 0, runners: (race.runners||[]).length, result: existing.result, cached: true };
          }
          const { result, inputTokens, outputTokens, cacheReadTokens, cacheWriteTokens, webSearchCount } = await analyseRace(race, NH, tipsterConsensusText);
          if (result) {
            try { await redisSet(raceKey, { result, analysedAt: new Date().toISOString(), NH }); } catch(re) {}
            if (result.raceHook) {
              try { await redisSet('hook:race:' + today + ':' + (race.course_id || race.course) + ':' + race.off_time, result.raceHook); } catch(re) {}
            }
          }
          return { label, ok: !!result, inputTokens, outputTokens, cacheReadTokens: cacheReadTokens || 0, cacheWriteTokens: cacheWriteTokens || 0, webSearchCount: webSearchCount || 0, runners: (race.runners||[]).length, result };
        } catch(e) {
          report.errors.push(label + ': ' + e.message);
          return { label, ok: false, inputTokens: 0, outputTokens: 0, runners: 0, result: null };
        }
      }));

      results.forEach(r => {
        const v = r.status === 'fulfilled' ? r.value : { ok: false, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, webSearchCount: 0, label: '?', runners: 0, result: null };
        if (v.ok) report.racesAnalysed++;
        if (v.cached) report.racesCached = (report.racesCached || 0) + 1;
        report.inputTokens += v.inputTokens;
        report.outputTokens += v.outputTokens;
        report.cacheReadTokens += (v.cacheReadTokens || 0);
        report.cacheWriteTokens += (v.cacheWriteTokens || 0);
        report.webSearchCount += (v.webSearchCount || 0);
        report.raceBreakdown.push({ race: v.label, ok: v.ok, runners: v.runners, inputTokens: v.inputTokens, outputTokens: v.outputTokens, cacheReadTokens: v.cacheReadTokens || 0, cacheWriteTokens: v.cacheWriteTokens || 0, webSearch: (v.webSearchCount || 0) > 0, webSearchCount: v.webSearchCount || 0, cached: !!v.cached });
        if (!v.cached) report.callLog.push({ type: 'race-analysis', label: v.label, inputTokens: v.inputTokens, outputTokens: v.outputTokens, cacheReadTokens: v.cacheReadTokens || 0, cacheWriteTokens: v.cacheWriteTokens || 0, webSearch: (v.webSearchCount || 0) > 0, webSearchCount: v.webSearchCount || 0 });
        if (v.result) report.analyses.push({ race: v.label, ...v.result });
      });
      try { await safeWriteReport(today, report); } catch(re) { report.errors.push('redis-write daily:report:' + today + ': ' + re.message); }
    }
    }

    // 5. Generate per-horse form summaries and race form overviews
    // Use cached racecard data (stored at step 2 from morning fetch) so runner lists
    // are intact even when re-running late in the day after the API strips completed runners
    console.log('[daily-build] Generating form summaries...');
    let formHorsesGenerated = 0, formRacesGenerated = 0;
    let formSourceCards = allRacecards;
    try {
      const cachedCards = await redisGet('daily-build:raw-racecards:' + today);
      if (cachedCards && Array.isArray(cachedCards.racecards) && cachedCards.racecards.length > 0) {
        formSourceCards = cachedCards.racecards.filter(r => {
          const reg = (r.region || '').toUpperCase();
          if (reg !== 'GB' && reg !== 'IRE' && reg !== 'IE') return false;
          return true;
        });
        console.log('[daily-build] Using cached racecards for form summaries (' + formSourceCards.length + ' races)');
      }
    } catch(e) { /* fall back to allRacecards */ }

    for (let fi = 0; fi < formSourceCards.length; fi += 2) {
      const formBatch = formSourceCards.slice(fi, fi + 2);
      await Promise.allSettled(formBatch.map(async race => {
        const raceContext = {
          course: race.course || '',
          distance: race.distance || '',
          going: race.going || 'Good',
          type: isJumps(race.race_name, race.type) ? 'NH' : 'Flat'
        };
        const raceKey = `analysis:race:${today}:${race.course_id || race.course}:${race.off_time}`;
        const runners = (race.runners || []).filter(r => !r.is_non_runner && r.horse_id);
        if (!runners.length) return;

        // Fetch form history: use in-memory cache if populated (fresh build), otherwise
        // fetch sequentially per runner to avoid Racing API rate limits on re-runs
        const runnerForms = [];
        for (const r of runners) {
          const history = await fetchHorseHistory(r.horse_id);
          if (history.length > 0) {
            runnerForms.push({ runner: r, history });
            // Cache history to Redis so Form Focus never needs a live API call
            redisSet(`form:history:${r.horse_id}:${today}`, history).catch(() => {});
          }
        }

        // Generate per-horse summaries sequentially — parallel batches cause Anthropic rate-limit errors
        const validHorseSummaries = [];

        if (validHorseSummaries.length >= 1) {
          // Build per-horse form fit grid data
          const runnerFormFit = validHorseSummaries.map(({ horseName, summary }) => ({
            horseName,
            fitRating: summary.fitRating || 'Neutral',
            keyAngle: summary.keyAngle || '',
            groundFit: summary.groundFit || '',
            distanceFit: summary.distanceFit || '',
            courseHandedness: summary.courseHandedness || '',
            formTrend: summary.formTrend || ''
          }));

          // Generate race-level form overview (needs >= 2 horses)
          let formOverview = null;
          if (RUN_FULL_BUILD) {
          if (validHorseSummaries.length >= 2) {
            try {
              const existingForOverview = await redisGet(raceKey);
              const existingResultForOverview = existingForOverview && (existingForOverview.result || existingForOverview);
              if (existingResultForOverview && existingResultForOverview.formOverview && existingResultForOverview.formOverview.formSummary) {
                formOverview = existingResultForOverview.formOverview;
              } else {
                const raceSummaryData = await generateRaceFormSummary(race, raceContext, validHorseSummaries);
                if (raceSummaryData) {
                  const { _tokens, ...fo } = raceSummaryData;
                  report.inputTokens += (_tokens?.input || 0);
                  report.outputTokens += (_tokens?.output || 0);
                  report.cacheReadTokens += (_tokens?.cacheRead || 0);
                  report.cacheWriteTokens += (_tokens?.cacheWrite || 0);
                  report.callLog.push({ type: 'race-form-overview', label: race.course + ' ' + (race.off_time || ''), inputTokens: _tokens?.input || 0, outputTokens: _tokens?.output || 0, cacheReadTokens: _tokens?.cacheRead || 0, cacheWriteTokens: _tokens?.cacheWrite || 0, webSearch: false, webSearchCount: 0 });
                  formOverview = fo;
                  formRacesGenerated++;
                }
              }
            } catch(e) {
              report.errors.push(`form:race:${race.course}: ${e.message}`);
            }
          }
          }

          // Merge runnerFormFit (and formOverview if generated) into race analysis
          try {
            const existing = await redisGet(raceKey);
            if (existing) {
              if (existing.result) {
                const merged = { ...existing.result, runnerFormFit };
                if (formOverview) merged.formOverview = formOverview;
                await redisSet(raceKey, { ...existing, result: merged });
              } else {
                const merged = { ...existing, runnerFormFit };
                if (formOverview) merged.formOverview = formOverview;
                await redisSet(raceKey, merged);
              }
            }
          } catch(e) {
            report.errors.push(`form:merge:${race.course}: ${e.message}`);
          }

          // Also update report.analyses so get-daily-build returns runnerFormFit
          const t24label = (function(offDt){ if(!offDt) return race.off_time||''; var m=offDt.match(/T(\d{2}):(\d{2})/); return m?m[1]+':'+m[2]:race.off_time||''; })(race.off_dt);
          const raceLabel = race.course + ' ' + t24label;
          const analysisEntry = report.analyses.find(function(a){ return a.race === raceLabel; });
          if (analysisEntry) {
            analysisEntry.runnerFormFit = runnerFormFit;
            if (formOverview) analysisEntry.formOverview = formOverview;
          }
        }
      }));
    }
    report.formHorsesGenerated = formHorsesGenerated;
    report.formRacesGenerated = formRacesGenerated;
    console.log(`[daily-build] Form summaries complete: ${formHorsesGenerated} horses, ${formRacesGenerated} races`);

    // 5.5 Cross-reference intelligence items against race analyses
    // Drop any intelligence card whose horse conflicts with the race analysis pick for that race.
    // A card survives only if: (a) it has no specific race/time, (b) no analysis exists for that race,
    // or (c) its horse matches the strongestSelection. This prevents two different horses being
    // recommended for the same race across the two layers.
    if (report.intelligence && report.intelligence.length && report.analyses && report.analyses.length) {
      const _normH = s => (s || '').toLowerCase()
        .replace(/\s*\((ire|gb|fr|usa|ger|aus|nz|ity|spa|bel|den|swe|nor|cze|pol|hun|por|tur|chi|arg|bra|jap|hkg|uae|can|saf|ind)\)/g, '')
        .replace(/[^a-z0-9]/g, '');

      // Build lookup: "TIME|courseFirstWord" → normalised strongest selection horse
      const _aLookup = {};
      for (const a of report.analyses) {
        if (!a.strongestSelection || !a.strongestSelection.horseName) continue;
        const parts = (a.race || '').split(' ');
        const time = parts[parts.length - 1] || '';
        const courseFirst = (parts[0] || '').toLowerCase();
        if (time && courseFirst) _aLookup[time + '|' + courseFirst] = _normH(a.strongestSelection.horseName);
      }

      const _before = report.intelligence.length;
      report.intelligence = report.intelligence.filter(item => {
        // Extract time and course from meta e.g. "14:30 Ascot · Queen Mary Stakes"
        const m = (item.meta || '').match(/^(\d{1,2}:\d{2})\s+([A-Za-z]+)/);
        if (!m) return true; // no time pattern → hot yard / info card → keep
        const key = m[1] + '|' + m[2].toLowerCase();
        const selHorse = _aLookup[key];
        if (!selHorse) return true; // no analysis for this race → keep
        const intelHorse = _normH(item.horseName || '');
        if (!intelHorse) return true; // no specific horse (info card) → keep
        return intelHorse === selHorse; // keep only if signal confirms the analysis pick
      });

      const _dropped = _before - report.intelligence.length;
      if (_dropped > 0) console.log(`[daily-build] Intelligence cross-ref: dropped ${_dropped} item(s) conflicting with race analysis picks`);
    }

    // 6. Calculate cost and store final report
    // AUDIT-DAILY-INTELLIGENCE.md, finding S4: report.costUSD used to silently
    // omit the tomorrow call's entire cost — its tokens were tracked in separate
    // tomorrowInputTokens/etc. accumulators but never folded into the total here.
    // report.inputTokens/etc. stay today-only (other code reads them for that
    // purpose); the cost figures below combine both calls into one true total,
    // plus a today/tomorrow split for transparency.
    const combinedInputTokens      = report.inputTokens + tomorrowInputTokens;
    const combinedOutputTokens     = report.outputTokens + tomorrowOutputTokens;
    const combinedCacheWriteTokens = report.cacheWriteTokens + tomorrowCacheWriteTokens;
    const combinedCacheReadTokens  = report.cacheReadTokens + tomorrowCacheReadTokens;
    const combinedWebSearchCount   = report.webSearchCount + tomorrowWebSearchCount;

    const costTokens    = combinedInputTokens * PRICE_IN + combinedOutputTokens * PRICE_OUT;
    const costCache     = combinedCacheWriteTokens * PRICE_CACHE_WRITE + combinedCacheReadTokens * PRICE_CACHE_READ;
    const costWebSearch = combinedWebSearchCount * PRICE_WEB_SEARCH;
    const cost = costTokens + costCache + costWebSearch;
    const todayCostUSD = (report.inputTokens * PRICE_IN + report.outputTokens * PRICE_OUT + report.cacheWriteTokens * PRICE_CACHE_WRITE + report.cacheReadTokens * PRICE_CACHE_READ + report.webSearchCount * PRICE_WEB_SEARCH);
    const tomorrowCostUSD = (tomorrowInputTokens * PRICE_IN + tomorrowOutputTokens * PRICE_OUT + tomorrowCacheWriteTokens * PRICE_CACHE_WRITE + tomorrowCacheReadTokens * PRICE_CACHE_READ + tomorrowWebSearchCount * PRICE_WEB_SEARCH);
    report.costUSD = cost.toFixed(4);
    report.costBreakdown = {
      inputTokenCost:      (combinedInputTokens * PRICE_IN).toFixed(4),
      outputTokenCost:     (combinedOutputTokens * PRICE_OUT).toFixed(4),
      cacheWriteCost:      (combinedCacheWriteTokens * PRICE_CACHE_WRITE).toFixed(4),
      cacheReadCost:       (combinedCacheReadTokens * PRICE_CACHE_READ).toFixed(4),
      webSearchCost:       (costWebSearch).toFixed(4),
      webSearchCount:      combinedWebSearchCount,
      totalInputTokens:    combinedInputTokens,
      totalOutputTokens:   combinedOutputTokens,
      totalCacheWrite:     combinedCacheWriteTokens,
      totalCacheRead:      combinedCacheReadTokens,
      todayCostUSD:        todayCostUSD.toFixed(4),
      tomorrowCostUSD:     tomorrowCostUSD.toFixed(4)
    };
    report.completedAt = new Date().toISOString();

    try { await safeWriteReport(today, report); } catch(re) { report.errors.push('redis-write daily:report:' + today + ': ' + re.message); }
    console.log(`[daily-build] Done. ${report.racesAnalysed}/${report.upcomingRaces} upcoming races analysed. Cost: $${report.costUSD}`);

    // 7. Send build report email — best-effort, must never crash the build
    try {
      const SIGNAL_TYPES = ['Tipster Consensus', 'Ground Edge', 'Course and Distance', 'Class Drop', 'Hot Yard', 'Intelligence'];
      const intelligenceFailMsg = report.errors.find(function(e) { return e.indexOf('Intelligence parse failed') === 0; });

      const signalLines = SIGNAL_TYPES.map(function(signalType, i) {
        if (intelligenceFailMsg) {
          return 'Signal ' + (i + 1) + ' ' + signalType + ': ERROR: ' + intelligenceFailMsg;
        }
        const count = (report.intelligence || []).filter(function(item) { return item.signalType === signalType; }).length;
        if (count === 0 && signalType === 'Tipster Consensus' && report.webSearchCount === 0) {
          return 'Signal ' + (i + 1) + ' ' + signalType + ': No web search fired — possible web search tool failure';
        }
        return 'Signal ' + (i + 1) + ' ' + signalType + ': ' + (count > 0 ? count + ' card(s) produced' : 'No edge found');
      });

      const tomorrowDateForEmail = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
      const tomorrowFailMsg = report.errors.find(function(e) { return e.indexOf('Tomorrow intelligence parse failed') === 0; });
      let tomorrowLine;
      if (tomorrowFailMsg) {
        tomorrowLine = 'Tomorrow Intelligence: ERROR: ' + tomorrowFailMsg;
      } else {
        let tomorrowStoredItems = [];
        try {
          const tomorrowIntel = await redisGet('intelligence:' + tomorrowDateForEmail);
          tomorrowStoredItems = (tomorrowIntel && tomorrowIntel.items) || [];
        } catch (e) { tomorrowStoredItems = []; }
        tomorrowLine = 'Tomorrow Intelligence: ' + (tomorrowStoredItems.length > 0 ? tomorrowStoredItems.length + ' card(s) produced' : 'No signals fired');
      }

      // AUDIT-DAILY-INTELLIGENCE.md, finding S4: this used to run its own separate,
      // hand-rolled cost calculation that intentionally diverged from report.costUSD
      // (omitted cache cost, priced web search at a stale $0.01 instead of the
      // correct $0.10) — the emailed number was simply wrong. report.costUSD /
      // report.costBreakdown are now the one correct, combined-today+tomorrow total
      // (see step 6 above); the email just reports that figure directly.
      const cb = report.costBreakdown || {};

      const emailSubject = (report.errors && report.errors.length)
        ? 'Daily Intelligence FAILED - ' + today
        : 'Daily Intelligence Complete - ' + today;

      const emailBody = signalLines.concat([
        tomorrowLine,
        '',
        'Total Cost: $' + report.costUSD,
        '  Input: $' + (cb.inputTokenCost || '0.0000') + ' | Output: $' + (cb.outputTokenCost || '0.0000') + ' | Cache write: $' + (cb.cacheWriteCost || '0.0000') + ' | Cache read: $' + (cb.cacheReadCost || '0.0000') + ' | Web search: $' + (cb.webSearchCost || '0.0000') + ' (' + (cb.webSearchCount || 0) + ' searches)',
        '  Today: $' + (cb.todayCostUSD || '0.0000') + ' | Tomorrow: $' + (cb.tomorrowCostUSD || '0.0000'),
        '',
        'Errors: ' + (report.errors.length ? report.errors.join('; ') : 'None'),
        '',
        'Warnings:',
        (report.warnings && report.warnings.length ? report.warnings.map(function(w) { return '- ' + w; }).join('\n') : 'None')
      ]).join('\n');

      const transporter = nodemailer.createTransport({
        service: 'gmail',
        auth: { user: process.env.GMAIL_USER, pass: process.env.GMAIL_APP_PASSWORD }
      });
      await transporter.sendMail({
        from: process.env.GMAIL_USER,
        to: 'gcoyne87@gmail.com',
        subject: emailSubject,
        text: emailBody
      });
    } catch (e) {
      // Email failure must never crash the build — swallow.
    }

    try { await redisSet('build:lock:' + today, null); } catch (ue) {}
    return { statusCode: 200, headers, body: JSON.stringify(report, null, 2) };

  } catch(e) {
    report.errors.push('FATAL: ' + e.message);
    report.completedAt = new Date().toISOString();
    console.error('[daily-build] Fatal:', e.message);
    // AUDIT-DAILY-INTELLIGENCE.md, finding S2: a crash before the first mid-build
    // redisSet used to leave zero evidence in Redis beyond the bare heartbeat —
    // the report body above is never observed by anything for a background
    // function. Write the crash itself so an early failure leaves a trail.
    try {
      if (UPSTASH_URL && UPSTASH_TOKEN) {
        await redisSet('build:crash:' + today, { message: e.message, stack: e.stack || '', at: new Date().toISOString() });
      }
    } catch (ce) {}
    try { if (UPSTASH_URL && UPSTASH_TOKEN) await redisSet('build:lock:' + today, null); } catch (ue) {}
    return { statusCode: 500, headers, body: JSON.stringify(report, null, 2) };
  }
};
