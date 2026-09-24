import { describe, it, expect } from '@jest/globals'
import { readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { trainedDefenseGenome, useTrainedDefense } from '../ai/trainedDefense.js'
import { DIFFICULTY } from '../constants.js'
import { DEEP_OBSERVATION_SIZE, DEEP_ACTION_SIZE } from '../training/deepBrainDefense.js'

// [deep] HARD mode's defense is a trained network; easy and medium stay on the heuristic.
//
// The genome is a data file in the repo, which makes it exactly the sort of thing that rots
// silently: a schema change to the observation or action layout leaves a saved genome meaningless,
// and nothing would say so — it would simply play badly. These tests fail loudly instead.

const BRAIN = join(process.cwd(), 'src', 'ai', 'brains', 'hard-defense.json')

describe('the installed hard-mode brain', () => {
  it('is present in the repo', () => {
    expect(existsSync(BRAIN)).toBe(true)
  })

  it('loads, and records a score that BEAT the heuristic on a common slate', () => {
    const saved = JSON.parse(readFileSync(BRAIN, 'utf8'))
    expect(saved.source).toMatch(/generation \d+/)
    expect(saved.genome?.nodes?.length).toBeGreaterThan(0)
    // It earned its place by beating the heuristic on an unseen slate both sides played.
    expect(saved.seriesMean).toBeGreaterThan(saved.heuristicSeriesMean)
    // ...and by beating the brain it replaced, measured the SAME way.
    expect(saved.seriesMean).toBeGreaterThan(saved.previousBrainSeriesMean)
  })

  // ⚠️ A SCORE IS ONLY MEANINGFUL INSIDE ONE HARNESS. The brain this replaced recorded
  // `roundRobinMean: 17` from the per-play yards-vs-par harness, which read as a far better
  // number than the 7.90 that replaced it — but re-measured under series scoring that same brain
  // was 4.67. Comparing a new champion's score against a stored old one nearly kept the worse
  // brain. The file therefore states which harness produced its numbers, and that is asserted.
  it('says which harness produced its numbers', () => {
    const saved = JSON.parse(readFileSync(BRAIN, 'utf8'))
    expect(saved.scoring).toMatch(/series/i)
  })

  // ⚠️ THE ROT CHECK. A genome's inputs and outputs are positional: input 23 means whatever
  // observation.js said it meant when the genome was trained. Add a field and every saved genome
  // silently reads the wrong numbers — it still runs, still scores, and is quietly nonsense.
  it('matches the CURRENT observation and action layout', () => {
    const g = trainedDefenseGenome()
    expect(g).toBeTruthy()
    const inputs = g.nodes.filter(n => n.kind === 'input').length
    const outputs = g.nodes.filter(n => n.kind === 'output').length
    expect(inputs).toBe(DEEP_OBSERVATION_SIZE)
    expect(outputs).toBe(DEEP_ACTION_SIZE)
  })

  it('is used on HARD and nowhere else', () => {
    expect(useTrainedDefense(DIFFICULTY.HARD)).toBe(true)
    expect(useTrainedDefense(DIFFICULTY.MEDIUM)).toBe(false)
    expect(useTrainedDefense(DIFFICULTY.EASY)).toBe(false)
    expect(useTrainedDefense(undefined)).toBe(false)
  })

  it('is NOT gated on the seat\'s kickoff role', () => {
    // The trained brain wraps a full controller: it plays the network on defense and the ordinary
    // heuristic offense after a turnover. Gating on the kickoff role would make hard mode depend on
    // the coin toss — a computer that received would play heuristic defense all game.
    expect(useTrainedDefense.length).toBe(1)
  })

  it('caches — the file is read once, not per game', () => {
    expect(trainedDefenseGenome()).toBe(trainedDefenseGenome())
  })
})
