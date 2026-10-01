import { ST_PHASE, POWER_DRAIN_PER_SEC, puntReturnDefault } from '../specialTeams.js'
import { executeKick, broadcastSpecialTeams, resolvePuntReturn } from '../eventQueue.js'

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
  if (!st) return

  // [28] An in-field punt is awaiting the receiving team's Return / Fair Catch / Let It Bounce
  // choice. Tick the decision timer; auto-pick the default when it expires.
  if (st.returnPending) {
    st.returnTimer = Math.max(0, st.returnTimer - dt)
    if (st.returnTimer <= 0) resolvePuntReturn(state, io, puntReturnDefault())
    return
  }

  if (!st.playerControlled || st.phase !== ST_PHASE.SETUP) return

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
  // ⚠️ A COMMITTED STRIKE DOES NOT DRAIN. A computer seat states its power once (see
  // applyKickInput); draining it away afterwards would put us straight back to the 22-yard punt.
  if (!st.__aiPowerSet) st.power = Math.max(0, st.power - POWER_DRAIN_PER_SEC * dt)
  st.kickTimer = Math.max(0, st.kickTimer - dt)
  if (st.kickTimer <= 0) { executeKick(state, io); return }

  // ⚠️ THE DRAINING METER IS BROADCAST, AND NOTHING USED TO SAY A WORD WHILE IT DRAINED.
  //
  // `special_teams_update` was sent once, when the kick began, and never again until it resolved.
  // For a human that is survivable — the client animates its own bar. For the COMPUTER it was fatal:
  // the AI works the meter by reacting to events, and during a kick it received none at all. It
  // tapped once, the meter drained for three and a half seconds, and the ball was kicked at 0.46
  // power. Measured across every distance from the 20 to the 50 yard line: forty attempts each,
  // ZERO made, every single one short — including a thirty-seven yarder.
  //
  // Sending it on the tick the displayed value changes gives the AI its heartbeat and makes the
  // human's bar server-truth rather than a local guess. Ten a second, a tiny payload, and only
  // while a kick is actually on the screen.
  const shown = Math.round(st.power * METER_STEPS)
  if (shown !== st.__shownPower) {
    st.__shownPower = shown
    broadcastSpecialTeams(state, io)
  }
}

// How finely the power meter is reported. Ten steps is smoother than the eye needs and still only a
// handful of messages per kick.
const METER_STEPS = 20
