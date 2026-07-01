// NO MORE FAKE GAMES — this file only provides fallback if ALL APIs fail
// Real games come from API-Football or The Odds API

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
