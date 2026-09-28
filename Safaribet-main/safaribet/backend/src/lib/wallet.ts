import mongoose, { Types } from "mongoose";
import { Wallet, LedgerEntry } from "../models/Wallet";

export class InsufficientFundsError extends Error {
  constructor() {
    super("Insufficient wallet balance");
    this.name = "InsufficientFundsError";
  }
}

export type WalletType = "MAIN" | "BONUS" | "CASHBACK";
export type LedgerEntryType =
  | "DEPOSIT"
  | "WITHDRAWAL"
  | "BET_PLACED"
  | "BET_WON"
  | "BET_LOST"
  | "BET_VOID_REFUND"
  | "BONUS_CREDIT"
  | "BONUS_EXPIRED"
  | "CASHBACK_CREDIT"
  | "ADMIN_ADJUSTMENT"
  | "REFERRAL_REWARD";

/**
 * Returns the current balance for a wallet, derived from the ledger (in cents).
 * balanceAfterCents on each entry is a fast-read snapshot, but the source of
 * truth is always the sum of ledger entries.
 */
export async function getWalletBalanceCents(walletId: Types.ObjectId | string): Promise<number> {
  const result = await LedgerEntry.aggregate([
    { $match: { walletId: new Types.ObjectId(walletId) } },
    { $group: { _id: null, total: { $sum: "$amountCents" } } },
  ]);
  return result[0]?.total ?? 0;
}

export async function getOrCreateWallet(userId: Types.ObjectId | string, type: WalletType, currency = "KES") {
  const existing = await Wallet.findOne({ userId, type, currency });
  if (existing) return existing;
  return Wallet.create({ userId, type, currency });
}

interface LedgerWriteParams {
  walletId: Types.ObjectId | string;
  type: LedgerEntryType;
  amountCents: number; // positive=credit, negative=debit, integer
  referenceId?: string;
  referenceType?: string;
  description?: string;
}

/**
 * Writes a ledger entry inside a Mongo transaction (requires a replica set,
 * even a single-node one) to prevent race conditions such as concurrent bets
 * overdrawing the same wallet. Throws InsufficientFundsError if a debit would
 * take the balance below zero.
 */
export async function writeLedgerEntry(params: LedgerWriteParams) {
  const session = await mongoose.startSession();
  try {
    let created;
    await session.withTransaction(async () => {
      const walletId = new Types.ObjectId(params.walletId);

      const agg = await LedgerEntry.aggregate(
        [
          { $match: { walletId } },
          { $group: { _id: null, total: { $sum: "$amountCents" } } },
        ],
        { session }
      );
      const currentBalance = agg[0]?.total ?? 0;
      const newBalance = currentBalance + params.amountCents;

      if (newBalance < 0) {
        throw new InsufficientFundsError();
      }

      const docs = await LedgerEntry.create(
        [
          {
            walletId,
            type: params.type,
            amountCents: params.amountCents,
            balanceAfterCents: newBalance,
            referenceId: params.referenceId ?? null,
            referenceType: params.referenceType ?? null,
            description: params.description ?? null,
          },
        ],
        { session }
      );
      created = docs[0];
    });
    return created;
  } finally {
    await session.endSession();
  }
}
