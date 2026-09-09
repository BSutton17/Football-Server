import { describe, it, expect, beforeEach } from '@jest/globals'
import {
  beginManualPlay, pressGo, releaseGo, endManualControl, runManualHold,
  isManualGame, isManualPlay, isManualFrozen, armThrowResolution,
  beginPassSuspense, revealPassOutcome, takePendingOutcome, revealLabel,
} from '../game/manual.js'
import { isStopped, stoppageReason, beginStoppage, STOPPAGE } from '../game/pause.js'
import { initGame, deleteGame } from '../game/gameState.js'
import { validateThrowToReceiver, validateThrowaway, validateThrowAtDefender } from '../game/validation.js'
import { PHASE } from '../game/stateMachine.js'
import { MANUAL, GAME_MODE, DIFFICULTY } from '../constants.js'
import { EVENT } from '../game/eventQueue.js'

// ── [manual] The GO-button hold loop ─────────────────────────────────────────
//
// Manual mode freezes play through the shared stoppage framework rather than by zeroing
// velocities, so these tests assert on the stoppage as the source of truth for "is the board
// moving", and on state being preserved across a freeze.

const ROOM = 'manual-room'
const DT = 0.05   // one tick at 20 Hz

// Collects the events the engine emits so tests can assert on what the clients were told.
function fakeIo() {
  const sent = []
  return { sent, to: () => ({ emit: (event, payload) => sent.push({ event, payload }) }) }
}

function manualPassState() {
  const state = initGame(ROOM, 0, { mode: GAME_MODE.MANUAL, difficulty: DIFFICULTY.EASY })
  state.phase = PHASE.LIVE
  state.playDesign = { playType: 'pass', players: [] }
  state.offensePlayers = new Map([
    ['qb',  { id: 'qb',  label: 'QB', x: 26, y: 30 }],
    ['wr1', { id: 'wr1', label: 'WR', x: 40, y: 55, routeWaypointIdx: 2 }],
  ])
  state.defensePlayers = new Map([['cb1', { id: 'cb1', label: 'CB', x: 41, y: 56 }]])
  return state
}

// Runs whole ticks of the hold system, the way the sim would.
function tickFor(state, io, seconds) {
  for (let t = 0; t < Math.round(seconds / DT); t++) runManualHold(state, io, DT)
}

beforeEach(() => deleteGame(ROOM))

describe('mode predicates', () => {
  it('isManualGame follows the game mode', () => {
    expect(isManualGame(manualPassState())).toBe(true)
    deleteGame(ROOM)
    expect(isManualGame(initGame(ROOM, 0))).toBe(false)
  })

  it('only PASS plays are driven by GO — a run play keeps the original behaviour', () => {
    const state = manualPassState()
    expect(isManualPlay(state)).toBe(true)
    state.playDesign.playType = 'run'
    expect(isManualPlay(state)).toBe(false)
  })

  it('an automatic room never arms the hold loop, even on a pass', () => {
    const state = initGame(ROOM, 0)
    state.playDesign = { playType: 'pass', players: [] }
    expect(isManualPlay(state)).toBe(false)
    expect(beginManualPlay(state)).toBeNull()
    expect(state.manual).toBeNull()
  })
})

describe('beginManualPlay', () => {
  it('opens with GO already down — the snap IS the first press', () => {
    const state = manualPassState()
    const m = beginManualPlay(state)
    expect(m.holding).toBe(true)
    expect(m.heldFor).toBe(0)
    expect(m.autoRun).toBe(false)
    expect(isStopped(state)).toBe(false)
  })

  it('clears a manual freeze stranded by a previous play', () => {
    const state = manualPassState()
    beginStoppage(state, STOPPAGE.MANUAL_HOLD, null)
    beginManualPlay(state)
    expect(isStopped(state)).toBe(false)
  })

  it('does not clear an unrelated stoppage such as a timeout', () => {
    const state = manualPassState()
    beginStoppage(state, STOPPAGE.TIMEOUT, 6)
    beginManualPlay(state)
    expect(stoppageReason(state)).toBe(STOPPAGE.TIMEOUT)
  })
})

