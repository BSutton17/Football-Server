import { PLAYER } from '../../constants.js'

// Per-position mass (arbitrary units) used by collision response: heavier bodies hold their
// ground and shove lighter ones aside. Linemen anchor; skill players get displaced. Falls
// back to an average mass for unlabeled players (e.g. in unit tests).
const MASS = {
  T: 1.7, G: 1.7, C: 1.7, OL: 1.7,
  DL: 1.6, TE: 1.35, LB: 1.2,
  RB: 1.0, QB: 0.95, S: 0.95,
  WR: 0.85, CB: 0.85,
}
const DEFAULT_MASS = 1.0

export function massForLabel(label) {
  return MASS[label] ?? DEFAULT_MASS
}

// Returns overlap data between two circular bodies, or null if they are not touching.
//
// Return value { depth, nx, ny }:
//   depth — yards of penetration (always > 0 when returned)
//   nx/ny — unit normal pointing FROM b TOWARD a
//            Push a by +(nx*depth) and b by -(nx*depth) to separate them.
//
// radiusA/radiusB default to PLAYER.RADIUS so callers rarely need to pass them.
export function circleOverlap(a, b, radiusA = PLAYER.RADIUS, radiusB = PLAYER.RADIUS) {
  const dx   = a.x - b.x
  const dy   = a.y - b.y
  const d2   = dx * dx + dy * dy
  const minD = radiusA + radiusB

  if (!Number.isFinite(d2) || d2 >= minD * minD) return null

  const dist  = Math.sqrt(d2)
  const depth = minD - dist

  // Guard against perfectly-stacked players (dist ≈ 0) to avoid NaN normals.
  const nx = dist > 0.0001 ? dx / dist : 1
  const ny = dist > 0.0001 ? dy / dist : 0

  return { depth, nx, ny }
}

// Scans every offense×defense pair and returns all overlapping pairs.
// Each entry: { offense, defense, depth, nx, ny }
// nx/ny always point from the defensive player toward the offensive player.
export function detectCollisions(offensePlayers, defensePlayers) {
  const collisions = []

  for (const o of offensePlayers.values()) {
    for (const d of defensePlayers.values()) {
      const overlap = circleOverlap(o, d)
      if (overlap) collisions.push({ offense: o, defense: d, ...overlap })
    }
  }

  return collisions
}
