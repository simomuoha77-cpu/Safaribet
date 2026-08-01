import { Router } from "express";
import { Wallet, LedgerEntry } from "../models/Wallet";
import { getWalletBalanceCents, getOrCreateWallet } from "../lib/wallet";
import { requireAuth, AuthedRequest } from "../middleware/requireAuth";

const router = Router();

function centsToStr(cents: number): string {
  return (cents / 100).toFixed(2);
}

router.get("/balance", requireAuth, async (req: AuthedRequest, res) => {
  const userId = req.user!.userId;

  const [main, bonus, cashback] = await Promise.all([
    getOrCreateWallet(userId, "MAIN"),
    getOrCreateWallet(userId, "BONUS"),
    getOrCreateWallet(userId, "CASHBACK"),
  ]);

  const [mainBal, bonusBal, cashbackBal] = await Promise.all([
    getWalletBalanceCents(main._id),
    getWalletBalanceCents(bonus._id),
    getWalletBalanceCents(cashback._id),
  ]);

  return res.json({
    main: centsToStr(mainBal),
    bonus: centsToStr(bonusBal),
    cashback: centsToStr(cashbackBal),
    currency: "KES",
  });
});

router.get("/history", requireAuth, async (req: AuthedRequest, res) => {
  const userId = req.user!.userId;
  const wallets = await Wallet.find({ userId });
  const walletIds = wallets.map((w) => w._id);

  const entries = await LedgerEntry.find({ walletId: { $in: walletIds } })
    .sort({ createdAt: -1 })
    .limit(100);

  return res.json({ entries });
});

export default router;
