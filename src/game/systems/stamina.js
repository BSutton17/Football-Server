import { ratingOf, drainFromStaminaRating } from '../../data/ratings.js'

// Linemen can't be subbed, so they don't accumulate fatigue.
const LINEMAN = new Set(['OL', 'C', 'G', 'T', 'DL'])

function isLineman(label) {
  return LINEMAN.has(label ?? '')
}

function getOrInit(state, playerId, label) {
  if (!state.playerFatigue.has(playerId)) {
    state.playerFatigue.set(playerId, { stamina: 100, label: label ?? '' })
  }
  const f = state.playerFatigue.get(playerId)
  if (!f.label && label) f.label = label
  return f
}

// Receivers who have settled at their route endpoint are standing still — drain at 30%.
const SETTLED_DRAIN_FACTOR = 0.3

// Global drain scale — players tire more slowly ([fatigue feedback]: drain lowered 35%).
const DRAIN_SCALE = 0.65

// Called each LIVE tick — drain stamina based on position rating.
// Linemen are skipped. Settled receivers (waiting for the ball) drain much slower.
export function drainStamina(state, _io, dt) {
  for (const p of state.offensePlayers.values()) {
    if (isLineman(p.label)) continue
    const f    = getOrInit(state, p.id, p.label)
    const rate = drainFromStaminaRating(ratingOf(p, 'stamina'))
    const mult = p.routePhase === 'settled' ? SETTLED_DRAIN_FACTOR : 1.0
    f.stamina  = Math.max(0, f.stamina - rate * mult * DRAIN_SCALE * dt)
  }
  for (const p of state.defensePlayers.values()) {
    if (isLineman(p.label)) continue
    const f    = getOrInit(state, p.id, p.label)
    const rate = drainFromStaminaRating(ratingOf(p, 'stamina'))
    f.stamina  = Math.max(0, f.stamina - rate * DRAIN_SCALE * dt)
  }
}

// Recovers (fractionOfLost * lost stamina) for every non-lineman.
// Called on possession change (0.5) and at the start of Q3 (0.8).
export function recoverStamina(state, fractionOfLost) {
  for (const f of state.playerFatigue.values()) {
    if (isLineman(f.label)) continue
    const lost = 100 - f.stamina
    f.stamina  = Math.min(100, f.stamina + lost * fractionOfLost)
  }
}

// Returns a 0.7–1.0 speed/accel multiplier based on current stamina bar (0–100).
// Linemen are never in the fatigue map → returns 1.0 (no penalty).
export function getFatigueMult(state, playerId) {
  const f = state.playerFatigue.get(playerId)
  if (!f || !Number.isFinite(f.stamina)) return 1.0
  return 0.7 + 0.3 * (f.stamina / 100)
}