describe('the anti-jitter minimum hold', () => {
  it('a release after the minimum has elapsed freezes play immediately', () => {
    const state = manualPassState(); const io = fakeIo()
    beginManualPlay(state)
    tickFor(state, io, 1.0)                      // held past MIN_HOLD_SECONDS
    expect(releaseGo(state, io)).toBe(true)
    expect(isManualFrozen(state)).toBe(true)
    expect(io.sent.some(e => e.event === 'manual_frozen')).toBe(true)
  })

  it('a TAP is honoured as a full minimum hold, not an instant stop', () => {
    const state = manualPassState(); const io = fakeIo()
    beginManualPlay(state)
    tickFor(state, io, 0.1)                      // barely held
    expect(releaseGo(state, io)).toBe(false)     // release recorded, but play continues
    expect(isManualFrozen(state)).toBe(false)

    tickFor(state, io, 0.5)                      // 0.6s total — still short of the minimum
    expect(isManualFrozen(state)).toBe(false)

    tickFor(state, io, 0.2)                      // now past MIN_HOLD_SECONDS
    expect(isManualFrozen(state)).toBe(true)
  })

  it('the committed movement window is exactly MIN_HOLD_SECONDS', () => {
    const state = manualPassState(); const io = fakeIo()
    beginManualPlay(state)
    releaseGo(state, io)                          // released on the very first frame
    let moved = 0
    while (!isManualFrozen(state)) { runManualHold(state, io, DT); moved += DT }
    expect(moved).toBeGreaterThanOrEqual(MANUAL.MIN_HOLD_SECONDS)
    expect(moved).toBeLessThan(MANUAL.MIN_HOLD_SECONDS + DT * 2)
  })

  it('rapid tapping buys no extra stoppages — a release while frozen is a no-op', () => {
    const state = manualPassState(); const io = fakeIo()
    beginManualPlay(state)
    tickFor(state, io, 1.0)
    releaseGo(state, io)
    expect(releaseGo(state, io)).toBe(false)     // already frozen
    expect(isManualFrozen(state)).toBe(true)
  })
})

describe('pressing GO again', () => {
  it('resumes play and starts a fresh minimum-hold window', () => {
    const state = manualPassState(); const io = fakeIo()
    beginManualPlay(state)
    tickFor(state, io, 1.0)
    releaseGo(state, io)

    expect(pressGo(state, io)).toBe(true)
    expect(isStopped(state)).toBe(false)
    expect(state.manual.holding).toBe(true)
    expect(state.manual.heldFor).toBe(0)
    expect(io.sent.some(e => e.event === 'manual_resumed')).toBe(true)
  })

  it('a press while already moving is ignored and does not reset the hold timer', () => {
    const state = manualPassState(); const io = fakeIo()
    beginManualPlay(state)
    tickFor(state, io, 0.4)
    expect(pressGo(state, io)).toBe(false)
    expect(state.manual.heldFor).toBeCloseTo(0.4, 5)
  })

  it('freezing preserves velocities — the openness read stays honest while paused', () => {
    const state = manualPassState(); const io = fakeIo()
    const wr = state.offensePlayers.get('wr1')
    // A comeback receiver breaking BACK toward the ball: the picture looks smothered, but the
    // heading is what tells the openness engine he has separation. It must survive the freeze.
    wr.route = 'comeback'; wr.vx = -3.5; wr.vy = -4.0
    beginManualPlay(state)
    tickFor(state, io, 1.0)
    releaseGo(state, io)

    expect(isManualFrozen(state)).toBe(true)
    expect(wr.vx).toBe(-3.5)
    expect(wr.vy).toBe(-4.0)
    expect(wr.route).toBe('comeback')
  })
})

describe('ending the hold loop', () => {
  it('endManualControl lifts the freeze and hands the play to the sim', () => {
    const state = manualPassState(); const io = fakeIo()
    beginManualPlay(state)
    tickFor(state, io, 1.0)
    releaseGo(state, io)

    endManualControl(state, io)
    expect(state.manual.autoRun).toBe(true)
    expect(isStopped(state)).toBe(false)
  })

  it('once auto-running, GO is inert in both directions', () => {
    const state = manualPassState(); const io = fakeIo()
    beginManualPlay(state)
    endManualControl(state, io)
    expect(pressGo(state, io)).toBe(false)
    expect(releaseGo(state, io)).toBe(false)
    tickFor(state, io, 2.0)
    expect(isStopped(state)).toBe(false)   // never re-freezes for the rest of the play
  })

  it('armThrowResolution marks the throw to resolve before anything moves', () => {
    const state = manualPassState()
    beginManualPlay(state)
    armThrowResolution(state)
    expect(state.manual.resolveThrowFirst).toBe(true)
  })
})

