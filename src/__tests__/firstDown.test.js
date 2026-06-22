import { describe, it, expect } from '@jest/globals'
import { enqueue, processQueue, EVENT } from '../game/eventQueue.js'
import { createRoom, joinRoom } from '../game/roomManager.js'
import { PHASE } from '../game/stateMachine.js'

// [197] First-down detection / [198] chain reset, exercised through the live tackle path
// (onTackle spots the ball, then advanceDown decides the next series). The detection/reset math
// itself is unit-tested in gameState.test.js; these confirm the end-to-end play resolution.

function makeMap(players) {
  const m = new Map()
  for (const p of players) m.set(p.id, p)
  return m
}

function mockIo() {
  const emits = []
  return { emits, to: (socketId) => ({ emit: (event, payload) => emits.push({ socketId, event, payload }) }) }
}

function baseState(roomId, over) {
  return {
    roomId, phase: PHASE.LIVE, direction: 1, yardLine: 25, down: 3, distance: 5,
    possession: 0, pendingStaminaRecovery: 0, deadBallSpot: null,
    interceptionReturn: false, tackleEnqueued: false,
    offensePlayers: makeMap([{ id: 'rb1', label: 'RB', x: 26, y: 45 }]),
    defensePlayers: new Map(),
    ...over,
  }
}

describe('first-down conversion ([197]/[198])', () => {
  it('a tackle past the marker resets to 1st & 10 and keeps possession', () => {
    const roomId = 'fd-1'
    createRoom(roomId, 'sA'); joinRoom(roomId, 'sB')
    const io = mockIo()
    // LOS at y=35 (yardLine 25). Tackled at y=45 → 10-yard gain, past the 5 to go.
    const state = baseState(roomId)

    enqueue(roomId, EVENT.TACKLE, { carrierId: 'rb1', x: 26, y: 45 })
    processQueue(roomId, state, io)

    expect(state.down).toBe(1)            // [198] fresh series
    expect(state.distance).toBe(10)       // chains reset
    expect(state.yardLine).toBeCloseTo(35, 6)   // field position preserved at the spot
    expect(state.possession).toBe(0)      // no turnover
    expect(io.emits.filter(e => e.event === 'switch_sides')).toHaveLength(0)
  })

  it('a tackle short of the marker advances the down without resetting the chains', () => {
    const roomId = 'fd-2'
    createRoom(roomId, 'sA'); joinRoom(roomId, 'sB')
    const io = mockIo()
    // 3rd & 5 from the 25; tackled at y=43 → 8 yards? No: spot y=43 ⇒ rel 33, gain 8 ⇒ first down.
    // Use a 3-yard gain instead: tackled at y=38 ⇒ rel 28, gain 3 (< 5) ⇒ 4th & 2.
    const state = baseState(roomId, { offensePlayers: makeMap([{ id: 'rb1', label: 'RB', x: 26, y: 38 }]) })

    enqueue(roomId, EVENT.TACKLE, { carrierId: 'rb1', x: 26, y: 38 })
    processQueue(roomId, state, io)

    expect(state.down).toBe(4)
    expect(state.distance).toBeCloseTo(2, 6)
    expect(state.yardLine).toBeCloseTo(28, 6)
    expect(state.possession).toBe(0)
  })
})
