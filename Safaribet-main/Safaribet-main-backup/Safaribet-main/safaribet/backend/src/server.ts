import "dotenv/config";
import express from "express";
import helmet from "helmet";
import cors from "cors";
import cookieParser from "cookie-parser";
import rateLimit from "express-rate-limit";

import { connectDB } from "./lib/db";
import { initWebSocketServer } from "./lib/websocket";
import authRoutes from "./routes/auth";
import walletRoutes from "./routes/wallet";
import sportsRoutes from "./routes/sports";
import casinoRoutes from "./routes/casino";
import paymentsRoutes from "./routes/payments";
import bonusesRoutes from "./routes/bonuses";
import adminRoutes from "./routes/admin";
import notificationsRoutes from "./routes/notifications";

const app = express();
const PORT = process.env.PORT || 4000;
const FRONTEND_ORIGIN = process.env.FRONTEND_ORIGIN || "http://localhost:3000";

app.set("trust proxy", 1);

app.use(helmet());
app.use(
  cors({
    origin: FRONTEND_ORIGIN,
    credentials: true,
  })
);
app.use(express.json({ limit: "1mb" }));
app.use(cookieParser());

// Global rate limit — tighter limits should be added per-route (esp. /auth/login) in production
const globalLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 300,
  standardHeaders: true,
  legacyHeaders: false,
});
app.use(globalLimiter);

const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 20,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Too many attempts, please try again later" },
});

app.get("/health", (_req, res) => res.json({ status: "ok", time: new Date().toISOString() }));

app.use("/api/auth", authLimiter, authRoutes);
app.use("/api/wallet", walletRoutes);
app.use("/api/sports", sportsRoutes);
app.use("/api/casino", casinoRoutes);
app.use("/api/payments", paymentsRoutes);
app.use("/api/bonuses", bonusesRoutes);
app.use("/api/admin", adminRoutes);
app.use("/api/notifications", notificationsRoutes);

// 404 handler
app.use((_req, res) => res.status(404).json({ error: "Not found" }));

// Central error handler — never leak stack traces to the client
app.use((err: Error, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
  console.error(err);
  res.status(500).json({ error: "Internal server error" });
});

async function start() {
  try {
    await connectDB();
    const server = app.listen(PORT, () => {
      console.log(`SafariBet backend running on http://localhost:${PORT}`);
    });
    initWebSocketServer(server);
    console.log(`WebSocket server ready at ws://localhost:${PORT}/ws`);
  } catch (err) {
    console.error("Failed to start server:", err);
    process.exit(1);
  }
}

start();
