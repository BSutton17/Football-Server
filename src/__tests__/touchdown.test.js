import { describe, it, expect } from '@jest/globals'
import { enqueue, processQueue, EVENT } from '../game/eventQueue.js'
import { runTouchdownDetection } from '../game/systems/touchdownDetection.js'
import { serializePositions } from '../game/serialization.js'
import { createRoom, joinRoom } from '../game/roomManager.js'
import { PHASE } from '../game/stateMachine.js'

function makeMap(players) {
  const m = new Map()
  for (const p of players) m.set(p.id, p)
  return m
}

function mockIo() {
  const emits = []
  return { emits, to: (socketId) => ({ emit: (event, payload) => emits.push({ socketId, event, payload }) }) }
}

// ── [193] Carrier marker ──────────────────────────────────────────────────────

describe('ball-carrier marker in positions ([193])', () => {
  it('tags the offensive ball carrier with state "ball"', () => {
    const state = {
      direction: 1, ballCarrierId: 'rb1',
      offensePlayers: makeMap([{ id: 'rb1', label: 'RB', x: 26, y: 60 }]),
      defensePlayers: new Map(),
      playDesign: { playType: 'run' },
    }
    const rb = serializePositions(state).find(p => p.id === 'rb1')
    expect(rb.state).toBe('ball')
  })

  it('tags an intercepting defender returning the ball', () => {
    const state = {
      direction: 1, ballCarrierId: 'cb1', interceptionReturn: true,
      offensePlayers: makeMap([{ id: 'wr1', label: 'WR', x: 30, y: 60 }]),
      defensePlayers: makeMap([{ id: 'cb1', label: 'CB', x: 26, y: 55 }]),
      playDesign: { playType: 'pass' },
    }
    const cb = serializePositions(state).find(p => p.id === 'cb1')
    expect(cb.state).toBe('ball')
  })
})

// ── [194] Touchdown detection ─────────────────────────────────────────────────

describe('touchdown detection ([194])', () => {
  it('fires when the offense carrier crosses the opponent goal line', () => {
    const state = {
      roomId: 'td-det-1', direction: 1, possession: 0, tackleEnqueued: false, interceptionReturn: false,
      ballCarrierId: 'rb1',
      offensePlayers: makeMap([{ id: 'rb1', label: 'RB', x: 26, y: 111 }]),   // rel 101 ≥ 100
      defensePlayers: new Map(), playDesign: { playType: 'run' },
    }
    runTouchdownDetection(state, null, 0.05)
    expect(state.tackleEnqueued).toBe(true)
  })

  it('does not fire short of the goal line', () => {
    const state = {
      roomId: 'td-det-2', direction: 1, possession: 0, tackleEnqueued: false, interceptionReturn: false,
      ballCarrierId: 'rb1',
      offensePlayers: makeMap([{ id: 'rb1', label: 'RB', x: 26, y: 105 }]),   // rel 95 < 100
      defensePlayers: new Map(), playDesign: { playType: 'run' },
    }
    runTouchdownDetection(state, null, 0.05)
    expect(state.tackleEnqueued).toBe(false)
  })

  it('fires a defensive touchdown when a return reaches the original offense goal', () => {
    const state = {
      roomId: 'td-det-3', direction: 1, possession: 0, tackleEnqueued: false, interceptionReturn: true,
      ballCarrierId: 'cb1',
      offensePlayers: makeMap([{ id: 'wr1', label: 'WR', x: 26, y: 40 }]),
      defensePlayers: makeMap([{ id: 'cb1', label: 'CB', x: 26, y: 8 }]),   // rel −2 ≤ 0
      playDesign: { playType: 'pass' },
    }
    runTouchdownDetection(state, null, 0.05)
    expect(state.tackleEnqueued).toBe(true)
  })
})

// ── [195] Awarding points ─────────────────────────────────────────────────────

describe('touchdown scoring ([195])', () => {
  it('awards 7 points, flips to the receiving team, and syncs the score to both players', () => {
    const roomId = 'td-score-1'
    createRoom(roomId, 'sockA')   // slot 0
    joinRoom(roomId, 'sockB')     // slot 1
    const io = mockIo()
    const state = {
      roomId, phase: PHASE.LIVE, direction: 1, yardLine: 98, down: 1, distance: 2,
      possession: 0, score: [0, 0], pendingStaminaRecovery: 0,
      interceptionReturn: false, ballCarrierId: 'rb1',
      offensePlayers: makeMap([{ id: 'rb1', label: 'RB', x: 26, y: 111 }]),
      defensePlayers: new Map(),
    }

    enqueue(roomId, EVENT.TOUCHDOWN, { scoringSlot: 0, x: 26, y: 111 })
    processQueue(roomId, state, io)

    // [51] A TD is 6 points; the scoring team keeps the ball to attempt the extra-point / 2-pt try.
    expect(state.score[0]).toBe(6)
    expect(state.possession).toBe(0)          // scorer keeps the ball for the conversion
    expect(state.direction).toBe(1)           // offensive TD — attacking direction unchanged
    expect(state.conversionPending).toBe(true)
    expect(state.phase).toBe(PHASE.DEAD)

    const scores = io.emits.filter(e => e.event === 'score_update')
    expect(scores).toHaveLength(2)
    expect(scores.find(e => e.socketId === 'sockA').payload).toEqual({ offense: 6, defense: 0 })
    expect(scores.find(e => e.socketId === 'sockB').payload).toEqual({ offense: 0, defense: 6 })

    // [196] both clients get a viewer-relative touchdown event for celebration/audio/animation.
    const tds = io.emits.filter(e => e.event === 'touchdown')
    expect(tds).toHaveLength(2)
    expect(tds.find(e => e.socketId === 'sockA').payload).toEqual({ scored: true,  score: { offense: 6, defense: 0 } })
    expect(tds.find(e => e.socketId === 'sockB').payload).toEqual({ scored: false, score: { offense: 0, defense: 6 } })
  })

  it('a defensive-return touchdown credits the intercepting team', () => {
    const roomId = 'td-score-2'
    createRoom(roomId, 'sockA')   // slot 0 (threw the pick)
    joinRoom(roomId, 'sockB')     // slot 1 (intercepted, returns it)
    const io = mockIo()
    const state = {
      roomId, phase: PHASE.LIVE, direction: 1, yardLine: 50, down: 1, distance: 10,
      possession: 0, score: [0, 0], pendingStaminaRecovery: 0,
      interceptionReturn: true, ballCarrierId: 'cb1',
      offensePlayers: new Map(), defensePlayers: makeMap([{ id: 'cb1', label: 'CB', x: 26, y: 8 }]),
    }

    enqueue(roomId, EVENT.TOUCHDOWN, { scoringSlot: 1, x: 26, y: 8 })
    processQueue(roomId, state, io)

    expect(state.score[1]).toBe(6)            // [51] intercepting team scored (6, then the try)
    expect(state.possession).toBe(1)          // the scoring team keeps the ball for the conversion
    // The returner ran the OTHER way, so the scoring team's attacking direction flips with possession —
    // otherwise the conversion (e.g. a 2-pt try) would line up on the wrong end of the field.
    expect(state.direction).toBe(-1)
    expect(state.conversionPending).toBe(true)
    expect(state.interceptionReturn).toBe(false)
  })
})
