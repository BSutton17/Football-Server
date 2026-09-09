// ── Throwaway availability ([187][manual]) ───────────────────────────────────
//
// The QB has to hold the ball a beat before throwing it away is offered — you can't bail out of a
// play the instant it starts. That beat is measured in GAME time, not wall-clock time.
//
// The distinction is the whole point in manual mode. There, the play only advances while the
// offense is holding GO: releasing it freezes everything, and a player can stand in that freeze for
// as long as they like reading the field. A real-world timer would quietly tick down through all of
// that and hand them the throwaway without the play having gone anywhere. Counting simulated time
// instead means the option arrives after the ball has actually been in the QB's hands that long.
//
// Because the tick itself is frozen during a stoppage — a manual hold, a pause, the pass-suspense
// beat — simply accumulating dt here is already "time the play was really running", with no special
// cases for any of them.

import { GAME_MODE } from '../../constants.js'

// Seconds of live play before the option appears. Manual gets slightly longer: its time is
// deliberate, held-down time, so the same wall-clock feel needs a bigger number.
const THROWAWAY_AFTER_SECONDS = {
  [GAME_MODE.AUTOMATIC]: 2,
  [GAME_MODE.MANUAL]:    3,
}

// Resets the window for a new play. Called from initLivePhase at the snap.
export function resetThrowawayWindow(state) {
  state.livePlayElapsed = 0
  state.throwawayOffered = false
}

export function runThrowawayWindow(state, io, dt) {
  if (state.throwawayOffered) return
  if (state.playDesign?.playType !== 'pass') return

  state.livePlayElapsed = (state.livePlayElapsed ?? 0) + dt

  const after = THROWAWAY_AFTER_SECONDS[state.mode] ?? THROWAWAY_AFTER_SECONDS[GAME_MODE.AUTOMATIC]
  if (state.livePlayElapsed < after) return

  state.throwawayOffered = true
  io.to(state.roomId).emit('throwaway_ready')
}

export { THROWAWAY_AFTER_SECONDS }
