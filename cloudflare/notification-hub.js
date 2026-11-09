const encoder = new TextEncoder();

function decodeBase64Url(value) {
  const normalized = value.replace(/-/g, '+').replace(/_/g, '/');
  const padded = normalized + '='.repeat((4 - normalized.length % 4) % 4);
  const binary = atob(padded);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

function decodeJsonPart(value) {
  return JSON.parse(new TextDecoder().decode(decodeBase64Url(value)));
}

export async function verifyUserJwt(token, secret, expectedUserId) {
  if (!token || !secret || typeof token !== 'string') return null;
  const parts = token.split('.');
  if (parts.length !== 3) return null;
  try {
    const header = decodeJsonPart(parts[0]);
    const payload = decodeJsonPart(parts[1]);
    if (header.alg !== 'HS256' || typeof payload.id !== 'string') return null;
    if (expectedUserId && payload.id !== String(expectedUserId)) return null;
    const now = Math.floor(Date.now() / 1000);
    if (typeof payload.exp === 'number' && now >= payload.exp) return null;
    if (typeof payload.nbf === 'number' && now < payload.nbf) return null;
    const key = await crypto.subtle.importKey(
      'raw', encoder.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['verify']
    );
    const valid = await crypto.subtle.verify(
      'HMAC', key, decodeBase64Url(parts[2]), encoder.encode(parts[0] + '.' + parts[1])
    );
    return valid ? payload : null;
  } catch {
    return null;
  }
}

/** One Durable Object instance per user; only that user's authenticated sockets live here. */
export class NotificationHub {
  constructor(state, env) {
    this.state = state;
    this.env = env;
  }

  async fetch(request) {
    const url = new URL(request.url);
    const userId = url.searchParams.get('user');
    const token = url.searchParams.get('token');
    if (!userId || !token) return new Response('Unauthorized', { status: 401 });
    const claims = await verifyUserJwt(token, this.env.JWT_SECRET, userId);
    if (!claims) return new Response('Unauthorized', { status: 401 });
    if (request.headers.get('Upgrade')?.toLowerCase() !== 'websocket') {
      return new Response('WebSocket upgrade required', { status: 426 });
    }

    const pair = new WebSocketPair();
    const client = pair[0];
    const server = pair[1];
    this.state.acceptWebSocket(server);
    server.send(JSON.stringify({ type: 'connected' }));
    return new Response(null, { status: 101, webSocket: client });
  }

  webSocketMessage() {
    // Notifications are server-to-client only. Ignore client-sent messages.
  }

  webSocketClose(socket) {
    try { socket.close(); } catch {}
  }

  webSocketError(socket) {
    try { socket.close(1011, 'WebSocket error'); } catch {}
  }

  broadcast(notification) {
    const message = JSON.stringify({ type: 'notification', data: notification });
    const sockets = this.state.getWebSockets();
    for (const socket of sockets) {
      try { socket.send(message); } catch { try { socket.close(1011, 'Delivery failed'); } catch {} }
    }
    return sockets.length;
  }
}

export async function broadcastToUser(env, userId, notification) {
  const id = env.NOTIFICATION_HUB.idFromName(String(userId));
  const hub = env.NOTIFICATION_HUB.get(id);
  return hub.broadcast(notification);
}
