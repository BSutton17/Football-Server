import { describe, it, expect } from '@jest/globals'
import { chooseDefensiveShell } from '../ai/playcall/select.js'
import { deepCount, classifyShell } from '../ai/playcall/shellShape.js'
import { loadPlaybook } from '../playbook/store.js'
import { shellsWithPersonnel } from '../ai/playbook/authored.js'

// ⚠️ THE COMPUTER'S OWN CALL MUST READ THE DOWN AND DISTANCE.
//
// It did not, for as long as it existed: the prior weighted shells by defensive-back count alone,
// so third and one and third and fifteen drew the same defense — three or more deep on ~35% of
// both, measured over real snaps. Reported as "it called cover 4 on third and short, that leaves
// no one in the box and I ran for an easy first down".
//
// Sampled rather than asserted on one call, because the choice is deliberately a mixed strategy:
// the claim is about the DISTRIBUTION, and any single call proves nothing either way.
describe('the defensive call answers the situation', () => {
  const book = loadPlaybook()
  const shells = shellsWithPersonnel(book)
  const look = { id: '3wr1te1rb', wr: 3, te: 1, rb: 1 }

  // A fixed generator, so this test does not flake on a lucky run.
  function sampler(seed) {
    let s = seed
    return () => ((s = (s * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff)
  }

  function profile(situation) {
    const rng = sampler(12345)
    let deepHeavy = 0, blitz = 0
    const N = 400
    for (let i = 0; i < N; i++) {
      const shell = chooseDefensiveShell(shells, situation, look, { rng })
      if (deepCount(shell) >= 3) deepHeavy++
      if (classifyShell(shell) === 'blitz') blitz++
    }
    return { deep: deepHeavy / N, blitz: blitz / N }
  }

  const short = profile({ down: 3, distance: 1, yardLine: 40 })
  const long = profile({ down: 3, distance: 15, yardLine: 25 })

  it('plays fewer defenders deep on third and short than on third and long', () => {
    expect(short.deep).toBeLessThan(long.deep)
  })

  it('sends pressure more often on third and short than on third and long', () => {
    expect(short.blitz).toBeGreaterThan(long.blitz)
  })

  // The margins above are the point; a difference of a fraction of a percent would pass the
  // comparisons while leaving the reported bug exactly as it was.
  it('by a margin big enough to be a different defense, not a rounding difference', () => {
    expect(long.deep - short.deep).toBeGreaterThan(0.10)
    expect(short.blitz - long.blitz).toBeGreaterThan(0.10)
  })
})
