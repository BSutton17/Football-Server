import { describe, it, expect } from '@jest/globals'
import { enqueue, processQueue, EVENT } from '../game/eventQueue.js'
import { clampToHash } from '../game/gameState.js'
import { createRoom, joinRoom } from '../game/roomManager.js'
import { PHASE } from '../game/stateMachine.js'
import { HASH, FIELD_CENTER_X, FIELD } from '../constants.js'

// [hash] A dead ball outside a hash mark is spotted ON that hash; between the hashes it keeps its
// exact lateral spot. The next formation lines up on state.ballX.

function mockIo() {
  return { to() { return { emit() {} } } }
}
function makeMap(players) {
  const m = new Map()
  for (const p of players) m.set(p.id, p)
  return m
}
function room(roomId) {
  createRoom(roomId, 'sockA')
  joinRoom(roomId, 'sockB')
}

describe('clampToHash', () => {
  it('pulls a ball outside the left hash onto the left hash', () => {
    expect(clampToHash(2)).toBeCloseTo(HASH.LEFT)
    expect(clampToHash(HASH.LEFT - 0.01)).toBeCloseTo(HASH.LEFT)
  })

  it('pulls a ball outside the right hash onto the right hash', () => {
    expect(clampToHash(FIELD.WIDTH - 2)).toBeCloseTo(HASH.RIGHT)
    expect(clampToHash(HASH.RIGHT + 0.01)).toBeCloseTo(HASH.RIGHT)
  })

  it('keeps a ball between the hashes at its exact spot', () => {
    expect(clampToHash(FIELD_CENTER_X)).toBeCloseTo(FIELD_CENTER_X)
    expect(clampToHash(HASH.LEFT)).toBeCloseTo(HASH.LEFT)
    expect(clampToHash(HASH.RIGHT)).toBeCloseTo(HASH.RIGHT)
  })
})

describe('ballX spotting through the event queue', () => {
  function tackleState(roomId, carrierX) {
    return {
      roomId, phase: PHASE.LIVE, direction: 1, yardLine: 50, down: 1, distance: 10,
      possession: 0, pendingStaminaRecovery: 0, deadBallSpot: null, ballX: FIELD_CENTER_X,
      interceptionReturn: false, tackleEnqueued: false,
      offensePlayers: makeMap([{ id: 'rb1', label: 'RB', x: carrierX, y: 72 }]),
      defensePlayers: new Map(),
    }
  }

  it('a tackle near the left sideline spots the ball on the left hash', () => {
    const roomId = 'hash-left'; room(roomId)
    const state = tackleState(roomId, 4)
    enqueue(roomId, EVENT.TACKLE, { carrierId: 'rb1', x: 4, y: 72 })
    processQueue(roomId, state, mockIo())
    expect(state.ballX).toBeCloseTo(HASH.LEFT)
  })

  it('a tackle near the right sideline spots the ball on the right hash', () => {
    const roomId = 'hash-right'; room(roomId)
    const state = tackleState(roomId, FIELD.WIDTH - 4)
    enqueue(roomId, EVENT.TACKLE, { carrierId: 'rb1', x: FIELD.WIDTH - 4, y: 72 })
    processQueue(roomId, state, mockIo())
    expect(state.ballX).toBeCloseTo(HASH.RIGHT)
  })

  it('a tackle between the hashes keeps the exact lateral spot', () => {
    const roomId = 'hash-mid'; room(roomId)
    const state = tackleState(roomId, 24)
    enqueue(roomId, EVENT.TACKLE, { carrierId: 'rb1', x: 24, y: 72 })
    processQueue(roomId, state, mockIo())
    expect(state.ballX).toBeCloseTo(24)
  })

  it('a touchdown resets the lateral spot to center (kickoff)', () => {
    const roomId = 'hash-td'; room(roomId)
    const state = {
      roomId, phase: PHASE.LIVE, direction: 1, yardLine: 95, down: 1, distance: 5,
      possession: 0, score: [0, 0], pendingStaminaRecovery: 0, ballX: HASH.LEFT,
      interceptionReturn: false, tackleEnqueued: false,
      offensePlayers: makeMap([{ id: 'rb1', label: 'RB', x: 4, y: 110 }]),
      defensePlayers: new Map(),
    }
    enqueue(roomId, EVENT.TOUCHDOWN, { scoringSlot: 0, carrierId: 'rb1', x: 4, y: 110 })
    processQueue(roomId, state, mockIo())
    expect(state.ballX).toBeCloseTo(FIELD_CENTER_X)
  })
})
