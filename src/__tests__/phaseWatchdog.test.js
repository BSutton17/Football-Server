import { describe, it, expect, beforeEach, afterEach, jest } from '@jest/globals'
import { tick } from '../game/simulation.js'
import { initGame, deleteGame, getGame } from '../game/gameState.js'
import { createRoom, joinRoom, leaveRoom } from '../game/roomManager.js'
import { PHASE } from '../game/stateMachine.js'

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
