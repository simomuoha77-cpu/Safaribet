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

  // Who earned the most (sorted by money really paid - so the newest referrers show up, not only the oldest accounts)
  const earnRows = await Transaction.aggregate([
    { $match: { type: 'referral_bonus', reference: { $regex: '^referral_referrer_' } } },
    { $group: { _id: '$userId', earned: { $sum: '$amount' }, paidCount: { $sum: 1 }, last: { $max: '$createdAt' } } },
    { $sort: { earned: -1, last: -1 } }, { $limit: limit || 20 },
    { $lookup: { from: 'users', localField: '_id', foreignField: '_id', as: 'u' } },
    { $unwind: '$u' },
    { $project: { username: '$u.username', phone: '$u.phone', earned: 1, paidCount: 1, last: 1 } }
  ]);
  const eIds = earnRows.map(r => r._id);
  const cRows = eIds.length ? await User.aggregate([{ $match: { referredBy: { $in: eIds } } }, { $group: { _id: '$referredBy', count: { $sum: 1 } } }]) : [];
  const cBy = new Map(cRows.map(r => [String(r._id), r.count]));
  const earners = earnRows.map(r => Object.assign({}, r, { count: cBy.get(String(r._id)) || 0 }));

  // Latest sign-ups through a referral link: WHO referred WHOM, and whether it was verified and paid
  const recentUsers = await User.find({ referredBy: { $ne: null } }).sort({ createdAt: -1 }).limit(30).select('username phone createdAt phoneVerified referredBy').lean();
  const rIds = Array.from(new Set(recentUsers.map(u => String(u.referredBy))));
  const referrers = rIds.length ? await User.find({ _id: { $in: rIds } }).select('username phone').lean() : [];
  const rBy = new Map(referrers.map(r => [String(r._id), r]));
  const refs = recentUsers.map(u => 'referral_referrer_' + u._id);
  const paidRows = refs.length ? await Transaction.find({ type: 'referral_bonus', reference: { $in: refs } }).select('reference amount createdAt').lean() : [];
  const paidBy = new Map(paidRows.map(r => [r.reference, r]));
  const recent = recentUsers.map(u => {
    const ref = rBy.get(String(u.referredBy)) || {}, paid = paidBy.get('referral_referrer_' + u._id);
    return { username: u.username, phone: u.phone, joinedAt: u.createdAt, referrer: ref.username || '(deleted account)', referrerPhone: ref.phone || '',
             verified: !!(paid || u.phoneVerified), paid: paid ? paid.amount : 0 };
  });

  return { data, earners, recent, totalReferred, verifiedReferrals: (t.referrer && t.referrer.n) || 0, referrerPaid, newUserPaid, totalPaid: referrerPaid + newUserPaid };
}
module.exports = { build };
