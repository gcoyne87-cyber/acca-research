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

    // Pull top picks by confidence score — top 3 become picks, rest are noted
    const analyses = (report.analyses || []).sort((a, b) => (b.confidenceScore || 0) - (a.confidenceScore || 0));

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
      aiRaceVerdict: a.aiRaceVerdict,
      raceIntelligence: a.raceIntelligence,
      horsesToWatch: a.horsesToWatch || []
    }));

    return {
      statusCode: 200,
      headers,
      body: JSON.stringify({
        status: 'done',
        date: reportDate,
        picks,
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
