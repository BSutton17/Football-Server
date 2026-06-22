import { describe, it, expect } from '@jest/globals'
import { enqueue, processQueue, EVENT } from '../game/eventQueue.js'
import { createRoom, joinRoom } from '../game/roomManager.js'
import { PHASE } from '../game/stateMachine.js'
import { RULES } from '../constants.js'

function mockIo(socketIds = []) {
  const emits = []
  const sockets = new Map()
  for (const id of socketIds) sockets.set(id, { data: { role: 'unset' } })
  return {
    emits,
    sockets: { sockets },
    to: (id) => ({ emit: (event, payload) => emits.push({ to: id, event, payload }) }),
  }
}

function state(roomId, over = {}) {
  return {
    roomId, phase: PHASE.LIVE, quarter: 1, clock: 0, direction: 1,
    yardLine: 40, down: 3, distance: 4, possession: 0, score: [0, 0],
    pendingStaminaRecovery: 0, clockStopped: false,
    offensePlayers: new Map(), defensePlayers: new Map(),
    ...over,
  }
}

describe('quarter end ([216])', () => {
  it('advances to the next quarter and preserves possession, field, down & distance', () => {
    const s = state('q-1')
    enqueue('q-1', EVENT.CLOCK_EXPIRED, {})
    processQueue('q-1', s, mockIo())

    expect(s.quarter).toBe(2)
    expect(s.clock).toBe(RULES.QUARTER_SECONDS)
    expect(s.phase).toBe(PHASE.DEAD)
    expect(s.possession).toBe(0)        // carried over
    expect(s.yardLine).toBe(40)
    expect(s.down).toBe(3)
    expect(s.distance).toBe(4)
  })

  it('handles a clock that expires between plays (running clock in pre_snap) without throwing', () => {
    const s = state('q-pre', { phase: PHASE.PRE_SNAP })
    enqueue('q-pre', EVENT.CLOCK_EXPIRED, {})
    expect(() => processQueue('q-pre', s, mockIo())).not.toThrow()
    expect(s.quarter).toBe(2)
    expect(s.phase).toBe(PHASE.DEAD)
  })
})

describe('halftime ([217]/[218])', () => {
  it('swaps field direction at Q2→Q3 while preserving score and possession', () => {
    const io = mockIo()
    const s = state('ht-1', { quarter: 2, direction: 1, possession: 1, score: [7, 3] })
    enqueue('ht-1', EVENT.CLOCK_EXPIRED, {})
    processQueue('ht-1', s, io)

    expect(s.quarter).toBe(3)
    expect(s.direction).toBe(-1)        // [217] ends swapped
    expect(s.possession).toBe(1)        // roles preserved
    expect(s.score).toEqual([7, 3])     // score preserved
    expect(io.emits.some(e => e.event === 'halftime')).toBe(true)   // [218]
  })

  it('does not flip direction on a non-halftime quarter change', () => {
    const s = state('ht-2', { quarter: 1, direction: 1 })
    enqueue('ht-2', EVENT.CLOCK_EXPIRED, {})
    processQueue('ht-2', s, mockIo())
    expect(s.direction).toBe(1)
  })
})

describe('game over ([219]/[220])', () => {
  it('ends the game after Q4 and sends each player the viewer-relative result', () => {
    const roomId = 'go-1'
    createRoom(roomId, 'sockA'); joinRoom(roomId, 'sockB')
    const io = mockIo(['sockA', 'sockB'])
    const s = state(roomId, { quarter: RULES.QUARTERS, score: [10, 7] })

    enqueue(roomId, EVENT.CLOCK_EXPIRED, {})
    expect(() => processQueue(roomId, s, io)).not.toThrow()

    expect(s.phase).toBe(PHASE.GAME_OVER)   // [219] terminal — no further snaps
    const go = io.emits.filter(e => e.event === 'game_over')
    expect(go).toHaveLength(2)
    expect(go.find(e => e.to === 'sockA').payload).toEqual({ score: { offense: 10, defense: 7 }, result: 'win' })
    expect(go.find(e => e.to === 'sockB').payload).toEqual({ score: { offense: 7, defense: 10 }, result: 'loss' })
  })

  it('reports a tie when the scores are level ([220])', () => {
    const roomId = 'go-tie'
    createRoom(roomId, 'tieA'); joinRoom(roomId, 'tieB')
    const io = mockIo(['tieA', 'tieB'])
    const s = state(roomId, { quarter: RULES.QUARTERS, score: [14, 14] })

    enqueue(roomId, EVENT.CLOCK_EXPIRED, {})
    processQueue(roomId, s, io)

    const go = io.emits.filter(e => e.event === 'game_over')
    expect(go.find(e => e.to === 'tieA').payload.result).toBe('tie')
    expect(go.find(e => e.to === 'tieB').payload.result).toBe('tie')
  })
})
