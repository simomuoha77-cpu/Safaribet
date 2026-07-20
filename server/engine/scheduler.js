const cron = require('node-cron');
let started = false;

function start() {
  if (started) return;
  started = true;

  const { syncFixtures, updateLive, cleanFakeMatches } = require('./apifootball');
  const { runSettlement } = require('./settlementEngine');
  const { settleJackpots } = require('./jackpotSettlement');
  const { deduplicateMatches } = require('../routes/odds');

  // Sync fixtures every 5 minutes
  cron.schedule('*/5 * * * *', () => { syncFixtures().catch(console.error); });

  // Live scores — interval via env, default 20s
  const liveMs = parseInt(process.env.LIVE_POLL_MS) || 10000; // 10s — catch score changes before match disappears
  setInterval(() => { updateLive().catch(console.error); }, liveMs);

  // Settlement every 5 minutes — fast win/loss notification for users
  cron.schedule('*/5 * * * *', () => { runSettlement().catch(console.error); });

  // Jackpot settlement — same cadence, checks if all fixtures in any open round finished
  cron.schedule('*/5 * * * *', () => { settleJackpots().catch(console.error); });

  // Loyalty cashback — weekly, Sunday midnight
  const { runWeeklyCashback } = require('./loyaltyCashback');
  cron.schedule('0 0 * * 0', () => { runWeeklyCashback().catch(console.error); });

  // Self-ping (Render free tier keep-alive)
  if (process.env.APP_URL) {
    const axios = require('axios');
    cron.schedule('*/10 * * * *', async () => {
      try { await axios.get(`${process.env.APP_URL}/api/health`, { timeout: 5000 }); } catch {}
    });
  }

  console.log(`✅ Scheduler started (fixtures 5m, live every ${liveMs/1000}s, settlement 15m)`);

  // Startup: clean any legacy non-Juan matches, then sync
  setTimeout(() => cleanFakeMatches().catch(console.error), 3000);
  setTimeout(() => syncFixtures().catch(console.error), 6000);
  setTimeout(() => updateLive().catch(console.error), 10000);
  setTimeout(() => runSettlement().catch(console.error), 15000);
}

module.exports = { start };
