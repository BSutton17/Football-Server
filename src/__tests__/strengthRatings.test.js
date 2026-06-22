import { describe, it, expect } from '@jest/globals'
import { getRatings, strengthModifier } from '../data/ratings.js'
import { runPushForce }                 from '../game/systems/pushForce.js'

// ── strengthModifier unit tests ───────────────────────────────────────────────

describe('strengthModifier', () => {
  it('returns 1.0 when both sides have equal ratings', () => {
    expect(strengthModifier(50, 50)).toBeCloseTo(1.0)
    expect(strengthModifier(80, 80)).toBeCloseTo(1.0)
    expect(strengthModifier(0, 0)).toBeCloseTo(1.0)
  })

  it('returns > 1.0 when the blocker is stronger', () => {
    expect(strengthModifier(80, 50)).toBeGreaterThan(1.0)
  })

  it('returns < 1.0 when the defender is stronger', () => {
    expect(strengthModifier(50, 80)).toBeLessThan(1.0)
  })

  it('clamps to 1.45 at the maximum advantage (99 vs 0)', () => {
    expect(strengthModifier(99, 0)).toBeCloseTo(1.45)
  })

  it('clamps to 0.55 at the maximum disadvantage (0 vs 99)', () => {
    expect(strengthModifier(0, 99)).toBeCloseTo(0.55)
  })

  it('strMod and (2 - strMod) always sum to 2', () => {
    for (const [a, b] of [[99, 0], [0, 99], [50, 80], [82, 86], [70, 50]]) {
      const mod = strengthModifier(a, b)
      expect(mod + (2 - mod)).toBeCloseTo(2.0)
    }
  })

  it('is symmetric — swapping sides flips the modifier around 1.0', () => {
    const modAB = strengthModifier(80, 40)
    const modBA = strengthModifier(40, 80)
    expect(modAB + modBA).toBeCloseTo(2.0)
  })

  it('scales linearly between the two ratings', () => {
    const low  = strengthModifier(50, 0)   // 50/99 advantage
    const high = strengthModifier(99, 0)   // full advantage
    expect(high).toBeGreaterThan(low)
  })
})

// ── getRatings — strength attribute coverage ──────────────────────────────────

describe('getRatings — strength attribute', () => {
  const POSITIONS = ['WR', 'CB', 'S', 'RB', 'LB', 'TE', 'QB', 'DL', 'T', 'G', 'C', 'OL']

  it('every known position has a strength rating', () => {
    for (const pos of POSITIONS) {
      const r = getRatings(pos)
      expect(r.strength).toBeDefined()
      expect(typeof r.strength).toBe('number')
    }
  })

  it('every strength rating is in the 0–99 range', () => {
    for (const pos of POSITIONS) {
      const r = getRatings(pos)
      expect(r.strength).toBeGreaterThanOrEqual(0)
      expect(r.strength).toBeLessThanOrEqual(99)
    }
  })

  it('unknown position falls back to a default that includes strength', () => {
    const r = getRatings('UNKNOWN')
    expect(r.strength).toBeDefined()
    expect(r.strength).toBeGreaterThanOrEqual(0)
    expect(r.strength).toBeLessThanOrEqual(99)
  })

  it('DL is the strongest position', () => {
    const dlStr = getRatings('DL').strength
    for (const pos of ['WR', 'CB', 'RB', 'QB', 'S', 'LB', 'TE']) {
      expect(dlStr).toBeGreaterThan(getRatings(pos).strength)
    }
  })

  it('skill positions (WR/CB) are the weakest', () => {
    const wrStr = getRatings('WR').strength
    const cbStr = getRatings('CB').strength
    for (const pos of ['OL', 'DL', 'LB', 'TE', 'RB', 'S']) {
      expect(wrStr).toBeLessThan(getRatings(pos).strength)
      expect(cbStr).toBeLessThan(getRatings(pos).strength)
    }
  })
})

// ── Push force integration: stronger player dominates ────────────────────────

const DT = 0.05

function makeMap(players) {
  const m = new Map()
  for (const p of players) m.set(p.id, p)
  return m
}

function makeState({ offense = [], defense = [] } = {}) {
  return {
    offensePlayers: makeMap(offense),
    defensePlayers: makeMap(defense),
    ballCarrierId: null,
  }
}

