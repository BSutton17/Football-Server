// Returns every player from one or more Maps that lies within `radius` yards
// of the point (x, y).
//
// Usage:
//   getPlayersNear([state.offensePlayers], qb.x, qb.y, 5)
//   getPlayersNear([state.offensePlayers, state.defensePlayers], x, y, 3)
export function getPlayersNear(maps, x, y, radius) {
  const r2      = radius * radius
  const results = []

  for (const map of maps) {
    for (const p of map.values()) {
      const dx = p.x - x
      const dy = p.y - y
      if (dx * dx + dy * dy <= r2) results.push(p)
    }
  }

  return results
}

// Returns the single player closest to (x, y), searching across all provided Maps.
// Returns null if all maps are empty.
// excludeId — optional ID to skip (e.g., exclude the querying player itself).
export function getClosestPlayer(maps, x, y, excludeId = null) {
  let closest = null
  let bestD2  = Infinity

  for (const map of maps) {
    for (const p of map.values()) {
      if (p.id === excludeId) continue
      const dx = p.x - x
      const dy = p.y - y
      const d2 = dx * dx + dy * dy
      if (d2 < bestD2) { bestD2 = d2; closest = p }
    }
  }

  return closest
}

// Returns the distance in yards between two players (or any {x,y} objects).
export function distanceBetween(a, b) {
  const dx = a.x - b.x
  const dy = a.y - b.y
  return Math.sqrt(dx * dx + dy * dy)
}

// ── [interior seam] The three linemen a back can squeeze between ─────────────
//
// A running back is far smaller than the men blocking for him and in reality slips through the
// creases between the center and the two guards. Both the collision solver (which lets him pass
// through them) and the vision model (which stops treating them as a wall) need to agree on
// exactly which three those are, so the definition lives here.
//
// Worked out from where the linemen LINED UP (blockAnchorX, latched at the snap) rather than where
// they have since been driven, so a line getting pushed around cannot change mid-play which bodies
// the back is allowed to fit between. Tackles and a kept-in tight end are deliberately excluded —
// running through THOSE is what the edge is for.
const INTERIOR_LINEMEN = 3
const INTERIOR_LABELS = new Set(['OL', 'C', 'G', 'T'])

export function interiorLinemanIds(offensePlayers, ballX) {
  const line = []
  for (const o of offensePlayers.values()) {
    if (!INTERIOR_LABELS.has(o.label)) continue
    line.push({ id: o.id, dx: Math.abs((o.blockAnchorX ?? o.x) - ballX) })
  }
  line.sort((a, b) => a.dx - b.dx)
  return new Set(line.slice(0, INTERIOR_LINEMEN).map(l => l.id))
}
