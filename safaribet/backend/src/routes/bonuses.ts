import { Router } from "express";
import { z } from "zod";
import { User } from "../models/User";
import { BonusGrant, PromoCode } from "../models/Bonus";
import { VipTier } from "../models/Vip";
import { AuditLog } from "../models/Log";
import { getOrCreateWallet, writeLedgerEntry } from "../lib/wallet";
import { getLifetimeWageredCents } from "../lib/vip";
import { requireAuth, AuthedRequest } from "../middleware/requireAuth";

const router = Router();

const REFERRAL_REWARD_CENTS = 10_000; // KES 100 — configurable business rule
const REFERRAL_WAGERING_MULTIPLIER = 3;
const BONUS_EXPIRY_DAYS = 30;

// ------------------------------------------------------------------
// POST /api/bonuses/promo/redeem — redeem a promo code
// ------------------------------------------------------------------
const redeemSchema = z.object({ code: z.string().min(1) });

router.post("/promo/redeem", requireAuth, async (req: AuthedRequest, res) => {
  const parsed = redeemSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: "Invalid input" });
  }
  const userId = req.user!.userId;
  const code = parsed.data.code.toUpperCase();

  const promo = await PromoCode.findOne({ code, isActive: true });
  if (!promo) {
    return res.status(404).json({ error: "Invalid or expired promo code" });
  }
  if (promo.expiresAt < new Date()) {
    return res.status(400).json({ error: "This promo code has expired" });
  }
  if (promo.maxRedemptions !== null && promo.redemptionCount >= promo.maxRedemptions) {
    return res.status(400).json({ error: "This promo code has reached its redemption limit" });
  }

  const alreadyRedeemed = await BonusGrant.findOne({ userId, promoCode: code });
  if (alreadyRedeemed) {
    return res.status(400).json({ error: "You've already redeemed this code" });
  }

  const bonusWallet = await getOrCreateWallet(userId, "BONUS");
  const expiresAt = new Date();
  expiresAt.setDate(expiresAt.getDate() + BONUS_EXPIRY_DAYS);

  await writeLedgerEntry({
    walletId: bonusWallet._id,
    type: "BONUS_CREDIT",
    amountCents: promo.amountCents,
    referenceId: code,
    referenceType: "PromoCode",
    description: `Promo code ${code} redeemed`,
  });

  const grant = await BonusGrant.create({
    userId,
    type: promo.bonusType,
    amountCents: promo.amountCents,
    wageringRequirementCents: promo.amountCents * promo.wageringMultiplier,
    expiresAt,
    promoCode: code,
  });

  promo.redemptionCount += 1;
  await promo.save();

  await AuditLog.create({ userId, action: "PROMO_REDEEMED", metadata: { code, grantId: grant._id } });

  return res.status(201).json({ grant });
});

// ------------------------------------------------------------------
// GET /api/bonuses/mine — list the current user's bonus grants
// ------------------------------------------------------------------
router.get("/mine", requireAuth, async (req: AuthedRequest, res) => {
  const grants = await BonusGrant.find({ userId: req.user!.userId }).sort({ createdAt: -1 });
  return res.json({ grants });
});

// ------------------------------------------------------------------
// POST /api/bonuses/referral/claim — credit the referrer once a referred
// user completes their first deposit. Call this from the deposit-success
// path in a real system; exposed here as its own endpoint so it can be
// triggered explicitly during testing without a real M-Pesa deposit.
// ------------------------------------------------------------------
const referralClaimSchema = z.object({ referredUserId: z.string() });

router.post("/referral/claim", requireAuth, async (req: AuthedRequest, res) => {
  const parsed = referralClaimSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: "Invalid input" });
  }

  const referredUser = await User.findById(parsed.data.referredUserId);
  if (!referredUser || !referredUser.referredBy) {
    return res.status(404).json({ error: "No referral relationship found for this user" });
  }

  const existingClaim = await BonusGrant.findOne({
    userId: referredUser.referredBy,
    type: "REFERRAL",
    promoCode: `referral-${referredUser._id}`,
  });
  if (existingClaim) {
    return res.status(400).json({ error: "Referral reward already claimed for this user" });
  }

  const referrerId = referredUser.referredBy;
  const bonusWallet = await getOrCreateWallet(referrerId.toString(), "BONUS");
  const expiresAt = new Date();
  expiresAt.setDate(expiresAt.getDate() + BONUS_EXPIRY_DAYS);

  await writeLedgerEntry({
    walletId: bonusWallet._id,
    type: "REFERRAL_REWARD",
    amountCents: REFERRAL_REWARD_CENTS,
    referenceId: referredUser._id.toString(),
    referenceType: "Referral",
    description: `Referral reward — ${referredUser.fullName} joined`,
  });

  const grant = await BonusGrant.create({
    userId: referrerId,
    type: "REFERRAL",
    amountCents: REFERRAL_REWARD_CENTS,
    wageringRequirementCents: REFERRAL_REWARD_CENTS * REFERRAL_WAGERING_MULTIPLIER,
    expiresAt,
    promoCode: `referral-${referredUser._id}`,
  });

  await AuditLog.create({
    userId: referrerId,
    action: "REFERRAL_REWARD_GRANTED",
    metadata: { referredUserId: referredUser._id },
  });

  return res.status(201).json({ grant });
});

// ------------------------------------------------------------------
// GET /api/bonuses/referral/stats — referral code + count of referred users
// ------------------------------------------------------------------
router.get("/referral/stats", requireAuth, async (req: AuthedRequest, res) => {
  const user = await User.findById(req.user!.userId);
  if (!user) return res.status(404).json({ error: "User not found" });

  const referredCount = await User.countDocuments({ referredBy: user._id });

  return res.json({
    referralCode: user.referralCode,
    referredCount,
  });
});

// ------------------------------------------------------------------
// GET /api/vip/status — current VIP tier + progress to next tier
// ------------------------------------------------------------------
router.get("/vip/status", requireAuth, async (req: AuthedRequest, res) => {
  const userId = req.user!.userId;
  const user = await User.findById(userId);
  if (!user) return res.status(404).json({ error: "User not found" });

  const lifetimeWageredCents = await getLifetimeWageredCents(userId);
  const currentTier = await VipTier.findOne({ level: user.vipLevel });
  const nextTier = await VipTier.findOne({ level: { $gt: user.vipLevel } }).sort({ level: 1 });

  return res.json({
    currentLevel: user.vipLevel,
    currentTier,
    nextTier,
    lifetimeWagered: lifetimeWageredCents / 100,
    progressToNextTier: nextTier
      ? Math.min(100, (lifetimeWageredCents / nextTier.minLifetimeWageredCents) * 100)
      : 100,
  });
});

export default router;
