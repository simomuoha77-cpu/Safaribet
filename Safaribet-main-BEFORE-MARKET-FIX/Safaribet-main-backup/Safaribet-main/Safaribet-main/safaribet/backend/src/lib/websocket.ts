import { WebSocketServer, WebSocket } from "ws";
import { Server } from "http";
import { verifyAccessToken } from "./auth";

interface ClientConnection {
  ws: WebSocket;
  userId: string | null; // null = unauthenticated, receives public channels only
  subscribedEventIds: Set<string>;
}

const clients = new Set<ClientConnection>();

export function initWebSocketServer(httpServer: Server) {
  const wss = new WebSocketServer({ server: httpServer, path: "/ws" });

  wss.on("connection", (ws, req) => {
    // Optional auth: ?token=<accessToken> in the connection URL. Public data
    // (odds updates) works without it; per-user data (bet settlement pushes)
    // requires it.
    const url = new URL(req.url || "", "http://localhost");
    const token = url.searchParams.get("token");
    let userId: string | null = null;

    if (token) {
      try {
        const payload = verifyAccessToken(token);
        userId = payload.userId;
      } catch {
        // Invalid/expired token — connection continues as unauthenticated
        // rather than being rejected, so public odds updates still work.
      }
    }

    const client: ClientConnection = { ws, userId, subscribedEventIds: new Set() };
    clients.add(client);

    ws.send(JSON.stringify({ type: "connected", authenticated: !!userId }));

    ws.on("message", (raw) => {
      try {
        const msg = JSON.parse(raw.toString());
        if (msg.type === "subscribe_event" && typeof msg.eventId === "string") {
          client.subscribedEventIds.add(msg.eventId);
        } else if (msg.type === "unsubscribe_event" && typeof msg.eventId === "string") {
          client.subscribedEventIds.delete(msg.eventId);
        }
      } catch {
        // ignore malformed messages
      }
    });

    ws.on("close", () => {
      clients.delete(client);
    });
  });

  return wss;
}

/**
 * Broadcasts an odds update to every client subscribed to that event.
 * Call this from wherever odds get updated (an odds-sync worker, once one exists).
 */
export function broadcastOddsUpdate(eventId: string, markets: unknown) {
  const payload = JSON.stringify({ type: "odds_update", eventId, markets });
  for (const client of clients) {
    if (client.subscribedEventIds.has(eventId) && client.ws.readyState === WebSocket.OPEN) {
      client.ws.send(payload);
    }
  }
}

/**
 * Pushes a bet settlement notification to a specific user, if they're
 * currently connected. Call this from the bet-settle route.
 */
export function pushBetSettled(userId: string, bet: unknown) {
  const payload = JSON.stringify({ type: "bet_settled", bet });
  for (const client of clients) {
    if (client.userId === userId && client.ws.readyState === WebSocket.OPEN) {
      client.ws.send(payload);
    }
  }
}

/**
 * Pushes a wallet balance change to a specific user (e.g. after a deposit
 * completes via M-Pesa callback), so the frontend can update live without polling.
 */
export function pushBalanceUpdate(userId: string, balances: unknown) {
  const payload = JSON.stringify({ type: "balance_update", balances });
  for (const client of clients) {
    if (client.userId === userId && client.ws.readyState === WebSocket.OPEN) {
      client.ws.send(payload);
    }
  }
}
