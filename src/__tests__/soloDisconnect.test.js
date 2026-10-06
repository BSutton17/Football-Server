import { describe, it, expect, beforeEach, afterEach } from '@jest/globals'
import { createSoloRoom } from '../ai/solo.js'
import { clearAiSeats } from '../ai/seats.js'
import { createFakeIo } from '../headless/harness.js'
import { getRoom, leaveRoomBySlot } from '../game/roomManager.js'
import { getGame, deleteGame } from '../game/gameState.js'
import { clearTeamSelect } from '../game/teamSelect.js'
import { getTokensByRoomId, invalidateSession } from '../game/sessionManager.js'
import { stopGameLoop } from '../game/simulation.js'
import { isAutoPaused } from '../game/pause.js'
import { registerRoomHandlers } from '../socket/roomHandlers.js'
import { registerTeamSelectHandlers } from '../socket/teamSelectHandlers.js'
import { registerGameHandlers } from '../socket/gameHandlers.js'
import { TEAMS } from '../data/teams.js'

// ⚠️ A SOLO PLAYER DROPPING USED TO KILL THE SERVER. The disconnect handler paused the solo game with
// a bare `slot` that was not in scope, so every solo disconnect — a phone sleeping, a closed tab —
// threw a ReferenceError out of a socket handler and took the whole process down with it.

const ROOM = '9710'

function human(io, id = 'humanD') {
  const handlers = new Map()
  const s = {
    id, data: {}, emits: [],
    on(e, fn) { handlers.set(e, fn) },
    emit(e, p) { s.emits.push({ event: e, payload: p }) },
    join() {}, to() { return { emit() {} } },
    fire(e, p) { handlers.get(e)?.(p); return handlers.has(e) },
  }
  registerRoomHandlers(io, s); registerTeamSelectHandlers(io, s); registerGameHandlers(io, s)
  io.register?.(s)
  return s
}

function cleanup() {
  clearAiSeats(ROOM)
  for (const t of getTokensByRoomId(ROOM)) invalidateSession(t)
  if (getRoom(ROOM)) { leaveRoomBySlot(ROOM, 0); leaveRoomBySlot(ROOM, 1) }
  stopGameLoop(ROOM); deleteGame(ROOM); clearTeamSelect(ROOM)
}

let you
beforeEach(() => {
  cleanup()
  const io = createFakeIo()
  you = human(io)
  const solo = createSoloRoom(io, you, { roomId: ROOM, mode: 'automatic', seed: 9191 })
  you.data.roomId = ROOM
  you.fire('lock_team', { teamId: TEAMS.map(t => t.id).find(id => id !== solo.aiTeamId) })
})
afterEach(cleanup)

describe('a solo player disconnecting', () => {
  it('does not throw, and holds the game with an automatic pause', () => {
    expect(getGame(ROOM)).toBeTruthy()
    expect(() => you.fire('disconnect', 'transport close')).not.toThrow()
    expect(isAutoPaused(getGame(ROOM))).toBe(true)
    expect(getGame(ROOM).pausedBy).toBe(0)
  })
})
