// ── Offline pre-snap timing ([offline]) ─────────────────────────────────────
//
// Online, the rhythm is fixed by the two humans: the offense sets when it is ready, and the
// defense gets a 5-or-10 second window to adjust before the hike unlocks. Offline that does not
// work, for two reasons.
//
//   • When the COMPUTER has the ball, it decides instantly. If it set the moment the play started,
//     a human defense would never get to look at the formation. So the computer waits — it sets
//     with somewhere between 20 and 5 seconds left on the play clock, picked at random, so the
//     human cannot learn a rhythm and pre-empt it.
//
//   • When the HUMAN has the defense and is ready early, there is nobody to wait for. So the human
//     may SET the defense, which cuts the wait to a short 3-second countdown and snaps.
//
// ⚠️ The short countdown belongs to ONE ordering only — defense first, then offense. If the OFFENSE
// sets first the defense has not declared anything, so it gets the ordinary 5-second window to look
// at the formation and answer it. Pressing Set Defense after that window has already started does
// not shorten it: the countdown the defense would be cutting short is its own.
//
// Both rules live here rather than in the handlers because they are a property of a SOLO room, and
// the handlers are shared with online play, which must keep the rhythm it has.

// The window the computer's offense will set inside, measured in seconds left on the play clock.
// Random within the range, per play.
export const AI_SET_LATEST = 20
export const AI_SET_EARLIEST = 5

// How long the defense has once it sets early. Short, because setting early is a declaration that
// you are ready — the whole point is to stop waiting.
export const DEFENSE_SET_COUNTDOWN = 3

// …and how long it has when the OFFENSE set first. The defense is still reading the formation, so
// this is the ordinary adjust window, not the short one.
export const OFFENSE_SET_COUNTDOWN = 5

// Picks the play-clock reading the computer will set its formation at. Called once per play by the
// CONTROLLER, on its own random stream — the server keeps no copy, because only the AI acts on it.
export function chooseSetTime(rng = Math.random) {
  return AI_SET_EARLIEST + rng() * (AI_SET_LATEST - AI_SET_EARLIEST)
}

// Has the moment arrived? Compares against the play clock rather than counting wall-clock time, so
// it behaves correctly through a timeout, a pause, or anything else that holds the clock.
export function shouldSetNow(playClockRemaining, setAt) {
  return Number.isFinite(setAt) && playClockRemaining <= setAt
}

// ── The defensive Set ─────────────────────────────────────────────────────────
//
// Tracks a solo room's early-set state. Kept as a small object on the game rather than as module
// state so it dies with the game and cannot leak between rooms.
// ⚠️ `defenseSet` is PER PLAY and is cleared by `resetPlay` in gameState.js, not here — this runs
// once, when the game is created. Forgetting that is what made the Set Defense button a one-shot.
export function initSoloTiming(state) {
  state.solo = {
    defenseSet: false,              // the human defense has declared itself ready FOR THIS PLAY
    countdown: null,                // seconds left once it has
  }
  return state.solo
}

// Records that the defense has declared itself ready. `offenseAlreadySet` is the ordering that
// decides the length: only a defense that got there FIRST earns the short countdown, and when the
// offense beat it the window it is already sitting in stands unchanged.
export function markDefenseSet(state, { offenseAlreadySet = false } = {}) {
  if (!state.solo) return false
  if (state.solo.defenseSet) return false
  state.solo.defenseSet = true
  if (!offenseAlreadySet) state.solo.countdown = DEFENSE_SET_COUNTDOWN
  return true
}

// The window the defense gets once the offense locks, for a SOLO room. Online keeps its own rule
// (10 s on a fresh drive, 5 otherwise), which is the offense's gift to give and is left alone.
export function soloCountdownFor(state) {
  return state?.solo?.defenseSet ? DEFENSE_SET_COUNTDOWN : OFFENSE_SET_COUNTDOWN
}

export function isSoloRoom(state) {
  return !!state?.solo
}

// Marks a freshly created game as solo and arms its timing. Called from the team-select handoff,
// which is where the game state first exists.
export function markSoloRoom(state) {
  if (!state) return null
  return initSoloTiming(state)
}
