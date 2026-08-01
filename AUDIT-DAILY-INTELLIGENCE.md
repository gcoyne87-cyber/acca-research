# Daily Intelligence System — Full Audit

**Date of audit:** 2026-08-01
**Method:** Fresh-eyes verification against the live repo, the live deployed state (Netlify Functions API, GitHub Actions API), and real Redis data — not against prior session summaries. Every claim below is either a quoted line from the current codebase or a live value pulled during this audit. Where evidence was ambiguous or unobtainable, that is stated explicitly rather than inferred.

**Scope note on effort:** Sections 1–5 and 7 are backed by direct code reads (with line numbers) and live data pulls performed during this audit, plus two parallel sub-agent investigations (frontend card lifecycle, and email/cost code) whose findings are folded in and independently spot-checked against the code. Section 6 items 1–2 draw on firsthand work done earlier in this same working session (the service worker and tomorrow-CTA fixes were diagnosed, shipped, and live-browser-verified directly, not inferred).

---

## SECTION 1 — HOW IT RUNS

### The three trigger paths, verified live

**1. Netlify scheduled function** — `netlify/functions/daily-build-background.js:4`
```js
module.exports.config = { schedule: '30 9 * * *', timeout: 900 };
```
Verified live via the Netlify Functions API (`searchSiteFunctions`) as of this audit:
```
daily-build-background | im: background | schedule: 30 9 * * *
```
The schedule **is** registered on the live deployed function — this is not a code-vs-deploy mismatch. However, git history shows this was not always true: the schedule was explicitly commented out on 2026-07-08 (`3e92327 — "Disable daily-build-background's automatic 09:30 UTC schedule; manual trigger still works"`) and only re-enabled on 2026-07-29 22:14 BST (`b63209c`). Any absence of evidence for a scheduled firing before 2026-07-30 is expected, not suspicious — the schedule was off.

