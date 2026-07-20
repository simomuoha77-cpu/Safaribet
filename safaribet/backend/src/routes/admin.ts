import { Router } from "express";
import { z } from "zod";
import { User } from "../models/User";
import { Deposit, Withdrawal } from "../models/Payment";
import { SportsBet } from "../models/Sports";
import { CasinoBet } from "../models/Casino";
import { AuditLog } from "../models/Log";
import { LedgerEntry, Wallet } from "../models/Wallet";
import { getOrCreateWallet, writeLedgerEntry } from "../lib/wallet";
import { requireAuth, AuthedRequest } from "../middleware/requireAuth";
import { requireAdmin } from "../middleware/requireAdmin";

const router = Router();

// Every route in this file requires both auth and admin role.
router.use(requireAuth, requireAdmin);

// ------------------------------------------------------------------
// GET /api/admin/dashboard — top-line platform stats
// ------------------------------------------------------------------
router.get("/dashboard", async (_req, res) => {
  const [userCount, pendingDeposits, pendingWithdrawals, pendingBets, totalDepositsAgg] =
    await Promise.all([
      User.countDocuments(),
      Deposit.countDocuments({ status: "PENDING" }),
      Withdrawal.countDocuments({ status: "PENDING" }),
      SportsBet.countDocuments({ status: "PENDING" }),
      Deposit.aggregate([
        { $match: { status: "SUCCESS" } },
        { $group: { _id: null, total: { $sum: "$amountCents" } } },
      ]),
    ]);

  return res.json({
    userCount,
    pendingDeposits,
    pendingWithdrawals,
    pendingBets,
    totalDepositedCents: totalDepositsAgg[0]?.total ?? 0,
  });
});

// ------------------------------------------------------------------
// GET /api/admin/users — list/search users
// ------------------------------------------------------------------
router.get("/users", async (req, res) => {
  const search = (req.query.search as string) || "";
  const filter = search
    ? { $or: [{ email: new RegExp(search, "i") }, { phone: new RegExp(search, "i") }, { fullName: new RegExp(search, "i") }] }
    : {};

  const users = await User.find(filter)
    .select("-passwordHash -twoFactorSecret")
    .sort({ createdAt: -1 })
    .limit(100);

  return res.json({ users });
});

// ------------------------------------------------------------------
// GET /api/admin/users/:id — user detail incl. wallet balances
// ------------------------------------------------------------------
router.get("/users/:id", async (req, res) => {
  const user = await User.findById(req.params.id).select("-passwordHash -twoFactorSecret");
  if (!user) return res.status(404).json({ error: "User not found" });

  const wallets = await Wallet.find({ userId: user._id });
  const balances = await Promise.all(
    wallets.map(async (w) => {
      const agg = await LedgerEntry.aggregate([
        { $match: { walletId: w._id } },
        { $group: { _id: null, total: { $sum: "$amountCents" } } },
      ]);
      return { type: w.type, balanceCents: agg[0]?.total ?? 0 };
    })
  );

  return res.json({ user, balances });
});

// ------------------------------------------------------------------
// PATCH /api/admin/users/:id/status — suspend/ban/reactivate a user
// ------------------------------------------------------------------
const statusSchema = z.object({
  status: z.enum(["ACTIVE", "SUSPENDED", "BANNED", "PENDING_VERIFICATION"]),
});

router.patch("/users/:id/status", async (req: AuthedRequest, res) => {
  const parsed = statusSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "Invalid input" });

  const user = await User.findById(req.params.id);
  if (!user) return res.status(404).json({ error: "User not found" });

  user.status = parsed.data.status;
  await user.save();

  await AuditLog.create({
    userId: req.user!.userId,
    action: "ADMIN_USER_STATUS_CHANGED",
    metadata: { targetUserId: user._id, newStatus: parsed.data.status },
  });

  return res.json({ user });
});

// ------------------------------------------------------------------
// POST /api/admin/users/:id/adjust-balance — manual wallet credit/debit
// ------------------------------------------------------------------
const adjustSchema = z.object({
  walletType: z.enum(["MAIN", "BONUS", "CASHBACK"]),
  amount: z.number(), // positive=credit, negative=debit, in whole KES
  reason: z.string().min(3),
});

router.post("/users/:id/adjust-balance", async (req: AuthedRequest, res) => {
  const parsed = adjustSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "Invalid input" });

  const targetUserId = req.params.id;
  const { walletType, amount, reason } = parsed.data;
  const amountCents = Math.round(amount * 100);

  const wallet = await getOrCreateWallet(targetUserId, walletType);

  try {
    const entry = await writeLedgerEntry({
      walletId: wallet._id,
      type: "ADMIN_ADJUSTMENT",
      amountCents,
      referenceType: "AdminAdjustment",
      description: reason,
    });

    await AuditLog.create({
      userId: req.user!.userId,
      action: "ADMIN_BALANCE_ADJUSTED",
      metadata: { targetUserId, walletType, amount, reason },
    });

    return res.status(201).json({ entry });
  } catch (err) {
    return res.status(400).json({ error: "Adjustment would result in a negative balance" });
  }
});

// ------------------------------------------------------------------
// GET /api/admin/deposits — list deposits, filterable by status
// ------------------------------------------------------------------
router.get("/deposits", async (req, res) => {
  const status = req.query.status as string | undefined;
  const filter = status ? { status } : {};
  const deposits = await Deposit.find(filter).sort({ createdAt: -1 }).limit(100).populate("userId", "fullName email phone");
  return res.json({ deposits });
});

// ------------------------------------------------------------------
// GET /api/admin/withdrawals — list withdrawals, filterable by status
// ------------------------------------------------------------------
router.get("/withdrawals", async (req, res) => {
  const status = req.query.status as string | undefined;
  const filter = status ? { status } : {};
  const withdrawals = await Withdrawal.find(filter).sort({ createdAt: -1 }).limit(100).populate("userId", "fullName email phone");
  return res.json({ withdrawals });
});

// ------------------------------------------------------------------
// GET /api/admin/bets — list sports + casino bets, filterable by status
// ------------------------------------------------------------------
router.get("/bets", async (req, res) => {
  const status = (req.query.status as string) || "PENDING";
  const [sportsBets, casinoBets] = await Promise.all([
    SportsBet.find({ status }).sort({ createdAt: -1 }).limit(50).populate("eventId").populate("userId", "fullName email"),
    CasinoBet.find({ status }).sort({ createdAt: -1 }).limit(50).populate("gameId").populate("userId", "fullName email"),
  ]);
  return res.json({ sportsBets, casinoBets });
});

// ------------------------------------------------------------------
// GET /api/admin/audit-logs — recent platform audit trail
// ------------------------------------------------------------------
router.get("/audit-logs", async (req, res) => {
  const action = req.query.action as string | undefined;
  const filter = action ? { action } : {};
  const logs = await AuditLog.find(filter).sort({ createdAt: -1 }).limit(200).populate("userId", "fullName email");
  return res.json({ logs });
});

export default router;
