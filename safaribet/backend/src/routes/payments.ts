import { Router } from "express";
import { z } from "zod";
import { Deposit, Withdrawal } from "../models/Payment";
import { AuditLog } from "../models/Log";
import { getOrCreateWallet, writeLedgerEntry } from "../lib/wallet";
import {
  initiateStkPush,
  initiateB2CPayout,
  stkCallbackSchema,
  extractCallbackMetadata,
} from "../lib/mpesa";
import { requireAuth, AuthedRequest } from "../middleware/requireAuth";
import { pushBalanceUpdate } from "../lib/websocket";

const router = Router();

// ------------------------------------------------------------------
// POST /api/payments/deposit — initiate an M-Pesa STK Push deposit
// ------------------------------------------------------------------
const depositSchema = z.object({
  amount: z.number().positive().max(500_000),
  phoneNumber: z.string().regex(/^254\d{9}$/, "Phone must be in format 2547XXXXXXXX"),
});

router.post("/deposit", requireAuth, async (req: AuthedRequest, res) => {
  const parsed = depositSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: "Invalid input", details: parsed.error.flatten() });
  }
  const { amount, phoneNumber } = parsed.data;
  const userId = req.user!.userId;

  const deposit = await Deposit.create({
    userId,
    amountCents: Math.round(amount * 100),
    phoneNumber,
    status: "PENDING",
  });

  try {
    const stkResult = await initiateStkPush({
      phoneNumber,
      amount,
      accountReference: deposit._id.toString(),
      transactionDesc: "SafariBet deposit",
    });

    deposit.mpesaCheckoutId = stkResult.checkoutRequestId;
    await deposit.save();

    await AuditLog.create({ userId, action: "DEPOSIT_INITIATED", metadata: { depositId: deposit._id, amount } });

    return res.status(202).json({
      message: "STK push sent. Approve the prompt on your phone.",
      depositId: deposit._id,
    });
  } catch (err) {
    deposit.status = "FAILED";
    await deposit.save();
    console.error(err);
    return res.status(503).json({
      error: err instanceof Error ? err.message : "Could not initiate deposit",
    });
  }
});

// ------------------------------------------------------------------
// GET /api/payments/deposit/:id — poll deposit status
// ------------------------------------------------------------------
router.get("/deposit/:id", requireAuth, async (req: AuthedRequest, res) => {
  const deposit = await Deposit.findOne({ _id: req.params.id, userId: req.user!.userId });
  if (!deposit) {
    return res.status(404).json({ error: "Deposit not found" });
  }
  return res.json({ status: deposit.status, amount: deposit.amountCents / 100 });
});

// ------------------------------------------------------------------
// POST /api/payments/mpesa/callback — Safaricom's STK Push result callback
//
// Public, unauthenticated by necessity (Safaricom calls it directly, not
// through a user session). Trust boundary: we only credit a wallet for a
// CheckoutRequestID we ourselves created as PENDING — arbitrary POSTed data
// can't credit an account without a matching pending deposit to update.
//
// Idempotent: safe to call twice with the same CheckoutRequestID.
// ------------------------------------------------------------------
router.post("/mpesa/callback", async (req, res) => {
  const parsed = stkCallbackSchema.safeParse(req.body);
  if (!parsed.success) {
    console.error("Invalid M-Pesa callback payload", parsed.error.flatten());
    return res.status(200).json({ ResultCode: 0, ResultDesc: "Accepted" });
  }

  const { CheckoutRequestID, ResultCode } = parsed.data.Body.stkCallback;

  const deposit = await Deposit.findOne({ mpesaCheckoutId: CheckoutRequestID });
  if (!deposit) {
    console.error("No matching deposit for CheckoutRequestID", CheckoutRequestID);
    return res.status(200).json({ ResultCode: 0, ResultDesc: "Accepted" });
  }

  if (deposit.status !== "PENDING") {
    return res.status(200).json({ ResultCode: 0, ResultDesc: "Accepted" });
  }

  if (ResultCode !== 0) {
    deposit.status = "FAILED";
    deposit.rawCallback = req.body;
    await deposit.save();
    return res.status(200).json({ ResultCode: 0, ResultDesc: "Accepted" });
  }

  const meta = extractCallbackMetadata(parsed.data);

  const wallet = await getOrCreateWallet(deposit.userId.toString(), "MAIN");
  await writeLedgerEntry({
    walletId: wallet._id,
    type: "DEPOSIT",
    amountCents: deposit.amountCents,
    referenceId: deposit._id.toString(),
    referenceType: "Deposit",
    description: `M-Pesa deposit — receipt ${meta.mpesaReceiptNumber ?? "unknown"}`,
  });

  deposit.status = "SUCCESS";
  deposit.mpesaReceiptNo = meta.mpesaReceiptNumber ?? null;
  deposit.rawCallback = req.body;
  await deposit.save();

  await AuditLog.create({
    userId: deposit.userId,
    action: "DEPOSIT_COMPLETED",
    metadata: { depositId: deposit._id, receipt: meta.mpesaReceiptNumber },
  });

  pushBalanceUpdate(deposit.userId.toString(), { deposited: deposit.amountCents / 100 });

  return res.status(200).json({ ResultCode: 0, ResultDesc: "Accepted" });
});

