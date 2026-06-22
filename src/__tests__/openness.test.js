import { describe, it, expect } from '@jest/globals'
import { computeReceiverOpenness } from '../game/utils/openness.js'

// Receiver at midfield; QB behind it (lower y). Openness ∈ [0,1]: 0 = blanketed, 1 = wide open.
const receiver = { x: 26, y: 50 }
const qb = { x: 26, y: 35 }

describe('computeReceiverOpenness ([169])', () => {
  it('is fully open with no defenders around', () => {
    expect(computeReceiverOpenness(receiver, [], qb)).toBe(1)
  })

  it('is fully open when the nearest defender is far away', () => {
    expect(computeReceiverOpenness(receiver, [{ x: 26, y: 60 }], qb)).toBe(1)   // 10 yds away
  })

  it('is smothered (≈0) when a defender is draped on the receiver', () => {
    expect(computeReceiverOpenness(receiver, [{ x: 26.5, y: 50 }], qb)).toBeLessThan(0.1)
  })

  it('decreases monotonically as the nearest defender closes in', () => {
    const far  = computeReceiverOpenness(receiver, [{ x: 26, y: 55 }], qb)   // 5 yds
    const mid  = computeReceiverOpenness(receiver, [{ x: 26, y: 53 }], qb)   // 3 yds
    const near = computeReceiverOpenness(receiver, [{ x: 26, y: 51.5 }], qb) // 1.5 yds
    expect(far).toBeGreaterThan(mid)
    expect(mid).toBeGreaterThan(near)
  })

  it('a defender in the throwing lane (ball-side) covers more than one trailing behind', () => {
    // Same separation (3 yds), but one defender is between receiver and QB (toward lower y),
    // the other is past the receiver (higher y, beaten).
    const ballSide = computeReceiverOpenness(receiver, [{ x: 26, y: 47 }], qb)   // toward the QB
    const trailing = computeReceiverOpenness(receiver, [{ x: 26, y: 53 }], qb)   // beaten, downfield
    expect(ballSide).toBeLessThan(trailing)
  })

  it('a second defender in bracket range tightens the coverage further', () => {
    const single  = computeReceiverOpenness(receiver, [{ x: 26, y: 53 }], qb)
    const bracket = computeReceiverOpenness(receiver, [{ x: 26, y: 53 }, { x: 28, y: 51 }], qb)
    expect(bracket).toBeLessThan(single)
  })

  it('clamps to the [0, 1] range', () => {
    const v = computeReceiverOpenness(receiver, [{ x: 26, y: 50 }, { x: 26.5, y: 50.2 }, { x: 25.5, y: 49.8 }], qb)
    expect(v).toBeGreaterThanOrEqual(0)
    expect(v).toBeLessThanOrEqual(1)
  })

  it('a fast-closing defender reduces openness more than a stationary one ([172])', () => {
    const stationary = computeReceiverOpenness(receiver, [{ x: 26, y: 54, vx: 0, vy: 0, label: 'CB' }], qb)
    const closing    = computeReceiverOpenness(receiver, [{ x: 26, y: 54, vx: 0, vy: -8, label: 'CB' }], qb)  // bearing down
    expect(closing).toBeLessThan(stationary)
  })

  it('a nearby safety over the top shrinks the window ([173])', () => {
    const cb = { x: 26, y: 52, vx: 0, vy: 0, label: 'CB' }
    const noHelp = computeReceiverOpenness(receiver, [cb], qb)
    const help   = computeReceiverOpenness(receiver, [cb, { x: 28, y: 54, vx: 0, vy: 0, label: 'S' }], qb)
    expect(help).toBeLessThan(noHelp)
  })

  it('a higher-awareness defender shrinks the window more, all else equal ([174])', () => {
    const qbHere    = { x: 26, y: 35 }
    const heady     = computeReceiverOpenness(receiver, [{ x: 26, y: 46, vx: 0, vy: 6, label: 'S' }],  qbHere)
    const oblivious = computeReceiverOpenness(receiver, [{ x: 26, y: 46, vx: 0, vy: 6, label: 'RB' }], qbHere)
    expect(heady).toBeLessThan(oblivious)
  })
})
