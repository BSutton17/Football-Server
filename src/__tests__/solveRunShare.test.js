import { describe, it, expect } from '@jest/globals'
import { solveSubgame, runShareConstraint } from '../ai/playcall/solve.js'

// ⚠️ THE DEFENSE MUST BE SOLVED AGAINST THE OFFENSE THE GAME ACTUALLY PLAYS.
//
// buildTable rewrites the offense's run/pass split to the situational share, because a play-level
// equilibrium is reliably wrong about that one number. The defense's mix was shipped untouched, so
// on third and one the game played a 73% run offense against a defense that was the best response
// to an 11% run offense. Measured, that allowed 73% conversion where a constant loaded box allowed
// 65%. The defense was not wrong; it was answering a different question.
describe('the run/pass split reaches the defense, not just the offense', () => {
  // A run that gashes a light box, a pass that punishes a loaded one.
  const estimates = [[-1, 9], [7, -2]]
  const counts = [[8, 8], [8, 8]]
  const fixed = (target) => (mix) => [target, 1 - target]
  const deepShare = (out) => out.defense[1]

  it('loads the box when the offense is made to run', () => {
    expect(deepShare(solveSubgame({ estimates, counts, constrainRow: fixed(0.73) }))).toBeLessThan(0.15)
  })

  it('plays deep when the offense is made to throw', () => {
    expect(deepShare(solveSubgame({ estimates, counts, constrainRow: fixed(0.11) }))).toBeGreaterThan(0.85)
  })

  // ⚠️ REDISTRIBUTES RATHER THAN SCALES. Regret matching drives the row to a pure strategy within a
  // few iterations; a constraint that SCALES has nothing to scale once one side is empty, bails out,
  // and the defense spends nearly every iteration answering an unconstrained offense. It still looks
  // right from outside, because the final averaged mix is re-constrained on the way out.
  it('still hits the target when the incoming mix is entirely one kind', () => {
    const c = runShareConstraint(['r', 'p'], 'down1|long|normal', (id) => (id === 'r' ? 'run' : 'pass'))
    const fromPureRun = c([1, 0])
    const fromPurePass = c([0, 1])
    expect(fromPureRun[0]).toBeCloseTo(fromPurePass[0], 6)
    expect(fromPureRun[0] + fromPureRun[1]).toBeCloseTo(1, 6)
    expect(fromPureRun[0]).toBeGreaterThan(0)
    expect(fromPureRun[1]).toBeGreaterThan(0)
  })
})
