import { describe, it, expect, beforeEach, afterEach } from '@jest/globals'
import { devFlag, noDelayOfGame } from '../game/devFlags.js'
import { runPlayClock } from '../game/systems/playClock.js'
import { RULES } from '../constants.js'

// [dev flags] Switches that make the game easier to work on and would be cheating or nonsense in a
// real one. The property that matters most is that production cannot be talked into honouring them.

const ORIGINAL = { node: process.env.NODE_ENV, delay: process.env.DISABLE_DELAY_OF_GAME }
const noIo = { to: () => ({ emit: () => {} }) }

beforeEach(() => { process.env.NODE_ENV = 'development' })
afterEach(() => {
  process.env.NODE_ENV = ORIGINAL.node
  if (ORIGINAL.delay === undefined) delete process.env.DISABLE_DELAY_OF_GAME
  else process.env.DISABLE_DELAY_OF_GAME = ORIGINAL.delay
})

describe('⚠️ PRODUCTION REFUSES BEFORE THE FLAG IS EVEN READ', () => {
  it('no dev switch can be turned on in production', () => {
    process.env.NODE_ENV = 'production'
    process.env.DISABLE_DELAY_OF_GAME = '1'
    expect(devFlag('DISABLE_DELAY_OF_GAME')).toBe(false)
    expect(noDelayOfGame()).toBe(false)
  })

  it('off by default — absent means absent', () => {
    delete process.env.DISABLE_DELAY_OF_GAME
    expect(noDelayOfGame()).toBe(false)
  })

  it('⚠️ ONLY "1" COUNTS — an ambiguous flag is worse than no flag', () => {
    for (const v of ['0', 'true', 'yes', 'on', '', 'false']) {
      process.env.DISABLE_DELAY_OF_GAME = v
      expect(noDelayOfGame()).toBe(false)
    }
    process.env.DISABLE_DELAY_OF_GAME = '1'
    expect(noDelayOfGame()).toBe(true)
  })
})

describe('[dev flags] delay of game', () => {
  function presnap() {
    return {
      roomId: 'dev', yardLine: 40, distance: 10, down: 1,
      playClock: 0.02, playClockRunning: true,
      offensePlayers: new Map(), defensePlayers: new Map(),
      direction: 1, newDrive: false, playSerial: 3,
    }
  }

  it('penalises normally with the flag off', () => {
    delete process.env.DISABLE_DELAY_OF_GAME
    const s = presnap()
    runPlayClock(s, noIo, 0.05)
    expect(s.yardLine).toBe(40 - RULES.DELAY_OF_GAME_YARDS)
    expect(s.distance).toBe(10 + RULES.DELAY_OF_GAME_YARDS)
    expect(s.playClock).toBe(RULES.PLAY_CLOCK_SECONDS)   // re-armed for the replay
  })

  it('⚠️ CHARGES NOTHING WITH THE FLAG ON, AND LEAVES THE CLOCK VISIBLY EXPIRED', () => {
    // Left at zero rather than reset, so it is obvious the rule is off instead of looking like a
    // clock that silently restarts.
    process.env.DISABLE_DELAY_OF_GAME = '1'
    const s = presnap()
    runPlayClock(s, noIo, 0.05)
    expect(s.yardLine).toBe(40)
    expect(s.distance).toBe(10)
    expect(s.down).toBe(1)
    expect(s.playClock).toBe(0)
    expect(s.playClockRunning).toBe(false)
    expect(s.playSerial).toBe(3)        // no replay, so the situation did not change
  })

  it('stopping the clock means it fires once, not every tick', () => {
    process.env.DISABLE_DELAY_OF_GAME = '1'
    const s = presnap()
    for (let i = 0; i < 40; i++) runPlayClock(s, noIo, 0.05)
    expect(s.yardLine).toBe(40)
    expect(s.playClock).toBe(0)
  })

  it('a running clock above zero is untouched either way', () => {
    for (const v of ['1', '0']) {
      process.env.DISABLE_DELAY_OF_GAME = v
      const s = { ...presnap(), playClock: 12 }
      runPlayClock(s, noIo, 0.05)
      expect(s.playClock).toBeCloseTo(11.95, 5)
      expect(s.playClockRunning).toBe(true)
      expect(s.yardLine).toBe(40)
    }
  })
})
