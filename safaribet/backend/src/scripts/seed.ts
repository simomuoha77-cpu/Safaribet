/**
 * Seeds a handful of sports events + markets so you can test the betting
 * flow end-to-end before a real odds provider is connected.
 *
 * These are manually entered fixtures, not live data. Once an odds provider
 * is wired in, this script should stop being used — SportsEvent.externalId
 * is designed to map to a real provider's event IDs at that point.
 *
 * Run with: npm run seed
 */
import "dotenv/config";
import { connectDB } from "../lib/db";
import { SportsEvent, SportsMarket } from "../models/Sports";
import { CasinoProvider, CasinoGame } from "../models/Casino";
import { VipTier } from "../models/Vip";
import { PromoCode } from "../models/Bonus";
import mongoose from "mongoose";

async function main() {
  await connectDB();

  const events = [
    {
      externalId: "manual-001",
      sport: "Football",
      league: "Kenyan Premier League",
      homeTeam: "Gor Mahia",
      awayTeam: "AFC Leopards",
      startTime: new Date(Date.now() + 1000 * 60 * 60 * 24),
      markets: [
        { marketType: "MATCH_WINNER", selection: "Home", odds: 2.1 },
        { marketType: "MATCH_WINNER", selection: "Draw", odds: 3.2 },
        { marketType: "MATCH_WINNER", selection: "Away", odds: 3.6 },
        { marketType: "OVER_UNDER", selection: "Over 2.5", odds: 1.9 },
        { marketType: "OVER_UNDER", selection: "Under 2.5", odds: 1.85 },
      ],
    },
    {
      externalId: "manual-002",
      sport: "Basketball",
      league: "NBA",
      homeTeam: "Lakers",
      awayTeam: "Celtics",
      startTime: new Date(Date.now() + 1000 * 60 * 60 * 48),
      markets: [
        { marketType: "MATCH_WINNER", selection: "Home", odds: 1.75 },
        { marketType: "MATCH_WINNER", selection: "Away", odds: 2.05 },
      ],
    },
  ];

  for (const e of events) {
    const event = await SportsEvent.findOneAndUpdate(
      { externalId: e.externalId },
      {
        externalId: e.externalId,
        sport: e.sport,
        league: e.league,
        homeTeam: e.homeTeam,
        awayTeam: e.awayTeam,
        startTime: e.startTime,
        status: "SCHEDULED",
      },
      { upsert: true, new: true }
    );

    for (const m of e.markets) {
      await SportsMarket.findOneAndUpdate(
        { eventId: event._id, marketType: m.marketType, selection: m.selection },
        { odds: m.odds },
        { upsert: true }
      );
    }

    console.log(`Seeded: ${e.homeTeam} vs ${e.awayTeam}`);
  }

  // Seed the Spribe provider + a couple of its known games so the casino
  // lobby has real entries to test the launch flow against. externalGameId
  // values here are common Spribe slugs (e.g. "aviator") but should be
  // confirmed against your actual Spribe game catalog before going live.
  const spribe = await CasinoProvider.findOneAndUpdate(
    { name: "Spribe" },
    {
      name: "Spribe",
      baseUrl: process.env.SPRIBE_LAUNCH_BASE_URL || "https://TODO-confirm-spribe-base-url",
      apiKeyRef: "SPRIBE_OPERATOR_KEY",
      isActive: true,
    },
    { upsert: true, new: true }
  );

  const spribeGames = [
    { externalGameId: "aviator", name: "Aviator", category: "CRASH" },
    { externalGameId: "mines", name: "Mines", category: "INSTANT" },
    { externalGameId: "dice", name: "Dice", category: "INSTANT" },
    { externalGameId: "hilo", name: "HiLo", category: "INSTANT" },
    { externalGameId: "plinko", name: "Plinko", category: "INSTANT" },
  ];

  for (const g of spribeGames) {
    await CasinoGame.findOneAndUpdate(
      { providerId: spribe._id, externalGameId: g.externalGameId },
      { name: g.name, category: g.category, isActive: true },
      { upsert: true }
    );
  }
  console.log(`Seeded Spribe provider with ${spribeGames.length} games`);

  // VIP tiers — thresholds are a starting business assumption, adjust freely.
  const tiers = [
    { level: 0, name: "Member", minLifetimeWageredCents: 0, cashbackPercent: 0, withdrawalLimitCents: 5_000_00, perks: [] },
    { level: 1, name: "Bronze", minLifetimeWageredCents: 10_000_00, cashbackPercent: 2, withdrawalLimitCents: 10_000_00, perks: ["2% cashback"] },
    { level: 2, name: "Silver", minLifetimeWageredCents: 50_000_00, cashbackPercent: 5, withdrawalLimitCents: 25_000_00, perks: ["5% cashback", "Priority support"] },
    { level: 3, name: "Gold", minLifetimeWageredCents: 200_000_00, cashbackPercent: 8, withdrawalLimitCents: 100_000_00, perks: ["8% cashback", "Priority support", "Higher limits"] },
    { level: 4, name: "Platinum", minLifetimeWageredCents: 1_000_000_00, cashbackPercent: 12, withdrawalLimitCents: 500_000_00, perks: ["12% cashback", "Dedicated account manager", "Highest limits"] },
  ];
  for (const t of tiers) {
    await VipTier.findOneAndUpdate({ level: t.level }, t, { upsert: true });
  }
  console.log(`Seeded ${tiers.length} VIP tiers`);

  // A test promo code for exercising the bonus redemption flow.
  const promoExpiry = new Date();
  promoExpiry.setDate(promoExpiry.getDate() + 90);
  await PromoCode.findOneAndUpdate(
    { code: "WELCOME100" },
    {
      code: "WELCOME100",
      bonusType: "WELCOME",
      amountCents: 100_00, // KES 100
      wageringMultiplier: 3,
      maxRedemptions: null,
      expiresAt: promoExpiry,
      isActive: true,
    },
    { upsert: true }
  );
  console.log("Seeded promo code: WELCOME100");

  await mongoose.disconnect();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
