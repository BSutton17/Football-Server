// ── Gameplay stoppage framework ([69]) ─────────────────────────────────────────
//
// A single, reusable primitive for pausing the game while PRESERVING the exact game state. While a
// stoppage is active the simulation tick freezes every clock (game clock, play clock, decision /
// conversion / kick timers) and holds the live sim, so nothing advances and no state is lost. When
// it ends, play resumes from precisely where it left off.
//
// Timeouts ([70]) are the first consumer, but the same mechanism is meant to back future features —
// injury stoppages, coach's challenges / reviews, and halftime transitions — each supplying its own
// `reason` (and optional auto-resume duration). Keep this module pure state: no io, no emits, no
// game-rule knowledge. Consumers layer their own effects on top (see call_timeout in gameHandlers).

export const STOPPAGE = {
  TIMEOUT:   'timeout',
  INJURY:    'injury',
  CHALLENGE: 'challenge',
  HALFTIME:  'halftime',
}

// Begin a stoppage. `durationSec` auto-resumes after that many seconds of sim time (counted down by
// tickStoppage); pass null for an open-ended stoppage that must be ended explicitly with endStoppage.
export function beginStoppage(state, reason, durationSec = null) {
  state.stoppage = { reason, remaining: durationSec }
  return state.stoppage
}

export function endStoppage(state) {
  state.stoppage = null
}

export function isStopped(state) {
  return state.stoppage != null
}

export function stoppageReason(state) {
  return state.stoppage?.reason ?? null
}

// Advance a timed stoppage by dt. Returns true while the stoppage should keep freezing the tick,
// false once a timed stoppage has elapsed (the caller then ends it and runs its resume hook). An
// open-ended stoppage (remaining == null) always returns true until endStoppage is called.
export function tickStoppage(state, dt) {
  const s = state.stoppage
  if (!s) return false
  if (s.remaining == null) return true
  s.remaining = Math.max(0, s.remaining - dt)
  return s.remaining > 0
}
