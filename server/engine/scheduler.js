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

async function cleanOldMatches() {
  try {
    const Match = require('../models/Match');
    const cutoff = new Date(Date.now() - 3*60*60*1000); // 3 hours ago
    // Delete old static matches
    const r1 = await Match.deleteMany({ isStatic: true });
    // Delete old finished matches older than 3 days
    const r2 = await Match.deleteMany({
      status: 'finished',
      settledAt: { $lt: new Date(Date.now() - 3*24*60*60*1000) }
    });
    // Delete matches with past commence time that are still upcoming (stale)
    const r3 = await Match.deleteMany({
      status: 'upcoming',
      commenceTime: { $lt: new Date(Date.now() - 5*60*60*1000) }
    });
    console.log(`🧹 Cleaned: ${r1.deletedCount} static, ${r2.deletedCount} old finished, ${r3.deletedCount} stale upcoming`);
  } catch(e) {
    console.error('Cleanup error:', e.message);
  }
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

  // Cleanup old/static matches on startup
  setTimeout(() => run('cleanup', cleanOldMatches), 2000);

  // Initial sync on startup (after 5s)
  setTimeout(async () => {
    console.log('🚀 Initial sync starting...');
    await run('apif_fixtures_init', syncFixtures);
    if (process.env.ODDS_API_KEY) {
      await run('odds_init', syncOdds);
    }
  }, 5000);

  // Daily cleanup at 3am
  cron.schedule('0 3 * * *', () => run('daily_cleanup', cleanOldMatches));
}

module.exports = { start };
