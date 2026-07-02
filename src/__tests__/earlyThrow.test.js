import { describe, it, expect } from '@jest/globals'
import { earlyThrowCatchChance } from '../game/eventQueue.js'

// [68] A pass thrown before the receiver is "ready" is almost always dropped; only elite hands have
// a slim chance to reel it in. Chance scales linearly with the catching rating.
describe('early-throw catch chance', () => {
  it('matches the design anchors: 50 → 1%, 70 → ~5%, 99 → 10%', () => {
    expect(earlyThrowCatchChance(50)).toBeCloseTo(1, 5)
    expect(earlyThrowCatchChance(70)).toBeCloseTo(4.67, 1)   // ~5%
    expect(earlyThrowCatchChance(99)).toBeCloseTo(10, 5)
  })

  it('is monotonic in catching and floored at 0 for poor hands', () => {
    expect(earlyThrowCatchChance(60)).toBeGreaterThan(earlyThrowCatchChance(55))
    expect(earlyThrowCatchChance(0)).toBe(0)
  })
})
