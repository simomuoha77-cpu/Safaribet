// ══════════════════════════════════════════════════════════════════════════════
// JuanAI Casino API integration  -  CASINO ONLY
//
//   Player -> SafariBet Casino -> JuanAI Casino API -> game provider
//                     ^                  |
//                     └── signed wallet callbacks (balance / debit / credit /
//                         rollback / refund) -> SAFARIBET WALLET (authoritative)
//
//   GET  /api/casino/juanai/status           integration state (no secrets)
//   GET  /api/casino/juanai/games            dynamic catalogue (provider, name, id, category, image)
//   POST /api/casino/juanai/launch   [auth]  create a JuanAI session, return the game URL
//   GET|POST /api/casino/juanai/wallet/balance
//   POST /api/casino/juanai/wallet/debit | credit | rollback | refund      (signed by JuanAI)
//
// JuanAI never holds a balance of its own. Every callback is signature-checked
// (fails closed), tied to a session this server created, and idempotent: the
// ledger row is inserted under a UNIQUE key before any money moves.
// ══════════════════════════════════════════════════════════════════════════════
const express = require('express');
const crypto = require('crypto');
const mongoose = require('mongoose');
const rateLimit = require('express-rate-limit');
const auth = require('../middleware/auth');
const safeError = require('../utils/safeError');
const walletService = require('../services/walletService');
const juanai = require('../services/juanaiCasino');
const User = require('../models/User');
const Wallet = require('../models/Wallet');
const WalletHistory = require('../models/WalletHistory');
const Transaction = require('../models/Transaction');
const CasinoSession = require('../models/CasinoSession');
const CasinoTransaction = require('../models/CasinoTransaction');

const router = express.Router();
const SESSION_TTL_MS = 7 * 24 * 3600 * 1000;      // kept long enough for late win/rollback callbacks
const DEBIT_SESSION_MAX_AGE_MS = 24 * 3600 * 1000; // new bets only inside 24h of launch
const MAX_AMOUNT = 1000000;

const launchLimiter = rateLimit({ windowMs: 60 * 1000, max: 20, standardHeaders: true, legacyHeaders: false,
  message: { success: false, message: 'Too many launch attempts. Please wait a moment.' } });

const first = (o, keys) => { for (const k of keys) if (o && o[k] != null && o[k] !== '') return o[k]; return undefined; };
const cents = n => Math.round(Number(n) * 100);
const money = c => c / 100;
const merge = req => Object.assign({}, req.query || {}, req.body || {});
const siteBase = req => (process.env.PUBLIC_URL || process.env.APP_URL || `${req.protocol}://${req.get('host')}`).replace(/\/+$/, '');

// ── public: state + catalogue ────────────────────────────────────────────────
router.get('/status', (req, res) => {
  const c = juanai.cfg();
  res.json({ success: true, configured: juanai.isConfigured() && !juanai.keyProblem(), environment: c.env, currency: 'KES' });
});

router.get('/games', async (req, res) => {
  if (!juanai.isConfigured() || juanai.keyProblem()) {
    return res.status(503).json({ success: false, message: 'Casino games are not available yet.', data: [] });
  }
  try {
    let games = await juanai.fetchCatalogue();
    const q = String(req.query.search || '').trim().toLowerCase();
    const cat = String(req.query.category || '').trim().toLowerCase();
    const prov = String(req.query.provider || '').trim().toLowerCase();
    const categories = Array.from(new Set(games.map(g => g.category))).sort((a, b) => a.localeCompare(b));
    const providers = Array.from(new Set(games.map(g => g.provider))).sort((a, b) => a.localeCompare(b));
    games = games.filter(g =>
      (!q || `${g.name} ${g.provider} ${g.gameId}`.toLowerCase().includes(q)) &&
      (!cat || cat === 'all' || g.category.toLowerCase() === cat) &&
      (!prov || prov === 'all' || g.provider.toLowerCase() === prov));
    res.json({ success: true, count: games.length, categories, providers, data: games });
  } catch (e) {
    console.error('[juanai/games]', e.message);
    res.status(502).json({ success: false, message: 'Casino catalogue is unavailable right now. Please try again shortly.', data: [] });
  }
});

