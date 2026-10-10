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

  // Settlement: fast DB-only pass every minute (cheap — matches are already
  // polled every 10s by updateLive above, so this alone delivers near-instant
  // win/loss settlement) plus a slower full pass with the external API
  // fallback every 5 minutes as a safety net for anything the DB path missed.
  cron.schedule('* * * * *', () => { runSettlement(false).catch(console.error); });
  cron.schedule('*/5 * * * *', () => { runSettlement(true).catch(console.error); });

  // Jackpot settlement — same cadence, checks if all fixtures in any open round finished
  cron.schedule('*/5 * * * *', () => { settleJackpots().catch(console.error); });

  // Loyalty cashback — weekly, Sunday midnight
  const { runWeeklyCashback } = require('./loyaltyCashback');
  cron.schedule('0 0 * * 0', () => { runWeeklyCashback().catch(console.error); });

  // Keep-alive. A free Render server goes to sleep after ~15 minutes without visitors, and a sleeping server
  // cannot watch games finish: a game that kicks off and ends while it sleeps is never seen live, so its bets
  // stay "awaiting result" forever (SofaBets has no results list to read afterwards).
  //  - APP_URL set (your explicit choice): ping every 10 minutes, always, exactly as before.
  //  - APP_URL not set: use the URL Render itself provides, but ONLY while a SofaBets bet is waiting on a game that
  //    is about to start, is playing, or is not confirmed finished yet (started in the last 12 hours). The rest of the
  //    time the server may sleep, so free instance hours are not burnt for nothing.
  const selfUrl = process.env.APP_URL || process.env.RENDER_EXTERNAL_URL;
  if (selfUrl) {
    const axios = require('axios');
    const alwaysOn = !!process.env.APP_URL || String(process.env.KEEP_AWAKE || '').toLowerCase() === 'always';
    cron.schedule(alwaysOn ? '*/10 * * * *' : '*/4 * * * *', async () => {
      try {
        if (!alwaysOn) {
          const Bet = require('../models/Bet');
          const now = Date.now();
          const needed = await Bet.exists({ status: 'pending', selections: { $elemMatch: {
            result: 'pending', matchId: /^sofabets_/,
            commenceTime: { $lte: new Date(now + 45 * 60000), $gte: new Date(now - 12 * 3600000) }
          } } });
          if (!needed) return;
        }
        await axios.get(`${selfUrl}/api/health`, { timeout: alwaysOn ? 5000 : 8000 });
      } catch {}
    });
    console.log(`✅ Keep-awake: ${alwaysOn ? 'always (every 10 min)' : 'only while bets wait on started/imminent games'} via ${selfUrl}`);
  }

  console.log(`✅ Scheduler started (fixtures 5m, live every ${liveMs/1000}s, settlement 15m)`);

  // Startup: clean any legacy non-Juan matches, then sync
  setTimeout(() => cleanFakeMatches().catch(console.error), 3000);
  setTimeout(() => syncFixtures().catch(console.error), 6000);
  setTimeout(() => updateLive().catch(console.error), 10000);
  setTimeout(() => runSettlement().catch(console.error), 15000);
}

module.exports = { start };
