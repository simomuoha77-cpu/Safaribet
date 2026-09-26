import { Router } from "express";
import { Notification } from "../models/Log";
import { requireAuth, AuthedRequest } from "../middleware/requireAuth";

const router = Router();

// ------------------------------------------------------------------
// GET /api/notifications — list the current user's notifications
// ------------------------------------------------------------------
router.get("/", requireAuth, async (req: AuthedRequest, res) => {
  const notifications = await Notification.find({ userId: req.user!.userId })
    .sort({ createdAt: -1 })
    .limit(50);
  return res.json({ notifications });
});

// ------------------------------------------------------------------
// PATCH /api/notifications/:id/read — mark a notification as read
// ------------------------------------------------------------------
router.patch("/:id/read", requireAuth, async (req: AuthedRequest, res) => {
  const notification = await Notification.findOneAndUpdate(
    { _id: req.params.id, userId: req.user!.userId },
    { isRead: true },
    { new: true }
  );
  if (!notification) return res.status(404).json({ error: "Notification not found" });
  return res.json({ notification });
});

// ------------------------------------------------------------------
// PATCH /api/notifications/read-all — mark all as read
// ------------------------------------------------------------------
router.patch("/read-all", requireAuth, async (req: AuthedRequest, res) => {
  await Notification.updateMany({ userId: req.user!.userId, isRead: false }, { isRead: true });
  return res.json({ message: "All notifications marked as read" });
});

export default router;

/**
 * Helper for other route files to create a notification. This is in-app
 * only — it writes a row the frontend can poll/display. There is no SMS or
 * push-notification provider wired in; if you want actual push/SMS delivery
 * (e.g. Africa's Talking for SMS, FCM for push), that's a separate provider
 * integration to add here, not something this can fabricate.
 */
export async function createNotification(userId: string, title: string, message: string) {
  return Notification.create({ userId, title, message });
}
