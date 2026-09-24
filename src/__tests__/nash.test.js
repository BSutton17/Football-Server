import { describe, it, expect } from '@jest/globals'
import {
  solveZeroSum, solveSignaling, exploitability, spread, effectiveOptions, diagnose, withMixingFloor,
} from '../ai/playcall/nash.js'

// [authored] The solver that replaces training for play CHOICE.
//
// These tests use games whose answers are known in closed form, because a solver that is subtly
// wrong produces plausible-looking numbers forever. If rock-paper-scissors does not come out at
// a third each, nothing downstream can be trusted.

describe('games with a known answer', () => {
  it('solves rock-paper-scissors to a third each', () => {
    const rps = [
      [0, -1, 1],
      [1, 0, -1],
      [-1, 1, 0],
    ]
    const { row, col, value } = solveZeroSum(rps, { iterations: 20000 })
    for (const p of row) expect(p).toBeCloseTo(1 / 3, 2)
    for (const p of col) expect(p).toBeCloseTo(1 / 3, 2)
    expect(value).toBeCloseTo(0, 2)
  })

  it('solves matching pennies to a coin flip', () => {
    const pennies = [[1, -1], [-1, 1]]
    const { row, col, value } = solveZeroSum(pennies)
    expect(row[0]).toBeCloseTo(0.5, 2)
    expect(col[0]).toBeCloseTo(0.5, 2)
    expect(value).toBeCloseTo(0, 2)
  })

  it('finds the biased equilibrium when the payoffs are lopsided', () => {
    // Row prefers matching on the first, but it pays double — so it must be played LESS often,
    // not more. A solver that simply chases the biggest number gets this backwards.
    const g = [[2, -1], [-1, 1]]
    const { row, col, value } = solveZeroSum(g)
    expect(row[0]).toBeCloseTo(0.4, 2)
    expect(col[0]).toBeCloseTo(0.4, 2)
    expect(value).toBeCloseTo(0.2, 2)
  })

  it('produces a genuine equilibrium — nothing exploits it', () => {
    // The real check: not "does it look right" but "can anyone beat it".
    const g = [[3, -2, 0], [-1, 1, 2], [0, 1, -3]]
    const { row, col } = solveZeroSum(g)
    expect(exploitability(g, row, col)).toBeLessThan(0.05)
  })

  it('is far less exploitable than always calling the best-looking play', () => {
    const g = [[3, -2, 0], [-1, 1, 2], [0, 1, -3]]
    const { row, col } = solveZeroSum(g)
    // "Always call the play with the best average" — the obvious naive policy.
    const means = g.map(r => r.reduce((a, b) => a + b, 0) / r.length)
    const bestIdx = means.indexOf(Math.max(...means))
    const pure = g.map((_, i) => (i === bestIdx ? 1 : 0))
    expect(exploitability(g, pure, col)).toBeGreaterThan(exploitability(g, row, col))
  })
})

describe('⚠️ THE USER REQUIREMENT: it must not call the same play every time', () => {
  it('returns a MIXED strategy, not a single pick', () => {
    // Predictability is what a zero-sum solve punishes, so mixing is not bolted on — it is the
    // property the method was chosen for.
    const rps = [[0, -1, 1], [1, 0, -1], [-1, 1, 0]]
    const { row } = solveZeroSum(rps)
    expect(row.every(p => p > 0.2)).toBe(true)
    expect(spread(row)).toBeGreaterThan(0.99)
    expect(effectiveOptions(row)).toBeCloseTo(3, 1)
  })

  it('mixes across a realistic playbook rather than settling on one call', () => {
    // Five plays against four shells, each play good against something and bad against something —
    // which is what an authored playbook should look like.
    const g = [
      [6, -2, 1, -3],
      [-3, 5, 2, 0],
      [1, 1, -4, 4],
      [0, -1, 5, -2],
      [2, 2, -1, 1],
    ]
    const { row } = solveZeroSum(g)
    expect(effectiveOptions(row)).toBeGreaterThan(1.5)
    expect(diagnose(row).nearPure).toBe(false)
  })
})

describe('⚠️ a near-pure answer is a BALANCE BUG, reported not hidden', () => {
  it('flags a playbook where one call dominates', () => {
    // This is the six-man-blitz finding in miniature: when one option beats everything on every
    // down, the solve correctly says to call it always — and that is a bug to fix in the engine,
    // not a strategy to ship.
    const dominated = [
      [9, 8, 9, 8],
      [-2, -1, 0, -3],
      [-1, -2, -1, 0],
    ]
    const { row } = solveZeroSum(dominated)
    const d = diagnose(row, ['blitz_six', 'cover_3', 'cover_2'])
    expect(d.nearPure).toBe(true)
    expect(d.warning).toMatch(/BALANCE BUG/)
    expect(d.top[0].label).toBe('blitz_six')
  })

  it('says nothing when the playbook is healthy', () => {
    const rps = [[0, -1, 1], [1, 0, -1], [-1, 1, 0]]
    expect(diagnose(solveZeroSum(rps).row).warning).toBeNull()
  })
})

