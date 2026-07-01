const cron = require('node-cron');

let started = false;

function start() {
  if (started) return;
  started = true;

  const { syncFixtures, updateLive } = require('./apifootball');
  const { runSettlement }            = require('./settlementEngine');

  // Sync fixtures every 6 hours
  cron.schedule('0 */6 * * *', () => { syncFixtures().catch(console.error); });

  // Update live scores every 2 minutes
  cron.schedule('*/2 * * * *', () => { updateLive().catch(console.error); });

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

  console.log('✅ Scheduler started (fixtures 6h, live 2m, settlement 15m)');

  // Run sync on startup after 10s
  setTimeout(() => syncFixtures().catch(console.error), 10000);
}

module.exports = { start };
