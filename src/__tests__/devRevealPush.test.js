import { describe, it, expect, beforeEach, afterEach } from '@jest/globals'
import { createSoloRoom } from '../ai/solo.js'
import { clearAiSeats } from '../ai/seats.js'
import { createFakeIo } from '../headless/harness.js'
import { getRoom, leaveRoomBySlot } from '../game/roomManager.js'
import { getGame, initGame, deleteGame } from '../game/gameState.js'
import { clearTeamSelect } from '../game/teamSelect.js'
import { getTokensByRoomId, invalidateSession } from '../game/sessionManager.js'
import { stopGameLoop } from '../game/simulation.js'
import { registerGameHandlers } from '../socket/gameHandlers.js'
import { serializeGameState } from '../game/serialization.js'
import { markSoloRoom } from '../ai/timing.js'

// [dev reveal] ⚠️ THE OVERLAY HAS TO SHOW THE COMPUTER AS IT ACTUALLY LINED UP.
//
// The reveal that rides on `game_state` is always captured BEFORE the computer has aligned — its
// defense cannot line up until it has seen the offense, so at that instant there is nobody on the
// field to describe. An overlay drawn from it shows an empty or stale defense, which is worse than
// showing nothing: the whole tool exists so a bad alignment can be photographed, and a photograph of
// the wrong thing sends the next fix in the wrong direction.
//
// So this drives the REAL path: a solo room, a human placing receivers, the computer answering
// through the same handlers a phone goes through — and asserts a `dev_reveal` arrives that describes
// eleven men with jobs.

const ROOM = '7311'
const ORIGINAL = { node: process.env.NODE_ENV, flag: process.env.ENABLE_DEV_REVEAL }

function humanSocket(id = 'devhuman') {
  const handlers = new Map()
  const emits = []
  return {
    id,
    data: {},
    emits,
    on(event, fn) { handlers.set(event, fn) },
    fire(event, payload) { handlers.get(event)?.(payload) },
    emit(event, payload) { emits.push({ event, payload }) },
    join() {}, to() { return { emit() {} } },
  }
}

function cleanup() {
  clearAiSeats(ROOM)
  for (const t of getTokensByRoomId(ROOM)) invalidateSession(t)
  if (getRoom(ROOM)) { leaveRoomBySlot(ROOM, 0); leaveRoomBySlot(ROOM, 1) }
  stopGameLoop(ROOM)
  deleteGame(ROOM)
  clearTeamSelect(ROOM)
}

let io, human
beforeEach(() => {
  process.env.NODE_ENV = 'development'
  process.env.ENABLE_DEV_REVEAL = '1'
  cleanup()
  io = createFakeIo()
  human = humanSocket()
})
afterEach(() => {
  cleanup()
  process.env.NODE_ENV = ORIGINAL.node
  if (ORIGINAL.flag === undefined) delete process.env.ENABLE_DEV_REVEAL
  else process.env.ENABLE_DEV_REVEAL = ORIGINAL.flag
})

// A solo room with the human on offense, then five receivers walked out — which is what makes the
// computer's defense align at all.
function soloOnOffense() {
  createSoloRoom(io, human, { roomId: ROOM, mode: 'automatic', seed: 42 })
  io.register(human)
  registerGameHandlers(io, human)

  // ⚠️ createSoloRoom SEATS the players; it does not create the game — team selection does that.
  // The game has to exist and be marked solo, or there is nothing for the reveal to describe.
  const state = initGame(ROOM, 0, { mode: 'automatic', difficulty: 'hard', seed: 42 })
  markSoloRoom(state)
  human.data.roomId = ROOM
  // The human must actually hold the ball for the computer to be the defense.
  state.possession = 0
  human.data.role = 'offense'
  const ai = getRoom(ROOM).players[1]
  io.sockets.sockets.get(ai)?.emit?.('game_state', serializeGameState(state, 1))

  const losY = state.yardLine
  const spots = [
    { id: 'h_wr1', x: 4,  y: losY, label: 'WR' },
    { id: 'h_wr2', x: 49, y: losY, label: 'WR' },
    { id: 'h_wr3', x: 15, y: losY - 1, label: 'WR' },
    { id: 'h_te1', x: 33, y: losY, label: 'TE' },
    { id: 'h_rb1', x: 26, y: losY - 6, label: 'RB' },
  ]
  io.clear()
  for (const s of spots) human.fire('place_player', { ...s, team: 'o' })
  return state
}

describe('⚠️ THE REVEAL ARRIVES AFTER THE COMPUTER HAS ALIGNED, NOT BEFORE', () => {
  it('the copy on game_state is empty at the start of a play — which is why the push exists', () => {
    createSoloRoom(io, human, { roomId: ROOM, mode: 'automatic', seed: 42 })
    const state = initGame(ROOM, 0, { mode: 'automatic', seed: 42 })
    markSoloRoom(state)
    state.possession = 0
    const early = serializeGameState(state, 0).devReveal
    // Not null (the gates are open), but it describes nobody: the defense has not lined up yet.
    expect(early).not.toBeNull()
    expect(early.aiRole).toBe('defense')
    expect(early.shell.players).toEqual([])
  })

  it('pushes a reveal to the human once the defense has answered the formation', () => {
    soloOnOffense()
    const pushes = io.of('dev_reveal')
    expect(pushes.length).toBeGreaterThan(0)

    const last = pushes[pushes.length - 1].payload
    expect(last.aiRole).toBe('defense')
    expect(last.shell.players.length).toBeGreaterThanOrEqual(7)
  })

  it('⚠️ AND IT DESCRIBES REAL JOBS — the thing a screenshot is taken of', () => {
    soloOnOffense()
    const last = io.of('dev_reveal').at(-1).payload
    const jobs = last.shell.players.map(p => p.job)
    // Somebody is covering somebody: a reveal of eleven rushers means the assignments never landed.
    expect(jobs.some(j => j === 'man' || j === 'zone')).toBe(true)
    // Everyone has a position on the field, or the overlay cannot be drawn.
    for (const p of last.shell.players) {
      expect(Number.isFinite(p.x)).toBe(true)
      expect(Number.isFinite(p.y)).toBe(true)
    }
    // A man defender names who he has; a zone defender names where his zone sits.
    for (const p of last.shell.players) {
      if (p.job === 'man') expect(p.covers).toBeTruthy()
      if (p.job === 'zone') expect(Number.isFinite(p.zoneCenterX)).toBe(true)
    }
  })

  it('goes only to the human — never to the seat that acted', () => {
    soloOnOffense()
    const aiId = getRoom(ROOM).players[1]
    for (const push of io.of('dev_reveal')) expect(push.target).not.toBe(aiId)
    expect(io.of('dev_reveal').every(p => p.target === human.id)).toBe(true)
  })

  it('⚠️ STAYS CURRENT — moving a receiver re-pushes the answer to it', () => {
    const state = soloOnOffense()
    const before = io.of('dev_reveal').length
    io.clear()
    human.fire('place_player', { id: 'h_wr1', x: 22, y: state.yardLine, label: 'WR', team: 'o' })
    expect(before).toBeGreaterThan(0)
    expect(io.of('dev_reveal').length).toBeGreaterThan(0)
  })

  it('pushes nothing at all with the flag off', () => {
    delete process.env.ENABLE_DEV_REVEAL
    soloOnOffense()
    expect(io.of('dev_reveal')).toEqual([])
  })
})
