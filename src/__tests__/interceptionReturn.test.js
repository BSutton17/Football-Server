import { describe, it, expect } from '@jest/globals'
import { enqueue, processQueue, EVENT } from '../game/eventQueue.js'
import { runMovement, findBallCarrier } from '../game/systems/movement.js'
import { runTackleDetection } from '../game/systems/tackleDetection.js'
import { PHASE } from '../game/stateMachine.js'

const DT = 0.05

function makeMap(players) {
  const m = new Map()
  for (const p of players) m.set(p.id, p)
  return m
}

// ── [189] Ownership transfer ───────────────────────────────────────────────────

describe('interception ownership transfer ([189])', () => {
  it('the intercepting defender becomes the live ball carrier (play stays live)', () => {
    const state = {
      roomId: 'int-1',
      phase: PHASE.LIVE,
      direction: 1,
      offensePlayers: makeMap([{ id: 'wr1', label: 'WR', x: 30, y: 60 }]),
      defensePlayers: makeMap([{ id: 'cb1', label: 'CB', x: 26, y: 55 }]),
      ballCarrierId: null,
      targetReceiverId: 'wr1',
      activeThrow: { receiverId: 'wr1', x: 30, y: 60 },
      interceptionReturn: false,
    }

    enqueue('int-1', EVENT.INTERCEPTION, { catcherId: 'cb1', x: 30, y: 60 })
    processQueue('int-1', state, null)

    expect(state.ballCarrierId).toBe('cb1')
    expect(state.interceptionReturn).toBe(true)
    expect(state.phase).toBe(PHASE.LIVE)            // [190] still live — the return is on
    expect(state.targetReceiverId).toBeNull()
    const cb = state.defensePlayers.get('cb1')
    expect(cb.x).toBeCloseTo(30)                    // dropped at the catch spot
    expect(cb.y).toBeCloseTo(60)
  })

  it('findBallCarrier resolves a carrier that lives on the defense', () => {
    const state = {
      direction: 1,
      offensePlayers: makeMap([{ id: 'wr1', label: 'WR', x: 30, y: 60 }]),
      defensePlayers: makeMap([{ id: 'cb1', label: 'CB', x: 26, y: 55 }]),
      ballCarrierId: 'cb1',
      interceptionReturn: true,
      playDesign: { playType: 'pass' },
    }
    expect(findBallCarrier(state)).toBe(state.defensePlayers.get('cb1'))
  })
})

// ── [190] Return behavior ────────────────────────────────────────────────────────

describe('interception return movement ([190])', () => {
  function returnState(roomId) {
    return {
      roomId,
      direction: 1,                 // original offense advanced toward +y; the return goes −y
      yardLine: 50,
      interceptionReturn: true,
      ballCarrierId: 'cb1',
      offensePlayers: makeMap([{ id: 'wr1', label: 'WR', x: 40, y: 70, vx: 0, vy: 0 }]),
      defensePlayers: makeMap([
        { id: 'cb1', label: 'CB', x: 26, y: 70, vx: 0, vy: 0 },   // the returner
        { id: 's1',  label: 'S',  x: 30, y: 75, vx: 0, vy: 0 },   // an escort
      ]),
      defenseCoverage: new Map(),
      playerFatigue: new Map(),
      playDesign: { playType: 'pass' },
      tick: 0,
    }
  }

  it('the returner runs back toward the original offense goal (against direction)', () => {
    const state = returnState('int-ret-1')
    const cb = state.defensePlayers.get('cb1')
    for (let i = 0; i < 30; i++) runMovement(state, null, DT)
    expect(cb.y).toBeLessThan(70)        // advanced toward −y (the return direction)
  })

  it('the original offense pursues the returner', () => {
    const state = returnState('int-ret-2')
    const wr = state.offensePlayers.get('wr1')
    for (let i = 0; i < 20; i++) runMovement(state, null, DT)
    expect(wr.x).toBeLessThan(40)        // closed laterally toward the returner's lane
  })
})

