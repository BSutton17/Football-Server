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

// Global drain scale — players tire more slowly ([fatigue feedback]: drain lowered 35%).
const DRAIN_SCALE = 0.65

// ── Effort model ([fatigue effort]) ─────────────────────────────────────────────
// Drain scales with how hard a player is working THIS tick, so stamina tracks effort. Movement speed
// (from vx/vy) is the proxy: a player standing still barely tires, a full sprint tires fast. On top of
// that, the ball carrier works hardest (cutting, contact, fighting for yards) and a blocker works less
// than an open-field runner. This makes an RB on a run, or a WR on a go, drain more than a WR on a
// slant (which settles early) or a blocking TE — without any per-route bookkeeping.
const EFFORT_REF_SPEED = 8      // yd/s treated as "full sprint" for the effort ramp (top speed ≈ 9.5)
const IDLE_EFFORT      = 0.3    // multiplier when standing still (matches the old settled-receiver rate)
const SPRINT_EFFORT    = 1.35   // multiplier at full sprint
const CARRIER_EFFORT   = 1.3    // extra exertion for the ball carrier
const BLOCK_EFFORT     = 0.5    // blocking caps effort low — costs less than running

function effortMultiplier(p, isCarrier) {
  const speed     = Math.hypot(p.vx ?? 0, p.vy ?? 0)
  const speedFrac = Math.min(1, speed / EFFORT_REF_SPEED)
  let effort      = IDLE_EFFORT + speedFrac * (SPRINT_EFFORT - IDLE_EFFORT)
  if (p.route === 'block') effort = Math.min(effort, BLOCK_EFFORT)   // a blocker isn't sprinting
  if (isCarrier)           effort *= CARRIER_EFFORT                   // the ball carrier works hardest
  return effort
}

// Who's carrying the ball this tick (mirrors movement.findBallCarrier's core, inlined to avoid a
// circular import): the explicit carrier on either side, else the designed RB on a run play.
function ballCarrierId(state) {
  if (state.ballCarrierId) return state.ballCarrierId
  if (state.playDesign?.playType === 'run') {
    for (const p of state.offensePlayers.values()) if (p.label === 'RB') return p.id
  }
  return null
}

// Called each LIVE tick — drain stamina based on position rating AND effort this tick. Linemen skipped.
export function drainStamina(state, _io, dt) {
  // A player's team slot is fixed: the offense is the team with possession, the defense the other.
  const offenseSlot = state.possession
  const defenseSlot = 1 - state.possession
  const carrierId   = ballCarrierId(state)
  const drainOne = (p, slot) => {
    if (isLineman(p.label)) return
    const f    = getOrInit(state, p.id, p.label, slot)
    const rate = drainFromStaminaRating(ratingOf(p, 'stamina'))
    f.stamina  = Math.max(0, f.stamina - rate * effortMultiplier(p, p.id === carrierId) * DRAIN_SCALE * dt)
  }
  for (const p of state.offensePlayers.values()) drainOne(p, offenseSlot)
  for (const p of state.defensePlayers.values()) drainOne(p, defenseSlot)
}

// ── One-time contact costs ([fatigue effort]) ───────────────────────────────────
// A collision is a burst of effort on top of the continuous drain, so a tackle tires both players.
const TACKLE_COST_CARRIER = 6   // the ball carrier absorbing the hit / fighting through it
const TACKLE_COST_TACKLER = 5   // the defender who makes the tackle

// Subtract a one-time stamina hit from a tracked player (linemen aren't tracked → no-op). Clamped ≥0.
export function applyStaminaHit(state, playerId, amount) {
  const f = state.playerFatigue?.get(playerId)
  if (!f || !Number.isFinite(f.stamina)) return
  f.stamina = Math.max(0, f.stamina - amount)
}

// A tackle tires the ball carrier and the tackler (the nearest tracked defender to the dead-ball spot).
// Call from the tackle handler with the tackle location (absolute field coords).
export function applyTackleStamina(state, carrierId, x, y) {
  if (carrierId) applyStaminaHit(state, carrierId, TACKLE_COST_CARRIER)
  let bestId = null, bestDist = Infinity
  for (const p of state.defensePlayers?.values() ?? []) {
    if (isLineman(p.label)) continue
    const d = Math.hypot((p.x ?? 0) - x, (p.y ?? 0) - y)
    if (d < bestDist) { bestDist = d; bestId = p.id }
  }
  if (bestId) applyStaminaHit(state, bestId, TACKLE_COST_TACKLER)
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
