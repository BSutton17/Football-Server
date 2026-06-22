import { detectEngagements } from '../utils/engagementZone.js'
import { computeLeverage }   from '../utils/leverageModel.js'
import { FIELD }             from '../../constants.js'

// Speed multiplier applied to both players while they are in an engagement.
// 0.5 = each player moves at half speed while locked in a block fight.
export const ENGAGED_SPEED_MULT = 0.5

// Finds the ball reference point for leverage computation.
// Prefers the active ball carrier; falls back to the QB; final fallback is midfield.
export function findBallRef(state) {
  if (state.ballCarrierId) {
    const carrier = state.offensePlayers.get(state.ballCarrierId)
    if (carrier) return carrier
  }
  for (const p of state.offensePlayers.values()) {
    if (p.label === 'QB') return p
  }
  return { x: FIELD.WIDTH / 2, y: FIELD.LENGTH / 2 }
}

// Sets isEngaged / engagedWithId / leverage data on players that are in a block
// engagement this tick. Runs BEFORE runMovement so the movement system sees
// up-to-date engagement and leverage state.
//
// All flags are cleared at the top of each tick — stale engagements auto-expire
// as soon as players separate, without any explicit cleanup.
export function runEngagement(state, _io, _dt) {
  // Clear per-tick flags on all players.
  for (const p of state.offensePlayers.values()) {
    p.isEngaged      = false
    p.engagedWithId  = null
  }
  for (const p of state.defensePlayers.values()) {
    p.isEngaged      = false
    p.engagedWithId  = null
    p.leverageScore  = 0
    p.leveragePushX  = 0
    p.leveragePushY  = 0
    p.leverageSide   = 'balanced'
  }

  const ballRef = findBallRef(state)
  const pairs   = detectEngagements(state.offensePlayers, state.defensePlayers, state.playDesign?.playType)

  for (const { offense: o, defense: d } of pairs) {
    // A rusher that has shed its block has broken free — don't re-engage or slow it.
    if (d.shedBlock) continue

    // Engagement flags — keep first recorded partner (primary opponent).
    o.isEngaged     = true
    o.engagedWithId = o.engagedWithId ?? d.id

    d.isEngaged     = true
    d.engagedWithId = d.engagedWithId ?? o.id

    // Leverage — compute for this pair and accumulate onto the defender.
    // If a defender is being double-teamed, the leverage scores add together
    // (two blockers with inside leverage push harder than one).
    const lev = computeLeverage(o, d, ballRef)
    d.leverageScore += lev.score
    d.leveragePushX += lev.pushX
    d.leveragePushY += lev.pushY
    // Side is set by the dominant (highest-score) blocker; later pairs may overwrite.
    if (lev.score > (d._bestLevScore ?? -Infinity)) {
      d._bestLevScore = lev.score
      d.leverageSide  = lev.side
    }
  }

  // Normalize accumulated push vectors (unit length) and clamp score.
  for (const d of state.defensePlayers.values()) {
    if (!d.isEngaged) continue
    const len = Math.sqrt(d.leveragePushX ** 2 + d.leveragePushY ** 2)
    if (len > 0.001) { d.leveragePushX /= len; d.leveragePushY /= len }
    d.leverageScore = Math.max(-1, Math.min(1, d.leverageScore))
    delete d._bestLevScore
  }
}
