/**
 * SCHEDULER
 * ─────────
 * Cron jobs that run everything automatically:
 *
 * Every 5 min  → sync odds (pre-match)
 * Every 1 min  → update live scores
 * Every 5 min  → run settlement engine
 * Every 30 min → clean up old data
 */

const cron             = require('node-cron');
const { syncOdds }     = require('./oddsEngine');
const { runSettlement, updateLiveScores } = require('./settlementEngine');

let isSettling = false;
let isSyncing  = false;

function start() {
  console.log('⏰ Scheduler started');

  // ── Sync odds every 5 minutes ──
  cron.schedule('*/5 * * * *', async () => {
    if (isSyncing) return;
    isSyncing = true;
    try { await syncOdds(); }
    catch (e) { console.error('Odds sync error:', e.message); }
    finally { isSyncing = false; }
  });

  // ── Update live scores every 60 seconds ──
  cron.schedule('* * * * *', async () => {
    try { await updateLiveScores(); }
    catch (e) { console.error('Live scores error:', e.message); }
  });

  // ── Run settlement every 5 minutes ──
  cron.schedule('*/5 * * * *', async () => {
    if (isSettling) return;
    isSettling = true;
    try { await runSettlement(); }
    catch (e) { console.error('Settlement error:', e.message); }
    finally { isSettling = false; }
  });

  // ── Initial sync on startup ──
  setTimeout(async () => {
    console.log('🚀 Running initial odds sync...');
    try { await syncOdds(); }
    catch (e) { console.error('Initial sync error:', e.message); }
  }, 3000);
}

module.exports = { start };
