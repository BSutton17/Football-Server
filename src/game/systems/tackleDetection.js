import { enqueue, EVENT } from '../eventQueue.js'
import { PLAYER }         from '../../constants.js'
import { findBallCarrier } from './movement.js'
import { ratingOf }        from '../../data/ratings.js'
import { tackleBreakBonus, keepsSpeedOnBreak, recordTackleBroken } from './xFactors.js'

// Two bodies overlap when their centers are within the sum of their radii.
const TACKLE_RADIUS = PLAYER.CONTACT_RADIUS  // 1.5 yd — defender and carrier are touching

// ── Run power: breaking tackles ([run power]) ───────────────────────────────────
//
// Base chance to break the Nth tackle attempt of the play (0-indexed): 1st 45%, 2nd 30%, 3rd 50%,
// none after that. Scaled by the carrier's run power (99 → full chance, 0 → none).
const BREAK_CHANCE = [0.45, 0.30, 0.5]

export function tackleBreakChance(runPower, brokenCount) {
  const base = BREAK_CHANCE[brokenCount] ?? 0
  const rp   = Math.max(0, Math.min(99, runPower ?? 0))
  return base * (rp / 99)
}

// On a break the carrier loses momentum (keeps 40% of its speed) and must re-accelerate to top speed.
const BREAK_SPEED_RETENTION = 0.4
// Seconds of immunity after a break so the same contact can't instantly re-tackle.
const BREAK_COOLDOWN = 0.15

// ── Overlap tackle detection ([161]) ────────────────────────────────────────────
//
// The instant a defender's body overlaps the ball carrier the carrier is down — UNLESS it breaks
// the tackle ([run power]): an offensive ball carrier rolls its run power and may shrug off the hit,
// keep running (at reduced speed), and stay live. Interception returns can't break tackles.
//
// On an interception return ([190]) the carrier is the intercepting defender, so the tacklers are
// the original OFFENSE; contact ends the return at the spot.
export function runTackleDetection(state, io, dt, rng = Math.random) {
  if (state.tackleEnqueued) return   // one tackle per play — don't double-fire

  const carrier = findBallCarrier(state)
  if (!carrier) return

  // Brief post-break burst — immune to a new tackle for a beat so the same hit doesn't re-fire.
  if ((carrier.tackleBreakCooldown ?? 0) > 0) {
    carrier.tackleBreakCooldown -= dt ?? 0
    return
  }

  const isReturn = state.interceptionReturn === true
  const tacklers = isReturn ? state.offensePlayers : state.defensePlayers

  for (const d of tacklers.values()) {
    const dx = d.x - carrier.x
    const dy = d.y - carrier.y
    if (dx * dx + dy * dy > TACKLE_RADIUS * TACKLE_RADIUS) continue

    // Run power: try to break the tackle and keep running (offense ball carriers only).
    if (!isReturn) {
      const broken = carrier.brokenTackles ?? 0
      // [294] An active RB X-Factor can boost the break chance (Shifty / Serious Dedication).
      const chance = tackleBreakChance(ratingOf(carrier, 'runPower'), broken) + tackleBreakBonus(state, carrier, broken)
      if (chance > 0 && rng() < chance) {
        carrier.brokenTackles = broken + 1
        // [294] Trucked: breaking a tackle no longer costs the carrier its speed.
        if (!keepsSpeedOnBreak(state, carrier)) {
          carrier.vx *= BREAK_SPEED_RETENTION
          carrier.vy *= BREAK_SPEED_RETENTION
        }
        carrier.tackleBreakCooldown = BREAK_COOLDOWN
        if (io) io.to(state.roomId).emit('tackle_broken', { carrierId: carrier.id })
        recordTackleBroken(state, carrier, carrier.brokenTackles, io)   // [294] Trucked earn
        return   // play continues — the carrier shrugged it off
      }
    }

    state.tackleEnqueued = true
    enqueue(state.roomId, EVENT.TACKLE, { carrierId: carrier.id, x: carrier.x, y: carrier.y, interceptionReturn: isReturn })
    return
  }
  // A return that reaches the original offense's goal line is a defensive touchdown — handled
  // by runTouchdownDetection (which runs first and latches the play-ending guard).
}
