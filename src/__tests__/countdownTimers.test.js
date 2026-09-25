import { describe, it, expect, afterEach } from '@jest/globals'
import { createTrainingGame, destroyTrainingGame, playDown } from '../training/game.js'

// ⚠️ THE SOLVER DIED OF THIS. Every tick of the defensive adjust window is booked up front —
// eleven to sixteen setTimeouts — and ending the countdown only makes them no-ops, it does not
// unbook them. Each holds `io`, and `io` holds every position broadcast of the play it belonged
// to. A real game gets away with it; thousands of training games a minute do not, and a solve run
// died after about 200,000 plays with "Ineffective mark-compacts near heap limit".
//
// The registry checks below are cheap and exact. The heap check is the one that would actually
// have caught it, and it is written to be about the SHAPE of the growth rather than an absolute
// number, so it does not become a flake on a different machine.

const liveTimers = () =>
  (process._getActiveHandles?.() ?? []).filter(h => h?.constructor?.name === 'Timeout').length

describe('a torn-down game leaves nothing booked', () => {
  it('cancels the countdown ticks it scheduled', () => {
    const before = liveTimers()
    const ctx = createTrainingGame({ seed: 4242 })
    try { playDown(ctx, {}) } finally { destroyTrainingGame(ctx) }
    // Anything still pending here is holding a game that no longer exists.
    expect(liveTimers()).toBeLessThanOrEqual(before)
  })

  it('⚠️ DOES NOT GROW THE HEAP PLAY AFTER PLAY', () => {
    if (!global.gc) return   // needs --expose-gc; the timer assertions above still run
    const settle = () => { global.gc(); global.gc() }
    const run = (n) => {
      for (let i = 0; i < n; i++) {
        const ctx = createTrainingGame({ seed: 1000 + i })
        try { playDown(ctx, {}) } catch { /* a refused play still has to clean up */ }
        finally { destroyTrainingGame(ctx) }
      }
    }

    run(150); settle()
    const after150 = process.memoryUsage().heapUsed
    run(450); settle()
    const after600 = process.memoryUsage().heapUsed

    // Three times the games must not mean three times the heap. The leak grew by ~0.25 MB a game,
    // which at this scale is well over 100 MB — a generous ceiling still catches it.
    expect(after600 - after150).toBeLessThan(40 * 1024 * 1024)
  })
})
