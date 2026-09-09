import { serializePositions, serializeCarrierVision } from '../serialization.js'
import { getRoom } from '../roomManager.js'
import { DIFFICULTY } from '../../constants.js'

// Sends the current field positions of all active players to both clients.
// Runs last each tick so clients always receive post-movement coordinates.
//
// [manual] On HARD difficulty the two teams must NOT see the same thing: the offense is denied the
// receiver-openness read, the defense keeps it. That is enforced here by serializing once per
// viewer instead of once per room, so the hidden information never leaves the server. Every other
// game builds a single shared payload and broadcasts it, exactly as before — the per-viewer path
// costs a second serialization pass at 20 Hz, so it is taken only when it actually changes anything.
export function runBroadcast(state, io, _dt) {
  if (state.difficulty === DIFFICULTY.HARD) {
    const room = getRoom(state.roomId)
    if (room) {
      room.players.forEach((socketId, slot) => {
        if (!socketId) return
        const positions = serializePositions(state, slot)
        if (positions.length > 0) io.to(socketId).emit('positions_update', positions)
      })
    }
  } else {
    const positions = serializePositions(state)
    if (positions.length > 0) {
      io.to(state.roomId).emit('positions_update', positions)
    }
  }

  // Debug overlay ([163]): the ball carrier's vision rays (null clears it on the client).
  io.to(state.roomId).emit('carrier_vision', serializeCarrierVision(state))
}
