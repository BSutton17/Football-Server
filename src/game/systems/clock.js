import { enqueue, EVENT } from '../eventQueue.js'
import { serializeClock } from '../serialization.js'

// Runs every tick during LIVE phase.
// Decrements the game clock by the fixed timestep (dt = 0.05 s at 20 Hz).
// Fires CLOCK_EXPIRED once when the clock reaches zero.
// Emits clock_update only when the displayed whole-second value changes —
// that's at most once per second instead of 20 times per second.
export function runClock(state, io, dt) {
  if (state.clock <= 0) return   // already expired this play, guard against re-firing
  // [Special Teams][57] A post-touchdown try (extra point or 2-pt conversion) is untimed — the game
  // clock is stopped for it and doesn't restart until the ensuing kickoff. (Kick menus / setup never
  // reach runClock; this covers the 2-pt try, which is a live scrimmage play.)
  if (state.twoPointActive != null) return

  const prevDisplay = Math.ceil(state.clock)

  state.clock = Math.max(0, state.clock - dt)

  if (state.clock <= 0) {
    // Clock just expired — let the event queue handle the quarter/game transition
    enqueue(state.roomId, EVENT.CLOCK_EXPIRED)
  }

  // Math.ceil means the display ticks: 300 → 299 → ... → 1 → 0
  // An update is only emitted when the ceiling value actually changes,
  // which happens once per second (every 20 ticks at 20 Hz).
  const display = Math.ceil(state.clock)
  if (display !== prevDisplay) {
    io.to(state.roomId).emit('clock_update', serializeClock(state))
  }
}
