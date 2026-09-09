// [manual] Room-level game mode + difficulty: the creator fixes both, the room is authoritative
// for them, and they flow through into the authoritative game state.

import { createRoom, joinRoom, getRoom } from '../game/roomManager.js'
import { initGame, deleteGame } from '../game/gameState.js'
import { serializeGameState } from '../game/serialization.js'
import { GAME_MODE, DIFFICULTY } from '../constants.js'

// Room codes are 4-digit; use a distinct one per test so the module-level registry stays clean.
let next = 1000
const code = () => String(next++)

describe('[manual] room mode + difficulty', () => {
  test('createRoom defaults to automatic/easy when nothing is supplied', () => {
    const id = code()
    const res = createRoom(id, 'sock-a')
    expect(res.mode).toBe(GAME_MODE.AUTOMATIC)
    expect(res.difficulty).toBe(DIFFICULTY.EASY)
    expect(getRoom(id).mode).toBe(GAME_MODE.AUTOMATIC)
  })

  test('a manual room records its creator\'s difficulty', () => {
    const id = code()
    const res = createRoom(id, 'sock-a', { mode: GAME_MODE.MANUAL, difficulty: DIFFICULTY.HARD })
    expect(res.mode).toBe(GAME_MODE.MANUAL)
    expect(res.difficulty).toBe(DIFFICULTY.HARD)
  })

  test('difficulty is meaningless in an automatic room — always easy', () => {
    const id = code()
    const res = createRoom(id, 'sock-a', { mode: GAME_MODE.AUTOMATIC, difficulty: DIFFICULTY.HARD })
    expect(res.difficulty).toBe(DIFFICULTY.EASY)
  })

  test('an unrecognized mode falls back to automatic rather than being stored raw', () => {
    const id = code()
    const res = createRoom(id, 'sock-a', { mode: 'nonsense', difficulty: 'nonsense' })
    expect(res.mode).toBe(GAME_MODE.AUTOMATIC)
    expect(res.difficulty).toBe(DIFFICULTY.EASY)
  })

  test('joining with the matching mode succeeds and reports the room settings', () => {
    const id = code()
    createRoom(id, 'sock-a', { mode: GAME_MODE.MANUAL, difficulty: DIFFICULTY.HARD })
    const res = joinRoom(id, 'sock-b', { mode: GAME_MODE.MANUAL })
    expect(res.error).toBeUndefined()
    expect(res.mode).toBe(GAME_MODE.MANUAL)
    expect(res.difficulty).toBe(DIFFICULTY.HARD)
  })

  test('joining a manual room with automatic selected is rejected, and the seat stays open', () => {
    const id = code()
    createRoom(id, 'sock-a', { mode: GAME_MODE.MANUAL })
    const res = joinRoom(id, 'sock-b', { mode: GAME_MODE.AUTOMATIC })
    expect(res.error).toBe('mode_mismatch')
    expect(res.mode).toBe(GAME_MODE.MANUAL)      // the client is told what the room actually is
    expect(getRoom(id).players[1]).toBeNull()    // a rejected join must not consume the slot
  })

  test('joining an automatic room with manual selected is rejected too', () => {
    const id = code()
    createRoom(id, 'sock-a', { mode: GAME_MODE.AUTOMATIC })
    expect(joinRoom(id, 'sock-b', { mode: GAME_MODE.MANUAL }).error).toBe('mode_mismatch')
  })

  test('omitting the mode skips the check (legacy clients still join)', () => {
    const id = code()
    createRoom(id, 'sock-a', { mode: GAME_MODE.MANUAL })
    expect(joinRoom(id, 'sock-b').error).toBeUndefined()
  })

  test('mode_mismatch is checked before the room is full, not after', () => {
    const id = code()
    createRoom(id, 'sock-a', { mode: GAME_MODE.MANUAL })
    joinRoom(id, 'sock-b', { mode: GAME_MODE.MANUAL })
    // Now full — fullness wins over the mode check so the message matches the real blocker.
    expect(joinRoom(id, 'sock-c', { mode: GAME_MODE.AUTOMATIC }).error).toBe('full')
  })
})

describe('[manual] mode reaches the game state and the client', () => {
  afterEach(() => deleteGame('9001'))

  test('initGame carries the room settings and starts with no live hold', () => {
    const state = initGame('9001', 0, { mode: GAME_MODE.MANUAL, difficulty: DIFFICULTY.HARD })
    expect(state.mode).toBe(GAME_MODE.MANUAL)
    expect(state.difficulty).toBe(DIFFICULTY.HARD)
    expect(state.manual).toBeNull()
  })

  test('initGame defaults to automatic/easy for an unconfigured room', () => {
    const state = initGame('9001', 0)
    expect(state.mode).toBe(GAME_MODE.AUTOMATIC)
    expect(state.difficulty).toBe(DIFFICULTY.EASY)
  })

  test('serializeGameState sends mode + difficulty to both viewers', () => {
    const state = initGame('9001', 0, { mode: GAME_MODE.MANUAL, difficulty: DIFFICULTY.HARD })
    for (const slot of [0, 1]) {
      const out = serializeGameState(state, slot)
      expect(out.mode).toBe(GAME_MODE.MANUAL)
      expect(out.difficulty).toBe(DIFFICULTY.HARD)
    }
  })
})
