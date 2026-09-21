import { Schema, model, Types } from "mongoose";

const casinoProviderSchema = new Schema(
  {
    name: { type: String, required: true, unique: true },
    baseUrl: { type: String, required: true },
    apiKeyRef: { type: String, required: true }, // name of the env var holding the real secret, never the secret itself
    isActive: { type: Boolean, default: true },
  },
  { timestamps: { createdAt: true, updatedAt: false } }
);

export const CasinoProvider = model("CasinoProvider", casinoProviderSchema);

const casinoGameSchema = new Schema(
  {
    providerId: { type: Types.ObjectId, ref: "CasinoProvider", required: true, index: true },
    externalGameId: { type: String, required: true },
    name: { type: String, required: true },
    category: { type: String, required: true, index: true }, // SLOTS, LIVE, CRASH, TABLE, etc.
    thumbnailUrl: { type: String, default: null },
    isActive: { type: Boolean, default: true },
  },
  { timestamps: { createdAt: true, updatedAt: false } }
);

casinoGameSchema.index({ providerId: 1, externalGameId: 1 }, { unique: true });

export const CasinoGame = model("CasinoGame", casinoGameSchema);

const casinoGameSessionSchema = new Schema(
  {
    userId: { type: Types.ObjectId, ref: "User", required: true, index: true },
    gameId: { type: Types.ObjectId, ref: "CasinoGame", required: true, index: true },
    providerSessionToken: { type: String, default: null },
    endedAt: { type: Date, default: null },
  },
  { timestamps: { createdAt: true, updatedAt: false } }
);

export const CasinoGameSession = model("CasinoGameSession", casinoGameSessionSchema);

const casinoBetSchema = new Schema(
  {
    userId: { type: Types.ObjectId, ref: "User", required: true, index: true },
    gameId: { type: Types.ObjectId, ref: "CasinoGame", required: true, index: true },
    providerRoundId: { type: String, default: null },
    stakeCents: { type: Number, required: true },
    winCents: { type: Number, default: 0 },
    status: {
      type: String,
      enum: ["PENDING", "WON", "LOST", "VOID", "CASHED_OUT"],
      default: "PENDING",
    },
    settledAt: { type: Date, default: null },
  },
  { timestamps: { createdAt: true, updatedAt: false } }
);

export const CasinoBet = model("CasinoBet", casinoBetSchema);
