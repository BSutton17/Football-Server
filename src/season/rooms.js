// Which live room, if any, a season's game is in. Its own small module so the HTTP routes can reach it
// without importing the socket and AI graph behind gameRoom.js, which must stay imported by nobody but
// src/socket/index.js (see the note in ai/solo.js).

import { leaveRoomBySlot } from '../game/roomManager.js'
import { deleteGame } from '../game/gameState.js'
import { stopGameLoop } from '../game/simulation.js'
import { clearQueue } from '../game/eventQueue.js'
import { clearTeamSelect } from '../game/teamSelect.js'
import { getTokensByRoomId, invalidateSession } from '../game/sessionManager.js'
import { clearAiSeats } from '../ai/seats.js'

const bySeason = new Map()   // seasonId → roomId

export function setSeasonRoom(seasonId, roomId) { bySeason.set(seasonId, roomId) }
export function seasonRoomOf(seasonId) { return bySeason.get(seasonId) ?? null }
export function forgetSeasonRoom(seasonId) { bySeason.delete(seasonId) }

// Tear a room down completely. The game's save, if there is one, is not touched.
export function closeRoom(roomId) {
  for (const t of getTokensByRoomId(roomId)) invalidateSession(t)
  leaveRoomBySlot(roomId, 0)
  leaveRoomBySlot(roomId, 1)
  stopGameLoop(roomId)
  deleteGame(roomId)
  clearQueue(roomId)
  clearTeamSelect(roomId)
  clearAiSeats(roomId)
}

export function closeSeasonRoomFor(seasonId) {
  const roomId = bySeason.get(seasonId)
  if (!roomId) return
  closeRoom(roomId)
  bySeason.delete(seasonId)
}
