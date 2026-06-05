/**
 * settlement-cron.js
 * 
 * Add this to your server.js to auto-settle bets every 30 minutes.
 * 
 * In server.js, add:
 *   require('./engine/settlement-cron');
 */
const { syncFixtures, updateLive, settleFromResults } = require('./apifootball');

// ── Auto-settle bets every 30 minutes ──
async function runSettlement() {
  console.log('\n⏰ [cron] Running settlement cycle...');
  try {
    await settleFromResults();
  } catch (e) {
    console.error('[cron] Settlement error:', e.message);
  }
}

// ── Sync fixtures every 3 hours ──
async function runSync() {
  console.log('\n⏰ [cron] Syncing fixtures...');
  try {
    await syncFixtures();
  } catch (e) {
    console.error('[cron] Sync error:', e.message);
  }
}

// ── Update live scores every 2 minutes ──
async function runLive() {
  try {
    await updateLive();
  } catch (e) {
    console.error('[cron] Live error:', e.message);
  }
}

// Run immediately on startup
runSync();
runSettlement();

// Then on schedule
setInterval(runSettlement, 30 * 60 * 1000);   // every 30 min
setInterval(runSync,       3 * 60 * 60 * 1000); // every 3 hours
setInterval(runLive,       2 * 60 * 1000);       // every 2 min

console.log('✅ [cron] Settlement, sync & live score jobs scheduled');

module.exports = { runSettlement, runSync, runLive };
