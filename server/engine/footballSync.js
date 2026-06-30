// Mirrors the Football API (footballApi.js) into the Match collection.
// The DB here is NEVER an independent source of data — it is fully
// overwritten on every sync from the API response. If the API has no
// live matches, we clear "live" status in the DB to match — we never
// leave stale matches displayed as live.
const Match = require('../models/Match');
const footballApi = require('./footballApi');

let broadcastFn = null;
function setBroadcaster(fn) { broadcastFn = fn; }
function broadcast(payload) { if (broadcastFn) { try { broadcastFn(payload); } catch (_) {} } }

// Full fixtures/odds mirror — replaces the whole collection with
// exactly what the API currently reports, nothing more, nothing less.
async function syncFixtures() {
  console.log('\n📡 [football] Syncing fixtures from Juan Football API...');
  try {
    const matches = await footballApi.fetchOdds();
    if (!matches.length) {
      console.log('  [football] API returned 0 matches — leaving DB untouched (avoid wiping on a transient empty response)');
      return { synced: 0 };
    }
    const seen = new Set();
    for (const m of matches) {
      seen.add(m.matchId);
      await Match.findOneAndUpdate(
        { matchId: m.matchId },
        { $set: { ...m } },
        { upsert: true }
      );
    }
    // Remove matches that the API no longer reports at all (stale games)
    const del = await Match.deleteMany({ source: 'juan', matchId: { $nin: Array.from(seen) } });
    console.log(`✅ [football] Synced ${matches.length} matches (removed ${del.deletedCount} stale)`);
    return { synced: matches.length };
  } catch (e) {
    console.error('  [football] sync failed:', e.message);
    return { synced: 0, error: e.message };
  }
}

// Live poll — runs frequently. Always reflects exactly what the API
// says right now; broadcasts the live snapshot to all WS subscribers.
async function updateLive() {
  try {
    const live = await footballApi.fetchLive();

    // Any match previously marked 'live' in DB that is no longer in
    // the live feed must be reconciled — re-check it against fixtures
    // rather than leaving it frozen as "live" with an old score.
    const stillLiveIds = new Set(live.map(m => m.matchId));
    const previouslyLive = await Match.find({ status: 'live' }, { matchId: 1 }).lean();
    const droppedOut = previouslyLive.filter(m => !stillLiveIds.has(m.matchId)).map(m => m.matchId);

    for (const m of live) {
      await Match.findOneAndUpdate(
        { matchId: m.matchId },
        { $set: { ...m } },
        { upsert: true }
      );
    }
    if (droppedOut.length) {
      // Match.findOne per id and re-fetch its true status from fixtures
      // would be ideal, but to never show stale "live", at minimum we
      // clear the live flag; the next syncFixtures() pass will set the
      // correct finished/upcoming status from the API.
      await Match.updateMany({ matchId: { $in: droppedOut } }, { $set: { status: 'finished' } });
    }

    broadcast({
      type: 'live',
      data: live,
      message: live.length ? null : 'No live matches',
      time: new Date().toISOString()
    });

    return { live: live.length };
  } catch (e) {
    console.error('  [football] live update failed:', e.message);
    // Do NOT broadcast stale data on failure — broadcast an explicit
    // error state so clients know not to trust their current cache.
    broadcast({ type: 'live_error', message: 'Live data temporarily unavailable', time: new Date().toISOString() });
    return { live: 0, error: e.message };
  }
}

module.exports = { syncFixtures, updateLive, setBroadcaster };
