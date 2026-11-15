#!/usr/bin/env node
// For a game the server never saw live (so it cannot know the result): enter the REAL final score yourself.
// The game is then marked finished and the normal settlement turns every waiting bet into won / lost within about a
// minute. Nothing is guessed: you give the score, the tool only writes it (marked "admin") and shows what it will touch.
// Dry run by default - nothing is written without --apply.
//
//   node tools/set-final-score.js "Morocco" 0-0 --date 2026-10-12          (shows the matching game, changes nothing)
//   node tools/set-final-score.js "Morocco" 0-0 --date 2026-10-12 --apply  (writes it)
//   node tools/set-final-score.js --id sofabets_12345 2-1 --apply           (exact match id instead of a name)
//
// score = home team first, as the game is listed (e.g. "Morocco vs Uzbekistan" 0-0). Full-time score, 90 minutes.
// The game must have kicked off more than 100 minutes ago (use --force only if you are sure it has ended).
const path = require('path');

function parseScoreArg(s) {
  const m = /^(\d{1,2})\s*[-:]\s*(\d{1,2})$/.exec(String(s || '').trim());
  return m ? { home: Number(m[1]), away: Number(m[2]) } : null;
}
// rows of the same real game (live-tab id, main-feed id ...) belong together
function groupRows(rows, parse) {
  const groups = new Map();
  for (const r of rows) {
    const p = parse ? parse(r.matchId) : null;
    const key = p && p.providerId ? `${p.sport}:${p.providerId}` : r.matchId;
    if (!groups.has(key)) groups.set(key, { key, parsed: p && p.providerId ? p : null, rows: [] });
    groups.get(key).rows.push(r);
  }
  return Array.from(groups.values());
}
function siblingIds(group) {
  const ids = new Set(group.rows.map(r => r.matchId));
  if (group.parsed) { const { providerId: id, sport } = group.parsed; [`sofabets_${id}`, `sofabets_${sport}_${id}`, `sofabets_live_${id}`, `sofabets_live_${sport}_${id}`].forEach(x => ids.add(x)); }
  return Array.from(ids);
}
// Is this game ALREADY confirmed final by the system? 'none' | 'same' (same score as entered) | 'different'
function finalConflict(rows, score) {
  const fr = (rows || []).filter(r => r.finalVerified && r.score && r.score.home != null && r.score.away != null);
  if (!fr.length) return { state: 'none' };
  const same = fr.every(r => Number(r.score.home) === score.home && Number(r.score.away) === score.away);
  return { state: same ? 'same' : 'different', existing: fr[0].score };
}
function tooRecent(kickoffMs, nowMs, minMinutes = 100) { return !kickoffMs || (nowMs - kickoffMs) < minMinutes * 60000; }
module.exports = { parseScoreArg, groupRows, siblingIds, tooRecent, finalConflict };

