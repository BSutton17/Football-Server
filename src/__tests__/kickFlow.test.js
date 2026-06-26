import { describe, it, expect } from '@jest/globals'
import { beginSpecialTeams, applyKickInput, KICK, ST_PHASE, KICK_TIMER_SECONDS } from '../game/specialTeams.js'
import { runKickClock } from '../game/systems/kickClock.js'
import { enqueue, processQueue, EVENT } from '../game/eventQueue.js'
import { createRoom, joinRoom } from '../game/roomManager.js'
import { PHASE } from '../game/stateMachine.js'

// [Special Teams][6][7][8][9] The kicking interface: a full power meter that drains over the 3.5s
// timer (started by input or the 5s inactivity window), then the unified engine resolves the kick.

function mockIo() {
  return { to() { return { emit() {} } } }
}
function room(roomId) {
  createRoom(roomId, 'sockA')
  joinRoom(roomId, 'sockB')
}
function kickState(roomId, kickType, { yardLine = 40 } = {}) {
  return {
    roomId, phase: PHASE.PRE_SNAP, direction: 1, yardLine, down: 4, distance: 10,
    possession: 0, score: [0, 0], pendingStaminaRecovery: 0, deadBallSpot: null,
    interceptionReturn: false, tackleEnqueued: false, specialTeams: null,
    offensePlayers: new Map(), defensePlayers: new Map(),
  }
}

describe('[7] kick initialization', () => {
  it('begins with a full power meter, centered aim, and the timer idle', () => {
    const state = kickState('ki', KICK.FIELD_GOAL); room('ki')
    beginSpecialTeams(state, KICK.FIELD_GOAL, { kickingSlot: 0 })
    const st = state.specialTeams
    expect(st.power).toBe(1)
    expect(st.angle).toBe(0)
    expect(st.started).toBe(false)
    expect(st.kickTimer).toBeCloseTo(KICK_TIMER_SECONDS)
  })
})

describe('[8] kick timer', () => {
  it('auto-starts the kick after the 5s inactivity window', () => {
    const state = kickState('kt-auto', KICK.FIELD_GOAL); room('kt-auto')
    beginSpecialTeams(state, KICK.FIELD_GOAL, { kickingSlot: 0 })
    const st = state.specialTeams
    st.inactivityTimer = 0.04
    runKickClock(state, mockIo(), 0.05)   // inactivity expires → started
    expect(st.started).toBe(true)
    expect(st.power).toBe(1)              // power only drains once started
  })

  it('does not drain power before the kick starts', () => {
    const state = kickState('kt-idle', KICK.PUNT); room('kt-idle')
    beginSpecialTeams(state, KICK.PUNT, { kickingSlot: 0 })
    runKickClock(state, mockIo(), 0.05)   // still idle (inactivity ticking)
    expect(state.specialTeams.power).toBe(1)
    expect(state.specialTeams.started).toBe(false)
  })
})

describe('[9][10] power meter drains continuously once started, refilled by taps', () => {
  it('halfway through the timer with no taps the meter is ~half full', () => {
    const state = kickState('pm', KICK.PUNT); room('pm')
    beginSpecialTeams(state, KICK.PUNT, { kickingSlot: 0 })
    const st = state.specialTeams
    st.started = true
    const half = KICK_TIMER_SECONDS / 2
    let elapsed = 0
    while (elapsed < half) { runKickClock(state, mockIo(), 0.05); elapsed += 0.05 }
    expect(st.power).toBeCloseTo(0.5, 1)
    expect(st.phase).toBe(ST_PHASE.SETUP)   // not executed yet
  })

  it('a directional tap fights the drain back up (+2%)', () => {
    const state = kickState('pm-tap', KICK.PUNT); room('pm-tap')
    beginSpecialTeams(state, KICK.PUNT, { kickingSlot: 0 })
    const st = state.specialTeams
    st.started = true; st.power = 0.5
    applyKickInput(state, 0, { aim: 'right' })
    expect(st.power).toBeCloseTo(0.52)
  })
})

