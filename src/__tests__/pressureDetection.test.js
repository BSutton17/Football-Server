import { describe, it, expect } from '@jest/globals'
import { runPressureDetection, PRESSURE_RADIUS, HEAVY_PRESSURE_RADIUS } from '../game/systems/pressureDetection.js'

function makeMap(players) {
  const m = new Map()
  for (const p of players) m.set(p.id, p)
  return m
}

function makeState({ offense = [], defense = [] } = {}) {
  return {
    offensePlayers: makeMap(offense),
    defensePlayers: makeMap(defense),
    qbPressureCount:      0,
    qbUnderHeavyPressure: false,
  }
}

function qb(x = 26, y = 30) {
  return { id: 'qb', label: 'QB', x, y }
}

// Place a defender at exactly `dist` yards north of the QB
function defAt(dist, id = 'd1') {
  return { id, label: 'DL', x: 26, y: 30 + dist }
}

// ── Constants ─────────────────────────────────────────────────────────────────

describe('exported constants', () => {
  it('PRESSURE_RADIUS is 3.0 yards', () => {
    expect(PRESSURE_RADIUS).toBe(3.0)
  })

  it('HEAVY_PRESSURE_RADIUS is 1.5 yards — strictly less than PRESSURE_RADIUS', () => {
    expect(HEAVY_PRESSURE_RADIUS).toBe(1.5)
    expect(HEAVY_PRESSURE_RADIUS).toBeLessThan(PRESSURE_RADIUS)
  })
})

// ── No QB on field ────────────────────────────────────────────────────────────

describe('no QB on field', () => {
  it('resets pressure count to 0 and clears heavy pressure', () => {
    const state = makeState({ defense: [defAt(1)] })
    state.qbPressureCount      = 3   // stale from a previous tick
    state.qbUnderHeavyPressure = true

    runPressureDetection(state, null, 0.05)

    expect(state.qbPressureCount).toBe(0)
    expect(state.qbUnderHeavyPressure).toBe(false)
  })
})

// ── Pressure radius detection ─────────────────────────────────────────────────

describe('pressure radius detection', () => {
  it('defender outside PRESSURE_RADIUS → qbPressureCount stays 0', () => {
    const state = makeState({ offense: [qb()], defense: [defAt(PRESSURE_RADIUS + 0.1)] })

    runPressureDetection(state, null, 0.05)

    expect(state.qbPressureCount).toBe(0)
  })

  it('defender exactly at PRESSURE_RADIUS → counted as pressuring', () => {
    const state = makeState({ offense: [qb()], defense: [defAt(PRESSURE_RADIUS)] })

    runPressureDetection(state, null, 0.05)

    expect(state.qbPressureCount).toBe(1)
  })

  it('defender inside PRESSURE_RADIUS → counted', () => {
    const state = makeState({ offense: [qb()], defense: [defAt(PRESSURE_RADIUS - 0.5)] })

    runPressureDetection(state, null, 0.05)

    expect(state.qbPressureCount).toBe(1)
  })

  it('two defenders inside PRESSURE_RADIUS → count is 2', () => {
    const state = makeState({
      offense: [qb()],
      defense: [defAt(1.0, 'd1'), defAt(2.0, 'd2')],
    })

    runPressureDetection(state, null, 0.05)

    expect(state.qbPressureCount).toBe(2)
  })

  it('one inside and one outside → count is 1', () => {
    const state = makeState({
      offense: [qb()],
      defense: [defAt(1.0, 'd1'), defAt(PRESSURE_RADIUS + 1, 'd2')],
    })

    runPressureDetection(state, null, 0.05)

    expect(state.qbPressureCount).toBe(1)
  })

  it('no defenders on field → count is 0', () => {
    const state = makeState({ offense: [qb()] })

    runPressureDetection(state, null, 0.05)

    expect(state.qbPressureCount).toBe(0)
  })
})

// ── Heavy pressure detection ──────────────────────────────────────────────────

describe('heavy pressure detection', () => {
  it('defender outside HEAVY_PRESSURE_RADIUS but inside PRESSURE_RADIUS → no heavy pressure', () => {
    const dist  = (PRESSURE_RADIUS + HEAVY_PRESSURE_RADIUS) / 2   // between the two radii
    const state = makeState({ offense: [qb()], defense: [defAt(dist)] })

    runPressureDetection(state, null, 0.05)

    expect(state.qbPressureCount).toBe(1)
    expect(state.qbUnderHeavyPressure).toBe(false)
  })

  it('defender exactly at HEAVY_PRESSURE_RADIUS → heavy pressure flagged', () => {
    const state = makeState({ offense: [qb()], defense: [defAt(HEAVY_PRESSURE_RADIUS)] })

    runPressureDetection(state, null, 0.05)

    expect(state.qbUnderHeavyPressure).toBe(true)
  })

  it('defender inside HEAVY_PRESSURE_RADIUS → heavy pressure flagged', () => {
    const state = makeState({ offense: [qb()], defense: [defAt(0.5)] })

    runPressureDetection(state, null, 0.05)

    expect(state.qbUnderHeavyPressure).toBe(true)
  })

  it('no defender inside any radius → heavy pressure is false', () => {
    const state = makeState({ offense: [qb()], defense: [defAt(PRESSURE_RADIUS + 2)] })

    runPressureDetection(state, null, 0.05)

    expect(state.qbUnderHeavyPressure).toBe(false)
  })

  it('heavy pressure is set even when a second defender is farther out', () => {
    const state = makeState({
      offense: [qb()],
      defense: [
        defAt(0.5, 'd_close'),      // inside HEAVY_PRESSURE_RADIUS
        defAt(PRESSURE_RADIUS - 0.1, 'd_far'),  // inside PRESSURE_RADIUS only
      ],
    })

    runPressureDetection(state, null, 0.05)

    expect(state.qbPressureCount).toBe(2)
    expect(state.qbUnderHeavyPressure).toBe(true)
  })
})

// ── Result overwrites stale state ─────────────────────────────────────────────

describe('stale state is overwritten each tick', () => {
  it('pressure count decreases when defenders move out of range', () => {
    const d = defAt(1.0)
    const state = makeState({ offense: [qb()], defense: [d] })

    runPressureDetection(state, null, 0.05)
    expect(state.qbPressureCount).toBe(1)

    // Defender moves away
    d.y = 30 + PRESSURE_RADIUS + 2
    runPressureDetection(state, null, 0.05)
    expect(state.qbPressureCount).toBe(0)
  })

  it('heavy pressure clears when the close defender moves away', () => {
    const d = defAt(0.5)
    const state = makeState({ offense: [qb()], defense: [d] })

    runPressureDetection(state, null, 0.05)
    expect(state.qbUnderHeavyPressure).toBe(true)

    d.y = 30 + PRESSURE_RADIUS + 2
    runPressureDetection(state, null, 0.05)
    expect(state.qbUnderHeavyPressure).toBe(false)
  })
})
