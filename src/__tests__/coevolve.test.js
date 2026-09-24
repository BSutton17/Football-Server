import { describe, it, expect } from '@jest/globals'
import { scoreSeries, runSeries } from '../training/series.js'
import { buildPairings, buildJobs, collectFitness, shapes, FITNESS_OFFSET } from '../training/coevolve.js'
import { createTrainingGame, destroyTrainingGame } from '../training/game.js'
import { buildSlate } from '../training/slate.js'

// [coevolve] Series-scored co-evolution: both populations step on the same evaluation, and every
// series scores an offense genome AND a defense genome.
//
// This replaced per-play yards-vs-par, which was a pile of numbers I invented — 12 for a turnover,
// 10 for a touchdown allowed, 3 for a sack, 1.2 per bunched pair. Each was a surface where a genome
// could win at the proxy instead of at football, and twice one did: a defense that blitzed six
// every down because pressure was underpriced, and one that piled its secondary into a single spot
// because spacing was not priced at all.

describe('what a series is worth', () => {
  const s = (outcome, downUsed = 4) => scoreSeries({ ok: true, outcome, downUsed })

  it('pays more for converting EARLY', () => {
    // The user's rule: the earlier the conversion the bigger the reward.
    expect(s('converted', 1)).toBeGreaterThan(s('converted', 2))
    expect(s('converted', 2)).toBeGreaterThan(s('converted', 3))
    expect(s('converted', 3)).toBeGreaterThan(s('converted', 4))
  })

  it('ranks the outcomes the way football does', () => {
    expect(s('touchdown')).toBeGreaterThan(s('converted', 1))
    expect(s('converted', 4)).toBeGreaterThan(s('field_goal'))
    expect(s('field_goal')).toBeGreaterThan(0)
    expect(s('downs')).toBeLessThan(0)
    expect(s('turnover')).toBeLessThan(s('downs'))   // a giveaway is worse than running out of downs
  })

  it('is ZERO SUM — one number, mirrored', () => {
    // Two separately-tuned scoring functions would eventually disagree about who won a play, and
    // that disagreement is invisible until it has already taught both sides something wrong.
    for (const o of ['touchdown', 'converted', 'downs', 'turnover', 'field_goal']) {
      const off = scoreSeries({ ok: true, outcome: o, downUsed: 2 })
      expect(-off).toBe(-scoreSeries({ ok: true, outcome: o, downUsed: 2 }))
    }
  })

  it('pays NOTHING for a series that could not be played', () => {
    // Otherwise breaking the harness becomes a strategy — which an earlier fitness accidentally
    // made profitable, because a broken play outscored one that conceded a yard.
    expect(scoreSeries({ ok: false, outcome: 'broken', downUsed: 1 })).toBe(0)
  })
})

describe('a series actually plays consecutive downs', () => {
  it('runs a real four-down series and resolves it', () => {
    const slate = buildSlate({ size: 6, generation: 1, seed: 4242 })
    const outcomes = []
    for (const s of slate.situations) {
      const ctx = createTrainingGame({ seed: s.seed })
      try {
        const r = runSeries(ctx, { ...s, seed: s.seed, possession: 0 })
        outcomes.push(r)
      } finally { destroyTrainingGame(ctx) }
    }

    // ⚠️ Every one of these used to fail. The whistle-to-snap transition lived inside a setTimeout
    // that a synchronous harness never fires, so every series died on the SECOND down; then the
    // 4th-down decision menu gated the snap; then two slot-ordered broadcasts wiped the defense.
    expect(outcomes.every(r => r.ok)).toBe(true)
    expect(outcomes.some(r => r.plays.length > 1)).toBe(true)
    for (const r of outcomes) {
      expect(['converted', 'touchdown', 'turnover', 'downs']).toContain(r.outcome)
      expect(r.downUsed).toBeGreaterThanOrEqual(1)
      expect(r.downUsed).toBeLessThanOrEqual(4)
    }
  })
})

describe('who plays whom', () => {
  it('spreads each genome across the opposing population', () => {
    // A random draw would make part of every fitness a measure of who got the easy opponents.
    const rows = buildPairings(20, 4)
    expect(rows).toHaveLength(20)
    for (const foes of rows) {
      expect(new Set(foes).size).toBe(4)        // four DISTINCT opponents
    }
    // And every defense is faced a comparable number of times.
    const faced = new Array(20).fill(0)
    for (const foes of rows) for (const f of foes) faced[f]++
    expect(Math.max(...faced) - Math.min(...faced)).toBeLessThanOrEqual(1)
  })

  it('is DETERMINISTIC, so a resumed run reproduces the same matchups', () => {
    // Offense[i] facing defense[i] is perfectly legitimate — they are separate populations, so
    // there is no "self" to avoid. What must hold is reproducibility: a random draw would make a
    // resumed run diverge from the one it is continuing.
    expect(buildPairings(12, 3)).toEqual(buildPairings(12, 3))
  })

  it('gives every job its own genomes — a worker can resolve nothing by index', () => {
    const offense = Array.from({ length: 6 }, (_, i) => ({ id: `o${i}`, nodes: [], connections: [] }))
    const defense = Array.from({ length: 6 }, (_, i) => ({ id: `d${i}`, nodes: [], connections: [] }))
    const jobs = buildJobs({ offense, defense, situations: [{ seed: 1 }], opponents: 2, anchors: 1 })
    expect(jobs).toHaveLength(6)
    for (const j of jobs) {
      expect(j.offGenome).toBeTruthy()
      expect(j.anchorDefGenome).toBeTruthy()
      for (const f of j.foes) expect(f.genome).toBeTruthy()
    }
  })
})

describe('turning results into fitness', () => {
  it('scores BOTH sides from the same series', () => {
    const results = [
      { offIndex: 0, offScore: 10, defScores: [{ index: 1, score: -10 }] },
      { offIndex: 1, offScore: -6, defScores: [{ index: 0, score: 6 }] },
    ]
    const fit = collectFitness(results, 2)
    expect(fit.offense[0]).toBeCloseTo(10 + FITNESS_OFFSET)
    expect(fit.defense[1]).toBeCloseTo(-10 + FITNESS_OFFSET)
    expect(fit.offense[1]).toBeCloseTo(-6 + FITNESS_OFFSET)
    expect(fit.defense[0]).toBeCloseTo(6 + FITNESS_OFFSET)
  })

  it('never produces a negative fitness', () => {
    // NEAT divides fitness by species size for sharing, and negative numbers make that meaningless.
    const fit = collectFitness([{ offIndex: 0, offScore: -999, defScores: [{ index: 0, score: -999 }] }], 1)
    expect(fit.offense[0]).toBeGreaterThanOrEqual(0)
    expect(fit.defense[0]).toBeGreaterThanOrEqual(0)
  })

  it('gives an unscored genome the floor rather than a free pass', () => {
    const fit = collectFitness([], 3)
    expect(fit.offense.every(v => v === 0)).toBe(true)
    expect(fit.defense.every(v => v === 0)).toBe(true)
  })
})

describe('the two sides have different genome shapes', () => {
  it('so a defensive champion is not interchangeable with an offensive one', () => {
    const { offense, defense } = shapes()
    expect(offense.inputs).not.toBe(defense.inputs)
    expect(offense.outputs).not.toBe(defense.outputs)
  })
})
