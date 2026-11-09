// Removes match rows that were flagged "live" but never closed by the feed (postponed / abandoned / dropped games).
// They inflate the admin "stuck" number and waste database space. Only rows that kicked off more than STALE_HOURS ago are touched,
// and NEVER a game that an open bet still depends on (settlement needs those rows).
const STALE_HOURS = Math.max(6, Number(process.env.STALE_LIVE_HOURS) || 12);
let timer = null, running = false;

async function run() {
  if (running) return { skipped: true };
  running = true;
  try {
    const Match = require('../models/Match');
    const Bet = require('../models/Bet');
    const fin = require('./finalResultService');
    const cutoff = new Date(Date.now() - STALE_HOURS * 3600000);
    const stale = await Match.find({ status: 'live', commenceTime: { $lt: cutoff } }, { matchId: 1 }).limit(3000).lean();
    if (!stale.length) return { removed: 0 };
    const open = await Bet.distinct('selections.matchId', { $or: [{ status: 'pending' }, { status: 'lost', selections: { $elemMatch: { result: 'pending' } } }] });
    const keep = new Set((open || []).map(id => fin.fixtureKey(id)));
    const ids = stale.filter(m => !keep.has(fin.fixtureKey(m.matchId))).map(m => m.matchId);
    let removed = 0;
    for (let i = 0; i < ids.length; i += 500) {
      const r = await Match.deleteMany({ matchId: { $in: ids.slice(i, i + 500) }, status: 'live', commenceTime: { $lt: cutoff } });
      removed += r.deletedCount || 0;
    }
    if (removed) console.log(`[stale-live] removed ${removed} games that were never closed by the feed (kept ${stale.length - ids.length} that open bets need)`);
    return { removed, kept: stale.length - ids.length };
  } catch (e) { console.error('[stale-live] failed:', e.message); return { error: e.message }; }
  finally { running = false; }
}

function start() {
  if (timer) return;
  setTimeout(run, 60 * 1000).unref();
  timer = setInterval(run, 30 * 60 * 1000); if (timer.unref) timer.unref();
}
module.exports = { start, run };
