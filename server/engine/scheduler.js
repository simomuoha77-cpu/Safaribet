/**
 * SCHEDULER - RENDER FREE TIER COMPATIBLE
 * ─────────────────────────────────────────
 * Problem: Render free tier sleeps after 15min inactivity
 * Solution: Self-ping every 10 minutes to stay awake
 * + Run settlement every 5 minutes
 */

const cron = require('node-cron');
const axios = require('axios');

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

  const { runSettlement }  = require('./settlementEngine');
  const { syncFixtures, updateLive } = require('./apifootball');

  // ── SELF PING — keeps Render awake ──
  const APP_URL = process.env.APP_URL || process.env.RENDER_EXTERNAL_URL;
  if (APP_URL) {
    cron.schedule('*/10 * * * *', async () => {
      try {
        await axios.get(`${APP_URL}/api/health`, { timeout: 8000 });
        console.log('💓 Self-ping OK');
      } catch(e) {
        console.log('💓 Self-ping failed:', e.message);
      }
    });
    console.log(`💓 Self-ping enabled → ${APP_URL}`);
  } else {
    console.log('⚠️  APP_URL not set — add RENDER_EXTERNAL_URL to env for auto keep-alive');
  }

  // ── SETTLEMENT every 5 min ──
  cron.schedule('*/5 * * * *', () => run('settlement', runSettlement));

  // ── LIVE SCORES every 60 sec ──
  cron.schedule('* * * * *', () => run('live', updateLive));

  // ── SYNC FIXTURES every 30 min ──
  cron.schedule('*/30 * * * *', () => run('fixtures', syncFixtures));

  // ── CLEANUP stale matches daily at 3am ──
  cron.schedule('0 3 * * *', async () => {
    try {
      const Match = require('../models/Match');
      const r1 = await Match.deleteMany({ isStatic: true });
      const r2 = await Match.deleteMany({
        status: 'finished', settled: true,
        settledAt: { $lt: new Date(Date.now() - 7*24*60*60*1000) }
      });
      const r3 = await Match.deleteMany({
        status: 'upcoming',
        commenceTime: { $lt: new Date(Date.now() - 6*60*60*1000) }
      });
      console.log(`🧹 Cleaned ${r1.deletedCount} static, ${r2.deletedCount} old, ${r3.deletedCount} stale`);
    } catch(e) { console.error('Cleanup error:', e.message); }
  });

  // ── STARTUP — run immediately after 5s ──
  setTimeout(async () => {
    console.log('🚀 Startup tasks...');
    await run('startup_settlement', runSettlement);
    await run('startup_fixtures',   syncFixtures);
  }, 5000);
}

module.exports = { start };
