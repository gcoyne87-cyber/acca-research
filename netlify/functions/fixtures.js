const https = require('https');

const API_KEY = '625746';

const TRACKED_LEAGUES = {
  '4328': true, // Premier League
  '4329': true, // Championship
  '4396': true, // League One
  '4397': true, // League Two
  '4330': true, // Scottish Premiership
  '4395': true, // Scottish Championship
  '4669': true, // Scottish League One
  '4670': true  // Scottish League Two
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

  const url = 'https://www.thesportsdb.com/api/v1/json/' + API_KEY + '/eventsday.php?d=' + date + '&s=Soccer';

  return new Promise((resolve) => {
    const req = https.get(url, (res) => {
      let body = '';
      res.on('data', chunk => body += chunk);
      res.on('end', () => {
        try {
          const data = JSON.parse(body);
          const events = (data.events || [])
            .filter(e => TRACKED_LEAGUES[e.idLeague])
            .map(e => ({
              id: e.idEvent,
              leagueId: e.idLeague,
              leagueName: e.strLeague,
              home: e.strHomeTeam,
              away: e.strAwayTeam,
              date: e.dateEvent,
              time: e.strTime || '',
              homeScore: e.intHomeScore,
              awayScore: e.intAwayScore,
              status: e.strStatus || 'NS',
              venue: e.strVenue || ''
            }));

          resolve({
            statusCode: 200,
            headers: { 'Access-Control-Allow-Origin': '*', 'Content-Type': 'application/json' },
            body: JSON.stringify({ events })
          });
        } catch (e) {
          resolve({
            statusCode: 500,
            headers: { 'Access-Control-Allow-Origin': '*', 'Content-Type': 'application/json' },
            body: JSON.stringify({ error: 'Parse error: ' + e.message })
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
