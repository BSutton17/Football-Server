import { getRatings, ratingOf } from '../../data/ratings.js'

// ── Block-shed model ──────────────────────────────────────────────────────────
//
// A pass rusher engaged by a blocker accumulates a "win meter" each tick based on
// the rating matchup (passRush vs the blocker's strength) and the leverage battle.
// When the meter reaches SHED_THRESHOLD the rusher sheds the block: it breaks the
// engagement and bursts at full speed toward the QB.
//
// Time-to-SACK = shed time + the ~2 s sprint from the LOS to the QB. So to land an even-matchup
// sack in ~2.5–3 s ([pass-rush feedback]), the even block has to shed in well under a second:
//   Even linemen — sheds in ~0.8 s → sack in ~2.5–3 s.
//   Elite rusher vs weak blocker — sheds almost immediately.
//   Weak rusher vs good protection — rarely sheds within a play.
//
// This — NOT the pushForce constants — is what determines whether the rush gets home. (The
// pushForce "defense wins" branch only fires when the rusher beats the blocker's POSITIONAL
// leverage, which almost never happens in pass pro since the blocker sets up between the rusher
// and the QB. The rush arrives by SHEDDING here, then sprinting at the QB in runMovement.)
//
// Runs AFTER runEngagement (which sets isEngaged / engagedWithId / leverageScore)
// and BEFORE runMovement (which steers shed rushers straight at the QB).

// Baseline meter fill per second for an engaged rusher in an even matchup with
// neutral leverage. 1 / BASE_WIN_RATE ≈ seconds to shed an even block (AFTER the lock-up below).
const BASE_WIN_RATE = 0.8    // [pass-rush ramp] lowered from 1.3 — a rusher shouldn't win instantly

// [pass-rush ramp] A rusher must stay engaged ("locked up" with the blocker) for at least this long
// before it can begin to win the rep. During the lock the win-meter neither fills nor decays — the
// blocker is holding the block — so a rusher can't fire off the ball and immediately beat its man;
// it has to fight through the block over time. Elite rushers still win quickly AFTER the lock.
const ENGAGE_LOCK_TIME = 0.6   // seconds of engagement before a shed can start building

// How strongly the passRush-vs-strength rating gap scales the fill rate.
// winFactor ranges −1..1; at +1 the fill rate triples, at −1 it drops to zero.
const WIN_SENSITIVITY = 2.0

// How much the pocket leverage score modulates the fill rate. Positive leverage
// (blocker sitting between the rusher and the QB) slows the shed — the rusher
// must beat the blocker's angle to win quickly. Kept small so good protection slows
// the shed without freezing it ([pass-rush feedback]).
const LEVERAGE_WEIGHT = 0.3

// Meter value at which the rusher sheds the block.
export const SHED_THRESHOLD = 1.0

// Meter bleed per second while a rusher is engaged but losing, or not engaged.
const SHED_DECAY = 0.5

// Fallback blocker strength when an engaged blocker can't be resolved.
const DEFAULT_BLOCK_STRENGTH = 60

// A defender actively pass-rushes when it has no coverage assignment (DL auto-rush)
// or is explicitly blitzing. Man / zone / spy defenders never shed-rush.
export function isRusher(state, defender) {
  const type = state.defenseCoverage.get(defender.id)?.type
  return type == null || type === 'blitz'
}

// Per-tick advantage a rusher gains on its blocker, in meter-units per second.
// Positive fills the meter toward a shed; non-positive lets it decay.
//
//   rushRating    — defender's passRush rating (0–99)
//   blockStrength — blocker's strength rating (0–99)
//   leverageScore — pocket leverage from the defender's POV (+1 offense, −1 defense)
export function rushAdvantage(rushRating, blockStrength, leverageScore) {
  const winFactor = (rushRating - blockStrength) / 99            // −1..1
  const matchup   = BASE_WIN_RATE * (1 + WIN_SENSITIVITY * winFactor)
  return matchup - LEVERAGE_WEIGHT * leverageScore
}

export function runPassRush(state, _io, dt) {
  // Shedding only matters on pass plays — there's no pocket to collapse on a run.
  const playType = state.playDesign?.playType ?? 'pass'
  if (playType !== 'pass') return

  for (const d of state.defensePlayers.values()) {
    if (!isRusher(state, d)) {
      d.rushWinMeter = 0
      d.shedBlock    = false
      continue
    }

    // Once a rusher sheds, it stays free for the rest of the play.
    if (d.shedBlock) continue

    if (!d.isEngaged) {
      // Unblocked or just separated — the meter slowly bleeds toward zero and the lock resets.
      d.rushWinMeter  = Math.max(0, (d.rushWinMeter ?? 0) - SHED_DECAY * dt)
      d.engageElapsed = 0
      continue
    }

    // Time locked up in this engagement. Until ENGAGE_LOCK_TIME passes, the rusher is held and the
    // meter is frozen — it can't beat the block off the snap ([pass-rush ramp]).
    d.engageElapsed = (d.engageElapsed ?? 0) + dt

    const blocker  = d.engagedWithId ? state.offensePlayers.get(d.engagedWithId) : null
    const strength = blocker ? ratingOf(blocker, 'strength') : DEFAULT_BLOCK_STRENGTH
    const advantage = rushAdvantage(ratingOf(d, 'passRush') ?? 0, strength, d.leverageScore ?? 0)

    if (d.engageElapsed < ENGAGE_LOCK_TIME) {
      // Locked up — no progress either way; the block is holding.
    } else if (advantage > 0) {
      d.rushWinMeter = (d.rushWinMeter ?? 0) + advantage * dt
    } else {
      d.rushWinMeter = Math.max(0, (d.rushWinMeter ?? 0) - SHED_DECAY * dt)
    }

    if (d.rushWinMeter >= SHED_THRESHOLD) {
      d.shedBlock    = true
      d.rushWinMeter = SHED_THRESHOLD
    }
  }
}
