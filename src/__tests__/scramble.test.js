import { describe, it, expect, beforeEach } from '@jest/globals'
import { initGame, getGame, deleteGame } from '../game/gameState.js'
import { validateScramble, validateThrowToReceiver, validateThrowaway } from '../game/validation.js'
import { PHASE } from '../game/stateMachine.js'

// Scramble trigger ([184]) and the irreversible throw lock it imposes ([185]).
// validateScramble / validateThrowToReceiver read the live game via getGame(roomId),
// so each test registers a game and points a fake socket at it.

const ROOM = 'scramble-room'

function offenseSocket() {
  return { id: 's1', data: { roomId: ROOM, role: 'offense' } }
}

function liveState() {
  const state = initGame(ROOM, 0)
  state.phase = PHASE.LIVE
  state.playDesign = { playType: 'pass', players: [] }
  state.offensePlayers = new Map([
    ['qb', { id: 'qb', label: 'QB', x: 26, y: 30 }],
    ['wr1', { id: 'wr1', label: 'WR', x: 40, y: 55 }],
  ])
  return state
}

beforeEach(() => deleteGame(ROOM))

describe('validateScramble ([184])', () => {
  it('allows a scramble on a live pass play with a QB on the field', () => {
    liveState()
    expect(validateScramble(offenseSocket())).toBeNull()
  })

  it('rejects a scramble on a run play', () => {
    const state = liveState()
    state.playDesign.playType = 'run'
    expect(validateScramble(offenseSocket())).toMatch(/pass play/)
  })

  it('rejects a second scramble once already scrambling', () => {
    const state = liveState()
    state.qbScrambling = true
    expect(validateScramble(offenseSocket())).toMatch(/Already scrambling/)
  })

  it('rejects a scramble after the ball has been thrown', () => {
    const state = liveState()
    state.targetReceiverId = 'wr1'
    expect(validateScramble(offenseSocket())).toMatch(/thrown/)
  })

  it('rejects the defense', () => {
    liveState()
    const sock = offenseSocket()
    sock.data.role = 'defense'
    expect(validateScramble(sock)).toMatch(/offense/)
  })
})

describe('throw lock after scramble ([185])', () => {
  it('a throw is valid before the scramble', () => {
    liveState()
    expect(validateThrowToReceiver(offenseSocket(), 'wr1')).toBeNull()
  })

  it('the same throw is rejected once the QB has committed to a scramble', () => {
    const state = liveState()
    state.qbScrambling = true
    expect(validateThrowToReceiver(offenseSocket(), 'wr1')).toMatch(/scramble/)
  })
})

describe('validateThrowaway ([187][188])', () => {
  it('allows a throwaway on a live pass play before the ball is gone', () => {
    liveState()
    expect(validateThrowaway(offenseSocket())).toBeNull()
  })

  it('rejects once a throw has been committed', () => {
    const state = liveState()
    state.targetReceiverId = 'wr1'
    expect(validateThrowaway(offenseSocket())).toMatch(/already been thrown/)
  })

  it('rejects while the QB is scrambling', () => {
    const state = liveState()
    state.qbScrambling = true
    expect(validateThrowaway(offenseSocket())).toMatch(/scrambling/)
  })

  it('rejects on a run play', () => {
    const state = liveState()
    state.playDesign.playType = 'run'
    expect(validateThrowaway(offenseSocket())).toMatch(/pass play/)
  })
})
