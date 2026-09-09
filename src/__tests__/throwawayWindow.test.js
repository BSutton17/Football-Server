import { describe, it, expect, beforeEach, afterEach } from '@jest/globals'
import { tick } from '../game/simulation.js'
import { initGame, deleteGame } from '../game/gameState.js'
import { runThrowawayWindow, resetThrowawayWindow, THROWAWAY_AFTER_SECONDS } from '../game/systems/throwawayWindow.js'
import { beginPlayerPause } from '../game/pause.js'
import { beginManualPlay, releaseGo, runManualHold } from '../game/manual.js'
import { PHASE } from '../game/stateMachine.js'
import { GAME_MODE, SIM } from '../constants.js'

// ── [187] Throwing the ball away is offered on GAME time, not wall time ──────
//
// The QB has to hold the ball a beat before he may bail out. In manual mode the play only advances
// while the offense holds GO — release it and everything freezes while they read the field. A
// real-world timer would tick straight through that and hand them the throwaway for a play that
// never went anywhere, so the count has to be simulated time.

const ROOM = 'throwaway-room'
const DT = SIM.TICK_MS / 1000

function fakeIo() {
  const sent = []
  return { sent, to: () => ({ emit: (event) => sent.push(event) }) }
}

function livePass(mode = GAME_MODE.AUTOMATIC) {
  const state = initGame(ROOM, 0, { mode })
  state.phase = PHASE.LIVE
  state.playDesign = { playType: 'pass', players: [] }
  state.offensePlayers = new Map([['qb', { id: 'qb', label: 'QB', x: 26, y: 30, vx: 0, vy: 0 }]])
  state.defensePlayers = new Map()
  resetThrowawayWindow(state)
  return state
}

const offered = (io) => io.sent.filter(e => e === 'throwaway_ready').length

beforeEach(() => deleteGame(ROOM))
afterEach(() => deleteGame(ROOM))

describe('the window opens on simulated time', () => {
  it('is not offered before the threshold', () => {
    const state = livePass(); const io = fakeIo()
    for (let i = 0; i < Math.floor(1.5 / DT); i++) runThrowawayWindow(state, io, DT)
    expect(offered(io)).toBe(0)
  })

  it('is offered once the threshold is crossed', () => {
    const state = livePass(); const io = fakeIo()
    for (let i = 0; i < Math.ceil(THROWAWAY_AFTER_SECONDS[GAME_MODE.AUTOMATIC] / DT) + 2; i++) {
      runThrowawayWindow(state, io, DT)
    }
    expect(offered(io)).toBe(1)
  })

  it('is offered exactly once, not every tick after', () => {
    const state = livePass(); const io = fakeIo()
    for (let i = 0; i < 400; i++) runThrowawayWindow(state, io, DT)
    expect(offered(io)).toBe(1)
  })

  it('manual mode waits longer than automatic', () => {
    expect(THROWAWAY_AFTER_SECONDS[GAME_MODE.MANUAL])
      .toBeGreaterThan(THROWAWAY_AFTER_SECONDS[GAME_MODE.AUTOMATIC])
  })

  it('a run play never offers it', () => {
    const state = livePass(); const io = fakeIo()
    state.playDesign.playType = 'run'
    for (let i = 0; i < 400; i++) runThrowawayWindow(state, io, DT)
    expect(offered(io)).toBe(0)
  })

  it('a new play re-arms the window', () => {
    const state = livePass(); const io = fakeIo()
    for (let i = 0; i < 400; i++) runThrowawayWindow(state, io, DT)
    resetThrowawayWindow(state)
    expect(state.throwawayOffered).toBe(false)
    expect(state.livePlayElapsed).toBe(0)
  })
})

describe('a frozen play does not count toward it — the regression this guards', () => {
  it('holds still through a manual GO freeze, however long it lasts', () => {
    const state = livePass(GAME_MODE.MANUAL)
    const io = fakeIo()

    // Hold GO briefly, then let go: the play freezes with the ball in the QB's hands.
    beginManualPlay(state)
    for (let i = 0; i < 20; i++) { runManualHold(state, io, DT); tick(ROOM, io) }
    releaseGo(state, io)
    const elapsedAtFreeze = state.livePlayElapsed

    // Now stand in that freeze for twenty seconds of WALL time.
    for (let i = 0; i < 400; i++) tick(ROOM, io)

    expect(state.livePlayElapsed).toBe(elapsedAtFreeze)
    expect(offered(io)).toBe(0)
  })

  it('does not count time spent paused either', () => {
    const state = livePass()
    const io = fakeIo()
    beginPlayerPause(state, 0)

    for (let i = 0; i < 400; i++) tick(ROOM, io)
    expect(state.livePlayElapsed ?? 0).toBe(0)
    expect(offered(io)).toBe(0)
  })

  it('resumes counting from where it left off, and eventually offers', () => {
    const state = livePass(GAME_MODE.MANUAL)
    const io = fakeIo()
    beginManualPlay(state)

    // Enough live ticks to clear the manual threshold, driven through the real tick.
    const needed = Math.ceil(THROWAWAY_AFTER_SECONDS[GAME_MODE.MANUAL] / DT) + 4
    for (let i = 0; i < needed; i++) tick(ROOM, io)

    expect(offered(io)).toBe(1)
  })
})
