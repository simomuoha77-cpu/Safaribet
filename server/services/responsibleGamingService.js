const User = require('../models/User');
const Bet = require('../models/Bet');
const Transaction = require('../models/Transaction');

/**
 * responsibleGamingService — self-exclusion and limit checks. These are
 * enforcement points called from bet placement / deposit flows; they THROW
 * on violation (caller should catch and return a 403) rather than silently
 * failing, since this is a user-protection feature, not optional.
 */

async function checkSelfExclusion(userId) {
  const user = await User.findById(userId).select('selfExcludedUntil');
  if (user?.selfExcludedUntil && user.selfExcludedUntil > new Date()) {
    const until = user.selfExcludedUntil.toISOString().slice(0, 10);
    throw new Error(`Your account is self-excluded until ${until}. Contact support if you believe this is an error.`);
  }
}

async function checkStakeLimit(userId, stakeAmount) {
  const user = await User.findById(userId).select('dailyStakeLimit');
  if (!user?.dailyStakeLimit) return; // no limit set

  const startOfDay = new Date(); startOfDay.setHours(0, 0, 0, 0);
  const todayStaked = await Bet.aggregate([
    { $match: { userId: user._id, createdAt: { $gte: startOfDay } } },
    { $group: { _id: null, total: { $sum: '$stake' } } }
  ]);
  const stakedSoFar = todayStaked[0]?.total || 0;

  if (stakedSoFar + stakeAmount > user.dailyStakeLimit) {
    throw new Error(`This would exceed your daily betting limit of KES ${user.dailyStakeLimit} (already staked KES ${stakedSoFar} today).`);
  }
}

async function checkDepositLimit(userId, depositAmount) {
  const user = await User.findById(userId).select('dailyDepositLimit');
  if (!user?.dailyDepositLimit) return;

  const startOfDay = new Date(); startOfDay.setHours(0, 0, 0, 0);
  const todayDeposited = await Transaction.aggregate([
    { $match: { userId: user._id, type: 'deposit', status: { $in: ['completed', 'pending'] }, createdAt: { $gte: startOfDay } } },
    { $group: { _id: null, total: { $sum: '$amount' } } }
  ]);
  const depositedSoFar = todayDeposited[0]?.total || 0;

  if (depositedSoFar + depositAmount > user.dailyDepositLimit) {
    throw new Error(`This would exceed your daily deposit limit of KES ${user.dailyDepositLimit} (already deposited KES ${depositedSoFar} today).`);
  }
}

async function setLimits(userId, { dailyDepositLimit, dailyStakeLimit }) {
  const update = {};
  // Limits can only be lowered immediately; raising a limit takes effect after 24h
  // (standard responsible-gambling practice — prevents impulsive limit raising mid-session).
  // Simplified here: we apply immediately but flag for a future cooling-off enforcement layer.
  if (dailyDepositLimit !== undefined) update.dailyDepositLimit = dailyDepositLimit;
  if (dailyStakeLimit !== undefined) update.dailyStakeLimit = dailyStakeLimit;
  return User.findByIdAndUpdate(userId, { $set: update }, { new: true }).select('dailyDepositLimit dailyStakeLimit');
}

async function selfExclude(userId, days) {
  const until = new Date(Date.now() + days * 24 * 3600 * 1000);
  await User.findByIdAndUpdate(userId, { $set: { selfExcludedUntil: until } });

  require('./authService').revokeAllSessions(userId).catch(() => {});
  require('./auditService').log('user.self_exclude', {
    actorId: userId, actorRole: 'user', targetType: 'User', targetId: userId.toString(), meta: { days, until }
  });

  return until;
}

module.exports = { checkSelfExclusion, checkStakeLimit, checkDepositLimit, setLimits, selfExclude };
