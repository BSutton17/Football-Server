import { describe, it, expect } from '@jest/globals'
import { passRushModifier, getRatings } from '../data/ratings.js'
import { runPushForce }                 from '../game/systems/pushForce.js'

// ── passRushModifier unit tests ───────────────────────────────────────────────

describe('passRushModifier', () => {
  it('returns 0 when rush rating equals block strength', () => {
    expect(passRushModifier(50, 50)).toBeCloseTo(0)
    expect(passRushModifier(80, 80)).toBeCloseTo(0)
    expect(passRushModifier(0, 0)).toBeCloseTo(0)
  })

  it('returns positive when rusher dominates (high rush, low block)', () => {
    expect(passRushModifier(80, 40)).toBeGreaterThan(0)
  })

  it('returns negative when blocker dominates (low rush, high block)', () => {
    expect(passRushModifier(40, 80)).toBeLessThan(0)
  })

  it('maximum positive bias at 99 vs 0 is +0.6', () => {
    expect(passRushModifier(99, 0)).toBeCloseTo(0.6)
  })

  it('maximum negative bias at 0 vs 99 is -0.6', () => {
    expect(passRushModifier(0, 99)).toBeCloseTo(-0.6)
  })

  it('is antisymmetric — swapping args negates the result', () => {
    const bias = passRushModifier(80, 40)
    expect(passRushModifier(40, 80)).toBeCloseTo(-bias)
  })

  it('scales with rating gap — larger gap produces larger bias', () => {
    const small = Math.abs(passRushModifier(60, 50))
    const large = Math.abs(passRushModifier(90, 50))
    expect(large).toBeGreaterThan(small)
  })

  it('DL (passRush=82) vs OL (strength=80) — marginal positive bias', () => {
    const bias = passRushModifier(getRatings('DL').passRush, getRatings('OL').strength)
    expect(bias).toBeGreaterThan(0)
    expect(bias).toBeLessThan(0.1)
  })

  it('LB blitz (passRush=62) vs T (strength=82) — negative bias (blocker advantage)', () => {
    const bias = passRushModifier(getRatings('LB').passRush, getRatings('T').strength)
    expect(bias).toBeLessThan(0)
  })

  it('every known position has a numeric passRush rating in 0–99', () => {
    const POSITIONS = ['WR', 'CB', 'S', 'RB', 'LB', 'TE', 'QB', 'DL', 'T', 'G', 'C', 'OL']
    for (const pos of POSITIONS) {
      const { passRush } = getRatings(pos)
      expect(typeof passRush).toBe('number')
      expect(passRush).toBeGreaterThanOrEqual(0)
      expect(passRush).toBeLessThanOrEqual(99)
    }
  })

  it('DL has the highest passRush rating among all positions', () => {
    const dlRush = getRatings('DL').passRush
    for (const pos of ['WR', 'CB', 'RB', 'QB', 'TE', 'OL', 'T', 'G', 'C', 'S']) {
      expect(dlRush).toBeGreaterThan(getRatings(pos).passRush)
    }
  })

  it('skill positions (WR, QB) have zero or near-zero passRush', () => {
    expect(getRatings('WR').passRush).toBe(0)
    expect(getRatings('QB').passRush).toBe(0)
  })
})

// ── Integration: pass-rush bias affects push force outcome ────────────────────

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

// OL at (26, 58) driving north (vy=4) into a defender at (26, 60).
// QB (ball reference) at (26, 50) — south of OL.
function makeEngagedPair(defLabel) {
  const qb  = { id: 'qb',  label: 'QB',      x: 26, y: 50, vx: 0, vy: 0 }
  const ol  = { id: 'ol',  label: 'OL',      x: 26, y: 58, vx: 0, vy: 4 }
  const def = { id: 'def', label: defLabel,  x: 26, y: 60, vx: 0, vy: 0 }
  return { qb, ol, def }
}

describe('pass-rush bias integration with runPushForce', () => {
  it('DL (passRush=82) causes more OL pushback than a zero-rush defender (WR, passRush=0)', () => {
    // Scenario A: DL rushes OL — rushBias ≈ +0.01 → leverage shifts toward defense → OL driven back
    const { qb: qa, ol: ola, def: defA } = makeEngagedPair('DL')
    const stateA = makeState({ offense: [ola, qa], defense: [defA] })

    // Scenario B: WR as defender — rushBias ≈ -0.49 → leverage shifts toward offense → OL barely pushed
    const { qb: qb_, ol: olb, def: defB } = makeEngagedPair('WR')
    const stateB = makeState({ offense: [olb, qb_], defense: [defB] })

    runPushForce(stateA, null, DT)
    runPushForce(stateB, null, DT)

    // ola pushed back harder (more negative vy) when facing elite rusher
    expect(ola.vy).toBeLessThan(olb.vy)
  })

  it('high pass-rush flips a neutral contest toward the defender', () => {
    // With DL (passRush=82 > OL strength=80): rushBias > 0 → effectiveLev < 0 → defense wins
    // OL is pushed toward the ball (negative vy from y=58 toward y=50)
    const { qb, ol, def: dl } = makeEngagedPair('DL')
    const state = makeState({ offense: [ol, qb], defense: [dl] })

    runPushForce(state, null, DT)

    // OL started with vy=4 (driving north). After DL wins block fight, vy should be reduced.
    expect(ol.vy).toBeLessThan(4)
  })
})
