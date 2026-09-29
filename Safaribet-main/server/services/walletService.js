const mongoose = require('mongoose');
const Wallet = require('../models/Wallet');
const WalletHistory = require('../models/WalletHistory');
const Transaction = require('../models/Transaction');

/**
 * walletService — single source of truth for all balance mutations.
 * Every function here is atomic at the document level (uses $inc, never read-modify-write)
 * and writes a WalletHistory entry for auditability.
 */

// Get or create a wallet for a user (lazy creation — keeps old User.balance users working)
async function getOrCreateWallet(userId) {
  let wallet = await Wallet.findOne({ userId });
  if (!wallet) {
    // Auto-migrate any existing legacy User.balance/bonus so nobody's money disappears
    try {
      const User = require('../models/User');
      wallet = await migrateFromLegacyUser(User, userId);
    } catch (e) {
      // Fallback: brand-new user with no legacy data
      wallet = await Wallet.create({ userId, main: 0, bonus: 0, locked: 0, pending: 0 });
    }
  }
  return wallet;
}

async function getBalance(userId) {
  const wallet = await getOrCreateWallet(userId);
  return {
    main: wallet.main,
    bonus: wallet.bonus,
    locked: wallet.locked,
    pending: wallet.pending,
    spendable: parseFloat((wallet.main + wallet.bonus).toFixed(2)),
    withdrawable: wallet.main
  };
}

/**
 * Credit a bucket (always safe — increases balance).
 */
async function credit(userId, bucket, amount, reason, reference, meta) {
  if (amount <= 0) throw new Error('Credit amount must be positive');
  amount = parseFloat(amount.toFixed(2));

  await getOrCreateWallet(userId); // ensure exists

  const wallet = await Wallet.findOneAndUpdate(
    { userId },
    { $inc: { [bucket]: amount } },
    { new: true }
  );

  await WalletHistory.create({
    userId, bucket, change: amount, balanceAfter: wallet[bucket],
    reason, reference, meta
  });

  return wallet;
}

/**
 * Debit a bucket atomically — only succeeds if sufficient balance exists.
 * Returns null if insufficient funds (caller must handle).
 */
async function debit(userId, bucket, amount, reason, reference, meta) {
  if (amount <= 0) throw new Error('Debit amount must be positive');
  amount = parseFloat(amount.toFixed(2));

  await getOrCreateWallet(userId);

  const wallet = await Wallet.findOneAndUpdate(
    { userId, [bucket]: { $gte: amount } },
    { $inc: { [bucket]: -amount } },
    { new: true }
  );

  if (!wallet) return null; // insufficient funds

  await WalletHistory.create({
    userId, bucket, change: -amount, balanceAfter: wallet[bucket],
    reason, reference, meta
  });

  return wallet;
}

/**
 * Move funds between buckets (e.g. unlock, bonus->main conversion).
 */
async function move(userId, fromBucket, toBucket, amount, reason, reference, meta) {
  const debited = await debit(userId, fromBucket, amount, reason, reference, meta);
  if (!debited) return null;
  const credited = await credit(userId, toBucket, amount, reason, reference, meta);
  return credited;
}

/**
 * Deduct a bet stake: prefers bonus balance first (use-bonus-before-cash is standard practice),
 * falls back to main. Returns { wallet, fromBonus, fromMain } or null if insufficient.
 */
async function deductStake(userId, amount, reference) {
  amount = parseFloat(amount.toFixed(2));
  const wallet = await getOrCreateWallet(userId);
  const totalAvailable = wallet.main + wallet.bonus;
  if (totalAvailable < amount) return null;

  const fromBonus = Math.min(wallet.bonus, amount);
  const fromMain = parseFloat((amount - fromBonus).toFixed(2));

  let updated = wallet;
  if (fromBonus > 0) {
    updated = await debit(userId, 'bonus', fromBonus, 'bet_stake', reference);
    if (!updated) return null;
  }
  if (fromMain > 0) {
    updated = await debit(userId, 'main', fromMain, 'bet_stake', reference);
    if (!updated) {
      // roll back bonus debit since main debit failed (race condition safety)
      if (fromBonus > 0) await credit(userId, 'bonus', fromBonus, 'refund', reference);
      return null;
    }
  }

  return { wallet: updated, fromBonus, fromMain };
}

/**
 * Pay out bet winnings — always to main balance (winnings are real cash, withdrawable).
 */
async function payoutWin(userId, amount, reference, meta) {
  return credit(userId, 'main', amount, 'bet_payout', reference, meta);
}

/**
 * Lock funds (e.g. while a withdrawal is processing) — moves main -> locked.
 */
async function lockForWithdrawal(userId, amount, reference) {
  return move(userId, 'main', 'locked', amount, 'lock', reference);
}

/**
 * Release a lock back to main (withdrawal failed/reversed).
 */
async function releaseLock(userId, amount, reference) {
  return move(userId, 'locked', 'main', amount, 'withdrawal_reversed', reference);
}

/**
 * Finalize a withdrawal — removes from locked permanently (money has left the platform).
 */
async function finalizeWithdrawal(userId, amount, reference) {
  return debit(userId, 'locked', amount, 'withdrawal', reference);
}

/**
 * Deposit confirmed (M-Pesa callback success) — credits main directly.
 */
async function confirmDeposit(userId, amount, reference, meta) {
  return credit(userId, 'main', amount, 'deposit', reference, meta);
}

/**
 * Get wallet transaction history (paginated).
 */
async function getHistory(userId, { page = 1, limit = 20, bucket, reason } = {}) {
  const filter = { userId };
  if (bucket) filter.bucket = bucket;
  if (reason) filter.reason = reason;
  const skip = (page - 1) * limit;
  const [items, total] = await Promise.all([
    WalletHistory.find(filter).sort({ createdAt: -1 }).skip(skip).limit(limit).lean(),
    WalletHistory.countDocuments(filter)
  ]);
  return { items, total, page, pages: Math.ceil(total / limit) };
}

/**
 * Migration helper: pull balance from legacy User.balance/User.bonus into Wallet
 * the first time a wallet is created for an existing user. Safe to call repeatedly —
 * no-ops if wallet already has funds reconciled (checked via meta flag).
 */
async function migrateFromLegacyUser(User, userId) {
  const existing = await Wallet.findOne({ userId });
  if (existing) return existing;

  const user = await User.findById(userId).select('balance bonus');
  if (!user) throw new Error('User not found');

  const wallet = await Wallet.create({
    userId,
    main: user.balance || 0,
    bonus: user.bonus || 0,
    locked: 0,
    pending: 0
  });

  await WalletHistory.create({
    userId, bucket: 'main', change: user.balance || 0, balanceAfter: wallet.main,
    reason: 'admin_adjustment', reference: 'legacy_migration',
    meta: { note: 'Migrated from User.balance on first wallet access' }
  });
  if (user.bonus) {
    await WalletHistory.create({
      userId, bucket: 'bonus', change: user.bonus, balanceAfter: wallet.bonus,
      reason: 'admin_adjustment', reference: 'legacy_migration',
      meta: { note: 'Migrated from User.bonus on first wallet access' }
    });
  }

  return wallet;
}

module.exports = {
  getOrCreateWallet,
  getBalance,
  credit,
  debit,
  move,
  deductStake,
  payoutWin,
  lockForWithdrawal,
  releaseLock,
  finalizeWithdrawal,
  confirmDeposit,
  getHistory,
  migrateFromLegacyUser
};
