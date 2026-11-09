#!/usr/bin/env node
// ONE-OFF clean-up. Bets where EVERY game was voided used to be saved as "won" (they only got their stake back).
// That made refunds show as wins in My Bets and in the won counter. This relabels them "void" (Refunded).
// NO money moves - payout and balances are not touched. Dry run by default: nothing is written without --apply.
//
//   node tools/fix-void-bets.js            (shows what it would change)
//   node tools/fix-void-bets.js --apply    (does it)
const path = require('path');
function isAllVoid(bet) {
  const real = (bet.selections || []).filter(s => !s.excludedFromPayout);
  return bet.status === 'won' && real.length > 0 && real.every(s => s.result === 'void');
}
module.exports = { isAllVoid };

if (require.main === module) {
  try { require('dotenv').config({ path: path.join(__dirname, '..', '.env') }); } catch (e) {}
  const apply = process.argv.includes('--apply');
  if (!process.env.MONGO_URI) { console.log('MONGO_URI is not set (it normally comes from the .env file in the project folder).'); process.exit(1); }
  const mongoose = require('mongoose');
  const Bet = require('../server/models/Bet');
  (async () => {
    await mongoose.connect(process.env.MONGO_URI, { serverSelectionTimeoutMS: 15000 });
    let seen = 0, hits = [];
    const cur = Bet.find({ status: 'won' }, { betCode: 1, status: 1, stake: 1, 'selections.result': 1, 'selections.excludedFromPayout': 1 }).lean().cursor();
    for (let b = await cur.next(); b; b = await cur.next()) { seen++; if (isAllVoid(b)) hits.push(b); }
    console.log(`Checked ${seen} "won" bets. Fully refunded ones saved as won: ${hits.length}`);
    hits.slice(0, 15).forEach(b => console.log(`  ${b.betCode}  stake KES ${b.stake}`));
    if (hits.length > 15) console.log(`  ... and ${hits.length - 15} more`);
    if (!hits.length) { await mongoose.disconnect(); return; }
    if (!apply) { console.log('\nDry run only. Run again with --apply to relabel them as void (Refunded).'); await mongoose.disconnect(); return; }
    const r = await Bet.updateMany({ _id: { $in: hits.map(h => h._id) }, status: 'won' }, { $set: { status: 'void' } });
    console.log(`\nRelabelled ${r.modifiedCount != null ? r.modifiedCount : r.nModified} bets as void (Refunded). No money was moved.`);
    await mongoose.disconnect();
  })().catch(e => { console.error('Failed:', e.message); process.exit(1); });
}
