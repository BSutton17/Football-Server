// ── Chewing the clock ([chew clock]) ────────────────────────────────────────
//
// An offense protecting a lead wants the pre-snap seconds to go away. They already DO go away — the
// game clock runs through PRE_SNAP whenever the previous play didn't stop it (see simulation.js) —
// but they go away in real time, which means sitting and watching a number count down with nothing
// to do. So this fast-forwards it: the play clock and the game clock both run at CHEW_SPEED until
// the play clock reads CHEW_STOP_AT, and then normal time resumes and the offense snaps.
//
// The two clocks are advanced by the SAME scaled step, which is the whole correctness argument: no
// extra game time is invented and none is skipped. Ten seconds burned off the play clock is ten
// seconds off the game clock, exactly as if the offense had stood there and let it happen.
//
// ⚠️ SOLO ROOMS ONLY, for the same reason the pre-snap Set Defense button is (see ai/timing.js).
// Before the offense locks, the DEFENSE is still placing its eleven. Fast-forwarding the play clock
// then is not one team spending its own time — it is one player taking the other's setup time away.
// Online, chewing the clock is already available and already fair: stand there and let it run.
//
// ⚠️ AND IT STOPS AT THREE, NOT AT ZERO. Zero is a delay-of-game penalty. The offense still has to
// set and snap after the fast-forward ends, so the last seconds are left on the clock to do it in.

import { PHASE } from './stateMachine.js'

// Where the fast-forward ends: enough to set the formation and hike, not enough to waste.
export const CHEW_STOP_AT = 3

// Below this on the play clock, chewing is refused outright rather than doing a token amount. There
// is nothing worth speeding through, and arming it that late is far more likely to be a mis-tap that
// costs a delay-of-game than a decision to burn four seconds.
export const CHEW_MIN_PLAY_CLOCK = 8

// How many times faster the clocks run while chewing. 8x turns a 20-second wait into 2.5 seconds —
// fast enough to feel like a skip, slow enough that the numbers are still readable as they go.
export const CHEW_SPEED = 8

// Can this viewer chew right now? Returns null when it may, or a reason string when it may not.
// Shared by the socket validator and by the client-facing snapshot, so the button and the handler
// can never disagree about the rules.
//
// ⚠️ `ignoreLive` EXISTS BECAUSE THE SNAPSHOT IS A SNAPSHOT. `game_state` is broadcast once, when the
// play begins; through pre-snap the client only receives clock ticks. So the two conditions that
// change second by second — how much play clock is left, and whether a chew is already running —
// cannot be answered by a serialized field, and the client mirrors them from the live clock it is
// already displaying. The handler still checks everything, so the client being a moment out of date
// costs a refusal, not a wrong chew.
export function chewRefusal(state, slot, { ignoreLive = false } = {}) {
  if (!state) return 'no game'
  if (!state.solo) return 'chewing the clock is offline-only'           // see the warning above
  if (state.possession !== slot) return 'only the offense may chew the clock'
  if (state.phase !== PHASE.PRE_SNAP) return 'the ball is not on the ground'
  if (state.decisionPending || state.conversionPending) return 'a decision is pending'
  if (state.specialTeams) return 'not during a kick'
  if (!state.playClockRunning) return 'the play clock is not running'
  if (ignoreLive) return null
  if (state.chewing) return 'already chewing'
  // The author's rule: under eight seconds, do not speed up at all.
  if ((state.playClock ?? 0) < CHEW_MIN_PLAY_CLOCK) return 'too little left on the play clock'
  return null
}

// Arms the fast-forward. Returns true when it took.
export function armChewClock(state, slot) {
  if (chewRefusal(state, slot)) return false
  state.chewing = true
  return true
}

// Cleared per play — chewing is a decision about THIS snap. (Called from the shared per-play reset,
// so both the training path and the real game's startNextPlay get it.)
export function clearChewClock(state) {
  if (state) state.chewing = false
}

// The timestep the pre-snap clocks should advance by this tick.
//
// Returns `dt` unchanged when not chewing. While chewing it returns a scaled step, never overshooting
// CHEW_STOP_AT — landing exactly on it rather than 0.4s past keeps the stop point exact and keeps the
// game clock's burn equal to the play clock's to the tick. Disarms itself on arrival.
export function chewStep(state, dt) {
  if (!state?.chewing) return dt
  // Anything that should stop a chew mid-flight (a timeout, the phase moving on) either never
  // reaches this function or has already cleared the flag; arriving here with no play clock left
  // means the chew is finished.
  const room = Math.max(0, (state.playClock ?? 0) - CHEW_STOP_AT)
  if (room <= 0) { state.chewing = false; return dt }
  return Math.min(dt * CHEW_SPEED, room)
}