**2. GitHub Actions safety net** — `.github/workflows/daily-build-safety-net.yml`
- Cron: `40 9 * * *` (10 minutes after Netlify's schedule). Also `workflow_dispatch` for manual runs.
- Confirmed live: workflow state `active`, secrets `BUILD_SECRET`, `UPSTASH_REDIS_REST_TOKEN`, `UPSTASH_REDIS_REST_URL` all present.
- Logic: reads `daily:report:{today-UTC}` from Redis via a **read-only** Upstash token (a dedicated Redis ACL user, `-@all +@read`, created this session — verified it can read but gets `NOPERM` on write attempts). If `intelligence.length` (or `intelligenceItems`) is `> 0`, it stands down. Otherwise it POSTs to `daily-build-test-background` with `x-build-secret`.
- Tested twice via manual dispatch this session, both times correctly standing down against a real, existing report (confirmed via workflow run logs: *"daily:report:2026-08-01 already has 5 card(s). Netlify's scheduled build ran — nothing to do."*). **The fallback-trigger branch has never fired for real** — it has only been exercised via direct `curl` calls to `daily-build-test-background`, not via the workflow itself detecting a genuinely missing report. This is a real, unclosed verification gap: the skip path is proven, the trigger path is not proven end-to-end through the workflow.

**3. Manual twin** — `netlify/functions/daily-build-test-background.js`
```js
module.exports.config = { timeout: 900 };
module.exports.handler = require('./daily-build-background.js').handler;
```
An unscheduled re-export of the exact same handler. Auth: `daily-build-background.js:1160-1166` checks `event.headers['x-build-secret']` against `process.env.BUILD_SECRET` for any non-scheduled invocation (`isScheduled = !event.httpMethod`). `BUILD_SECRET` was rotated this session; verified the old value is now rejected (the handler wrote its heartbeat — which happens before the auth check — but never reached the report-generation code, i.e., a clean 401).

### What should happen tomorrow morning, minute by minute

| Time (UTC) | Event | Redis evidence |
|---|---|---|
| 09:30 | Netlify's cron *should* invoke `daily-build-background` | `debug:build-heartbeat:{date}` written unconditionally as the literal first line of the handler (`daily-build-background.js:1138-1144`), before even the auth check. Field `scheduled: !event.httpMethod` → `true` for a real cron firing. |
| 09:30–~09:35 to 09:47+ | Build runs — today's intelligence call, then tomorrow's. **Observed real durations this session: 5 to over 17 minutes**, dominated by serial per-horse Racing API history calls in the Course & Distance / Class Drop pre-computation loops. | `daily:report:{today}` written multiple times through the run (unconditionally — see Section 3). `intelligence:{today}` written once, only if items were produced. |
| 09:40 | GitHub Actions safety net fires, checks `daily:report:{today}` | If the 09:30 run already finished and wrote a non-empty report, the Action stands down. |
| **Race condition** | **If the 09:30 run is still in flight past 09:40 (plausible — several real runs this session exceeded 10 minutes), the safety net sees no report yet, concludes the scheduler failed, and triggers `daily-build-test-background` — a second, fully redundant build starts while the first is still running.** Both will eventually write `intelligence:{today}` / `daily:report:{today}` (last writer wins, no locking), and **both will send their own post-build email** — directly contradicting the stated design goal ("no duplicate builds, no double emails"). This is not hypothetical; it follows directly from the 10-minute gap chosen versus the actually-observed build durations. See Section 7, rated CRITICAL. |
| 09:30 (either run) email | Post-build email sent from inside `daily-build-background.js` at the end of the handler. Subject `Daily Intelligence Complete - {date}` or `Daily Intelligence FAILED - {date}`, driven **only** by `report.errors.length`, never by warnings (verified clean — see Section 5). |
| 23:00 | `fetch-future-cards-background` (separately scheduled, `schedule: '0 23 * * *'`) fetches future racecards and sends a distinct "Daily Intelligence Ready / Not Ready" email for the *next* day, based on whether a tomorrow-preview intelligence sweep found any items. |
| 23:30 / 23:50 | `fetch-horse-history-1-background` / `-2-background` pre-warm `form:history:{horse_id}:{date}` for the next 3 days, feeding the morning build's cache. |

### Failure-mode matrix for the Redis tripwires

| Scenario | `debug:build-heartbeat:{date}` | `daily:report:{date}` |
|---|---|---|
| Netlify fires and completes normally | Written, `scheduled:true` | Populated with real data, `errors:[]` |
| Netlify never invokes the function at all | **Absent entirely for that date** (nothing else has run yet) | Absent |
| Netlify invokes but the function crashes *before* its first `redisSet('daily:report:'+today, report)` (line 1782) | Written (`scheduled:true`) — proves an invocation started | **Absent** — the crash reason is lost forever; the outermost `catch` (line 2106-2110) does not write to Redis. Only Netlify's own function logs would show it, and this session repeatedly found those logs inaccessible/unreliable via CLI. |
| Netlify's run is still mid-flight when the safety net checks at 09:40 | Written, `scheduled:true` | Absent or has fewer items than the run will eventually produce — safety net **cannot distinguish "still running" from "never started"** and triggers a redundant second build |
| A run completes but produces zero cards (e.g. a parse failure) | Written | **Populated with `intelligenceItems:0`, overwriting whatever good report was there before** — this is the guard failure documented in Section 3, and it happened for real this session, wiping the live site's carousel until manually restored |

---

## SECTION 2 — THE SIGNALS, AS THE CODE ACTUALLY IMPLEMENTS THEM

All line numbers refer to `netlify/functions/daily-build-background.js` as of this audit. Today's pre-computation runs first (~line 744 onward); tomorrow's is a **near-complete line-for-line duplicate** starting ~line 1352, with `tomorrow`-prefixed names (see Section 7, finding #1 — this is the single largest fragility in the file).

### Today's 6 signals

**1. Tipster Consensus** — prompt-only (web search), no pre-computed candidate pool. Explicit prompt rule (line 381): must not pick a horse priced shorter than 1/2; must never name a publication.

**2. Ground Edge** (lines 830-885) — Heavy/Yielding jumps races only (`GROUND_RE = /heavy|yield/i` AND `isJumps()`, line 834). Per horse: `groundRuns.length >= 2 && groundWins >= 1` (line 853), then qualifies if `groundWins >= 2 || groundSR >= 33` (line 856). **Matches the intended spec exactly.** Capped at the top 12 heavy-going meetings and top 15 runners per race during scanning (line 838, 842 — a scan-cost cap, not a quality cap), then the final candidate list is the global top 3 by wins-then-SR (line 885).

**3. Course and Distance** (lines 887-931) — two independent qualifying conditions, matching spec exactly:
- Condition A (line 901): `courseTopTwo.length >= 2 && courseTopTwoRate >= 33`
- Condition B (line 904): `courseWins.length >= 1` (any win at the course, regardless of distance/going)
Sorted by top-2 count then rate (928-931), displayed top 5 (line 1045).

**4. Class Drop** (lines 933-1014) — two pools:
- Pool 1, Class Drop (935-979): today's race must itself be Class 1-3 numerically (`todayClassNum = parseClassNum(race.race_class)`, only proceeds if not null, line 944-945); horse's most recent class-recorded run must be Class ≤3 (line 962); `classDrop = todayClassNum - lastRunClassNum`, qualifies if `>= 1`. **Note:** the code comment at line 933-934 says "at least 2 classes lower" but the actual check (line 965: `if (classDrop < 1) continue;`) is **at least 1 class** — the comment is stale, the message sent to the model (line 1057) correctly says "at least 1 class today," matching the code, not the comment. Cosmetic mismatch, not a functional bug.
- Pool 2, OR Gap (981-1014): top-rated horse in a race qualifies if its OR is `>= 8` points clear of the second-best rated horse in the same race. Capped to top 5 by gap size (`orGapCandidates.splice(5)`, line 1014 — mutates in place, unlike Class Drop's pool which is only `.slice(0,5)` at display time, non-mutating).
- **Structural finding (see also Section 6, item 3): Pool 1 is effectively starved.** Every historical result entry checked this audit (26 races across 5 different horses, 100% sample) has `race_class: ""` — empty. `fetchHorseHistory` (line 107) maps `race_class: race.race_class || ''` from the Racing API's `/v1/horses/{id}/results` endpoint, and that field appears to never be populated by that endpoint (today's live racecard entries *do* have `race_class`, e.g. "Class 2" — it's specifically the historical-results endpoint that's empty). Since Pool 1 requires `validClassRuns.length >= 2` (line 955) and valid entries require a non-null parsed class, Pool 1 can essentially never qualify a horse. In practice, every "Class Drop" card observed live this session (e.g. "Bang Bang," OR 74 vs field-high 40) was actually an OR Gap pick, not a genuine class-drop pick — the signal's name doesn't reflect what's actually driving it most of the time.

**5. Hot Yard** (lines 766-828) — trainer-level: `runs >= 5 && pct >= 25` over the last 14 days (line 773) to enter the candidate map, then a 60-day baseline fetch per trainer (one Racing API call each, 200ms spacing, line 797) to confirm `isHot = entry.pct >= 25 && entry.pct >= baseline60 * 1.5` (line 813) — i.e. current strike rate is both ≥25% and at least 50% above the trailing-60-day baseline. **Matches spec exactly.** A trainer with no baseline data, a zero baseline, or a failed API call is dropped entirely (not marked hot) — no silent false positive.

**6. Intelligence** (free rein) — only signal without a pre-computed pool; draws from the "FREE REIN INTELLIGENCE" section of the message (full today's card, every runner, line 1087-1089), up to 3 horses, web search available.

### Today-only signals — verified

**Tipster Consensus is correctly today-only**: the tomorrow message (`tomorrowMsg`) closes with an explicit instruction (line 1702): *"Do not produce Tipster Consensus cards for tomorrow."*

**Intelligence is NOT correctly enforced as today-only.** The tomorrow message never includes a "FREE REIN INTELLIGENCE" section at all (grepped for the literal string across the whole file — it appears only once, inside the shared `INTELLIGENCE_PROMPT` text and once in the today-message builder; `tomorrowMsg` never constructs one). The closing tomorrow-message instruction (line 1702) forbids Tipster Consensus explicitly but says nothing about Intelligence. **This is not a theoretical gap** — a real tomorrow build run captured live this session produced an `Intelligence`-signalType card (`"Dance In The Storm," 15:52 Chester, "unbeaten at course and distance"`) despite there being no free-rein data section in that day's message for the model to draw from. The model is filling the gap on its own initiative, not because the code told it to; the design intent ("today-only" per this audit's brief) is not enforced in the tomorrow prompt the way Tipster Consensus is.

### Tomorrow's 4 signals

Ground Edge, Course and Distance, Class Drop, Hot Yard — same thresholds as above, computed by an independent, nearly-identical block of code (see Section 7). The candidate-pool computations were verified correct on live data this session (Chester/Yarmouth/Galway, real horse names post-fix, zero duplicate-race cards, correctly spread across 2 meetings).

---

## SECTION 3 — THE PRODUCT RULES

**1. One card per race across all signals; collision keeps the data-verified signal; drop logged.**
✅ **Implemented and verified.** `dedupeRaceCollisionsAndCapPerMeeting()` (lines 605-667). `SIGNAL_STRENGTH_PRIORITY` (line 607): Tipster Consensus (1) > Course and Distance (2) > Class Drop (3) > Ground Edge (4) > Hot Yard (5) > Intelligence (6, lowest priority — the free-rein catch-all always loses a collision to a data-verified signal). On collision, the lower-priority card is dropped and a message pushed to `warningsOut` (line 635/639). Wired into both today (lines 1125-1126) and tomorrow (line 1730) paths; warnings flow into `report.warnings` (line 1320-1321 for today).

**2. Venue prestige excluded; max 3 cards per meeting backstop.**
✅ **Implemented.** Explicit prompt line (430): *"Venue prestige is not a factor... judge every candidate purely on the strength of its own data."* Code-level cap in the same dedup function (lines 643-664): only triggers when cards span more than one course (line 651 — a single-meeting day is never artificially thinned), keeps the top 3 by signal priority per course, drops and logs the rest.

**3. Email subject FAILED only for genuine failures; warnings separate.**
✅ **Implemented, verified clean.** Subject line is driven exclusively by `report.errors.length` — `report.warnings` is never referenced in the subject logic. Email body has a distinct Errors section and a distinct Warnings section.

**4. A failed/zero-card run must never overwrite a good same-day report.**
❌ **Not built.** This guard does not exist for the key that actually matters. `intelligence:{date}` *is* conditionally written (`if (items && items.length)`, line 1323/1731) — but `daily:report:{date}`, the key `get-daily-build.js` and the live frontend actually read, is written **unconditionally** at multiple points in the handler (lines 1197, 1269 [racecards cache, different key pattern], 1782, 1828, 2034), with no comparison against what's already stored. This is not a theoretical finding — it happened for real earlier this session: a run that hit a JSON-parse failure wrote `intelligenceItems: 0` over a good 5-card report, and the live site's Daily Intelligence carousel went empty until a manual re-run restored it. Rated CRITICAL in Section 7.

**5. Never a blank screen from a card CTA.**
⚠️ **Mostly true by design, but has a real gap.** The `race:`/`tomorrowrace:` routing path in `index.html`'s `selectRacingSection()` has explicit, well-commented no-blank-screen engineering (search-before-switch, fallback to the other day's meetings, single 800ms retry, catch-all `try/catch` that only logs a warning) — this part earns its "never blank" claim. However, the function's **generic fallthrough branch** (reached whenever `s` isn't one of the recognized prefixes/literals) unconditionally hides every content section and has no `else`/default case — landing there produces a genuinely empty content area, with the nav bar misleadingly still highlighting "Home." The only untrusted value that reaches this function is `item.ctaDestination`, which is LLM-generated per a prompt instruction (line 435) with **no backend schema validation** before being written to Redis and served to the frontend. A malformed or unexpected `ctaDestination` — which the model is free to write, since nothing checks it — is a live path to exactly the blank screen this rule says must never happen.

