// Where is each still-pending game right now: live / not started (with its kick-off time) / over and awaiting its result?
// Used by the admin Bet Management lists (display only: it never changes a bet or a result).
// Same rules as the player's My Bets page: the feed's current kick-off wins, a game with a future kick-off is never live,
// and simulated (SRL) games only count as live while the live feed is actually listing them.
const Match = require('../models/Match');
const fin = require('./finalResultService');

const isSrl = s => /\bSRL\b/i.test(`${s.homeTeam || ''} ${s.awayTeam || ''} ${s.league || ''}`);

async function annotate(bets) {
  try {
    const pend = [];
    (bets || []).forEach(bt => (bt.selections || []).forEach(s => { if ((s.result || 'pending') === 'pending') pend.push(Object.assign({ s }, { placed: new Date(bt.placedAt || bt.createdAt || 0).getTime() || 0 })); }));
    if (!pend.length) return bets;
    const ids = new Set();
    pend.forEach(({ s }) => {
      ids.add(s.matchId);
      const p = fin.parseSofaMatchId(s.matchId);
      if (p) [`sofabets_${p.providerId}`, `sofabets_${p.sport}_${p.providerId}`, `sofabets_live_${p.providerId}`, `sofabets_live_${p.sport}_${p.providerId}`].forEach(x => ids.add(x));
    });
    const rows = await Match.find({ matchId: { $in: Array.from(ids) } }, { matchId: 1, status: 1, finalVerified: 1, lastLiveSeenAt: 1, commenceTime: 1 }).lean();
    const byId = {}; rows.forEach(r => { byId[r.matchId] = r; });
    let lookup = null; try { lookup = require('../routes/sports').lookupIndexedMatch; } catch (_) {}
    const now = Date.now();
    for (const { s, placed } of pend) {
      const p = fin.parseSofaMatchId(s.matchId);
      const sib = p ? [s.matchId, `sofabets_${p.providerId}`, `sofabets_${p.sport}_${p.providerId}`, `sofabets_live_${p.providerId}`, `sofabets_live_${p.sport}_${p.providerId}`] : [s.matchId];
      const rs = sib.map(i => byId[i]).filter(Boolean);
      let ix = null; try { ix = lookup && lookup(s.matchId); } catch (_) {}
      const feedKick = ix && ix.commenceTime ? new Date(ix.commenceTime).getTime() || 0 : 0;
      const kick = feedKick || new Date((rs[0] && rs[0].commenceTime) || s.commenceTime || 0).getTime() || 0;
      const seen = Math.max(0, ...rs.map(r => r.lastLiveSeenAt ? new Date(r.lastLiveSeenAt).getTime() : 0));
      const sport = ((p && p.sport) || s.sport || 'football').toLowerCase();
      let state = fin.fixtureLiveState({ kick, seen, finalVerified: rs.some(r => r.finalVerified), sport, now });
      if (ix && ix.status === 'live' && !(kick && kick - now > 120000)) state = 'live';
      if (state === 'live' && kick && kick - now > 120000) state = 'not_started';
      // a simulated game, or a kick-off that is just the bet time, is only live while the feed really lists it
      const suspect = isSrl(s) || (!seen && placed && kick && Math.abs(kick - placed) < 10 * 60000 && now - kick > 10 * 60000);
      let unknown = false;
      if (state === 'live' && suspect && !(seen && now - seen < 3 * 60000) && !(ix && ix.status === 'live' && feedKick)) { state = 'not_started'; unknown = !feedKick; }
      s.fixtureState = state;
      s.kickoffAt = unknown ? null : (kick || null);
      if (unknown) s.kickoffUnknown = true;
    }
  } catch (_) { /* display only */ }
  return bets;
}
module.exports = { annotate };
