const Notification = require('../models/Notification');

// Lazy reference to the live-notifications WebSocket broadcaster (set by index.js at startup)
let wsBroadcast = null;
function setBroadcaster(fn) { wsBroadcast = fn; }
function getBroadcaster() { return wsBroadcast; }

const TEMPLATES = {
  bet_won:            (d) => ({ title: 'Bet Won! 🎉', message: `Your bet ${d.betCode} won — KES ${d.amount} credited.` }),
  bet_lost:           (d) => ({ title: 'Bet Settled', message: `Your bet ${d.betCode} did not win this time.` }),
  bet_void:           (d) => ({ title: 'Bet Voided', message: `Your bet ${d.betCode} was voided and refunded.` }),
  cashout:            (d) => ({ title: 'Cash Out Successful', message: `You cashed out ${d.betCode} for KES ${d.amount}.` }),
  deposit_success:    (d) => ({ title: 'Deposit Successful', message: `KES ${d.amount} added to your wallet.` }),
  withdrawal_success: (d) => ({ title: 'Withdrawal Successful', message: `KES ${d.amount} sent to your M-Pesa.` }),
  withdrawal_failed:  (d) => ({ title: 'Withdrawal Failed', message: `Your withdrawal of KES ${d.amount} failed and was refunded.` }),
  promotion:          (d) => ({ title: d.title || 'New Promotion', message: d.message || 'Check out our latest offer!' }),
  system:             (d) => ({ title: d.title || 'Announcement', message: d.message || '' }),
  bonus_credited:     (d) => ({ title: 'Bonus Credited 🎁', message: `KES ${d.amount} bonus added to your account.` }),
  // Sent whenever an admin corrects a match result on an already-settled bet
  // (see POST /api/bets/admin/override-selection) — always sent alongside
  // whatever the balance change actually was, so the user is never left
  // guessing why their balance moved or why an earlier "You Won!" notice no
  // longer matches what's shown on the bet. The original notification from
  // the first settlement is deliberately left in their history untouched —
  // this adds a new, honest one rather than editing the past.
  bet_correction_now_lost:   (d) => ({ title: 'Bet Result Corrected', message: `We corrected the result for bet ${d.betCode} — after review, it did not win. KES ${d.amount} has been deducted from your balance.` }),
  bet_correction_now_won:    (d) => ({ title: 'Bet Result Corrected — You Won!', message: `We corrected the result for bet ${d.betCode} — after review, it actually won. KES ${d.amount} has been credited to your balance.` }),
  bet_correction_adjusted:   (d) => ({ title: 'Bet Payout Adjusted', message: `Your payout for bet ${d.betCode} was adjusted after a result correction. ${d.amount >= 0 ? `KES ${d.amount} additional credit` : `KES ${Math.abs(d.amount)} deducted`}.` }),
  bet_correction_shortfall:  (d) => ({ title: 'Bet Result Corrected', message: `We corrected the result for bet ${d.betCode} — after review, it did not win. KES ${d.amount} has been deducted from your balance; the remaining KES ${d.shortfall} is outstanding.` }),
};

async function notify(userId, type, data = {}) {
  const template = TEMPLATES[type];
  if (!template) throw new Error(`Unknown notification type: ${type}`);
  const { title, message } = template(data);

  const notification = await Notification.create({ userId, type, title, message, data });

  if (wsBroadcast) {
    try { wsBroadcast(userId.toString(), notification); } catch (_) {}
  }

  return notification;
}

// Rewrites the ORIGINAL "You Won!"/"Bet Settled" notification from a bet's
// first settlement so it no longer says something that's no longer true —
// used alongside (not instead of) sending a fresh bet_correction_* notify()
// above, so the user both sees an active alert about the change right now
// AND never finds a stale, contradictory "You Won!" sitting in their history
// if they scroll back to it later. Finds the notification by betCode stored
// in its `data`, since that's the only stable link back to a specific bet.
async function correctBetNotification(userId, betCode, newStatus) {
  const REWRITES = {
    won:  { title: 'Bet Won! 🎉',  toType: 'bet_won'  },
    lost: { title: 'Bet Settled',  toType: 'bet_lost' },
    void: { title: 'Bet Voided',   toType: 'bet_void' }
  };
  const rewrite = REWRITES[newStatus];
  if (!rewrite) return null;
  const message = newStatus === 'won'
    ? `Your bet ${betCode} won.`
    : newStatus === 'lost'
      ? `Your bet ${betCode} did not win this time.`
      : `Your bet ${betCode} was voided and refunded.`;
  return Notification.findOneAndUpdate(
    { userId, 'data.betCode': betCode, type: { $in: ['bet_won', 'bet_lost', 'bet_void'] } },
    { $set: { type: rewrite.toType, title: rewrite.title, message } },
    { sort: { createdAt: -1 } } // if somehow more than one exists, correct the most recent
  );
}

async function getForUser(userId, { page = 1, limit = 20, unreadOnly = false } = {}) {
  const filter = { userId };
  if (unreadOnly) filter.read = false;
  const skip = (page - 1) * limit;
  const [items, total, unreadCount] = await Promise.all([
    Notification.find(filter).sort({ createdAt: -1 }).skip(skip).limit(limit).lean(),
    Notification.countDocuments(filter),
    Notification.countDocuments({ userId, read: false })
  ]);
  return { items, total, page, pages: Math.ceil(total / limit), unreadCount };
}

async function markRead(userId, notificationId) {
  return Notification.findOneAndUpdate({ _id: notificationId, userId }, { $set: { read: true } }, { new: true });
}

async function markAllRead(userId) {
  return Notification.updateMany({ userId, read: false }, { $set: { read: true } });
}

module.exports = { notify, correctBetNotification, getForUser, markRead, markAllRead, setBroadcaster, getBroadcaster };
