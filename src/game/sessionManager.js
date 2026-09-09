import { randomBytes } from 'node:crypto';

// sessions: Map<token, { socketId, roomId, slot, role, active, disconnectedAt, expiryTimer }>
const sessions = new Map();

const RECONNECT_WINDOW_MS = 30_000;

// [pause] How often the hold is re-checked once the normal window has run out but the game is
// paused. Short enough that resuming a game with an absent player settles promptly.
const PAUSE_RECHECK_MS = 5_000;

export function createSession(socketId, roomId, slot, role) {
  const token = randomBytes(16).toString('hex');
  sessions.set(token, { socketId, roomId, slot, role, active: true, expiryTimer: null });
  return token;
}

// Mark a session as disconnected and start the expiry window.
// onExpired(roomId, slot) is called if the player does not reconnect in time.
//
// [pause] The window is normally 30 seconds, but stretches to `pausedWindowMs` while the game is
// paused — a paused game means somebody stepped away, and their phone locking must not end the
// match. The limit is re-evaluated each time the timer fires rather than fixed at disconnect, so it
// behaves correctly however the two events interleave: pausing after someone drops still holds
// their seat, and resuming without them lets it lapse at the next check.
export function markDisconnected(token, onExpired, opts = {}) {
  const session = sessions.get(token);
  if (!session) return false;

  const isPaused       = opts.isPaused ?? (() => false);
  const pausedWindowMs = opts.pausedWindowMs ?? RECONNECT_WINDOW_MS;

  session.active = false;
  session.socketId = null;
  session.disconnectedAt = Date.now();

  const check = () => {
    // Gone already (reconnected, or the room was torn down) — nothing to expire.
    if (!sessions.has(token) || session.active) return;

    const elapsed = Date.now() - session.disconnectedAt;
    const limit   = isPaused() ? pausedWindowMs : RECONNECT_WINDOW_MS;

    if (elapsed >= limit) {
      sessions.delete(token);
      onExpired(session.roomId, session.slot);
      return;
    }
    session.expiryTimer = setTimeout(check, Math.min(limit - elapsed, PAUSE_RECHECK_MS));
  };

  session.expiryTimer = setTimeout(check, RECONNECT_WINDOW_MS);
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
