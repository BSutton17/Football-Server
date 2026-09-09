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

  // [pause] A player called a pause. Open-ended: it lasts until somebody lifts it. Unlike every
  // other stoppage this one can land ON TOP of another (a timeout, or a manual-mode freeze), so
  // beginPlayerPause remembers what it interrupted and resumePlayerPause puts it back.
  PLAYER_PAUSE: 'player_pause',

  // [manual] The three freezes that make up manual (electric-football) mode. All three reuse this
  // framework precisely because it preserves state EXACTLY — velocities included, which is what
  // lets the openness read stay honest while the field is frozen (see manual.js).
  MANUAL_HOLD:   'manual_hold',    // open-ended: the offense let go of GO; play resumes on the next press
  PASS_SUSPENSE: 'pass_suspense',  // timed: the "It is…" beat before the already-decided result is shown
  RESULT_HOLD:   'result_hold',    // timed: the beat after "Caught!"/"Intercepted!" before play resumes
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

// ── Player pause ([pause]) ───────────────────────────────────────────────────

// True while a player-called pause is up.
export function isPlayerPaused(state) {
  return state?.stoppage?.reason === STOPPAGE.PLAYER_PAUSE
}

// Freezes the game until resumePlayerPause. Any stoppage already running is set aside rather than
// discarded: pausing during a timeout, or while a manual-mode play is frozen with the GO button up,
// must not silently cancel it — the play would resume moving with nobody holding anything.
export function beginPlayerPause(state, bySlot) {
  if (isPlayerPaused(state)) return false
  state.pauseInterrupted = state.stoppage ?? null
  state.pausedBy = bySlot
  beginStoppage(state, STOPPAGE.PLAYER_PAUSE, null)
  return true
}

// Lifts the pause and restores whatever it interrupted.
export function resumePlayerPause(state) {
  if (!isPlayerPaused(state)) return false
  state.stoppage = state.pauseInterrupted ?? null
  state.pauseInterrupted = null
  state.pausedBy = null
  return true
}
