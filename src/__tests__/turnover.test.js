import { describe, it, expect } from '@jest/globals'
import { enqueue, processQueue, EVENT } from '../game/eventQueue.js'
import { createRoom, joinRoom } from '../game/roomManager.js'
import { PHASE } from '../game/stateMachine.js'

// [192] A turnover (interception or failure on downs) flips possession AND pushes each client
// its new role via switch_sides. We register a room with two fake sockets and capture emits.

function mockIo() {
  const emits = []
  return {
    emits,
    to(socketId) {
      return { emit: (event, payload) => emits.push({ socketId, event, payload }) }
    },
  }
}

function makeMap(players) {
  const m = new Map()
  for (const p of players) m.set(p.id, p)
  return m
}

function room(roomId) {
  createRoom(roomId, 'sockA')   // slot 0
  joinRoom(roomId, 'sockB')     // slot 1
}

function switchEmits(io) {
  return io.emits.filter(e => e.event === 'switch_sides')
}

describe('turnover role swap ([192])', () => {
  it('an interception return swaps both clients to their new role', () => {
    const roomId = 'turn-int'
    room(roomId)
    const io = mockIo()
    const state = {
      roomId, phase: PHASE.LIVE, direction: 1, yardLine: 50, down: 1, distance: 10,
      possession: 0, pendingStaminaRecovery: 0, deadBallSpot: null,
      interceptionReturn: true, ballCarrierId: 'cb1',
      offensePlayers: makeMap([{ id: 'wr1', label: 'WR', x: 26, y: 30 }]),
      defensePlayers: makeMap([{ id: 'cb1', label: 'CB', x: 26, y: 30 }]),
    }

    enqueue(roomId, EVENT.TACKLE, { carrierId: 'cb1', x: 26, y: 30, interceptionReturn: true })
    processQueue(roomId, state, io)

    expect(state.possession).toBe(1)
    const sw = switchEmits(io)
    expect(sw).toHaveLength(2)
    expect(sw.find(e => e.socketId === 'sockA').payload).toEqual({ role: 'defense' })  // lost the ball
    expect(sw.find(e => e.socketId === 'sockB').payload).toEqual({ role: 'offense' })  // gained it
  })

  it('a failed 4th down swaps roles', () => {
    const roomId = 'turn-downs'
    room(roomId)
    const io = mockIo()
    const state = {
      roomId, phase: PHASE.LIVE, direction: 1, yardLine: 40, down: 4, distance: 10,
      possession: 0, pendingStaminaRecovery: 0,
      offensePlayers: makeMap([{ id: 'wr1', label: 'WR', x: 26, y: 50 }]),
      defensePlayers: new Map(), interceptionReturn: false,
    }

    enqueue(roomId, EVENT.PASS_INCOMPLETE, {})
    processQueue(roomId, state, io)

    expect(state.possession).toBe(1)
    const sw = switchEmits(io)
    expect(sw).toHaveLength(2)
    expect(sw.find(e => e.socketId === 'sockA').payload).toEqual({ role: 'defense' })
    expect(sw.find(e => e.socketId === 'sockB').payload).toEqual({ role: 'offense' })
  })

  it('a routine incompletion with downs remaining does NOT swap roles', () => {
    const roomId = 'turn-none'
    room(roomId)
    const io = mockIo()
    const state = {
      roomId, phase: PHASE.LIVE, direction: 1, yardLine: 40, down: 1, distance: 10,
      possession: 0, pendingStaminaRecovery: 0,
      offensePlayers: makeMap([{ id: 'wr1', label: 'WR', x: 26, y: 50 }]),
      defensePlayers: new Map(), interceptionReturn: false,
    }

    enqueue(roomId, EVENT.PASS_INCOMPLETE, {})
    processQueue(roomId, state, io)

    expect(state.possession).toBe(0)
    expect(switchEmits(io)).toHaveLength(0)
  })
})

// ── [199] turnover on downs / [200] turnover field position ───────────────────
//
// On a 4th-down failure the new offense inherits the ball at the exact turnover spot, mirrored
// into its own frame (the same physical location). down/distance reset to a fresh series.
describe('turnover on downs — spot inheritance ([199]/[200])', () => {
  it('a tackle short on 4th down moves the LOS to the tackle spot for the new offense', () => {
    const roomId = 'tod-tackle'
    room(roomId)
    const io = mockIo()
    // LOS at y=70 (yardLine 60, dir 1), 4th & 5. Tackled at y=72 → spot rel 62, a 2-yard gain
    // (short of the 5 to go) → turnover on downs.
    const state = {
      roomId, phase: PHASE.LIVE, direction: 1, yardLine: 60, down: 4, distance: 5,
      possession: 0, pendingStaminaRecovery: 0, deadBallSpot: null,
      interceptionReturn: false, tackleEnqueued: false,
      offensePlayers: makeMap([{ id: 'rb1', label: 'RB', x: 26, y: 72 }]),
      defensePlayers: new Map(),
    }

    enqueue(roomId, EVENT.TACKLE, { carrierId: 'rb1', x: 26, y: 72 })
    processQueue(roomId, state, io)

    expect(state.possession).toBe(1)
    expect(state.direction).toBe(-1)
    expect(state.yardLine).toBeCloseTo(38, 6)   // spot rel 62 mirrors to 100−62 for the new offense
    expect(state.down).toBe(1)
    expect(state.distance).toBe(10)
    expect(state.deadBallSpot).toEqual({ x: 26, y: 72 })   // exact physical spot preserved
  })

  it('a 4th-down incompletion hands over at the previous line of scrimmage', () => {
    const roomId = 'tod-incomplete'
    room(roomId)
    const io = mockIo()
    const state = {
      roomId, phase: PHASE.LIVE, direction: 1, yardLine: 45, down: 4, distance: 8,
      possession: 0, pendingStaminaRecovery: 0,
      offensePlayers: makeMap([{ id: 'wr1', label: 'WR', x: 26, y: 55 }]),
      defensePlayers: new Map(), interceptionReturn: false,
    }

    enqueue(roomId, EVENT.PASS_INCOMPLETE, {})
    processQueue(roomId, state, io)

    expect(state.possession).toBe(1)
    expect(state.yardLine).toBeCloseTo(55, 6)   // no gain on the incompletion → LOS 45 mirrors to 55
    expect(state.down).toBe(1)
    expect(state.distance).toBe(10)
  })
})
