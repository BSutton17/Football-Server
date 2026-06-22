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
