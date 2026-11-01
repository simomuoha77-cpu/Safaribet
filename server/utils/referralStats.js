// Admin referral numbers, taken from what was REALLY paid (Transaction rows of type "referral_bonus"),
// not from "count x current bonus amount" (which was 0 once the bonus settings were split in two).
// A referrer's row: reference "referral_referrer_<newUserId>"; the new player's welcome bonus: "referral_new_<newUserId>".
async function build(User, Transaction, limit) {
  const top = await User.aggregate([
    { $match: { referredBy: { $ne: null } } },
    { $group: { _id: '$referredBy', count: { $sum: 1 } } },
    { $sort: { count: -1 } }, { $limit: limit || 20 },
    { $lookup: { from: 'users', localField: '_id', foreignField: '_id', as: 'referrer' } },
    { $unwind: '$referrer' },
    { $project: { username: '$referrer.username', phone: '$referrer.phone', referralCode: '$referrer.referralCode', count: 1 } }
  ]);
  const ids = top.map(t => t._id);
  const earnedRows = ids.length ? await Transaction.aggregate([
    { $match: { type: 'referral_bonus', userId: { $in: ids }, reference: { $regex: '^referral_referrer_' } } },
    { $group: { _id: '$userId', earned: { $sum: '$amount' }, paidCount: { $sum: 1 } } }
  ]) : [];
  const byId = new Map(earnedRows.map(r => [String(r._id), r]));
  const data = top.map(t => {
    const e = byId.get(String(t._id)) || {};
    return Object.assign({}, t, { earned: e.earned || 0, paidCount: e.paidCount || 0 });
  });
  const totals = await Transaction.aggregate([
    { $match: { type: 'referral_bonus' } },
    { $group: { _id: { $cond: [{ $regexMatch: { input: { $ifNull: ['$reference', ''] }, regex: '^referral_referrer_' } }, 'referrer', 'newUser'] }, amount: { $sum: '$amount' }, n: { $sum: 1 } } }
  ]);
  const t = Object.fromEntries(totals.map(x => [x._id, x]));
  const referrerPaid = (t.referrer && t.referrer.amount) || 0, newUserPaid = (t.newUser && t.newUser.amount) || 0;
  const totalReferred = await User.countDocuments({ referredBy: { $ne: null } });
  return { data, totalReferred, verifiedReferrals: (t.referrer && t.referrer.n) || 0, referrerPaid, newUserPaid, totalPaid: referrerPaid + newUserPaid };
}
module.exports = { build };
