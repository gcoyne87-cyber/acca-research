const https = require('https');

// TheSportsDB league IDs mapped to their names for server-side filtering
const LEAGUE_IDS = {
  '4328': 'English Premier League',
  '4329': 'English League Championship',
  '4396': 'English League 1',
  '4397': 'English League 2',
  '4330': 'Scottish Premier League',
  '4395': 'Scottish Championship',
  '4669': 'Scottish League 1',
  '4670': 'Scottish League 2'
};

exports.handler = async function(event) {
  const { date } = event.queryStringParameters || {};

  if (!date) {
    return {
      statusCode: 400,
      headers: { 'Access-Control-Allow-Origin': '*', 'Content-Type': 'application/json' },
      body: JSON.stringify({ error: 'date parameter required' })
    };
  }

  const url = 'https://www.thesportsdb.com/api/v1/json/123/eventsday.php?d=' + date + '&s=Soccer';

  return new Promise((resolve) => {
    const req = https.get(url, (res) => {
      let body = '';
      res.on('data', chunk => body += chunk);
      res.on('end', () => {
        try {
          const data = JSON.parse(body);
          const events = data.events || [];

          // Filter to only our tracked leagues, map to a clean shape
          const filtered = events
            .filter(e => LEAGUE_IDS[e.idLeague])
            .map(e => ({
              id: e.idEvent,
              leagueId: e.idLeague,
              leagueName: e.strLeague,
              home: e.strHomeTeam,
              away: e.strAwayTeam,
              date: e.dateEvent,
              time: e.strTime,         // UTC time e.g. "15:00:00"
              homeScore: e.intHomeScore,
              awayScore: e.intAwayScore,
              status: e.strStatus,     // "NS", "FT", "1H", "2H", "HT" etc.
              venue: e.strVenue || ''
            }));

          resolve({
            statusCode: 200,
            headers: { 'Access-Control-Allow-Origin': '*', 'Content-Type': 'application/json' },
            body: JSON.stringify({ events: filtered })
          });
        } catch (parseErr) {
          resolve({
            statusCode: 500,
            headers: { 'Access-Control-Allow-Origin': '*', 'Content-Type': 'application/json' },
            body: JSON.stringify({ error: 'Failed to parse response', raw: body.substring(0, 200) })
          });
        }
      });
    });

    req.on('error', (e) => {
      resolve({
        statusCode: 500,
        headers: { 'Access-Control-Allow-Origin': '*', 'Content-Type': 'application/json' },
        body: JSON.stringify({ error: e.message })
      });
    });
  });
};