---

## SECTION 4 — CARD LIFECYCLE, TRACED WITH REAL DATA

Traced using a real card from today's live report (`daily:report:2026-08-01`): **"Far Above Dream," Course and Distance, Goodwood 15:35.**

1. **Generation**: produced by the Claude Sonnet 4.6 call in `generateIntelligence()`, selected from the Course & Distance candidate pool (qualified via Condition A — 3/3 top-2 finishes, 100% rate).
2. **Parse**: `extractJsonArray()` (lines 573-603) — a balanced-bracket scanner added this session after two live incidents where the naive `indexOf('[')/lastIndexOf(']')` extraction broke on trailing model output and wiped the day's cards. It correctly skips brackets inside string literals and stops at the array's true closing bracket. **This hardening was applied only to the array-based Intelligence parse.** The older, still-live `parseJson()` (object-brace version, lines 122-127) and the inline extraction inside `callClaudeSimple()` (lines 682-683) use the original naive pattern and were never hardened — currently dormant since they're only reached when `RUN_FULL_BUILD` is `true` (see Section 6/7).
3. **Redis writes**: `intelligence:2026-08-01` (conditional on non-empty items) and `daily:report:2026-08-01` (unconditional — see Section 3, finding 4). Both confirmed live and consistent this audit.
4. **`get-daily-build.js`**: reads `daily:report:{date}` (defaulting to server UTC "today," or a validated `?date=` param), passes `report.intelligence` through unmodified, separately derives a `picks` array from `report.analyses` (currently always empty — see Section 6/8, the whole per-race-analysis subsystem is dormant).
5. **Frontend fetch**: `loadDailyBuild()` fetches today's and tomorrow's build in parallel, applies the **retag** (`race:`→`tomorrowrace:`, `trainer:`→`tomorrowtrainer:`) to any item whose server-set `date` field is later than the browser's own UTC-today string — confirmed this is a simple, correct string comparison on zero-padded ISO dates.
6. **Render**: `renderAIIntelligence()` builds one card per item, injecting `item.ctaDestination` **verbatim and unvalidated** into an inline `onclick="selectRacingSection('...')"`.
7. **CTA click**: `selectRacingSection()`'s `race:`/`tomorrowrace:` branch normalizes the course name (lowercase, strip parenthetical country codes, collapse to hyphens) and the time (accepts 12h/24h/zero-padded variants), searches the correct day's meeting list, opens the meeting and race idempotently, with documented fallback behavior. Verified working live this session (screenshot-confirmed: clicking "Analyse Goodwood 15:35" correctly expanded Goodwood to the 15:35 race with the right runner list, zero related console errors).
8. **Service worker**: `sw.js` — cache name `racingedge-v2` (confirmed, not v1). Install pre-caches the app shell; activate deletes any cache that isn't `racingedge-v2`; fetch handler explicitly bypasses `.netlify/functions/`/`api.` URLs entirely (API calls always hit the network live, never cached), and for everything else is **network-first** — cache is only a fallback for offline, never served in preference to a live response, and is refreshed on every successful GET. This is correctly deployed and behaving; confirmed live this session via direct `navigator.serviceWorker.getRegistrations()` inspection (single registration, `active.state:"activated"`, no stale waiting worker).

