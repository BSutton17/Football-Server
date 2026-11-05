import { describe, it, expect, afterEach } from '@jest/globals'
import { registerRoomHandlers } from '../socket/roomHandlers.js'
import { createRoom, joinRoom, leaveRoomBySlot } from '../game/roomManager.js'
import { initGame, getGame, deleteGame } from '../game/gameState.js'
import { getTokenBySocketId, invalidateSession, getTokensByRoomId } from '../game/sessionManager.js'
import { clearTeamSelect } from '../game/teamSelect.js'
import { markSoloRoom } from '../ai/timing.js'
import { isPlayerPaused, isAutoPaused, beginPlayerPause } from '../game/pause.js'
import { stopGameLoop } from '../game/simulation.js'
import { PHASE, transition } from '../game/stateMachine.js'

// [quick leave] "Ensure the game survives quick leaves like swiping up and answering a text or leaving
// the app for a few moments."

function makeSocket(id, registry) {
  const handlers = new Map()
  const emits = []
  const s = {
    id,
    data: {},
    emits,
    connected: true,
    on: (event, fn) => handlers.set(event, fn),
    emit: (event, payload) => emits.push({ event, payload }),
    join: () => {},
    leave: () => {},
    disconnect() { s.connected = false; handlers.get('disconnect')?.('forced') },
    to: () => ({ emit: () => {} }),
    fire: (event, payload) => handlers.get(event)?.(payload),
    emitted: (event) => emits.filter(e => e.event === event),
  }
  registry.set(id, s)
  return s
}

const ROOMS = []
afterEach(() => {
  for (const roomId of ROOMS.splice(0)) {
    for (const t of getTokensByRoomId(roomId)) invalidateSession(t)
    leaveRoomBySlot(roomId, 0); leaveRoomBySlot(roomId, 1)
    stopGameLoop(roomId); deleteGame(roomId); clearTeamSelect(roomId)
  }
})

function setup(roomId, { solo = false } = {}) {
  ROOMS.push(roomId)
  const registry = new Map()
  const io = {
    sockets: { sockets: registry },
    to: (target) => ({
      emit: (event, payload) => {
        const one = registry.get(target)
        if (one) one.emit(event, payload)
        else for (const sock of registry.values()) if (sock.data.roomId === target) sock.emit(event, payload)
      },
    }),
  }
  const a = makeSocket(`${roomId}-a`, registry)
  const b = makeSocket(`${roomId}-b`, registry)
  registerRoomHandlers(io, a)
  registerRoomHandlers(io, b)
  a.fire('create_room', { roomId, mode: 'automatic' })
  b.fire('join_room', { roomId, mode: 'automatic' })
  clearTeamSelect(roomId)
  const state = initGame(roomId, 0)
  if (solo) markSoloRoom(state)
  return { io, registry, a, b, state, tokenA: getTokenBySocketId(a.id) }
}

describe('[quick leave] swiping away', () => {
  it('⚠️ HOLDS THE GAME THE MOMENT THE APP GOES, without waiting for the socket to die', () => {
    const { a, state } = setup('9101', { solo: true })
    a.fire('app_hidden')
    expect(isPlayerPaused(state)).toBe(true)
    expect(isAutoPaused(state)).toBe(true)
  })

  it('…and lets it go the moment the app is back, with the connection intact', () => {
    const { a, state } = setup('9102', { solo: true })
    a.fire('app_hidden')
    a.fire('app_visible')
    expect(isPlayerPaused(state)).toBe(false)
    expect(a.emitted('game_resumed').length).toBe(1)
  })

  it('tells the player left waiting that it was the server, not a choice', () => {
    const { a, b } = setup('9103')
    a.fire('app_hidden')
    expect(b.emitted('game_paused')[0].payload).toEqual({ byYou: false, auto: true })
    expect(a.emitted('game_paused')[0].payload).toEqual({ byYou: true, auto: true })
  })

  it('does not lift a pause somebody asked for', () => {
    const { a, state } = setup('9104', { solo: true })
    beginPlayerPause(state, 0)            // the player pressed pause, then swiped away
    a.fire('app_hidden')
    a.fire('app_visible')
    expect(isPlayerPaused(state)).toBe(true)
  })

  it('does not hold a game that is already over', () => {
    const { a, state } = setup('9105', { solo: true })
    state.phase = PHASE.DEAD
    transition(state, PHASE.GAME_OVER)
    a.fire('app_hidden')
    expect(isPlayerPaused(state)).toBe(false)
  })
})

describe('[quick leave] coming back before the server noticed', () => {
  it('⚠️ THE TOKEN TAKES THE SEAT OVER — it used to answer reconnect_failed and lose the game', () => {
    const { io, registry, a, tokenA } = setup('9110', { solo: true })
    // The old connection is dead but nobody has told the server: the session still reads active.
    const back = makeSocket('9110-back', registry)
    registerRoomHandlers(io, back)
    back.fire('reconnect_to_room', tokenA)

    expect(back.emitted('reconnect_failed').length).toBe(0)
    expect(back.emitted('reconnect_success').length).toBe(1)
    expect(getTokenBySocketId('9110-back')).toBe(tokenA)
    expect(a.connected).toBe(false)     // the dead connection is retired
  })

  it('⚠️ THE RETIRED SOCKET DOES NOT ANNOUNCE THE PLAYER LEFT, which ends the game for the other side', () => {
    const { io, registry, a, tokenA } = setup('9111')
    const sent = []
    a.to = () => ({ emit: (event) => sent.push(event) })
    const back = makeSocket('9111-back', registry)
    registerRoomHandlers(io, back)
    back.fire('reconnect_to_room', tokenA)
    expect(sent).not.toContain('opponent_left')
    expect(sent).not.toContain('opponent_disconnected')
  })

  it('an unknown token still fails', () => {
    const { io, registry } = setup('9112')
    const back = makeSocket('9112-back', registry)
    registerRoomHandlers(io, back)
    back.fire('reconnect_to_room', 'not-a-real-token')
    expect(back.emitted('reconnect_failed').length).toBe(1)
  })
})

describe('[quick leave] an online game when a player drops', () => {
  it('⚠️ HOLDS for both players instead of playing on against an empty side of the ball', () => {
    const { a, b, state } = setup('9120')
    a.fire('disconnect', 'transport close')
    expect(isAutoPaused(state)).toBe(true)
    expect(b.emitted('game_paused')[0].payload.auto).toBe(true)
  })

  it('and resumes when they return', () => {
    const { io, registry, a, tokenA, state } = setup('9121')
    a.fire('disconnect', 'transport close')
    const back = makeSocket('9121-back', registry)
    registerRoomHandlers(io, back)
    back.fire('reconnect_to_room', tokenA)
    expect(isPlayerPaused(state)).toBe(false)
  })

  it('⚠️ ONE PLAYER RETURNING DOES NOT RELEASE A GAME HELD FOR ANOTHER STILL GONE', () => {
    const { io, registry, a, b, tokenA, state } = setup('9122')
    a.fire('disconnect', 'transport close')
    b.fire('disconnect', 'transport close')
    const back = makeSocket('9122-back', registry)
    registerRoomHandlers(io, back)
    back.fire('reconnect_to_room', tokenA)
    expect(isPlayerPaused(state)).toBe(true)
    expect(getGame('9122')).toBeTruthy()
  })
})
