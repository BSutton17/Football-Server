import { describe, it, expect } from '@jest/globals'
import { enqueue, processQueue, EVENT } from '../game/eventQueue.js'
import { createRoom, joinRoom } from '../game/roomManager.js'
import { PHASE } from '../game/stateMachine.js'

// [211] Possession swap system + [212] field flip + [214] LOS reset + [215] state preservation.
// One path (notifyRoleSwap) swaps both players' roles after a TD, interception, turnover on
// downs, or safety: it updates the authoritative server role (socket.data.role) AND emits
// switch_sides to each client, so both switch responsibilities in place.

function makeMap(players) {
  const m = new Map()
  for (const p of players) m.set(p.id, p)
  return m
}

// Mock io with a socket registry so we can verify socket.data.role is updated server-side.
function mockIo(socketIds) {
  const emits = []
  const sockets = new Map()
  for (const id of socketIds) sockets.set(id, { data: { role: 'unset' } })
  return {
    emits,
    sockets: { sockets },
    to: (socketId) => ({ emit: (event, payload) => emits.push({ socketId, event, payload }) }),
  }
}

function room(roomId) {
  createRoom(roomId, 'sockA')   // slot 0
  joinRoom(roomId, 'sockB')     // slot 1
  return mockIo(['sockA', 'sockB'])
}

function liveState(roomId, over = {}) {
  return {
    roomId, phase: PHASE.LIVE, direction: 1, yardLine: 50, down: 1, distance: 10,
    possession: 0, score: [0, 0], clock: 250, pendingStaminaRecovery: 0, deadBallSpot: null,
    interceptionReturn: false, ballCarrierId: null, clockStopped: false,
    offensePlayers: new Map(), defensePlayers: new Map(),
    ...over,
  }
}

function rolesAfter(io) {
  return {
    sockA: io.sockets.sockets.get('sockA').data.role,
    sockB: io.sockets.sockets.get('sockB').data.role,
    switches: io.emits.filter(e => e.event === 'switch_sides'),
  }
}

describe('possession swap — roles switch for both players ([211])', () => {
  it('turnover on downs swaps server role AND notifies both clients', () => {
    const io = room('ps-tod')
    const s = liveState('ps-tod', { down: 4, distance: 5, yardLine: 60 })
    enqueue('ps-tod', EVENT.TACKLE, { carrierId: 'rb1', x: 26, y: 72 })   // +2, short on 4th (LOS y=70)
    processQueue('ps-tod', s, io)

    const r = rolesAfter(io)
    expect(s.possession).toBe(1)
    expect(r.sockA).toBe('defense')   // slot 0 lost the ball
    expect(r.sockB).toBe('offense')   // slot 1 gained it
    expect(r.switches.find(e => e.socketId === 'sockA').payload).toEqual({ role: 'defense' })
    expect(r.switches.find(e => e.socketId === 'sockB').payload).toEqual({ role: 'offense' })
  })

  it('an interception swaps both players', () => {
    const io = room('ps-int')
    const s = liveState('ps-int', {
      interceptionReturn: true, ballCarrierId: 'cb1',
      defensePlayers: makeMap([{ id: 'cb1', label: 'CB', x: 26, y: 30 }]),
    })
    enqueue('ps-int', EVENT.TACKLE, { carrierId: 'cb1', x: 26, y: 30, interceptionReturn: true })
    processQueue('ps-int', s, io)

    const r = rolesAfter(io)
    expect(s.possession).toBe(1)
    expect(r.sockA).toBe('defense')
    expect(r.sockB).toBe('offense')
  })

  it('a touchdown swaps both players (scoring team kicks off → defense)', () => {
    const io = room('ps-td')
    const s = liveState('ps-td', { yardLine: 98, ballCarrierId: 'rb1',
      offensePlayers: makeMap([{ id: 'rb1', label: 'RB', x: 26, y: 111 }]) })
    enqueue('ps-td', EVENT.TOUCHDOWN, { scoringSlot: 0, x: 26, y: 111 })
    processQueue('ps-td', s, io)

    const r = rolesAfter(io)
    expect(s.possession).toBe(1)        // receiving team
    expect(r.sockA).toBe('defense')     // slot 0 scored, now kicks off
    expect(r.sockB).toBe('offense')
  })

  it('a safety swaps both players', () => {
    const io = room('ps-safety')
    const s = liveState('ps-safety')
    enqueue('ps-safety', EVENT.SAFETY, { safetySlot: 0 })
    processQueue('ps-safety', s, io)

    const r = rolesAfter(io)
    expect(s.score[1]).toBe(2)
    expect(s.possession).toBe(1)
    expect(r.sockA).toBe('defense')
    expect(r.sockB).toBe('offense')
  })
})

describe('field flip & field position on possession change ([212]/[214])', () => {
  it('a turnover flips the field direction and spots the ball at the turnover location', () => {
    const io = room('ps-flip')
    const s = liveState('ps-flip', { down: 4, distance: 5, yardLine: 60, direction: 1 })
    enqueue('ps-flip', EVENT.TACKLE, { carrierId: 'rb1', x: 26, y: 72 })   // LOS y=70 → +2, short on 4th
    processQueue('ps-flip', s, io)
    expect(s.direction).toBe(-1)            // [212] field reverses for the new offense
    expect(s.yardLine).toBeCloseTo(38, 6)   // [214] spot rel 62 → 100−62
  })

  it('a touchdown spots the receiving team at its own 25 with the field flipped', () => {
    const io = room('ps-td-spot')
    const s = liveState('ps-td-spot', { direction: 1, yardLine: 98, ballCarrierId: 'rb1',
      offensePlayers: makeMap([{ id: 'rb1', label: 'RB', x: 26, y: 111 }]) })
    enqueue('ps-td-spot', EVENT.TOUCHDOWN, { scoringSlot: 0, x: 26, y: 111 })
    processQueue('ps-td-spot', s, io)
    expect(s.direction).toBe(-1)   // receiving slot 1 → direction -1
    expect(s.yardLine).toBe(25)    // [214] kickoff spot
  })
})

describe('state preserved across a possession change ([215])', () => {
  it('the game clock is untouched and the score reflects only the points scored', () => {
    const io = room('ps-preserve')
    const s = liveState('ps-preserve', { clock: 187.5, score: [3, 10], yardLine: 98, ballCarrierId: 'rb1',
      offensePlayers: makeMap([{ id: 'rb1', label: 'RB', x: 26, y: 111 }]) })
    enqueue('ps-preserve', EVENT.TOUCHDOWN, { scoringSlot: 0, x: 26, y: 111 })
    processQueue('ps-preserve', s, io)
    expect(s.clock).toBe(187.5)    // clock preserved (a TD doesn't run time off)
    expect(s.score).toEqual([10, 10])   // only +7 to the scorer
  })
})
