import { describe, it, expect } from '@jest/globals'
import { createTrainingGame, destroyTrainingGame, playDown } from '../training/game.js'
import { loadPlaybook } from '../playbook/store.js'

// ⚠️ THE SOLVER MUST MEASURE THE MATCHUP IT THINKS IT IS MEASURING.
//
// `samplePlay` forced the play onto brain 0 and the shell onto brain 1 unconditionally. Which seat
// opens on offense is decided by the SEED, and about 38% of seeds give it to slot 1 — so in better
// than a third of every cell's samples the play went to the defense and the shell to the offense,
// both were ignored, and the down was played with two freely chosen calls. The number that landed
// in the payoff matrix was the value of a matchup that never happened.
//
// Nothing about it looked wrong: the play ran, `ok` came back true, and an ordinary number came
// out. This test is the only thing that would have caught it.

const book = loadPlaybook()
const runPlay = Object.entries(book.plays).find(([, p]) => p.playType === 'run')?.[0]
const shells = Object.keys(book.shells)

describe('forcing a call in the solve harness', () => {
  it('⚠️ FORCES THE SIDE THAT ACTUALLY HAS THE BALL', () => {
    if (!runPlay || !shells.length) return   // an empty playbook has nothing to force
    let forced = 0, total = 0
    for (let i = 0; i < 40; i++) {
      const ctx = createTrainingGame({ seed: (i * 31337) >>> 0 })
      try {
        ctx.state.down = 1; ctx.state.distance = 10; ctx.state.yardLine = 40
        // The fix: ask who has the ball rather than assuming slot 0 does.
        const offense = ctx.state.possession
        ctx.brains[offense].forceAuthoredPlay = runPlay
        ctx.brains[1 - offense].forceAuthoredShell = shells[i % shells.length]
        playDown(ctx, {})
        total++
        if (ctx.state.playDesign?.playType === 'run') forced++
      } finally { destroyTrainingGame(ctx) }
    }
    // A forced run must come out a run essentially every time. Assuming slot 0 scored about 78%.
    expect(total).toBeGreaterThan(0)
    expect(forced / total).toBeGreaterThan(0.97)
  })

  it('does not assume slot 0 opens on offense', () => {
    // The assumption the bug rested on, written down so it cannot be made again.
    const seats = new Set()
    for (let i = 0; i < 40; i++) {
      const ctx = createTrainingGame({ seed: (i * 104729) >>> 0 })
      seats.add(ctx.state.possession)
      destroyTrainingGame(ctx)
    }
    expect(seats).toEqual(new Set([0, 1]))
  })
})
