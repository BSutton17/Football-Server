import { describe, it, expect, beforeEach, afterEach, jest } from '@jest/globals'
import { tick } from '../game/simulation.js'
import { initGame, deleteGame, getGame } from '../game/gameState.js'
import { createRoom, joinRoom, leaveRoom } from '../game/roomManager.js'
import { PHASE } from '../game/stateMachine.js'
import { beginStoppage, isStopped, STOPPAGE, beginPlayerPause } from '../game/pause.js'

// ── [watchdog] Nothing is allowed to wait for ever ──────────────────────────
//
// ⚠️ REPORTED TWICE, AND THE FIRST FIX WAS THE WRONG STATE. "I'll click set defense or offense and the
// game will just freeze and I'm stuck ... pausing and unpausesing and refreshing does not work its a
// softlock." The half-time hold was one such state; it was not the one being hit.
//
// The shape is general, which is why the answer is general. COUNTDOWN is driven by timers scheduled UP
// FRONT and cancelled together by bumping `countdownToken` — and `set_defense` during a countdown does
// exactly that, then emits a single `hike_countdown { count: 0 }` in their place. That one emit becomes
// the only thing in existence that can start the play: no timer left, no clock running, no retry. If
// the offense does not act on it, the game sits there for ever. DEAD is the same shape — the next play
// is a `setTimeout`, and a path that reaches DEAD without booking one has nothing to advance it.
//
// Both are invisible: every button is phase-gated and refuses silently, so the player sees a pressed
// button and a still field.
//
// ⚠️ THIS DOES NOT FIX A CAUSE AND IS NOT MEANT TO. It makes the class survivable and LOUD, so the next
// occurrence names its own phase in the log instead of being a mystery.

const ROOM = 'wd-room'

function mockIo() {
  const emits = []
  return { emits, to: () => ({ emit: (event, payload) => emits.push({ event, payload }) }) }
}

let warn
beforeEach(() => {
  warn = jest.spyOn(console, 'warn').mockImplementation(() => {})
  leaveRoom('wdA'); leaveRoom('wdB')
  deleteGame(ROOM)
  createRoom(ROOM, 'wdA'); joinRoom(ROOM, 'wdB')
})
afterEach(() => { warn.mockRestore(); deleteGame(ROOM) })

const stuckFor = (ms) => { getGame(ROOM).phaseSince = Date.now() - ms }

describe('a countdown that nothing will ever finish', () => {
  function countdownGame() {
    const s = initGame(ROOM, 0, {})
    s.phase = PHASE.COUNTDOWN
    s.clockStopped = true
    s.phaseSince = Date.now()
    return s
  }

  it('leaves a healthy countdown alone', () => {
    countdownGame()
    const io = mockIo()
    tick(ROOM, io)
    expect(io.emits.filter(e => e.event === 'hike_countdown')).toHaveLength(0)
  })

  it('re-issues the hike once it has clearly been stranded', () => {
    countdownGame()
    stuckFor(30_000)
    const io = mockIo()
    tick(ROOM, io)
    const hikes = io.emits.filter(e => e.event === 'hike_countdown')
    expect(hikes).toHaveLength(1)
    expect(hikes[0].payload).toEqual({ count: 0 })
  })

  // ⚠️ ONE NUDGE PER WINDOW, NOT ONE PER TICK. The loop runs at 20 Hz; a watchdog that fired every tick
  // would bury the log it exists to write and spray the clients with hikes.
  it('does not fire again on the very next tick', () => {
    countdownGame()
    stuckFor(30_000)
    const io = mockIo()
    tick(ROOM, io)
    tick(ROOM, io)
    tick(ROOM, io)
    expect(io.emits.filter(e => e.event === 'hike_countdown')).toHaveLength(1)
  })

  it('says so in the log, with the phase and how long', () => {
    countdownGame()
    stuckFor(30_000)
    tick(ROOM, mockIo())
    const said = warn.mock.calls.map(c => c.join(' ')).join('\n')
    expect(said).toMatch(/watchdog/i)
    expect(said).toMatch(/COUNTDOWN/)
  })
})

