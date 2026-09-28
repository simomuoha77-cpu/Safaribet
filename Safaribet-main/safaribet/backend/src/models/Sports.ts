import { Schema, model, Types } from "mongoose";

const sportsEventSchema = new Schema(
  {
    externalId: { type: String, required: true, unique: true },
    sport: { type: String, required: true, index: true },
    league: { type: String, required: true },
    homeTeam: { type: String, required: true },
    awayTeam: { type: String, required: true },
    startTime: { type: Date, required: true, index: true },
    status: { type: String, default: "SCHEDULED" },
  },
  { timestamps: true }
);

export const SportsEvent = model("SportsEvent", sportsEventSchema);

const sportsMarketSchema = new Schema(
  {
    eventId: { type: Types.ObjectId, ref: "SportsEvent", required: true, index: true },
    marketType: { type: String, required: true },
    selection: { type: String, required: true },
    odds: { type: Number, required: true },
    isActive: { type: Boolean, default: true },
  },
  { timestamps: { createdAt: false, updatedAt: true } }
);

sportsMarketSchema.index({ eventId: 1, marketType: 1, selection: 1 }, { unique: true });

export const SportsMarket = model("SportsMarket", sportsMarketSchema);

const sportsBetSchema = new Schema(
  {
    userId: { type: Types.ObjectId, ref: "User", required: true, index: true },
    eventId: { type: Types.ObjectId, ref: "SportsEvent", required: true, index: true },
    marketType: { type: String, required: true },
    selection: { type: String, required: true },
    odds: { type: Number, required: true },
    stakeCents: { type: Number, required: true },
    potentialWinCents: { type: Number, required: true },
    status: {
      type: String,
      enum: ["PENDING", "WON", "LOST", "VOID", "CASHED_OUT"],
      default: "PENDING",
      index: true,
    },
    isAccumulator: { type: Boolean, default: false },
    settledAt: { type: Date, default: null },
  },
  { timestamps: { createdAt: true, updatedAt: false } }
);

export const SportsBet = model("SportsBet", sportsBetSchema);