---

## SECTION 5 — EMAILS AND COSTS

### Emails
Two emails relevant to Daily Intelligence, both via `nodemailer`/Gmail, both hardcoded to `to: 'gcoyne87@gmail.com'` (not an env var):

- **Post-build report** (`daily-build-background.js`, end of the handler): subject `Daily Intelligence Complete - {date}` / `Daily Intelligence FAILED - {date}`, driven only by `report.errors.length` (verified — see Section 3). Body has separate Errors and Warnings sections.
- **Midnight ready-notice** (`fetch-future-cards-background.js`, its own `schedule: '0 23 * * *'`): subject `Daily Intelligence Ready - {date}` / `Daily Intelligence Not Ready - {date}` based on `tomorrowItems.length > 0`. No errors/warnings section — just card count and signal names, with a hint to check Netlify logs if empty.

### Cost calculation — pricing constants correct, totals are not

Pricing constants (lines 14-18) correctly match Claude Sonnet 4.6's published rates: $3/M input, $15/M output, $3.75/M cache write (1.25× input), $0.30/M cache read (0.1× input), $0.10/web search. No staleness found here.

**However, neither of the two cost figures the system produces is a complete total:**
- `report.costUSD` (the "official" figure, written to Redis and shown by `get-daily-build`) is built entirely from `report.inputTokens`/`outputTokens`/etc. — accumulator fields that are **never incremented by the tomorrow call's usage**. The tomorrow call's own result only captures `inputTokens`/`outputTokens` (line ~1705-1706 area) and never even reads `cacheReadTokens`/`cacheWriteTokens`/`webSearchCount` off the response. **`report.costUSD` silently omits the entire tomorrow-build cost.**
- `emailCost` (used only in the post-build email body) does add tomorrow's input/output tokens, but the code's own comment admits it intentionally diverges from `report.costUSD`: it omits all cache read/write cost, and prices web search at **$0.01/call — a stale, 10× understatement** of the correct $0.10 rate used everywhere else in the same file, on top of only counting today's web searches (tomorrow's are never captured).

