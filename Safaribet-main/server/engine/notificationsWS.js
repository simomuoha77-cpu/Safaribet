const jwt = require('jsonwebtoken');

/**
 * Live notifications WebSocket — unlike a public game broadcast, this is
 * per-user: each client authenticates with a JWT (passed as ?token=... in the
 * connection URL, since browsers can't set custom headers on WS upgrade) and
 * only receives notifications addressed to their own userId.
 */

const userSockets = new Map(); // userId (string) -> Set<ws>

function setupWS(wss) {
  wss.on('connection', (ws, req) => {
    try {
      const url = new URL(req.url, 'http://localhost');
      const token = url.searchParams.get('token');
      if (!token) { ws.close(4001, 'Missing token'); return; }

      const decoded = jwt.verify(token, process.env.JWT_SECRET);
      const userId = String(decoded.id);

      if (!userSockets.has(userId)) userSockets.set(userId, new Set());
      userSockets.get(userId).add(ws);

      ws.send(JSON.stringify({ type: 'connected' }));

      ws.on('close', () => {
        const set = userSockets.get(userId);
        if (set) { set.delete(ws); if (!set.size) userSockets.delete(userId); }
      });
      ws.on('error', () => {});
    } catch (e) {
      ws.close(4002, 'Invalid token');
    }
  });
}

function broadcastToUser(userId, notification) {
  const set = userSockets.get(String(userId));
  if (!set || !set.size) return;
  const msg = JSON.stringify({ type: 'notification', data: notification });
  set.forEach(ws => { if (ws.readyState === 1) ws.send(msg); });
}

module.exports = { setupWS, broadcastToUser };
