import { describe, it, expect } from '@jest/globals'
import {
  DECISION, DECISION_SECONDS,
  canFieldGoal, canPunt, isDecisionLegal, decisionDefault, decisionRequired,
  serializeDecision,
} from '../game/specialTeams.js'
import { resolveDecision } from '../game/eventQueue.js'
import { runDecisionClock } from '../game/systems/decisionClock.js'
import { createRoom, joinRoom } from '../game/roomManager.js'
import { PHASE } from '../game/stateMachine.js'

function mockIo() {
  return { to() { return { emit() {} } } }
}
function room(roomId) {
  createRoom(roomId, 'sockA')
  joinRoom(roomId, 'sockB')
}

// ── [4] Legality by field position ───────────────────────────────────────────────

describe('field-goal legality — only past midfield', () => {
  it('is illegal at or before midfield, legal once crossed', () => {
    expect(canFieldGoal({ down: 4, yardLine: 49 })).toBe(false)
    expect(canFieldGoal({ down: 4, yardLine: 50 })).toBe(false)   // AT midfield ≠ crossed
    expect(canFieldGoal({ down: 4, yardLine: 51 })).toBe(true)
    expect(canFieldGoal({ down: 4, yardLine: 80 })).toBe(true)
  })
  it('is only a 4th-down option', () => {
    expect(canFieldGoal({ down: 3, yardLine: 80 })).toBe(false)
  })
})

describe('punt legality — unavailable at the opponent 35 and in', () => {
  it('is legal in your own territory, illegal from the opponent 35 (yardLine 65)+', () => {
    expect(canPunt({ down: 4, yardLine: 20 })).toBe(true)
    expect(canPunt({ down: 4, yardLine: 64 })).toBe(true)
    expect(canPunt({ down: 4, yardLine: 65 })).toBe(false)
    expect(canPunt({ down: 4, yardLine: 80 })).toBe(false)
  })
})

describe('go for it / option legality', () => {
  it('Go For It is always legal on 4th down', () => {
    expect(isDecisionLegal({ down: 4, yardLine: 5 }, DECISION.GO_FOR_IT)).toBe(true)
    expect(isDecisionLegal({ down: 4, yardLine: 95 }, DECISION.GO_FOR_IT)).toBe(true)
  })
  it('rejects an unknown option', () => {
    expect(isDecisionLegal({ down: 4, yardLine: 50 }, 'kneel')).toBe(false)
  })
})

describe('auto-pick default', () => {
  it('punts from your own end / midfield', () => {
    expect(decisionDefault({ down: 4, yardLine: 20 })).toBe(DECISION.PUNT)
    expect(decisionDefault({ down: 4, yardLine: 60 })).toBe(DECISION.PUNT)   // both legal → punt
  })
  it('kicks the field goal once punting is off the table (opponent 35+)', () => {
    expect(decisionDefault({ down: 4, yardLine: 70 })).toBe(DECISION.FIELD_GOAL)
  })
})

describe('decisionRequired', () => {
  it('only on a pre-snap 4th down that is not already a kick', () => {
    expect(decisionRequired({ phase: PHASE.PRE_SNAP, down: 4, specialTeams: null })).toBe(true)
    expect(decisionRequired({ phase: PHASE.PRE_SNAP, down: 3, specialTeams: null })).toBe(false)
    expect(decisionRequired({ phase: PHASE.LIVE, down: 4, specialTeams: null })).toBe(false)
    expect(decisionRequired({ phase: PHASE.PRE_SNAP, down: 4, specialTeams: {} })).toBe(false)
  })
})

// ── [2][3] The menu the offense sees ─────────────────────────────────────────────

