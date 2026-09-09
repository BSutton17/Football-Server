import { describe, it, expect, beforeEach } from '@jest/globals'
import { serializePositions } from '../game/serialization.js'
import { runBroadcast } from '../game/systems/broadcast.js'
import { initGame, deleteGame } from '../game/gameState.js'
import { createRoom, joinRoom } from '../game/roomManager.js'
import { PHASE } from '../game/stateMachine.js'
import { GAME_MODE, DIFFICULTY } from '../constants.js'

// ── [manual] Difficulty is an INFORMATION rule, enforced server-side ──────────
//
// Easy shows the offense the openness colors it always had. Hard withholds them — and withholds
// them at the serializer, so the value never reaches the offense's client at all. The defense sees
// the true read either way.

const ROOM = 'difficulty-room'

// possession is slot 0 in these states, so slot 0 is the offense and slot 1 the defense.
function state(difficulty) {
  const s = initGame(ROOM, 0, { mode: GAME_MODE.MANUAL, difficulty })
  s.phase = PHASE.LIVE
  s.playDesign = { playType: 'pass', players: [] }
  s.offensePlayers = new Map([
    ['qb',  { id: 'qb',  label: 'QB', x: 26, y: 30 }],
    // declared (made its first cut) — the openness read is available for it
    ['wr1', { id: 'wr1', label: 'WR', x: 40, y: 55, routeWaypointIdx: 2 }],
    // not yet declared — no read for anyone, in either difficulty
    ['wr2', { id: 'wr2', label: 'WR', x: 12, y: 52, routeWaypointIdx: 0, routeElapsed: 0 }],
  ])
  s.defensePlayers = new Map([['cb1', { id: 'cb1', label: 'CB', x: 44, y: 57 }]])
  return s
}

const find = (positions, id) => positions.find(p => p.id === id)

beforeEach(() => deleteGame(ROOM))

describe('easy difficulty', () => {
  it('sends the offense the openness read, exactly as automatic mode always did', () => {
    const s = state(DIFFICULTY.EASY)
    const wr = find(serializePositions(s, 0), 'wr1')
    expect(typeof wr.openness).toBe('number')
  })

  it('sends the defense the same read', () => {
    const s = state(DIFFICULTY.EASY)
    expect(typeof find(serializePositions(s, 1), 'wr1').openness).toBe('number')
  })
})

describe('hard difficulty', () => {
  it('withholds openness from the OFFENSE', () => {
    const s = state(DIFFICULTY.HARD)
    expect(find(serializePositions(s, 0), 'wr1').openness).toBeUndefined()
  })

  it('still gives the DEFENSE the true read', () => {
    const s = state(DIFFICULTY.HARD)
    expect(typeof find(serializePositions(s, 1), 'wr1').openness).toBe('number')
  })

  it('follows possession rather than a fixed seat — after a turnover the other slot is blinded', () => {
    const s = state(DIFFICULTY.HARD)
    s.possession = 1
    expect(find(serializePositions(s, 1), 'wr1').openness).toBeUndefined()   // now the offense
    expect(typeof find(serializePositions(s, 0), 'wr1').openness).toBe('number')
  })

  it('signals readiness instead, so the offense can still tell who is throwable', () => {
    const s = state(DIFFICULTY.HARD)
    const off = serializePositions(s, 0)
    expect(find(off, 'wr1').ready).toBe(true)    // declared — renders lit
    expect(find(off, 'wr2').ready).toBe(false)   // undeclared — renders faded
  })

  it('never leaks a read for an undeclared receiver, whoever is looking', () => {
    const s = state(DIFFICULTY.HARD)
    expect(find(serializePositions(s, 0), 'wr2').openness).toBeUndefined()
    expect(find(serializePositions(s, 1), 'wr2').openness).toBeUndefined()
  })

  it('hides nothing else — positions are identical for both viewers', () => {
    const s = state(DIFFICULTY.HARD)
    const off = serializePositions(s, 0)
    const def = serializePositions(s, 1)
    expect(off.map(p => [p.id, p.x, p.y])).toEqual(def.map(p => [p.id, p.x, p.y]))
  })
})

describe('the full payload (no viewer)', () => {
  it('keeps openness even on hard — it is the internal/debug view, never sent to a seat', () => {
    const s = state(DIFFICULTY.HARD)
    expect(typeof find(serializePositions(s), 'wr1').openness).toBe('number')
  })
})

describe('runBroadcast', () => {
  // Records every emit with the target it was addressed to.
  function fakeIo() {
    const sent = []
    return { sent, to: (target) => ({ emit: (event, payload) => sent.push({ target, event, payload }) }) }
  }

  function seatedRoom(difficulty) {
    createRoom(ROOM, 'sock-off', { mode: GAME_MODE.MANUAL, difficulty })
    joinRoom(ROOM, 'sock-def', { mode: GAME_MODE.MANUAL })
    const s = state(difficulty)
    return s
  }

  it('broadcasts one shared payload to the room when nothing is hidden', () => {
    const s = seatedRoom(DIFFICULTY.EASY)
    const io = fakeIo()
    runBroadcast(s, io, 0.05)
    const pos = io.sent.filter(e => e.event === 'positions_update')
    expect(pos).toHaveLength(1)
    expect(pos[0].target).toBe(ROOM)
  })

  it('addresses each seat separately on hard, so the two payloads can differ', () => {
    const s = seatedRoom(DIFFICULTY.HARD)
    const io = fakeIo()
    runBroadcast(s, io, 0.05)

    const pos = io.sent.filter(e => e.event === 'positions_update')
    expect(pos).toHaveLength(2)
    expect(pos.map(p => p.target).sort()).toEqual(['sock-def', 'sock-off'])

    // The offense's copy is blind; the defense's is not.
    const offence = pos.find(p => p.target === 'sock-off').payload
    const defence = pos.find(p => p.target === 'sock-def').payload
    expect(find(offence, 'wr1').openness).toBeUndefined()
    expect(typeof find(defence, 'wr1').openness).toBe('number')
  })
})
