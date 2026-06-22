// A defender within this radius affects the QB's ability to throw accurately.
export const PRESSURE_RADIUS = 3.0   // yards

// Within this radius a defender is about to make contact — heavy pressure.
export const HEAVY_PRESSURE_RADIUS = 1.5  // yards

// Scans all defenders each tick and writes pressure state onto the game state.
// Other systems (passOutcome, sackDetection) read these values rather than
// re-scanning on their own.
export function runPressureDetection(state, _io, _dt) {
  let qb = null
  for (const p of state.offensePlayers.values()) {
    if (p.label === 'QB') { qb = p; break }
  }

  if (!qb) {
    state.qbPressureCount      = 0
    state.qbUnderHeavyPressure = false
    return
  }

  let count        = 0
  let heavyPressure = false

  for (const d of state.defensePlayers.values()) {
    const dx   = d.x - qb.x
    const dy   = d.y - qb.y
    const dist = Math.sqrt(dx * dx + dy * dy)

    if (dist <= PRESSURE_RADIUS) {
      count++
      if (dist <= HEAVY_PRESSURE_RADIUS) heavyPressure = true
    }
  }

  state.qbPressureCount      = count
  state.qbUnderHeavyPressure = heavyPressure
}
