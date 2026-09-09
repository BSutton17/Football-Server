import { describe, it, expect, beforeEach, afterEach, jest } from '@jest/globals'
import { initGame, deleteGame } from '../game/gameState.js'
import {
  beginPlayerPause, resumePlayerPause, isPlayerPaused,
  beginStoppage, isStopped, stoppageReason, STOPPAGE,
} from '../game/pause.js'
import { tick } from '../game/simulation.js'
import { serializeGameState } from '../game/serialization.js'
import { beginTeamSelect, setQuarterLength, getTeamSelect, clearTeamSelect } from '../game/teamSelect.js'
import { enqueue, processQueue, EVENT } from '../game/eventQueue.js'
import { PHASE } from '../game/stateMachine.js'
import { RULES, QUARTER_MINUTES_MIN, QUARTER_MINUTES_MAX, clampQuarterMinutes } from '../constants.js'

const ROOM = 'pause-room'
const noIo = { to: () => ({ emit: () => {} }) }

beforeEach(() => deleteGame(ROOM))
afterEach(() => { deleteGame(ROOM); clearTeamSelect(ROOM) })

// ── [quarter length] The host's pregame choice ───────────────────────────────

describe('quarter length', () => {
  it('defaults to the standard quarter when nobody chose', () => {
    expect(initGame(ROOM, 0).quarterSeconds).toBe(RULES.QUARTER_SECONDS)
  })

  it('starts the clock on the chosen length', () => {
    const state = initGame(ROOM, 0, { quarterSeconds: 3 * 60 })
    expect(state.quarterSeconds).toBe(180)
    expect(state.clock).toBe(180)
  })

  it('every later quarter resets to the same chosen length, not the constant', () => {
    // Driven through the real clock-expiry path rather than the private helper, so this covers the
    // route the game actually takes into a new quarter.
    const state = initGame(ROOM, 0, { quarterSeconds: 6 * 60 })
    state.phase = PHASE.PRE_SNAP
    state.clock = 0
    enqueue(ROOM, EVENT.CLOCK_EXPIRED, {})
    processQueue(ROOM, state, noIo)

    expect(state.quarter).toBe(2)
    expect(state.clock).toBe(360)
    expect(state.clock).not.toBe(RULES.QUARTER_SECONDS)
  })

  it('clamps a value outside the allowed band rather than trusting it', () => {
    expect(clampQuarterMinutes(1)).toBe(QUARTER_MINUTES_MIN)
    expect(clampQuarterMinutes(99)).toBe(QUARTER_MINUTES_MAX)
    expect(clampQuarterMinutes(4)).toBe(4)
    expect(clampQuarterMinutes(4.4)).toBe(4)
  })

  it('falls back to the default for nonsense', () => {
    expect(clampQuarterMinutes('abc')).toBe(5)
    expect(clampQuarterMinutes(undefined)).toBe(5)
  })

  it('team selection records the host choice, clamped', () => {
    beginTeamSelect(ROOM)
    expect(getTeamSelect(ROOM).quarterMinutes).toBe(5)   // sensible default before anyone picks
    expect(setQuarterLength(ROOM, 3)).toBe(3)
    expect(getTeamSelect(ROOM).quarterMinutes).toBe(3)
    expect(setQuarterLength(ROOM, 60)).toBe(QUARTER_MINUTES_MAX)
  })
})

// ── [pause] Freezing the game ────────────────────────────────────────────────

describe('pausing', () => {
  function livePlay() {
    const state = initGame(ROOM, 0)
    state.phase = PHASE.LIVE
    state.playDesign = { playType: 'pass', players: [] }
    state.offensePlayers = new Map()
    state.defensePlayers = new Map()
    return state
  }

  it('freezes the game clock — a live play stops where it is', () => {
    const state = livePlay()
    beginPlayerPause(state, 0)

    const before = state.clock
    for (let i = 0; i < 60; i++) tick(ROOM, noIo)   // three seconds of wall time
    expect(state.clock).toBe(before)
    expect(state.tick ?? 0).toBe(0)                 // …and not one tick of simulation
  })

  it('never expires on its own — it is open-ended', () => {
    const state = livePlay()
    beginPlayerPause(state, 0)
    for (let i = 0; i < 2000; i++) tick(ROOM, noIo)  // 100 seconds
    expect(isPlayerPaused(state)).toBe(true)
  })

  it('resuming lets the game run again', () => {
    const state = livePlay()
    beginPlayerPause(state, 1)
    resumePlayerPause(state)
    expect(isPlayerPaused(state)).toBe(false)
    expect(isStopped(state)).toBe(false)
  })

  it('records who called it', () => {
    const state = livePlay()
    beginPlayerPause(state, 1)
    expect(state.pausedBy).toBe(1)
  })

  it('pausing twice is a no-op rather than losing the first one', () => {
    const state = livePlay()
    expect(beginPlayerPause(state, 0)).toBe(true)
    expect(beginPlayerPause(state, 1)).toBe(false)
    expect(state.pausedBy).toBe(0)
  })

  it('resuming when not paused does nothing', () => {
    expect(resumePlayerPause(livePlay())).toBe(false)
  })
})

describe('a pause landing on top of another stoppage', () => {
  it('restores a timeout it interrupted, with its remaining time', () => {
    const state = initGame(ROOM, 0)
    beginStoppage(state, STOPPAGE.TIMEOUT, 6)

    beginPlayerPause(state, 0)
    expect(stoppageReason(state)).toBe(STOPPAGE.PLAYER_PAUSE)

    resumePlayerPause(state)
    expect(stoppageReason(state)).toBe(STOPPAGE.TIMEOUT)
    expect(state.stoppage.remaining).toBe(6)
  })

  it('restores a manual-mode freeze, so the play does not resume unheld', () => {
    // The dangerous case: a manual play frozen with GO up. Cancelling that freeze instead of
    // restoring it would set everyone running again with nobody holding the button.
    const state = initGame(ROOM, 0)
    beginStoppage(state, STOPPAGE.MANUAL_HOLD, null)

    beginPlayerPause(state, 1)
    resumePlayerPause(state)

    expect(stoppageReason(state)).toBe(STOPPAGE.MANUAL_HOLD)
    expect(isStopped(state)).toBe(true)
  })

  it('leaves the game running when it interrupted nothing', () => {
    const state = initGame(ROOM, 0)
    beginPlayerPause(state, 0)
    resumePlayerPause(state)
    expect(isStopped(state)).toBe(false)
  })
})

describe('the paused flag reaches the clients', () => {
  it('is reported viewer-relatively so each side knows who paused', () => {
    const state = initGame(ROOM, 0)
    beginPlayerPause(state, 1)

    expect(serializeGameState(state, 1).pausedByYou).toBe(true)
    expect(serializeGameState(state, 0).pausedByYou).toBe(false)
    expect(serializeGameState(state, 0).paused).toBe(true)
  })

  it('is false once resumed', () => {
    const state = initGame(ROOM, 0)
    beginPlayerPause(state, 0)
    resumePlayerPause(state)
    expect(serializeGameState(state, 0).paused).toBe(false)
  })
})
