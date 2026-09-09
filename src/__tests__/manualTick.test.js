import { describe, it, expect, beforeEach, afterEach } from '@jest/globals'
import { tick } from '../game/simulation.js'
import { initGame, getGame, deleteGame } from '../game/gameState.js'
import { beginManualPlay, beginPassSuspense, releaseGo, pressGo, runManualHold } from '../game/manual.js'
import { isStopped, stoppageReason, STOPPAGE } from '../game/pause.js'
import { EVENT } from '../game/eventQueue.js'
import { PHASE } from '../game/stateMachine.js'
import { GAME_MODE, DIFFICULTY, MANUAL, SIM } from '../constants.js'

// ── [manual] The freeze chain, driven through the real simulation tick ────────
//
// These exercise simulation.js itself rather than the manual module in isolation: that a freeze
// actually stops the clock (because the tick returns before any system runs), and that the
// suspense → reveal → hold → resolve chain hands the parked outcome back at the right moment.

const ROOM = 'manual-tick'
const DT = SIM.TICK_MS / 1000

function fakeIo() {
  const sent = []
  return { sent, to: () => ({ emit: (event, payload) => sent.push({ event, payload }) }) }
}

function manualGame() {
  const state = initGame(ROOM, 0, { mode: GAME_MODE.MANUAL, difficulty: DIFFICULTY.EASY })
  state.phase = PHASE.LIVE
  state.playDesign = { playType: 'pass', players: [] }
  state.offensePlayers = new Map([['qb', { id: 'qb', label: 'QB', x: 26, y: 30, vx: 0, vy: 0 }]])
  state.defensePlayers = new Map()
  return state
}

beforeEach(() => { deleteGame(ROOM) })
afterEach(() => { deleteGame(ROOM) })

describe('a manual freeze stops everything', () => {
  it('the game clock does not move while the play is frozen', () => {
    const state = manualGame(); const io = fakeIo()
    beginManualPlay(state)
    // Hold past the minimum, then release — the play freezes.
    for (let i = 0; i < 30; i++) runManualHold(state, io, DT)
    releaseGo(state, io)
    expect(stoppageReason(state)).toBe(STOPPAGE.MANUAL_HOLD)

    const before = state.clock
    for (let i = 0; i < 40; i++) tick(ROOM, io)      // two seconds of wall time
    expect(state.clock).toBe(before)                  // …and not one tick of game time
  })

  it('an open-ended manual freeze never times itself out', () => {
    const state = manualGame(); const io = fakeIo()
    beginManualPlay(state)
    for (let i = 0; i < 30; i++) runManualHold(state, io, DT)
    releaseGo(state, io)

    for (let i = 0; i < 400; i++) tick(ROOM, io)     // 20 seconds
    expect(stoppageReason(state)).toBe(STOPPAGE.MANUAL_HOLD)
  })

  it('pressing GO lifts the freeze so the tick runs again', () => {
    const state = manualGame(); const io = fakeIo()
    beginManualPlay(state)
    for (let i = 0; i < 30; i++) runManualHold(state, io, DT)
    releaseGo(state, io)

    pressGo(state, io)
    expect(isStopped(state)).toBe(false)
    expect(state.manual.holding).toBe(true)
  })
})

describe('the suspense → reveal → resolve chain', () => {
  it('holds the outcome for the suspense, announces it, then hands it back after the result hold', () => {
    const state = manualGame(); const io = fakeIo()
    beginManualPlay(state)
    beginPassSuspense(state, io, {
      event: EVENT.PASS_COMPLETE, payload: { receiverId: 'wr1', x: 30, y: 55 },
      outcome: 'complete', settles: true,
    })

    // Tick only until the reveal lands, so this never runs on into the result hold that follows it.
    const suspenseTicks = Math.ceil(MANUAL.SUSPENSE_MAX_SECONDS / DT) + 2
    let revealedAt = -1
    for (let i = 0; i < suspenseTicks; i++) {
      tick(ROOM, io)
      if (io.sent.some(e => e.event === 'manual_pass_reveal')) { revealedAt = i; break }
    }

    expect(revealedAt).toBeGreaterThanOrEqual(Math.floor(MANUAL.SUSPENSE_MIN_SECONDS / DT) - 1)
    const reveal = io.sent.find(e => e.event === 'manual_pass_reveal')
    expect(reveal.payload.label).toBe('Caught!')

    // A catch leaves the ball live, so the chain moves straight into the result hold.
    expect(stoppageReason(state)).toBe(STOPPAGE.RESULT_HOLD)

    // Ride out the hold — the parked event is then queued for the sim to resume from.
    for (let i = 0; i < Math.ceil(MANUAL.RESULT_HOLD_SECONDS / DT) + 2; i++) {
      if (!isStopped(state)) break
      tick(ROOM, io)
    }
    expect(isStopped(state)).toBe(false)
    expect(state.manual.pending).toBeNull()
  })

  it('an incompletion skips the result hold — the play is already dead', () => {
    const state = manualGame(); const io = fakeIo()
    beginManualPlay(state)
    beginPassSuspense(state, io, {
      event: EVENT.PASS_INCOMPLETE, payload: { reason: 'broken_up' },
      outcome: 'incomplete', reason: 'broken_up',
    })

    for (let i = 0; i < Math.ceil(MANUAL.SUSPENSE_MAX_SECONDS / DT) + 2; i++) {
      tick(ROOM, io)
      if (io.sent.some(e => e.event === 'manual_pass_reveal')) break
    }

    const reveal = io.sent.find(e => e.event === 'manual_pass_reveal')
    expect(reveal.payload.label).toBe('Broken up!')
    expect(stoppageReason(state)).not.toBe(STOPPAGE.RESULT_HOLD)
    expect(state.manual.pending).toBeNull()
  })

  it('the suspense beat lands inside the configured window, not instantly', () => {
    const state = manualGame(); const io = fakeIo()
    beginManualPlay(state)
    beginPassSuspense(state, io, {
      event: EVENT.PASS_INCOMPLETE, payload: {}, outcome: 'incomplete',
    })

    // Well short of the minimum: still silent.
    for (let i = 0; i < Math.floor((MANUAL.SUSPENSE_MIN_SECONDS - 0.5) / DT); i++) tick(ROOM, io)
    expect(io.sent.some(e => e.event === 'manual_pass_reveal')).toBe(false)
    expect(stoppageReason(state)).toBe(STOPPAGE.PASS_SUSPENSE)
  })

  it('the game clock is frozen through the whole reveal, so suspense costs no time', () => {
    const state = manualGame(); const io = fakeIo()
    beginManualPlay(state)
    const before = state.clock
    beginPassSuspense(state, io, {
      event: EVENT.PASS_COMPLETE, payload: { receiverId: 'wr1' }, outcome: 'complete', settles: true,
    })
    for (let i = 0; i < Math.ceil((MANUAL.SUSPENSE_MAX_SECONDS + MANUAL.RESULT_HOLD_SECONDS) / DT); i++) {
      if (!isStopped(state)) break
      tick(ROOM, io)
    }
    expect(state.clock).toBe(before)
  })
})

describe('an automatic game is untouched by any of this', () => {
  it('never freezes and never parks an outcome', () => {
    deleteGame(ROOM)
    const state = initGame(ROOM, 0)
    state.phase = PHASE.LIVE
    state.playDesign = { playType: 'pass', players: [] }
    expect(beginManualPlay(state)).toBeNull()
    expect(state.manual).toBeNull()
    expect(isStopped(state)).toBe(false)
  })
})
