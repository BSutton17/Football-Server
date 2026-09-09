import { GAME_MODE, DIFFICULTY } from '../constants.js';

// rooms: Map<roomId, { players, offenseSlot, createdAt, mode, difficulty }>
// offenseSlot: which index in players[] is currently offense (null until both players join)
// mode/difficulty: [manual] fixed by the creator; the room is authoritative for both (see joinRoom)
const rooms = new Map();

const ROOM_TTL_MS = 5 * 60 * 1000;

// Sweep abandoned rooms nobody ever joined. unref'd so this housekeeping timer never by itself
// keeps the process alive — in production the HTTP listener does that, and under Jest an active
// interval would otherwise hold the runner open after the tests finish.
const sweeper = setInterval(() => {
  const now = Date.now();
  for (const [roomId, room] of rooms) {
    if (room.players[1] === null && now - room.createdAt > ROOM_TTL_MS) {
      rooms.delete(roomId);
      console.log(`[room] expired: ${roomId}`);
    }
  }
}, 60_000);
sweeper.unref?.();

// Create a brand-new room — no role assigned yet.
// [manual] The creator fixes the room's mode and (for manual rooms) its difficulty. Unknown values
// fall back to the original automatic/easy behaviour so an old client can still create a room.
export function createRoom(roomId, socketId, { mode, difficulty } = {}) {
  if (rooms.has(roomId)) return { error: 'exists' };

  const resolvedMode = mode === GAME_MODE.MANUAL ? GAME_MODE.MANUAL : GAME_MODE.AUTOMATIC;
  // Difficulty only means anything in manual mode; an automatic room is always 'easy' (colors on).
  const resolvedDifficulty =
    resolvedMode === GAME_MODE.MANUAL && difficulty === DIFFICULTY.HARD ? DIFFICULTY.HARD : DIFFICULTY.EASY;

  rooms.set(roomId, {
    players: [socketId, null],
    offenseSlot: null,
    createdAt: Date.now(),
    mode: resolvedMode,
    difficulty: resolvedDifficulty,
  });
  return { slot: 0, mode: resolvedMode, difficulty: resolvedDifficulty };
}

// Join an existing room — randomly assign offense/defense to both players.
// [manual] `mode` is the mode the joiner picked in the lobby. The ROOM is authoritative, so a
// mismatch is rejected outright (with the room's real mode, so the client can say which it is)
// rather than silently dropping the joiner into a game they didn't choose. Omitting it skips the
// check, which keeps the join path usable from tests and older clients.
export function joinRoom(roomId, socketId, { mode } = {}) {
  const room = rooms.get(roomId);
  if (!room) return { error: 'not_found' };
  if (room.players[1] !== null) return { error: 'full' };

  const roomMode = room.mode ?? GAME_MODE.AUTOMATIC;
  if (mode != null && mode !== roomMode) return { error: 'mode_mismatch', mode: roomMode };

  room.players[1] = socketId;
  room.offenseSlot = Math.random() < 0.5 ? 0 : 1;

  return {
    slot: 1,
    mode: roomMode,
    difficulty: room.difficulty ?? DIFFICULTY.EASY,
    roles: {
      [room.players[0]]: room.offenseSlot === 0 ? 'offense' : 'defense',
      [socketId]:        room.offenseSlot === 1 ? 'offense' : 'defense',
    },
  };
}

export function leaveRoom(socketId) {
  for (const [roomId, room] of rooms) {
    const idx = room.players.indexOf(socketId);
    if (idx === -1) continue;
    room.players[idx] = null;
    if (room.players.every((p) => p === null)) rooms.delete(roomId);
    return { roomId, slot: idx };
  }
  return null;
}

// Flip offense/defense — called after touchdowns and turnovers
export function swapRoles(roomId) {
  const room = rooms.get(roomId);
  if (!room || room.offenseSlot === null) return null;
  room.offenseSlot = 1 - room.offenseSlot;
  return getRoles(roomId);
}

export function getRoles(roomId) {
  const room = rooms.get(roomId);
  if (!room || room.offenseSlot === null) return null;
  return {
    offenseSocketId: room.players[room.offenseSlot],
    defenseSocketId: room.players[1 - room.offenseSlot],
  };
}

export function getRoom(roomId) {
  return rooms.get(roomId) ?? null;
}

export function isFull(roomId) {
  const room = rooms.get(roomId);
  return !!room && room.players.every((p) => p !== null);
}

export function getRoomId(socketId) {
  for (const [roomId, room] of rooms) {
    if (room.players.includes(socketId)) return roomId;
  }
  return null;
}

export function getRole(socketId) {
  for (const room of rooms.values()) {
    const idx = room.players.indexOf(socketId);
    if (idx === -1) continue;
    if (room.offenseSlot === null) return null;
    return idx === room.offenseSlot ? 'offense' : 'defense';
  }
  return null;
}

// Swap the socket ID for a slot — used when a player reconnects with a new socket
export function updateSocketId(roomId, slot, newSocketId) {
  const room = rooms.get(roomId);
  if (!room) return false;
  room.players[slot] = newSocketId;
  return true;
}

// Vacate a slot by index — used when a disconnected player's 30-second window expires
export function leaveRoomBySlot(roomId, slot) {
  const room = rooms.get(roomId);
  if (!room) return;
  room.players[slot] = null;
  if (room.players.every((p) => p === null)) rooms.delete(roomId);
}
