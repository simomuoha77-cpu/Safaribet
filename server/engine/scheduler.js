const cron = require('node-cron');

let started = false;

function start() {
  if (started) return;
  started = true;

  const { syncFixtures, updateLive } = require('./footballSync');
  const { runSettlement }            = require('./settlementEngine');

  // Sync fixtures/odds every 5 minutes — keeps the DB mirror aligned
  // with the API without hammering it for data that rarely changes.
  cron.schedule('*/5 * * * *', () => { syncFixtures().catch(console.error); });

  // Poll live scores frequently so the site reflects real-time state.
  // Interval is configurable via env (ms) — default 20s.
  const liveIntervalMs = parseInt(process.env.LIVE_POLL_MS) || 20000;
  setInterval(() => { updateLive().catch(console.error); }, liveIntervalMs);

  // Run settlement every 15 minutes
  cron.schedule('*/15 * * * *', () => { runSettlement().catch(console.error); });

  // Self-ping every 10 min to stay awake on Render free tier
  if (process.env.APP_URL) {
    const axios = require('axios');
    cron.schedule('*/10 * * * *', async () => {
      try {
        await axios.get(`${process.env.APP_URL}/api/health`, { timeout: 5000 });
      } catch {}
    });
  }

  console.log(`✅ Scheduler started (fixtures 5m, live ${liveIntervalMs / 1000}s, settlement 15m)`);

  // Run an initial sync + live poll shortly after startup
  setTimeout(() => syncFixtures().catch(console.error), 5000);
  setTimeout(() => updateLive().catch(console.error), 8000);
}

module.exports = { start };
