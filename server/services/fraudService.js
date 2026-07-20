const User = require('../models/User');
const Device = require('../models/Device');
const Bet = require('../models/Bet');
const Transaction = require('../models/Transaction');

/**
 * fraudService — lightweight, explainable heuristics (not ML). Flags suspicious
 * activity for admin review; does NOT auto-block accounts (false positives in
 * betting are costly to real customers), except for the most clear-cut signal
 * (same device/IP registering many accounts), which is rate-limited rather than blocked outright.
 */

// How many distinct user accounts have used this IP recently?
async function countAccountsOnIp(ip, withinHours = 24) {
  const since = new Date(Date.now() - withinHours * 3600 * 1000);
  const distinctUsers = await Device.distinct('userId', { ip, lastSeenAt: { $gte: since } });
  return distinctUsers.length;
}

// How many distinct accounts share this deviceId?
async function countAccountsOnDevice(deviceId) {
  if (!deviceId) return 0;
  const distinctUsers = await Device.distinct('userId', { deviceId });
  return distinctUsers.length;
}

/**
 * Run at registration time — returns a risk note (does not block), logged for admin visibility.
 */
async function assessRegistration({ ip, deviceId }) {
  const flags = [];
  const ipCount = await countAccountsOnIp(ip);
  if (ipCount >= 3) flags.push(`${ipCount} accounts already seen from this IP in 24h`);

  const deviceCount = await countAccountsOnDevice(deviceId);
  if (deviceCount >= 2) flags.push(`${deviceCount} accounts already linked to this device`);

  return { risk: flags.length ? 'review' : 'normal', flags };
}

/**
 * Run before/after a withdrawal — flags unusual patterns for admin review.
 * Does not block; withdraw.js already has its own hard limits (min bet placed, etc).
 */
async function assessWithdrawal(userId, amount) {
  const flags = [];

  // Deposit-and-withdraw cycling without any betting activity (common laundering pattern)
  const betCount = await Bet.countDocuments({ userId });
  const totalStaked = await Bet.aggregate([
    { $match: { userId } }, { $group: { _id: null, total: { $sum: '$stake' } } }
  ]);
  const staked = totalStaked[0]?.total || 0;

  const totalWithdrawn = await Transaction.aggregate([
    { $match: { userId, type: 'withdrawal', status: { $in: ['completed', 'pending'] } } },
    { $group: { _id: null, total: { $sum: { $abs: '$amount' } } } }
  ]);
  const withdrawnSoFar = totalWithdrawn[0]?.total || 0;

  if (betCount > 0 && staked > 0 && (withdrawnSoFar + amount) > staked * 3) {
    flags.push('Withdrawal volume significantly exceeds betting activity');
  }

  // Rapid-fire withdrawal requests (even within the route's own rate limit, flag for visibility)
  const recentWithdrawals = await Transaction.countDocuments({
    userId, type: 'withdrawal', createdAt: { $gte: new Date(Date.now() - 3600 * 1000) }
  });
  if (recentWithdrawals >= 2) flags.push(`${recentWithdrawals} withdrawal attempts in the last hour`);

  return { risk: flags.length ? 'review' : 'normal', flags };
}

module.exports = { countAccountsOnIp, countAccountsOnDevice, assessRegistration, assessWithdrawal };
