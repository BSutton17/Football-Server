import { describe, it, expect } from '@jest/globals'
import {
  playValue, fillGaps, solveSubgame, formationMix, buildTable,
} from '../ai/playcall/solve.js'

// [authored] Turning simulated outcomes into the distributions the selector calls from.

const POSSESSION = 32   // measured, not invented: what a drive is worth in this engine

describe('what a play is worth', () => {
  it('is yards, plainly, when nothing else happened', () => {
    expect(playValue({ yards: 7 }, { possessionValue: POSSESSION })).toBe(7)
    expect(playValue({ yards: -3 }, { possessionValue: POSSESSION })).toBe(-3)
  })

  it('charges a turnover the whole possession', () => {
    // ⚠️ MEASURED, NOT INVENTED. The last fitness I wrote charged 12 for a turnover because I
    // picked 12. Here it costs what losing the ball actually costs in this engine.
    expect(playValue({ yards: 4, turnover: true }, { possessionValue: POSSESSION })).toBe(-POSSESSION)
  })

  it('pays a touchdown the possession plus the yards', () => {
    expect(playValue({ yards: 20, touchdown: true }, { possessionValue: POSSESSION })).toBe(52)
  })

  it('pays a conversion the yards plus a discounted possession', () => {
    const converted = playValue({ yards: 8, firstDown: true }, { possessionValue: POSSESSION })
    expect(converted).toBeGreaterThan(8)
    expect(converted).toBeLessThan(8 + POSSESSION)
  })

  it('ranks the outcomes the way football does', () => {
    const v = (o) => playValue(o, { possessionValue: POSSESSION })
    expect(v({ yards: 60, touchdown: true })).toBeGreaterThan(v({ yards: 12, firstDown: true }))
    expect(v({ yards: 12, firstDown: true })).toBeGreaterThan(v({ yards: 12 }))
    expect(v({ yards: 12 })).toBeGreaterThan(v({ yards: 0 }))
    expect(v({ yards: 0 })).toBeGreaterThan(v({ yards: 5, turnover: true }))
  })
})

describe('⚠️ CELLS NOBODY PLAYED', () => {
  it('fills an unvisited matchup with the play’s own mean, not with zero', () => {
    // Zero would say "this matchup is terrible" about something nobody tried, and the solver would
    // dutifully avoid a play for a reason that does not exist.
    const estimates = [[10, 0], [0, 4]]
    const counts = [[5, 0], [0, 5]]
    const filled = fillGaps(estimates, counts)
    expect(filled[0][1]).toBe(10)
    expect(filled[1][0]).toBe(4)
  })

  it('falls back to the overall mean for a play with no samples at all', () => {
    const estimates = [[8, 8], [0, 0]]
    const counts = [[3, 3], [0, 0]]
    expect(fillGaps(estimates, counts)[1][0]).toBe(8)
  })

  it('leaves the cells that WERE played exactly alone', () => {
    const estimates = [[10, -4], [2, 6]]
    const counts = [[1, 1], [1, 1]]
    expect(fillGaps(estimates, counts)).toEqual(estimates)
  })
})

describe('solving one formation’s subgame', () => {
  const counts = (r, c, n = 4) => Array.from({ length: r }, () => Array(c).fill(n))

  it('mixes rather than settling on one play', () => {
    // Each play beats a different shell, which is what an authored playbook should look like.
    const estimates = [[9, -3], [-2, 8]]
    const out = solveSubgame({ estimates, counts: counts(2, 2) })
    expect(out.offense[0]).toBeGreaterThan(0.2)
    expect(out.offense[1]).toBeGreaterThan(0.2)
    expect(out.confident).toBe(true)
  })

  it('reports a dominant play as a BALANCE problem rather than shipping it quietly', () => {
    const estimates = [[14, 12, 13], [1, 0, -1], [0, -2, 1]]
    const out = solveSubgame({ estimates, counts: counts(3, 3) })
    expect(out.diagnosis.nearPure).toBe(true)
    expect(out.diagnosis.warning).toMatch(/BALANCE BUG/)
  })

  it('⚠️ SAYS SO WHEN IT HAS BARELY SEEN ANYTHING', () => {
    // A subgame solved off two visited cells out of forty is a guess wearing a distribution.
    const estimates = Array.from({ length: 4 }, () => Array(10).fill(0))
    const c = Array.from({ length: 4 }, () => Array(10).fill(0))
    c[0][0] = 3; c[1][1] = 3
    estimates[0][0] = 7; estimates[1][1] = 5
    expect(solveSubgame({ estimates, counts: c }).confident).toBe(false)
  })

  it('does not fall over on an empty subgame', () => {
    expect(solveSubgame({ estimates: [], counts: [] }).offense).toEqual([])
  })
})

describe('⚠️ CHOOSING A FORMATION NEEDS NO HIDING', () => {
  it('prefers the formation whose subgame is worth more', () => {
    const mix = formationMix([6, 2, 0])
    expect(mix[0]).toBeGreaterThan(mix[1])
    expect(mix[1]).toBeGreaterThan(mix[2])
  })

  it('⚠️ DOES NOT COLLAPSE ONTO THE BEST ONE, because the values are sampled', () => {
    // Always calling the single best formation is right only if the estimates are exact. A
    // formation half a yard behind on noisy evidence should not vanish from the playbook.
    const mix = formationMix([6, 5.5, 5])
    for (const p of mix) expect(p).toBeGreaterThan(0.15)
  })

  it('is a proper distribution', () => {
    const mix = formationMix([3, 1, -4, 9])
    expect(mix.reduce((a, b) => a + b, 0)).toBeCloseTo(1)
  })
})

describe('the table the selector reads', () => {
  const sg = (situation, formation, value, confident = true) => ({
    situation, formation, value, confident,
    plays: [`${formation}_a`, `${formation}_b`],
    shells: ['cover2', 'cover3'],
    offense: [0.6, 0.4],
    defense: [0.7, 0.3],
  })

  it('weights each formation’s plays by how good that formation is', () => {
    const { offense } = buildTable([sg('S', 'trips', 8), sg('S', 'bunch', 0)])
    expect(offense.S.trips_a).toBeGreaterThan(offense.S.bunch_a)
  })

  it('produces a distribution per situation', () => {
    const { offense } = buildTable([sg('S', 'trips', 8), sg('S', 'bunch', 4)])
    const total = Object.values(offense.S).reduce((a, b) => a + b, 0)
    expect(total).toBeCloseTo(1, 5)
  })

  it('keys the defense on situation AND formation, because that is what it sees', () => {
    const { defense } = buildTable([sg('S', 'trips', 8)])
    expect(defense['S|trips']).toEqual({ cover2: 0.7, cover3: 0.3 })
  })

  it('⚠️ LEAVES OUT A SITUATION IT DID NOT REALLY SOLVE', () => {
    // Half the plays coming from evidence and half from a guess, with no way to tell them apart
    // later, is worse than falling back to the prior for the whole bucket.
    const { offense } = buildTable([sg('S', 'trips', 8, false), sg('S', 'bunch', 4, false)])
    expect(offense.S).toBeUndefined()
  })

  it('keeps the confident formations when only some are', () => {
    const { offense } = buildTable([sg('S', 'trips', 8, true), sg('S', 'bunch', 4, false)])
    expect(Object.keys(offense.S).every(k => k.startsWith('trips'))).toBe(true)
  })
})
