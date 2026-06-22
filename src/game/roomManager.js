// rooms: Map<roomId, { players: [socketId|null, socketId|null], offenseSlot: 0|1|null, createdAt: number }>
// offenseSlot: which index in players[] is currently offense (null until both players join)
const rooms = new Map();

const ROOM_TTL_MS = 5 * 60 * 1000;

setInterval(() => {
  const now = Date.now();
  for (const [roomId, room] of rooms) {
    if (room.players[1] === null && now - room.createdAt > ROOM_TTL_MS) {
      rooms.delete(roomId);
      console.log(`[room] expired: ${roomId}`);
    }
  }
}, 60_000);

// Create a brand-new room — no role assigned yet
export function createRoom(roomId, socketId) {
  if (rooms.has(roomId)) return { error: 'exists' };
  rooms.set(roomId, { players: [socketId, null], offenseSlot: null, createdAt: Date.now() });
  return { slot: 0 };
}

// Join an existing room — randomly assign offense/defense to both players
export function joinRoom(roomId, socketId) {
  const room = rooms.get(roomId);
  if (!room) return { error: 'not_found' };
  if (room.players[1] !== null) return { error: 'full' };

  room.players[1] = socketId;
  room.offenseSlot = Math.random() < 0.5 ? 0 : 1;

  return {
    slot: 1,
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
