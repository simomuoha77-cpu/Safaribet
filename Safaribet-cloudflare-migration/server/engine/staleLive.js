// Closes "live" game records that the feed never closed (postponed / abandoned / dropped by the provider).
// They kept stacking up (1117 in the admin panel). A record is closed only when it is certain nobody is waiting for it:
//   - kicked off more than 24h ago (multi-day cricket excluded), AND not seen in the live feed for 2h+ (so a feed that still lists it is left alone), AND
//   - no pending bet and no open jackpot round uses it.
// Games that still have a bet waiting stay as they are, so settlement is never affected.
const OLDER_THAN_MS = 24 * 3600000, UNSEEN_MS = 2 * 3600000;

async function closeStuckLive(Match, Bet, Jackpot, opts) {
  const now = (opts && opts.now) || Date.now();
  const cutoff = new Date(now - OLDER_THAN_MS), unseen = new Date(now - UNSEEN_MS);
  const cands = await Match.find({
    status: 'live', sport: { $ne: 'cricket' }, commenceTime: { $lt: cutoff },
    $or: [{ lastLiveSeenAt: null }, { lastLiveSeenAt: { $exists: false } }, { lastLiveSeenAt: { $lt: unseen } }]
  }).select('matchId').limit(5000).lean();
  if (!cands.length) return { closed: 0, kept: 0 };

  const keep = new Set((await Bet.distinct('selections.matchId', { status: 'pending' })).map(String));
  if (Jackpot) {
    const open = await Jackpot.find({ status: { $in: ['open', 'locked', 'awaiting_approval'] } }).select('fixtures.matchId').lean();
    for (const j of open) for (const f of (j.fixtures || [])) if (f && f.matchId) keep.add(String(f.matchId));
  }
  const ids = cands.map(c => c.matchId).filter(id => !keep.has(String(id)));
  if (ids.length) {
    await Match.updateMany({ matchId: { $in: ids }, status: 'live' },
      { $set: { status: 'finished', trackerNote: 'closed automatically: old live record, no result from the feed and no bet waiting' } });
  }
  return { closed: ids.length, kept: cands.length - ids.length };
}
module.exports = { closeStuckLive, OLDER_THAN_MS, UNSEEN_MS };
