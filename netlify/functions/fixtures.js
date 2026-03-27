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

function fetchLeague(leagueId, date) {
  return new Promise((resolve) => {
    // eventsnextleague returns next 15 events for a league - free tier supported
    const url = 'https://www.thesportsdb.com/api/v1/json/123/eventsnextleague.php?id=' + leagueId;
    const req = https.get(url, (res) => {
      let body = '';
      res.on('data', chunk => body += chunk);
      res.on('end', () => {
        try {
          const data = JSON.parse(body);
          const events = (data.events || [])
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
              status: e.strStatus || 'NS',
              venue: e.strVenue || ''
            }));
          resolve(events);
        } catch (e) {
          resolve([]);
        }
      });
    });
    req.on('error', () => resolve([]));
  });
}

function fetchLeaguePast(leagueId, date) {
  return new Promise((resolve) => {
    // eventspastleague returns last 15 events - used as fallback for past dates
    const url = 'https://www.thesportsdb.com/api/v1/json/123/eventspastleague.php?id=' + leagueId;
    const req = https.get(url, (res) => {
      let body = '';
      res.on('data', chunk => body += chunk);
      res.on('end', () => {
        try {
          const data = JSON.parse(body);
          const events = (data.events || [])
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
              status: e.strStatus || 'FT',
              venue: e.strVenue || ''
            }));
          resolve(events);
        } catch (e) {
          resolve([]);
        }
      });
    });
    req.on('error', () => resolve([]));
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

  // Fetch all leagues in parallel
  const results = await Promise.all(
    leagueIds.map(id => isPast ? fetchLeaguePast(id, date) : fetchLeague(id, date))
  );

  const allEvents = results.flat();

  return {
    statusCode: 200,
    headers: { 'Access-Control-Allow-Origin': '*', 'Content-Type': 'application/json' },
    body: JSON.stringify({ events: allEvents })
  };
};