describe('interception return contact ([190])', () => {
  function contactState(roomId, extra = {}) {
    return {
      roomId,
      direction: 1,
      yardLine: 50,
      interceptionReturn: true,
      ballCarrierId: 'cb1',
      tackleEnqueued: false,
      offensePlayers: makeMap(extra.offense ?? []),
      defensePlayers: makeMap([{ id: 'cb1', label: 'CB', x: 26, y: 50 }, ...(extra.defense ?? [])]),
      playDesign: { playType: 'pass' },
    }
  }

  it('an offensive tackler ends the return on contact', () => {
    const state = contactState('int-tk-1', { offense: [{ id: 'wr1', label: 'WR', x: 26.5, y: 50 }] })
    runTackleDetection(state, null, DT)
    expect(state.tackleEnqueued).toBe(true)
  })

  it('a defensive teammate touching the returner does NOT end the return', () => {
    const state = contactState('int-tk-2', { defense: [{ id: 's1', label: 'S', x: 26.5, y: 50 }] })
    runTackleDetection(state, null, DT)
    expect(state.tackleEnqueued).toBe(false)
  })

  it('does not end the return on position alone — contact is required', () => {
    // A return that reaches the goal line is a defensive touchdown owned by runTouchdownDetection
    // (see touchdown.test.js); tackle detection only ends the return on an offensive tackler's
    // contact, so with no offense nearby it must NOT fire here.
    const state = contactState('int-tk-3')
    state.defensePlayers.get('cb1').y = 8   // at the goal line, but no offensive tackler nearby
    runTackleDetection(state, null, DT)
    expect(state.tackleEnqueued).toBe(false)
  })
})

// ── [191] Offense pursuit after the pick ──────────────────────────────────────

describe('interception pursuit ([191])', () => {
  function returnState(roomId, players) {
    return {
      roomId,
      direction: 1,
      yardLine: 50,
      interceptionReturn: true,
      ballCarrierId: 'cb1',
      tackleEnqueued: false,
      offensePlayers: makeMap(players.offense),
      defensePlayers: makeMap(players.defense),
      defenseCoverage: new Map(),
      playerFatigue: new Map(),
      playDesign: { playType: 'pass' },
      tick: 0,
    }
  }

  it('a pursuer leads the returner (intercept angle), not a flat tail chase', () => {
    // Returner already sprinting toward −y; the pursuer sits level with it, off to the side.
    // A flat chase would aim at the current spot (same y → no vy); a real pursuit angle aims
    // ahead of the carrier, giving the pursuer downfield (−y) velocity.
    const state = returnState('int-pursue-1', {
      offense: [{ id: 'wr1', label: 'WR', x: 44, y: 50, vx: 0, vy: 0, pursuitReaction: 5 }],
      defense: [{ id: 'cb1', label: 'CB', x: 26, y: 50, vx: 0, vy: -8 }],
    })

    runMovement(state, null, DT)

    expect(state.offensePlayers.get('wr1').vy).toBeLessThan(0)   // leading toward the carrier's path
  })

  it('pursuit closes on the returner and ends the play with a tackle', () => {
    const state = returnState('int-pursue-2', {
      offense: [{ id: 'wr1', label: 'WR', x: 26, y: 30, vx: 0, vy: 0 }],   // ahead in the return lane
      defense: [{ id: 'cb1', label: 'CB', x: 26, y: 40, vx: 0, vy: 0 }],
    })

    let ended = false
    for (let i = 0; i < 80 && !ended; i++) {
      runMovement(state, null, DT)
      runTackleDetection(state, null, DT)
      ended = state.tackleEnqueued
    }

    expect(ended).toBe(true)
  })
})

describe('interception return resolution ([189])', () => {
  it('the tackle settles possession to the intercepting team at the spot', () => {
    const state = {
      roomId: 'int-settle-1',
      phase: PHASE.LIVE,
      direction: 1,
      yardLine: 50,
      down: 2,
      distance: 7,
      possession: 0,
      pendingStaminaRecovery: 0,
      interceptionReturn: true,
      ballCarrierId: 'cb1',
      deadBallSpot: null,
      offensePlayers: makeMap([{ id: 'wr1', label: 'WR', x: 26, y: 30 }]),
      defensePlayers: makeMap([{ id: 'cb1', label: 'CB', x: 26, y: 30 }]),
    }

    enqueue('int-settle-1', EVENT.TACKLE, { carrierId: 'cb1', x: 26, y: 30, interceptionReturn: true })
    processQueue('int-settle-1', state, null)

    expect(state.phase).toBe(PHASE.DEAD)
    expect(state.possession).toBe(1)              // flipped to the intercepting team
    expect(state.direction).toBe(-1)              // and the field flips
    expect(state.interceptionReturn).toBe(false)
    expect(state.ballCarrierId).toBeNull()
    expect(state.yardLine).toBeCloseTo(80)        // spot y=30 ⇒ rel 20 ⇒ new offense at 100−20
    expect(state.down).toBe(1)                    // fresh series
  })
})
