const https = require('https');

const UPSTASH_URL = process.env.UPSTASH_REDIS_REST_URL;
const UPSTASH_TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN;

function redisGet(key) {
  const url = new URL(UPSTASH_URL);
  return new Promise((resolve, reject) => {
    const req = https.request({
      hostname: url.hostname,
      path: '/get/' + encodeURIComponent(key),
      method: 'GET',
      headers: { 'Authorization': 'Bearer ' + UPSTASH_TOKEN }
    }, res => {
      let d = '';
      res.on('data', c => d += c);
      res.on('end', () => {
        try {
          const r = JSON.parse(d);
          resolve(r.result ? JSON.parse(r.result) : null);
        } catch(e) { resolve(null); }
      });
    });
    req.on('error', () => resolve(null));
    req.end();
  });
}

exports.handler = async function(event) {
  const headers = { 'Access-Control-Allow-Origin': '*', 'Content-Type': 'application/json' };
  const today = new Date().toISOString().slice(0, 10);
  const dateParam = (event.queryStringParameters || {}).date;
  const reportDate = dateParam && /^\d{4}-\d{2}-\d{2}$/.test(dateParam) ? dateParam : today;

  try {
    const report = await redisGet('daily:report:' + reportDate);
    if (!report) {
      return { statusCode: 200, headers, body: JSON.stringify({ status: 'loading' }) };
    }

    // Pull top picks — top 3 become picks, rest are noted. Ranking rule: the
    // build's stored pickRank (stamped by the NB reorder step as the final
    // pick order — rank 1 is always the highest-confidence NAP) wins when
    // present; the confidence-score sort is the fallback for reports built
    // before pickRank existed and for days the reorder call failed. Sort runs
    // in place first (report.analyses passthrough keeps its order as before),
    // then filter drops unusable entries — no selection, no horse name, or an
    // explicit Pass — so a Pass race can never occupy a NAP/NB/intel slot with
    // a blank card. picks and intelPicks both slice this same filtered
    // ranking, keeping their indexes aligned (no NB/intel duplicates).
    const analyses = (report.analyses || [])
      .sort((a, b) => {
        if (a.pickRank != null && b.pickRank != null) return a.pickRank - b.pickRank;
        if (a.pickRank != null) return -1;
        if (b.pickRank != null) return 1;
        return (b.confidenceScore || 0) - (a.confidenceScore || 0);
      })
      .filter(a => a && a.strongestSelection && a.strongestSelection.horseName
        && a.strongestSelection.confidenceLevel !== 'Pass');

    const picks = analyses.slice(0, 3).map(a => ({
      race: a.race,
      horseName: a.strongestSelection && a.strongestSelection.horseName,
      odds: a.strongestSelection && a.strongestSelection.odds,
      jockey: a.strongestSelection && a.strongestSelection.jockey,
      trainer: a.strongestSelection && a.strongestSelection.trainer,
      formFigures: a.strongestSelection && a.strongestSelection.formFigures,
      confidenceLevel: a.strongestSelection && a.strongestSelection.confidenceLevel,
      confidenceScore: a.confidenceScore,
      pullQuote: a.strongestSelection && a.strongestSelection.pullQuote,
      factors: a.strongestSelection && a.strongestSelection.factors,
      raceIntelligence: a.raceIntelligence,
      horsesToWatch: a.horsesToWatch || []
    }));

    // Daily Intelligence horses — ranks 3-5 (sorted indexes 2, 3, 4) of the same
    // confidence-sorted array picks is built from. Index 2 is intentionally both
    // the 3rd pick and the first intel horse. Entries with no usable selection
    // are dropped rather than sent as blank cards; fewer than 5 analyses simply
    // yields a shorter (possibly empty) array.
    const intelPicks = analyses.slice(2, 5)
      .filter(a => a && a.strongestSelection && a.strongestSelection.horseName)
      .map(a => ({
        horseName: a.strongestSelection.horseName,
        odds: a.strongestSelection.odds || 'SP',
        jockey: a.strongestSelection.jockey,
        trainer: a.strongestSelection.trainer,
        formFigures: a.strongestSelection.formFigures,
        confidenceScore: a.confidenceScore,
        pullQuote: a.strongestSelection.pullQuote,
        factors: a.strongestSelection.factors,
        raceIntelligence: a.raceIntelligence,
        race: a.race
      }));

    // Value picks — ranks 6-10 (sorted indexes 5-9) of the same confidence-
    // sorted array. Feeds the tracker's Intel 6-10 rows; same filter rule as
    // intelPicks so a missing selection can never produce a blank entry.
    const valuePicks = analyses.slice(5, 10)
      .filter(a => a && a.strongestSelection && a.strongestSelection.horseName)
      .map(a => ({
        horseName: a.strongestSelection.horseName,
        odds: a.strongestSelection.odds || 'SP',
        jockey: a.strongestSelection.jockey,
        trainer: a.strongestSelection.trainer,
        formFigures: a.strongestSelection.formFigures,
        confidenceScore: a.confidenceScore,
        pullQuote: a.strongestSelection.pullQuote,
        race: a.race
      }));

    return {
      statusCode: 200,
      headers,
      body: JSON.stringify({
        status: 'done',
        date: reportDate,
        picks,
        intelPicks,
        valuePicks,
        bigRace: report.bigRace || null,
        candgCard: report.candgCard || null,
        candgHorsesCount: (report.candgHorses || []).length,
        hotYard: report.hotYard || null,
        hotYardCard: report.hotYardCard || null,
        intelligence: report.intelligence || [],
        analyses: report.analyses || [],
        cost: report.costUSD,
        costBreakdown: report.costBreakdown || null,
        callLog: report.callLog || [],
        racesAnalysed: report.racesAnalysed,
        webSearchCount: report.webSearchCount || 0
      })
    };
  } catch(e) {
    return { statusCode: 500, headers, body: JSON.stringify({ status: 'error', error: e.message }) };
  }
};
