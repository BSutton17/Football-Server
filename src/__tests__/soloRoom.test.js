import { describe, it, expect, beforeEach, afterEach } from '@jest/globals'
import { createSoloRoom, endSoloRoom } from '../ai/solo.js'
import { getAiSeat, aiSeatCount, clearAiSeats } from '../ai/seats.js'
import { isAiSocketId } from '../ai/virtualSocket.js'
import { createFakeIo } from '../headless/harness.js'
import { createRoom, getRoom, leaveRoomBySlot } from '../game/roomManager.js'
import { initGame, getGame, deleteGame, resetPlay } from '../game/gameState.js'
import { getTeamSelect, clearTeamSelect } from '../game/teamSelect.js'
import { getTokensByRoomId, invalidateSession } from '../game/sessionManager.js'
import { stopGameLoop } from '../game/simulation.js'
import { isSeeded } from '../game/utils/rng.js'
import {
  markSoloRoom, markDefenseSet, isSoloRoom, soloCountdownFor,
  DEFENSE_SET_COUNTDOWN, OFFENSE_SET_COUNTDOWN,
} from '../ai/timing.js'
import { validatePlacePlayer } from '../game/validation.js'

// [offline] A solo room is an ORDINARY room whose second seat is a virtual socket. These tests pin
// the properties the whole offline design rests on: the AI occupies a real slot, it plays through
// the same validated handlers a phone does, the game it creates is seeded (therefore replayable),
// and nothing about the online path changed.

const ROOM = '7001'

// A stand-in for a human's socket — the same shape registerSocketHandlers gives a real one.
function humanSocket(id = 'human1') {
  const emits = []
  return {
    id,
    data: {},
    emits,
    on() {},
    emit(event, payload) { emits.push({ event, payload }) },
    join() {},
    to() { return { emit() {} } },
    of(event) { return emits.filter(e => e.event === event) },
  }
}

function cleanup(roomId) {
  clearAiSeats(roomId)
  for (const t of getTokensByRoomId(roomId)) invalidateSession(t)
  if (getRoom(roomId)) { leaveRoomBySlot(roomId, 0); leaveRoomBySlot(roomId, 1) }
  stopGameLoop(roomId)
  deleteGame(roomId)
  clearTeamSelect(roomId)
}

let io, human
beforeEach(() => { cleanup(ROOM); io = createFakeIo(); human = humanSocket() })
afterEach(() => cleanup(ROOM))

describe('solo room — seating a computer opponent', () => {
  it('fills both slots, with the AI in slot 1', () => {
    const r = createSoloRoom(io, human, { roomId: ROOM, mode: 'automatic', seed: 99 })

    expect(r.error).toBeUndefined()
    expect(r.slot).toBe(0)
    const room = getRoom(ROOM)
    expect(room.players[0]).toBe('human1')
    expect(isAiSocketId(room.players[1])).toBe(true)
    expect(aiSeatCount()).toBe(1)
  })

  it('puts the human on the team-select screen with a session token', () => {
    createSoloRoom(io, human, { roomId: ROOM, seed: 99 })

    expect(human.of('room_joined')).toHaveLength(1)
    expect(human.of('roles_assigned')).toHaveLength(1)
    expect(human.of('session_token')).toHaveLength(1)
    expect(human.of('team_select_start')[0].payload.slot).toBe(0)
  })

  it('gives the two seats opposite roles', () => {
    const r  = createSoloRoom(io, human, { roomId: ROOM, seed: 99 })
    const ai = getAiSeat(r.aiSocketId)
    expect(new Set([human.data.role, ai.data.role])).toEqual(new Set(['offense', 'defense']))
  })

  it('the AI locks a team immediately, so the human never waits on an empty slot', () => {
    const r   = createSoloRoom(io, human, { roomId: ROOM, seed: 99 })
    const sel = getTeamSelect(ROOM)
    expect(sel.locked[1]).toBe(true)
    expect(sel.picks[1]).toBe(r.aiTeamId)
    expect(sel.locked[0]).toBeFalsy()   // …and the human still gets to choose
  })

  it('issues a session token to the human only — a virtual seat cannot reconnect', () => {
    createSoloRoom(io, human, { roomId: ROOM, seed: 99 })
    expect(getTokensByRoomId(ROOM)).toHaveLength(1)
  })

  it('registers the real handlers on the AI seat, so it acts through real validation', () => {
    const r  = createSoloRoom(io, human, { roomId: ROOM, seed: 99 })
    const ai = getAiSeat(r.aiSocketId)
    for (const event of ['place_player', 'assign_coverage', 'set_offense', 'snap_ball', 'throw_to_receiver', 'lock_team']) {
      expect({ event, wired: ai.hasHandler(event) }).toEqual({ event, wired: true })
    }
  })

  it('tears the seat down with the room', () => {
    createSoloRoom(io, human, { roomId: ROOM, seed: 99 })
    expect(aiSeatCount()).toBe(1)
    endSoloRoom(ROOM)
    expect(aiSeatCount()).toBe(0)
  })
})

