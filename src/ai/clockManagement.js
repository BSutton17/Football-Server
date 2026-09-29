import { scoreMargin } from './knowledge.js'

// ── Spending timeouts ([clock]) ─────────────────────────────────────────────
//
// The computer had three timeouts and never called one. It would take the ball with ninety seconds
// left in a half, run a play, and let forty of those seconds bleed away standing at the line — then
// run out of time on the drive it was trying to score on. Reported as exactly that: "when they are
// trying to score late in the 2nd or 4th quarter they should be using timeouts if need be."
//
// A timeout is worth roughly the forty seconds between the whistle and the next snap. That makes
// the rule simple and it is the one a coach actually uses: SPEND WHEN THE CLOCK IS THE THING
// STOPPING YOU, which is a different question from whether the situation is tense.
//
// Four things have to be true, and each one rules out a whole class of waste:
//   • the clock is RUNNING — after an incompletion or out of bounds it is already stopped, and a
//     timeout then buys nothing at all;
//   • the period actually ends soon — in any other situation the clock is not the constraint;
//   • the team NEEDS the time — an offense that needs points, or a defense that needs the ball
//     back. A team leading comfortably wants the clock to run, not to stop;
//   • there is still enough time for the saved seconds to become a snap.

// ⚠️ A FRACTION OF THE QUARTER, NOT A NUMBER OF SECONDS — see the same note in tempo.js. A quarter
// here is three to six minutes against the NFL's fifteen, so "the last five minutes" is a third of
// a quarter wherever it is played, and an absolute threshold would have the computer spending
// timeouts from the opening snap.
const LATE_FRACTION = { 2: 0.17, 4: 0.40 }

// Roughly what stopping the clock is worth: the play clock plus the walk-up.
export const TIMEOUT_SECONDS_SAVED = 40

// Below this there is no next snap to buy, so a timeout is simply thrown away.
const MIN_CLOCK_TO_BOTHER = 6

function lateness(k) {
  const quarterSeconds = k.quarterSeconds ?? 300
  return (LATE_FRACTION[k.quarter] ?? 0) * quarterSeconds
}

// Is this seat the one with the ball?
function hasBall(k) {
  return k.role === 'offense'
}

// Reachable scoring range, generously: a drive that starts here can plausibly end in points.
function inStrikingRange(k) {
  return (k.yardLine ?? 0) >= 40
}

export function shouldCallTimeout(k) {
  if (!k) return false
  if ((k.timeouts?.own ?? 0) <= 0) return false

  // Only while the ball is dead and nothing else owns the screen. The server refuses otherwise, and
  // a refused action from the AI is always worth not attempting.
  if (k.phase !== 'pre_snap') return false
  if (k.specialTeams || k.decision) return false

  // ⚠️ THE CLOCK HAS TO BE RUNNING. Stopping a stopped clock is the single easiest way to throw
  // three timeouts away, and it is what a naive "it is late, call one" rule does on every
  // incompletion.
  if (k.clockStopped) return false

  const late = lateness(k)
  if (!late) return false
  const clock = k.clock ?? 0
  if (clock > late) return false
  if (clock <= MIN_CLOCK_TO_BOTHER) return false

  const margin = scoreMargin(k)

  if (hasBall(k)) {
    // ⚠️ AN OFFENSE WITH A LEAD IN THE FOURTH WANTS THE CLOCK TO RUN, AT ANY MARGIN. Time is the
    // thing protecting the lead; stopping it to hurry a drive you do not need is helping the other
    // team. Only a side that must SCORE spends here — level or behind.
    if (k.quarter === 4) return margin <= 0
    // In the second quarter there is no lead worth protecting — the half ends either way, and points
    // before it are free — but there does have to be something to drive for.
    return inStrikingRange(k)
  }

  // On defense the time is only worth having if you are going to need the ball: level or behind.
  // A defense with a lead wants every second to disappear.
  return margin <= 0
}

// How many snaps the remaining clock is worth if every timeout is spent. Used to decide whether the
// situation is salvageable at all; exported because it is the honest way to reason about "need".
export function snapsLeft(k, secondsPerSnap = TIMEOUT_SECONDS_SAVED) {
  const clock = k?.clock ?? 0
  const outs = k?.timeouts?.own ?? 0
  return Math.floor((clock + outs * secondsPerSnap) / secondsPerSnap)
}
