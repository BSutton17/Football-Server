// ── Run-Pass Option ([rpo]) ──────────────────────────────────────────────────
//
// A third play type alongside RUN and PASS. The snap opens a short READ WINDOW in which the play
// is still a pass: receivers run their routes normally and the QB may throw. The back meshes and
// WAITS rather than taking off. If no throw comes before the window closes, the ball is handed off
// and the play is a run from there on — the option has been exercised by not exercising it.
//
// Two rules give it its character, and both are deliberate:
//
//   • The LINE never works downfield. On a run the OL climbs to the second level; here it stays at
//     the line, because the ball might still be thrown. That is enforced in movement.js by capping
//     a run blocker's target depth (RPO_LINE_DEPTH), so an RPO's run lanes are genuinely tighter
//     than a called run's — the trade you make for keeping the throw alive.
//
//   • The window is measured in LIVE PLAY TIME, not wall-clock time, exactly like the throwaway
//     window it sits beside. This is what makes it behave in manual mode: there the play only
//     advances while GO is held, and a freeze holds the whole tick, so a player who releases GO to
//     read the field does not have the option quietly expire underneath them. They get a full
//     second of the play actually running. No special-casing is needed for manual, for a pause or
//     for the pass-suspense beat — a frozen tick simply never reaches this system.
//
// Note the window is short enough (1s) that only the quick game declares inside it — a receiver is
// not a legal target until his route has declared (isReceiverReady), which takes 1.3s on a route
// with no cut. That is the intended shape: an RPO is a slant/flat/drag concept, not a shot play.

// Seconds of live play the read window stays open before the ball is handed off.
export const RPO_READ_WINDOW = 1.0

export function isRpo(state) {
  return state.playDesign?.playType === 'rpo'
}

// True while the throw is still live. Everything that asks "may the offense throw?" goes through
// here so the answer can never drift between the validators and the simulation.
export function rpoReadOpen(state) {
  return isRpo(state) && !state.rpo?.committed
}

// Fresh play — called from initLivePhase at the snap.
export function resetRpo(state) {
  state.rpo = isRpo(state) ? { elapsed: 0, committed: false } : null
}

// The back the option hands to: the first RB on the field, matching how findBallCarrier picks the
// runner on a designed run. Any OTHER back is a receiver and runs its route as normal.
export function rpoRunner(state) {
  for (const p of state.offensePlayers.values()) {
    if (p.label === 'RB') return p
  }
  return null
}

// Close the window early — the ball left the QB's hands, so there is no option left to exercise.
// Called on a throw / throwaway / scramble commit so a pass doesn't turn into a handoff behind it.
export function cancelRpo(state) {
  if (state.rpo) state.rpo.committed = true
}

export function runRpo(state, io, dt) {
  const rpo = state.rpo
  if (!rpo || rpo.committed) return
  // The ball is already gone (thrown, or the QB took off) — nothing left to hand off.
  if (state.targetReceiverId != null || state.activeThrow || state.ballCarrierId) {
    rpo.committed = true
    return
  }

  rpo.elapsed += dt
  if (rpo.elapsed < RPO_READ_WINDOW) return

  // Window closed: give the ball to the back. From here findBallCarrier returns him and he runs
  // through the shared ball-carrier model on the called run angle, exactly like a designed run.
  const rb = rpoRunner(state)
  rpo.committed = true
  if (!rb) return                       // no back on the field — the QB is left holding it

  state.ballCarrierId = rb.id
  io?.to?.(state.roomId)?.emit?.('rpo_handoff', { carrierId: rb.id })
}
