import { Response, NextFunction } from "express";
import { User } from "../models/User";
import { AuthedRequest } from "./requireAuth";

/**
 * Must run after requireAuth. Confirms the authenticated user has role "ADMIN".
 * Looks the user up fresh on every request rather than trusting a role claim
 * baked into the JWT, so a demotion takes effect immediately rather than
 * waiting for the access token to expire.
 */
export async function requireAdmin(req: AuthedRequest, res: Response, next: NextFunction) {
  if (!req.user) {
    return res.status(401).json({ error: "Authentication required" });
  }

  const user = await User.findById(req.user.userId).select("role status");
  if (!user || user.role !== "ADMIN") {
    return res.status(403).json({ error: "Admin access required" });
  }
  if (user.status !== "ACTIVE") {
    return res.status(403).json({ error: "Account is not active" });
  }

  next();
}
