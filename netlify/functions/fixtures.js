const https = require('https');

const LEAGUES = {
  '4328': 'Premier League',
  '4329': 'Championship',
  '4396': 'League One',
  '4397': 'League Two',
  '4330': 'Scottish Premiership',
  '4395': 'Scottish Championship',
  '4669': 'Scottish League One',
  '4670': 'Scottish League Two'
};

function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function fetchLeague(leagueId, date, usePast) {
  return new Promise((resolve) => {
    const endpoint = usePast ? 'eventspastleague' : 'eventsnextleague';
    const url = 'https://www.thesportsdb.com/api/v1/json/123/' + endpoint + '.php?id=' + leagueId;

    const req = https.get(url, (res) => {
      let body = '';
      res.on('data', chunk => body += chunk);
      res.on('end', () => {
        try {
          const data = JSON.parse(body);
          const allEvents = data.events || [];
          const filtered = allEvents
            .filter(e => e.dateEvent === date)
            .map(e => ({
              id: e.idEvent,
              leagueId: leagueId,
              leagueName: e.strLeague,
              home: e.strHomeTeam,
              away: e.strAwayTeam,
              date: e.dateEvent,
              time: e.strTime || '',
              homeScore: e.intHomeScore,
              awayScore: e.intAwayScore,
              status: e.strStatus || (usePast ? 'FT' : 'NS'),
              venue: e.strVenue || ''
            }));
          console.log('League', leagueId, '| returned:', allEvents.length, '| matched', date + ':', filtered.length);
          resolve(filtered);
        } catch (e) {
          console.log('League', leagueId, '| parse error:', e.message);
          resolve([]);
        }
      });
    });
    req.on('error', (e) => {
      console.log('League', leagueId, '| request error:', e.message);
      resolve([]);
    });
  });
}

exports.handler = async function(event) {
  const { date } = event.queryStringParameters || {};

  if (!date) {
    return {
      statusCode: 400,
      headers: { 'Access-Control-Allow-Origin': '*', 'Content-Type': 'application/json' },
      body: JSON.stringify({ error: 'date parameter required' })
    };
  }

  const today = new Date().toISOString().split('T')[0];
  const isPast = date < today;
  const leagueIds = Object.keys(LEAGUES);
  const allEvents = [];

  // Sequential with 250ms gap between each — stays well within 30 req/min free limit
  for (let i = 0; i < leagueIds.length; i++) {
    if (i > 0) await delay(250);
    const events = await fetchLeague(leagueIds[i], date, isPast);
    allEvents.push(...events);
  }

  console.log('Total for', date, ':', allEvents.length);

  return {
    statusCode: 200,
    headers: { 'Access-Control-Allow-Origin': '*', 'Content-Type': 'application/json' },
    body: JSON.stringify({ events: allEvents })
  };
};