// Execution now fires only when the 3.5s timer expires; we set the timer near zero and tick once.
function fireKick(state) {
  state.specialTeams.started   = true
  state.specialTeams.kickTimer = 0.04
  runKickClock(state, mockIo(), 0.05)
}

describe('[6][8] kick execution', () => {
  it('a short field goal at full power is good → +3 and kickoff', () => {
    const state = kickState('ex-fg-make', KICK.FIELD_GOAL, { yardLine: 90 }); room('ex-fg-make')
    beginSpecialTeams(state, KICK.FIELD_GOAL, { kickingSlot: 0 })
    state.specialTeams.angle = 0; state.specialTeams.power = 1   // full power, dead center → made
    fireKick(state)
    expect(state.score[0]).toBe(3)
    expect(state.possession).toBe(1)     // kickoff to the other team
    expect(state.yardLine).toBe(30)      // receiving team's own 30 ([5])
  })

  it('a long field goal at low power is no good → turnover at the spot, no points', () => {
    const state = kickState('ex-fg-miss', KICK.FIELD_GOAL, { yardLine: 51 }); room('ex-fg-miss')
    beginSpecialTeams(state, KICK.FIELD_GOAL, { kickingSlot: 0 })
    state.specialTeams.angle = 0; state.specialTeams.power = 0.4   // distance ~43 < required 66 → short
    fireKick(state)
    expect(state.score[0]).toBe(0)
    expect(state.possession).toBe(1)
  })

  it('a punt hands possession to the other team downfield', () => {
    const state = kickState('ex-punt', KICK.PUNT, { yardLine: 30 }); room('ex-punt')
    beginSpecialTeams(state, KICK.PUNT, { kickingSlot: 0 })
    state.specialTeams.angle = 0; state.specialTeams.power = 0.5   // ~47 yd punt
    fireKick(state)
    expect(state.possession).toBe(1)
    expect(state.yardLine).toBeGreaterThan(0)
  })
})

describe('[specialists] the kicking team\'s real Punter/Kicker drives the kick', () => {
  function puntSpot(roomId, teams) {
    const state = kickState(roomId, KICK.PUNT, { yardLine: 30 }); room(roomId)
    if (teams) state.teams = teams
    beginSpecialTeams(state, KICK.PUNT, { kickingSlot: 0 })
    state.specialTeams.angle = 0; state.specialTeams.power = 0.5
    fireKick(state)
    return state.yardLine   // receiving team's spot (lower = pinned deeper = a longer punt)
  }

  it('a strong-legged punter (DAL Bryan Anger 97) out-punts the default', () => {
    const dal     = puntSpot('sp-dal', ['DAL', 'SEA'])   // punter power 97
    const dflt     = puntSpot('sp-none', null)            // no team → default 75
    expect(dal).toBeLessThan(dflt)
  })
})

describe('[20] kickoff placement — receiving team at its own 30, no return', () => {
  it('a score kicks off to the other team at the 30 automatically', () => {
    const roomId = 'ko'; room(roomId)
    const state = {
      roomId, phase: PHASE.LIVE, direction: 1, yardLine: 95, down: 1, distance: 5,
      possession: 0, score: [0, 0], pendingStaminaRecovery: 0, specialTeams: null,
      interceptionReturn: false, tackleEnqueued: false, ballX: 26,
      offensePlayers: new Map([['rb1', { id: 'rb1', label: 'RB', x: 26, y: 111 }]]),
      defensePlayers: new Map(),
    }
    enqueue(roomId, EVENT.TOUCHDOWN, { scoringSlot: 0, carrierId: 'rb1', x: 26, y: 111 })
    processQueue(roomId, state, mockIo())

    expect(state.possession).toBe(1)              // receiving team is the one that was scored on
    expect(state.yardLine).toBe(30)               // their own 30
    expect(state.specialTeams.kickType).toBe(KICK.KICKOFF)
    expect(state.specialTeams.playerControlled).toBe(false)   // automatic — no input, no return
  })
})
