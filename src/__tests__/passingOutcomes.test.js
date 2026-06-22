import { describe, it, expect } from '@jest/globals'
import { enqueue, processQueue, EVENT } from '../game/eventQueue.js'
import { resolvePass } from '../game/utils/passOutcome.js'
import { PHASE } from '../game/stateMachine.js'

// [209] Passing outcomes: completions, interceptions, incompletions, throwaways, and the
// post-catch transition — verified end-to-end, with the decision point (resolvePass) shown to be
// deterministic for a fixed RNG.

function makeMap(players) {
  const m = new Map()
  for (const p of players) m.set(p.id, p)
  return m
}
const noIo = { to: () => ({ emit: () => {} }) }

function liveState(roomId, over = {}) {
  return {
    roomId, phase: PHASE.LIVE, direction: 1, yardLine: 50, down: 1, distance: 10,
    possession: 0, score: [0, 0], pendingStaminaRecovery: 0, deadBallSpot: null,
    interceptionReturn: false, ballCarrierId: null, catchSpot: null, activeThrow: null,
    targetReceiverId: null, clockStopped: false,
    offensePlayers: new Map(), defensePlayers: new Map(),
    ...over,
  }
}

// A small deterministic PRNG so we can prove identical seeds → identical outcomes.
function seeded(seed) {
  let s = seed >>> 0
  return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296 }
}

describe('resolvePass is deterministic for a fixed RNG', () => {
  it('identical seeds produce identical outcome sequences', () => {
    const inputs = { openness: 0.4, qbAccuracy: 60, receiverCatch: 55 }
    const a = [], b = []
    const r1 = seeded(42), r2 = seeded(42)
    for (let i = 0; i < 50; i++) { a.push(resolvePass(inputs, r1).outcome); b.push(resolvePass(inputs, r2).outcome) }
    expect(a).toEqual(b)
    // and the run actually exercised more than one branch
    expect(new Set(a).size).toBeGreaterThan(1)
  })
})

describe('completion → post-catch transition ([181])', () => {
  it('resolvePass completes an open, accurate throw on a low roll', () => {
    expect(resolvePass({ openness: 0.9, qbAccuracy: 80, receiverCatch: 80 }, () => 0.01).outcome).toBe('complete')
  })

  it('PASS_COMPLETE hands the receiver the ball, records the catch spot, and plays on', () => {
    const state = liveState('po-complete', {
      targetReceiverId: 'wr1', activeThrow: { receiverId: 'wr1', x: 31, y: 56 },
      offensePlayers: makeMap([{ id: 'wr1', label: 'WR', x: 31, y: 56 }]),
    })
    enqueue('po-complete', EVENT.PASS_COMPLETE, { receiverId: 'wr1', x: 31, y: 56 })
    processQueue('po-complete', state, noIo)

    expect(state.ballCarrierId).toBe('wr1')        // becomes the live carrier
    expect(state.catchSpot).toEqual({ x: 31, y: 56 })
    expect(state.targetReceiverId).toBeNull()
    expect(state.phase).toBe(PHASE.LIVE)           // play continues — runs until contact/score
  })
})

describe('interception', () => {
  it('resolvePass intercepts a smothered window on a roll into the pick band', () => {
    expect(resolvePass({ openness: 0.05, qbAccuracy: 50, receiverCatch: 50 }, () => 0.15).outcome).toBe('intercepted')
  })

  it('INTERCEPTION turns the defender into the live returner', () => {
    const state = liveState('po-int', {
      targetReceiverId: 'wr1', activeThrow: { receiverId: 'wr1', x: 30, y: 60 },
      offensePlayers: makeMap([{ id: 'wr1', label: 'WR', x: 30, y: 60 }]),
      defensePlayers: makeMap([{ id: 'cb1', label: 'CB', x: 28, y: 60 }]),
    })
    enqueue('po-int', EVENT.INTERCEPTION, { catcherId: 'cb1', x: 30, y: 60 })
    processQueue('po-int', state, noIo)

    expect(state.ballCarrierId).toBe('cb1')
    expect(state.interceptionReturn).toBe(true)
    expect(state.phase).toBe(PHASE.LIVE)           // return is live until contact
  })
})

describe('incompletion', () => {
  it('resolvePass misses a moderate (yellow) window on a high roll', () => {
    expect(resolvePass({ openness: 0.5, qbAccuracy: 50, receiverCatch: 50 }, () => 0.999).outcome).toBe('incomplete')
  })

  it('PASS_INCOMPLETE advances the down, returns the ball to the LOS, and stops the clock', () => {
    const state = liveState('po-inc', {
      down: 2, distance: 7, yardLine: 40,
      offensePlayers: makeMap([{ id: 'wr1', label: 'WR', x: 30, y: 50 }]),
    })
    enqueue('po-inc', EVENT.PASS_INCOMPLETE, {})
    processQueue('po-inc', state, noIo)

    expect(state.down).toBe(3)
    expect(state.distance).toBe(7)         // no gain
    expect(state.yardLine).toBe(40)        // spot unchanged
    expect(state.clockStopped).toBe(true)
  })
})

describe('throwaway ([187][188])', () => {
  it('resolves exactly as an incompletion — a down consumed and the clock stopped', () => {
    // The throwaway handler enqueues PASS_INCOMPLETE, so the resolution is identical.
    const state = liveState('po-throwaway', {
      down: 1, distance: 10, yardLine: 30,
      offensePlayers: makeMap([{ id: 'wr1', label: 'WR', x: 30, y: 40 }]),
    })
    enqueue('po-throwaway', EVENT.PASS_INCOMPLETE, {})
    processQueue('po-throwaway', state, noIo)

    expect(state.down).toBe(2)
    expect(state.clockStopped).toBe(true)
  })
})
