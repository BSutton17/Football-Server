import { FIELD, PLAYER } from '../../constants.js'
import { circleOverlap, detectCollisions, massForLabel } from '../utils/collision.js'

// Coefficient of restitution: 0 = no bounce (perfectly inelastic). Football contact is
// sticky, not springy.
const RESTITUTION = 0.0

// Velocity retention applied to the ball carrier per tick while a defender is in contact —
// a defender getting hands on the carrier before the tackle.
const TACKLE_DRAG = 0.55

// Velocity retention for any non-carrier offensive player in contact with a defender
// (a receiver caught in coverage, or a blocker being shed).
const CONTACT_DRAG = 0.82

// Positional separation is run as an iterative relaxation solver over EVERY pair of players
// (offense-offense, defense-defense, offense-defense). Players are circles and must never
// overlap — the goal is compression, not intersection. Each pass resolves most of every
// overlap; several passes converge crowded piles to zero penetration, with the early-out
// stopping as soon as a pass finds nothing left to separate.
const SEPARATION_ITERATIONS = 10
const SEPARATION_RELAX      = 0.7   // fraction of each overlap resolved per pass

const clampX = (x) => Math.max(PLAYER.RADIUS, Math.min(FIELD.WIDTH  - PLAYER.RADIUS, x))
const clampY = (y) => Math.max(PLAYER.RADIUS, Math.min(FIELD.LENGTH - PLAYER.RADIUS, y))

export function runCollisionResponse(state, _io, _dt) {
  // ── 1. Velocity impulse + engagement drag (offense vs defense contacts) ───────
  // Resolved once per contact from the current overlap, before separation moves anyone.
  for (const { offense: o, defense: d, nx, ny } of detectCollisions(state.offensePlayers, state.defensePlayers)) {
    const vRel = (o.vx - d.vx) * nx + (o.vy - d.vy) * ny   // <0 means they're approaching

    if (vRel <= 0) {
      // Mass-weighted inelastic impulse: the heavier body's velocity changes less.
      const invO = 1 / (o.mass ?? massForLabel(o.label))
      const invD = 1 / (d.mass ?? massForLabel(d.label))
      const j    = -(1 + RESTITUTION) * vRel / (invO + invD)
      o.vx += j * invO * nx;  o.vy += j * invO * ny
      d.vx -= j * invD * nx;  d.vy -= j * invD * ny
    }

    // Engagement drag — slow the offensive player by role once contact is made.
    if (o.id === state.ballCarrierId) {
      o.vx *= TACKLE_DRAG;  o.vy *= TACKLE_DRAG
    } else {
      o.vx *= CONTACT_DRAG; o.vy *= CONTACT_DRAG
    }
  }

  // ── 2. Positional separation — no two circles may overlap ─────────────────────
  const players = [...state.offensePlayers.values(), ...state.defensePlayers.values()]

  for (let iter = 0; iter < SEPARATION_ITERATIONS; iter++) {
    let resolved = 0
    for (let i = 0; i < players.length; i++) {
      for (let k = i + 1; k < players.length; k++) {
        const a = players[i]
        const b = players[k]
        const ov = circleOverlap(a, b)   // nx/ny point from b toward a
        if (!ov) continue

        // Split the push inversely to mass — the lighter player yields more ground, so
        // linemen form walls and defenders flow around them rather than clipping through.
        const ma    = a.mass ?? massForLabel(a.label)
        const mb    = b.mass ?? massForLabel(b.label)
        const total = ma + mb
        const push  = ov.depth * SEPARATION_RELAX

        a.x = clampX(a.x + ov.nx * push * (mb / total))
        a.y = clampY(a.y + ov.ny * push * (mb / total))
        b.x = clampX(b.x - ov.nx * push * (ma / total))
        b.y = clampY(b.y - ov.ny * push * (ma / total))
        resolved++
      }
    }
    if (resolved === 0) break   // everyone is separated — nothing left to do
  }
}
