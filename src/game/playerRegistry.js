// players: Map<socketId, PlayerInfo>
// Tracks every currently connected socket and what we know about them.
// Complements roomManager (room-centric) with a player-centric view.
const players = new Map();

export function registerPlayer(socketId) {
  players.set(socketId, {
    socketId,
    roomId: null,
    role: null,
    connectedAt: Date.now(),
    lastSeenAt: Date.now(),
  });
}

export function updatePlayer(socketId, updates) {
  const player = players.get(socketId);
  if (!player) return false;
  Object.assign(player, updates, { lastSeenAt: Date.now() });
  return true;
}

export function removePlayer(socketId) {
  return players.delete(socketId);
}

export function getPlayer(socketId) {
  return players.get(socketId) ?? null;
}

export function getPlayersInRoom(roomId) {
  const result = [];
  for (const player of players.values()) {
    if (player.roomId === roomId) result.push(player);
  }
  return result;
}

export function getConnectedCount() {
  return players.size;
}
