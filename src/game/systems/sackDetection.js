import { enqueue, EVENT } from '../eventQueue.js'
import { getLosY }        from '../gameState.js'
import { PLAYER }         from '../../constants.js'
import { shakeOffSack, SHAKE_IMMUNITY_S, SHAKE_KNOCKBACK_YD } from './xFactors.js'

// A defender sacks the QB the instant their bodies touch. This MUST match the contact distance
// (sum of the two radii) — the collision solver never lets centers get closer than CONTACT_RADIUS,
// so a tighter threshold (the old 1.0) could never be reached and sacks never fired ([sack fix]).
const SACK_RADIUS = PLAYER.CONTACT_RADIUS  // 1.5 yd — bodies touching, same as a tackle

export function runSackDetection(state, io, dt, rng = Math.random) {
  // Only check while the ball is still in the QB's hands. Once a scramble starts ([184])
  // ballCarrierId is the QB itself — it's a runner now, so overlap tackle detection brings
  // it down (a QB run tackled behind the LOS spots at the same place a sack would).
  // Skip if the play is already ending (event was already enqueued this tick).
  if (state.sackEnqueued) return

  // [294] Shake It Off grace window: after the QB shrugs off a sack the beaten rusher is shoved
  // away and no sack can land for a beat, so the same contact can't instantly re-sack.
  if (state.qbSackImmunity > 0) { state.qbSackImmunity -= dt ?? 0; return }

  if (state.ballCarrierId) return

  let qb = null
  for (const p of state.offensePlayers.values()) {
    if (p.label === 'QB') { qb = p; break }
  }
  if (!qb) return

  // QB must be behind the line of scrimmage for it to be a sack.
  const losY        = getLosY(state)
  const yardsBehind = (losY - qb.y) * state.direction
  if (yardsBehind < 0) return  // QB is past the LOS — no sack possible

  for (const d of state.defensePlayers.values()) {
    const dx   = d.x - qb.x
    const dy   = d.y - qb.y
    const dist = Math.sqrt(dx * dx + dy * dy)

    if (dist <= SACK_RADIUS) {
      // [294] Shake It Off — an active-ability QB has a 50% chance to escape. On a shake-off the
      // play stays live: shove the rusher off the QB and grant a brief sack immunity.
      if (shakeOffSack(state, qb, rng)) {
        state.qbSackImmunity = SHAKE_IMMUNITY_S
        const sep = SACK_RADIUS + SHAKE_KNOCKBACK_YD
        const nx  = dist > 0.0001 ? dx / dist : 0
        const ny  = dist > 0.0001 ? dy / dist : 1
        d.x  = qb.x + nx * sep
        d.y  = qb.y + ny * sep
        d.vx = 0
        d.vy = 0
        if (io) io.to(state.roomId).emit('sack_shaken', { qbId: qb.id })
        return
      }

      state.sackEnqueued = true
      enqueue(state.roomId, EVENT.SACK, { qbY: qb.y, losY, dir: state.direction, qbX: qb.x })
      return
    }
  }
}