describe('solo room — the game is seeded', () => {
  it('records the seed on the room so the game inherits it', () => {
    createSoloRoom(io, human, { roomId: ROOM, seed: 4242 })
    expect(getRoom(ROOM).seed).toBe(4242)
  })

  it('a solo room without an explicit seed still gets one', () => {
    const r = createSoloRoom(io, human, { roomId: ROOM })
    expect(Number.isInteger(r.seed)).toBe(true)
    expect(getRoom(ROOM).seed).toBe(r.seed)
  })

  it('the same seed seats the same matchup twice', () => {
    const a = createSoloRoom(io, human, { roomId: ROOM, seed: 12345 })
    cleanup(ROOM)
    const b = createSoloRoom(createFakeIo(), humanSocket(), { roomId: ROOM, seed: 12345 })
    expect(b.aiTeamId).toBe(a.aiTeamId)
    expect(b.role).toBe(a.role)
  })
})

describe('role derivation — the hazard a virtual seat exposes', () => {
  // [role drift] notifyRoleSwap refreshes socket.data.role through io's socket registry, which a
  // virtual seat is not in. Before roles were derived, an AI seat's cached role went stale on the
  // first turnover and every action it took was refused — the same soft-lock a reconnecting human
  // used to hit. The validators now ask the GAME who has the ball, so a stale cache cannot matter.
  it('a seat is whichever side currently has the ball, cache or no cache', () => {
    const r  = createSoloRoom(io, human, { roomId: ROOM, seed: 99 })
    const ai = getAiSeat(r.aiSocketId)

    const state = initGame(ROOM, 0)
    ai.data.role = 'kickoff-era-nonsense'    // deliberately stale, as it would be after a turnover

    // place_player reports the team it expects for your role, which reads the derivation directly.
    const place = (team) => validatePlacePlayer(ai, { id: 'x', x: 26, y: 30, label: 'WR', team })

    state.possession = 1                      // the AI's slot has the ball → it is the offense
    expect(place('o')).toBeNull()
    expect(place('d')).toBe('team must be "o" for your role')

    state.possession = 0                      // ball changes hands → it is the defense, same tick
    expect(place('d')).toBeNull()
    expect(place('o')).toBe('team must be "d" for your role')
  })

  it('falls back to the assigned role before a game exists (team selection)', () => {
    const r  = createSoloRoom(io, human, { roomId: ROOM, seed: 99 })
    const ai = getAiSeat(r.aiSocketId)
    expect(getGame(ROOM)).toBeFalsy()
    // No ball to have yet, so the role handed out at the coin flip stands.
    expect(['offense', 'defense']).toContain(ai.data.role)
  })
})

