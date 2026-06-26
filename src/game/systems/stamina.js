import { ratingOf, drainFromStaminaRating } from '../../data/ratings.js'

// Linemen can't be subbed, so they don't accumulate fatigue.
const LINEMAN = new Set(['OL', 'C', 'G', 'T', 'DL'])

function isLineman(label) {
  return LINEMAN.has(label ?? '')
}

// slot — which team (0 | 1) this player belongs to, so fatigue can be reported to the right viewer
// even after the per-play offense/defense maps are wiped at a play boundary ([fatigue]).
function getOrInit(state, playerId, label, slot) {
  if (!state.playerFatigue.has(playerId)) {
    state.playerFatigue.set(playerId, { stamina: 100, label: label ?? '', slot })
  }
  const f = state.playerFatigue.get(playerId)
  if (!f.label && label) f.label = label
  if (f.slot == null && slot != null) f.slot = slot
  return f
}

// Receivers who have settled at their route endpoint are standing still — drain at 30%.
const SETTLED_DRAIN_FACTOR = 0.3

// Global drain scale — players tire more slowly ([fatigue feedback]: drain lowered 35%).
const DRAIN_SCALE = 0.65

// Called each LIVE tick — drain stamina based on position rating.
// Linemen are skipped. Settled receivers (waiting for the ball) drain much slower.
export function drainStamina(state, _io, dt) {
  // A player's team slot is fixed: the offense is the team with possession, the defense the other.
  const offenseSlot = state.possession
  const defenseSlot = 1 - state.possession
  for (const p of state.offensePlayers.values()) {
    if (isLineman(p.label)) continue
    const f    = getOrInit(state, p.id, p.label, offenseSlot)
    const rate = drainFromStaminaRating(ratingOf(p, 'stamina'))
    const mult = p.routePhase === 'settled' ? SETTLED_DRAIN_FACTOR : 1.0
    f.stamina  = Math.max(0, f.stamina - rate * mult * DRAIN_SCALE * dt)
  }
  for (const p of state.defensePlayers.values()) {
    if (isLineman(p.label)) continue
    const f    = getOrInit(state, p.id, p.label, defenseSlot)
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
