import { describe, it, expect, beforeEach } from '@jest/globals'
import { registerRoomHandlers } from '../socket/roomHandlers.js'
import { createRoom, joinRoom, getRoom, leaveRoomBySlot } from '../game/roomManager.js'
import { initGame, getGame, deleteGame, changePossession } from '../game/gameState.js'
import { getTokenBySocketId, invalidateSession, getTokensByRoomId } from '../game/sessionManager.js'
import { clearTeamSelect } from '../game/teamSelect.js'

// [role drift] A player who swipes out of the tab or refreshes comes back through
// `reconnect_to_room`. The session that resolves the token records the role the player was GIVEN at
// kickoff — but roles swap on EVERY possession change (notifyRoleSwap). Handing that stored role
// back put the returning player on the WRONG SIDE OF THE BALL, and because socket.data.role is
// exactly what the validators check, everything they then did was rejected: a soft-lock. The
// reconnect path must derive the role from the live game instead.

// A socket stand-in: records emits, exposes the registered handlers by event name.
function makeSocket(id) {
  const handlers = new Map()
  const emits = []
  return {
    id,
    data: {},
    emits,
    handlers,
    on:   (event, fn) => handlers.set(event, fn),
    emit: (event, payload) => emits.push({ event, payload }),
    join: () => {},
    to:   () => ({ emit: () => {} }),
    fire: (event, payload) => handlers.get(event)?.(payload),
    emitted: (event) => emits.filter(e => e.event === event),
  }
}

function makeIo() {
  return {
    sockets: { sockets: new Map() },
    to: () => ({ emit: () => {} }),
  }
}

// Stand a room up the way the real create/join path does, then start the game with slot 0 on
// offense, and return each player's live session token.
function setupGame(roomId) {
  const io = makeIo()

  const a = makeSocket('sockA')
  const b = makeSocket('sockB')
  registerRoomHandlers(io, a)
  registerRoomHandlers(io, b)

  a.fire('create_room', { roomId, mode: 'automatic' })
  b.fire('join_room',   { roomId, mode: 'automatic' })

  // Both players locked in and kicked off: team selection is over, the game is live.
  clearTeamSelect(roomId)
  initGame(roomId, 0)   // slot 0 opens on offense

  return {
    io, a, b,
    tokenA: getTokenBySocketId('sockA'),
    tokenB: getTokenBySocketId('sockB'),
  }
}

function cleanup(roomId) {
  for (const t of getTokensByRoomId(roomId)) invalidateSession(t)
  clearTeamSelect(roomId)
  if (getRoom(roomId)) { leaveRoomBySlot(roomId, 0); leaveRoomBySlot(roomId, 1) }
  deleteGame(roomId)
}

// Take a socket offline the way a real disconnect does, so its token becomes reconnectable.
function drop(socket) {
  socket.fire('disconnect', 'transport close')
}

describe('reconnect role ([role drift])', () => {
  const ROOM = '4411'

  beforeEach(() => cleanup(ROOM))

  it('returns the role the player currently holds, not the one they started with', () => {
    const { io, a, tokenA } = setupGame(ROOM)

    // The ball changes hands while slot 0 is still connected — they are the defense now.
    changePossession(getGame(ROOM))
    expect(getGame(ROOM).possession).toBe(1)

    drop(a)

    // …then they swipe back in on a fresh socket.
    const back = makeSocket('sockA2')
    registerRoomHandlers(io, back)
    back.fire('reconnect_to_room', tokenA)

    const [success] = back.emitted('reconnect_success')
    expect(success).toBeDefined()
    expect(success.payload.role).toBe('defense')
    expect(success.payload.slot).toBe(0)

    // The authoritative server-side role must agree, or every action they send is rejected.
    expect(back.data.role).toBe('defense')

    cleanup(ROOM)
  })

  it('the restored game_state agrees with the role it handed back', () => {
    const { io, a, tokenA } = setupGame(ROOM)
    changePossession(getGame(ROOM))
    drop(a)

    const back = makeSocket('sockA2')
    registerRoomHandlers(io, back)
    back.fire('reconnect_to_room', tokenA)

    const [success] = back.emitted('reconnect_success')
    const [state]   = back.emitted('game_state')
    expect(state).toBeDefined()
    expect(state.payload.role).toBe(success.payload.role)

    cleanup(ROOM)
  })

  it('leaves an unswapped player on the side they started on', () => {
    const { io, a, tokenA } = setupGame(ROOM)
    drop(a)

    const back = makeSocket('sockA2')
    registerRoomHandlers(io, back)
    back.fire('reconnect_to_room', tokenA)

    expect(back.emitted('reconnect_success')[0].payload.role).toBe('offense')
    expect(back.data.role).toBe('offense')

    cleanup(ROOM)
  })

  it('survives a second round trip — the refreshed role is written back to the session', () => {
    const { io, a, tokenA } = setupGame(ROOM)

    changePossession(getGame(ROOM))   // slot 0 → defense
    drop(a)

    const back1 = makeSocket('sockA2')
    registerRoomHandlers(io, back1)
    back1.fire('reconnect_to_room', tokenA)
    expect(back1.emitted('reconnect_success')[0].payload.role).toBe('defense')

    // Ball comes back, and they drop out again. The session must not still be serving 'offense'
    // from kickoff, nor 'defense' from the last reconnect.
    changePossession(getGame(ROOM))   // slot 0 → offense again
    drop(back1)

    const back2 = makeSocket('sockA3')
    registerRoomHandlers(io, back2)
    back2.fire('reconnect_to_room', tokenA)
    expect(back2.emitted('reconnect_success')[0].payload.role).toBe('offense')
    expect(back2.data.role).toBe('offense')

    cleanup(ROOM)
  })
})
