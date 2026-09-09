import { describe, it, expect, beforeEach } from '@jest/globals'
import { initGame, getGame, deleteGame } from '../game/gameState.js'
import { validateSetOffense } from '../game/validation.js'
import { applyDelayOfGame } from '../game/eventQueue.js'
import { serializeGameState } from '../game/serialization.js'
import { createRoom, joinRoom } from '../game/roomManager.js'
import { PHASE } from '../game/stateMachine.js'

// ── [stale set] Locking the formation as the play clock expires ──────────────
//
// The two can cross in flight. The clock runs out, a delay-of-game penalty moves the line of
// scrimmage back five yards, and the set_offense that was already on its way lands afterwards — into
// a PRE_SNAP that looks entirely valid. Accepting it commits a formation drawn for a line that has
// since moved, leaving the server in COUNTDOWN with players the client has already redrawn
// elsewhere: the offense sees its routes vanish and its players snap backwards.
//
// The client echoes the serial of the situation it was actually looking at, so a superseded
// formation is refused and the offense simply sets again on the new spot.

const ROOM = '7311'

function offenseSocket() {
  return { id: 'sock-off', data: { roomId: ROOM, role: 'offense' } }
}

function preSnapGame() {
  deleteGame(ROOM)
  createRoom(ROOM, 'sock-off')
  joinRoom(ROOM, 'sock-def')
  const state = initGame(ROOM, 0)
  state.phase = PHASE.PRE_SNAP
  state.yardLine = 40
  state.offensePlayers = new Map()
  state.defensePlayers = new Map()
  return state
}

const formation = (playSerial) => ({ playType: 'pass', runAngle: 0, players: [], playSerial })

const noIo = { to: () => ({ emit: () => {} }) }

beforeEach(() => deleteGame(ROOM))

describe('the serial identifies the pre-snap situation', () => {
  it('is sent to the client with the game state', () => {
    const state = preSnapGame()
    expect(serializeGameState(state, 0).playSerial).toBe(state.playSerial)
  })

  it('changes when a delay of game moves the line back', () => {
    const state = preSnapGame()
    const before = state.playSerial
    applyDelayOfGame(state, noIo)
    expect(state.playSerial).not.toBe(before)
  })
})

describe('a formation racing the play clock', () => {
  it('is accepted when it matches the situation it was drawn for', () => {
    const state = preSnapGame()
    expect(validateSetOffense(offenseSocket(), formation(state.playSerial))).toBeNull()
  })

  it('is REFUSED when a delay of game landed first — the regression this guards', () => {
    const state = preSnapGame()
    const drawnFor = state.playSerial          // what the offense was looking at when it hit Set

    applyDelayOfGame(state, noIo)              // …the clock expired before the message arrived

    // The phase is still PRE_SNAP and everything else about the payload is valid, which is exactly
    // why this used to slip through and commit a formation five yards off the new line.
    expect(state.phase).toBe(PHASE.PRE_SNAP)
    expect(validateSetOffense(offenseSocket(), formation(drawnFor))).toMatch(/set again/)
  })

  it('the offense can simply set again on the new spot', () => {
    const state = preSnapGame()
    applyDelayOfGame(state, noIo)
    expect(validateSetOffense(offenseSocket(), formation(state.playSerial))).toBeNull()
  })

  it('back-to-back penalties each supersede the last', () => {
    const state = preSnapGame()
    applyDelayOfGame(state, noIo)
    const afterFirst = state.playSerial
    applyDelayOfGame(state, noIo)
    expect(validateSetOffense(offenseSocket(), formation(afterFirst))).toMatch(/set again/)
    expect(validateSetOffense(offenseSocket(), formation(state.playSerial))).toBeNull()
  })

  it('a client that sends no serial is still accepted', () => {
    // Older clients, and the tests that predate this, must keep working.
    const state = preSnapGame()
    expect(validateSetOffense(offenseSocket(), { playType: 'pass', runAngle: 0, players: [] })).toBeNull()
    expect(state.playSerial).toBeDefined()
  })

  it('the serial check does not mask a genuinely invalid formation', () => {
    const state = preSnapGame()
    expect(validateSetOffense(offenseSocket(), { ...formation(state.playSerial), playType: 'punt' }))
      .toMatch(/playType/)
  })
})
