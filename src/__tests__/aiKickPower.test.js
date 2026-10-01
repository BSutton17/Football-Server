import { describe, it, expect, beforeEach } from '@jest/globals'
import { beginSpecialTeams, applyKickInput, KICK, ST_PHASE } from '../game/specialTeams.js'
import { createRoom, leaveRoom } from '../game/roomManager.js'
import { specialTeamsAction } from '../ai/specialTeams.js'

// ⚠️ THE COMPUTER PUNTED 22 YARDS BECAUSE IT HAS NO THUMB.
//
// A tap is +2% of the meter and the drain is 25.7% a second, so holding the bar takes about thirteen
// taps a second. The AI only acts when it hears `special_teams_update`, which is sent when the
// displayed power changes — so its kick was decided by broadcast cadence, not by football. Measured
// in a real game: the human reached 75% of the meter and punted 40 yards, the computer reached NINE
// PERCENT and punted 21.8, four times out of four, which is the floor of the distance curve.
//
// Tapping harder was tried first and could not be verified: in the headless harness the AI reaches
// 100% with ONE tap per update, which is not what production does with the same code. So it states
// the power instead — the same kind of abstraction as the make/miss intent it already decides up
// front for a field goal.
const ROOM = 'aikick'

function stateWith(kickingSlot) {
  return {
    roomId: ROOM, phase: 'pre_snap', direction: 1, yardLine: 35, down: 4, distance: 7,
    possession: kickingSlot, score: [0, 0], specialTeams: null,
    offensePlayers: new Map(), defensePlayers: new Map(),
  }
}

describe('a computer seat states its kick power; a human seat does not', () => {
  // Each case needs its own room with its own seat holder; leaveRoom clears the previous one.
  beforeEach(() => { leaveRoom('ai:aikick:0'); leaveRoom('socket-human-0') })

  it('honours a power from an AI seat', () => {
    const room = createRoom(ROOM, 'ai:aikick:0', { solo: true })
    expect(room).toBeTruthy()
    const state = stateWith(0)
    beginSpecialTeams(state, KICK.PUNT, { kickingSlot: 0 })
    state.specialTeams.power = 0.1          // as if the meter had drained away
    expect(applyKickInput(state, 0, { power: 0.82 })).toBe(true)
    expect(state.specialTeams.power).toBeCloseTo(0.82, 2)
  })

  // ⚠️ ENFORCED ON THE SERVER, NOT TRUSTED TO THE CLIENT. The meter is the whole of the kicking game
  // for a player; a client that could name its own power would skip it.
  it('refuses a power from a human seat and leaves the meter alone', () => {
    createRoom(ROOM, 'socket-human-0', {})
    const state = stateWith(0)
    beginSpecialTeams(state, KICK.PUNT, { kickingSlot: 0 })
    state.specialTeams.power = 0.1
    applyKickInput(state, 0, { power: 0.95 })
    expect(state.specialTeams.power).toBeCloseTo(0.1, 2)
  })

  it('still lets a human tap for power the ordinary way', () => {
    createRoom(ROOM, 'socket-human-0', {})
    const state = stateWith(0)
    beginSpecialTeams(state, KICK.PUNT, { kickingSlot: 0 })
    state.specialTeams.power = 0.5
    expect(applyKickInput(state, 0, { aim: 'right' })).toBe(true)
    expect(state.specialTeams.power).toBeGreaterThan(0.5)
  })
})

describe('what the computer aims for', () => {
  // ⚠️ NOT A PERFECT METER. 100% every time is as wrong as 9% and more annoying: a human reached 75%
  // in a real game, so a computer pinned at full would out-kick every player every time.
  it('punts well short of perfect, with real spread', () => {
    const seen = []
    let r = 0
    const rng = () => ((r = (r * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff)
    for (let i = 0; i < 40; i++) {
      const st = { kicking: true, phase: ST_PHASE.SETUP, kickType: KICK.PUNT, angle: 0 }
      const action = specialTeamsAction({ specialTeams: st, yardLine: 35 }, rng)
      seen.push(action?.payload?.power)
    }
    const powers = seen.filter(p => typeof p === 'number')
    expect(powers.length).toBe(40)
    const mean = powers.reduce((a, b) => a + b, 0) / powers.length
    expect(mean).toBeGreaterThan(0.7)
    expect(mean).toBeLessThan(0.92)
    // and it is not the same number every time
    expect(new Set(powers.map(p => p.toFixed(3))).size).toBeGreaterThan(5)
  })
})
