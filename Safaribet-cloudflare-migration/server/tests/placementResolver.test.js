const Module = require('module');
const path = require('path');
const originalLoad = Module._load;

const resolverPath = path.resolve(__dirname, '../services/placementResolver.js');
const now = Date.now();

let liveLookupCalls = 0;
let marketLookupCalls = 0;

const markets = [{
  id: 'market-1',
  key: 'match-winner',
  name: 'Match Winner',
  selections: [
    { id: 'home', key: 'home', name: 'Home', odds: 1.80 }
  ]
}];

const providerStub = {
  getMatchMarkets: async () => {
    marketLookupCalls++;
    return { markets };
  },
  getLiveMatchById: () => {
    liveLookupCalls++;
    return new Promise(() => {});
  },
  getMatchById: async () => null,
  marketsCacheAge: () => Infinity
};

const sportsStub = {
  lookupIndexedMatch: () => ({
    matchId: 'sofabets_live_football_100',
    homeTeam: 'Fresh Home',
    awayTeam: 'Fresh Away',
    league: 'Fresh League',
    sport: 'football',
    status: 'live',
    commenceTime: new Date(now - 20 * 60000),
    fetchedAt: new Date(now),
    score: { home: 1, away: 0, minute: 20 }
  })
};

Module._load = function (request, parent, isMain) {
  if (parent && parent.filename === resolverPath) {
    if (request === '../providers/sofaBetsProvider') return providerStub;
    if (request === '../routes/sports') return sportsStub;
    if (request === './finalResultService') {
      return {
        parseSofaMatchId: id => {
          if (id === 'sofabets_live_football_100') {
            return { isLive: true, sport: 'football', providerId: '100' };
          }
          return null;
        }
      };
    }
    if (request === './marketOffer') return { canOffer: () => true };
  }
  return originalLoad.apply(this, arguments);
};

const resolver = require('../services/placementResolver');

let passed = 0;
let failed = 0;

function check(name, condition) {
  if (condition) passed++;
  else failed++;
  console.log((condition ? 'PASS ' : 'FAIL ') + name);
}

(async () => {
  try {
    const staleMongoRow = {
      matchId: 'sofabets_live_football_100',
      homeTeam: 'Old Home',
      awayTeam: 'Old Away',
      league: 'Old League',
      sport: 'football',
      status: 'live',
      markets: [{
        id: 'old-market',
        name: 'Old Market',
        selections: []
      }, {
        id: 'another-old-market',
        name: 'Another Old Market',
        selections: []
      }],
      marketsRefreshedAt: new Date(now - 10 * 60000)
    };

    const selection = {
      matchId: 'sofabets_live_football_100',
      providerMarketId: 'market-1',
      providerSelectionId: 'home',
      marketLabel: 'Match Winner',
      pickLabel: 'Home',
      odds: 1.80
    };

    const result = await resolver.resolveProviderSelection(
      selection,
      staleMongoRow,
      { budgetMs: 300 }
    );

    check('placement resolves successfully', result.ok === true);
    check('fresh indexed fixture is used instead of stale Mongo teams',
      result.ok &&
      result.fixture.homeTeam === 'Fresh Home' &&
      result.fixture.awayTeam === 'Fresh Away'
    );
    check('fresh indexed fixture is marked live',
      result.ok && result.fixture.status === 'live'
    );
    check('exact provider market and selection are matched',
      result.ok &&
      result.mk.id === 'market-1' &&
      result.out.id === 'home'
    );
    check('server-side provider odds are returned',
      result.ok && Number(result.out.odds) === 1.80
    );
    check('live provider lookup is skipped when fresh index exists',
      liveLookupCalls === 0
    );
    check('market catalogue is checked once',
      marketLookupCalls === 1
    );

    console.log(`\n${passed} passed, ${failed} failed`);
    process.exitCode = failed ? 1 : 0;
  } catch (error) {
    console.error(error);
    process.exitCode = 1;
  } finally {
    Module._load = originalLoad;
  }
})();
