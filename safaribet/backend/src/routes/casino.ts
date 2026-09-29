import { Router } from "express";
import { z } from "zod";
import mongoose, { Types } from "mongoose";
import { CasinoProvider, CasinoGame, CasinoGameSession, CasinoBet } from "../models/Casino";
import { LedgerEntry } from "../models/Wallet";
import { AuditLog } from "../models/Log";
import { getOrCreateWallet, writeLedgerEntry, InsufficientFundsError } from "../lib/wallet";
import { buildLaunchUrl, verifyWebhookSignature } from "../lib/spribe";
import { requireAuth, AuthedRequest } from "../middleware/requireAuth";

const router = Router();

// ------------------------------------------------------------------
// GET /api/casino/games — list active games for the lobby
// ------------------------------------------------------------------
router.get("/games", async (_req, res) => {
  const games = await CasinoGame.find({ isActive: true }).populate("providerId").lean();
  return res.json({ games });
});

// ------------------------------------------------------------------
// POST /api/casino/launch — generate a launch URL for a game
// ------------------------------------------------------------------
const launchSchema = z.object({
  gameId: z.string(),
});

router.post("/launch", requireAuth, async (req: AuthedRequest, res) => {
  const parsed = launchSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: "Invalid input" });
  }

  const game = await CasinoGame.findById(parsed.data.gameId);
  if (!game || !game.isActive) {
    return res.status(404).json({ error: "Game not found" });
  }

  const userId = req.user!.userId;

  try {
    const session = await CasinoGameSession.create({
      userId,
      gameId: game._id,
    });

    const launchUrl = buildLaunchUrl({
      userId,
      gameId: game.externalGameId,
      currency: "KES",
      returnUrl: process.env.FRONTEND_ORIGIN
        ? `${process.env.FRONTEND_ORIGIN}/casino`
        : "http://localhost:3000/casino",
    });

    await AuditLog.create({ userId, action: "CASINO_GAME_LAUNCHED", metadata: { gameId: game._id } });

    return res.json({ launchUrl, sessionId: session._id });
  } catch (err) {
    console.error(err);
    return res.status(503).json({
      error: "Casino provider is not configured yet. Set SPRIBE_* env vars to enable game launches.",
    });
  }
});

// ------------------------------------------------------------------
// POST /api/casino/webhooks/spribe — provider callback for bet/win/rollback
//
// This is the critical money-safety endpoint: Spribe calls this whenever a
// player places a bet or wins inside their game client, and expects
// SafariBet to debit/credit the wallet and confirm the new balance.
//
// TODO before going live:
// - confirm the exact request/response JSON shape from Spribe's docs
//   (this assumes { operation, user_id, amount, currency, round_id, provider_tx_id })
// - confirm what Spribe expects back on success/failure (this assumes
//   { balance, transaction_id } — verify exact field names)
// - confirm the signature header name (this assumes "x-spribe-signature")
//
// Idempotency: Spribe (like most aggregators) will retry webhooks on
// timeout/network failure. We key on provider_tx_id to guarantee the same
// transaction is never applied twice, even if this endpoint is called
// multiple times with identical data.
// ------------------------------------------------------------------
router.post("/webhooks/spribe", async (req, res) => {
  const signature = req.headers["x-spribe-signature"] as string | undefined; // TODO: confirm header name
  const rawBody = JSON.stringify(req.body);

  if (!verifyWebhookSignature(rawBody, signature || "")) {
    return res.status(401).json({ error: "Invalid signature" });
  }

  const schema = z.object({
    operation: z.enum(["bet", "win", "rollback"]),
    user_id: z.string(),
    amount: z.number(), // TODO: confirm units — assumed whole currency units, converted to cents below
    currency: z.string(),
    round_id: z.string(),
    provider_tx_id: z.string(), // unique per Spribe transaction — used for idempotency
    game_external_id: z.string().optional(),
  });

  const parsed = schema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: "Invalid payload", details: parsed.error.flatten() });
  }
  const { operation, user_id, amount, round_id, provider_tx_id, game_external_id } = parsed.data;
  const amountCents = Math.round(amount * 100);

  // Idempotency check: if we've already processed this exact provider transaction, return the same result.
  const existingEntry = await LedgerEntry.findOne({
    referenceId: provider_tx_id,
    referenceType: "CasinoBet",
  });
  if (existingEntry) {
    const wallet = await getOrCreateWallet(user_id, "MAIN");
    const balance = await LedgerEntry.aggregate([
      { $match: { walletId: wallet._id } },
      { $group: { _id: null, total: { $sum: "$amountCents" } } },
    ]);
    return res.json({ balance: (balance[0]?.total ?? 0) / 100, transaction_id: provider_tx_id });
  }

  const wallet = await getOrCreateWallet(user_id, "MAIN");

  let game = game_external_id
    ? await CasinoGame.findOne({ externalGameId: game_external_id })
    : null;

  try {
    if (operation === "bet") {
      await writeLedgerEntry({
        walletId: wallet._id,
        type: "BET_PLACED",
        amountCents: -amountCents,
        referenceId: provider_tx_id,
        referenceType: "CasinoBet",
        description: `Spribe bet — round ${round_id}`,
      });

      if (game) {
        await CasinoBet.create({
          userId: user_id,
          gameId: game._id,
          providerRoundId: round_id,
          stakeCents: amountCents,
          status: "PENDING",
        });
      }
    } else if (operation === "win") {
      await writeLedgerEntry({
        walletId: wallet._id,
        type: "BET_WON",
        amountCents,
        referenceId: provider_tx_id,
        referenceType: "CasinoBet",
        description: `Spribe win — round ${round_id}`,
      });

      await CasinoBet.updateMany(
        { userId: user_id, providerRoundId: round_id, status: "PENDING" },
        { status: "WON", winCents: amountCents, settledAt: new Date() }
      );
    } else if (operation === "rollback") {
      // Rollback reverses a previous bet debit — credit it back.
      await writeLedgerEntry({
        walletId: wallet._id,
        type: "BET_VOID_REFUND",
        amountCents,
        referenceId: provider_tx_id,
        referenceType: "CasinoBet",
        description: `Spribe rollback — round ${round_id}`,
      });

      await CasinoBet.updateMany(
        { userId: user_id, providerRoundId: round_id },
        { status: "VOID", settledAt: new Date() }
      );
    }

    const balanceAgg = await LedgerEntry.aggregate([
      { $match: { walletId: wallet._id } },
      { $group: { _id: null, total: { $sum: "$amountCents" } } },
    ]);
    const balanceCents = balanceAgg[0]?.total ?? 0;

    await AuditLog.create({
      userId: user_id,
      action: "CASINO_WEBHOOK_PROCESSED",
      metadata: { operation, provider_tx_id, round_id, amountCents },
    });

    return res.json({ balance: balanceCents / 100, transaction_id: provider_tx_id });
  } catch (err) {
    if (err instanceof InsufficientFundsError) {
      // TODO: confirm Spribe's expected error response shape for declined bets
      return res.status(400).json({ error: "INSUFFICIENT_FUNDS" });
    }
    console.error(err);
    return res.status(500).json({ error: "Internal error processing callback" });
  }
});

export default router;