// ── launch ───────────────────────────────────────────────────────────────────
router.post('/launch', auth, launchLimiter, async (req, res) => {
  try {
    if (!juanai.isConfigured() || juanai.keyProblem()) return res.status(503).json({ success: false, message: 'Casino games are not available yet.' });
    const gameId = String(req.body.gameId || '').trim();
    const mode = req.body.mode === 'demo' ? 'demo' : 'real';
    if (!gameId || gameId.length > 128) return res.status(400).json({ success: false, message: 'gameId is required' });

    const games = await juanai.fetchCatalogue();
    const game = games.find(g => g.gameId === gameId);
    if (!game) return res.status(404).json({ success: false, message: 'Game not found' });
    if (mode === 'demo' && !game.demo) return res.status(400).json({ success: false, message: 'Demo mode is not available for this game' });

    if (mode === 'real') {
      try { await require('../services/responsibleGamingService').checkSelfExclusion(req.user._id, req.user); }
      catch (rg) { return res.status(403).json({ success: false, message: rg.message }); }
    }

    const wallet = await Wallet.findOne({ userId: req.user._id }).select('currency').lean();
    const currency = String((wallet && wallet.currency) || 'KES').toUpperCase();

    const s = await juanai.createSession({
      playerId: req.user._id, username: req.user.username, currency, gameId, mode,
      callbackBase: siteBase(req), returnUrl: `${siteBase(req)}/casino`
    });
    let url;
    try { url = new URL(s.launchUrl || ''); } catch (e) { url = null; }
    if (!url || !/^https?:$/.test(url.protocol)) {
      console.error('[juanai/launch] provider returned no usable launch URL; keys:', Object.keys(s.raw || {}).join(','));
      return res.status(502).json({ success: false, message: 'The game could not be started. Please try again.' });
    }
    const sessionId = s.sessionId || crypto.randomUUID();
    await CasinoSession.findOneAndUpdate({ sessionId }, { $set: {
      sessionId, userId: req.user._id, provider: 'juanai', gameId, gameName: game.name, currency, mode,
      expiresAt: new Date(Date.now() + SESSION_TTL_MS)
    } }, { upsert: true });
    console.log(`[juanai/launch] user=${req.user._id} game=${gameId} mode=${mode} session=${sessionId} currency=${currency}`);
    res.json({ success: true, launchUrl: url.toString(), sessionId, currency, mode, gameName: game.name });
  } catch (e) {
    if (e && (e.code === 'NOT_CONFIGURED' || e.code === 'BAD_KEY')) return res.status(503).json({ success: false, message: 'Casino games are not available yet.' });
    return safeError(res, e, 'juanai/launch', 502, 'The game could not be started. Please try again.');
  }
});

// ── wallet callbacks (JuanAI -> SafariBet) ───────────────────────────────────
function verified(req, res, next) {
  const v = juanai.verifyCallback(req);
  if (!v.ok) {
    console.warn(`[juanai/wallet] rejected ${req.method} ${req.originalUrl}: ${v.message}`);
    return res.status(v.status).json({ success: false, status: 'UNAUTHORIZED', message: v.message });
  }
  next();
}

const fail = (res, http, status, message, extra) => res.status(http).json(Object.assign({ success: false, status, message }, extra || {}));

async function resolvePlayer(p) {
  const sessionId = first(p, ['sessionId', 'session_id', 'token', 'utoken']);
  const playerId = first(p, ['playerId', 'player_id', 'userId', 'user_id', 'player']);
  let session = null;
  if (sessionId != null) session = await CasinoSession.findOne({ sessionId: String(sessionId) });
  if (session) {
    if (playerId != null && String(playerId) !== String(session.userId)) return { error: ['PLAYER_MISMATCH', 'Player does not match the session'] };
    return { session, userId: session.userId };
  }
  if (sessionId != null) return { error: ['INVALID_SESSION', 'Unknown or expired session'] };
  if (playerId == null || !mongoose.isValidObjectId(String(playerId))) return { error: ['INVALID_PLAYER', 'playerId or sessionId is required'] };
  session = await CasinoSession.findOne({ userId: String(playerId), mode: 'real' }).sort({ createdAt: -1 });
  if (!session) return { error: ['NO_ACTIVE_SESSION', 'Player has no casino session'] };
  return { session, userId: session.userId };
}

async function balanceOf(userId) {
  const b = await walletService.getBalance(userId);
  return Number(b.main);   // the casino plays with the MAIN balance (bonus money is not casino-playable)
}

async function okReply(res, tx, userId, extra) {
  const bal = await balanceOf(userId);
  return res.json(Object.assign({ success: true, status: 'OK', transactionId: tx.transactionId, balance: bal, newBalance: bal, currency: tx.currency }, extra || {}));
}

async function replay(res, existing, userId) {
  // another request is still processing the same transaction: give it a moment
  for (let i = 0; i < 25 && existing.status === 'processing'; i++) {
    await new Promise(r => setTimeout(r, 150));
    existing = await CasinoTransaction.findById(existing._id);
  }
  if (existing.status === 'completed') return okReply(res, existing, userId, { duplicate: true });
  if (existing.status === 'failed') return fail(res, 400, existing.failCode || 'FAILED', existing.note || 'Transaction was rejected', { duplicate: true, transactionId: existing.transactionId, balance: await balanceOf(userId) });
  return fail(res, 409, 'IN_PROGRESS', 'Transaction is still being processed, retry shortly', { transactionId: existing.transactionId });
}

