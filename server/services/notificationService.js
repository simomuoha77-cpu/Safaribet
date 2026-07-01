const Notification = require('../models/Notification');

// Lazy reference to the live-notifications WebSocket broadcaster (set by index.js at startup)
let wsBroadcast = null;
function setBroadcaster(fn) { wsBroadcast = fn; }

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

module.exports = { notify, getForUser, markRead, markAllRead, setBroadcaster };
