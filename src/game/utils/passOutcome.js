// Base completion probability with no pressure and a clean pocket.
const BASE_ACCURACY = 0.85

// Each defender within PRESSURE_RADIUS cuts accuracy by this much.
const PRESSURE_PENALTY = 0.12

// Additional penalty when any defender is within HEAVY_PRESSURE_RADIUS.
const HEAVY_PRESSURE_PENALTY = 0.20

// Returns a 0.05–0.85 completion probability for the current tick.
// Reads qbPressureCount and qbUnderHeavyPressure written by runPressureDetection.
// Called by the throw handler when it resolves a pass attempt.
export function getThrowAccuracy(state) {
  const pressureCount = Math.min(3, state.qbPressureCount ?? 0)
  const heavy         = state.qbUnderHeavyPressure ?? false

  let accuracy = BASE_ACCURACY - pressureCount * PRESSURE_PENALTY
  if (heavy) accuracy -= HEAVY_PRESSURE_PENALTY

  return Math.max(0.05, accuracy)
}

// ── Instant pass resolution ([176]–[179], [pass-outcome feedback]) ────────────────
//
// A thrown pass resolves with no ball-flight simulation. The receiver's coverage TIER — the same
// red/yellow/green window the QB sees — sets the base odds of a catch, a broken-up/dropped ball,
// or an interception. The receiver's hands and the QB's accuracy then nudge those odds.

function clamp01(v) {
  return Math.max(0, Math.min(1, v))
}

function clampRating(r) {
  return Math.max(0, Math.min(99, r ?? 50))
}

// Coverage tier thresholds — these MUST match the client's red/yellow/green coloring
// (opennessFill in renderer.ts) so the outcome matches the window the QB actually saw.
export const OPENNESS_OPEN = 0.66   // ≥ this → open (green)
export const OPENNESS_RED  = 0.33   // < this → smothered (red); in between → covered (yellow)

export function opennessTier(openness) {
  if (openness >= OPENNESS_OPEN) return 'open'
  if (openness >= OPENNESS_RED)  return 'covered'
  return 'smothered'
}

// Base catch / interception split per tier ([pass-outcome feedback]). The remaining probability is
// the ball falling incomplete — a drop on an open window, a break-up under coverage:
//   open      → 95% catch,  5% drop,                    0% INT
//   covered   → 55% catch, 40% broken up,               5% INT
//   smothered → 10% catch, 70% broken up,              20% INT
// These are the odds at neutral ratings, before the catch/accuracy modifiers below.
const TIER_ODDS = {
  open:      { catch: 0.95, int: 0.00 },
  covered:   { catch: 0.55, int: 0.05 },
  smothered: { catch: 0.10, int: 0.20 },
}

// All rating modifiers are measured from a NEUTRAL rating: a 66/66 throw lands exactly on the
// published base odds, and ratings above/below shift them by the amounts below. (The endpoints
// the user specified — 0 and 99 — sit on a single line through this neutral point.)
const NEUTRAL_RATING = 66

// Receiver hands swing the catch rate: 99 catch → +5%, 0 catch → −10% (0 at the neutral rating).
function catchRatingMod(receiverCatch) {
  return ((clampRating(receiverCatch) - NEUTRAL_RATING) / 99) * 0.15
}

// QB accuracy swings the catch rate: 99 → +10%, 0 → −20% (0 at the neutral rating).
function accuracyCatchMod(qbAccuracy) {
  return ((clampRating(qbAccuracy) - NEUTRAL_RATING) / 99) * 0.30
}

// QB accuracy swings the pick rate on covered/smothered windows: 0 → +5% INT, 0 at neutral, and a
// little below for an elite passer (an accurate QB throws fewer picks).
function accuracyIntMod(qbAccuracy) {
  return ((NEUTRAL_RATING - clampRating(qbAccuracy)) / NEUTRAL_RATING) * 0.05
}

// Catch / interception / incomplete probabilities for a window, given the receiver's hands and the
// QB's accuracy. catchP + intP + incompleteP === 1.
export function passProbabilities(openness, qbAccuracy = 50, receiverCatch = 50) {
  const tier = opennessTier(openness)
  const base = TIER_ODDS[tier]

  let catchP = clamp01(base.catch + catchRatingMod(receiverCatch) + accuracyCatchMod(qbAccuracy))
  // Open windows are never picked; coverage windows take the accuracy pick bump.
  let intP   = tier === 'open' ? 0 : clamp01(base.int + accuracyIntMod(qbAccuracy))

  // Catch and pick can't sum past certainty — the broken-up/drop slice absorbs the rest; if they
  // do overflow, trim the pick first, then the catch.
  if (catchP + intP > 1) {
    intP   = Math.max(0, 1 - catchP)
    catchP = Math.min(1, catchP)
  }

  return { tier, catchP, intP, incompleteP: clamp01(1 - catchP - intP) }
}

// Resolve a pass instantly. Returns { outcome, reason }:
//   outcome — 'complete' | 'incomplete' | 'intercepted'
//   reason  — 'caught' | 'drop' (open) | 'broken_up' (coverage) | 'intercepted'
//   interceptionEligible — ball thrown into a defender (throwaway-at-coverage): a near-certain pick.
//   rng — injectable for tests; defaults to Math.random.
export function resolvePass(
  { openness, qbAccuracy = 50, receiverCatch = 50, interceptionEligible = false },
  rng = Math.random,
) {
  if (interceptionEligible) {
    // Thrown straight at a defender — overwhelmingly a pick, occasionally knocked down.
    return rng() < 0.85
      ? { outcome: 'intercepted', reason: 'intercepted' }
      : { outcome: 'incomplete',  reason: 'broken_up' }
  }

  const { tier, catchP, intP } = passProbabilities(openness, qbAccuracy, receiverCatch)

  const roll = rng()
  if (roll < catchP)        return { outcome: 'complete',    reason: 'caught' }
  if (roll < catchP + intP) return { outcome: 'intercepted', reason: 'intercepted' }
  return { outcome: 'incomplete', reason: tier === 'open' ? 'drop' : 'broken_up' }
}
