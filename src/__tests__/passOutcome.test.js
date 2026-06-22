import { describe, it, expect } from '@jest/globals'
import {
  passProbabilities, resolvePass, opennessTier, OPENNESS_OPEN, OPENNESS_RED,
} from '../game/utils/passOutcome.js'

// [pass-outcome feedback] Coverage tier drives the catch / break-up / interception split; the
// receiver's hands and the QB's accuracy nudge the odds. Tiers MUST match the client coloring.

describe('opennessTier', () => {
  it('maps the openness score to green / yellow / red windows', () => {
    expect(opennessTier(0.9)).toBe('open')
    expect(opennessTier(OPENNESS_OPEN)).toBe('open')
    expect(opennessTier(0.5)).toBe('covered')
    expect(opennessTier(OPENNESS_RED)).toBe('covered')
    expect(opennessTier(0.1)).toBe('smothered')
  })
})

describe('passProbabilities ([pass-outcome feedback])', () => {
  it('the three outcomes always sum to 1', () => {
    for (const o of [0.9, 0.5, 0.1]) {
      const p = passProbabilities(o, 60, 60)
      expect(p.catchP + p.intP + p.incompleteP).toBeCloseTo(1, 6)
    }
  })

  it('an open window is never intercepted', () => {
    expect(passProbabilities(0.9, 0, 0).intP).toBe(0)
    expect(passProbabilities(0.9, 99, 99).intP).toBe(0)
  })

  it('hits the base odds at the neutral rating crossover (catch 66, accuracy 66)', () => {
    // The catch/accuracy mods are linear over 0–99 and cross zero at rating 66, so a 66/66
    // throw lands on the published base odds for each tier.
    expect(passProbabilities(0.9, 66, 66).catchP).toBeCloseTo(0.95, 2)
    expect(passProbabilities(0.5, 66, 66).catchP).toBeCloseTo(0.55, 2)
    expect(passProbabilities(0.1, 66, 66).catchP).toBeCloseTo(0.10, 2)
    expect(passProbabilities(0.5, 66, 66).intP).toBeCloseTo(0.05, 2)
    expect(passProbabilities(0.1, 66, 66).intP).toBeCloseTo(0.20, 2)
  })

  it('99 hands add +5% catch, 0 hands subtract 10% (vs the 66 baseline)', () => {
    const base = passProbabilities(0.5, 66, 66).catchP
    expect(passProbabilities(0.5, 66, 99).catchP).toBeCloseTo(base + 0.05, 2)
    expect(passProbabilities(0.5, 66, 0).catchP).toBeCloseTo(base - 0.10, 2)
  })

  it('99 accuracy adds +10% catch, 0 accuracy subtracts 20% (vs the 66 baseline)', () => {
    const base = passProbabilities(0.5, 66, 66).catchP
    expect(passProbabilities(0.5, 99, 66).catchP).toBeCloseTo(base + 0.10, 2)
    expect(passProbabilities(0.5, 0, 66).catchP).toBeCloseTo(base - 0.20, 2)
  })

  it('0 accuracy adds +5% interception on covered/smothered windows', () => {
    expect(passProbabilities(0.5, 0, 66).intP).toBeCloseTo(0.05 + 0.05, 2)
    expect(passProbabilities(0.1, 0, 66).intP).toBeCloseTo(0.20 + 0.05, 2)
    // ...but never on an open window.
    expect(passProbabilities(0.9, 0, 66).intP).toBe(0)
  })

  it('a smothered window is mostly broken up', () => {
    const p = passProbabilities(0.1, 66, 66)
    expect(p.incompleteP).toBeCloseTo(0.70, 2)
  })
})

describe('resolvePass ([179], [pass-outcome feedback])', () => {
  const open = { openness: 0.9, qbAccuracy: 80, receiverCatch: 80 }

  it('an open, accurate throw is caught on a low roll', () => {
    expect(resolvePass(open, () => 0.01)).toEqual({ outcome: 'complete', reason: 'caught' })
  })

  it('an open throw is never intercepted — even on a zero roll, and a miss is a drop', () => {
    expect(resolvePass(open, () => 0).outcome).toBe('complete')          // catchP is high
    // A neutral-rated open window has a 5% drop slice, so a high roll falls incomplete as a drop.
    const neutralOpen = { openness: 0.9, qbAccuracy: 66, receiverCatch: 66 }
    expect(resolvePass(neutralOpen, () => 0.999)).toEqual({ outcome: 'incomplete', reason: 'drop' })
  })

  it('a covered window can be broken up on a high roll', () => {
    const covered = { openness: 0.5, qbAccuracy: 66, receiverCatch: 66 }
    expect(resolvePass(covered, () => 0.999)).toEqual({ outcome: 'incomplete', reason: 'broken_up' })
  })

  it('a smothered window is intercepted on a roll into the pick band', () => {
    // smothered: catch ~0.10, then the pick band. A roll just above the catch lands on the INT.
    const smothered = { openness: 0.1, qbAccuracy: 66, receiverCatch: 66 }
    expect(resolvePass(smothered, () => 0.15).outcome).toBe('intercepted')
  })

  it('a ball thrown at a defender is overwhelmingly intercepted', () => {
    expect(resolvePass({ ...open, interceptionEligible: true }, () => 0.0001).outcome).toBe('intercepted')
  })
})
