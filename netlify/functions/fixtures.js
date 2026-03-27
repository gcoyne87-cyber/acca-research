exports.handler = async function(event) {
  const API_KEY = '4876fc6e82fa43210ee8dc53214f000d';
  const { league, date, season } = event.queryStringParameters || {};
  const url = `https://v3.football.api-sports.io/fixtures?league=${league}&date=${date}&season=${season}`;
  try {
    const response = await fetch(url, {
      headers: { 'x-apisports-key': API_KEY }
    });
    const data = await response.json();
    return {
      statusCode: 200,
      headers: { 'Access-Control-Allow-Origin': '*', 'Content-Type': 'application/json' },
      body: JSON.stringify(data)
    };
  } catch (err) {
    return { statusCode: 500, body: JSON.stringify({ error: err.message }) };
  }
};
