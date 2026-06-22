import { serializePositions, serializeCarrierVision } from '../serialization.js'

// Sends the current field positions of all active players to both clients.
// Runs last each tick so clients always receive post-movement coordinates.
export function runBroadcast(state, io, _dt) {
  const positions = serializePositions(state)
  if (positions.length > 0) {
    io.to(state.roomId).emit('positions_update', positions)
  }

  // Debug overlay ([163]): the ball carrier's vision rays (null clears it on the client).
  io.to(state.roomId).emit('carrier_vision', serializeCarrierVision(state))
}
