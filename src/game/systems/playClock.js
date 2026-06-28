import { applyDelayOfGame } from '../eventQueue.js'

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
    // [delay of game] Offense failed to snap in time → 5-yard penalty, replay the down, reset to 25.
    applyDelayOfGame(state, io)
  }
}