describe('throws are legal only while frozen', () => {
  const socket = { id: 's1', data: { roomId: ROOM, role: 'offense' } }

  it('rejects a throw while the players are moving', () => {
    const state = manualPassState()
    beginManualPlay(state)
    expect(validateThrowToReceiver(socket, 'wr1')).toMatch(/Release GO/)
    expect(validateThrowaway(socket)).toMatch(/Release GO/)
    expect(validateThrowAtDefender(socket, 'cb1')).toMatch(/Release GO/)
  })

  it('allows the throw once play is frozen', () => {
    const state = manualPassState(); const io = fakeIo()
    beginManualPlay(state)
    tickFor(state, io, 1.0)
    releaseGo(state, io)
    expect(validateThrowToReceiver(socket, 'wr1')).toBeNull()
    expect(validateThrowaway(socket)).toBeNull()
  })

  it('an automatic game is unaffected — throws stay legal mid-play', () => {
    const state = initGame(ROOM, 0)
    state.phase = PHASE.LIVE
    state.playDesign = { playType: 'pass', players: [] }
    state.offensePlayers = new Map([['wr1', { id: 'wr1', label: 'WR', x: 40, y: 55 }]])
    state.defensePlayers = new Map()
    expect(validateThrowToReceiver(socket, 'wr1')).toBeNull()
  })

  it('a manual RUN play is unaffected — there is no freeze to wait for', () => {
    const state = manualPassState()
    state.playDesign.playType = 'run'
    // Run plays reject throws for their own reason, never the manual one.
    expect(validateThrowToReceiver(socket, 'wr1')).not.toMatch(/Release GO/)
  })
})

describe('the "It is…" pass reveal', () => {
  it('labels each outcome the way the banner reads it', () => {
    expect(revealLabel('complete')).toBe('Caught!')
    expect(revealLabel('intercepted')).toBe('Intercepted!')
    expect(revealLabel('incomplete', 'drop')).toBe('Dropped!')
    expect(revealLabel('incomplete', 'broken_up')).toBe('Broken up!')
    expect(revealLabel('incomplete', null)).toBe('Incomplete!')
  })

  it('parks the outcome and freezes for a suspense beat inside the configured range', () => {
    const state = manualPassState(); const io = fakeIo()
    beginManualPlay(state)
    const seconds = beginPassSuspense(state, io, {
      event: EVENT.PASS_COMPLETE, payload: { receiverId: 'wr1' }, outcome: 'complete', settles: true,
    })

    expect(seconds).toBeGreaterThanOrEqual(MANUAL.SUSPENSE_MIN_SECONDS)
    expect(seconds).toBeLessThanOrEqual(MANUAL.SUSPENSE_MAX_SECONDS)
    expect(stoppageReason(state)).toBe(STOPPAGE.PASS_SUSPENSE)
    expect(state.manual.pending.outcome).toBe('complete')
    expect(io.sent.some(e => e.event === 'manual_pass_pending')).toBe(true)
  })

  it('a catch is announced, then held before the ball goes live again', () => {
    const state = manualPassState(); const io = fakeIo()
    beginManualPlay(state)
    beginPassSuspense(state, io, {
      event: EVENT.PASS_COMPLETE, payload: { receiverId: 'wr1' }, outcome: 'complete', settles: true,
    })

    // The suspense elapsed: the result is revealed but play does NOT resume yet.
    expect(revealPassOutcome(state, io)).toBeNull()
    expect(io.sent.some(e => e.event === 'manual_pass_reveal' && e.payload.label === 'Caught!')).toBe(true)
    expect(stoppageReason(state)).toBe(STOPPAGE.RESULT_HOLD)

    // The hold elapsed: now the parked event is handed back for the sim to resume from.
    const next = takePendingOutcome(state)
    expect(next.event).toBe(EVENT.PASS_COMPLETE)
    expect(next.payload.receiverId).toBe('wr1')
    expect(state.manual.pending).toBeNull()
  })

  it('an incompletion resolves straight off the reveal — the play is already over', () => {
    const state = manualPassState(); const io = fakeIo()
    beginManualPlay(state)
    beginPassSuspense(state, io, {
      event: EVENT.PASS_INCOMPLETE, payload: { reason: 'drop' }, outcome: 'incomplete', reason: 'drop',
    })

    const now = revealPassOutcome(state, io)
    expect(now.event).toBe(EVENT.PASS_INCOMPLETE)
    expect(io.sent.some(e => e.event === 'manual_pass_reveal' && e.payload.label === 'Dropped!')).toBe(true)
    expect(state.manual.pending).toBeNull()
  })

  it('an interception takes the same held beat as a catch — the return is still live', () => {
    const state = manualPassState(); const io = fakeIo()
    beginManualPlay(state)
    beginPassSuspense(state, io, {
      event: EVENT.INTERCEPTION, payload: { catcherId: 'cb1' }, outcome: 'intercepted', settles: true,
    })
    expect(revealPassOutcome(state, io)).toBeNull()
    expect(stoppageReason(state)).toBe(STOPPAGE.RESULT_HOLD)
    expect(takePendingOutcome(state).event).toBe(EVENT.INTERCEPTION)
  })

  it('revealing with nothing parked is a no-op rather than a crash', () => {
    const state = manualPassState(); const io = fakeIo()
    beginManualPlay(state)
    expect(revealPassOutcome(state, io)).toBeNull()
    expect(takePendingOutcome(state)).toBeNull()
  })
})