if (require.main === module) {
  try { require('dotenv').config({ path: path.join(__dirname, '..', '.env') }); } catch (e) {}
  const args = process.argv.slice(2);
  const flag = n => args.includes(n);
  const opt = n => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : null; };
  const apply = flag('--apply'), force = flag('--force');
  const idOpt = opt('--id'), dateOpt = opt('--date');
  const positional = args.filter((a, i) => !a.startsWith('--') && !['--id', '--date'].includes(args[i - 1]));
  const text = idOpt ? null : positional[0];
  const score = parseScoreArg(idOpt ? positional[0] : positional[1]);
  if ((!text && !idOpt) || !score) { console.log('Usage: node tools/set-final-score.js "<team name>" <home>-<away> [--date YYYY-MM-DD] [--apply]\n   or: node tools/set-final-score.js --id <matchId> <home>-<away> [--apply]'); process.exit(1); }
  if (!process.env.MONGO_URI) { console.log('MONGO_URI is not set (it normally comes from the .env file in the project folder).'); process.exit(1); }
  const mongoose = require('mongoose');
  const Match = require('../server/models/Match'), Bet = require('../server/models/Bet');
  const fin = require('../server/services/finalResultService');
  (async () => {
    await mongoose.connect(process.env.MONGO_URI, { serverSelectionTimeoutMS: 15000 });
    const now = Date.now();
    const q = idOpt ? { matchId: idOpt } : (() => {
      const rx = new RegExp(text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
      const from = dateOpt ? new Date(dateOpt + 'T00:00:00+03:00') : new Date(now - 5 * 86400000);
      const to = dateOpt ? new Date(from.getTime() + 24 * 3600000) : new Date(now);
      return { $or: [{ homeTeam: rx }, { awayTeam: rx }], commenceTime: { $gte: from, $lte: to } };
    })();
    const rows = await Match.find(q, { matchId: 1, homeTeam: 1, awayTeam: 1, league: 1, sport: 1, commenceTime: 1, status: 1, finalVerified: 1, score: 1 }).limit(80).lean();
    const groups = groupRows(rows, fin.parseSofaMatchId);
    if (!groups.length) { console.log('No game found. Try a shorter part of the name, or add --date YYYY-MM-DD (the day it was played).'); await mongoose.disconnect(); return; }
    const info = [];
    for (const g of groups) {
      const sib = siblingIds(g), r0 = g.rows[0], kick = r0.commenceTime ? new Date(r0.commenceTime).getTime() : 0;
      const pending = await Bet.countDocuments({ status: 'pending', selections: { $elemMatch: { matchId: { $in: sib }, result: 'pending' } } });
      info.push({ g, sib, r0, kick, pending });
    }
    info.forEach((x, i) => console.log(`#${i + 1}  ${x.r0.homeTeam} vs ${x.r0.awayTeam} | ${x.r0.league || '-'} | kickoff ${x.kick ? new Date(x.kick).toLocaleString('en-KE', { timeZone: 'Africa/Nairobi', dateStyle: 'medium', timeStyle: 'short' }) : '?'}\n    ids: ${x.g.rows.map(r => r.matchId + (r.finalVerified ? ' (final ' + (r.score ? r.score.home + '-' + r.score.away : '?') + ')' : ' (' + (r.status || '?') + ')')).join(', ')}\n    waiting bets on it: ${x.pending}`));
    console.log(`\nScore you entered: ${score.home}-${score.away} (first team = home, as listed above)`);
    if (info.length !== 1) { console.log('More than one game matches. Add more of the name, add --date, or use --id <matchId>.'); await mongoose.disconnect(); return; }
    const x = info[0];
    const fc = finalConflict(x.g.rows, score);
    if (fc.state === 'same' && !force) { console.log('This game is already confirmed final with exactly this score. Nothing to do.'); await mongoose.disconnect(); return; }
    if (fc.state === 'different' && !force) { console.log(`This game is already confirmed final by the system as ${fc.existing.home}-${fc.existing.away}, which is different from the ${score.home}-${score.away} you entered. NOTHING changed. Check the real result first; use --force only if the system's score is wrong.`); await mongoose.disconnect(); return; }
    if (tooRecent(x.kick, now) && !force) { console.log('This game kicked off less than 100 minutes ago (or has no kickoff time), so it may still be playing. Nothing changed. (--force overrides.)'); await mongoose.disconnect(); return; }
    if (!apply) { console.log('Dry run only. If this is the right game and score, run it again with --apply.'); await mongoose.disconnect(); return; }
    const set = { status: 'finished', result: fin.resultFromScore(score.home, score.away), 'score.home': score.home, 'score.away': score.away, 'score.period': 'FT', finalVerified: true, finalVerifiedAt: new Date(), finalSource: 'admin', settled: false, trackerNote: null };
    const r = await Match.updateMany({ matchId: { $in: x.sib } }, { $set: set });
    // make sure every id a waiting bet points at has a row to carry the result
    const bets = await Bet.find({ status: 'pending', selections: { $elemMatch: { matchId: { $in: x.sib }, result: 'pending' } } }, { selections: 1 }).lean();
    const have = new Set((await Match.find({ matchId: { $in: x.sib } }, { matchId: 1 }).lean()).map(m => m.matchId));
    let created = 0;
    for (const b of bets) for (const s of b.selections || []) {
      if (!x.sib.includes(s.matchId) || have.has(s.matchId)) continue;
      await Match.updateOne({ matchId: s.matchId }, { $setOnInsert: { matchId: s.matchId, homeTeam: x.r0.homeTeam, awayTeam: x.r0.awayTeam, league: x.r0.league, sport: x.r0.sport || 'football', commenceTime: x.r0.commenceTime, source: 'admin' }, $set: set }, { upsert: true });
      have.add(s.matchId); created++;
    }
    console.log(`\nDone. Marked FINAL ${score.home}-${score.away} on ${r.modifiedCount != null ? r.modifiedCount : r.nModified} record(s)${created ? ' (+' + created + ' created)' : ''}. The ${x.pending} waiting bet(s) settle within about a minute.`);
    await mongoose.disconnect();
  })().catch(e => { console.error('Failed:', e.message); process.exit(1); });
}