describe('the mixing floor — a safety net, not the fix', () => {
  it('stops any call reaching 100%', () => {
    const mix = [0.97, 0.02, 0.01]
    const floored = withMixingFloor(mix, { floor: 0.1 })
    expect(Math.max(...floored)).toBeLessThan(0.95)
    expect(floored.reduce((a, b) => a + b, 0)).toBeCloseTo(1)
  })

  it('never spreads onto plays the solve REJECTED', () => {
    // Blending toward uniform across everything would start calling plays that lose, which is
    // worse than being a little predictable.
    const mix = [0.6, 0.4, 0]
    const floored = withMixingFloor(mix, { floor: 0.2 })
    expect(floored[2]).toBe(0)
  })

  it('leaves a genuinely single-option decision alone', () => {
    expect(withMixingFloor([1, 0, 0], { floor: 0.2 })).toEqual([1, 0, 0])
  })
})

describe('degenerate input', () => {
  it('does not throw on an empty matrix', () => {
    expect(solveZeroSum([])).toEqual({ row: [], col: [], value: 0, iterations: 0 })
  })
})

describe('⚠️ the defense SEES personnel before it calls', () => {
  // Personnel is public: three receivers brings a nickel corner, four brings dime. That is not the
  // play call, so it breaks no rule — but it does mean the defense is not choosing blind, and a
  // simultaneous matrix models it wrongly in BOTH directions.
  //
  // Plays 0 and 1 are four-wide; play 2 is a heavy run set.
  const payoff = [
    [-2, 8],    // 4WR deep    : dies to dime, feasts on base
    [-1, 6],    // 4WR quick   : same shape, milder
    [7, -3],    // heavy run   : feasts on dime, dies to base
  ]
  const signals = ['4wr', '4wr', 'heavy']

  it('plays dime against four wide and base against heavy — WITHOUT being told to', () => {
    // Nobody wrote "if 4 WR then dime". It falls out of the solve, which is the whole argument for
    // solving rather than hand-coding a table of situational rules.
    const { col } = solveSignaling(payoff, signals)
    expect(col['4wr'][0]).toBeGreaterThan(0.9)     // dime
    expect(col.heavy[1]).toBeGreaterThan(0.9)      // base
  })

  it('punishes the offense for the tell, which a simultaneous solve does not', () => {
    // Blind, the defense must hedge and four-wide still pays. Sighted, it does not — and that
    // difference is exactly the information the defense really has.
    const blind = solveZeroSum(payoff)
    const sighted = solveSignaling(payoff, signals)
    expect(sighted.value).toBeLessThan(blind.value)
  })

  it('keeps each look its own decision', () => {
    const { col, signals: groups } = solveSignaling(payoff, signals)
    expect(new Set(groups)).toEqual(new Set(['4wr', 'heavy']))
    for (const g of groups) expect(col[g].reduce((a, b) => a + b, 0)).toBeCloseTo(1)
  })

  it('still mixes when a look does not have one clean answer', () => {
    // Two four-wide plays that beat opposite calls: the defense cannot be right by guessing, so
    // the equilibrium mixes inside that look rather than collapsing onto one shell.
    const mixed = [[-4, 6], [6, -4]]
    const { col } = solveSignaling(mixed, ['4wr', '4wr'])
    expect(effectiveOptions(col['4wr'])).toBeGreaterThan(1.8)
  })

  it('⚠️ answers a look the equilibrium offense would NEVER show', () => {
    // The bug this caught: an equilibrium offense abandons a dominated look entirely, so it never
    // occurs, so the defense's answer to it is off-path and the maths leaves it undetermined — the
    // solver returned a coin flip and was not wrong to. Useless against a person, who will happily
    // line up in a formation no equilibrium offense would call.
    //
    // 'heavy' here is strictly worse for the offense than either four-wide play, so it is dropped.
    const payoffDominated = [
      [-2, 8],
      [-1, 6],
      [-9, -3],   // never worth calling
    ]
    const { row, col } = solveSignaling(payoffDominated, ['4wr', '4wr', 'heavy'])
    expect(row[2]).toBeLessThan(0.05)          // the offense really has abandoned it...
    // ...and the defense STILL knows what to do about it: -9 hurts the offense more than -3, so
    // shell 0 is the answer. Without the tremble this came back an even coin flip.
    expect(col.heavy[0]).toBeGreaterThan(0.9)
  })

  it('does not let a rare look be drowned out by a common one', () => {
    // Counterfactual weighting: five common plays and one rare one. The rare look still gets the
    // right answer, which unweighted averaging loses.
    const p = [[-2, 8], [-2, 8], [-2, 8], [-2, 8], [-2, 8], [7, -3]]
    const sig = ['4wr', '4wr', '4wr', '4wr', '4wr', 'heavy']
    const { col } = solveSignaling(p, sig)
    expect(col.heavy[1]).toBeGreaterThan(0.9)
  })
})