describe('offline pre-snap timing', () => {
  // [offline] "The defense is ready" is a declaration about THIS play. Leaving it set made the Set
  // Defense button a one-shot: every later press was refused and every later countdown was silently
  // the short one, so the "Offense is set…" banner flashed past. Found by playing, not by testing.
  it('clears the defense declaration at every play boundary', () => {
    createSoloRoom(io, human, { roomId: ROOM, seed: 99 })
    const state = initGame(ROOM, 0)
    markSoloRoom(state)

    expect(markDefenseSet(state)).toBe(true)
    expect(state.solo.defenseSet).toBe(true)
    expect(markDefenseSet(state)).toBe(false)     // once per play, not twice

    resetPlay(state)                               // …the play ends
    expect(state.solo.defenseSet).toBe(false)
    expect(markDefenseSet(state)).toBe(true)       // …and it can be declared again
    deleteGame(ROOM)
  })

  // ⚠️ WHO SET FIRST decides the length, and the two orderings are genuinely different situations.
  // A defense that declared itself ready before the offense locked asked not to wait, so it gets 3.
  // A defense that the offense beat to the punch has not declared anything — it is still reading a
  // formation it has only just seen — so it gets the ordinary 5. The old code ran `markDefenseSet`
  // the same way in both and announced 3 either way, while the countdown actually on screen kept
  // running from 5: the server and the player were watching two different clocks.
  it('gives the short countdown only when the DEFENSE set first', () => {
    createSoloRoom(io, human, { roomId: ROOM, seed: 99 })
    const state = initGame(ROOM, 0)
    markSoloRoom(state)

    // Nobody has declared yet — the offense locking now owes the defense a full window.
    expect(soloCountdownFor(state)).toBe(OFFENSE_SET_COUNTDOWN)
    expect(OFFENSE_SET_COUNTDOWN).toBe(5)

    markDefenseSet(state)                           // …the defense gets there first
    expect(soloCountdownFor(state)).toBe(DEFENSE_SET_COUNTDOWN)
    expect(DEFENSE_SET_COUNTDOWN).toBe(3)
    deleteGame(ROOM)
  })

  it('does not shorten a window the offense has already started', () => {
    createSoloRoom(io, human, { roomId: ROOM, seed: 99 })
    const state = initGame(ROOM, 0)
    markSoloRoom(state)

    // The offense locked first, so the 5-second window is already on the clock.
    state.solo.countdown = OFFENSE_SET_COUNTDOWN

    // The defense presses Set during it. That registers — the button reads "Defense Set" — but the
    // clock it would be cutting short is its own, so it is left exactly where it is.
    expect(markDefenseSet(state, { offenseAlreadySet: true })).toBe(true)
    expect(state.solo.defenseSet).toBe(true)
    expect(state.solo.countdown).toBe(OFFENSE_SET_COUNTDOWN)
    deleteGame(ROOM)
  })

  it('leaves an ordinary online game alone', () => {
    const state = initGame('7009', 0)
    expect(state.solo).toBeUndefined()
    expect(() => resetPlay(state)).not.toThrow()
    expect(markDefenseSet(state)).toBe(false)      // nothing to declare in a two-player room
    deleteGame('7009')
  })
})

describe('the online path is untouched', () => {
  it('an ordinary room carries no seed — only a solo room does', () => {
    createRoom('7002', 'someone', { mode: 'automatic' })
    expect(getRoom('7002').seed).toBeNull()
    leaveRoomBySlot('7002', 0)

    createSoloRoom(io, human, { roomId: ROOM, seed: 7 })
    expect(getRoom(ROOM).seed).toBe(7)
  })

  it('an unseeded game runs on Math.random exactly as before', () => {
    expect(isSeeded({})).toBe(false)
    expect(isSeeded({ rng: null })).toBe(false)
    // …and initGame only creates a generator when a seed is supplied.
    expect(initGame('7003', 0).rng).toBeNull()
    deleteGame('7003')
  })
})
