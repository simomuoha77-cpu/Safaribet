const cron = require('node-cron');
const { syncOdds }     = require('./oddsEngine');
const { runSettlement, updateLiveScores } = require('./settlementEngine');
const { syncFixtures, updateLive, settleFromResults } = require('./apifootball');

let busy = {};

async function run(name, fn) {
  if (busy[name]) return;
  busy[name] = true;
  try { await fn(); }
  catch(e) { console.error(`[${name}] error:`, e.message); }
  finally { busy[name] = false; }
}

function start() {
  console.log('⏰ Scheduler started');

  // Sync fixtures from API-Football every 30 min
  cron.schedule('*/30 * * * *', () => run('apif_fixtures', syncFixtures));

  // Update live scores every 60 seconds
  cron.schedule('* * * * *', () => run('apif_live', updateLive));

  // Sync odds from The Odds API every 5 min (if key available)
  if (process.env.ODDS_API_KEY) {
    cron.schedule('*/5 * * * *', () => run('odds_sync', syncOdds));
  }

  // Run settlement every 5 min (both sources)
  cron.schedule('*/5 * * * *', async () => {
    await run('settlement', runSettlement);
    await run('apif_settle', settleFromResults);
  });

  // Initial sync on startup (after 5s)
  setTimeout(async () => {
    console.log('🚀 Initial sync starting...');
    await run('apif_fixtures_init', syncFixtures);
    if (process.env.ODDS_API_KEY) {
      await run('odds_init', syncOdds);
    }
  }, 5000);
}

module.exports = { start };