// OL driving north into a DL, with identical geometry. Only the label changes.
function makeInsidePair(olLabel, dlLabel) {
  const qb = { id: 'qb', label: 'QB', x: 26, y: 50, vx: 0, vy: 0 }
  const ol = { id: 'ol', label: olLabel, x: 26, y: 58, vx: 0, vy: 4 }   // driving north
  const dl = { id: 'dl', label: dlLabel, x: 26, y: 60, vx: 0, vy: 0 }   // 2 yards away
  return { qb, ol, dl }
}

describe('runPushForce — strength affects force magnitude', () => {
  it('a stronger blocker (OL vs DL) pushes the defender more than a weaker blocker', () => {
    // Scenario A: OL (str=80) vs CB (str=48) — blocker strength advantage
    const { qb: qbA, ol: olA, dl: dlA } = makeInsidePair('OL', 'CB')
    const stateA = makeState({ offense: [olA, qbA], defense: [dlA] })

    // Scenario B: OL (str=80) vs DL (str=86) — defender strength advantage
    const { qb: qbB, ol: olB, dl: dlB } = makeInsidePair('OL', 'DL')
    const stateB = makeState({ offense: [olB, qbB], defense: [dlB] })

    runPushForce(stateA, null, DT)
    runPushForce(stateB, null, DT)

    // OL vs CB: CB should be pushed farther (blocker is stronger)
    // OL vs DL: DL should be pushed less (defender is stronger)
    expect(Math.abs(dlA.vy)).toBeGreaterThan(Math.abs(dlB.vy))
  })

  it('a stronger defender (DL vs WR) resists being pushed more than a weaker one', () => {
    // WR blocks with route='block' so they register as a blocker
    const makeWRBlocker = () => ({
      id: 'ol', label: 'WR', route: 'block', x: 26, y: 58, vx: 0, vy: 4,
    })

    const { qb: qbA, dl: dlA } = makeInsidePair('OL', 'CB')
    const wrA = makeWRBlocker()
    const stateA = makeState({ offense: [wrA, qbA], defense: [dlA] })

    const { qb: qbB, dl: dlB } = makeInsidePair('OL', 'DL')
    const wrB = makeWRBlocker()
    const stateB = makeState({ offense: [wrB, qbB], defense: [dlB] })

    runPushForce(stateA, null, DT)
    runPushForce(stateB, null, DT)

    // Same weak blocker (WR), but DL resists more than CB
    expect(Math.abs(dlA.vy)).toBeGreaterThan(Math.abs(dlB.vy))
  })

  it('blocker reaction is smaller when the blocker is stronger', () => {
    // Strong blocker scenario: OL (80) vs CB (48) — strMod high, reaction factor small
    const { qb: qbA, ol: olA, dl: dlA } = makeInsidePair('OL', 'CB')
    const stateA = makeState({ offense: [olA, qbA], defense: [dlA] })

    // Weak blocker scenario: WR (44) vs CB (48) — strMod slightly below 1, more reaction
    const { qb: qbB, dl: dlB } = makeInsidePair('WR', 'CB')
    const olB = { id: 'ol', label: 'WR', x: 26, y: 58, vx: 0, vy: 4 }
    const stateB = makeState({ offense: [olB, qbB], defense: [dlB] })

    runPushForce(stateA, null, DT)
    runPushForce(stateB, null, DT)

    // olA (OL, stronger) gets less reaction than olB (WR, weaker)
    expect(Math.abs(olA.vy)).toBeLessThan(Math.abs(olB.vy))
  })

  it('equal-strength matchup produces symmetric-ish forces (strMod ≈ 1)', () => {
    // Two positions with similar strength: OL (80) vs LB (74)
    const { qb, ol, dl: lb } = makeInsidePair('OL', 'LB')
    const state = makeState({ offense: [ol, qb], defense: [lb] })

    runPushForce(state, null, DT)

    const strMod = strengthModifier(
      getRatings('OL').strength,
      getRatings('LB').strength,
    )
    // strMod should be close to 1 for near-equal matchup
    expect(strMod).toBeGreaterThan(0.9)
    expect(strMod).toBeLessThan(1.2)
  })
})