**Measured cost, live, this audit:** today's intelligence call alone: 76,548 input / 1,945 output tokens, 2 web searches, `costUSD: $0.4588`. This is an underestimate of the true full-day cost (today + tomorrow calls, all cache/search costs) — a true total was not directly measurable from stored data due to the bug above. Rough manual reconstruction (today's real figure + a comparable tomorrow call, which observed this session ran ~15-20K input tokens with no web search) suggests true full-day cost is in the **$0.50-0.60** range per day, i.e. roughly **$15-18/month** at current signal volume — but this is an audit-time estimate working around a known-broken official figure, not a value the system itself can currently produce correctly.

---

## SECTION 6 — KNOWN OPEN ITEMS

**1. Tomorrow-card CTAs after the service worker v2 fix — confirmed fixed, confirmed by a real end user action (via this session directly, not inferred).**
This was diagnosed and fixed in this exact working session, in two stages. First, `sw.js` was bumped to `racingedge-v2` with network-first fetch behavior (the earlier `v1` cache was suspected but, once live-inspected via `navigator.serviceWorker.getRegistrations()`, ruled out as the actual cause). The real bug was in `index.html`'s `renderTomorrowMeetingsList()`, which had been copy-pasted from the today-list renderer and never had its variable names updated — it read `todayOpenMeeting`/`rcOpenRace` and called `toggleTodayMeeting`/`todaySelectRace` instead of the `tm*` equivalents, so the click handler was correctly computing which meeting/race to open but the renderer never displayed it. Fixed and **verified via an actual simulated browser click** (not just a curl/API check): navigated to the live production site, clicked the real "Analyse Goodwood 15:35" button, and confirmed via screenshot that Goodwood expanded to the correct race with the correct runner list, plus a clean console read (zero errors attributable to the fix). **Status: confirmed fixed, confirmed by direct browser interaction.**

