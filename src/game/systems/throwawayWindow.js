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
// ⚠️ MANUAL'S 3s WAS LONGER THAN THE PLAY LASTED. Sacks in manual land at about 1.8-2.0s of
// BOARD time, so the bail-out became legal strictly after the point it was needed: the AI
// quarterback was measured going down with `throwawayReady` still false on every look he had.
//
// It has to arrive before his FIRST look, which is at 1.45s, and swept values confirm that is the
// binding point exactly — 1.6 and 1.3 give identical results, while 2.2 is measurably worse. Manual
// time is deliberate, held-down time and still gets the longer number of the two; it just has to
// exist while the play is still alive.
//
//   four-man rush, manual, medium:  man 30% -> 24% sacks,  zone 24% -> 16%,  six-man 60% -> 46%
//
// ⚠️ AND THEN IT WAS TOO EASY. With the bail-out live at 1.6s the AI quarterback gave up on plays
// that were still developing — reported as "the AI qb can throw the ball away way too easily". A
// throwaway is for a play that has actually died: 2.25s in automatic, 2s in manual (by request —
// manual's board-time plays end sooner). The sacks the shorter window saved are the price of the
// quarterback having to hang in there.
const THROWAWAY_AFTER_SECONDS = {
  [GAME_MODE.AUTOMATIC]: 2.25,
  [GAME_MODE.MANUAL]:    2,
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
