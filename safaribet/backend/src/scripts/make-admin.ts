/**
 * Promotes a user to ADMIN role by email. Admin accounts should never be
 * created through the public registration endpoint — this script (or an
 * equivalent internal-only tool) is the intended path.
 *
 * Run with: npx tsx src/scripts/make-admin.ts you@example.com
 */
import "dotenv/config";
import { connectDB } from "../lib/db";
import { User } from "../models/User";
import mongoose from "mongoose";

async function main() {
  const email = process.argv[2];
  if (!email) {
    console.error("Usage: npx tsx src/scripts/make-admin.ts <email>");
    process.exit(1);
  }

  await connectDB();

  const user = await User.findOneAndUpdate({ email }, { role: "ADMIN" }, { new: true });
  if (!user) {
    console.error(`No user found with email ${email}`);
    process.exit(1);
  }

  console.log(`${user.email} is now an ADMIN`);
  await mongoose.disconnect();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
