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
          console.log('League', leagueId, '- total events returned:', allEvents.length, '- dates:', [...new Set(allEvents.map(e => e.dateEvent))].join(', '));
          const filtered = allEvents.filter(e => e.dateEvent === date);
          console.log('League', leagueId, '- matching', date, ':', filtered.length);
          const mapped = filtered.map(e => ({
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
          resolve(mapped);
        } catch (e) {
          console.log('League', leagueId, '- parse error:', e.message);
          resolve([]);
        }
      });
    });
    req.on('error', (e) => {
      console.log('League', leagueId, '- request error:', e.message);
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
  console.log('Fetching date:', date, '- isPast:', isPast, '- today:', today);

  const leagueIds = Object.keys(LEAGUES);

  const results = await Promise.all(
    leagueIds.map(id => fetchLeague(id, date, isPast))
  );

  const allEvents = results.flat();
  console.log('Total events for', date, ':', allEvents.length);

  return {
    statusCode: 200,
    headers: { 'Access-Control-Allow-Origin': '*', 'Content-Type': 'application/json' },
    body: JSON.stringify({ events: allEvents, debug: { date, isPast, totalFound: allEvents.length } })
  };
};
