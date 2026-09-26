import { describe, it, expect, beforeEach, afterEach } from '@jest/globals'
import { createSoloRoom } from '../ai/solo.js'
import { clearAiSeats } from '../ai/seats.js'
import { createFakeIo } from '../headless/harness.js'
import { getRoom, leaveRoomBySlot } from '../game/roomManager.js'
import { getGame, deleteGame } from '../game/gameState.js'
import { clearTeamSelect } from '../game/teamSelect.js'
import { getTokensByRoomId, invalidateSession } from '../game/sessionManager.js'
import { stopGameLoop } from '../game/simulation.js'
import { PHASE } from '../game/stateMachine.js'
import { startNextPlay } from '../game/eventQueue.js'
import { registerRoomHandlers } from '../socket/roomHandlers.js'
import { registerTeamSelectHandlers } from '../socket/teamSelectHandlers.js'
import { registerGameHandlers } from '../socket/gameHandlers.js'
import { TEAMS } from '../data/teams.js'

// ⚠️ SOLO HALF-TIME WAITS FOR THE PLAYER. Five seconds is not long enough to read a box score, and
// there is nobody else being held up.
//
// The safety of it is that the next play is deliberately NOT booked: the game sits in DEAD, where
// no clock of any kind runs. Leaving the overlay up while the server marched on would start the
// play clock behind it and hand out a delay of game for reading the stats.

const ROOM = '9700'

function human(io, id = 'humanA') {
  const emits = []
  const handlers = new Map()
  const s = {
    id, data: {}, emits,
    on(e, fn) { handlers.set(e, fn) },
    emit(e, p) { emits.push({ event: e, payload: p }) },
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

let g
beforeEach(() => {
  cleanup()
  const io = createFakeIo()
  const you = human(io)
  const solo = createSoloRoom(io, you, { roomId: ROOM, mode: 'automatic', seed: 9090 })
  const mine = TEAMS.map(t => t.id).find(id => id !== solo.aiTeamId)
  you.data.roomId = ROOM
  you.fire('lock_team', { teamId: mine })
  g = { io, you }
})
afterEach(cleanup)

// The common way a period ends: the play that ran the clock to zero finishes, and the next play
// resolves the period end instead of lining up.
function endTheHalf() {
  const st = getGame(ROOM)
  st.quarter = 2
  st.clock = 0
  st.phase = PHASE.DEAD
  st.nextPlayTimer = null
  startNextPlay(ROOM, g.io)
  return getGame(ROOM)
}

describe('half-time in a solo game', () => {
  it('⚠️ HOLDS, AND BOOKS NO NEXT PLAY', () => {
    const st = endTheHalf()
    expect(st.awaitingTransitionTap).toBe(true)
    // Nothing scheduled means nothing can start the clock behind the overlay.
    expect(st.nextPlayTimer == null).toBe(true)
    expect(st.phase).toBe(PHASE.DEAD)
  })

  it('sends the box score with the transition', () => {
    endTheHalf()
    const t = g.io.of('period_transition').map(e => e.payload).filter(p => p.kind === 'halftime')
    expect(t.length).toBeGreaterThan(0)
    expect(t[t.length - 1].stats).toBeTruthy()
  })

  it('plays on when the player taps', () => {
    const st = endTheHalf()
    expect(st.phase).toBe(PHASE.DEAD)
    g.you.fire('transition_continue')
    expect(getGame(ROOM).awaitingTransitionTap).toBe(false)
    expect(getGame(ROOM).phase).toBe(PHASE.PRE_SNAP)
  })

  it('⚠️ IGNORES A TAP THAT IS NOT BEING WAITED ON', () => {
    // Otherwise the button becomes a way to skip straight past the next play.
    const st = getGame(ROOM)
    st.phase = PHASE.PRE_SNAP
    st.awaitingTransitionTap = false
    const before = st.playSerial
    g.you.fire('transition_continue')
    expect(getGame(ROOM).playSerial).toBe(before)
  })

  it('a second tap does nothing', () => {
    endTheHalf()
    g.you.fire('transition_continue')
    const serial = getGame(ROOM).playSerial
    g.you.fire('transition_continue')
    expect(getGame(ROOM).playSerial).toBe(serial)
  })
})
