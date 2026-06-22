import { randomBytes } from 'node:crypto';

// sessions: Map<token, { socketId, roomId, slot, role, active, disconnectedAt, expiryTimer }>
const sessions = new Map();

const RECONNECT_WINDOW_MS = 30_000;

export function createSession(socketId, roomId, slot, role) {
  const token = randomBytes(16).toString('hex');
  sessions.set(token, { socketId, roomId, slot, role, active: true, expiryTimer: null });
  return token;
}

// Mark a session as disconnected and start the 30-second expiry window.
// onExpired(roomId, slot) is called if the player does not reconnect in time.
export function markDisconnected(token, onExpired) {
  const session = sessions.get(token);
  if (!session) return false;

  session.active = false;
  session.socketId = null;
  session.disconnectedAt = Date.now();
  session.expiryTimer = setTimeout(() => {
    sessions.delete(token);
    onExpired(session.roomId, session.slot);
  }, RECONNECT_WINDOW_MS);

  return true;
}

// Match an incoming reconnect token to a pending session.
// Returns session data on success, null if token is unknown or already active.
export function reconnect(token, newSocketId) {
  const session = sessions.get(token);
  if (!session || session.active) return null;

  clearTimeout(session.expiryTimer);
  session.socketId = newSocketId;
  session.active = true;
  session.expiryTimer = null;
  delete session.disconnectedAt;

  return { roomId: session.roomId, slot: session.slot, role: session.role };
}

export function getTokenBySocketId(socketId) {
  for (const [token, session] of sessions) {
    if (session.socketId === socketId) return token;
  }
  return null;
}

export function invalidateSession(token) {
  const session = sessions.get(token);
  if (!session) return;
  if (session.expiryTimer) clearTimeout(session.expiryTimer);
  sessions.delete(token);
}

export function getTokensByRoomId(roomId) {
  const found = [];
  for (const [token, session] of sessions) {
    if (session.roomId === roomId) found.push(token);
  }
  return found;
}
