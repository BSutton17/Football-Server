import { describe, it, expect } from '@jest/globals'
import { playValue, formationMix, withCeiling, buildTable } from '../ai/playcall/solve.js'

// [authored] Two defects that only showed up once a real solve had run against the real playbook.
// Both produced tables that looked perfectly well-formed and called football nobody would call.

const POSSESSION = 26.4

describe('⚠️ FAILING TO CONVERT COSTS SOMETHING', () => {
  // `playValue` took `firstDown` but never the DOWN, so a 3rd-and-1 incompletion scored exactly 0 —
  // the same as a 1st-and-10 incompletion, though the first ends the drive. With no price on
  // failure the only thing separating plays in short yardage was raw yardage, so a twelve-yard pass
  // beat a one-yard conversion and the solve called 3rd and 1 a throwing down.
  const v = (o) => playValue(o, { possessionValue: POSSESSION })

  it('⚠️ BARELY PAYS FOR YARDS THAT DO NOT CONVERT', () => {
    // Charging for the failure was only half of it. Paying full price for the yardage as well meant
    // a four-yard run on 3rd and 16 scored four yards better than an incompletion, when both punt.
    // That is what made the solve prefer the run MORE on 3rd and 16 than on 3rd and 1.
    const shortOfTheSticks = v({ yards: 4, down: 3, firstDown: false })
    const incomplete = v({ yards: 0, down: 3, firstDown: false })
    expect(shortOfTheSticks - incomplete).toBeLessThan(1)
    // Not zero, though: a punt from four yards further up is worth something.
    expect(shortOfTheSticks).toBeGreaterThan(incomplete)
  })

  it('still pays full price for yards on a down that continues', () => {
    expect(v({ yards: 6, down: 1 })).toBe(6)
    expect(v({ yards: 6, down: 2 })).toBe(6)
  })

  it('charges nothing extra on first down — there are downs left', () => {
    expect(v({ yards: 0, down: 1 })).toBe(0)
    expect(v({ yards: 3, down: 2 })).toBe(3)
  })

  it('charges the lost continuation on third down', () => {
    expect(v({ yards: 0, down: 3 })).toBeLessThan(0)
    expect(v({ yards: 0, down: 3 })).toBeGreaterThan(-POSSESSION)
  })

  it('charges the whole possession on fourth — that IS a turnover on downs', () => {
    expect(v({ yards: 0, down: 4 })).toBe(-POSSESSION)
  })

  it('⚠️ PREFERS A ONE-YARD CONVERSION TO A LONGER FAILURE ON 3RD AND 1', () => {
    const converted = v({ yards: 1, down: 3, firstDown: true })
    const cameUpShort = v({ yards: 0, down: 3, firstDown: false })
    expect(converted).toBeGreaterThan(cameUpShort)
    // And the gap has to be big enough to matter against raw yardage, which is what it lost to.
    expect(converted - cameUpShort).toBeGreaterThan(5)
  })

  it('still pays a conversion and a touchdown properly', () => {
    expect(v({ yards: 4, down: 3, firstDown: true })).toBeGreaterThan(4)
    expect(v({ yards: 8, down: 4, touchdown: true })).toBe(POSSESSION + 8)
  })

  it('a turnover is still the worst thing that can happen on any down', () => {
    expect(v({ yards: 5, down: 1, turnover: true })).toBe(-POSSESSION)
    expect(v({ yards: 5, down: 1, turnover: true })).toBeLessThanOrEqual(v({ yards: 0, down: 4 }))
  })
})

describe('⚠️ NO FORMATION MAY OWN A SITUATION', () => {
  // Measured values spanned -0.2 to 9.6 yards, and at a temperature of 1.5 the softmax was an
  // argmax: one formation took 87% of 2nd and medium, and the best-valued formation on 3rd and
  // short was an EMPTY set that cannot run. Sixteen authored formations went unused.

  it('caps the top share', () => {
    const mix = formationMix([9.6, 0.3, 0.2, 0.1, 0.0, -0.2])
    expect(Math.max(...mix)).toBeLessThanOrEqual(0.36)
  })

  it('still prefers the better formation — this is a ceiling, not a flattening', () => {
    const mix = formationMix([6, 2, 0])
    expect(mix[0]).toBeGreaterThan(mix[1])
    expect(mix[1]).toBeGreaterThan(mix[2])
  })

  it('is still a distribution', () => {
    for (const vals of [[9, 1, 0], [3, 3, 3], [-4, 9, 1, 2]]) {
      expect(formationMix(vals).reduce((a, b) => a + b, 0)).toBeCloseTo(1, 6)
    }
  })

  it('leaves a spread-out mix alone', () => {
    const even = withCeiling([0.34, 0.33, 0.33], 0.35)
    expect(even[0]).toBeCloseTo(0.34, 6)
  })

  it('⚠️ LEAVES A CEILING THE SUPPORT CANNOT SATISFY ALONE', () => {
    // Two formations cannot both sit under 35%, and forcing it flattens them to 50/50 — throwing
    // away the solve's preference, which is worse than the collapse the ceiling exists to fix.
    const mix = withCeiling([0.9, 0.1], 0.35)
    expect(mix[0]).toBeCloseTo(0.9, 6)
  })

  it('⚠️ REDISTRIBUTES ONLY ONTO THE SUPPORT THE SOLVE CHOSE', () => {
    // Handing weight to a formation the solve gave none would resurrect an option it rejected,
    // which is the same trap `withMixingFloor` avoids.
    const mix = withCeiling([0.8, 0.1, 0.1, 0, 0], 0.35)
    expect(mix[3]).toBe(0)
    expect(mix[4]).toBe(0)
    expect(mix[0]).toBeLessThanOrEqual(0.36)
    expect(mix.reduce((a, b) => a + b, 0)).toBeCloseTo(1, 6)
  })

  it('spreads a situation over many formations end to end', () => {
    const sg = (formation, value) => ({
      situation: 'S', formation, value, confident: true,
      plays: [`${formation}_a`], shells: ['c2'], offense: [1], defense: [1],
    })
    const { offense } = buildTable([sg('a', 9.6), sg('b', 1), sg('c', 0.5), sg('d', 0.2)])
    expect(Math.max(...Object.values(offense.S))).toBeLessThanOrEqual(0.36)
    expect(Object.keys(offense.S)).toHaveLength(4)
  })
})
