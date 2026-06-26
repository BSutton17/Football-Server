import { ST_PHASE, POWER_DRAIN_PER_SEC } from '../specialTeams.js'
import { executeKick, broadcastSpecialTeams } from '../eventQueue.js'

// [Special Teams][8][9][10] Drives a player-controlled kick (punt / field goal / extra point) while
// the kicking interface is up. The power meter is full and idle until the kick "starts" — on the
// first input or after the 5-second inactivity window. Once started, power DRAINS continuously while
// the player fights it back up with directional taps ([10], applyKickInput); the kick fires when the
// 3.5s timer expires, using whatever power and angle are current then.
//
// Server-authoritative ([14]): the client animates its meter for smoothness, but THIS is the power
// the kick engine actually uses. Run during PRE_SNAP only while a player-controlled kick is active.
export function runKickClock(state, io, dt) {
  const st = state.specialTeams
  if (!st || !st.playerControlled || st.phase !== ST_PHASE.SETUP) return

  if (!st.started) {
    // [8] Idle: full power, waiting. Auto-start the kick timer after the inactivity window.
    st.inactivityTimer = Math.max(0, st.inactivityTimer - dt)
    if (st.inactivityTimer <= 0) {
      st.started = true
      broadcastSpecialTeams(state, io)   // tell the clients the meter is now draining
    }
    return
  }

  // [9][10] Drain power continuously; taps refill it. Fire the kick when the timer expires.
  st.power     = Math.max(0, st.power - POWER_DRAIN_PER_SEC * dt)
  st.kickTimer = Math.max(0, st.kickTimer - dt)
  if (st.kickTimer <= 0) executeKick(state, io)
}
