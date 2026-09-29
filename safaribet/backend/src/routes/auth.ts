import { Router } from "express";
import { z } from "zod";
import { User } from "../models/User";
import { Session, LoginHistory } from "../models/Session";
import { AuditLog } from "../models/Log";
import {
  hashPassword,
  verifyPassword,
  signAccessToken,
  generateRefreshToken,
  generateReferralCode,
} from "../lib/auth";
import { getOrCreateWallet } from "../lib/wallet";

const router = Router();

const registerSchema = z.object({
  email: z.string().email(),
  phone: z.string().min(10).max(15),
  password: z.string().min(8).max(128),
  fullName: z.string().min(2).max(100),
  referralCode: z.string().optional(),
});

router.post("/register", async (req, res) => {
  const parsed = registerSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: "Invalid input", details: parsed.error.flatten() });
  }
  const { email, phone, password, fullName, referralCode } = parsed.data;

  const existing = await User.findOne({ $or: [{ email }, { phone }] });
  if (existing) {
    return res.status(409).json({ error: "Email or phone already registered" });
  }

  let referredBy: string | undefined;
  if (referralCode) {
    const referrer = await User.findOne({ referralCode });
    if (referrer) referredBy = referrer._id.toString();
  }

  const passwordHash = await hashPassword(password);

  const user = await User.create({
    email,
    phone,
    fullName,
    passwordHash,
    referralCode: generateReferralCode(),
    referredBy,
  });

  // Every new user gets Main + Bonus + Cashback wallets provisioned immediately.
  await Promise.all([
    getOrCreateWallet(user._id, "MAIN"),
    getOrCreateWallet(user._id, "BONUS"),
    getOrCreateWallet(user._id, "CASHBACK"),
  ]);

  await AuditLog.create({ userId: user._id, action: "USER_REGISTERED", ipAddress: req.ip });

  return res.status(201).json({
    message: "Registration successful",
    userId: user._id,
  });
});

const loginSchema = z.object({
  emailOrPhone: z.string(),
  password: z.string(),
});

router.post("/login", async (req, res) => {
  const parsed = loginSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: "Invalid input" });
  }
  const { emailOrPhone, password } = parsed.data;

  const user = await User.findOne({ $or: [{ email: emailOrPhone }, { phone: emailOrPhone }] });

  const genericError = () => res.status(401).json({ error: "Invalid credentials" });

  if (!user) {
    return genericError(); // never reveal whether the account exists
  }

  const validPassword = await verifyPassword(user.passwordHash, password);

  await LoginHistory.create({
    userId: user._id,
    ipAddress: req.ip,
    userAgent: req.headers["user-agent"],
    success: validPassword,
  });

  if (!validPassword) {
    return genericError();
  }

  if (user.status !== "ACTIVE") {
    return res.status(403).json({ error: `Account is ${user.status.toLowerCase()}` });
  }

  const accessToken = signAccessToken({ userId: user._id.toString(), email: user.email });
  const { token: refreshToken, expiresAt } = generateRefreshToken();

  await Session.create({
    userId: user._id,
    refreshToken,
    expiresAt,
    ipAddress: req.ip,
    userAgent: req.headers["user-agent"],
  });

  res.cookie("refreshToken", refreshToken, {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "strict",
    maxAge: 30 * 24 * 60 * 60 * 1000,
  });

  return res.json({
    accessToken,
    user: {
      id: user._id,
      email: user.email,
      fullName: user.fullName,
      vipLevel: user.vipLevel,
    },
  });
});

router.post("/refresh", async (req, res) => {
  const refreshToken = req.cookies?.refreshToken;
  if (!refreshToken) {
    return res.status(401).json({ error: "No refresh token provided" });
  }

  const session = await Session.findOne({ refreshToken }).populate("userId");
  const user = session?.userId as any;

  if (!session || session.revokedAt || session.expiresAt < new Date() || !user) {
    return res.status(401).json({ error: "Invalid or expired session" });
  }

  const accessToken = signAccessToken({ userId: user._id.toString(), email: user.email });
  return res.json({ accessToken });
});

router.post("/logout", async (req, res) => {
  const refreshToken = req.cookies?.refreshToken;
  if (refreshToken) {
    await Session.updateMany({ refreshToken }, { revokedAt: new Date() });
  }
  res.clearCookie("refreshToken");
  return res.json({ message: "Logged out" });
});

export default router;
