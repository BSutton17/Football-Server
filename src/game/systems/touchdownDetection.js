import { enqueue, EVENT } from '../eventQueue.js'
import { findBallCarrier } from './movement.js'
import { yardLineFromAbsY } from '../gameState.js'

// ── Touchdown detection ([194]) ──────────────────────────────────────────────
//
// The instant the ball carrier crosses a goal line the play ends in a touchdown. Field position
// is read in the original-offense frame (yardLineFromAbsY: 0 = offense's own goal, 100 = the
// opponent's goal):
//   • normal carrier — reaching the opponent goal line (rel ≥ 100) scores for the offense.
//   • interception return — the defender is running the other way; reaching the original
//     offense's goal line (rel ≤ 0) is a defensive touchdown for the intercepting team.
//
// Runs BEFORE tackle detection in the pipeline and latches the shared play-ending guard
// (tackleEnqueued) so a carrier who breaks the plane isn't also recorded as tackled this tick.
export function runTouchdownDetection(state, _io, _dt) {
  if (state.tackleEnqueued) return   // play already ending

  const carrier = findBallCarrier(state)
  if (!carrier) return

  const rel = yardLineFromAbsY(state, carrier.y)

  if (state.interceptionReturn) {
    if (rel <= 0) {
      state.tackleEnqueued = true
      enqueue(state.roomId, EVENT.TOUCHDOWN, { scoringSlot: 1 - state.possession, carrierId: carrier.id, x: carrier.x, y: carrier.y })
    }
    return
  }

  if (rel >= 100) {
    state.tackleEnqueued = true
    enqueue(state.roomId, EVENT.TOUCHDOWN, { scoringSlot: state.possession, carrierId: carrier.id, x: carrier.x, y: carrier.y })
  }
}