// ------------------------------------------------------------------
// POST /api/payments/withdraw — request a withdrawal via M-Pesa B2C
// ------------------------------------------------------------------
const withdrawSchema = z.object({
  amount: z.number().positive().max(500_000),
  phoneNumber: z.string().regex(/^254\d{9}$/, "Phone must be in format 2547XXXXXXXX"),
});

router.post("/withdraw", requireAuth, async (req: AuthedRequest, res) => {
  const parsed = withdrawSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: "Invalid input" });
  }
  const { amount, phoneNumber } = parsed.data;
  const userId = req.user!.userId;
  const amountCents = Math.round(amount * 100);

  const wallet = await getOrCreateWallet(userId, "MAIN");

  // Reserve funds immediately (debit now) so the balance can't be withdrawn
  // twice while the B2C payout is in flight. Refund via credit if it fails.
  const withdrawal = await Withdrawal.create({
    userId,
    amountCents,
    phoneNumber,
    status: "PENDING",
  });

  try {
    await writeLedgerEntry({
      walletId: wallet._id,
      type: "WITHDRAWAL",
      amountCents: -amountCents,
      referenceId: withdrawal._id.toString(),
      referenceType: "Withdrawal",
      description: "Withdrawal requested",
    });
  } catch (err) {
    withdrawal.status = "FAILED";
    await withdrawal.save();
    return res.status(400).json({ error: "Insufficient balance" });
  }

  try {
    const result = await initiateB2CPayout({
      phoneNumber,
      amount,
      remarks: `SafariBet withdrawal ${withdrawal._id}`,
    });
    withdrawal.mpesaConversationId = result.ConversationID;
    await withdrawal.save();

    await AuditLog.create({ userId, action: "WITHDRAWAL_INITIATED", metadata: { withdrawalId: withdrawal._id, amount } });

    return res.status(202).json({ message: "Withdrawal is being processed", withdrawalId: withdrawal._id });
  } catch (err) {
    await writeLedgerEntry({
      walletId: wallet._id,
      type: "BET_VOID_REFUND",
      amountCents,
      referenceId: withdrawal._id.toString(),
      referenceType: "Withdrawal",
      description: "Withdrawal failed to initiate — refunded",
    });
    withdrawal.status = "FAILED";
    await withdrawal.save();
    console.error(err);
    return res.status(503).json({
      error: err instanceof Error ? err.message : "Could not process withdrawal",
    });
  }
});

// ------------------------------------------------------------------
// POST /api/payments/mpesa/b2c-result — Safaricom's B2C payout result callback
// TODO: confirm exact payload shape against Daraja docs — this assumes the
// documented Result.ResultCode / Result.ConversationID shape.
// ------------------------------------------------------------------
router.post("/mpesa/b2c-result", async (req, res) => {
  const result = req.body?.Result;
  if (!result?.ConversationID) {
    return res.status(200).json({ ResultCode: 0, ResultDesc: "Accepted" });
  }

  const withdrawal = await Withdrawal.findOne({ mpesaConversationId: result.ConversationID });
  if (!withdrawal || withdrawal.status !== "PENDING") {
    return res.status(200).json({ ResultCode: 0, ResultDesc: "Accepted" });
  }

  withdrawal.rawCallback = req.body;

  if (result.ResultCode === 0) {
    withdrawal.status = "SUCCESS";
  } else {
    const wallet = await getOrCreateWallet(withdrawal.userId.toString(), "MAIN");
    await writeLedgerEntry({
      walletId: wallet._id,
      type: "BET_VOID_REFUND",
      amountCents: withdrawal.amountCents,
      referenceId: withdrawal._id.toString(),
      referenceType: "Withdrawal",
      description: "Withdrawal failed — refunded",
    });
    withdrawal.status = "FAILED";
  }

  await withdrawal.save();
  return res.status(200).json({ ResultCode: 0, ResultDesc: "Accepted" });
});

export default router;