**2. SP-instead-of-live-odds on future cards — likely an expected data-source limitation, not investigated as a bug in code, and no evidence found that anyone dug deeper.**
`racecards.js` and `fetch-future-cards-background.js` both implement `extractPrice()` identically (down to the variable names) — both fall back to the literal string `'SP'` whenever the Racing API's `odds` array for a runner is empty. Since both today's and future dates' fetchers use the same fallback logic, this points to the Racing API itself simply not publishing firm bookmaker odds for races several days out (a standard, expected industry behavior — "SP" meaning "wait until race time"), rather than a code defect. No commit in git history specifically investigates or discusses this as a bug. **Status: no evidence this was ever formally investigated; current code evidence is consistent with "expected limitation," not "bug," but this has not been confirmed against the Racing API's own documentation or by comparing odds availability at different lead times.**

**3. Class Drop "no valid class data" warnings — confirmed real, and worse than the warning message alone suggests.**
Empirically verified this audit: 100% of cached historical race results checked (26 races across 5 different horses, zero exceptions) have `race_class: ""`. `fetchHorseHistory` correctly maps whatever the Racing API's `/v1/horses/{id}/results` endpoint provides (`race.race_class || ''`, line 107) — today's live racecard entries *do* have real class data, so this isn't the same class of bug as the earlier `runner.horse`/`runner.name` mismatch found this session; it looks like the results endpoint specifically doesn't return this field. Practical effect: Class Drop's "class drop" candidate pool (Pool 1) can essentially never qualify a horse, since it requires 2+ historical runs with a valid class — every "Class Drop" card actually observed this session was driven by the OR Gap pool (Pool 2) instead. **Status: confirmed real and structurally significant — not just noisy warnings, but a signal that's quietly running on one leg instead of two, with no error surfaced beyond a warning count.**

**4. Newton Abbot / Market Rasen now visible after filter removal.**
Confirmed via fresh grep this audit: `EXCLUDED_COURSES` and both course names return zero matches anywhere in `netlify/functions/*.js` or `index.html`. The filter is fully gone, not partially removed. **Flagged as awaiting your decision, per the brief — no recommendation made here.**

**5. Build-written ctaDestination times occasionally wrong — no validation exists.**
Confirmed by direct code read: the only place `ctaDestination` is referenced in the backend is the prompt instruction itself (lines 424, 435, 448) and the dedup helper's parsing (line 610, which extracts course/time as a grouping key but does not check it against real race data). There is **no post-generation validation anywhere** that cross-checks a card's embedded time against the actual off-time in that day's racecard before the card is written to Redis or shown to a user. The model is trusted to copy the time correctly from the data it was given; nothing catches it if it doesn't. **Status: still open, no mitigation built.**

