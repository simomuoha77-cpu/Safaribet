// NO MORE FAKE GAMES — this file only provides fallback if ALL APIs fail
// Real games come from API-Football or The Odds API

function genOdds(home, away) {
  const h = s => (s||'').split('').reduce((a,c) => a + c.charCodeAt(0), 0);
  const seed = (h(home) * 7 + h(away) * 3) % 100;
  return {
    home: +(1.40 + (seed % 30) / 20).toFixed(2),
    draw: +(2.80 + (seed % 20) / 15).toFixed(2),
    away: +(1.70 + (seed % 35) / 18).toFixed(2)
  };
}

// Empty — no fake games
function getFixtures(sport) { return []; }
function getAllUpcoming()    { return []; }
function smartSort(matches) {
  const now = new Date();
  return matches
    .filter(m => new Date(m.commenceTime) > new Date(now - 3*3600000))
    .sort((a, b) => {
      if (a.status === 'live' && b.status !== 'live') return -1;
      if (b.status === 'live' && a.status !== 'live') return 1;
      return new Date(a.commenceTime) - new Date(b.commenceTime);
    });
}

module.exports = { getFixtures, getAllUpcoming, smartSort };
