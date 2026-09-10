import { detectEngagements, ENGAGEMENT_RADIUS } from '../utils/engagementZone.js'
import { computeLeverage }                       from '../utils/leverageModel.js'
import { findBallRef }                           from './engagement.js'
import { ratingOf, strengthModifier }            from '../../data/ratings.js'
import { PANCAKE }                               from '../../constants.js'

// ── [pancake] Dominant blocks ────────────────────────────────────────────────
//
// A blocker who is beating the man in front of him badly enough occasionally puts him on the
// ground. A pancaked defender is removed from the play for PANCAKE.DURATION_SECONDS: he cannot
// move, cannot tackle, cannot rush the passer, and the ball carrier runs straight through him.
//
// WHO CAN DO IT is a matchup question, not a dice roll. Three things must all be true, and the
// chance scales with how comprehensively the blocker wins:
//
//   1. he must be winning the leverage fight (MIN_LEVERAGE),
//   2. he must be physically stronger (MIN_STRENGTH_EDGE), and
//   3. the odds then come from his strength edge and his block rating against the defender's
//      resistance — so a 90-strength guard flattens a 60-strength linebacker often, and two
//      even linemen essentially never pancake each other.
//
// THE PLAY TYPES DIFFER ON PURPOSE. On a run the blocker finishes and works upfield, which is the
// entire point of a pancake in the run game. On a pass he is frozen for the same window, so a
// pancake can never be exploited to free a protector up and send him to double-team someone else.

const BLOCKER_LABELS = new Set(['OL', 'C', 'G', 'T', 'TE'])

// How completely does this blocker beat this defender, 0–1? Combines the strength edge with the
// relevant block rating measured against what the defender brings to resist it.
export function pancakeMatchupScore(blocker, defender, isRun) {
  // strengthModifier is 0.55–1.45; subtracting 1 gives a −0.45…+0.45 edge, 0 being dead even.
  const edge = strengthModifier(ratingOf(blocker, 'strength'), ratingOf(defender, 'strength')) - 1
  if (edge < PANCAKE.MIN_STRENGTH_EDGE) return 0

  const skill  = (ratingOf(blocker, isRun ? 'runBlock' : 'passBlock') ?? 50) / 99
  // What the defender brings to stay upright: raw strength always, plus his pass-rush craft when
  // he is rushing the passer.
  const resist = isRun
    ? ratingOf(defender, 'strength') / 99
    : (ratingOf(defender, 'strength') / 99) * 0.5 + ((ratingOf(defender, 'passRush') ?? 50) / 99) * 0.5

  const strengthPart = (edge / 0.45) * PANCAKE.STRENGTH_WEIGHT      // 0…1 of its weight
  const skillPart    = (skill - resist) * PANCAKE.SKILL_WEIGHT      // can be negative
  return Math.max(0, Math.min(1, strengthPart + skillPart))
}

// Is this player currently flattened / frozen by a pancake?
export const isPancaked = (p) => (p?.pancakedFor ?? 0) > 0
export const isPancakeFrozen = (p) => (p?.pancakeFrozenFor ?? 0) > 0

// Clear every pancake flag — call between plays.
export function resetPancakes(state) {
  for (const p of state.offensePlayers.values()) p.pancakeFrozenFor = 0
  for (const p of state.defensePlayers.values()) { p.pancakedFor = 0; p.pancakedBy = null }
}

export function runPancake(state, _io, dt, rng = Math.random) {
  // ── Tick down anyone already down / frozen ──
  for (const d of state.defensePlayers.values()) {
    if (d.pancakedFor > 0) {
      // Snap to zero rather than trusting repeated subtraction to land there: 60 ticks of 0.05
      // leaves a float residue, which would keep him nominally "down" and never clear pancakedBy.
      d.pancakedFor = d.pancakedFor - dt <= 1e-9 ? 0 : d.pancakedFor - dt
      // Stay put. Velocity is zeroed here as well as in movement so nothing that ran earlier in
      // the tick can leave a pancaked man drifting.
      d.vx = 0; d.vy = 0
      if (d.pancakedFor === 0) d.pancakedBy = null
    }
  }
  for (const o of state.offensePlayers.values()) {
    if (o.pancakeFrozenFor > 0) {
      o.pancakeFrozenFor = o.pancakeFrozenFor - dt <= 1e-9 ? 0 : o.pancakeFrozenFor - dt
      o.vx = 0; o.vy = 0
    }
  }

  const isRun   = state.playDesign?.playType === 'run'
  const ballRef = findBallRef(state)
  const pairs   = detectEngagements(state.offensePlayers, state.defensePlayers, state.playDesign?.playType)

  for (const { offense: o, defense: d, dist } of pairs) {
    if (!BLOCKER_LABELS.has(o.label)) continue
    if (isPancaked(d) || isPancakeFrozen(o)) continue
    if (d.shedBlock) continue                       // he already beat the block — nothing to finish

    const lev = computeLeverage(o, d, ballRef)
    if (lev.score < PANCAKE.MIN_LEVERAGE) continue  // not winning decisively enough

    const score = pancakeMatchupScore(o, d, isRun)
    if (score <= 0) continue

    // Scale by how won the rep is and how square the contact is, then convert to a per-tick roll.
    const depth  = Math.max(0, (ENGAGEMENT_RADIUS - dist) / ENGAGEMENT_RADIUS)
    const chance = PANCAKE.MAX_RATE_PER_SECOND * score * lev.score * depth * dt
    if (rng() >= chance) continue

    d.pancakedFor = PANCAKE.DURATION_SECONDS
    d.pancakedBy  = o.id
    d.vx = 0; d.vy = 0
    d.shedBlock = false
    // On a pass the blocker goes down with him: he finished the block and is on the floor too, so
    // he cannot get up and go help elsewhere. On a run he keeps working upfield.
    if (!isRun) o.pancakeFrozenFor = PANCAKE.DURATION_SECONDS
  }
}