**6. Upstash token rotation.**
The read-only token (for the GitHub Actions safety net) was created and deployed this session via Redis ACL commands run through the existing REST API — no dashboard needed, verified read succeeds / write returns `NOPERM`. The main read-write token rotation was attempted the same way and explicitly blocked by Upstash (`"ERR The 'default' user cannot be modified"`) — this is a deliberate platform protection requiring the Upstash dashboard's "Reset Password" action, which has not yet been completed. **Status: still open, pending a manual dashboard step outside this audit's scope.**

---

## SECTION 7 — BUG HUNT AND FRAGILITY REVIEW

### CRITICAL

**C1. Failed/zero-item runs silently overwrite good `daily:report:{date}` data.** (Detailed in Section 3, finding 4.) This is the single most consequential bug in the system: it already happened live this session and broke the production site's Daily Intelligence carousel until manually restored. No comparison against the existing report's item count or error state exists anywhere before the unconditional `redisSet` calls at lines 1197, 1782, 1828, 2034 (today) and the tomorrow-equivalent block. **Fix direction (not implemented per audit rules): before overwriting, compare the new report's item count / error state against what's already stored, and refuse to overwrite a report that had cards with one that has none, unless explicitly forced.**

**C2. Race condition between Netlify's scheduler and the GitHub Actions safety net can cause duplicate builds and duplicate emails.** (Detailed in Section 1.) The 10-minute gap between the two triggers is shorter than several real build durations observed this session. The only guard is the intelligence-cache check inside `generateIntelligence()`'s caller (line 1297-1302), which only helps if the *first* run has already written `intelligence:{today}` by the time the *second* run's own cache-check executes — if the first run is still mid-flight, the second run's own cache-check also sees nothing cached and proceeds to do a full, independent, concurrent build. There is no locking/mutex of any kind between invocations.

