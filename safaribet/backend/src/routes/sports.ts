import { Router } from "express";
import { z } from "zod";
import mongoose, { Types } from "mongoose";
import { SportsEvent, SportsMarket, SportsBet } from "../models/Sports";
import { AuditLog } from "../models/Log";
import { getOrCreateWallet, writeLedgerEntry, InsufficientFundsError } from "../lib/wallet";
import { recalculateVipLevel } from "../lib/vip";
import { pushBetSettled } from "../lib/websocket";
import { LedgerEntry } from "../models/Wallet";
import { requireAuth, AuthedRequest } from "../middleware/requireAuth";
import { requireAdmin } from "../middleware/requireAdmin";

const router = Router();

// ------------------------------------------------------------------
// GET /api/sports/events — list upcoming events with their markets
// ------------------------------------------------------------------
router.get("/events", async (_req, res) => {
  const events = await SportsEvent.find({
    status: "SCHEDULED",
    startTime: { $gt: new Date() },
  })
    .sort({ startTime: 1 })
    .limit(50)
    .lean();

  const eventIds = events.map((e) => e._id);
  const markets = await SportsMarket.find({ eventId: { $in: eventIds }, isActive: true }).lean();

  const marketsByEvent = new Map<string, typeof markets>();
  for (const m of markets) {
    const key = m.eventId.toString();
    if (!marketsByEvent.has(key)) marketsByEvent.set(key, []);
    marketsByEvent.get(key)!.push(m);
  }

  const eventsWithMarkets = events.map((e) => ({
    ...e,
    markets: marketsByEvent.get(e._id.toString()) ?? [],
  }));

  return res.json({ events: eventsWithMarkets });
});

const placeBetSchema = z.object({
  eventId: z.string(),
  marketType: z.string().min(1),
  selection: z.string().min(1),
  odds: z.number().positive(),
  stake: z.number().positive().max(1_000_000), // whole KES, converted to cents below
});

// ------------------------------------------------------------------
// POST /api/sports/bets — place a bet
// ------------------------------------------------------------------
router.post("/bets", requireAuth, async (req: AuthedRequest, res) => {
  const parsed = placeBetSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: "Invalid input", details: parsed.error.flatten() });
  }
  const { eventId, marketType, selection, odds, stake } = parsed.data;
  const userId = req.user!.userId;

  const event = await SportsEvent.findById(eventId);
  if (!event) {
    return res.status(404).json({ error: "Event not found" });
  }
  if (event.status !== "SCHEDULED") {
    return res.status(400).json({ error: "Betting is closed for this event" });
  }

  const wallet = await getOrCreateWallet(userId, "MAIN");
  const stakeCents = Math.round(stake * 100);
  const potentialWinCents = Math.round(stakeCents * odds);

  const session = await mongoose.startSession();
  try {
    let bet;
    await session.withTransaction(async () => {
      const walletId = new Types.ObjectId(wallet._id);

      const agg = await LedgerEntry.aggregate(
        [{ $match: { walletId } }, { $group: { _id: null, total: { $sum: "$amountCents" } } }],
        { session }
      );
      const currentBalance = agg[0]?.total ?? 0;
      if (currentBalance < stakeCents) {
        throw new InsufficientFundsError();
      }

      const createdBets = await SportsBet.create(
        [
          {
            userId,
            eventId,
            marketType,
            selection,
            odds,
            stakeCents,
            potentialWinCents,
            status: "PENDING",
          },
        ],
        { session }
      );
      bet = createdBets[0];

      const newBalance = currentBalance - stakeCents;
      await LedgerEntry.create(
        [
          {
            walletId,
            type: "BET_PLACED",
            amountCents: -stakeCents,
            balanceAfterCents: newBalance,
            referenceId: bet._id.toString(),
            referenceType: "SportsBet",
            description: `${event.homeTeam} vs ${event.awayTeam} — ${marketType}: ${selection}`,
          },
        ],
        { session }
      );
    });

    await AuditLog.create({
      userId,
      action: "SPORTS_BET_PLACED",
      metadata: { betId: bet!._id, stake, odds },
    });

    return res.status(201).json({ bet });
  } catch (err) {
    if (err instanceof InsufficientFundsError) {
      return res.status(400).json({ error: "Insufficient balance" });
    }
    console.error(err);
    return res.status(500).json({ error: "Could not place bet" });
  } finally {
    await session.endSession();
  }
});

// ------------------------------------------------------------------
// GET /api/sports/bets — list the current user's bets
// ------------------------------------------------------------------
router.get("/bets", requireAuth, async (req: AuthedRequest, res) => {
  const userId = req.user!.userId;
  const bets = await SportsBet.find({ userId })
    .populate("eventId")
    .sort({ createdAt: -1 })
    .limit(50);
  return res.json({ bets });
});

// ------------------------------------------------------------------
// POST /api/sports/bets/:id/settle — settle a single bet (admin/internal use)
// In production this should be gated behind an admin-role check and/or
// triggered by an automated results-feed worker, not exposed publicly as-is.
// ------------------------------------------------------------------
const settleSchema = z.object({
  outcome: z.enum(["WON", "LOST", "VOID"]),
});

router.post("/bets/:id/settle", requireAuth, requireAdmin, async (req: AuthedRequest, res) => {
  const parsed = settleSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: "Invalid input" });
  }
  const { outcome } = parsed.data;
  const { id } = req.params;

  const bet = await SportsBet.findById(id);
  if (!bet) {
    return res.status(404).json({ error: "Bet not found" });
  }
  if (bet.status !== "PENDING") {
    return res.status(400).json({ error: "Bet already settled" });
  }

  const wallet = await getOrCreateWallet(bet.userId.toString(), "MAIN");

  try {
    if (outcome === "WON") {
      await writeLedgerEntry({
        walletId: wallet._id,
        type: "BET_WON",
        amountCents: bet.potentialWinCents,
        referenceId: bet._id.toString(),
        referenceType: "SportsBet",
        description: "Bet won — payout credited",
      });
    } else if (outcome === "VOID") {
      await writeLedgerEntry({
        walletId: wallet._id,
        type: "BET_VOID_REFUND",
        amountCents: bet.stakeCents,
        referenceId: bet._id.toString(),
        referenceType: "SportsBet",
        description: "Bet voided — stake refunded",
      });
    }
    // LOST: no ledger entry needed, stake was already debited at placement time.

    bet.status = outcome;
    bet.settledAt = new Date();
    await bet.save();

    await recalculateVipLevel(bet.userId.toString());
    pushBetSettled(bet.userId.toString(), bet);

    await AuditLog.create({
      userId: bet.userId,
      action: "SPORTS_BET_SETTLED",
      metadata: { betId: id, outcome },
    });

    return res.json({ bet });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: "Could not settle bet" });
  }
});

export default router;