async function walletOnce(reference, doOp) {
  // Money moves at most once per reference, even if a stuck request is retried.
  const done = await WalletHistory.findOne({ reference }).lean();
  if (done) return { already: true };
  return { already: false, result: await doOp() };
}

async function handleMoney(type, req, res) {
  const p = merge(req);
  const who = await resolvePlayer(p);
  if (who.error) return fail(res, 400, who.error[0], who.error[1]);
  const { session, userId } = who;
  if (session.mode === 'demo') return fail(res, 400, 'DEMO_SESSION', 'Demo sessions do not use the wallet');

  const txId = String(first(p, ['transactionId', 'txId', 'transaction_id', 'tx_id', 'id', 'roundId']) ?? '').trim();
  if (!txId || txId.length > 128 || !/^[\w.:@=-]+$/.test(txId)) return fail(res, 400, 'INVALID_TRANSACTION', 'A valid transactionId is required');

  const isReversal = type === 'rollback' || type === 'refund';
  const rawAmt = first(p, ['amount', 'value']);
  let amount = rawAmt == null ? NaN : Number(rawAmt);
  if (isReversal && !Number.isFinite(amount)) amount = 0;       // reversals refund the ORIGINAL debit amount
  if (!Number.isFinite(amount) || amount < 0 || amount > MAX_AMOUNT || (type === 'debit' && amount <= 0)) return fail(res, 400, 'INVALID_AMOUNT', 'Invalid amount');
  const amtC = cents(amount);

  const currency = String(first(p, ['currency']) || session.currency).toUpperCase();
  if (currency !== session.currency) return fail(res, 400, 'CURRENCY_MISMATCH', `Wallet currency is ${session.currency}`);

  const refTx = String(first(p, ['refTransactionId', 'referenceTransactionId', 'originalTransactionId', 'betTransactionId', 'ref_transaction_id', 'original_transaction_id']) || txId).trim();
  const key = `juanai:${type}:${txId}`;
  const reference = `juanai_${type}_${txId}`;
  const eventAt = first(p, ['timestamp', 'time', 'createdAt']);

  // 1. claim the transaction id (unique) BEFORE touching the wallet
  let tx;
  try {
    tx = await CasinoTransaction.create({
      key, type, transactionId: txId, refTransactionId: isReversal ? refTx : undefined, userId, sessionId: session.sessionId,
      gameId: first(p, ['gameId', 'game_id']) != null ? String(first(p, ['gameId', 'game_id'])) : session.gameId,
      roundId: first(p, ['roundId', 'round_id']) != null ? String(first(p, ['roundId', 'round_id'])) : undefined,
      currency, amount: money(amtC), status: 'processing', walletReference: reference,
      eventAt: eventAt && !isNaN(new Date(Number(eventAt) || eventAt)) ? new Date(Number(eventAt) || eventAt) : undefined, ip: req.ip
    });
  } catch (e) {
    if (e && e.code === 11000) {
      let existing = await CasinoTransaction.findOne({ key });
      // a request that died mid-way (>30s in 'processing') is taken over safely: the wallet step is reference-guarded
      if (existing && existing.status === 'processing' && Date.now() - new Date(existing.updatedAt).getTime() > 30000) {
        const took = await CasinoTransaction.findOneAndUpdate({ _id: existing._id, status: 'processing', updatedAt: existing.updatedAt }, { $set: { note: 'retaken' } }, { new: true });
        if (took) tx = took;
      }
      if (!tx) return replay(res, existing, userId);
    } else throw e;
  }

  const finish = async (patch) => { Object.assign(tx, patch); await tx.save(); return tx; };
  const reject = async (http, code, message) => { await finish({ status: 'failed', failCode: code, note: message }); return fail(res, http, code, message, { transactionId: txId, balance: await balanceOf(userId) }); };

  try {
    if (type === 'debit') {
      const u = await User.findById(userId).select('isActive').lean();
      if (!u || u.isActive === false) return reject(400, 'PLAYER_BLOCKED', 'Player account is not active');
      try { await require('../services/responsibleGamingService').checkSelfExclusion(userId); }
      catch (rg) { return reject(400, 'PLAYER_BLOCKED', 'Player is not allowed to play'); }
      const rolled = await CasinoTransaction.findOne({ type: { $in: ['rollback', 'refund'] }, refTransactionId: txId, status: 'completed' }).lean();
      if (rolled) return reject(400, 'ALREADY_ROLLED_BACK', 'This bet was already rolled back');
      const r = await walletOnce(reference, () => walletService.debit(userId, 'main', money(amtC), 'casino_bet', reference, { provider: 'juanai', gameId: tx.gameId, session: session.sessionId, tx: txId }));
      if (!r.already && !r.result) return reject(400, 'INSUFFICIENT_FUNDS', 'Insufficient balance');
      await Transaction.create({ userId, type: 'casino_bet', amount: -money(amtC), balance: (r.result && r.result.main) || 0, reference, description: `${tx.gameId || 'Casino'} bet (tx ${txId})` }).catch(e => console.error('[juanai] tx log failed', e.message));
    } else if (type === 'credit') {
      if (amtC > 0) {
        const r = await walletOnce(reference, () => walletService.credit(userId, 'main', money(amtC), 'casino_win', reference, { provider: 'juanai', gameId: tx.gameId, session: session.sessionId, tx: txId }));
        await Transaction.create({ userId, type: 'casino_win', amount: money(amtC), balance: (r.result && r.result.main) || 0, reference, description: `${tx.gameId || 'Casino'} win (tx ${txId})` }).catch(e => console.error('[juanai] tx log failed', e.message));
        if (!r.already) require('../services/notificationService').notify(userId, 'casino_win', { title: 'Casino Win!', message: `You won ${currency} ${money(amtC).toFixed(2)} in ${session.gameName || 'Casino'}!` }).catch(() => {});
      }
    } else {
      // rollback / refund: give back exactly what the ORIGINAL debit took, once
      const orig = await CasinoTransaction.findOne({ type: 'debit', transactionId: refTx, userId, status: 'completed' });
      if (!orig) {
        await finish({ status: 'completed', amount: 0, note: 'original bet not found - recorded so a later bet with this id is refused' });
        return okReply(res, tx, userId, { note: 'original_not_found' });
      }
      const claimed = await CasinoTransaction.findOneAndUpdate({ _id: orig._id, rolledBack: false }, { $set: { rolledBack: true } });
      if (!claimed) { await finish({ status: 'completed', amount: 0, note: 'original bet already reversed' }); return okReply(res, tx, userId, { note: 'already_reversed' }); }
      const refundC = cents(orig.amount);
      const r = await walletOnce(reference, () => walletService.credit(userId, 'main', money(refundC), 'casino_refund', reference, { provider: 'juanai', gameId: orig.gameId, session: session.sessionId, tx: txId, original: refTx }));
      amount = money(refundC);
      await finish({ amount: money(refundC), note: amtC && amtC !== refundC ? `payload amount ${money(amtC)} ignored; refunded original ${money(refundC)}` : undefined });
      await Transaction.create({ userId, type: 'casino_refund', amount: money(refundC), balance: (r.result && r.result.main) || 0, reference, description: `${orig.gameId || 'Casino'} bet reversed (tx ${refTx})` }).catch(e => console.error('[juanai] tx log failed', e.message));
    }
    const bal = await balanceOf(userId);
    await finish({ status: 'completed', balanceAfter: bal });
    console.log(`[juanai/${type}] user=${userId} tx=${txId} ${currency} ${money(type === 'debit' ? amtC : cents(tx.amount))} -> balance ${bal}`);
    return res.json({ success: true, status: 'OK', transactionId: txId, balance: bal, newBalance: bal, currency });
  } catch (e) {
    console.error(`[juanai/${type}] error tx=${txId}:`, e.message);
    // leave the row 'processing': a provider retry will take it over (wallet step is reference-guarded, so money cannot move twice)
    return fail(res, 500, 'ERROR', 'Could not process the transaction, please retry');
  }
}

router.all('/wallet/balance', verified, async (req, res) => {
  try {
    if (!['GET', 'POST'].includes(req.method)) return res.status(405).end();
    const who = await resolvePlayer(merge(req));
    if (who.error) return fail(res, 400, who.error[0], who.error[1]);
    if (who.session.mode === 'demo') return fail(res, 400, 'DEMO_SESSION', 'Demo sessions do not use the wallet');
    const bal = await balanceOf(who.userId);
    res.json({ success: true, status: 'OK', playerId: String(who.userId), balance: bal, newBalance: bal, currency: who.session.currency });
  } catch (e) { return safeError(res, e, 'juanai/wallet/balance', 500, 'Could not load balance'); }
});
for (const t of ['debit', 'credit', 'rollback', 'refund']) {
  router.post(`/wallet/${t}`, verified, async (req, res) => {
    try { return await handleMoney(t, req, res); }
    catch (e) { return safeError(res, e, `juanai/wallet/${t}`, 500, 'Could not process the transaction'); }
  });
}

module.exports = router;