**C3. `ctaDestination` has no backend validation and one confirmed live path to a real blank screen.** (Detailed in Section 3, finding 5, and the frontend agent's finding #1.) `selectRacingSection()`'s generic fallthrough branch hides every section with no default case; the only untrusted input reaching it is an LLM-generated field with no schema enforcement.

### SHOULD FIX

**S1. Today/tomorrow near-duplicate code is the dominant fragility pattern in this file, and it is not contained to the 4+ bugs already attributed to it.** Confirmed present, line-for-line, in: Ground Edge pre-computation (830-885 vs ~1370-1428), Course & Distance pre-computation (887-931 vs ~1430+), Class Drop and OR Gap pre-computation (equivalent tomorrow blocks further down), Hot Yard/trainer pre-computation, and the message-assembly block that builds the prompt user-message. Every one of these is a fully separate, independently-maintained copy with `tomorrow`-prefixed names rather than a shared, parameterized function. This is precisely the pattern that produced the `runner.horse`/`runner.name` Unknown-name bug and the `renderTomorrowMeetingsList` copy-paste bug found and fixed earlier this session — both were cases where a fix landed on one side (today) and the maintainer had to remember to also apply it to the other (tomorrow), and in both cases initially didn't. The Intelligence-signal-leaking-into-tomorrow finding in Section 2 is arguably a third instance of the same root cause (the tomorrow message-builder was never given the same "forbid this signal" treatment as Tipster Consensus).

**S2. An early crash leaves no diagnostic trail.** (Detailed in Section 1's failure-mode matrix.) The outermost `catch` block (lines 2106-2110) pushes a `'FATAL: ...'` message onto `report.errors` and returns it in the HTTP response body — but for a background function, that response body is unobservable by anything except the function's own runtime logs (already established this session as unreliable to access via Netlify's CLI). It does not call `redisSet`. Any crash before the first successful `daily:report` write is invisible in Redis beyond the bare fact that an invocation started.

**S3. `parseJson()` and `callClaudeSimple()`'s inline JSON extraction remain unhardened.** (Detailed in Section 4.) Both still use the original naive `indexOf('{')/lastIndexOf('}')` pattern that caused two live incidents for the array-based Intelligence parse before it was fixed this session with a balanced-bracket scanner. These two are currently dormant (gated behind `RUN_FULL_BUILD = false`, confirmed via live data: `racesAnalysed: 0`, `analyses: []`, `formHorsesGenerated: 0`), but they are the exact code path that would activate if `RUN_FULL_BUILD` is ever flipped on — including for a future Form Summaries feature (see Section 8).

**S4. Cost reporting is silently incomplete.** (Detailed in Section 5.) `report.costUSD` omits tomorrow's entire cost; `emailCost` uses a stale 10× -under web-search price. Neither is flagged as an error or warning anywhere — the number is simply wrong, quietly, every day.

**S5. Intelligence signal is not actually restricted to today**, contrary to the apparent design intent, and contrary to how Tipster Consensus is correctly restricted. (Detailed in Section 2.)

### COSMETIC

**Co1. Stale code comment on Class Drop's threshold** — the comment at lines 933-934 says "at least 2 classes lower," the actual code and the model-facing message both correctly say "at least 1." No functional impact, but misleading to a future reader.

**Co2. `tomorrowtrainer:` branch in `index.html` calls `selectRacingDate('tomorrow')` twice in a row** (frontend agent finding #5) — harmless but sloppy, can trigger a redundant fetch.

**Co3. Two independently-written 12h/24h time-normalizer functions** in `index.html` doing the same job (frontend agent finding #6) — not wired together, a future fix to one won't propagate to the other.

**Co4. Dead/orphaned files with their own stale copies of the render/CTA logic are publicly reachable** as static assets (`index.backup.html`, `_check.js`, `sc11.js`, `sc11_check.js`) because `netlify.toml` publishes the whole repo root. Not a runtime risk to the live page (nothing includes them), but unnecessary attack/confusion surface, alongside numerous root-level `patch_*.js`/`fix_*.py`/debug-dump scratch files.

### Checked and found clean
- No unhandled promise rejections found: the file consistently uses `Promise.allSettled` for concurrent work, and every fire-and-forget `redisSet` call has an explicit `.catch(() => {})`.
- The one-card-per-race / venue-prestige / 3-per-meeting product rules are correctly implemented and shared between today and tomorrow (they live in one function, not duplicated) — a good counter-example to the general duplication problem above.
- The service worker is correctly deployed, versioned, and behaving (network-first, no stale-cache risk).

---

## SECTION 8 — VERDICT

**What this system does every morning, in plain English:** shortly after 9:30am UK time, a script pulls the day's (and the next day's) full race cards, runs a set of hard-coded statistical checks against each horse's and trainer's recent record (course form, class movements, rating gaps, hot streaks), hands the results to an AI model along with freedom to spot anything else worth a look, and produces 3-6 short intelligence cards that show up on the site and get emailed to you as a report. That's genuinely what's live and working. What is *not* currently live, despite existing in the code: individual race-by-race analysis ("Today's Selections"/picks) and per-horse Form Summaries — that entire subsystem is switched off (`RUN_FULL_BUILD = false`) and produces nothing at present.

**How confident should you be in it, right now:** the core signal logic is sound and was mostly verified to match its intended rules exactly. But the system has a real, demonstrated weak spot — it can silently destroy a good day's output and replace it with nothing, and it happened for real during this very audit period, not as a theoretical concern. The safety net you just had built is a genuine improvement but has an unproven trigger path and a real risk of firing a redundant, cost-doubling build on a day the real one just runs long. I'd call this system "works most days, and when it fails, it fails silently and can fail twice" — solid foundations, thin margins.

**Top 3 risks, in priority order:**
1. **A bad run can permanently erase a good day's cards with no self-correction** (C1). This is the highest-priority fix — it's already happened once live, and nothing in the current code prevents it happening again tomorrow.
2. **The build-duration-vs-safety-net-timing race condition** (C2) could double your Anthropic spend on any day Netlify's build simply runs a bit long, and would double the emails you get — undermining the exact thing the safety net was built to prevent.
3. **The today/tomorrow duplicated-code pattern** (S1) isn't one bug, it's a bug *factory* — it has already produced at least 3 confirmed incidents (Unknown horse names, the tomorrow-CTA render bug, and now the Intelligence-signal-leaking-into-tomorrow gap), and every future change to a shared rule has to be remembered and applied twice by hand.

**What I'd fix before building Form Summaries on top of this:** Form Summaries would activate the two still-unhardened JSON parsers (`parseJson()`, `callClaudeSimple()`'s inline extraction — S3) the moment `RUN_FULL_BUILD` goes on, inheriting the exact parse-fragility class that already broke the live site twice for the (already-hardened) Intelligence signal. I would harden those two parsers first, fix the no-overwrite guard (C1) so a bad Form Summaries run can't wipe good data either, and seriously consider collapsing the today/tomorrow duplication (S1) into one parameterized code path before adding a third day-dependent copy of the same logic on top of it.