// ⚠️ THE FAMILY THAT ACTUALLY HAPPENS, AND THE ONE THE FIRST WATCHDOG COULD NOT SEE.
//
// An OPEN-ENDED stoppage freezes the tick — and the watchdog used to sit BELOW that early return, so a
// dead game was precisely the state in which it never ran. Reported as "the saftey net isn't working".
//
// The real chain: the AI snaps a RUN in manual mode, its hold loop releases GO (it never checked the
// play type), the server freezes the board on an open-ended MANUAL_HOLD, and `onManualFrozen` returns
// early because it is a run — so nobody ever presses GO again. No clock, no timer, no path back, and
// every button phase-gated into a silent refusal.
describe('a board frozen with nobody left to press GO', () => {
  function frozenGame() {
    const s = initGame(ROOM, 0, { mode: 'manual' })
    s.phase = PHASE.LIVE
    s.phaseSince = Date.now()
    s.manual = { holding: false, heldFor: 0, released: true, autoRun: false, pending: null }
    beginStoppage(s, STOPPAGE.MANUAL_HOLD, null)
    return s
  }

  it('leaves a fresh freeze alone — reading the field is the point of it', () => {
    frozenGame()
    tick(ROOM, mockIo())
    expect(isStopped(getGame(ROOM))).toBe(true)
    expect(warn.mock.calls).toHaveLength(0)
  })

  it('resumes it once it has clearly been abandoned', () => {
    const s = frozenGame()
    s.stoppageSince = Date.now() - 30_000
    tick(ROOM, mockIo())
    expect(isStopped(getGame(ROOM))).toBe(false)
    expect(warn.mock.calls.map(c => c.join(' ')).join(' ')).toMatch(/frozen/i)
  })

  // ⚠️ AND IT CLEARS THE FREEZE EVEN WHEN A PRESS CANNOT LIFT IT. `pressGo` refuses when the play has
  // gone to autoRun, which would leave the game just as dead as before.
  it('clears a freeze that a press cannot lift', () => {
    const s = frozenGame()
    s.manual.autoRun = true
    s.stoppageSince = Date.now() - 30_000
    tick(ROOM, mockIo())
    expect(isStopped(getGame(ROOM))).toBe(false)
  })

  // ⚠️ A PLAYER PAUSE IS DELIBERATE AND IS LEFT ALONE. Un-pausing somebody who walked away from the
  // game would be its own bug.
  it('never lifts a pause the player asked for', () => {
    const s = initGame(ROOM, 0, {})
    s.phase = PHASE.PRE_SNAP
    s.phaseSince = Date.now()
    beginPlayerPause(s, 0)
    s.stoppageSince = Date.now() - 120_000
    tick(ROOM, mockIo())
    expect(isStopped(getGame(ROOM))).toBe(true)
  })
})

describe('a dead ball with no next play booked', () => {
  function deadGame() {
    const s = initGame(ROOM, 0, {})
    s.phase = PHASE.DEAD
    s.nextPlayTimer = null
    s.phaseSince = Date.now()
    return s
  }

  it('leaves an ordinary dead-ball gap alone', () => {
    deadGame()
    tick(ROOM, mockIo())
    expect(warn.mock.calls).toHaveLength(0)
  })

  // ⚠️ AND IT MUST NOT PRE-EMPT A HOLD THAT IS DELIBERATELY LONG. Half-time books its own 90-second
  // fallback; a booked timer means somebody is already responsible for restarting the game.
  it('leaves a long but BOOKED hold alone', () => {
    const s = deadGame()
    s.nextPlayTimer = setTimeout(() => {}, 60_000)
    stuckFor(30_000)
    try {
      tick(ROOM, mockIo())
      expect(warn.mock.calls).toHaveLength(0)
    } finally { clearTimeout(s.nextPlayTimer) }
  })

  it('starts one when nothing at all is booked', () => {
    deadGame()
    stuckFor(20_000)
    tick(ROOM, mockIo())
    expect(warn.mock.calls.map(c => c.join(' ')).join('\n')).toMatch(/DEAD/)
  })
})