describe('serializeDecision', () => {
  it('returns null when no decision is pending', () => {
    expect(serializeDecision({ decisionPending: false }, 0)).toBeNull()
  })
  it('is shown only to the offense, with viewer-relative legality and a countdown', () => {
    const state = { decisionPending: true, decisionTimer: 4.2, possession: 0, down: 4, yardLine: 70 }
    expect(serializeDecision(state, 1)).toBeNull()   // defense doesn't choose
    const menu = serializeDecision(state, 0)
    expect(menu.context).toBe('fourth_down')
    expect(menu.secondsRemaining).toBe(5)            // ceil(4.2)
    expect(menu.defaultOption).toBe(DECISION.FIELD_GOAL)   // yardLine 70: punt illegal, FG legal
    const legal = Object.fromEntries(menu.options.map(o => [o.id, o.legal]))
    expect(legal[DECISION.GO_FOR_IT]).toBe(true)
    expect(legal[DECISION.PUNT]).toBe(false)
    expect(legal[DECISION.FIELD_GOAL]).toBe(true)
  })
})

// ── Resolving the choice (server-authoritative routing) ──────────────────────────

function decisionState(roomId, { yardLine = 30, possession = 0 } = {}) {
  return {
    roomId, phase: PHASE.PRE_SNAP, direction: 1, yardLine, down: 4, distance: 10,
    possession, score: [0, 0], pendingStaminaRecovery: 0, deadBallSpot: null,
    decisionPending: true, decisionTimer: DECISION_SECONDS,
    interceptionReturn: false, tackleEnqueued: false, specialTeams: null,
    offensePlayers: new Map(), defensePlayers: new Map(),
  }
}

describe('resolveDecision — routes the choice into the kicking engine', () => {
  it('Punt clears the menu and brings up the punt kicking interface', () => {
    const roomId = 'dec-punt'; room(roomId)
    const state = decisionState(roomId, { yardLine: 30 })
    resolveDecision(state, mockIo(), DECISION.PUNT)
    expect(state.decisionPending).toBe(false)
    expect(state.specialTeams?.kickType).toBe('punt')
    expect(state.possession).toBe(0)   // not flipped yet — the kick hasn't been struck
  })

  it('Field Goal brings up the field-goal kicking interface', () => {
    const roomId = 'dec-fg'; room(roomId)
    const state = decisionState(roomId, { yardLine: 78 })
    resolveDecision(state, mockIo(), DECISION.FIELD_GOAL)
    expect(state.specialTeams?.kickType).toBe('field_goal')
  })

  it('an illegal option falls back to the default (FG inside own territory → punt)', () => {
    const roomId = 'dec-illegal'; room(roomId)
    const state = decisionState(roomId, { yardLine: 30 })   // FG illegal here
    resolveDecision(state, mockIo(), DECISION.FIELD_GOAL)
    expect(state.specialTeams?.kickType).toBe('punt')   // fell back to punt (the default)
  })

  it('Go For It just clears the menu (no kick)', () => {
    const roomId = 'dec-go'; room(roomId)
    const state = decisionState(roomId, { yardLine: 45 })
    resolveDecision(state, mockIo(), DECISION.GO_FOR_IT)
    expect(state.decisionPending).toBe(false)
    expect(state.specialTeams).toBeNull()
    expect(state.possession).toBe(0)
  })
})

describe('runDecisionClock — auto-pick on timeout', () => {
  it('counts down and auto-selects the default at zero (→ kicking interface)', () => {
    const roomId = 'dec-timer'; room(roomId)
    const state = decisionState(roomId, { yardLine: 30 })
    state.decisionTimer = 0.04
    runDecisionClock(state, mockIo(), 0.05)   // ticks below zero → auto-pick (punt)
    expect(state.decisionPending).toBe(false)
    expect(state.specialTeams?.kickType).toBe('punt')
  })
  it('does nothing while time remains', () => {
    const roomId = 'dec-timer2'; room(roomId)
    const state = decisionState(roomId, { yardLine: 30 })
    state.decisionTimer = 3
    runDecisionClock(state, mockIo(), 0.05)
    expect(state.decisionPending).toBe(true)
    expect(state.decisionTimer).toBeCloseTo(2.95)
  })
})
