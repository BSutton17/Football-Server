// ── Phase constants ───────────────────────────────────────────────────────────
//
// pre_snap  — Both teams placing players in formation.
// countdown — Offense called set_offense; defense may still adjust.
//             Offense must snap the ball to advance.
// live      — Ball snapped; simulation ticking.
// dead      — Play ended; outcome is being resolved before next snap.
// game_over — Terminal. No further transitions are possible.

export const PHASE = {
  PRE_SNAP:  'pre_snap',
  COUNTDOWN: 'countdown',
  LIVE:      'live',
  DEAD:      'dead',
  GAME_OVER: 'game_over',
}

// ── Valid transitions ─────────────────────────────────────────────────────────
//
//  pre_snap  → countdown   (offense calls set_offense)
//  pre_snap  → dead        (clock expired between plays — running clock; [216])
//  pre_snap  → game_over   (clock expired, Q4, no play needed)
//  countdown → live        (offense calls snap_ball)
//  countdown → dead        (clock expired during the hike countdown — running clock; [216])
//  live      → dead        (play ends — tackle, OOB, incomplete, score)
//  dead      → pre_snap    (result resolved; next play begins)
//  dead      → game_over   (Q4 clock expired after this play)
//  game_over → (none)      (terminal)
//
// A clock that runs out between plays (PRE_SNAP / COUNTDOWN, [204]) is funneled through DEAD so
// the end-of-period transition is uniform with a clock that runs out mid-play.

const TRANSITIONS = new Map([
  [PHASE.PRE_SNAP,  new Set([PHASE.COUNTDOWN, PHASE.DEAD, PHASE.GAME_OVER])],
  [PHASE.COUNTDOWN, new Set([PHASE.LIVE, PHASE.DEAD])],
  [PHASE.LIVE,      new Set([PHASE.DEAD])],
  [PHASE.DEAD,      new Set([PHASE.PRE_SNAP, PHASE.GAME_OVER])],
  [PHASE.GAME_OVER, new Set()],
])

// Returns true if moving from fromPhase to toPhase is a legal transition.
export function canTransition(fromPhase, toPhase) {
  return TRANSITIONS.get(fromPhase)?.has(toPhase) ?? false
}

// Applies a transition to a game state object in-place.
// Throws an Error if the transition is not permitted.
export function transition(state, newPhase) {
  if (!canTransition(state.phase, newPhase)) {
    throw new Error(`[state] illegal transition: ${state.phase} → ${newPhase}`)
  }
  state.phase = newPhase
  return state
}
