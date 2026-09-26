import { applyDelayOfGame } from '../eventQueue.js'
import { noDelayOfGame } from '../devFlags.js'

// Runs every tick during PRE_SNAP phase.
// Counts down the 25-second play clock and emits play_clock_update once per
// whole second. Paused when playClockRunning is false (offense pressed Set).
export function runPlayClock(state, io, dt) {
  if (!state.playClockRunning || state.playClock <= 0) return

  const prevDisplay = Math.ceil(state.playClock)
  state.playClock   = Math.max(0, state.playClock - dt)
  const display     = Math.ceil(state.playClock)

  if (display !== prevDisplay) {
    io.to(state.roomId).emit('play_clock_update', { playClock: display })
  }

  if (state.playClock <= 0) {
    // [dev flags] DISABLE_DELAY_OF_GAME: hold at zero and charge nothing. The clock is left visibly
    // expired rather than reset, so it is obvious the rule is off rather than looking like a clock
    // that silently restarts. Stopping it also means this branch runs once, not every tick.
    if (noDelayOfGame()) {
      state.playClockRunning = false
      if (!state.devDelayNoted) {
        state.devDelayNoted = true
        console.log(`[dev] ${state.roomId} play clock expired — delay of game is disabled`)
      }
      return
    }
    // [delay of game] Offense failed to snap in time → 5-yard penalty, replay the down, reset to 25.
    applyDelayOfGame(state, io)
  }
}
